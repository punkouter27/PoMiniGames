// fireball.js — volumetric FBM-displaced fireball shader + pooled point light (#1).
//
// Each detonation spawns an expanding sphere with a 3-octave FBM vertex displacement and
// a blackbody fragment ramp: white-hot core → bright orange → dark soot smoke rim.
// A short-lived pooled PointLight illuminates nearby masonry, and a smoke puff follow-up
// lingers after the fireball cools.

import * as THREE from 'three';

const FIREBALL_LIFE_S = 0.65;
const LIGHT_POOL_SIZE = 4;

const FIREBALL_VERTEX = /* glsl */`
  uniform float uAge;
  uniform float uSeed;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vNoise;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise3(p);
      p = p * 2.07 + vec3(1.7, 3.2, 2.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 n = normalize(normal);
    float nVal = fbm(n * 3.2 + vec3(0.0, -uAge * 4.5, uSeed * 11.3));
    vNoise = nVal;
    float disp = (nVal - 0.35) * (0.35 + uAge * 0.55);
    vec3 displaced = position + n * disp;
    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vNormal = normalize(mat3(modelMatrix) * n);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FIREBALL_FRAGMENT = /* glsl */`
  uniform float uAge;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vNoise;

  vec3 blackbodyRamp(float temp) {
    // 1.0 = white-hot core, 0.65 = yellow-orange, 0.35 = deep red, 0.0 = dark soot smoke
    vec3 soot = vec3(0.08, 0.06, 0.05);
    vec3 red = vec3(0.95, 0.18, 0.03);
    vec3 orange = vec3(1.8, 0.78, 0.15);
    vec3 white = vec3(3.4, 3.1, 2.5);
    if (temp < 0.35) return mix(soot, red, temp / 0.35);
    if (temp < 0.7) return mix(red, orange, (temp - 0.35) / 0.35);
    return mix(orange, white, (temp - 0.7) / 0.3);
  }

  void main() {
    float ndv = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
    // Core is hottest at center (ndv near 1) and cools with age + FBM turbulence
    float heat = clamp(ndv * 0.75 + vNoise * 0.55 - uAge * 0.85, 0.0, 1.0);
    vec3 col = blackbodyRamp(heat);
    float edgeFade = smoothstep(0.0, 0.22, ndv);
    float lifeFade = 1.0 - smoothstep(0.45, 1.0, uAge);
    float alpha = clamp(edgeFade * lifeFade * (0.65 + 0.35 * vNoise), 0.0, 1.0);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export class FireballPool {
  constructor(scene, onSmoke = null) {
    this.scene = scene;
    this.onSmoke = onSmoke; // optional (point, radius) callback for follow-up smoke puff
    this.geometry = new THREE.SphereGeometry(1, 20, 16);
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
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAge: { value: 0 },
        uSeed: { value: Math.random() * 10 },
      },
      vertexShader: FIREBALL_VERTEX,
      fragmentShader: FIREBALL_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
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
      material,
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
        f.material.dispose();
        this.active.splice(i, 1);
        continue;
      }
      f.material.uniforms.uAge.value = normAge;
      const grow = f.radius * (0.28 + 0.82 * (1 - Math.pow(1 - normAge, 2.4)));
      f.mesh.scale.setScalar(grow);
    }
  }

  dispose() {
    for (const f of this.active) {
      this.scene.remove(f.mesh);
      f.material.dispose();
    }
    this.active.length = 0;
    for (const slot of this.lights) {
      this.scene.remove(slot.light);
    }
    this.lights.length = 0;
    this.geometry.dispose();
  }
}
