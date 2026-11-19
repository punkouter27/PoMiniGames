// fighterFx.js — the shader nodes every fighter's materials share: the ink edge, and blood
// that spatters and runs.
//
// ONE GRAPH FOR EVERYBODY. three keys a compiled program by its node graph, and a node's key
// includes its own identity: a graph built per fighter is a new program per fighter, so every
// bout (and all sixteen fighters of a battle royale) paid seconds of shader builds for code
// that was already compiled. The graphs here are built once, at module load, and handed to
// every fighter; what differs per fighter is read at draw time from the mesh being drawn
// (`mesh.userData.fx`, one shared object per rig), so a new fighter reuses the programs the
// last one left behind.
//
// Presentation only. Nothing here reads or writes match state.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, abs, attribute, clamp, dot, exp, float, floor, fract, length, materialColor, materialRoughness, max, mix,
  normalView, output, positionLocal, positionViewDirection, pow, sin, smoothstep, step, texture, userData, vec2, vec3,
  vec4,
} from 'three-eco/tsl';

// Fresnel edge darkening in the fighters' own materials — free, unlike an inverted hull /
// outline pass (a second draw of every fighter mesh), and identical on capsules.
export const INK_BASE = 0.55;      // resting edge strength
export const INK_POWER = 2.6;      // Fresnel exponent — higher = tighter line
// Navy, not black: pure black reads as a hole once bloom lights around it.
export const INK_COLOR = 0x05070f;
// A face cut's red; well below full red, which AgX at this exposure turns salmon-pink.
const BLOOD_COLOR = 0x4a0806;
// How far full wear opens the blood pattern on skin and on cloth (0..1).
const WEAR_SKIN = 1;
const WEAR_CLOTH = 0.55;
// Wounds: the last few places a fighter was cut. Blood is densest round each one and runs
// down from it; the rest of the body only picks up a light spatter.
export const HITS = 4;
const HIT_RADIUS = 0.17;       // metres of dense blood round a wound
const DRIP_WIDTH = 0.03;       // half-width of the run below it
const DRIP_MAX = 0.42;         // a run stops this far down
const BODY_SHARE = 0.3;        // how much of the wear shows away from any wound
// Blows: the last few places a fighter was struck, bleeding or not. Each sends a ripple out
// through the surface round it and squashes the part it landed on, which springs back.
const DENTS = 4;
const RIPPLE_SPEED = 1.5;      // m/s the ripple front travels over the body
const RIPPLE_SECS = 0.55;      // it is spent after this
const SQUASH = 0.11;           // peak squash of the struck part, as a share of its size

const fx = (name, type) => userData(`fx.${name}`, type);
// The impact light flashes inches from a fighter at many times the house lights' power, and
// the lit result can leave the range a half-float target holds; what comes back out of the
// bloom and the tone map is then blocks of rainbow garbage on the struck part. Bounded here,
// where the fighters' shading ends: no negatives, and nothing brighter than the bloom can use.
const HDR_MAX = 16;
const sane = (rgb) => clamp(rgb, 0, HDR_MAX);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _hit = new THREE.Vector3();
// normalView is the shaded view-space normal (post normal-map) and positionViewDirection is
// fragment→camera; their dot falling toward 0 IS the silhouette. Mixed over the lit colour
// before the pipeline's tone mapping, so the line survives AgX's shoulder.
const INK_OUTPUT = Fn(() => {
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  const ink = clamp(pow(facing.oneMinus(), fx('inkPower', 'float')).mul(fx('ink', 'float')), 0, 1);
  return vec4(mix(sane(output.rgb), fx('inkColor', 'color'), ink), output.a);
})();

// The pattern's randomness: a small tiling texture of smooth noise, three independent
// channels. Looked up, not computed: procedural 3D noise evaluated four times per fragment
// made the fighters' shaders take ten seconds to compile and halved the frame rate.
let _noiseTex = null;
function noiseTexture() {
  if (_noiseTex) return _noiseTex;
  const N = 64, data = new Uint8Array(N * N * 4);
  // Value noise on an 8-cell lattice per channel, smoothstep-interpolated, so it tiles.
  const L = 8, lattice = [0, 1, 2].map(() => Array.from({ length: L * L }, () => Math.random()));
  const fade = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const gx = (x / N) * L, gy = (y / N) * L;
      const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = fade(gx - x0), fy = fade(gy - y0);
      for (let c = 0; c < 3; c++) {
        const at = (ix, iy) => lattice[c][(iy % L) * L + (ix % L)];
        const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
          + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
        data[(y * N + x) * 4 + c] = Math.round(v * 255);
      }
      data[(y * N + x) * 4 + 3] = 255;
    }
  }
  _noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
  _noiseTex.magFilter = _noiseTex.minFilter = THREE.LinearFilter;
  _noiseTex.colorSpace = THREE.NoColorSpace;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

// Where the sweat is on a piece of skin: beads standing on it, and trickles running down it.
// Both come up out of the noise as `fx.sweat` rises, the trickles sliding as `sweatRun` grows.
// `glint` is the bright heart of each bead and the spine of each trickle: the part that
// throws the lights back whatever the angle, because a bead is a little dome.
export function sweatParts(sweat = fx('sweat', 'float'), sweatRun = fx('sweatRun', 'float')) {
  const noise = noiseTexture();
  const p = positionLocal;
  const across = p.x.add(p.z.mul(0.73));
  const on = smoothstep(0.05, 0.2, sweat);
  // Beads: about a centimetre across, a few at first, a scattering on a drenched face.
  const beadNoise = texture(noise, vec2(across, p.y).mul(74)).g;
  const beadAt = mix(0.985, 0.8, sweat);
  const beads = smoothstep(beadAt, beadAt.add(0.025), beadNoise);
  const down = p.y.add(sweatRun);
  const strand = texture(noise, vec2(across.mul(14), down.mul(0.9))).r;
  const trickleAt = mix(0.96, 0.52, sweat);
  const fed = smoothstep(trickleAt, trickleAt.add(0.06), texture(noise, vec2(across.mul(2.3), down.mul(0.27))).b);
  const trickles = smoothstep(0.66, 0.72, strand).mul(fed);
  const glint = max(smoothstep(beadAt.add(0.03), beadAt.add(0.06), beadNoise), smoothstep(0.71, 0.76, strand).mul(fed).mul(0.5));
  return { wetSkin: max(beads, trickles).mul(on), glint: glint.mul(on) };
}

// Blood on a fighter: fine spatter where it landed, and thin runs that creep down the body
// while it is fresh. All of it is noise in the mesh's own space, so it stays put as the body
// moves, and it is thresholded by the fighter's wear, so more blood means more of the same
// pattern rather than a new one popping in.
//   spots  two scales of fine noise: centimetre flecks with a gritty edge
//   runs   noise stretched down the body, so it reads as strands. Its lookup slides with
//          `run` (metres travelled), which is what makes them flow
//   wet    fresh blood is glossy; it dulls as `wet` falls
function bloodNodes(share, skin = false) {
  const wear = fx('wear', 'float'), run = fx('run', 'float'), wet = fx('wet', 'float');
  const noise = noiseTexture();
  const p = positionLocal;
  // Where this fragment is in its joint's own space (baked per vertex by applyFighterFx),
  // against the wounds recorded in that joint's space: (x, y, z, joint id + strength).
  const jp = attribute('jpos', 'vec3');
  const joint = userData('fxJoint', 'float');
  const hits = fx('hits', 'vec4'), hitRuns = fx('hitRuns', 'float');
  let near = float(0), drip = float(0);
  for (let i = 0; i < HITS; i++) {
    const h = hits.element(i);
    const mine = step(abs(floor(h.w).sub(joint)), 0.5).mul(fract(h.w));
    const d = jp.sub(h.xyz);
    near = near.add(mine.mul(smoothstep(0, HIT_RADIUS, length(d)).oneMinus()));
    // Below the wound, in a narrow column, as far as the blood has run since it opened.
    const ran = clamp(run.sub(hitRuns.element(i)), 0, DRIP_MAX);
    const below = d.y.negate();
    drip = drip.add(mine
      .mul(smoothstep(DRIP_WIDTH * 0.35, DRIP_WIDTH, length(d.xz)).oneMinus())
      .mul(step(0, below)).mul(smoothstep(ran.mul(0.75), ran.add(0.012), below).oneMinus()));
  }
  const amount = clamp(wear.mul(BODY_SHARE).add(near), 0, 1).mul(share);
  // Across the body: x and z folded into one axis, so every face of a box gets a pattern.
  const across = p.x.add(p.z.mul(0.73));
  const fleck = texture(noise, vec2(across, p.y).mul(8.5)).r.mul(0.7)
    .add(texture(noise, vec2(across.mul(1.31).add(0.37), p.y.mul(1.17)).mul(23)).g.mul(0.3));
  // The noise sits around 0.5 with most of it inside ±0.2, so these thresholds run from
  // "a few flecks" to about a quarter of the surface.
  // (Value noise from a texture is spread wider than Perlin, so the bar starts high: a
  // fighter with a little blood on them shows a few flecks, not a rash.)
  const spotAt = mix(0.9, 0.62, amount);
  const spots = smoothstep(spotAt, spotAt.add(0.03), fleck);
  // Strands: tight across the body, long down it. `feed` decides which stretches of skin
  // carry a run at all, so they come in ragged groups, not an even comb.
  const slide = p.y.add(run);
  const lanes = texture(noise, vec2(across.mul(11), slide.mul(0.85)));
  const feedAt = mix(0.82, 0.48, amount);
  const runs = smoothstep(0.63, 0.69, lanes.b)
    .mul(smoothstep(feedAt, feedAt.add(0.06), texture(noise, vec2(across.mul(2), slide.mul(0.31))).r));
  const stained = max(max(spots, runs.mul(0.92)), clamp(drip, 0, 1)).mul(smoothstep(0, 0.04, wear));
  if (!skin) {
    return {
      colorNode: mix(materialColor.rgb, new THREE.Color(BLOOD_COLOR), stained.mul(0.9)),
      roughnessNode: mix(materialRoughness, 0.22, stained.mul(wet)),
    };
  }
  // Skin sweats. The material's own roughness already falls as a fighter tires
  // (hitResolution.js _applyDamageWear); that makes the whole face a little glossier, which
  // on its own reads as plastic. What reads as sweat is that it is uneven: beads standing on
  // the skin, each a pinpoint of the ring lights, and trickles running down from the brow
  // that slide as `sweatRun` grows. Both come up out of the same noise as `sweat` rises,
  // and the skin under them is a touch darker, as wet skin is.
  const sweat = fx('sweat', 'float');
  const { wetSkin } = sweatParts();
  const sheen = mix(mix(materialRoughness, 0.2, sweat.mul(0.5)), 0.05, wetSkin);
  return {
    colorNode: mix(materialColor.rgb.mul(wetSkin.mul(0.08).oneMinus()), new THREE.Color(BLOOD_COLOR), stained.mul(0.9)),
    roughnessNode: mix(sheen, 0.22, stained.mul(wet)),
  };
}
// The ink edge plus the blow's ripple, for the parts that carry `jpos` (skin and clothes).
// A SHADING ripple: bands of light and shadow racing out from the contact point, the way the
// canvas takes a fall (reactiveArena.js). The fighters are built from boxes with a vertex only
// at each corner, so there is nothing between the corners to push; the squash of the whole
// part (tickFighterFx) is what moves.
const INK_RIPPLE_OUTPUT = Fn(() => {
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  const ink = clamp(pow(facing.oneMinus(), fx('inkPower', 'float')).mul(fx('ink', 'float')), 0, 1);
  const jp = attribute('jpos', 'vec3');
  const joint = userData('fxJoint', 'float');
  const dents = fx('dents', 'vec4'), ages = fx('dentAges', 'float');
  let shade = float(0);
  for (let i = 0; i < DENTS; i++) {
    const h = dents.element(i), age = ages.element(i);
    const mine = step(abs(floor(h.w).sub(joint)), 0.5).mul(fract(h.w));
    const d = length(jp.sub(h.xyz));
    const edge = d.sub(age.mul(RIPPLE_SPEED)).mul(16);
    const band = exp(edge.mul(edge).negate());
    const fade = smoothstep(0, RIPPLE_SECS, age).oneMinus().mul(exp(d.mul(-3.5)));
    shade = shade.add(mine.mul(band).mul(fade).mul(sin(d.mul(42).sub(age.mul(34)))));
  }
  const lit = sane(output.rgb).mul(shade.mul(0.55).add(1));
  return vec4(mix(lit, fx('inkColor', 'color'), ink), output.a);
})();

// The same for skin, which also sweats (see sweatParts).
const INK_RIPPLE_SWEAT_OUTPUT = Fn(() => {
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  const ink = clamp(pow(facing.oneMinus(), fx('inkPower', 'float')).mul(fx('ink', 'float')), 0, 1);
  const jp = attribute('jpos', 'vec3');
  const joint = userData('fxJoint', 'float');
  const dents = fx('dents', 'vec4'), ages = fx('dentAges', 'float');
  let shade = float(0);
  for (let i = 0; i < DENTS; i++) {
    const h = dents.element(i), age = ages.element(i);
    const mine = step(abs(floor(h.w).sub(joint)), 0.5).mul(fract(h.w));
    const d = length(jp.sub(h.xyz));
    const edge = d.sub(age.mul(RIPPLE_SPEED)).mul(16);
    const band = exp(edge.mul(edge).negate());
    const fade = smoothstep(0, RIPPLE_SECS, age).oneMinus().mul(exp(d.mul(-3.5)));
    shade = shade.add(mine.mul(band).mul(fade).mul(sin(d.mul(42).sub(age.mul(34)))));
  }
  // Sweat throws the ring lights back: a pinpoint from every bead and trickle, and a wet
  // sheen where the skin turns away from the eye. Added to the lit colour, scaled by how
  // brightly this patch is lit, so a fighter in shadow does not sparkle.
  const { glint } = sweatParts();
  const lightOn = clamp(dot(sane(output.rgb), vec3(0.3, 0.5, 0.2)).mul(2.2), 0.15, 1.4);
  const rim = pow(facing.oneMinus(), 3).mul(fx('sweat', 'float')).mul(0.22);
  const shine = vec3(1, 0.97, 0.92).mul(glint.mul(0.75).add(rim)).mul(lightOn);
  const lit = sane(output.rgb).mul(shade.mul(0.55).add(1)).add(shine);
  return vec4(mix(lit, fx('inkColor', 'color'), ink), output.a);
})();

const BLOOD_SKIN = bloodNodes(WEAR_SKIN, true);
const BLOOD_CLOTH = bloodNodes(WEAR_CLOTH);

const isLit = (m) => !!m && (m.isMeshStandardNodeMaterial || m.isMeshPhysicalNodeMaterial);

/**
 * Attach the shared graphs to one rig and give it its own values.
 *
 * Must run before the rig's first render, so the warm-up compiles the finished materials.
 * Returns the rig's state: plain fields the engine writes (`ink`, `inkPower`, `inkColor`,
 * `wear`, `run`, `wet`), read by the shaders the next time the rig is drawn.
 *
 * @param {{root: object, materials?: object}} rig
 * @param {{ink?: boolean, blood?: boolean}} [o]
 */
export function applyFighterFx(rig, { ink = true, blood = true } = {}) {
  const state = {
    ink: ink ? INK_BASE : 0,
    inkPower: INK_POWER,
    inkColor: new THREE.Color(INK_COLOR),
    wear: 0,       // 0..1 blood on this fighter
    // Wounds, each in the space of the joint it is on: xyz, and joint id + strength (0..0.95).
    hits: Array.from({ length: HITS }, () => new THREE.Vector4(0, 0, 0, 0)),
    hitRuns: new Array(HITS).fill(0),     // `run` when each wound opened
    hitCursor: 0,
    // Blows, in the struck joint's space like the wounds, and seconds since each landed.
    dents: Array.from({ length: DENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    dentAges: new Array(DENTS).fill(9),
    dentCursor: 0,
    squashes: [],  // parts springing back: { joint, t, amp }
    joints: null,  // joint name -> id, for recordHit
    jointNames: null,
    run: 0,        // metres the fresh blood has run
    wet: 0,        // 1 = just bled, falling to 0 as it dries
    sweat: 0,      // 0..1 how hard this fighter is sweating (hitResolution.js _applyDamageWear)
    sweatRun: 0,   // metres the trickles have run
  };
  // Each mesh learns which joint carries it, and each vertex where it sits in that joint's
  // space, so a wound recorded on the head stays on the head whatever the body does.
  const jointId = new Map(), names = Object.keys(rig.joints || {});
  names.forEach((name, i) => jointId.set(rig.joints[name], i + 1));
  state.joints = Object.fromEntries(names.map((name, i) => [name, i + 1]));
  state.jointNames = [null, ...names];     // id -> joint name, for whoever needs the joint back
  rig.root.updateMatrixWorld(true);
  const seen = new Set();
  rig.root.traverse((obj) => {
    // Every mesh, not only the lit ones: a material can be shared with a part added later.
    if (obj.isMesh) {
      obj.userData.fx = state;
      let carrier = obj.parent;
      while (carrier && !jointId.has(carrier)) carrier = carrier.parent;
      obj.userData.fxJoint = carrier ? jointId.get(carrier) : 0;
      if (blood && obj.geometry?.attributes.position && !obj.geometry.attributes.jpos) {
        // Its own copy unless it already is one: part geometry can be shared between rigs.
        if (!obj.userData.baked && !obj.userData.painted) obj.geometry = obj.geometry.clone();
        const toJoint = carrier ? _m.copy(carrier.matrixWorld).invert().multiply(obj.matrixWorld) : _m.copy(obj.matrixWorld);
        const src = obj.geometry.attributes.position, out = new Float32Array(src.count * 3);
        for (let i = 0; i < src.count; i++) {
          _v.fromBufferAttribute(src, i).applyMatrix4(toJoint);
          out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
        }
        obj.geometry.setAttribute('jpos', new THREE.BufferAttribute(out, 3));
      }
    }
    if (!ink || !obj.material) return;
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      // Lit node materials only: `output` is the lit result the edge is mixed over.
      if (!isLit(m) || seen.has(m)) continue;
      seen.add(m);
      m.outputNode = INK_OUTPUT;
      m.needsUpdate = true;
    }
  });
  if (blood) {
    const done = new Set();
    for (const [name, m] of Object.entries(rig.materials || {})) {
      if (!isLit(m) || done.has(m)) continue;
      done.add(m);
      const nodes = name === 'skinMat' || name === 'faceMat' || name === 'plateMat' ? BLOOD_SKIN
        : name === 'suitMat' || name === 'tieMat' ? BLOOD_CLOTH : null;
      if (!nodes) continue;
      m.colorNode = nodes.colorNode;
      m.roughnessNode = nodes.roughnessNode;
      // These parts carry `jpos`, so they can show the blow's ripple as well as the ink;
      // skin also shows its sweat.
      if (ink) m.outputNode = nodes === BLOOD_SKIN ? INK_RIPPLE_SWEAT_OUTPUT : INK_RIPPLE_OUTPUT;
      m.needsUpdate = true;
    }
  }
  return state;
}

/**
 * The ink edge as the `{ value }` slots the super cinematic and the personality effects
 * drive (`u.uInk.value = …`, `u.uInkColor.value.copy(…)`), over a rig's fx state.
 */
export function inkHandles(state) {
  return [{
    uInk: { get value() { return state.ink; }, set value(v) { state.ink = v; } },
    uInkPower: { get value() { return state.inkPower; }, set value(v) { state.inkPower = v; } },
    uInkColor: { value: state.inkColor },
  }];
}

/**
 * A wound at world `point` on `rig`: recorded on the nearest joint, in that joint's space.
 * The oldest of the HITS slots is reused. `strength` 0..1 is how hard it bleeds.
 */
export function recordHit(rig, state, point, strength = 1) {
  if (!state?.joints || !point) return;
  let best = null, bestD = Infinity;
  for (const name in state.joints) {
    const joint = rig.joints[name];
    if (!joint) continue;
    const d = joint.getWorldPosition(_hit).distanceToSquared(point);
    if (d < bestD) { bestD = d; best = name; }
  }
  if (!best) return;
  const slot = state.hitCursor++ % HITS;
  rig.joints[best].worldToLocal(_hit.copy(point));
  state.hits[slot].set(_hit.x, _hit.y, _hit.z, state.joints[best] + Math.max(0.05, Math.min(0.95, strength)));
  state.hitRuns[slot] = state.run;
}

// The nearest joint of `rig` to a world point, and the point in that joint's space (in _hit).
function nearestJoint(rig, state, point) {
  let best = null, bestD = Infinity;
  for (const name in state.joints) {
    const joint = rig.joints[name];
    if (!joint) continue;
    const d = joint.getWorldPosition(_hit).distanceToSquared(point);
    if (d < bestD) { bestD = d; best = name; }
  }
  if (best) rig.joints[best].worldToLocal(_hit.copy(point));
  return best;
}

/**
 * A blow landed at world `point`: a ripple runs out from it and the struck part squashes
 * and springs back. `strength` 0..1.
 */
export function recordDent(rig, state, point, strength = 0.5) {
  if (!state?.joints || !point) return;
  const name = nearestJoint(rig, state, point);
  if (!name) return;
  const slot = state.dentCursor++ % DENTS;
  state.dents[slot].set(_hit.x, _hit.y, _hit.z, state.joints[name] + Math.max(0.05, Math.min(0.95, strength)));
  state.dentAges[slot] = 0;
  // One spring per part: a second blow re-arms it, it does not stack.
  const joint = rig.joints[name];
  const live = state.squashes.find((q) => q.joint === joint);
  if (live) { live.t = 0; live.amp = Math.max(live.amp, strength); }
  else state.squashes.push({ joint, t: 0, amp: strength });
}

/** Per frame: age the ripples and run the squash springs (volume kept: thinner means taller). */
export function tickFighterFx(rig, state, dt) {
  for (let i = 0; i < DENTS; i++) if (state.dentAges[i] < 9) state.dentAges[i] += dt;
  // Sweat trickles a few centimetres a second, faster the harder the fighter is sweating.
  state.sweatRun += dt * 0.045 * state.sweat;
  for (let i = state.squashes.length - 1; i >= 0; i--) {
    const q = state.squashes[i];
    q.t += dt;
    const k = q.amp * SQUASH * Math.exp(-q.t * 9) * Math.cos(q.t * 30);
    if (q.t > 0.6) { q.joint.scale.set(1, 1, 1); state.squashes.splice(i, 1); continue; }
    q.joint.scale.set(1 + k * 0.5, 1 - k, 1 + k * 0.5);
  }
}

// How sweaty a fighter is after `seconds` of fighting: nothing for the opening
// SWEAT_DELAY, then the square of the time since, reaching 1 after SWEAT_RAMP more.
const SWEAT_DELAY = 10;
const SWEAT_RAMP = 75;
export function sweatCurve(seconds) {
  const u = Math.max(0, seconds - SWEAT_DELAY) / SWEAT_RAMP;
  return Math.min(1, u * u);
}

/**
 * What sweat adds to lit skin: a pinpoint of the lights from every bead and trickle, and a
 * wet sheen where the skin turns from the eye. For an output node; `lit` is the lit colour.
 */
export function sweatShine(lit, sweat, sweatRun) {
  const { glint } = sweatParts(sweat, sweatRun);
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  const lightOn = clamp(dot(lit, vec3(0.3, 0.5, 0.2)).mul(2.2), 0.15, 1.4);
  const rim = pow(facing.oneMinus(), 3).mul(sweat).mul(0.22);
  return vec3(1, 0.97, 0.92).mul(glint.mul(0.75).add(rim)).mul(lightOn);
}
