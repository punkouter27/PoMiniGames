// fireball.js — volumetric FBM-displaced fireball shader + pooled point light (#1).
//
// Each detonation spawns an expanding sphere with a 3-octave FBM vertex displacement and
// a blackbody fragment ramp: white-hot core → bright orange → dark soot smoke rim.
// A short-lived pooled PointLight illuminates nearby masonry, and a smoke puff follow-up
// lingers after the fireball cools.

import * as THREE from 'three-eco/webgpu';
import {
  cameraPosition, dot, floor, fract, mix, modelWorldMatrix, normalGeometry, normalize, positionGeometry, positionWorld, select,
  smoothstep, userData, varying, vec3, vec4, clamp, max, float, Fn, cameraProjectionMatrix, cameraViewMatrix, transformNormalToView,
} from 'three-eco/tsl';

const FIREBALL_LIFE_S = 0.65;
const LIGHT_POOL_SIZE = 4;

// Per-fireball state (age, seed) rides on mesh.userData and is read through userData nodes, so
// every fireball shares ONE node graph and one compiled program. (A graph per spawn would
// compile a pipeline per explosion: a visible hitch at the exact moment of the blast.)
const uAge = userData('uAge', 'float');
const uSeed = userData('uSeed', 'float');

const hash31 = Fn(([p0]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.yzx.add(33.33)));
  return fract(p.x.add(p.y).mul(p.z));
});

const noise3 = Fn(([p]) => {
  const i = floor(p);
  const f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  const h = (ox, oy, oz) => hash31(i.add(vec3(ox, oy, oz)));
  const x00 = mix(h(0, 0, 0), h(1, 0, 0), f.x);
  const x10 = mix(h(0, 1, 0), h(1, 1, 0), f.x);
  const x01 = mix(h(0, 0, 1), h(1, 0, 1), f.x);
  const x11 = mix(h(0, 1, 1), h(1, 1, 1), f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
});

// 3-octave FBM; octaves unrolled (the loop count is fixed at 3).
const fbm = Fn(([p0]) => {
  const p = p0.toVar();
  const v = float(0).toVar();
  let amp = 0.5;
  for (let o = 0; o < 3; o++) {
    v.addAssign(noise3(p).mul(amp));
    p.assign(p.mul(2.07).add(vec3(1.7, 3.2, 2.1)));
    amp *= 0.5;
  }
  return v;
});

// 1.0 = white-hot core, 0.65 = yellow-orange, 0.35 = deep red, 0.0 = dark soot smoke
const blackbodyRamp = (temp) => {
  const soot = vec3(0.08, 0.06, 0.05), red = vec3(0.95, 0.18, 0.03);
  const orange = vec3(1.8, 0.78, 0.15), white = vec3(3.4, 3.1, 2.5);
  return select(temp.lessThan(0.35), mix(soot, red, temp.div(0.35)),
    select(temp.lessThan(0.7), mix(red, orange, temp.sub(0.35).div(0.35)), mix(orange, white, temp.sub(0.7).div(0.3))));
};

function buildFireballMaterial() {
  const n = normalize(normalGeometry);
  const nVal = fbm(n.mul(3.2).add(vec3(0, uAge.mul(-4.5), uSeed.mul(11.3))));
  const disp = nVal.sub(0.35).mul(uAge.mul(0.55).add(0.35));
  const displaced = positionGeometry.add(n.mul(disp));
  const worldPos = modelWorldMatrix.mul(vec4(displaced, 1)).xyz;
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  material.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1));
  const vNormal = varying(normalize(modelWorldMatrix.mul(vec4(n, 0)).xyz));
  const vViewDir = varying(normalize(cameraPosition.sub(worldPos)));
  const vNoise = varying(nVal);
  const ndv = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0, 1);
  // Core is hottest at centre (ndv near 1) and cools with age + FBM turbulence.
  const heat = clamp(ndv.mul(0.75).add(vNoise.mul(0.55)).sub(uAge.mul(0.85)), 0, 1);
  const edgeFade = smoothstep(0, 0.22, ndv);
  const lifeFade = smoothstep(0.45, 1.0, uAge).oneMinus();
  material.colorNode = blackbodyRamp(heat);
  material.opacityNode = clamp(edgeFade.mul(lifeFade).mul(vNoise.mul(0.35).add(0.65)), 0, 1);
  return material;
}

export class FireballPool {
  constructor(scene, onSmoke = null) {
    this.scene = scene;
    this.onSmoke = onSmoke; // optional (point, radius) callback for follow-up smoke puff
    this.geometry = new THREE.SphereGeometry(1, 20, 16);
    this.material = buildFireballMaterial();   // shared by every fireball
    this.active = [];
    this.lights = [];
    this.lightCursor = 0;

    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xff8c3b, 0, 26, 1.7);
      light.visible = false;
      scene.add(light);
      this.lights.push({ light, life: 0, maxLife: 0.25, peak: 0 });
    }
  }

  spawn(point, radius = 4.5, enabled = true) {
    if (!enabled) return;
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.userData.uAge = 0;
    mesh.userData.uSeed = Math.random() * 10;
    mesh.position.copy(point);
    mesh.scale.setScalar(Math.max(0.5, radius * 0.28));
    mesh.renderOrder = 3;
    this.scene.add(mesh);

    const slot = this.lights[this.lightCursor];
    this.lightCursor = (this.lightCursor + 1) % this.lights.length;
    slot.light.position.copy(point);
    slot.light.position.y += 0.6;
    slot.light.distance = Math.max(16, radius * 4.5);
    slot.peak = Math.min(90, 28 + radius * 8);
    slot.light.intensity = slot.peak;
    slot.light.visible = true;
    slot.maxLife = 0.28;
    slot.life = slot.maxLife;

    this.active.push({
      mesh,
      point: point.clone(),
      radius,
      age: 0,
      life: FIREBALL_LIFE_S,
      smoked: false,
    });
  }

  update(dt) {
    for (const slot of this.lights) {
      if (slot.life > 0) {
        slot.life -= dt;
        if (slot.life <= 0) {
          slot.light.visible = false;
          slot.light.intensity = 0;
        } else {
          const t = slot.life / slot.maxLife;
          slot.light.intensity = slot.peak * t * t;
        }
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      f.age += dt;
      const normAge = f.age / f.life;
      if (!f.smoked && normAge >= 0.32) {
        f.smoked = true;
        this.onSmoke?.(f.point, f.radius);
      }
      if (normAge >= 1) {
        this.scene.remove(f.mesh);
        this.active.splice(i, 1);
        continue;
      }
      f.mesh.userData.uAge = normAge;
      const grow = f.radius * (0.28 + 0.82 * (1 - Math.pow(1 - normAge, 2.4)));
      f.mesh.scale.setScalar(grow);
    }
  }

  dispose() {
    for (const f of this.active) this.scene.remove(f.mesh);
    this.active.length = 0;
    for (const slot of this.lights) {
      this.scene.remove(slot.light);
    }
    this.lights.length = 0;
    this.geometry.dispose();
    this.material.dispose();
  }
}
