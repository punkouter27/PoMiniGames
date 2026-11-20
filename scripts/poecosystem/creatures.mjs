// Authors PoEcosystem's four creature models and writes them as skinned, animated glTF:
//
//   node scripts/poecosystem/creatures.mjs            write wwwroot/models/poecosystem/*.glb
//   node scripts/poecosystem/creatures.mjs --check    rebuild in memory, exit 1 if a file differs
//
// The models are described here in code (there is no Blender file to lose): a skeleton, a
// body built from tapered prisms each bound to one joint, and clips written as functions of
// the cycle's phase. What comes out is ordinary glTF 2.0 binary: a skin, vertex colours and
// one animation per clip, so any glTF viewer opens it and a hand-made model with the same clip
// names can replace one without touching the game. The game (render/creatureModels.js) loads
// each file with three's GLTFLoader and bakes its clips into a bone-matrix texture.
//
// CLIPS, by name: idle, walk, run, feed, rest, and for people work. Every clip loops. `walk`
// and `run` carry a stride (metres of ground covered per cycle at model scale) and a top
// cadence in asset.extras.poecosystem, which is how the game matches the legs to the speed
// the sim reports.
//
// CONVENTIONS: metres, +Y up, +Z forward, feet on y = 0 (the same frame as the box rigs in
// render/creatureMeshes.js, whose sizes these follow so picking, seating and the ragdoll that
// replaces a body all still fit). A positive rotation about X tips "up" toward "forward": a
// neck goes down with +x, a hanging leg swings BACK with +x.
//
// No dependencies: the maths and the GLB container are a few dozen lines each, below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/models/poecosystem');
const TAU = Math.PI * 2;

// ── maths ────────────────────────────────────────────────────────────�
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qaxis = (axis, angle) => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
/** [x, y, z] radians, applied roll (z) first, then pitch (x), then yaw (y). */
const quat = ([x = 0, y = 0, z = 0]) => qmul(qaxis([0, 1, 0], y), qmul(qaxis([1, 0, 0], x), qaxis([0, 0, 1], z)));
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [linear(((hex >> 16) & 255) / 255), linear(((hex >> 8) & 255) / 255), linear((hex & 255) / 255)];
/** A smooth pulse of the cycle: 1 at `at`, 0 further than `width` from it (wraps). */
const pulse = (t, at, width) => { let d = Math.abs(t - at); d = Math.min(d, 1 - d); return d >= width ? 0 : 0.5 + 0.5 * Math.cos((d / width) * Math.PI); };
const wave = (t, phase = 0) => Math.sin((t + phase) * TAU);

// ── a model under construction ───────────────────────────────────────
function model(name) {
  const joints = []; const index = new Map();
  const position = []; const colour = []; const bound = []; const triangles = [];
  const m = {
    name, joints, position, colour, bound, triangles,
    /** A joint at `at` (model space, bind pose), child of `parent` (a name, or null for the root). */
    joint(jointName, parent, at) {
      index.set(jointName, joints.length);
      joints.push({ name: jointName, parent: parent === null ? -1 : index.get(parent), at });
      return m;
    },
    at: (jointName) => joints[index.get(jointName)].at,
    has: (jointName) => index.has(jointName),
    /**
     * A tapered prism from `from` to `to`, bound to one joint. `a` and `b` are the cross
     * sections at each end, [width, height]; [0, 0] at `b` makes a point. `up` orients the
     * section (its height runs along `up` as nearly as the direction allows).
     * Colours: `col` everywhere, `tip` at the far end, `under` on the lower two corners.
     */
    seg(jointName, from, to, a, b, { col, tip = col, under = null, up = [0, 1, 0] }) {
      const j = index.get(jointName);
      const d = norm(sub(to, from));
      const hint = Math.abs(dot(d, up)) > 0.96 ? [0, 0, 1] : up;
      const right = norm(cross(hint, d));
      const top = cross(d, right);
      const first = position.length / 3;
      const corners = (c, [w, h]) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => add(c, add(mul(right, su * w / 2), mul(top, sv * h / 2))));
      const put = (p, c) => { position.push(...p); colour.push(...c); bound.push(j); };
      const ringA = corners(from, a);
      ringA.forEach((p, k) => put(p, rgb(k < 2 && under !== null ? under : col)));
      const pointed = b[0] === 0 && b[1] === 0;
      if (pointed) put(to, rgb(tip));
      else corners(to, b).forEach((p, k) => put(p, rgb(k < 2 && under !== null && tip === col ? under : tip)));
      const tri = [];
      tri.push([0, 1, 2], [0, 2, 3]);                                   // the near cap
      for (let k = 0; k < 4; k++) {
        const n = (k + 1) % 4;
        if (pointed) tri.push([k, n, 4]);
        else tri.push([k, n, 4 + n], [k, 4 + n, 4 + k]);
      }
      if (!pointed) tri.push([4, 5, 6], [4, 6, 7]);                     // the far cap
      // Wound outward whatever the prism's orientation: away from its own middle.
      const middle = mul(add(from, to), 0.5);
      for (const t of tri) {
        const [p0, p1, p2] = t.map((k) => position.slice((first + k) * 3, (first + k) * 3 + 3));
        const n = cross(sub(p1, p0), sub(p2, p0));
        const out = sub(mul(add(add(p0, p1), p2), 1 / 3), middle);
        if (dot(n, out) < 0) t.reverse();
        triangles.push(first + t[0], first + t[1], first + t[2]);
      }
      return m;
    },
  };
  return m;
}

// ── four-legged animals ──────────────────────────────────────────────
function quadruped(P) {
  const m = model(P.name);
  const { sy, len, w, h, legX, legZf, legZb, legW, hip } = P;
  const neckBase = [0, sy + h * 0.22, len / 2 - 0.04];
  const neckDir = [0, Math.sin(P.neckAngle), Math.cos(P.neckAngle)];
  const headAt = add(neckBase, mul(neckDir, P.neckLen));
  const knee = hip * 0.52;
  m.joint('root', null, [0, 0, 0])
    .joint('body', 'root', [0, sy, 0])
    .joint('neck', 'body', neckBase)
    .joint('head', 'neck', headAt)
    .joint('earL', 'head', add(headAt, [-P.head.w * 0.34, P.head.h * 0.42, -0.02]))
    .joint('earR', 'head', add(headAt, [P.head.w * 0.34, P.head.h * 0.42, -0.02]))
    .joint('tail', 'body', [0, sy + h * 0.25, -len / 2]);
  for (const [leg, x, z] of [['fl', -legX, legZf], ['fr', legX, legZf], ['bl', -legX, legZb], ['br', legX, legZb]]) {
    m.joint(`${leg}_up`, 'body', [x, hip, z]).joint(`${leg}_lo`, `${leg}_up`, [x, knee, z]);
  }
  const C = P.colours;

  // Torso in two halves, so the chest can be deeper than the rump and the belly lighter.
  m.seg('body', [0, sy, -len / 2], [0, sy + h * 0.03, 0], [w * 0.84, h * 0.86], [w, h], { col: C.coat, under: C.belly });
  m.seg('body', [0, sy + h * 0.03, 0], [0, sy + h * 0.05, len / 2], [w, h], [w * 0.88, h * 1.02], { col: C.coat, under: C.belly });
  // Neck, skull, muzzle.
  m.seg('neck', sub(neckBase, mul(neckDir, 0.06)), headAt, [P.neckW, P.neckW * 1.25], [P.neckW * 0.78, P.neckW * 0.9], { col: C.coat, under: C.belly, up: [0, 0, -1] });
  const H = P.head;
  const skullBack = add(headAt, [0, H.h * 0.08, -H.len * 0.3]);
  const skullFront = add(headAt, [0, H.h * 0.02, H.len * 0.34]);
  const muzzle = add(skullFront, [0, -H.h * 0.14, H.snout]);
  m.seg('head', skullBack, skullFront, [H.w * 0.9, H.h * 0.92], [H.w, H.h], { col: C.coat, under: C.belly });
  m.seg('head', skullFront, muzzle, [H.w * 0.72, H.h * 0.66], [H.w * 0.44, H.h * 0.4], { col: C.coat, tip: P.darkMuzzle ? C.dark : C.coat, under: P.darkMuzzle ? null : C.belly });
  // The nose: a small dark block on the end of the muzzle.
  m.seg('head', add(muzzle, [0, H.h * 0.05, -0.01]), add(muzzle, [0, H.h * 0.03, 0.03 * P.detail]), [H.w * 0.3, H.h * 0.24], [H.w * 0.22, H.h * 0.16], { col: C.dark });
  for (const side of [-1, 1]) {
    const eye = add(skullFront, [side * H.w * 0.5, H.h * 0.16, -H.len * 0.12]);
    m.seg('head', eye, add(eye, [side * 0.012, 0, 0]), [0.04 * P.detail, 0.04 * P.detail], [0.03 * P.detail, 0.03 * P.detail], { col: 0x14110f });
  }
  // Ears: flat points, leaning out (and back, for a rabbit's).
  for (const [ear, side] of [['earL', -1], ['earR', 1]]) {
    const base = m.at(ear);
    const tip = add(base, [side * P.ears.out, P.ears.len, P.ears.back]);
    m.seg(ear, base, tip, [P.ears.w, P.ears.w * 0.35], [0, 0], { col: C.coat, tip: C.ear, up: [0, 0, 1] });
  }
  if (P.antlers) {
    for (const side of [-1, 1]) {
      const base = add(headAt, [side * H.w * 0.2, H.h * 0.46, -0.03]);
      const fork = add(base, [side * 0.1, 0.24, -0.06]);
      m.seg('head', base, fork, [0.035, 0.035], [0.028, 0.028], { col: C.extra });
      m.seg('head', fork, add(fork, [side * 0.07, 0.2, -0.05]), [0.028, 0.028], [0, 0], { col: C.extra });
      m.seg('head', fork, add(fork, [side * 0.04, 0.1, 0.12]), [0.026, 0.026], [0, 0], { col: C.extra });
    }
  }
  // Legs: thigh and shank, the shank ending in a dark foot.
  for (const leg of ['fl', 'fr', 'bl', 'br']) {
    const top = m.at(`${leg}_up`); const mid = m.at(`${leg}_lo`);
    const rear = leg[0] === 'b';
    m.seg(`${leg}_up`, add(top, [0, legW * 0.5, 0]), mid, [legW * (rear ? 1.55 : 1.3), legW * (rear ? 1.9 : 1.45)], [legW, legW * 1.05], { col: C.coat, up: [0, 0, 1] });
    m.seg(`${leg}_lo`, mid, [mid[0], 0, mid[2] + P.foot], [legW, legW * 1.05], [legW * 0.86, legW * 1.05], { col: C.coat, tip: C.dark, up: [0, 0, 1] });
  }
  // Tail.
  const tailAt = m.at('tail');
  const tailDir = [0, Math.sin(P.tail.angle), -Math.cos(P.tail.angle)];
  m.seg('tail', tailAt, add(tailAt, mul(tailDir, P.tail.len)), [P.tail.w, P.tail.w], P.tail.blunt ? [P.tail.w * 0.8, P.tail.w * 0.8] : [0, 0], { col: C.coat, tip: C.tail ?? C.coat });
  return m;
}

/**
 * The clips every four-legged animal shares, shaped by its gait:
 * `G.walk` / `G.run`: per-leg phase offsets [fl, fr, bl, br], the swing in radians, how far
 * the body rises, and the stride and top cadence the game reads.
 */
function quadrupedClips(P) {
  const G = P.gait;
  const legs = ['fl', 'fr', 'bl', 'br'];
  const stepping = (t, g) => {
    const pose = {};
    legs.forEach((leg, k) => {
      const ph = t + g.phase[k];
      const swing = wave(ph) * g.swing;
      const rear = leg[0] === 'b';
      // Forward is -x. The shank folds while the leg is travelling forward.
      pose[`${leg}_up`] = { r: [-swing * (rear ? 1.1 : 1), 0, 0] };
      pose[`${leg}_lo`] = { r: [g.fold * Math.max(0, Math.cos(ph * TAU)) * (rear ? 0.85 : 1), 0, 0] };
    });
    return pose;
  };
  return {
    idle: {
      seconds: 3.6, frames: 30,
      pose: (t) => ({
        body: { p: [0, 0.006 * wave(t * 2), 0] },
        neck: { r: [0.05 * wave(t), 0.24 * wave(t, 0.15), 0] },
        head: { r: [-0.05 * wave(t), 0.2 * wave(t, 0.25), 0] },
        tail: { r: [0, 0.5 * wave(t * 4) * pulse(t, 0.55, 0.2), 0] },
        earL: { r: [0, 0, 0.35 * pulse(t, 0.22, 0.05)] },
        earR: { r: [0, 0, -0.35 * pulse(t, 0.72, 0.05)] },
      }),
    },
    walk: {
      seconds: 1, frames: 16, stride: G.walk.stride, cadence: G.walk.cadence,
      pose: (t) => ({
        ...stepping(t, G.walk),
        body: { p: [0, G.walk.rise * Math.abs(wave(t)), 0], r: [G.walk.pitch * wave(t, 0.1), 0, 0.025 * wave(t)] },
        neck: { r: [0.07 * wave(t * 2, 0.1), 0, 0] },
        head: { r: [-0.06 * wave(t * 2, 0.1), 0, 0] },
        tail: { r: [0.06 * wave(t * 2), 0.18 * wave(t), 0] },
      }),
    },
    run: {
      seconds: 1, frames: 16, stride: G.run.stride, cadence: G.run.cadence,
      pose: (t) => ({
        ...stepping(t, G.run),
        body: { p: [0, G.run.rise * Math.max(0, wave(t, 0.1)), 0], r: [G.run.pitch * wave(t, 0.3), 0, 0] },
        // The neck reaches forward and the tail streams.
        neck: { r: [G.run.reach + 0.08 * wave(t, 0.4), 0, 0] },
        head: { r: [-G.run.reach * 0.6, 0, 0] },
        tail: { r: [-0.45 + 0.15 * wave(t, 0.2), 0, 0] },
        earL: { r: [-0.5, 0, 0] }, earR: { r: [-0.5, 0, 0] },
      }),
    },
    feed: {
      seconds: 2.4, frames: 24,
      pose: (t) => {
        const nibble = 0.09 * wave(t * 5);
        return {
          body: { r: [0.05, 0, 0] },
          neck: { r: [P.feedNeck + 0.04 * wave(t), 0.1 * wave(t, 0.2), 0] },
          head: { r: [P.feedHead + nibble, 0, 0] },
          fl_up: { r: [-0.1, 0, 0] }, fr_up: { r: [-0.1, 0, 0] },
          tail: { r: [0, 0.4 * wave(t * 3) * pulse(t, 0.4, 0.2), 0] },
          earL: { r: [0, 0, 0.3 * pulse(t, 0.6, 0.06)] },
        };
      },
    },
    rest: {
      seconds: 4, frames: 20,
      pose: (t) => {
        const breath = 0.008 * wave(t);
        return {
          // Lying on the brisket: the body down by most of a leg, legs folded under it.
          body: { p: [0, -P.restDrop + breath, 0], r: [0, 0, 0.05] },
          fl_up: { r: [-1.2, 0, 0] }, fr_up: { r: [-1.2, 0, 0] },
          fl_lo: { r: [2.5, 0, 0] }, fr_lo: { r: [2.5, 0, 0] },
          bl_up: { r: [-1.0, 0, 0] }, br_up: { r: [-1.0, 0, 0] },
          bl_lo: { r: [2.2, 0, 0] }, br_lo: { r: [2.2, 0, 0] },
          neck: { r: [P.restNeck + 0.03 * wave(t), 0.5, 0] },
          head: { r: [-P.restNeck * 0.5, 0.25, 0] },
          tail: { r: [0.3, 0.2, 0] },
          earL: { r: [0, 0, 0.3 * pulse(t, 0.5, 0.04)] },
        };
      },
    },
  };
}

const RABBIT = {
  name: 'rabbit', detail: 0.9,
  colours: { coat: 0xd9c8a9, belly: 0xf1e8d6, dark: 0x8a6f5a, ear: 0xe8b7ae, tail: 0xfaf6ee },
  sy: 0.5, len: 0.74, w: 0.46, h: 0.4, hip: 0.4, legX: 0.17, legZf: 0.26, legZb: -0.24, legW: 0.11, foot: 0.07,
  neckAngle: 0.75, neckLen: 0.16, neckW: 0.26,
  head: { len: 0.3, w: 0.3, h: 0.28, snout: 0.1 },
  ears: { len: 0.42, w: 0.12, out: 0.04, back: -0.1 },
  tail: { len: 0.13, w: 0.16, angle: 0.5, blunt: true },
  feedNeck: 0.7, feedHead: -0.1, restDrop: 0.27, restNeck: 0.25,
  gait: {
    // A hop: the fronts land together, then the hinds come through together.
    walk: { phase: [0, 0.04, 0.5, 0.54], swing: 0.55, fold: 0.8, rise: 0.07, pitch: 0.08, stride: 0.9, cadence: 3.2 },
    run: { phase: [0, 0.03, 0.42, 0.45], swing: 0.95, fold: 1.3, rise: 0.2, pitch: 0.2, reach: 0.2, stride: 1.7, cadence: 3.6 },
  },
};

const DEER = {
  name: 'deer', detail: 1,
  colours: { coat: 0x9a6b3f, belly: 0xd8b48a, dark: 0x2e231a, ear: 0xc79a72, tail: 0xf4ead9, extra: 0xd9cdb4 },
  sy: 0.66, len: 0.9, w: 0.42, h: 0.4, hip: 0.56, legX: 0.16, legZf: 0.32, legZb: -0.32, legW: 0.085, foot: 0.02,
  neckAngle: 1.05, neckLen: 0.4, neckW: 0.19,
  head: { len: 0.3, w: 0.2, h: 0.22, snout: 0.2 },
  ears: { len: 0.2, w: 0.1, out: 0.11, back: -0.03 },
  tail: { len: 0.14, w: 0.09, angle: -0.5, blunt: false },
  antlers: true,
  feedNeck: 1.5, feedHead: -0.55, restDrop: 0.4, restNeck: 0.2,
  gait: {
    walk: { phase: [0, 0.5, 0.5, 0], swing: 0.42, fold: 0.7, rise: 0.015, pitch: 0.012, stride: 1.25, cadence: 2.4 },
    run: { phase: [0, 0.1, 0.5, 0.6], swing: 0.85, fold: 1.25, rise: 0.1, pitch: 0.13, reach: 0.4, stride: 2.9, cadence: 2.8 },
  },
};

const WOLF = {
  name: 'wolf', detail: 1,
  colours: { coat: 0x6b7280, belly: 0xb9bec8, dark: 0x1c1d22, ear: 0x3f434d, tail: 0x3f434d },
  sy: 0.62, len: 1.0, w: 0.4, h: 0.38, hip: 0.54, legX: 0.15, legZf: 0.35, legZb: -0.36, legW: 0.1, foot: 0.05,
  neckAngle: 0.5, neckLen: 0.3, neckW: 0.24,
  head: { len: 0.32, w: 0.27, h: 0.25, snout: 0.24 },
  ears: { len: 0.17, w: 0.11, out: 0.02, back: -0.02 },
  tail: { len: 0.52, w: 0.14, angle: -0.6, blunt: false },
  darkMuzzle: true,
  feedNeck: 0.95, feedHead: -0.2, restDrop: 0.36, restNeck: 0.55,
  gait: {
    walk: { phase: [0, 0.5, 0.5, 0], swing: 0.45, fold: 0.75, rise: 0.012, pitch: 0.012, stride: 1.3, cadence: 2.5 },
    run: { phase: [0, 0.12, 0.5, 0.62], swing: 0.9, fold: 1.3, rise: 0.08, pitch: 0.12, reach: 0.3, stride: 2.8, cadence: 3 },
  },
};

// ── people ───────────────────────────────────────────────────────────
function human() {
  const m = model('human');
  const C = { tunic: 0xc7d2fe, kilt: 0x8f9bd6, skin: 0xd8a47f, hair: 0x3a2a20, sole: 0x4a3a2e };
  m.joint('root', null, [0, 0, 0])
    .joint('pelvis', 'root', [0, 0.98, 0])
    .joint('chest', 'pelvis', [0, 1.12, 0])
    .joint('head', 'chest', [0, 1.68, 0]);
  for (const [side, x] of [['L', -1], ['R', 1]]) {
    m.joint(`arm${side}_up`, 'chest', [x * 0.27, 1.6, 0]).joint(`arm${side}_lo`, `arm${side}_up`, [x * 0.29, 1.3, 0]);
    m.joint(`leg${side}_up`, 'pelvis', [x * 0.11, 0.95, 0]).joint(`leg${side}_lo`, `leg${side}_up`, [x * 0.11, 0.5, 0]);
  }
  // Hips and kilt, then the trunk widening to the shoulders.
  m.seg('pelvis', [0, 0.82, 0], [0, 1.13, 0], [0.36, 0.24], [0.33, 0.22], { col: C.kilt, up: [0, 0, 1] });
  m.seg('chest', [0, 1.1, 0], [0, 1.64, 0], [0.32, 0.21], [0.44, 0.25], { col: C.tunic, up: [0, 0, 1] });
  // Neck, head, hair.
  m.seg('head', [0, 1.62, 0], [0, 1.72, 0.01], [0.12, 0.12], [0.12, 0.12], { col: C.skin, up: [0, 0, 1] });
  m.seg('head', [0, 1.7, 0.01], [0, 1.96, 0.01], [0.21, 0.23], [0.24, 0.25], { col: C.skin, up: [0, 0, 1] });
  m.seg('head', [0, 1.9, -0.02], [0, 2.0, -0.02], [0.26, 0.27], [0.2, 0.21], { col: C.hair, up: [0, 0, 1] });
  m.seg('head', [0, 1.74, -0.1], [0, 1.94, -0.12], [0.24, 0.08], [0.25, 0.08], { col: C.hair, up: [0, 0, 1] });
  m.seg('head', [0, 1.82, 0.13], [0, 1.8, 0.17], [0.05, 0.07], [0.03, 0.04], { col: C.skin });
  for (const [side, x] of [['L', -1], ['R', 1]]) {
    const sh = m.at(`arm${side}_up`); const el = m.at(`arm${side}_lo`);
    m.seg(`arm${side}_up`, add(sh, [0, 0.04, 0]), el, [0.13, 0.13], [0.1, 0.1], { col: C.tunic, up: [0, 0, 1] });
    m.seg(`arm${side}_lo`, el, [el[0], 1.0, 0], [0.095, 0.095], [0.08, 0.08], { col: C.skin, up: [0, 0, 1] });
    m.seg(`arm${side}_lo`, [el[0], 1.0, 0], [el[0], 0.9, 0.01], [0.085, 0.1], [0.06, 0.08], { col: C.skin, up: [0, 0, 1] });
    const hipAt = m.at(`leg${side}_up`); const kn = m.at(`leg${side}_lo`);
    m.seg(`leg${side}_up`, hipAt, kn, [0.16, 0.17], [0.12, 0.13], { col: C.kilt, tip: C.skin, up: [0, 0, 1] });
    m.seg(`leg${side}_lo`, kn, [kn[0], 0.07, 0], [0.115, 0.125], [0.09, 0.1], { col: C.skin, up: [0, 0, 1] });
    m.seg(`leg${side}_lo`, [kn[0], 0.07, -0.05], [kn[0], 0.07, 0.17], [0.1, 0.07], [0.09, 0.05], { col: C.sole });
    void x;
  }
  return m;
}

function humanClips() {
  const limbs = (t, { leg, knee, arm, elbow }) => {
    const pose = {};
    for (const [side, ph] of [['L', 0], ['R', 0.5]]) {
      const s = wave(t + ph);
      pose[`leg${side}_up`] = { r: [-s * leg, 0, 0] };
      pose[`leg${side}_lo`] = { r: [knee * Math.max(0, Math.cos((t + ph) * TAU)), 0, 0] };
      // Arms swing against the legs.
      pose[`arm${side}_up`] = { r: [s * arm, 0, 0] };
      pose[`arm${side}_lo`] = { r: [-elbow - 0.15 * Math.max(0, -s), 0, 0] };
    }
    return pose;
  };
  // The chop: a long lift, a short hard swing, a pause in the wood.
  const swing = (t) => (t < 0.55 ? 0.5 - 0.5 * Math.cos((t / 0.55) * Math.PI) : t < 0.7 ? 1 - (t - 0.55) / 0.15 : 0);
  return {
    idle: {
      seconds: 4, frames: 28,
      pose: (t) => ({
        pelvis: { p: [0.012 * wave(t), 0, 0] },
        chest: { p: [0, 0.006 * wave(t * 2), 0], r: [0.02 * wave(t * 2), 0.07 * wave(t), 0] },
        head: { r: [0.04 * wave(t, 0.3), 0.35 * wave(t, 0.1), 0] },
        armL_up: { r: [0.05 * wave(t), 0, 0.06] }, armR_up: { r: [-0.05 * wave(t), 0, -0.06] },
        armL_lo: { r: [-0.12, 0, 0] }, armR_lo: { r: [-0.12, 0, 0] },
      }),
    },
    walk: {
      seconds: 1, frames: 16, stride: 1.25, cadence: 2,
      pose: (t) => ({
        ...limbs(t, { leg: 0.5, knee: 0.75, arm: 0.42, elbow: 0.2 }),
        pelvis: { p: [0, 0.02 * Math.abs(wave(t)), 0] },
        chest: { r: [0.05, 0.09 * wave(t), 0] },
        head: { r: [-0.03, -0.06 * wave(t), 0] },
      }),
    },
    run: {
      seconds: 1, frames: 16, stride: 2.3, cadence: 2.6,
      pose: (t) => ({
        ...limbs(t, { leg: 0.95, knee: 1.35, arm: 0.85, elbow: 1.35 }),
        pelvis: { p: [0, 0.05 * Math.abs(wave(t)), 0] },
        chest: { r: [0.24, 0.12 * wave(t), 0] },
        head: { r: [-0.16, -0.06 * wave(t), 0] },
      }),
    },
    feed: {
      // Foraging, or drinking: down on bent knees, hands working at the ground.
      seconds: 2.4, frames: 24,
      pose: (t) => {
        const reach = 0.22 * wave(t * 2);
        return {
          pelvis: { p: [0, -0.3, -0.06] },
          chest: { r: [0.95 + 0.05 * wave(t), 0.08 * wave(t), 0] },
          head: { r: [-0.4, 0, 0] },
          legL_up: { r: [-1.15, 0, 0] }, legR_up: { r: [-1.05, 0, 0] },
          legL_lo: { r: [1.75, 0, 0] }, legR_lo: { r: [1.65, 0, 0] },
          armL_up: { r: [-0.75 + reach, 0, 0] }, armR_up: { r: [-0.75 - reach, 0, 0] },
          armL_lo: { r: [-0.35, 0, 0] }, armR_lo: { r: [-0.35, 0, 0] },
        };
      },
    },
    rest: {
      // Sitting on the ground, knees up, arms on them.
      seconds: 4.4, frames: 20,
      pose: (t) => ({
        pelvis: { p: [0, -0.72, 0] },
        chest: { p: [0, 0.006 * wave(t), 0], r: [0.28 + 0.02 * wave(t), 0, 0] },
        head: { r: [0.1 + 0.05 * wave(t, 0.2), 0.2 * wave(t * 0.5), 0] },
        legL_up: { r: [-1.95, 0, 0] }, legR_up: { r: [-1.9, 0, 0] },
        legL_lo: { r: [1.9, 0, 0] }, legR_lo: { r: [1.85, 0, 0] },
        armL_up: { r: [-0.95, 0, 0.1] }, armR_up: { r: [-0.95, 0, -0.1] },
        armL_lo: { r: [-0.5, 0, 0] }, armR_lo: { r: [-0.5, 0, 0] },
      }),
    },
    work: {
      // Chopping, building, tending: both hands up and over, then down hard.
      seconds: 1.5, frames: 24,
      pose: (t) => {
        const up = swing(t);
        return {
          pelvis: { p: [0, -0.06 * (1 - up), 0] },
          chest: { r: [0.42 - 0.6 * up, 0.12 * up, 0] },
          head: { r: [-0.2 + 0.25 * up, 0, 0] },
          armL_up: { r: [-0.7 - 2.0 * up, 0, 0.18] }, armR_up: { r: [-0.7 - 2.0 * up, 0, -0.18] },
          armL_lo: { r: [-0.35 - 0.5 * up, 0, 0] }, armR_lo: { r: [-0.35 - 0.5 * up, 0, 0] },
          legL_up: { r: [-0.28, 0, 0] }, legR_up: { r: [0.22, 0, 0] },
          legL_lo: { r: [0.3, 0, 0] }, legR_lo: { r: [0.12, 0, 0] },
        };
      },
    },
  };
}

// ── glTF binary ──────────────────────────────────────────────────────�
function toGlb(m, clips) {
  const chunks = []; let length = 0;
  const views = []; const accessors = [];
  /** Append a typed array as its own buffer view + accessor; returns the accessor index. */
  const push = (array, type, { target = undefined, normalized = false, minMax = false } = {}) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(bytes); length += bytes.length;
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType = array instanceof Float32Array ? 5126 : array instanceof Uint16Array ? 5123 : 5121;
    const acc = { bufferView: views.length - 1, componentType, count: array.length / size, type, ...(normalized ? { normalized: true } : {}) };
    if (minMax) {
      acc.min = Array(size).fill(Infinity); acc.max = Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i++) { const k = i % size; acc.min[k] = Math.min(acc.min[k], array[i]); acc.max[k] = Math.max(acc.max[k], array[i]); }
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const n = m.position.length / 3;
  const jointsAttr = new Uint8Array(n * 4); const weights = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { jointsAttr[i * 4] = m.bound[i]; weights[i * 4] = 255; }
  const attributes = {
    POSITION: push(new Float32Array(m.position), 'VEC3', { target: 34962, minMax: true }),
    COLOR_0: push(new Float32Array(m.colour), 'VEC3', { target: 34962 }),
    JOINTS_0: push(jointsAttr, 'VEC4', { target: 34962 }),
    WEIGHTS_0: push(weights, 'VEC4', { target: 34962, normalized: true }),
  };
  const indices = push(new Uint16Array(m.triangles), 'SCALAR', { target: 34963 });

  // Joints are nodes 0..J-1 (bind pose: translation only), the mesh is node J.
  const J = m.joints.length;
  const nodes = m.joints.map((j, k) => {
    const from = j.parent < 0 ? [0, 0, 0] : m.joints[j.parent].at;
    const children = m.joints.map((c, ci) => (c.parent === k ? ci : -1)).filter((ci) => ci >= 0);
    return { name: j.name, translation: sub(j.at, from).map(Math.fround), ...(children.length ? { children } : {}) };
  });
  nodes.push({ name: m.name, mesh: 0, skin: 0 });
  const inverseBind = new Float32Array(J * 16);
  m.joints.forEach((j, k) => { inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -j.at[0], -j.at[1], -j.at[2], 1], k * 16); });
  const skin = { joints: m.joints.map((_, k) => k), skeleton: 0, inverseBindMatrices: push(inverseBind, 'MAT4') };

  const animations = []; const extras = {};
  for (const [name, clip] of Object.entries(clips)) {
    const F = clip.frames;
    const times = new Float32Array(F + 1);
    for (let f = 0; f <= F; f++) times[f] = (f / F) * clip.seconds;
    const input = push(times, 'SCALAR', { minMax: true });
    // Frame F is frame 0 again: the clip loops, and a sampler needs both ends.
    const poses = Array.from({ length: F + 1 }, (_, f) => clip.pose((f % F) / F));
    const samplers = []; const channels = [];
    m.joints.forEach((j, k) => {
      if (!poses.some((p) => p[j.name])) return;
      const rot = new Float32Array((F + 1) * 4);
      poses.forEach((p, f) => rot.set(quat(p[j.name]?.r ?? [0, 0, 0]), f * 4));
      samplers.push({ input, output: push(rot, 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: k, path: 'rotation' } });
      if (poses.some((p) => p[j.name]?.p)) {
        const rest = nodes[k].translation;
        const pos = new Float32Array((F + 1) * 3);
        poses.forEach((p, f) => pos.set(add(rest, p[j.name]?.p ?? [0, 0, 0]), f * 3));
        samplers.push({ input, output: push(pos, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: k, path: 'translation' } });
      }
    });
    for (const j of Object.keys(poses[0])) if (!m.has(j)) throw new Error(`${m.name}/${name}: no joint "${j}"`);
    animations.push({ name, samplers, channels });
    if (clip.stride) extras[name] = { stride: clip.stride, cadence: clip.cadence };
  }

  const json = {
    asset: { version: '2.0', generator: 'PoMiniGames scripts/poecosystem/creatures.mjs', extras: { poecosystem: { clips: extras } } },
    scene: 0,
    scenes: [{ name: m.name, nodes: [0, J] }],
    nodes,
    meshes: [{ name: m.name, primitives: [{ attributes, indices, material: 0, mode: 4 }] }],
    materials: [{ name: 'vertex-colour', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    skins: [skin],
    animations,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: 0 }],
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

// ── main ─────────────────────────────────────────────────────────────
const MODELS = [
  [quadruped(RABBIT), quadrupedClips(RABBIT)],
  [quadruped(DEER), quadrupedClips(DEER)],
  [quadruped(WOLF), quadrupedClips(WOLF)],
  [human(), humanClips()],
];
const check = process.argv.includes('--check');
let stale = 0;
if (!check) fs.mkdirSync(OUT, { recursive: true });
for (const [m, clips] of MODELS) {
  const glb = toGlb(m, clips);
  const file = path.join(OUT, `${m.name}.glb`);
  const summary = `${m.name}.glb  ${m.triangles.length / 3} triangles, ${m.position.length / 3} vertices, ${m.joints.length} joints, ${Object.keys(clips).join(' ')}  ${(glb.length / 1024).toFixed(1)} KB`;
  if (check) {
    const same = fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), glb) === 0;
    console.log(`${same ? 'ok   ' : 'STALE'} ${summary}`);
    if (!same) stale++;
  } else {
    fs.writeFileSync(file, glb);
    console.log(`wrote ${summary}`);
  }
}
if (stale) { console.error(`${stale} model(s) differ from this script: run it without --check`); process.exit(1); }
