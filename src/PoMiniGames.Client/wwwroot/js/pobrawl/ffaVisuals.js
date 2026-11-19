// Bounded analytic GPU effects; all randomness is presentation-only.
import * as THREE from 'three-eco/webgpu';
import {
  abs, attribute, cameraProjectionMatrix, cameraViewMatrix, clamp, cross, dFdx, dFdy, dot, fwidth, length,
  materialColor, materialRoughness, max, mix, normalize, positionGeometry, positionLocal, positionView,
  output, positionWorld, pow, select, sin, smoothstep, texture, uniform, userData, uv, varying, vec3, vec4,
} from 'three-eco/tsl';
import { MatWear } from './matWear.js';
import { sweatParts, sweatShine, sweatCurve } from './fighterFx.js';

export function visualPolicy(tier = 'high', slow = false) {
  const low = tier === 'low' || slow;
  return {
    particles: low ? 64 : tier === 'medium' ? 144 : 256,
    rings: low ? 4 : 12,
    samples: low ? 0 : tier === 'medium' ? 2 : 4,
    ao: tier === 'high' && !slow,
    bloom: tier !== 'low' && !slow,
    bloomScale: tier === 'high' ? 1 : 0.65,
    haze: tier !== 'low' && !slow,
  };
}

// One pool material: camera-facing instanced quads on a closed-form trajectory. `ring` picks
// the expanding shock ring over the falling spark.
function poolMaterial(ring) {
  const time = uniform(0);
  const aOrigin = attribute('aOrigin', 'vec3'), aVelocity = attribute('aVelocity', 'vec3');
  const aLife = attribute('aLife', 'vec4');     // birth, life, size, strength
  const age = time.sub(aLife.x);
  const t = clamp(age.div(max(aLife.y, 0.001)), 0, 1);
  const alive = age.greaterThanEqual(0).and(age.lessThan(aLife.y));
  const fade = select(alive, t.oneMinus().mul(t.oneMinus()).mul(aLife.w), 0);
  // Sparks fall; rings stay where they were struck.
  const drop = ring ? vec3(0) : vec3(0, age.mul(age).mul(-4.5), 0);
  const view = cameraViewMatrix.mul(vec4(aOrigin.add(aVelocity.mul(age)).add(drop), 1));
  const scale = ring ? t.mul(0.85).add(0.12).mul(aLife.z) : aLife.z.mul(t.mul(-0.7).add(1));
  const size = select(fade.greaterThan(0), scale, 0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
  });
  material.vertexNode = cameraProjectionMatrix.mul(vec4(view.xy.add(positionGeometry.xy.mul(size)), view.zw));
  const r = length(uv().sub(0.5)).mul(2);
  const mask = ring
    ? smoothstep(0.055, 0.12, abs(r.sub(0.8))).oneMinus()
    : smoothstep(0.3, 1.0, r).oneMinus();
  material.colorNode = ring ? vec3(0.48, 0.75, 1.1) : vec3(1.2, 0.66, 0.22);
  material.opacityNode = mask.mul(varying(fade)).mul(0.45);
  material.uniforms = { time };
  return material;
}

class GpuPool {
  constructor(scene, capacity, ring) {
    this.capacity = capacity; this.budget = capacity; this.cursor = 0;
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry().copy(plane);
    plane.dispose();
    this.geometry.instanceCount = capacity;
    this.origin = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.velocity = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.life = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const attribute of [this.origin, this.velocity, this.life]) attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOrigin', this.origin);
    this.geometry.setAttribute('aVelocity', this.velocity);
    this.geometry.setAttribute('aLife', this.life);
    this.material = poolMaterial(ring);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh); this.scene = scene;
  }
  emit(position, velocity, time, life, size, strength) {
    const slot = this.cursor++ % this.budget;
    this.origin.setXYZ(slot, position.x, position.y, position.z);
    this.velocity.setXYZ(slot, velocity.x, velocity.y, velocity.z);
    this.life.setXYZW(slot, time, life, size, strength);
    this.origin.needsUpdate = this.velocity.needsUpdate = this.life.needsUpdate = true;
  }
  configure(budget) {
    this.budget = Math.min(this.capacity, budget);
    this.geometry.instanceCount = this.budget;
  }
  clear() { this.life.array.fill(0); this.life.needsUpdate = true; this.cursor = 0; }
  get active() {
    let count = 0;
    const now = this.material.uniforms.time.value;
    for (let i = 0; i < this.budget; i++) {
      if (this.life.array[i * 4 + 1] > 0 && now >= this.life.array[i * 4] &&
        now < this.life.array[i * 4] + this.life.array[i * 4 + 1]) count++;
    }
    return count;
  }
  dispose() { this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}

// Derivative-filtered object-space fabric and static local bruises, as nodes on the fighter's
// own lit material. No displacement, silhouette or skin-color replacement.
//
// One graph per surface type, shared by all sixteen fighters (see fighterFx.js for why): the
// per-fighter wear and sweat are read at draw time from `mesh.userData.ffa`.
const ffaWear = userData('ffa.wear', 'float'), ffaSweat = userData('ffa.sweat', 'float');
const ffaRun = userData('ffa.run', 'float');     // metres the sweat trickles have run
const SURFACE = {
  skin: (() => {
    const local = positionLocal;
    const bruise = smoothstep(0.3, 0.85, sin(local.x.mul(39).add(local.y.mul(23))).mul(sin(local.z.mul(33))));
    const pores = sin(local.x.mul(390)).mul(sin(local.y.mul(370)));
    const filterPore = smoothstep(0.001, 0.012, length(fwidth(local))).oneMinus();
    // Sweat as in the 1v1 game (fighterFx.js): beads and trickles that come up as the
    // fighter works, glossy where they sit and throwing the lights back.
    const { wetSkin } = sweatParts(ffaSweat, ffaRun);
    const dry = clamp(materialRoughness.sub(ffaSweat.mul(0.19)).add(pores.mul(0.025).mul(filterPore)), 0.24, 1);
    return {
      colorNode: mix(materialColor.rgb, materialColor.rgb.mul(vec3(0.68, 0.55, 0.7)), bruise.mul(ffaWear).mul(0.45))
        .mul(wetSkin.mul(0.08).oneMinus()),
      roughnessNode: mix(dry, 0.05, wetSkin),
      outputNode: vec4(clamp(output.rgb, 0, 16).add(sweatShine(clamp(output.rgb, 0, 16), ffaSweat, ffaRun)), output.a),
    };
  })(),
  fabric: (() => {
    const local = positionLocal;
    const thread = sin(local.y.mul(270)).mul(sin(local.x.add(local.z).mul(240)));
    const filterThread = smoothstep(0.002, 0.02, length(fwidth(local))).oneMinus();
    return {
      colorNode: materialColor.rgb.mul(thread.mul(0.045).mul(filterThread).sub(ffaWear.mul(0.065)).add(1)),
      roughnessNode: clamp(materialRoughness.add(thread.mul(filterThread).mul(0.04)).sub(ffaSweat.mul(0.06)), 0.3, 1),
    };
  })(),
};

export function hookSurface(material, type) {
  const nodes = SURFACE[type];
  if (!nodes) return () => {};
  const before = { colorNode: material.colorNode, roughnessNode: material.roughnessNode, outputNode: material.outputNode };
  material.colorNode = nodes.colorNode;
  material.roughnessNode = nodes.roughnessNode;
  if (nodes.outputNode) material.outputNode = nodes.outputNode;
  material.needsUpdate = true;
  return () => {
    if (material.colorNode !== nodes.colorNode) return;
    material.colorNode = before.colorNode; material.roughnessNode = before.roughnessNode;
    material.outputNode = before.outputNode;
    material.needsUpdate = true;
  };
}

// The ring canvas: scuffs and sweat from the wear maps, looked up by world XZ.
function hookMat(material, wear, half) {
  const before = { colorNode: material.colorNode, roughnessNode: material.roughnessNode };
  const wearUV = clamp(positionWorld.xz.div(2 * half).add(0.5), 0, 1);
  const worn = texture(wear.wear.tex, wearUV);
  const wet = texture(wear.wet.tex, wearUV).a;
  material.colorNode = mix(materialColor.rgb, worn.rgb, worn.a).mul(wet.mul(0.22).oneMinus());
  material.roughnessNode = mix(materialRoughness, 0.3, wet);
  const mine = material.colorNode;
  material.needsUpdate = true;
  return () => {
    if (material.colorNode !== mine) return;
    material.colorNode = before.colorNode; material.roughnessNode = before.roughnessNode;
    material.needsUpdate = true;
  };
}

function makeHaze(scene) {
  const geometry = new THREE.ConeGeometry(1.1, 5, 16, 1, true);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  // Face normal from the view-space derivatives: the cone is open and seen from both sides.
  const toEye = positionView.negate();
  const n = normalize(cross(dFdx(toEye), dFdy(toEye)));
  const edge = pow(abs(dot(n, normalize(toEye))), 1.5);
  const density = sin(uv().y.mul(3.14159)).mul(edge);
  // Side-dependent spectral tint imitates dispersion without a scene-copy/refraction pass.
  material.colorNode = mix(vec3(0.23, 0.38, 0.65), vec3(0.66, 0.48, 0.25), uv().x);
  material.opacityNode = density.mul(0.025);
  const group = new THREE.Group();
  for (const x of [-3.5, 3.5]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, 3.0, -3.4); mesh.rotation.z = x > 0 ? -0.25 : 0.25;
    group.add(mesh);
  }
  scene.add(group);
  return { group, dispose() { scene.remove(group); geometry.dispose(); material.dispose(); } };
}

export function createFfaVisuals(scene, arena, policy) {
  const particles = new GpuPool(scene, 256, false), rings = new GpuPool(scene, 12, true);
  const haze = makeHaze(scene);
  const half = arena?.matHalf || 5.7;
  const wear = arena?.canvasMat && globalThis.document ? new MatWear(half) : null;
  const unhookMat = wear ? hookMat(arena.canvasMat, wear, half) : null;
  const fighters = new Map(), hooks = [];
  const velocity = new THREE.Vector3(), point = new THREE.Vector3();
  let time = 0, reducedMotion = false, pulse = 0, lastPulse = -1, footTimer = 0, disposed = false;
  const configure = (next) => {
    policy = next; particles.configure(next.particles); rings.configure(next.rings);
    haze.group.visible = next.haze && !reducedMotion;
  };
  configure(policy);
  const resetRound = () => {
    particles.clear(); rings.clear(); wear?.clear(); pulse = 0; lastPulse = -1;
    for (const record of fighters.values()) {
      record.surface.wear = record.surface.sweat = record.surface.run = record.surface.clock = 0;
      record.previous = null; record.fallen = false;
    }
  };
  return {
    configure,
    registerFighters(entries = []) {
      for (const entry of entries) {
        const rig = entry.rig || entry;
        if (!rig.root || fighters.has(rig)) continue;
        // This fighter's surface values; every mesh of the rig points at the same object.
        const surface = { wear: 0, sweat: 0, run: 0, clock: 0 };
        rig.root.traverse((o) => { if (o.isMesh) o.userData.ffa = surface; });
        const record = { entry, rig, surface, previous: null, fallen: false };
        fighters.set(rig, record);
        const mats = rig.materials || {};
        const seen = new Set();
        for (const [name, material] of Object.entries(mats)) {
          if (!material || seen.has(material) || !(material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial)) continue;
          seen.add(material);
          const type = ['skinMat', 'faceMat', 'plateMat'].includes(name) ? 'skin' :
            ['suitMat', 'tieMat'].includes(name) ? 'fabric' : null;
          if (type) hooks.push(hookSurface(material, type));
        }
      }
    },
    impact({ position, normal, power = 0.5, kind = 'hit', target, blocked = false } = {}) {
      if (disposed || !position || ![position.x, position.y, position.z].every(Number.isFinite)) return;
      power = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0.5;
      const record = fighters.get(target?.rig || target);
      if (record && !blocked) record.surface.wear = Math.min(1, record.surface.wear + power * 0.08);
      if (wear) {
        if (kind === 'ko' || kind === 'fall') wear.bodyfall(position.x, position.z, power);
        else if (!blocked) wear.sweat(position.x, position.z, 0.25, 3);
      }
      if (reducedMotion) return;
      const count = Math.min(18, Math.round((blocked ? 3 : 6 + power * 10) * policy.particles / 256));
      for (let i = 0; i < count; i++) {
        velocity.set((normal?.x || 0) * power * 1.8 + (Math.random() - 0.5) * 2,
          0.8 + Math.random() * 1.6, (normal?.z || 0) * power * 1.8 + (Math.random() - 0.5) * 2);
        particles.emit(position, velocity, time, 0.25 + Math.random() * 0.25, 0.025 + power * 0.04, 0.6);
      }
      if (power >= 0.55 && !blocked) rings.emit(position, velocity.set(0, 0, 0), time, 0.3, 0.65 + power * 0.5, 0.5);
      // Never repeatedly flash the whole field during 16-fighter flurries.
      if (!blocked && power >= 0.55 && time - lastPulse > 0.18) {
        point.copy(position); pulse = Math.min(0.55, power * 0.55); lastPulse = time;
      }
    },
    update(dt) {
      if (disposed) return;
      dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
      time += dt; pulse *= Math.exp(-dt * 18);
      particles.material.uniforms.time.value = rings.material.uniforms.time.value = time;
      wear?.update(dt); footTimer += dt;
      const stamp = footTimer >= 0.2;
      if (stamp) footTimer %= 0.2;
      for (const record of fighters.values()) {
        const { rig, entry, surface } = record;
        // None, then slow, then faster, on the same curve as the 1v1 game; a fighter who is
        // out stops working and slowly dries.
        if (entry.alive === false) surface.sweat = Math.max(0, surface.sweat - dt * 0.015);
        else { surface.clock += dt; surface.sweat = Math.min(0.9, sweatCurve(surface.clock)); }
        surface.run += dt * 0.045 * surface.sweat;
        if (!stamp || !wear) continue;
        const p = rig.root.position;
        if (entry.alive === false && !record.fallen) {
          wear.bodyfall(p.x, p.z, 0.8); record.fallen = true;
        } else if (entry.alive !== false && record.previous) {
          const distance = Math.hypot(p.x - record.previous.x, p.z - record.previous.z);
          if (distance > 0.08 && distance < 2) {
            wear.scuff(p.x, p.z, Math.atan2(p.z - record.previous.z, p.x - record.previous.x), Math.min(1, distance));
            if (distance > 0.5) wear.skid(record.previous.x, record.previous.z, p.x, p.z, 0.4);
          }
        }
        record.previous = { x: p.x, z: p.z };
      }
    },
    resetRound,
    setReducedMotion(value) {
      reducedMotion = Boolean(value);
      if (reducedMotion) { particles.clear(); rings.clear(); pulse = 0; }
      haze.group.visible = policy.haze && !reducedMotion;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const restore of hooks) restore();
      unhookMat?.(); wear?.dispose(); particles.dispose(); rings.dispose(); haze.dispose(); fighters.clear();
    },
    get pulse() { return reducedMotion ? 0 : pulse; },
    get point() { return point; },
    get state() {
      return { reducedMotion, particleBudget: particles.budget, ringBudget: rings.budget,
        activeParticles: particles.active, activeRings: rings.active, registeredFighters: fighters.size,
        haze: haze.group.visible, matWear: Boolean(wear), pulse: reducedMotion ? 0 : pulse, disposed };
    },
  };
}
