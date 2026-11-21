// fx-race.js — WebGPU / TSL GPU particle system & speed-streak state for PoMarbleRace.
//
// Runs an 8,192-slot ring buffer of GPU-simulated particles (sparks, confetti, kicker shockwaves,
// boost chevrons, finish fountains) using THREE.PointsNodeMaterial + TSL so the exact same node
// graph compiles to WGSL on WebGPU and GLSL on the WebGL2 backend in ONE draw call.
//
// COLLIDING PARTICLES (platform/3d/gpuParticles.js). Those 8,192 follow closed-form curves in the
// vertex shader, so a spark never lands on the track and a landing never raises dust that settles.
// On the WebGPU backend `attachGpu()` adds a compute particle system (65k-262k slots by quality
// tier) that bounces off the track, walls and ramps the camera sees (screen-space depth collision):
// impact sparks, track-chip debris, landing dust and, on snowy maps, snow. `sparks`, `pop` and the
// new `debris` / `dust` / `snow` bursts go to it when it is up; every other burst, and every burst
// on the WebGL2 backend or while it is still building, stays on the ring above.
// scene.js hands over (renderer, camera, scene-pass depth) with one call after it builds the pipeline.
import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { createGpuParticles } from '../platform/3d/gpuParticles.js';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const POOL = 8192;
const GRAVITY = 26;
const DRAG = 2.2;
const FINISH = [0x22d3ee, 0xe879f9, 0xa3e635, 0xfb923c, 0xfde047, 0xf472b6, 0xffffff];
const rnd = (a, b) => a + Math.random() * (b - a);

function createBursts(scene) {
  const pos = new Float32Array(POOL * 3);
  const vel = new Float32Array(POOL * 3);
  const meta = new Float32Array(POOL * 4); // x birth, y life, z size, w gravity scale
  const col = new Float32Array(POOL * 3);
  for (let i = 0; i < POOL; i++) meta[i * 4] = -1e6;

  const geo = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(pos, 3),
    aVel: new THREE.BufferAttribute(vel, 3),
    aMeta: new THREE.BufferAttribute(meta, 4),
    aColor: new THREE.BufferAttribute(col, 3),
  };
  for (const [k, a] of Object.entries(attrs)) {
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, a);
  }

  const uTime = TSL.uniform(0);
  const aPos = TSL.attribute('position', 'vec3');
  const aVel = TSL.attribute('aVel', 'vec3');
  const aMeta = TSL.attribute('aMeta', 'vec4');
  const aColor = TSL.attribute('aColor', 'vec3');

  const age = uTime.sub(aMeta.x);
  const alive = age.greaterThanEqual(0).and(age.lessThanEqual(aMeta.y));
  const t = TSL.clamp(age, 0, 10);
  const k = TSL.float(1).sub(TSL.exp(t.mul(-DRAG))).div(DRAG);
  const dropY = t.mul(t).mul(0.5 * GRAVITY).mul(aMeta.w);
  const simPos = aPos.add(aVel.mul(k)).sub(TSL.vec3(0, dropY, 0));
  const life = TSL.clamp(TSL.float(1).sub(t.div(TSL.max(aMeta.y, 0.001))), 0, 1);

  const mat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  mat.positionNode = TSL.select(alive, simPos, TSL.vec3(0, -99999, 0));
  mat.colorNode = aColor.mul(1.25);
  mat.opacityNode = TSL.select(alive, life.mul(life), TSL.float(0));
  mat.sizeNode = TSL.select(alive, aMeta.z.mul(16), TSL.float(0));

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.noAO = true;
  scene.add(points);

  let head = 0, clock = 0, lo = POOL, hi = -1;
  const _c = new THREE.Color();

  function emit(x, y, z, vx, vy, vz, lifeS, size, grav, hex) {
    const i = head; head = (head + 1) % POOL;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
    meta[i * 4] = clock; meta[i * 4 + 1] = lifeS; meta[i * 4 + 2] = size; meta[i * 4 + 3] = grav;
    _c.setHex(hex);
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    if (i < lo) lo = i;
    if (i > hi) hi = i;
  }

  function kicker(p) {
    for (let k = 0; k < 44; k++) {
      const a = (k / 44) * Math.PI * 2 + rnd(-0.05, 0.05);
      const sp = rnd(26, 36);
      emit(p.x, p.y + 0.4, p.z, Math.cos(a) * sp, rnd(2, 6), Math.sin(a) * sp,
        rnd(0.45, 0.7), rnd(0.8, 1.3), 0.15, k % 3 ? 0xe879f9 : 0xffffff);
    }
  }

  function pop(p) {
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rnd(8, 22);
      emit(p.x, p.y, p.z, Math.cos(a) * sp, rnd(6, 16), Math.sin(a) * sp,
        rnd(0.35, 0.6), rnd(0.5, 0.9), 1, k % 2 ? 0xf0abfc : 0xfef08a);
    }
  }

  function boost(p, dir) {
    const bx = dir ? -dir.x : 0, by = dir ? -dir.y : 0, bz = dir ? -dir.z : -1;
    for (let k = 0; k < 6; k++) {
      const sp = rnd(14, 28);
      emit(p.x + rnd(-0.7, 0.7), p.y + rnd(-0.2, 0.5), p.z + rnd(-0.7, 0.7),
        bx * sp + rnd(-4, 4), by * sp + rnd(1, 5), bz * sp + rnd(-4, 4),
        rnd(0.25, 0.45), rnd(0.55, 0.95), 0.15, k % 3 ? 0x22d3ee : 0xe0f2fe);
    }
  }

  function finish(p, big) {
    const n = big ? 110 : 36;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = rnd(4, big ? 24 : 14);
      emit(p.x, p.y + 0.8, p.z, Math.cos(a) * r, rnd(14, big ? 30 : 20), Math.sin(a) * r,
        rnd(0.9, 1.4), big ? 1.0 : 0.7, 1, FINISH[(Math.random() * FINISH.length) | 0]);
    }
    if (!big) return;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      emit(p.x, p.y + 0.3, p.z, Math.cos(a) * 30, 1, Math.sin(a) * 30, 0.7, 1.2, 0, 0xfde047);
    }
  }

  function sparks(p, colorHex, count = 9, strength = 1) {
    const hex = colorHex ?? 0xffd9a0;
    for (let k = 0; k < count; k++) {
      emit(p.x, p.y, p.z,
        (Math.random() - 0.5) * 14 * strength,
        (Math.random() * 0.7 + 0.3) * 12 * strength,
        (Math.random() - 0.5) * 14 * strength,
        rnd(0.35, 0.65), 0.75, 1, hex);
    }
  }

  function confetti(p, count = 24) {
    for (let k = 0; k < count; k++) {
      emit(p.x, p.y + 1.2, p.z,
        (Math.random() - 0.5) * 20,
        Math.random() * 14 + 8,
        (Math.random() - 0.5) * 20,
        rnd(0.9, 1.5), 0.95, 0.85, FINISH[(Math.random() * FINISH.length) | 0]);
    }
  }

  function update(dt) {
    clock += dt;
    uTime.value = clock;
    if (hi < lo) return;
    for (const a of Object.values(attrs)) {
      a.needsUpdate = true;
    }
    lo = POOL; hi = -1;
  }

  return {
    points,
    spawn(kind, p, dir, big) {
      if (!p) return;
      if (kind === 'kicker') kicker(p);
      else if (kind === 'pop') pop(p);
      else if (kind === 'boost') boost(p, dir);
      else if (kind === 'finish') finish(p, !!big);
      else if (kind === 'sparks') sparks(p, dir, big?.count, big?.strength);
      else if (kind === 'confetti') confetti(p, big);
    },
    update,
    clear() { for (let i = 0; i < POOL; i++) meta[i * 4] = -1e6; lo = 0; hi = POOL - 1; },
    dispose() { scene.remove(points); geo.dispose(); mat.dispose(); },
  };
}

export function createRaceFx({ scene, level = 'full' }) {
  const bursts = createBursts(scene);
  let enabled = level !== 'lite';
  let boosting = false;
  let streakVal = 0;
  let clock = 0;
  // GPU colliding particles: bound lazily (the renderer finishes its async init after createScene).
  let gpuArgs = null; let gpu = null; let gpuTried = 0;
  const gpuScale = () => { const t = (typeof window !== 'undefined' && window.PoQuality?.tier?.()) || 'high'; return t === 'low' ? 0.4 : t === 'medium' ? 0.7 : 1; };
  function bindGpu() {
    if (gpu || !gpuArgs || gpuTried > 600) return;
    if (!gpuArgs.renderer?.backend) return;   // not initialised yet
    gpuTried = 601;
    try { gpu = createGpuParticles(gpuArgs.renderer, scene, { camera: gpuArgs.camera, depth: gpuArgs.depth }); } catch (e) { console.warn('[fx-race] gpu particles unavailable:', e?.message || e); gpu = null; }
    if (gpu) gpu.mesh.visible = false;
  }
  const v3 = (x, y, z) => ({ x, y, z });

  /** Spawn on the GPU system when it is up. Returns true if it took the burst. */
  function gpuBurst(kind, p, dir, big) {
    if (!gpu || gpu.failed || !p) return false;
    const k = gpuScale();
    if (kind === 'sparks') {
      const n = Math.round((big?.count ?? 9) * 14 * k), st = big?.strength ?? 1;
      gpu.emit(v3(p.x, p.y, p.z), v3(0, 7 * st, 0), n, 'sparks', { spread: 9 * st, speedJitter: 0.3, radius: 0.1, colour: dir ?? 0xffd9a0 });
      return true;
    }
    if (kind === 'pop') {
      gpu.emit(v3(p.x, p.y + 0.2, p.z), v3(0, 4, 0), Math.round(220 * k), 'sparks', { spread: 12, radius: 0.3, colour: 0xfef08a });
      gpu.emit(v3(p.x, p.y + 0.1, p.z), v3(0, 1.5, 0), Math.round(40 * k), 'dust', { spread: 3, radius: 0.5, size: 1.0 });
      gpu.emit(v3(p.x, p.y + 0.1, p.z), v3(0, 5, 0), Math.round(30 * k), 'debris', { spread: 7, radius: 0.3, colour: 0x8a8f99 });
      return false;       // the ring's own pop still plays: this adds the bits that land
    }
    if (kind === 'debris') { gpu.emit(v3(p.x, p.y, p.z), dir ?? v3(0, 5, 0), Math.round((big ?? 40) * k), 'debris', { spread: 6 }); return true; }
    if (kind === 'dust') { gpu.emit(v3(p.x, p.y, p.z), dir ?? v3(0, 1.5, 0), Math.round((big ?? 30) * k), 'dust', { spread: 3, radius: 0.6 }); return true; }
    if (kind === 'snow') { gpu.emit(v3(p.x, p.y, p.z), dir ?? v3(0, -1, 0), Math.round((big ?? 200) * k), 'snow', { spread: 1.5, radius: 14 }); return true; }
    return false;
  }

  return {
    /** The compute particle system (or null): `.stats()`, `.emit()` for tests and tools. */
    get gpu() { return gpu; },
    /** scene.js: renderer, the camera, and the scene pass's depth node (optional: without it particles do not collide). */
    attachGpu(args) { gpuArgs = args; gpuTried = 0; bindGpu(); },
    burst(kind, pos, dir, big) {
      if (!enabled || reducedMotion()) return;
      if (gpuBurst(kind, pos, dir, big)) return;
      if (kind === 'debris' || kind === 'dust' || kind === 'snow') return;   // GPU-only kinds
      bursts.spawn(kind, pos, dir, big);
    },
    setBoosting(b) { boosting = !!b; },
    flashDirt() { /* handled via TSL bloom + streak in scene.js */ },
    setTheme() { },
    setLevel(l) {
      enabled = l !== 'lite';
      bursts.points.visible = enabled;
      if (!enabled) { bursts.clear(); gpu?.clear(); }
    },
    get streak() { return streakVal; },
    get time() { return clock; },
    update(dt, speed) {
      clock += dt;
      if (!enabled || reducedMotion()) {
        streakVal = 0;
        return;
      }
      bursts.update(dt);
      if (!gpu) bindGpu();
      gpu?.update(dt);
      const target = Math.max(0, Math.min(1, ((speed || 0) - 48) / 42)) * 0.7 + (boosting ? 0.55 : 0);
      streakVal += (Math.min(1, target) - streakVal) * (1 - Math.exp(-8 * dt));
    },
    resize() { },
    dispose() { bursts.dispose(); gpu?.dispose(); },
  };
}
