// creatureModels.js — the four species as animated models (glTF), one draw call each.
//
// creatureMeshes.js draws a creature as eight boxes whose legs swing by a sine of the clock:
// it walks the same whether it is walking, grazing, sleeping or running for its life. This
// module draws the same creature from a skinned glTF model (wwwroot/models/poecosystem/, made
// by scripts/poecosystem/creatures.mjs) with a clip for each of those: idle, walk, run, feed,
// rest, and for people work.
//
// HOW 400 SKINNED CREATURES ARE ONE DRAW CALL PER SPECIES
// A skinned mesh is normally one draw call and one set of bone matrices each. Here every clip
// of a model is played once, at load, and the matrix of every joint at every frame is written
// into a float texture: one row per frame, three texels (a 3x4 matrix) per joint. After that
// a creature's whole pose is two numbers, which clip row and how far to the next, and they
// ride on the instance. The vertex stage reads its joint's matrix from that row. The CPU
// writes ~20 floats per creature per frame where the box rig wrote eight 4x4 matrices.
//
//   • Each vertex follows ONE joint (the heaviest of its weights). The models are built from
//     rigid pieces, so nothing is lost, and a smooth-skinned model would simply crease at its
//     joints, which is how flat-shaded low-poly animals crease anyway.
//   • Two clips are read per vertex and blended, so a change of clip (walk to feed) is a
//     quarter-second cross-fade, not a pop.
//   • Normals are not skinned at all: the material is flat-shaded, and a flat normal comes
//     from the screen-space derivatives of the position that was actually drawn.
//
// WHICH CLIP is decided here from what the frame already carries: the goal and the speed.
// The legs' cadence follows the speed through the clip's stride (metres per cycle, from the
// file), up to a top cadence, so a deer covers ground at the rate its legs say it does.
//
// THE DEAD ARE THE SAME MODEL. When a creature dies the physics takes over a ragdoll of six
// or seven boxes (sim/physics/ragdoll.js), and those used to be drawn as boxes: the deer
// turned into brown crates as it fell. Now each joint of the model belongs to one ragdoll
// part (by its name: a leg's two joints follow that leg's box), and a body is drawn as one
// more instance of the model whose "clip row" is a row of this frame's part matrices, kept in
// rows set aside at the end of the same texture. The texture is uploaded again only on a
// frame a body actually moved, which is the few seconds after a death.
//
// A species whose file has not loaded (or will not) is not `ready`, and creatureMeshes.js
// keeps drawing it as boxes. `?ecoCreatures=boxes` keeps every species on boxes, for comparing.
import {
  AnimationMixer, BufferAttribute, Color, DataTexture, DynamicDrawUsage, Euler, FloatType, InstancedBufferAttribute,
  InstancedBufferGeometry, Matrix4, Mesh, NearestFilter, Quaternion, RGBAFormat, Vector3,
} from 'three-eco/webgpu';
import { attribute, cross, dot, float, int, ivec2, mix, textureLoad, uniform, vec3, vec4 } from 'three-eco/tsl';
import { SPECIES } from '../sim/creatures/species.js';
import { GOAL } from '../sim/behavior/utility.js';
import { RIGS, rigFor } from '../sim/physics/ragdoll.js';
import { EcoLambertMaterial, materialLens } from './materials.js';

const FILES = ['rabbit', 'deer', 'wolf', 'human'];   // by species id
const BAKE_FPS = 24;
const FADE_SECONDS = 0.28;       // cross-fade between two clips
const HOLD_SECONDS = 0.35;       // a clip is kept at least this long, so a stutter in speed is not a twitch
const WHITE = new Color(1, 1, 1);
const BODY_ROWS = 48;            // bodies of one species drawn as the model at once; more lie as boxes
const BODY_TINT = [0.8, 0.76, 0.74];   // a body is a little duller than the living

/**
 * Which ragdoll part a joint follows, from its name: the part names in physics/ragdoll.js
 * RIGS are torso, head, legFL... and pelvis, chest, head, armL, legL... A joint nothing
 * claims rides the first part (the torso or the pelvis).
 */
function partOfJoint(name, rig) {
  const n = name.toLowerCase();
  const find = (part) => Math.max(0, RIGS[rig].parts.findIndex((p) => p.name === part));
  if (rig === 'biped') {
    const limb = /^(arm|leg)([lr])/.exec(n);
    if (limb) return find(limb[1] + limb[2].toUpperCase());
    if (n.startsWith('head') || n.startsWith('neck')) return find('head');
    if (n.startsWith('chest') || n.startsWith('spine')) return find('chest');
    return find('pelvis');
  }
  const leg = /^([fb])([lr])(_|$)/.exec(n);
  if (leg) return find(`leg${leg[1].toUpperCase()}${leg[2].toUpperCase()}`);
  if (n.startsWith('head') || n.startsWith('neck') || n.startsWith('ear')) return find('head');
  return find('torso');
}

/** `?ecoCreatures=boxes`: no models, the box rigs for every species. */
function modelsWanted() {
  try { return new URLSearchParams(window.location.search).get('ecoCreatures') !== 'boxes'; } catch { return true; }
}

/**
 * Play every clip of a loaded glTF once and write the skeleton into a texture.
 * @returns {{ geometry, texture, clips: Record<string, {start, frames, seconds, stride?, cadence?}> }}
 */
export function bakeModel(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) throw new Error('the model has no skinned mesh');
  const skeleton = skinned[0].skeleton;
  const bones = skeleton.bones; const J = bones.length;

  // Geometry: every mesh on that skeleton, in the model's own space at bind pose.
  const position = []; const colour = []; const joint = []; const index = [];
  const p = new Vector3();
  for (const mesh of skinned) {
    if (mesh.skeleton !== skeleton) continue;
    const g = mesh.geometry;
    const pos = g.getAttribute('position'); const col = g.getAttribute('color');
    const si = g.getAttribute('skinIndex'); const sw = g.getAttribute('skinWeight');
    const base = position.length / 3;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
      position.push(p.x, p.y, p.z);
      if (col) colour.push(col.getX(i), col.getY(i), col.getZ(i)); else colour.push(1, 1, 1);
      let best = 0; let weight = -1;
      for (let k = 0; k < 4; k++) { const w = sw ? sw.getComponent(i, k) : (k === 0 ? 1 : 0); if (w > weight) { weight = w; best = si ? si.getComponent(i, k) : 0; } }
      joint.push(best);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) index.push(base + i);
  }

  // The texture: for each clip, each frame, each joint, the top three rows of
  // (bone world matrix x inverse bind matrix), the matrix that carries a bind-pose vertex to
  // where the joint has taken it.
  const meta = gltf.asset?.extras?.poecosystem?.clips ?? {};
  const clips = {}; let rows = 0;
  for (const clip of gltf.animations) {
    const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS));
    clips[clip.name] = { start: rows, frames, seconds: clip.duration, ...(meta[clip.name] ?? {}) };
    rows += frames;
  }
  if (!rows) throw new Error('the model has no animation');
  const width = J * 3;
  // After the clips, rows for the dead: one per body, rewritten as its ragdoll moves.
  const bodyStart = rows;
  const data = new Float32Array(width * (rows + BODY_ROWS) * 4);
  const mixer = new AnimationMixer(root);
  const m = new Matrix4();
  for (const clip of gltf.animations) {
    const { start, frames } = clips[clip.name];
    const action = mixer.clipAction(clip);
    action.play();
    for (let f = 0; f < frames; f++) {
      // Frame `frames` would be frame 0 again: the row after the last wraps on the CPU.
      mixer.setTime((f / frames) * clip.duration);
      root.updateMatrixWorld(true);
      for (let j = 0; j < J; j++) {
        m.multiplyMatrices(bones[j].matrixWorld, skeleton.boneInverses[j]);
        const e = m.elements; const o = ((start + f) * width + j * 3) * 4;
        // Column-major elements, written out as three rows.
        data[o] = e[0]; data[o + 1] = e[4]; data[o + 2] = e[8]; data[o + 3] = e[12];
        data[o + 4] = e[1]; data[o + 5] = e[5]; data[o + 6] = e[9]; data[o + 7] = e[13];
        data[o + 8] = e[2]; data[o + 9] = e[6]; data[o + 10] = e[10]; data[o + 11] = e[14];
      }
    }
    action.stop();
    mixer.uncacheAction(clip);
  }
  const texture = new DataTexture(data, width, rows + BODY_ROWS, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colour), 3));
  geometry.setAttribute('aJoint', new BufferAttribute(new Float32Array(joint), 1));
  geometry.setIndex(index);
  return { geometry, texture, clips, joints: J, frames: rows, bodyStart, data, width, names: bones.map((b) => b.name) };
}

/**
 * The model's material: the creatures' shared Lambert (materials.js) with the vertex stage
 * above and the model's own vertex colours. `plain` (0/1) swaps those colours for white,
 * which is what a lens paints on.
 */
class CreatureMaterial extends EcoLambertMaterial {
  constructor(texture, plain) {
    super({ flatShading: true }, { rim: 0.42, mottle: 0.16, mottleScale: 0.9, lens: false });
    const col = int(attribute('aJoint', 'float').mul(3).add(0.5));
    const pose = attribute('aPose', 'vec4');          // x, y, z, scale
    const q = attribute('aRot', 'vec4');
    const a = attribute('aAnimA', 'vec4');            // row, next row, fraction, weight of B
    const b = attribute('aAnimB', 'vec4');            // row, next row, fraction
    const bind = vec4(attribute('position', 'vec3'), 1);
    const at = (row) => {
      const y = int(row.add(0.5));
      return vec3(
        dot(textureLoad(texture, ivec2(col, y)), bind),
        dot(textureLoad(texture, ivec2(col.add(1), y)), bind),
        dot(textureLoad(texture, ivec2(col.add(2), y)), bind));
    };
    const clip = (anim) => mix(at(anim.x), at(anim.y), anim.z);
    const local = mix(clip(a), clip(b), a.w).mul(pose.w);
    // v' = v + 2 q.xyz x (q.xyz x v + q.w v)
    const turned = local.add(cross(q.xyz, cross(q.xyz, local).add(local.mul(q.w))).mul(2));
    this.positionNode = pose.xyz.add(turned);
    this.tintNode = attribute('aTint', 'vec3');
    this.colorNode = mix(attribute('color', 'vec3'), vec3(1, 1, 1), plain).mul(this.tintNode);
    this.ecoKey += ':creature';
  }

  setupLighting(builder) {
    return mix(super.setupLighting(builder), this.tintNode, materialLens);
  }
}

/** Which clip a creature is in, from its goal and its speed. */
function clipFor(species, goal, speed, current) {
  const walk = SPECIES[species]?.walkSpeed ?? 3;
  // A little hysteresis on the run threshold: a creature at exactly walking pace stays walking.
  if (speed > walk * (current === 'run' ? 1.12 : 1.3)) return 'run';
  if (speed > 0.3) return 'walk';
  switch (goal) {
    case GOAL.EAT: case GOAL.DRINK: return 'feed';
    case GOAL.REST: return 'rest';
    case GOAL.CHOP: case GOAL.BUILD: case GOAL.TEND_FIELD: return 'work';
    default: return 'idle';
  }
}

/**
 * @param scene
 * @param {number} cap the most creatures of one species that can be drawn
 * @param {{ loader?: Function }} opts `loader(url)` → a loaded glTF (the tests' seam)
 */
export function createCreatureModels(scene, cap, { loader = null } = {}) {
  const species = [];            // by id: null until its file is baked
  const plain = uniform(0);
  const state = new Map();       // handle → { clip, phase, prev, prevPhase, fade, held, seen }
  const euler = new Euler(0, 0, 0, 'YXZ'); const quat = new Quaternion();
  let disposed = false; let clock = 0; let swept = 0;
  let force = null;              // a clip name every creature plays (a harness looking at one clip)

  async function load(id) {
    const url = new URL(`../../../models/poecosystem/${FILES[id]}.glb`, import.meta.url).href;
    let gltf;
    if (loader) gltf = await loader(url);
    else {
      const { GLTFLoader } = await import('three-eco/addons/loaders/GLTFLoader.js');
      gltf = await new GLTFLoader().loadAsync(url);
    }
    if (disposed) return;
    const baked = bakeModel(gltf);
    const { geometry } = baked;
    const attr = (name, size) => {
      const a = new InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    const rig = rigFor(id).rig;
    const s = {
      ...baked,
      bodies: 0, rig,
      // Per joint: the ragdoll part it follows, and that part's centre in the model's own space.
      part: baked.names.map((name) => partOfJoint(name, rig)),
      pose: attr('aPose', 4), rot: attr('aRot', 4), animA: attr('aAnimA', 4), animB: attr('aAnimB', 4), tint: attr('aTint', 3),
      count: 0,
    };
    geometry.instanceCount = 0;
    s.material = new CreatureMaterial(baked.texture, plain);
    s.mesh = new Mesh(geometry, s.material);
    s.mesh.frustumCulled = false;      // every vertex is placed in the shader
    s.mesh.castShadow = true;
    s.mesh.visible = false;
    s.mesh.name = `creature-model-${FILES[id]}`;
    scene.add(s.mesh);
    species[id] = s;
  }

  if (modelsWanted()) {
    FILES.forEach((name, id) => {
      load(id).catch((err) => console.warn(`[poecosystem] ${name} model unavailable, keeping the box rig`, err));
    });
  }

  /** Rows for a clip at a phase 0..1: [row, next row, fraction]. */
  const rowsOf = (s, name, phase, out, o) => {
    const c = s.clips[name] ?? s.clips.idle;
    const f = (phase - Math.floor(phase)) * c.frames;
    const f0 = Math.floor(f) % c.frames;
    out[o] = c.start + f0; out[o + 1] = c.start + (f0 + 1) % c.frames; out[o + 2] = f - Math.floor(f);
  };

  return {
    /** Is this species drawn as a model yet? Until it is, the caller draws its boxes. */
    ready: (id) => !!species[id],
    get loaded() { return species.filter(Boolean).length; },
    /** 1: the lens colour replaces the model's own colours (creatureMeshes.js setTint). */
    setPlain(on) { plain.value = on ? 1 : 0; },
    /** A clip every creature plays regardless of what it is doing, or null. */
    set force(name) { force = name || null; },
    get force() { return force; },
    clipsOf: (id) => (species[id] ? Object.keys(species[id].clips) : []),

    begin(dt) {
      clock += dt;
      for (const s of species) if (s) { s.count = 0; s.bodies = 0; }
    },

    /**
     * One dead creature this frame, drawn as its model in its ragdoll's pose. `rows` are the
     * prop rows of its parts in rig order (index into `view`, stride 8: x, y, z, qx, qy, qz,
     * qw, kind); `scale` is the size it was drawn at alive. Returns false when the species
     * has no model yet or has no row left, and the caller draws the boxes.
     */
    body(id, view, rows, scale) {
      const s = species[id];
      if (!s || s.bodies >= BODY_ROWS || s.count >= cap) return false;
      const row = s.bodyStart + s.bodies++;
      const parts = RIGS[s.rig].parts;
      const { data, width } = s;
      let moved = false;
      for (let j = 0; j < s.joints; j++) {
        // A part the frame did not carry (the prop table was full) rides the first one.
        const k = s.part[j] < rows.length ? s.part[j] : 0;
        const o = rows[k] * 8;
        const qx = view[o + 3]; const qy = view[o + 4]; const qz = view[o + 5]; const qw = view[o + 6];
        // The part's rotation, scaled; then the translation that puts its bind-pose centre
        // (the rig's offset, in the model's own units) where the physics has the box.
        const r00 = (1 - 2 * (qy * qy + qz * qz)) * scale; const r01 = 2 * (qx * qy - qz * qw) * scale; const r02 = 2 * (qx * qz + qy * qw) * scale;
        const r10 = 2 * (qx * qy + qz * qw) * scale; const r11 = (1 - 2 * (qx * qx + qz * qz)) * scale; const r12 = 2 * (qy * qz - qx * qw) * scale;
        const r20 = 2 * (qx * qz - qy * qw) * scale; const r21 = 2 * (qy * qz + qx * qw) * scale; const r22 = (1 - 2 * (qx * qx + qy * qy)) * scale;
        const c = parts[k].offset;
        const t = (row * width + j * 3) * 4;
        const put = (i, v) => { if (Math.abs(data[t + i] - v) > 1e-5) { data[t + i] = v; moved = true; } };
        put(0, r00); put(1, r01); put(2, r02); put(3, view[o] - (r00 * c[0] + r01 * c[1] + r02 * c[2]));
        put(4, r10); put(5, r11); put(6, r12); put(7, view[o + 1] - (r10 * c[0] + r11 * c[1] + r12 * c[2]));
        put(8, r20); put(9, r21); put(10, r22); put(11, view[o + 2] - (r20 * c[0] + r21 * c[1] + r22 * c[2]));
      }
      if (moved) s.texture.needsUpdate = true;
      // The matrices are already in world space: no place, no turn, no size of its own.
      const i = s.count++;
      s.pose.array.set([0, 0, 0, 1], i * 4);
      s.rot.array.set([0, 0, 0, 1], i * 4);
      s.animA.array.set([row, row, 0, 0], i * 4);
      s.animB.array.set([row, row, 0, 0], i * 4);
      s.tint.array.set(BODY_TINT, i * 3);
      return true;
    },

    /**
     * One creature this frame. `handle` is what its animation state is remembered by, so it
     * must be the sim's handle, not the row it happens to be in.
     */
    put(id, handle, x, y, z, yaw, pitch, roll, scale, tint, goal, speed, dt) {
      const s = species[id];
      const i = s.count++;
      if (i >= cap) { s.count = cap; return; }

      let a = state.get(handle);
      if (!a) {
        // A phase of its own, so a herd does not move in step.
        a = { clip: 'idle', phase: (handle * 0.6180339887) % 1, prev: 'idle', prevPhase: 0, fade: 0, held: 0, seen: 0 };
        state.set(handle, a);
      }
      a.seen = clock;
      let want = force ?? clipFor(id, goal, speed, a.clip);
      if (!s.clips[want]) want = want === 'work' ? 'feed' : 'idle';
      a.held += dt;
      if (want !== a.clip && (a.held >= HOLD_SECONDS || want === 'run' || force)) {
        // Walk and run share a cycle: the legs carry on from where they are.
        const gait = (n) => n === 'walk' || n === 'run';
        a.prev = a.clip; a.prevPhase = a.phase; a.fade = 1;
        if (!(gait(want) && gait(a.clip))) a.phase = (handle * 0.6180339887) % 1;
        a.clip = want; a.held = 0;
      }
      const c = s.clips[a.clip];
      // Cycles a second: the ground covered over the stride, between a shuffle and the clip's top cadence.
      const rate = c.stride ? Math.min(c.cadence ?? 3, Math.max(0.7, speed / (c.stride * scale))) : 1 / c.seconds;
      a.phase += rate * dt;
      if (a.fade > 0) a.fade = Math.max(0, a.fade - dt / FADE_SECONDS);

      s.pose.array.set([x, y, z, scale], i * 4);
      quat.setFromEuler(euler.set(pitch, yaw, roll));
      s.rot.array.set([quat.x, quat.y, quat.z, quat.w], i * 4);
      rowsOf(s, a.clip, a.phase, s.animA.array, i * 4);
      // Smoothstep on the fade, so the hand-over eases at both ends.
      s.animA.array[i * 4 + 3] = a.fade * a.fade * (3 - 2 * a.fade);
      rowsOf(s, a.prev, a.prevPhase, s.animB.array, i * 4);
      const t = tint ?? WHITE;
      s.tint.array[i * 3] = t.r; s.tint.array[i * 3 + 1] = t.g; s.tint.array[i * 3 + 2] = t.b;
    },

    end() {
      for (const s of species) {
        if (!s) continue;
        s.geometry.instanceCount = s.count;
        s.mesh.visible = s.count > 0;       // WebGPU warns on a draw of no instances
        if (!s.count) continue;
        for (const a of [s.pose, s.rot, s.animA, s.animB, s.tint]) {
          a.clearUpdateRanges(); a.addUpdateRange(0, s.count * a.itemSize); a.needsUpdate = true;
        }
      }
      // Forget the dead: a handle not drawn for two seconds is not coming back as itself.
      if (clock - swept > 3) {
        swept = clock;
        for (const [h, a] of state) if (clock - a.seen > 2) state.delete(h);
      }
    },

    dispose() {
      disposed = true;
      for (const s of species) {
        if (!s) continue;
        scene.remove(s.mesh);
        s.geometry.dispose(); s.material.dispose(); s.texture.dispose();
      }
      species.length = 0; state.clear();
    },
  };
}
