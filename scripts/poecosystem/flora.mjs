// Authors PoEcosystem's trees and bushes and writes them as one glTF file:
//
//   node scripts/poecosystem/flora.mjs            write wwwroot/models/poecosystem/flora.glb
//   node scripts/poecosystem/flora.mjs --check    rebuild in memory, exit 1 if the file differs
//
// Every tree on the island used to be the same five-sided post with a six-sided cone on it,
// and a bush a twenty-sided ball. These are the island's plants as shapes: pines for the high
// ground, broadleaf trees for the forest, palms behind the beach, a charred snag for what a
// fire leaves standing, and bushes with and without berries. Like the creatures
// (creatures.mjs) they are described here in code, so there is no model file to lose and a
// change is a diff.
//
// WHAT COMES OUT: ordinary glTF 2.0 binary, one mesh per variety, each a node named for it
// (`pine-a`, `broadleaf-b`, `palm-a`, `snag-a`, `bush-a`, `berry-a`, ...). Positions, vertex
// colours and indices; no normals (the game shades its plants flat), no textures, no
// materials to speak of. The game (render/floraMeshes.js) loads the file with three's
// GLTFLoader and draws each variety as one instanced mesh; a variety it cannot find, or a
// file that will not load, leaves that plant on the cone it always was.
//
// CONVENTIONS: metres, +Y up, the plant's foot at the origin. A tree's trunk stays inside
// TRUNK_RADIUS: the simulation keeps creatures clear of a trunk by a fixed distance
// (sim/terrain/ground.js), and a fatter trunk would be walked through. `asset.extras
// .poecosystem.flora` lists, per mesh, its height and the height its foliage starts at,
// which is where the game lets the wind take hold of it.
//
// No dependencies: the shapes and the GLB container are a few dozen lines each, below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/models/poecosystem/flora.glb');
const TAU = Math.PI * 2;
const TRUNK_RADIUS = 0.26;

// ── maths ───────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [linear(((hex >> 16) & 255) / 255), linear(((hex >> 8) & 255) / 255), linear((hex & 255) / 255)];
/** A seeded 0..1 stream: the same plant every run. */
function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── a plant under construction ──────────────────────────────────────────────
function plant(name, { foliageFrom = 0 } = {}) {
  const position = []; const colour = []; const triangles = [];
  const put = (p, c) => { position.push(...p); colour.push(...c); return position.length / 3 - 1; };
  /** Two directions square to `d` and to each other. */
  const frame = (d) => {
    const hint = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(hint, d));
    return [u, cross(d, u)];
  };
  const m = {
    name, position, colour, triangles, foliageFrom,
    /**
     * A tapered prism of `sides` from `from` to `to`: radius `ra` at the near end, `rb` at
     * the far one (0 makes a point). Colour runs from `ca` to `cb`. `skew` 0..1 makes the
     * near ring ragged, which is what stops a cone's skirt looking turned on a lathe.
     */
    limb(from, to, ra, rb, sides, ca, cb, { skew = 0, rnd = null, cap = false, twist = 0 } = {}) {
      const d = norm(sub(to, from));
      const [u, v] = frame(d);
      const ring = (c, r, col, ragged) => Array.from({ length: sides }, (_, k) => {
        const a = (k / sides) * TAU + twist;
        const rr = r * (ragged && rnd ? 1 - skew + rnd() * skew * 2 : 1);
        return put(add(c, add(mul(u, Math.cos(a) * rr), mul(v, Math.sin(a) * rr))), col);
      });
      const A = ring(from, ra, rgb(ca), true);
      if (rb === 0) {
        const tip = put(to, rgb(cb));
        for (let k = 0; k < sides; k++) triangles.push(A[k], A[(k + 1) % sides], tip);
      } else {
        const B = ring(to, rb, rgb(cb), false);
        for (let k = 0; k < sides; k++) {
          const n = (k + 1) % sides;
          triangles.push(A[k], A[n], B[n], A[k], B[n], B[k]);
        }
        if (cap) { const c = put(to, rgb(cb)); for (let k = 0; k < sides; k++) triangles.push(B[k], B[(k + 1) % sides], c); }
      }
      // The underside of a skirt, so a crown is not hollow when the camera is under it.
      if (cap || rb === 0) { const c = put(from, rgb(ca)); for (let k = 0; k < sides; k++) triangles.push(A[(k + 1) % sides], A[k], c); }
      return m;
    },
    /** A lump of foliage: a twenty-sided ball pulled about, dark underneath and light on top. */
    blob(centre, radii, rnd, dark, light, lumpy = 0.22) {
      const t = (1 + Math.sqrt(5)) / 2;
      const base = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
      const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
      const idx = base.map((b) => {
        const k = 1 - lumpy + rnd() * lumpy * 2;
        const p = [centre[0] + b[0] * radii[0] * k, centre[1] + b[1] * radii[1] * k, centre[2] + b[2] * radii[2] * k];
        return put(p, lerp3(rgb(dark), rgb(light), Math.max(0, Math.min(1, b[1] * 0.6 + 0.5))));
      });
      for (const f of faces) triangles.push(idx[f[0]], idx[f[1]], idx[f[2]]);
      return m;
    },
    /** A frond: a strip from `from` along `dir` that droops, drawn on both faces. */
    frond(from, dir, length, width, droop, dark, light) {
      const d = norm(dir);
      const side = norm(cross(d, [0, 1, 0]));
      const steps = 3; let prevL = -1; let prevR = -1;
      for (let s = 0; s <= steps; s++) {
        const k = s / steps;
        const at = add(add(from, mul(d, length * k)), [0, -droop * k * k, 0]);
        const w = width * Math.sin(Math.PI * Math.min(1, 0.15 + k * 0.85)) * 0.5 + 0.02;
        const col = lerp3(rgb(dark), rgb(light), k);
        const L = put(add(at, mul(side, -w)), col); const R = put(add(at, mul(side, w)), col);
        if (prevL >= 0) triangles.push(prevL, prevR, R, prevL, R, L, prevR, prevL, R, R, prevL, L);
        prevL = L; prevR = R;
      }
      return m;
    },
    /** A berry: a small four-sided gem. */
    berry(at, r, col) {
      const top = put(add(at, [0, r, 0]), rgb(col)); const bot = put(add(at, [0, -r, 0]), rgb(col));
      const ring = [[r, 0, 0], [0, 0, r], [-r, 0, 0], [0, 0, -r]].map((o) => put(add(at, o), rgb(col)));
      for (let k = 0; k < 4; k++) { const n = (k + 1) % 4; triangles.push(ring[k], top, ring[n], ring[n], bot, ring[k]); }
      return m;
    },
  };
  return m;
}

const BARK = 0x6b4423; const BARK_DARK = 0x4a2f18; const BARK_PALE = 0x8a6a45;

/** A pine: a straight trunk and a stack of ragged skirts, the widest lowest. */
function pine(name, seed, { height = 5.4, tiers = 3, spread = 1.45 } = {}) {
  const rnd = stream(seed);
  const m = plant(name, { foliageFrom: height * 0.26 });
  const lean = [(rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25];
  const top = add([0, height, 0], lean);
  m.limb([0, 0, 0], lerp3([0, 0, 0], top, 0.62), 0.22, 0.1, 5, BARK_DARK, BARK);
  for (let t = 0; t < tiers; t++) {
    const k = t / tiers;
    const from = lerp3([0, 0, 0], top, 0.26 + k * 0.5);
    const to = lerp3([0, 0, 0], top, Math.min(1, 0.26 + k * 0.5 + 0.34 + (t === tiers - 1 ? 0.2 : 0)));
    m.limb(from, to, spread * (1 - k * 0.55), 0, 7, 0x1d4a2a, 0x3d7a3a, { skew: 0.2, rnd, twist: t * 0.6 + rnd() });
  }
  return m;
}

/** A broadleaf tree: a forked trunk under two or three lumps of crown. */
function broadleaf(name, seed, { height = 4.9, crown = 1.5 } = {}) {
  const rnd = stream(seed);
  const m = plant(name, { foliageFrom: height * 0.42 });
  const fork = [(rnd() - 0.5) * 0.3, height * 0.46, (rnd() - 0.5) * 0.3];
  m.limb([0, 0, 0], fork, 0.25, 0.17, 5, BARK_DARK, BARK);
  const lumps = 2 + (rnd() < 0.6 ? 1 : 0);
  for (let l = 0; l < lumps; l++) {
    const a = (l / lumps) * TAU + rnd() * 1.2;
    const out = l === 0 ? 0.15 : 0.55 + rnd() * 0.35;
    const c = [fork[0] + Math.cos(a) * crown * out, height * (0.68 + rnd() * 0.16), fork[2] + Math.sin(a) * crown * out];
    m.limb(fork, lerp3(fork, c, 0.7), 0.13, 0.06, 4, BARK, BARK_PALE);
    const r = crown * (l === 0 ? 0.95 : 0.62 + rnd() * 0.2);
    m.blob(c, [r, r * 0.78, r], rnd, 0x2a5c22, 0x6da33a);
  }
  return m;
}

/** A palm: a trunk that bows, and a head of drooping fronds. */
function palm(name, seed, { height = 5.2 } = {}) {
  const rnd = stream(seed);
  const m = plant(name, { foliageFrom: height * 0.82 });
  const bow = rnd() * TAU; const reach = 0.5 + rnd() * 0.5;
  const spine = (k) => [Math.cos(bow) * reach * k * k, height * k, Math.sin(bow) * reach * k * k];
  const cuts = 4;
  for (let s = 0; s < cuts; s++) m.limb(spine(s / cuts), spine((s + 1) / cuts), 0.2 - s * 0.025, 0.2 - (s + 1) * 0.025, 5, s % 2 ? BARK_PALE : 0x7a5c38, s % 2 ? 0x7a5c38 : BARK_PALE);
  const head = spine(1);
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * TAU + rnd() * 0.4;
    m.frond(head, [Math.cos(a), 0.35 + rnd() * 0.3, Math.sin(a)], 1.8 + rnd() * 0.5, 0.5, 1.1 + rnd() * 0.6, 0x2f6b2a, 0x7fb04a);
  }
  m.berry(add(head, [0.12, -0.12, 0.05]), 0.11, 0x5a3d22);
  m.berry(add(head, [-0.1, -0.15, -0.08]), 0.1, 0x5a3d22);
  return m;
}

/** What a fire leaves: a black trunk and the stubs of two limbs. */
function snag(name, seed) {
  const rnd = stream(seed);
  const m = plant(name, { foliageFrom: 99 });
  const top = [(rnd() - 0.5) * 0.35, 2.4 + rnd() * 0.9, (rnd() - 0.5) * 0.35];
  m.limb([0, 0, 0], top, 0.2, 0.07, 5, 0x1c1a19, 0x2b2623, { cap: true });
  for (let b = 0; b < 2; b++) {
    const from = lerp3([0, 0, 0], top, 0.45 + b * 0.25);
    const a = rnd() * TAU;
    m.limb(from, add(from, [Math.cos(a) * 0.7, 0.45 + rnd() * 0.3, Math.sin(a) * 0.7]), 0.07, 0, 4, 0x211e1c, 0x35302c);
  }
  return m;
}

/** A bush: three lumps on the ground; with `berries`, fruit standing proud of the leaves. */
function bush(name, seed, berries) {
  const rnd = stream(seed);
  const m = plant(name, { foliageFrom: 0.1 });
  const lumps = [[0, 0.42, 0, 0.55], [0.38, 0.3, 0.12, 0.36], [-0.3, 0.28, -0.22, 0.34]];
  for (const [x, y, z, r] of lumps) m.blob([x, y, z], [r, r * 0.8, r], rnd, 0x21552a, 0x4f8a3a, 0.18);
  if (berries) {
    for (let k = 0; k < 9; k++) {
      const a = rnd() * TAU; const up = 0.25 + rnd() * 0.55; const out = 0.5 * Math.sqrt(1 - Math.min(0.9, (up - 0.42) ** 2 * 3));
      m.berry([Math.cos(a) * out, up, Math.sin(a) * out], 0.085, k % 3 ? 0xb3122f : 0xd8324e);
    }
  }
  return m;
}

// ── glTF binary ───────────────────────────────────────────────────────────
function toGlb(plants) {
  const chunks = []; let length = 0;
  const views = []; const accessors = [];
  const push = (array, type, { target = undefined, minMax = false } = {}) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes); length += bytes.length;
    const size = { SCALAR: 1, VEC3: 3 }[type];
    const acc = { bufferView: views.length - 1, componentType: array instanceof Float32Array ? 5126 : 5123, count: array.length / size, type };
    if (minMax) {
      acc.min = Array(size).fill(Infinity); acc.max = Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i++) { const k = i % size; acc.min[k] = Math.min(acc.min[k], array[i]); acc.max[k] = Math.max(acc.max[k], array[i]); }
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const meshes = []; const nodes = []; const extras = {};
  for (const m of plants) {
    if (m.position.length / 3 > 65535) throw new Error(`${m.name}: too many vertices for 16-bit indices`);
    const attributes = {
      POSITION: push(new Float32Array(m.position), 'VEC3', { target: 34962, minMax: true }),
      COLOR_0: push(new Float32Array(m.colour), 'VEC3', { target: 34962 }),
    };
    const indices = push(new Uint16Array(m.triangles), 'SCALAR', { target: 34963 });
    meshes.push({ name: m.name, primitives: [{ attributes, indices, material: 0, mode: 4 }] });
    nodes.push({ name: m.name, mesh: meshes.length - 1 });
    let height = 0; let reach = 0;
    for (let i = 0; i < m.position.length; i += 3) { height = Math.max(height, m.position[i + 1]); reach = Math.max(reach, Math.hypot(m.position[i], m.position[i + 2])); }
    extras[m.name] = { height: Math.round(height * 100) / 100, reach: Math.round(reach * 100) / 100, foliageFrom: Math.round(m.foliageFrom * 100) / 100 };
  }
  const json = {
    asset: { version: '2.0', generator: 'PoMiniGames scripts/poecosystem/flora.mjs', extras: { poecosystem: { flora: extras, trunkRadius: TRUNK_RADIUS } } },
    scene: 0,
    scenes: [{ name: 'flora', nodes: nodes.map((_, k) => k) }],
    nodes, meshes,
    materials: [{ name: 'vertex-colour', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors, bufferViews: views, buffers: [{ byteLength: 0 }],
  };
  const tail = (4 - (length % 4)) % 4;
  if (tail) { chunks.push(Buffer.alloc(tail)); length += tail; }
  json.buffers[0].byteLength = length;
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

// ── main ────────────────────────────────────────────────────────────────
const PLANTS = [
  pine('pine-a', 11, { height: 5.6, tiers: 3 }),
  pine('pine-b', 12, { height: 6.6, tiers: 4, spread: 1.3 }),
  pine('pine-c', 13, { height: 4.5, tiers: 3, spread: 1.6 }),
  broadleaf('broadleaf-a', 21),
  broadleaf('broadleaf-b', 22, { height: 5.5, crown: 1.7 }),
  broadleaf('broadleaf-c', 23, { height: 4.2, crown: 1.35 }),
  palm('palm-a', 31),
  palm('palm-b', 32, { height: 6.1 }),
  snag('snag-a', 41),
  snag('snag-b', 42),
  bush('bush-a', 51, false),
  bush('bush-b', 52, false),
  bush('berry-a', 51, true),
  bush('berry-b', 52, true),
];
for (const m of PLANTS) {
  // A trunk must stay inside the room the simulation leaves for it (see the header).
  for (let i = 0; i < m.position.length; i += 3) {
    if (m.position[i + 1] < 0.9 && Math.hypot(m.position[i], m.position[i + 2]) > TRUNK_RADIUS + 1e-6 && !m.name.startsWith('bush') && !m.name.startsWith('berry')) {
      throw new Error(`${m.name}: wider than ${TRUNK_RADIUS} m below 0.9 m`);
    }
  }
}
const glb = toGlb(PLANTS);
const check = process.argv.includes('--check');
const tris = PLANTS.map((m) => `${m.name} ${m.triangles.length / 3}`).join(', ');
const summary = `flora.glb  ${PLANTS.length} plants (triangles: ${tris})  ${(glb.length / 1024).toFixed(1)} KB`;
if (check) {
  const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), glb) === 0;
  console.log(`${same ? 'ok   ' : 'STALE'} ${summary}`);
  if (!same) { console.error('flora.glb differs from this script: run it without --check'); process.exit(1); }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, glb);
  console.log(`wrote ${summary}`);
}
