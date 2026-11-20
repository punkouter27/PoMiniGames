// physics/world.js — the simulation's physics surface, and its cannon-es implementation
// (plan decisions 4 and 7). Rapier, where it loads, is the engine of choice
// (rapierWorld.js); cannon-es is what runs offline or when the WASM cannot start.
//
// This module is WRITE-ONLY from the sim's point of view: world.js tells it about deaths,
// felled trees, rocks and explosions and reads back prop poses for the render frame; no
// rule ever reads a body. That is what keeps the seeded simulation deterministic while the
// props stay physically real. `createPhysics` and `nullPhysics` share one surface.
//
// The engine is injected: the worker imports it by URL (no import map in workers) and the
// main-thread fallback from the import map.
import { PHYSICS, PROP_BASE } from '../core/config.js';
import { applyExplosion } from './explosion.js';
import { buildRagdoll, freezeRagdoll, lyingPose, ragdollAsleep } from './ragdoll.js';
import { spawnFallingTree, releaseTree } from './fallingTree.js';
import { spawnRocks } from './rocks.js';
import { createRapierPhysics } from './rapierWorld.js';

/**
 * The no-physics implementation of the same surface. Kept beside createPhysics so the two
 * cannot drift: every member here exists there, which is what lets world.js call the hook
 * unconditionally.
 */
export function nullPhysics() {
  return {
    kind: 'null', propCount: 0, activeRagdolls: 0,
    onDeath() {}, fellTree() {}, spawnRocks() {}, explode() {}, walkers() {},
    step() {}, readProps() { return 0; }, settledCount() { return 0; },
    snapshot() { return []; }, restore() {}, dispose() {},
  };
}

export const G_TERRAIN = 1;
export const G_RAGDOLL = 2;
export const G_PROP = 4;

const LAUNCH = Object.freeze({
  predation: { x: 0, y: 1.5, z: 0 }, lightning: { x: 0, y: 7, z: 0 }, eruption: { x: 0, y: 5, z: 0 },
  rockfall: { x: 0, y: 2, z: 0 }, fire: { x: 0, y: 0.5, z: 0 },
});

/**
 * `lib` is whichever engine the host managed to load: the Rapier module (rapierWorld.js)
 * or cannon-es (below). Both return the same surface.
 */
export function createPhysics(lib, terrain, opts = {}) {
  if (lib?.RigidBodyDesc) return createRapierPhysics(lib, terrain, opts);
  const CANNON = lib;
  const cfg = { ...PHYSICS, ...opts };
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -cfg.gravity, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.solver.iterations = cfg.solverIterations;
  const material = new CANNON.Material('poecosystem');
  world.addContactMaterial(new CANNON.ContactMaterial(material, material, { friction: cfg.friction, restitution: cfg.restitution }));
  const filter = { group: G_PROP | G_RAGDOLL, mask: G_TERRAIN | G_PROP | G_RAGDOLL };

  // Terrain: corner heightmap as a Heightfield. data[i][j] is sampled at world (x = i,
  // z = size − j) so that after the −90° roll about X (local +Z up → world +Y, local +Y
  // → world −Z) and the body sitting at z = size, tile coordinates line up exactly.
  const size = terrain.size; const cs = size + 1;
  const data = [];
  for (let i = 0; i < cs; i++) {
    const column = new Array(cs);
    for (let j = 0; j < cs; j++) column[j] = Math.max(-3, terrain.height[(size - j) * cs + i]);
    data.push(column);
  }
  const ground = new CANNON.Body({ mass: 0, material, collisionFilterGroup: G_TERRAIN, collisionFilterMask: G_RAGDOLL | G_PROP });
  ground.addShape(new CANNON.Heightfield(data, { elementSize: 1 }));
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.position.set(0, 0, size);
  world.addBody(ground);

  let time = 0;
  const props = [];      // { body, kind, sizeIndex, born, settled, expires, rag?, tree? }
  const ragdolls = [];   // { parts: entries[], constraints, born, settled }
  const trees = [];      // { entry, anchor, hinge, born }

  const freezeEntry = (entry, lifetime) => {
    const b = entry.body;
    b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
    b.mass = 0; b.type = CANNON.Body.STATIC; b.updateMassProperties();
    entry.settled = true; entry.expires = time + lifetime;
  };

  const physics = {
    kind: 'cannon',
    world,
    get activeRagdolls() { return ragdolls.filter(r => !r.settled).length; },

    onDeath(info, cause, rng) {
      const launch = LAUNCH[cause] ?? { x: 0, y: 0.3, z: 0 };
      if (physics.activeRagdolls >= cfg.maxActiveRagdolls) {
        for (const pose of lyingPose(info.species, info.x, info.y, info.z, info.yaw, info.scale)) {
          const sizeIndex = pose.propKind % 8;
          const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material, collisionFilterGroup: G_RAGDOLL, collisionFilterMask: G_PROP | G_RAGDOLL });
          body.addShape(new CANNON.Box(new CANNON.Vec3(0.15, 0.15, 0.15)));
          body.position.set(pose.x, pose.y, pose.z);
          body.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
          world.addBody(body);
          props.push({ body, kind: Math.floor(pose.propKind / 8), sizeIndex, owner: pose.owner, born: time, settled: true, expires: time + cfg.carcassSeconds });
        }
        return;
      }
      const rag = buildRagdoll(CANNON, world, material, { group: G_RAGDOLL, mask: G_TERRAIN | G_PROP | G_RAGDOLL }, info, rng, launch, cfg);
      rag.born = time;
      rag.info = { species: info.species, x: info.x, y: info.y, z: info.z, yaw: info.yaw, scale: info.scale };
      ragdolls.push(rag);
      for (const part of rag.parts) props.push({ ...part, born: time, settled: false, expires: Infinity, rag });
    },

    fellTree(info, rng) {
      const tree = spawnFallingTree(CANNON, world, material, filter, info, rng, cfg);
      tree.born = time;
      trees.push(tree);
      props.push({ ...tree.entry, born: time, settled: false, expires: Infinity, tree });
    },

    spawnRocks(spec, rng) {
      for (const entry of spawnRocks(CANNON, world, material, filter, spec, rng, cfg)) {
        props.push({ ...entry, born: time, settled: false, expires: Infinity });
      }
    },

    /** Rapier's (rapierWorld.js): creatures pushing loose props. cannon-es leaves them be. */
    walkers() {},

    explode(spec) {
      return applyExplosion(CANNON, props.map(p => p.body), spec);
    },

    step(dt) {
      time += dt;
      const sub = dt / cfg.substeps;
      for (let k = 0; k < cfg.substeps; k++) world.step(sub);

      for (const tree of trees) if (tree.hinge && time - tree.born >= cfg.treeHingeSeconds) releaseTree(world, tree);

      for (const rag of ragdolls) {
        if (rag.settled) continue;
        if (time - rag.born >= cfg.ragdollMaxSeconds || ragdollAsleep(CANNON, rag)) {
          freezeRagdoll(CANNON, world, rag);
          for (const p of props) if (p.rag === rag) { p.settled = true; p.expires = time + cfg.carcassSeconds; }
        }
      }
      for (const p of props) {
        if (p.settled || p.rag) continue;
        if (p.body.sleepState === CANNON.Body.SLEEPING || time - p.born >= cfg.settleTimeoutSeconds) {
          if (p.tree) releaseTree(world, p.tree);
          freezeEntry(p, p.kind === 2 || p.kind === 3 ? cfg.rockSeconds : cfg.logSeconds);
        }
      }
      for (let k = props.length - 1; k >= 0; k--) {
        if (props[k].expires <= time) { world.removeBody(props[k].body); props.splice(k, 1); }
      }
      for (let k = ragdolls.length - 1; k >= 0; k--) if (ragdolls[k].settled && !props.some(p => p.rag === ragdolls[k])) ragdolls.splice(k, 1);
      for (let k = trees.length - 1; k >= 0; k--) if (!trees[k].hinge && !props.some(p => p.tree === trees[k])) trees.splice(k, 1);
    },

    /** Write [x,y,z,qx,qy,qz,qw,propKind] per prop into `view`; returns the count written. */
    readProps(view, propCap) {
      const n = Math.min(props.length, propCap);
      for (let k = 0; k < n; k++) {
        const p = props[k]; const o = k * 8;
        view[o] = p.body.position.x; view[o + 1] = p.body.position.y; view[o + 2] = p.body.position.z;
        view[o + 3] = p.body.quaternion.x; view[o + 4] = p.body.quaternion.y; view[o + 5] = p.body.quaternion.z; view[o + 6] = p.body.quaternion.w;
        view[o + 7] = p.kind * 8 + p.sizeIndex + PROP_BASE * (p.owner ?? 0);
      }
      return n;
    },

    settledCount() { return props.filter(p => p.settled).length; },
    get propCount() { return props.length; },

    /**
     * Save-file view: settled props with their remaining lifetime, plus unsettled ragdolls
     * as static lying poses (a mid-fall body is never worth persisting). Bodies in flight
     * are dropped — the sim's own plan (corridors) already owns their consequences.
     */
    snapshot() {
      const out = [];
      for (const p of props) {
        if (!p.settled) continue;
        const b = p.body;
        out.push({ x: b.position.x, y: b.position.y, z: b.position.z, qx: b.quaternion.x, qy: b.quaternion.y, qz: b.quaternion.z, qw: b.quaternion.w, kind: p.kind, sizeIndex: p.sizeIndex, owner: p.owner ?? 0, remaining: Math.max(1, p.expires - time) });
      }
      for (const rag of ragdolls) {
        if (rag.settled || !rag.info) continue;
        for (const pose of lyingPose(rag.info.species, rag.info.x, rag.info.y, rag.info.z, rag.info.yaw, rag.info.scale)) {
          out.push({ x: pose.x, y: pose.y, z: pose.z, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw, kind: Math.floor(pose.propKind / 8), sizeIndex: pose.propKind % 8, owner: pose.owner, remaining: cfg.carcassSeconds });
        }
      }
      return out;
    },

    /** Recreate saved props as static bodies with their remaining lifetimes. */
    restore(list) {
      for (const s of list ?? []) {
        const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material, collisionFilterGroup: G_PROP, collisionFilterMask: G_PROP | G_RAGDOLL });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.15, 0.15, 0.15)));
        body.position.set(s.x, s.y, s.z);
        body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
        world.addBody(body);
        props.push({ body, kind: s.kind, sizeIndex: s.sizeIndex, owner: s.owner ?? 0, born: time, settled: true, expires: time + (s.remaining ?? cfg.carcassSeconds) });
      }
    },
    dispose() {
      for (const p of props) world.removeBody(p.body);
      for (const t of trees) releaseTree(world, t);
      props.length = 0; ragdolls.length = 0; trees.length = 0;
      world.removeBody(ground);
    },
  };
  return physics;
}
