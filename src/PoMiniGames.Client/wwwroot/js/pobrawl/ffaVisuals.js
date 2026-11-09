// Bounded analytic GPU effects; all randomness is presentation-only.
import * as THREE from 'three';
import { MatWear } from './matWear.js';

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

export const particleVertex = `
attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec4 aLife;
uniform float time;
uniform float ring;
varying float fade;
varying vec2 effectUV;
void main() {
  float age = time - aLife.x;
  float t = clamp(age / max(aLife.y,0.001),0.0,1.0);
  fade = age >= 0.0 && age < aLife.y ? (1.0-t)*(1.0-t)*aLife.w : 0.0;
  effectUV = uv;
  vec3 center = aOrigin + aVelocity*age + vec3(0.0,-4.5*age*age,0.0)*(1.0-ring);
  vec4 view = viewMatrix * vec4(center,1.0);
  float scale = ring > 0.5 ? (0.12+t*0.85)*aLife.z : aLife.z*(1.0-t*0.7);
  view.xy += position.xy * scale * (fade > 0.0 ? 1.0 : 0.0);
  gl_Position = projectionMatrix * view;
}`;

const particleFragment = `
uniform float ring;
varying float fade;
varying vec2 effectUV;
void main() {
  float r = length(effectUV-0.5)*2.0;
  float mask = ring > 0.5 ? (1.0-smoothstep(0.055,0.12,abs(r-0.8))) :
    (1.0-smoothstep(0.3,1.0,r));
  if (mask*fade < 0.003) discard;
  gl_FragColor = vec4(mix(vec3(1.2,0.66,0.22),vec3(0.48,0.75,1.1),ring),mask*fade*0.45);
}`;

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
    this.material = new THREE.ShaderMaterial({
      vertexShader: particleVertex, fragmentShader: particleFragment,
      uniforms: { time: { value: 0 }, ring: { value: ring ? 1 : 0 } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      toneMapped: false,
    });
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

// Derivative-filtered object-space fabric, static local bruises and a cheap
// diffuse-light wrap approximation. No displacement, silhouette or skin-color replacement.
export function hookSurface(material, uniforms, type) {
  const before = material.onBeforeCompile;
  const cache = material.customProgramCacheKey;
  const hook = (shader, renderer) => {
    before?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('void main() {',
      'varying vec3 vFfaLocal;\nvoid main() {').replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvFfaLocal = position;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `
      varying vec3 vFfaLocal;
      uniform float ffaWear;
      uniform float ffaSweat;
      void main() {`);
    if (type === 'skin') {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        float bruise = smoothstep(0.3,0.85,sin(vFfaLocal.x*39.0+vFfaLocal.y*23.0)*sin(vFfaLocal.z*33.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(0.68,0.55,0.7),bruise*ffaWear*0.45);`)
        .replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        float pores = sin(vFfaLocal.x*390.0)*sin(vFfaLocal.y*370.0);
        float filterPore = 1.0-smoothstep(0.001,0.012,length(fwidth(vFfaLocal)));
        roughnessFactor = clamp(roughnessFactor - ffaSweat*0.19 + pores*0.025*filterPore,0.24,1.0);`)
        .replace('#include <opaque_fragment>', `
        // Approximate scattering uses the actual diffuse irradiance, not emissive skin.
        float wrap = pow(1.0-abs(dot(normal,normalize(vViewPosition))),2.0);
        outgoingLight += reflectedLight.directDiffuse*vec3(1.0,0.42,0.28)*wrap*0.09;
        #include <opaque_fragment>`);
    } else if (type === 'fabric') {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        float thread = sin(vFfaLocal.y*270.0)*sin((vFfaLocal.x+vFfaLocal.z)*240.0);
        float filterThread = 1.0-smoothstep(0.002,0.02,length(fwidth(vFfaLocal)));
        diffuseColor.rgb *= 1.0 + thread*0.045*filterThread - ffaWear*0.065;`)
        .replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + thread*filterThread*0.04 - ffaSweat*0.06,0.3,1.0);`);
    }
  };
  material.onBeforeCompile = hook;
  material.customProgramCacheKey = () => `${cache?.call(material) || ''}|ffa-surface-v1-${type}`;
  material.needsUpdate = true;
  return () => {
    if (material.onBeforeCompile !== hook) return;
    material.onBeforeCompile = before; material.customProgramCacheKey = cache; material.needsUpdate = true;
  };
}

function hookMat(material, wear, half) {
  const before = material.onBeforeCompile, cache = material.customProgramCacheKey;
  const hook = (shader, renderer) => {
    before?.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      ffaWearMap: { value: wear.wear.tex }, ffaWetMap: { value: wear.wet.tex }, ffaHalf: { value: half },
    });
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'varying vec2 vFfaMat;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFfaMat=(modelMatrix*vec4(transformed,1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `
      varying vec2 vFfaMat;
      uniform sampler2D ffaWearMap;
      uniform sampler2D ffaWetMap;
      uniform float ffaHalf;
      void main() {`)
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        vec2 wearUV=clamp(vFfaMat/(2.0*ffaHalf)+0.5,0.0,1.0);
        vec4 wear=texture2D(ffaWearMap,wearUV);
        float wet=texture2D(ffaWetMap,wearUV).a;
        diffuseColor.rgb=mix(diffuseColor.rgb,wear.rgb,wear.a)*(1.0-wet*0.22);`)
      .replace('#include <roughnessmap_fragment>', `
        #include <roughnessmap_fragment>
        roughnessFactor=mix(roughnessFactor,0.3,wet);`);
  };
  material.onBeforeCompile = hook;
  material.customProgramCacheKey = () => `${cache?.call(material) || ''}|ffa-mat-v1`;
  material.needsUpdate = true;
  return () => {
    if (material.onBeforeCompile === hook) {
      material.onBeforeCompile = before; material.customProgramCacheKey = cache; material.needsUpdate = true;
    }
  };
}

function makeHaze(scene) {
  const geometry = new THREE.ConeGeometry(1.1, 5, 16, 1, true);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: {},
    vertexShader: `
      varying vec2 vUv; varying vec3 vView;
      void main() { vUv=uv; vec4 p=modelViewMatrix*vec4(position,1.0); vView=-p.xyz; gl_Position=projectionMatrix*p; }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vView;
      void main() {
        vec3 n=normalize(cross(dFdx(vView),dFdy(vView)));
        float edge=pow(abs(dot(n,normalize(vView))),1.5);
        float density=sin(vUv.y*3.14159)*edge;
        // Side-dependent spectral tint imitates dispersion without a scene-copy/refraction pass.
        vec3 tint=mix(vec3(0.23,0.38,0.65),vec3(0.66,0.48,0.25),vUv.x);
        gl_FragColor=vec4(tint,density*0.025);
      }`,
  });
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
      record.uniforms.ffaWear.value = record.uniforms.ffaSweat.value = 0;
      record.previous = null; record.fallen = false;
    }
  };
  return {
    configure,
    registerFighters(entries = []) {
      for (const entry of entries) {
        const rig = entry.rig || entry;
        if (!rig.root || fighters.has(rig)) continue;
        const uniforms = { ffaWear: { value: 0 }, ffaSweat: { value: 0 } };
        const record = { entry, rig, uniforms, previous: null, fallen: false };
        fighters.set(rig, record);
        const mats = rig.materials || {};
        const seen = new Set();
        for (const [name, material] of Object.entries(mats)) {
          if (!material || seen.has(material) || !material.isMeshStandardMaterial) continue;
          seen.add(material);
          const type = ['skinMat', 'faceMat', 'plateMat'].includes(name) ? 'skin' :
            ['suitMat', 'tieMat'].includes(name) ? 'fabric' : null;
          if (type) hooks.push(hookSurface(material, uniforms, type));
        }
      }
    },
    impact({ position, normal, power = 0.5, kind = 'hit', target, blocked = false } = {}) {
      if (disposed || !position || ![position.x, position.y, position.z].every(Number.isFinite)) return;
      power = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0.5;
      const record = fighters.get(target?.rig || target);
      if (record && !blocked) record.uniforms.ffaWear.value = Math.min(1, record.uniforms.ffaWear.value + power * 0.08);
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
        const { rig, entry, uniforms } = record;
        uniforms.ffaSweat.value = Math.min(0.8, uniforms.ffaSweat.value + dt * (entry.alive === false ? -0.015 : 0.005));
        uniforms.ffaSweat.value = Math.max(0, uniforms.ffaSweat.value);
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
