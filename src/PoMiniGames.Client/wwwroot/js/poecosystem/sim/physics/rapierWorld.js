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
//   • WATER: a prop below sea level over a water tile is lifted in proportion to how much
//     of it is under (and to what it is made of), dragged, and eased toward the shallows.
//     Logs and bodies bob at the surface and drift ashore; rock sinks, slowly.
//   • WALKERS: a living creature passing a loose prop gets an unseen moving body for as
//     long as it is close (`walkers`), so a herd kicks scree downhill and a deer shoulders
//     a log aside. The creature is told nothing about it: its path is the sim's alone.
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
const G_WALKER = 8;
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

// Water. LIFT is how many times its own weight the water pushes a fully sunk body up: over
// 1 floats (it settles where 1/LIFT of it is under), under 1 sinks, slowly.
const WATER_DEPTH = -0.08;      // the ground under a body must be this low for it to be in water
const LIFT = Object.freeze({ [PROP_KIND.log]: 1.9, [PROP_KIND.ragdollPart]: 1.35, [PROP_KIND.rock]: 0.3, [PROP_KIND.projectile]: 0.3 });
const WATER_DRAG = 2.2;         // s^-1 along the surface
const WATER_HEAVE_DRAG = 4.5;   // s^-1 up and down: what stops a log bobbing for ever
const WATER_SPIN_DRAG = 2.0;
const SHOREWARD = 0.55;         // m/s^2 toward the shallows for what floats: waves bring things in
const AFLOAT_SECONDS = 25;      // extra time before something still afloat is frozen where it is
const AFLOAT_RAGDOLL_SECONDS = 12;
const LOG_END = 0.95;           // metres from a trunk's middle to where each end is lifted
/** Half the height of a prop as it lies in the water. */
const halfHeight = (p) => p.kind === PROP_KIND.log ? TRUNK_HALF.x
  : p.kind === PROP_KIND.ragdollPart ? 0.12
    : p.sizeIndex === 7 ? 0.5 : p.sizeIndex === 6 ? 0.32 : p.sizeIndex === 0 ? 0.17 : 0.1;

// Walkers: living creatures as moving bodies, only where there is something loose to push.
const WALKERS = 24;             // most creatures given a body at once
const WALKER_REACH = 1.6;       // metres from a creature to a loose prop for it to get one
const WALKER_WAKE = 1.0;        // metres at which a settled prop is woken to be pushed
const WALKER_SPEED = 0.5;       // m/s: a creature standing still pushes nothing
const WALKER_RADIUS = [0.2, 0.36, 0.34, 0.26];   // rabbit, deer, wolf, human
const NUDGE_SPEED = 3.2;        // m/s a pushed prop may leave at, however fast it was hit
const NUDGE_SETTLE = 4;         // seconds a woken prop has to come to rest again
const PARKED = -60;             // where an idle walker waits, well under the island

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
  const props = [];      // { body, kind, sizeIndex, born, settled, expires, lifetime?, rag?, tree?, afloat?, keep?, nudged?, fixedShape? }
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
  // Everything loose is also touched by walkers (the living, below), which touch nothing else.
  const shaped = (body, desc, mass, member, touches) => world.createCollider(
    desc.setMass(mass).setFriction(cfg.friction).setRestitution(cfg.restitution).setCollisionGroups(groups(member, touches | G_WALKER)),
    body);
  const fixedBox = (pose, member) => {
    const body = world.createRigidBody(R.RigidBodyDesc.fixed()
      .setTranslation(pose.x, pose.y, pose.z)
      .setRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw }));
    world.createCollider(R.ColliderDesc.cuboid(0.15, 0.15, 0.15).setCollisionGroups(groups(member, G_PROP | G_RAGDOLL)), body);
    return body;
  };

  /**
   * Water on every loose body, once per substep. A body is in the water when its underside
   * is below sea level (0) and the ground under it is too. Nothing here is read by a rule.
   */
  const heightAt = typeof terrain.heightAt === 'function' ? (x, z) => terrain.heightAt(x, z) : null;
  const float = (dt) => {
    if (!heightAt) return;
    for (const p of props) {
      if (p.settled) continue;
      const body = p.body;
      const t = body.translation();
      const half = halfHeight(p);
      // A trunk is long: it is lifted at its two ends, each by how deep that end is, which is
      // what lays a log flat on the water instead of leaving it standing in it.
      let ex = 0; let ey = 0; let ez = 0;
      if (p.kind === PROP_KIND.log) {
        const q = body.rotation();
        ex = 2 * (q.x * q.y - q.w * q.z) * LOG_END; ey = (1 - 2 * (q.x * q.x + q.z * q.z)) * LOG_END; ez = 2 * (q.y * q.z + q.w * q.x) * LOG_END;
      }
      if (t.y - Math.abs(ey) - half > 0) continue;
      if (heightAt(t.x, t.z) > WATER_DEPTH) continue;
      const depth = (y) => Math.max(0, Math.min(1, (half - y) / (2 * half)));
      const lift = LIFT[p.kind] ?? 1;
      const m = body.mass();
      let under = depth(t.y);
      if (p.kind === PROP_KIND.log) {
        const a = depth(t.y + ey); const b = depth(t.y - ey);
        under = (a + b) / 2;
        if (under <= 0) continue;
        const j = m * cfg.gravity * lift * dt / 2;
        body.applyImpulseAtPoint({ x: 0, y: j * a, z: 0 }, { x: t.x + ex, y: t.y + ey, z: t.z + ez }, true);
        body.applyImpulseAtPoint({ x: 0, y: j * b, z: 0 }, { x: t.x - ex, y: t.y - ey, z: t.z - ez }, true);
      } else {
        if (under <= 0) continue;
        body.applyImpulse({ x: 0, y: m * cfg.gravity * lift * under * dt, z: 0 }, true);
      }
      let jx = 0; let jz = 0;
      if (lift > 1) {
        p.afloat = time;
        // Uphill on the sea bed is toward the shore.
        const gx = heightAt(t.x + 2, t.z) - heightAt(t.x - 2, t.z); const gz = heightAt(t.x, t.z + 2) - heightAt(t.x, t.z - 2);
        const g = Math.hypot(gx, gz);
        if (g > 1e-3) { jx = gx / g * SHOREWARD * under * m * dt; jz = gz / g * SHOREWARD * under * m * dt; }
      }
      if (jx || jz) body.applyImpulse({ x: jx, y: 0, z: jz }, true);
      const v = body.linvel();
      const k = 1 - Math.min(0.9, WATER_DRAG * under * dt); const ky = 1 - Math.min(0.9, WATER_HEAVE_DRAG * under * dt);
      body.setLinvel({ x: v.x * k, y: v.y * ky, z: v.z * k }, true);
      const w = body.angvel();
      const kw = 1 - Math.min(0.9, WATER_SPIN_DRAG * under * dt);
      body.setAngvel({ x: w.x * kw, y: w.y * kw, z: w.z * kw }, true);
    }
  };

  // ── walkers ───────────────────────────────────────────────────────────
  const walkerPool = [];        // { body, handle } made on first need
  const propAt = new Float32Array(PROP_CAP * 3);   // where each prop was after the last step
  let propAtCount = 0;
  const near = [];
  const wakeable = (p) => !p.fixedShape && (p.kind === PROP_KIND.log || (p.kind === PROP_KIND.ragdollPart && p.rag)
    || (p.kind === PROP_KIND.rock && p.sizeIndex < 6));
  const wake = (p) => {
    if (!p.settled) return;
    if (p.rag) {
      // A carcass wakes whole or not at all, and never past the cap a fresh death needs.
      if (!p.rag.settled || physics.activeRagdolls >= cfg.maxActiveRagdolls - 4) return;
      for (const part of p.rag.parts) {
        part.keep = part.keep ?? part.expires; part.settled = false; part.nudged = time;
        part.body.setBodyType(R.RigidBodyType.Dynamic, true);
      }
      p.rag.settled = false;
      p.rag.born = time - cfg.ragdollMaxSeconds + NUDGE_SETTLE;
      return;
    }
    p.keep = p.keep ?? p.expires; p.settled = false; p.nudged = time;
    p.born = time - cfg.settleTimeoutSeconds + NUDGE_SETTLE;
    p.body.setBodyType(R.RigidBodyType.Dynamic, true);
  };
  const parkWalkers = () => {
    for (const w of walkerPool) {
      if (w.handle === -1) continue;
      w.handle = -1;
      w.body.setTranslation({ x: 0, y: PARKED, z: 0 }, false);
    }
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
          props.push({ body: fixedBox(pose, G_RAGDOLL), kind: Math.floor(pose.propKind / 8), sizeIndex: pose.propKind % 8, owner: pose.owner, born: time, settled: true, fixedShape: true, expires: time + cfg.carcassSeconds });
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

    /**
     * Where the living are, once per tick before `step`: `e` is the sim's entity store, read
     * and never written. A creature moving within reach of a loose prop gets a body that
     * follows it for as long as it stays close; a settled log, carcass or scree stone it
     * walks into is woken to be pushed, and settles again. Nothing comes back to the sim.
     */
    walkers(e) {
      if (!props.length || !e?.forEachAlive) { if (walkerPool.length) parkWalkers(); return; }
      near.length = 0;
      const reach2 = WALKER_REACH * WALKER_REACH; const wake2 = WALKER_WAKE * WALKER_WAKE;
      const slow2 = WALKER_SPEED * WALKER_SPEED;
      e.forEachAlive((i) => {
        const vx = e.vx[i]; const vz = e.vz[i];
        if (vx * vx + vz * vz < slow2) return;
        const x = e.x[i]; const y = e.y[i]; const z = e.z[i];
        let best = reach2;
        for (let k = 0; k < propAtCount; k++) {
          const dx = propAt[k * 3] - x; const dz = propAt[k * 3 + 2] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= reach2 || Math.abs(propAt[k * 3 + 1] - y) > 1.5) continue;
          const p = props[k];
          if (!p || !wakeable(p)) continue;
          if (d2 < wake2) wake(p);
          if (d2 < best) best = d2;
        }
        if (best < reach2) near.push({ i, d2: best });
      });
      if (!near.length) { if (walkerPool.length) parkWalkers(); return; }
      if (near.length > WALKERS) { near.sort((p, q) => p.d2 - q.d2); near.length = WALKERS; }
      while (walkerPool.length < WALKERS) {
        const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PARKED, 0));
        world.createCollider(R.ColliderDesc.ball(0.3).setCollisionGroups(groups(G_WALKER, G_PROP | G_RAGDOLL)), body);
        walkerPool.push({ body, handle: -1, used: false });
      }
      for (const w of walkerPool) w.used = false;
      const fresh = [];
      for (const n of near) {
        const handle = e.handle(n.i);
        const w = walkerPool.find(q => q.handle === handle);
        if (w) { w.used = true; n.walker = w; } else fresh.push(n);
      }
      for (const n of fresh) {
        const w = walkerPool.find(q => !q.used);
        if (!w) break;
        w.used = true; w.handle = e.handle(n.i); n.walker = w; n.fresh = true;
      }
      for (const n of near) {
        const w = n.walker; if (!w) continue;
        const i = n.i;
        const r = (WALKER_RADIUS[e.species[i]] ?? 0.3) * (e.scale[i] || 1);
        const at = { x: e.x[i], y: e.y[i] + r, z: e.z[i] };
        w.body.collider(0).setRadius(r);
        // A walker that has just been handed a creature appears beside it; one that already
        // had it is carried there, which is what gives the push its speed.
        if (n.fresh) w.body.setTranslation(at, true); else w.body.setNextKinematicTranslation(at);
      }
      for (const w of walkerPool) if (!w.used && w.handle !== -1) { w.handle = -1; w.body.setTranslation({ x: 0, y: PARKED, z: 0 }, false); }
    },
    get activeWalkers() { return walkerPool.filter(w => w.handle !== -1).length; },

    step(dt) {
      time += dt;
      world.timestep = dt / cfg.substeps;
      for (let k = 0; k < cfg.substeps; k++) { float(world.timestep); world.step(); }

      // What a creature pushed leaves at a walk, however fast it was hit.
      for (const p of props) {
        if (p.nudged === undefined || p.settled || time - p.nudged > 1.5) continue;
        const v = p.body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp > NUDGE_SPEED) { const k = NUDGE_SPEED / sp; p.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true); }
      }

      for (const tree of trees) if (tree.hinge && time - tree.born >= cfg.treeHingeSeconds) releaseTree(tree);

      for (const rag of ragdolls) {
        if (rag.settled) continue;
        // A body in the water is given a while longer to come ashore before it is frozen.
        const afloat = rag.parts.some(p => p.afloat !== undefined && time - p.afloat < 0.5);
        if (time - rag.born >= cfg.ragdollMaxSeconds + (afloat ? AFLOAT_RAGDOLL_SECONDS : 0) || rag.parts.every(p => p.body.isSleeping())) {
          // Making a body fixed drops nothing by itself, but its joints no longer have
          // anything to solve, so the parts simply stay where they came to rest.
          for (const p of rag.parts) { freeze(p.body); p.settled = true; p.expires = p.keep ?? (time + cfg.carcassSeconds); p.keep = undefined; }
          rag.settled = true;
        }
      }
      for (const p of props) {
        if (p.settled || p.rag) continue;
        const afloat = p.afloat !== undefined && time - p.afloat < 0.5;
        if (p.body.isSleeping() || time - p.born >= cfg.settleTimeoutSeconds + (afloat ? AFLOAT_SECONDS : 0)) {
          if (p.tree) releaseTree(p.tree);
          freeze(p.body);
          p.settled = true;
          // A prop a creature woke keeps the time it had left; it does not start again.
          p.expires = p.keep ?? (time + (p.lifetime ?? (p.kind === PROP_KIND.rock || p.kind === PROP_KIND.projectile ? cfg.rockSeconds : cfg.logSeconds)));
          p.keep = undefined;
        }
      }
      for (let k = props.length - 1; k >= 0; k--) {
        if (props[k].expires <= time) { world.removeRigidBody(props[k].body); props.splice(k, 1); }
      }
      for (let k = ragdolls.length - 1; k >= 0; k--) if (ragdolls[k].settled && !props.some(p => p.rag === ragdolls[k])) ragdolls.splice(k, 1);
      for (let k = trees.length - 1; k >= 0; k--) if (!trees[k].hinge && !props.includes(trees[k].entry)) trees.splice(k, 1);

      // Where everything is now, for the next tick's walkers (one read per prop, not one
      // per prop per creature).
      propAtCount = Math.min(props.length, PROP_CAP);
      for (let k = 0; k < propAtCount; k++) {
        const t = props[k].body.translation();
        propAt[k * 3] = t.x; propAt[k * 3 + 1] = t.y; propAt[k * 3 + 2] = t.z;
      }
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
        // Settled, or settled once and being pushed about just now (its carcass, if it is
        // one, is written below as a lying pose).
        if (!p.settled && (p.keep === undefined || p.rag)) continue;
        const t = p.body.translation(); const q = p.body.rotation();
        out.push({ x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, kind: p.kind, sizeIndex: p.sizeIndex, owner: p.owner ?? 0, remaining: Math.max(1, (p.keep ?? p.expires) - time) });
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
        // `fixedShape`: a restored prop is a small fixed box, not the shape it was, so it is never woken.
        props.push({ body: fixedBox(s, G_PROP), kind: s.kind, sizeIndex: s.sizeIndex, owner: s.owner ?? 0, born: time, settled: true, fixedShape: true, expires: time + (s.remaining ?? cfg.carcassSeconds) });
      }
    },

    dispose() {
      props.length = 0; ragdolls.length = 0; trees.length = 0; walkerPool.length = 0; propAtCount = 0;
      // Frees the bodies, colliders and joints with it: the WASM heap is not garbage collected.
      try { world.removeCollider(ground, false); world.free(); } catch { /* already gone */ }
    },
  };
  return physics;
}
