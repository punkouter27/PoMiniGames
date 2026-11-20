// physics/rapierWorld.js — the Rapier side of the simulation: the same surface as
// world.js's cannon-es implementation (createPhysics dispatches here when it is handed the
// Rapier module), on a rigid-body engine compiled to WASM.
//
// WRITE-ONLY from the sim's point of view, exactly like the cannon path: world.js tells it
// about deaths, felled trees, rocks and explosions and reads prop poses back for the render
// frame. No rule reads a body, so which engine is stepping never changes what happens on the
// island, only how the props move.
//
// What Rapier adds over cannon-es here:
//   • CONTINUOUS COLLISION on every body: the ground is a surface with nothing under it,
//     and a limb five centimetres thick falling at ten metres a second crosses it between
//     two steps (physics-check.mjs caught exactly that before this was switched on).
//   • SCREE: each rockslide boulder brings loose stones with it. They are cosmetic (the
//     sim planned the boulders and never hears about the stones), short-lived, and only
//     spawned while the prop table has room. The solver is cheap enough to carry them.
//   • a solver that stays stable with many bodies in a pile, so settled props sleep sooner.
//
// The module is injected (createPhysics(R, ...)): the worker imports it from the CDN by
// absolute URL (workers have no import map), the inline fallback from the import map, and
// scripts/poecosystem/physics-check.mjs from node_modules.
import { PHYSICS, PROP_BASE, PROP_CAP, PROP_KIND, propOwner } from '../core/config.js';
import { explosionImpulse } from './explosion.js';
import { RIGS, lyingPose, rigFor } from './ragdoll.js';

const G_TERRAIN = 1;
const G_RAGDOLL = 2;
const G_PROP = 4;
/** Rapier collision groups: membership in the high 16 bits, what it touches in the low 16. */
const groups = (member, touches) => ((member << 16) | touches) >>> 0;

const LAUNCH = Object.freeze({
  predation: { x: 0, y: 1.5, z: 0 }, lightning: { x: 0, y: 7, z: 0 }, eruption: { x: 0, y: 5, z: 0 },
  rockfall: { x: 0, y: 2, z: 0 }, fire: { x: 0, y: 0.5, z: 0 },
});

const TRUNK_HALF = { x: 0.15, y: 1.3, z: 0.15 }; // PROP_SIZES[5] = [0.30, 2.60, 0.30]
const SCREE_PER_ROCK = 3;       // loose stones thrown with each rockslide boulder
const SCREE_SECONDS = 25;       // a settled stone stays this long
const SCREE_HEADROOM = 96;      // prop rows always left free for ragdolls, logs and rocks
const RAGDOLL_ANGULAR_DAMPING = 0.6; // the joints carry no cone limits, so limbs are damped instead

const yawQuat = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
const rotY = (x, z, yaw) => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];

/**
 * The island's corner heightmap as a Rapier heightfield. `terrain.height` is row-major by z
 * (index z * (size + 1) + x); Rapier wants a column-major matrix whose rows run along z and
 * columns along x, centred on its collider — so the grid is transposed and the collider
 * sits at the middle of the island.
 */
export function heightfieldData(terrain) {
  const size = terrain.size; const cs = size + 1;
  const heights = new Float32Array(cs * cs);
  for (let x = 0; x < cs; x++) {
    for (let z = 0; z < cs; z++) heights[x * cs + z] = Math.max(-3, terrain.height[z * cs + x]);
  }
  return { heights, size };
}

export function createRapierPhysics(R, terrain, opts = {}) {
  const cfg = { ...PHYSICS, ...opts };
  const world = new R.World({ x: 0, y: -cfg.gravity, z: 0 });

  const { heights, size } = heightfieldData(terrain);
  const ground = world.createCollider(
    R.ColliderDesc.heightfield(size, size, heights, { x: size, y: 1, z: size })
      .setTranslation(size / 2, 0, size / 2)
      .setFriction(cfg.friction).setRestitution(cfg.restitution)
      .setCollisionGroups(groups(G_TERRAIN, G_RAGDOLL | G_PROP)));

  let time = 0;
  let screeSeed = (terrain.hash ?? 1) >>> 0 || 1;
  const props = [];      // { body, kind, sizeIndex, born, settled, expires, lifetime?, rag?, tree? }
  const ragdolls = [];   // { parts: entries[], born, settled, info }
  const trees = [];      // { entry, anchor, hinge, born }

  // Scree has its own generator: the cosmetic stream is drawn exactly as the cannon path
  // draws it, so a save made under one engine replays the same under the other.
  const scree = () => {
    screeSeed = (Math.imul(screeSeed, 1664525) + 1013904223) >>> 0;
    return screeSeed / 4294967296;
  };

  const dynamic = (x, y, z, { rotation = null, linearDamping = 0, angularDamping = 0, ccd = false } = {}) => {
    const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setLinearDamping(linearDamping).setAngularDamping(angularDamping).setCcdEnabled(ccd);
    if (rotation) desc.setRotation(rotation);
    return world.createRigidBody(desc);
  };
  const shaped = (body, desc, mass, member, touches) => world.createCollider(
    desc.setMass(mass).setFriction(cfg.friction).setRestitution(cfg.restitution).setCollisionGroups(groups(member, touches)),
    body);
  const fixedBox = (pose, member) => {
    const body = world.createRigidBody(R.RigidBodyDesc.fixed()
      .setTranslation(pose.x, pose.y, pose.z)
      .setRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw }));
    world.createCollider(R.ColliderDesc.cuboid(0.15, 0.15, 0.15).setCollisionGroups(groups(member, G_PROP | G_RAGDOLL)), body);
    return body;
  };
  const freeze = (body) => {
    body.setLinvel({ x: 0, y: 0, z: 0 }, false); body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    body.setBodyType(R.RigidBodyType.Fixed, false);
  };
  const releaseTree = (tree) => {
    if (tree.hinge) { world.removeImpulseJoint(tree.hinge, true); tree.hinge = null; }
    if (tree.anchor) { world.removeRigidBody(tree.anchor); tree.anchor = null; }
  };

  const rock = (radius, mass, x, y, z, vx, vy, vz, spin, kind, sizeIndex, lifetime) => {
    const body = dynamic(x, y, z, { linearDamping: 0.05, angularDamping: 0.1, ccd: true });
    shaped(body, R.ColliderDesc.ball(radius), mass, G_PROP, G_TERRAIN | G_PROP | G_RAGDOLL);
    body.setLinvel({ x: vx, y: vy, z: vz }, true);
    body.setAngvel(spin, true);
    props.push({ body, kind, sizeIndex, born: time, settled: false, expires: Infinity, lifetime });
  };

  const physics = {
    kind: 'rapier',
    world,
    get activeRagdolls() { return ragdolls.filter(r => !r.settled).length; },

    onDeath(info, cause, rng) {
      const launch = LAUNCH[cause] ?? { x: 0, y: 0.3, z: 0 };
      if (physics.activeRagdolls >= cfg.maxActiveRagdolls) {
        for (const pose of lyingPose(info.species, info.x, info.y, info.z, info.yaw, info.scale)) {
          props.push({ body: fixedBox(pose, G_RAGDOLL), kind: Math.floor(pose.propKind / 8), sizeIndex: pose.propKind % 8, owner: pose.owner, born: time, settled: true, expires: time + cfg.carcassSeconds });
        }
        return;
      }
      const { rig, scale: rs } = rigFor(info.species);
      const s = rs * (info.scale || 1);
      const def = RIGS[rig];
      const rotation = yawQuat(info.yaw);
      const bodies = new Map();
      const rag = { parts: [], born: time, settled: false, info: { species: info.species, x: info.x, y: info.y, z: info.z, yaw: info.yaw, scale: info.scale } };
      for (const [k, p] of def.parts.entries()) {
        const [ox, oz] = rotY(p.offset[0] * s, p.offset[2] * s, info.yaw);
        const body = dynamic(info.x + ox, info.y + p.offset[1] * s, info.z + oz, { rotation, linearDamping: cfg.linearDamping, angularDamping: RAGDOLL_ANGULAR_DAMPING, ccd: true });
        shaped(body, R.ColliderDesc.cuboid(p.size[0] * s / 2, p.size[1] * s / 2, p.size[2] * s / 2), p.mass * s, G_RAGDOLL, G_TERRAIN | G_PROP | G_RAGDOLL);
        // The same draws, in the same order, as ragdoll.js makes for cannon.
        body.setLinvel({ x: launch.x + (rng.next() - 0.5) * 0.6, y: launch.y + (rng.next() - 0.5) * 0.6, z: launch.z + (rng.next() - 0.5) * 0.6 }, true);
        body.setAngvel({ x: (rng.next() - 0.5) * 2, y: (rng.next() - 0.5) * 2, z: (rng.next() - 0.5) * 2 }, true);
        bodies.set(p.name, { body, offset: p.offset });
        const entry = { body, kind: PROP_KIND.ragdollPart, sizeIndex: p.sizeIndex, owner: propOwner(info.species, k, info.scale), born: time, settled: false, expires: Infinity, rag };
        rag.parts.push(entry);
        props.push(entry);
      }
      for (const [childName, parentName, joint] of def.links) {
        const child = bodies.get(childName); const parent = bodies.get(parentName);
        // Every part shares the creature's yaw, so the joint in a part's own frame is just
        // the difference of the two offsets in creature space.
        const local = (part) => ({ x: (joint[0] - part.offset[0]) * s, y: (joint[1] - part.offset[1]) * s, z: (joint[2] - part.offset[2]) * s });
        const j = world.createImpulseJoint(R.JointData.spherical(local(child), local(parent)), child.body, parent.body, true);
        j.setContactsEnabled(false);
      }
      ragdolls.push(rag);
    },

    fellTree(info, rng) {
      const trunk = dynamic(info.x, info.y + TRUNK_HALF.y, info.z, { linearDamping: 0.1, angularDamping: 0.2, ccd: true });
      shaped(trunk, R.ColliderDesc.cuboid(TRUNK_HALF.x, TRUNK_HALF.y, TRUNK_HALF.z), 40, G_PROP, G_TERRAIN | G_PROP | G_RAGDOLL);
      const anchor = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(info.x, info.y, info.z));
      // Fall direction (unit, horizontal); the hinge axis is perpendicular to it, signed so
      // a positive swing carries the crown toward the fall direction.
      let dx = info.dirX ?? 1; let dz = info.dirZ ?? 0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
      const hinge = world.createImpulseJoint(
        R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: -TRUNK_HALF.y, z: 0 }, { x: dz, y: 0, z: -dx }), anchor, trunk, true);
      const shove = 2.5 + rng.next();
      trunk.applyImpulseAtPoint({ x: dx * 40 * shove, y: 0, z: dz * 40 * shove }, { x: info.x, y: info.y + TRUNK_HALF.y * 2, z: info.z }, true);
      const tree = { anchor, hinge, born: time };
      tree.entry = { body: trunk, kind: PROP_KIND.log, sizeIndex: 5, born: time, settled: false, expires: Infinity, tree };
      trees.push(tree);
      props.push(tree.entry);
    },

    spawnRocks(spec, rng) {
      const kind = spec.projectile ? PROP_KIND.projectile : PROP_KIND.rock;
      const spin = () => ({ x: rng.range(-3, 3), y: rng.range(-3, 3), z: rng.range(-3, 3) });
      if (spec.rocks) {
        spec.rocks.forEach((r, k) => {
          const x = r.x + (rng.next() - 0.5) * 0.3; const y = r.y + k * 0.05; const z = r.z + (rng.next() - 0.5) * 0.3;
          rock(r.big ? 0.5 : 0.32, r.big ? 80 : 30, x, y, z, r.vx, r.vy, r.vz, spin(), kind, r.big ? 7 : 6);
          if (spec.projectile) return;
          for (let n = 0; n < SCREE_PER_ROCK && props.length < PROP_CAP - SCREE_HEADROOM; n++) {
            const small = scree() < 0.6;
            const f = 0.55 + scree() * 0.6;
            rock(small ? 0.1 : 0.17, small ? 2 : 6,
              x + (scree() - 0.5) * 1.4, y + 0.2 + scree() * 0.8, z + (scree() - 0.5) * 1.4,
              r.vx * f + (scree() - 0.5) * 2.2, r.vy * f + scree() * 1.5, r.vz * f + (scree() - 0.5) * 2.2,
              { x: (scree() - 0.5) * 12, y: (scree() - 0.5) * 12, z: (scree() - 0.5) * 12 },
              PROP_KIND.rock, small ? 1 : 0, SCREE_SECONDS);
          }
        });
        return;
      }
      const up = spec.up ?? 2;
      const baseAngle = spec.angle ?? rng.range(0, Math.PI * 2);
      const spread = spec.spread ?? Math.PI;
      for (let k = 0; k < spec.count; k++) {
        const big = rng.next() < 0.3;
        const radius = big ? 0.5 : 0.32;
        const a = baseAngle + (rng.next() - 0.5) * spread;
        const x = spec.x + (rng.next() - 0.5); const y = spec.y + radius + k * 0.1; const z = spec.z + (rng.next() - 0.5);
        const vx = Math.cos(a) * spec.speed; const vy = up + rng.next() * up; const vz = Math.sin(a) * spec.speed;
        rock(radius, big ? 80 : 30, x, y, z, vx, vy, vz, spin(), kind, big ? 7 : 6);
      }
    },

    explode({ x, y, z, radius, strength }) {
      let hit = 0;
      for (const p of props) {
        const body = p.body;
        if (!body.isDynamic()) continue;
        const t = body.translation();
        let dx = t.x - x; let dy = t.y - y; let dz = t.z - z;
        const d = Math.hypot(dx, dy, dz);
        const mag = explosionImpulse(d, radius, strength);
        if (mag === 0) continue;
        if (d < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; }
        dy += 0.6;
        const n = Math.hypot(dx, dy, dz);
        const k = mag * body.mass() / n;
        body.applyImpulse({ x: dx * k, y: dy * k, z: dz * k }, true);
        hit++;
      }
      return hit;
    },

    step(dt) {
      time += dt;
      world.timestep = dt / cfg.substeps;
      for (let k = 0; k < cfg.substeps; k++) world.step();

      for (const tree of trees) if (tree.hinge && time - tree.born >= cfg.treeHingeSeconds) releaseTree(tree);

      for (const rag of ragdolls) {
        if (rag.settled) continue;
        if (time - rag.born >= cfg.ragdollMaxSeconds || rag.parts.every(p => p.body.isSleeping())) {
          // Making a body fixed drops nothing by itself, but its joints no longer have
          // anything to solve, so the parts simply stay where they came to rest.
          for (const p of rag.parts) { freeze(p.body); p.settled = true; p.expires = time + cfg.carcassSeconds; }
          rag.settled = true;
        }
      }
      for (const p of props) {
        if (p.settled || p.rag) continue;
        if (p.body.isSleeping() || time - p.born >= cfg.settleTimeoutSeconds) {
          if (p.tree) releaseTree(p.tree);
          freeze(p.body);
          p.settled = true;
          p.expires = time + (p.lifetime ?? (p.kind === PROP_KIND.rock || p.kind === PROP_KIND.projectile ? cfg.rockSeconds : cfg.logSeconds));
        }
      }
      for (let k = props.length - 1; k >= 0; k--) {
        if (props[k].expires <= time) { world.removeRigidBody(props[k].body); props.splice(k, 1); }
      }
      for (let k = ragdolls.length - 1; k >= 0; k--) if (ragdolls[k].settled && !props.some(p => p.rag === ragdolls[k])) ragdolls.splice(k, 1);
      for (let k = trees.length - 1; k >= 0; k--) if (!trees[k].hinge && !props.includes(trees[k].entry)) trees.splice(k, 1);
    },

    /** Write [x,y,z,qx,qy,qz,qw,propKind] per prop into `view`; returns the count written. */
    readProps(view, propCap) {
      const n = Math.min(props.length, propCap);
      for (let k = 0; k < n; k++) {
        const p = props[k]; const o = k * 8;
        const t = p.body.translation(); const q = p.body.rotation();
        view[o] = t.x; view[o + 1] = t.y; view[o + 2] = t.z;
        view[o + 3] = q.x; view[o + 4] = q.y; view[o + 5] = q.z; view[o + 6] = q.w;
        view[o + 7] = p.kind * 8 + p.sizeIndex + PROP_BASE * (p.owner ?? 0);
      }
      return n;
    },

    settledCount() { return props.filter(p => p.settled).length; },
    get propCount() { return props.length; },

    /**
     * Save-file view, the same shape world.js writes: settled props with their remaining
     * lifetime, and unsettled ragdolls as static lying poses. Bodies in flight are dropped.
     */
    snapshot() {
      const out = [];
      for (const p of props) {
        if (!p.settled) continue;
        const t = p.body.translation(); const q = p.body.rotation();
        out.push({ x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, kind: p.kind, sizeIndex: p.sizeIndex, owner: p.owner ?? 0, remaining: Math.max(1, p.expires - time) });
      }
      for (const rag of ragdolls) {
        if (rag.settled) continue;
        for (const pose of lyingPose(rag.info.species, rag.info.x, rag.info.y, rag.info.z, rag.info.yaw, rag.info.scale)) {
          out.push({ x: pose.x, y: pose.y, z: pose.z, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw, kind: Math.floor(pose.propKind / 8), sizeIndex: pose.propKind % 8, owner: pose.owner, remaining: cfg.carcassSeconds });
        }
      }
      return out;
    },

    /** Recreate saved props as static bodies with their remaining lifetimes. */
    restore(list) {
      for (const s of list ?? []) {
        props.push({ body: fixedBox(s, G_PROP), kind: s.kind, sizeIndex: s.sizeIndex, owner: s.owner ?? 0, born: time, settled: true, expires: time + (s.remaining ?? cfg.carcassSeconds) });
      }
    },

    dispose() {
      props.length = 0; ragdolls.length = 0; trees.length = 0;
      // Frees the bodies, colliders and joints with it: the WASM heap is not garbage collected.
      try { world.removeCollider(ground, false); world.free(); } catch { /* already gone */ }
    },
  };
  return physics;
}
