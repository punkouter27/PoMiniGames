// bolt.js — lightning you can see.
//
// A strike had sparks, embers, smoke, camera trauma and a thunderclap that arrives late by
// the right amount for its distance. It had no bolt: the one thing that says "lightning" from
// across the island was missing, and a far strike was a puff of smoke on a hillside.
//
// This draws the bolt itself and nothing else. eventFx.js left a whole-screen flash out on
// purpose (a strobe on every weather event reads as the screen flickering) and that decision
// stands: a bolt is a LINE IN THE SKY, a few pixels wide, and the only other light is a soft
// glow on the underside of the cloud it came from.
//
//   SHAPE     a midpoint-displaced path from the cloud deck to the struck tile, with two or
//             three forks that die out on the way down. Seeded from the tile and the tick,
//             so the same strike is the same bolt in a replay.
//   RIBBON    each segment is two crossed quads, so the bolt has width from any side without
//             a camera-facing shader. Additive and brighter than white: the bloom the post
//             chain already runs is what makes it glow.
//   TIMING    a stroke, a dip, a return stroke, an afterglow: about a third of a second.
//             Under the app's reduce-flashing setting it is one dim line that fades over
//             half a second, with no return stroke and no cloud glow.
//
// A small fixed pool: a storm can throw two strikes inside a second.
import { AdditiveBlending, BufferAttribute, BufferGeometry, CircleGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three-eco/webgpu';
import { float, length, smoothstep, uniform, uv, vec3 } from 'three-eco/tsl';
import { VIEW_ONLY_LAYER } from './materials.js';

const POOL = 3;
const CLOUD_Y = 92;            // just under sky.js's cloud plane
const MAIN_STEPS = 5;          // midpoint subdivisions: 2^5 = 32 segments down the trunk
const FORK_SEGMENTS = 7;
const MAX_FORKS = 3;
const MAX_SEGMENTS = (1 << MAIN_STEPS) + MAX_FORKS * FORK_SEGMENTS;
const GLOW_RADIUS = 70;
const LIFE = 0.36;
const CALM_LIFE = 0.6;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bolt's brightness at `t` seconds into a strike: stroke, dip, return stroke, afterglow. */
export function boltLevel(t, calm = false) {
  if (t < 0) return 0;
  if (calm) return t >= CALM_LIFE ? 0 : 0.4 * (1 - t / CALM_LIFE);
  if (t >= LIFE) return 0;
  if (t < 0.05) return 1;
  if (t < 0.09) return 0.22;
  if (t < 0.15) return 0.85;
  const k = (t - 0.15) / (LIFE - 0.15);
  return 0.6 * (1 - k) * (1 - k);
}

/**
 * The bolt's path: `{ points: Float32Array(xyz...), segments: [[from, to, width], ...] }`.
 * Pure, so the shape can be checked without a GPU.
 */
export function boltPath(x, y, z, seed) {
  const rnd = mulberry(seed);
  const top = [x + (rnd() - 0.5) * 30, CLOUD_Y, z + (rnd() - 0.5) * 30];
  let path = [top, [x, y, z]];
  let sway = 9;
  for (let s = 0; s < MAIN_STEPS; s++) {
    const next = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]; const b = path[i];
      next.push([(a[0] + b[0]) / 2 + (rnd() - 0.5) * sway, (a[1] + b[1]) / 2 + (rnd() - 0.5) * sway * 0.35, (a[2] + b[2]) / 2 + (rnd() - 0.5) * sway], b);
    }
    path = next;
    sway *= 0.55;
  }
  const points = []; const segments = [];
  const push = (p) => { points.push(p[0], p[1], p[2]); return points.length / 3 - 1; };
  let last = push(path[0]);
  for (let i = 1; i < path.length; i++) { const k = push(path[i]); segments.push([last, k, 0.34]); last = k; }

  // Forks leave the upper two thirds of the trunk, lean away from it and thin out.
  const forks = 2 + (rnd() < 0.5 ? 1 : 0);
  for (let f = 0; f < forks && f < MAX_FORKS; f++) {
    const from = Math.floor(path.length * (0.25 + rnd() * 0.45));
    const o = path[from];
    const ang = rnd() * Math.PI * 2;
    const reach = 2.5 + rnd() * 3;
    let px = o[0]; let py = o[1]; let pz = o[2];
    let prev = from;                       // trunk points were pushed in path order
    for (let k = 1; k <= FORK_SEGMENTS; k++) {
      // Each step leans the fork's way and kinks as hard as it leans: a fork is as jagged
      // as the trunk, never a straight streak.
      px += Math.cos(ang) * reach * 0.4 + (rnd() - 0.5) * reach * 0.9;
      py -= reach * 0.5 + rnd() * reach * 0.5;
      pz += Math.sin(ang) * reach * 0.4 + (rnd() - 0.5) * reach * 0.9;
      if (py < y + 3) break;
      const idx = push([px, py, pz]);
      segments.push([prev, idx, 0.2 * (1 - k / (FORK_SEGMENTS + 1))]);
      prev = idx;
    }
  }
  return { points: new Float32Array(points), segments, top };
}

export function createBolts(scene) {
  const bolts = [];
  for (let b = 0; b < POOL; b++) {
    const positions = new Float32Array(MAX_SEGMENTS * 8 * 3);
    const index = new Uint16Array(MAX_SEGMENTS * 12);
    for (let s = 0; s < MAX_SEGMENTS; s++) {
      const v = s * 8; const i = s * 12;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3, v + 4, v + 5, v + 6, v + 6, v + 5, v + 7], i);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    const uLevel = uniform(0);
    const material = new MeshBasicNodeMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false, side: DoubleSide, fog: false });
    // Brighter than white on purpose: the scene target is HDR and the bloom finds it.
    material.colorNode = vec3(2.6, 2.9, 3.6).mul(uLevel);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false; mesh.visible = false; mesh.name = `bolt-${b}`; mesh.renderOrder = 14;
    mesh.layers.set(VIEW_ONLY_LAYER);
    scene.add(mesh);

    const uGlow = uniform(0);
    const glowMat = new MeshBasicNodeMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false, side: DoubleSide, fog: false });
    glowMat.colorNode = vec3(0.62, 0.7, 0.95);
    glowMat.opacityNode = float(1).sub(smoothstep(0, 0.5, length(uv().sub(0.5)))).mul(uGlow);
    const glowGeo = new CircleGeometry(GLOW_RADIUS, 24);
    glowGeo.rotateX(-Math.PI / 2);
    const glow = new Mesh(glowGeo, glowMat);
    glow.frustumCulled = false; glow.visible = false; glow.name = `bolt-glow-${b}`; glow.renderOrder = -4;
    glow.layers.set(VIEW_ONLY_LAYER);
    scene.add(glow);
    bolts.push({ mesh, geometry, positions, material, uLevel, glow, glowMat, glowGeo, uGlow, age: 1e9, calm: false });
  }

  function build(bolt, path) {
    const p = path.points; const out = bolt.positions;
    let s = 0;
    for (const [a, b, w] of path.segments) {
      if (s >= MAX_SEGMENTS) break;
      const ax = p[a * 3]; const ay = p[a * 3 + 1]; const az = p[a * 3 + 2];
      const bx = p[b * 3]; const by = p[b * 3 + 1]; const bz = p[b * 3 + 2];
      let dx = bx - ax; let dy = by - ay; let dz = bz - az;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      // Two directions square to the segment and to each other. The first is dir x Z (a
      // bolt runs mostly down, so dir x Y would vanish on it).
      let ux = dy; let uy = -dx; let uz = 0;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-3) { ux = 1; uy = 0; uz = 0; ul = 1; }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = dy * uz - dz * uy; const vy = dz * ux - dx * uz; const vz = dx * uy - dy * ux;
      const o = s * 24;
      const put = (k, x, y, z) => { out[o + k * 3] = x; out[o + k * 3 + 1] = y; out[o + k * 3 + 2] = z; };
      put(0, ax - ux * w, ay - uy * w, az - uz * w); put(1, ax + ux * w, ay + uy * w, az + uz * w);
      put(2, bx - ux * w, by - uy * w, bz - uz * w); put(3, bx + ux * w, by + uy * w, bz + uz * w);
      put(4, ax - vx * w, ay - vy * w, az - vz * w); put(5, ax + vx * w, ay + vy * w, az + vz * w);
      put(6, bx - vx * w, by - vy * w, bz - vz * w); put(7, bx + vx * w, by + vy * w, bz + vz * w);
      s++;
    }
    bolt.geometry.attributes.position.needsUpdate = true;
    bolt.geometry.setDrawRange(0, s * 12);
    return s;
  }

  return {
    /**
     * A strike at a world point. `seed` makes the shape (tile and tick); `calm` is the
     * reduce-flashing form. Returns the number of segments drawn.
     */
    strike(x, y, z, seed = 1, calm = false) {
      // The oldest bolt is the one to reuse.
      let bolt = bolts[0];
      for (const b of bolts) if (b.age > bolt.age) bolt = b;
      const path = boltPath(x, y, z, seed);
      const segs = build(bolt, path);
      bolt.age = 0; bolt.calm = !!calm;
      bolt.mesh.visible = true;
      bolt.glow.position.set(path.top[0], CLOUD_Y + 1, path.top[2]);
      bolt.glow.visible = !calm;
      return segs;
    },
    update(dt) {
      for (const b of bolts) {
        if (!b.mesh.visible) continue;
        b.age += dt;
        const level = boltLevel(b.age, b.calm);
        b.uLevel.value = level;
        b.uGlow.value = b.calm ? 0 : level * 0.55;
        if (level <= 0 && b.age > 0.05) { b.mesh.visible = false; b.glow.visible = false; }
      }
    },
    /** How many bolts are on screen now (a harness reads it). */
    get live() { return bolts.filter(b => b.mesh.visible).length; },
    get bolts() { return bolts; },
    dispose() {
      for (const b of bolts) {
        scene.remove(b.mesh, b.glow);
        b.geometry.dispose(); b.material.dispose(); b.glowGeo.dispose(); b.glowMat.dispose();
      }
      bolts.length = 0;
    },
  };
}
