// physics.js — rigid-body world for PoBrawl's VISUALS (Rapier, via platform/physics).
//
// Not the fight sim: hit detection, knockback and netplay run on the fixed-point rollback sim and
// never read this world. What lives here is dressing — KO ragdolls, severed arms, the corner crates
// and the ring's posts/ropes — so the physics engine can change without touching a replay. The
// engine code still speaks the cannon Body API (platform/physics/cannonCompat.js), now backed by the
// shared Rapier wrapper; contact-force events from tagged materials (ragdoll=flesh, props/ring=wood)
// reach impactSynth on their own (platform/physics/rapier.js), so crates thud on the mat for free.
//
// The character controllers own intent (move, attack, block) and hit detection
// is the capsule test in hitboxes.js. The physics world owns what needs a
// solver: the kinematic rig roots (ragdoll/prop shoving; fighter-vs-fighter
// separation is enforced in game.js because cannon never pairs two kinematic
// bodies), the KO ragdolls and severed limbs, the ring colliders and the props.
//
// Filter groups (A collides with B iff A.group & B.mask && B.group & A.mask).
// Bits 1 and 2 are unused.

import * as CANNON from '../platform/physics/cannonCompat.js';
import { loadRapier } from '../platform/physics/rapier.js';

// Rapier is a CDN WASM module; the world is built synchronously by game.js, so it is awaited here at
// module load. If it never arrives the compat world is inert (bodies hold still) and nothing throws.
await loadRapier();

export const G_ROOT = 1 << 0;
export const G_RAGDOLL = 1 << 3;  // KO rigid-body ragdoll parts
export const G_ARENA = 1 << 4;    // static ring colliders (posts, rope walls)
export const G_PROP = 1 << 5;     // dynamic corner crates + debris (props.js)

const GRAVITY = 20;
const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 8;

let _materials = null;

// Material instances are module-cached, but ContactMaterials must be
// registered on EVERY world (a rematch builds a fresh world).
function ensureMaterials(world) {
  if (!_materials) {
    _materials = {
      root: new CANNON.Material('root'),
      ragdoll: new CANNON.Material({ name: 'ragdoll', impactTag: 'flesh' }),
      arena: new CANNON.Material({ name: 'arena', impactTag: 'wood' }),
      prop: new CANNON.Material({ name: 'prop', impactTag: 'wood' }),
    };
  }
  const m = _materials;
  world.addContactMaterial(new CANNON.ContactMaterial(m.root, m.root, {
    friction: 0, restitution: 0,
  }));
  // KO ragdoll response: slight bounce off the canvas, high limb-on-limb
  // friction so the pile settles, springy rope walls.
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.root, {
    friction: 0.5, restitution: 0.25,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.ragdoll, {
    friction: 0.4, restitution: 0.05,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.ragdoll, m.arena, {
    friction: 0.3, restitution: 0.45,
  }));
  // Props: enough friction against the mat that a knocked pile settles instead
  // of sliding forever; crate-on-crate friction keeps stacks standing until
  // shoved; a ragdoll crashing through bounces a touch more so the scatter reads.
  world.addContactMaterial(new CANNON.ContactMaterial(m.prop, m.root, {
    friction: 0.55, restitution: 0.2,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.prop, m.prop, {
    friction: 0.5, restitution: 0.15,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.prop, m.ragdoll, {
    friction: 0.4, restitution: 0.35,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(m.prop, m.arena, {
    friction: 0.4, restitution: 0.4,
  }));
  return m;
}

// One world per match.
export function createPhysicsWorld() {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -GRAVITY, 0), fixedDt: FIXED_DT,
    // Quiet scuffles stay silent; a crate hitting the mat or a limp body landing rings once per pair.
    impact: { threshold: 2.5, pairGapMs: 110, maxPerStep: 2, full: 25 },
  });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 14;
  world.defaultContactMaterial.friction = 0;
  const mats = ensureMaterials(world);
  // Floor at y = 0.04 to match the arena canvas.
  const floorBody = new CANNON.Body({
    mass: 0,
    material: mats.root,
    shape: new CANNON.Plane(),
  });
  floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  floorBody.position.set(0, 0.04, 0);
  world.addBody(floorBody);
  return { world, materials: mats, floorBody };
}

// Callers skip this during hit-pause.
export function stepWorld(world, dt) {
  world.step(FIXED_DT, Math.min(dt, 0.05), MAX_SUBSTEPS);
}

// ── Rig-root kinematic body ───────────────────────────────────────────
// Kinematic (not static) so game.js can write its position every tick and
// cannon still resolves contacts against it: dynamic ragdolls and crates get
// shoved, the root itself never moves.
export function createRootBody(world, mats, initialPos) {
  const body = new CANNON.Body({
    mass: 0,
    material: mats.root,
    shape: new CANNON.Sphere(0.55),
    position: new CANNON.Vec3(initialPos.x, 0.9, initialPos.z),
    type: CANNON.Body.KINEMATIC,
  });
  // Lower shin/foot sphere reaching down to the canvas (y = 0.04) so standing
  // fighters physically shove active KO ragdolls instead of walking through them.
  body.addShape(new CANNON.Sphere(0.34), new CANNON.Vec3(0, -0.52, 0));
  body.collisionFilterGroup = G_ROOT;
  // Ragdolls: the standing winner shoves the KO'd body aside. Props: a
  // standing fighter nudges the corner crates as a fallback to the explicit
  // shove impulses props.js applies.
  body.collisionFilterMask = G_ROOT | G_RAGDOLL | G_PROP;
  body.userData = { kind: 'rigRoot' };
  world.addBody(body);
  return body;
}

// Lightweight kinematic proxy for a retired FFA corpse so newly falling ragdolls
// and crates collide with and stack on top of bodies already on the mat.
export function createRetiredBody(world, mats, rootPos, parts) {
  const body = new CANNON.Body({
    mass: 0,
    material: mats.ragdoll,
    position: new CANNON.Vec3(rootPos.x, rootPos.y, rootPos.z),
    type: CANNON.Body.KINEMATIC,
  });
  for (const part of parts) {
    body.addShape(new CANNON.Sphere(part.radius), new CANNON.Vec3(part.ox, part.oy, part.oz));
  }
  body.collisionFilterGroup = G_RAGDOLL;
  body.collisionFilterMask = G_RAGDOLL | G_PROP;
  body.userData = { kind: 'retiredBody' };
  world.addBody(body);
  return body;
}

// ── Static ring colliders ─────────────────────────────────────────────
// Posts + rope walls the KO ragdoll can crumple against and bounce off.
// They only interact with ragdolls and props, so live-fight bodies never see them.
export function buildArenaColliders(world, mats) {
  const HALF = 5.8;
  const bodies = [];
  const add = (body) => {
    body.collisionFilterGroup = G_ARENA;
    // G_PROP so launched crates rebound off the rope walls / posts and stay
    // inside the ring instead of sliding out under the ropes.
    body.collisionFilterMask = G_RAGDOLL | G_PROP;
    body.userData = { kind: 'arena' };
    world.addBody(body);
    bodies.push(body);
  };
  // Corner posts.
  for (const x of [-HALF, HALF]) {
    for (const z of [-HALF, HALF]) {
      add(new CANNON.Body({
        mass: 0, material: mats.arena,
        shape: new CANNON.Cylinder(0.1, 0.1, 1.5, 8),
        position: new CANNON.Vec3(x, 0.79, z),
      }));
    }
  }
  // Rope walls: one springy box per side so a launched body rebounds into the
  // ring. Deep and tall on purpose: a charged KO launches limbs at 20+ m/s, and
  // the old 8 cm slab spanning only the rope band (y 0.45..1.35) was tunnelled
  // through at 120 Hz, slid under or cleared — the body left the ring and the KO
  // camera filmed the crowd. Floor to WALL_TOP, WALL_DEPTH thick, inner face
  // where the ropes are (HALF − 0.04, as before). The ragdoll also clamps itself
  // to the ring (ragdollPhysics.js RING_LIMIT), so this is the bounce, not the fence.
  const WALL_DEPTH = 0.6, WALL_TOP = 2.4, WALL_LEN = HALF + WALL_DEPTH;
  const wallOff = HALF - 0.04 + WALL_DEPTH / 2;
  for (const side of [0, 1]) {
    for (const sign of [-1, 1]) {
      add(new CANNON.Body({
        mass: 0, material: mats.arena,
        shape: new CANNON.Box(new CANNON.Vec3(
          side ? WALL_DEPTH / 2 : WALL_LEN, WALL_TOP / 2, side ? WALL_LEN : WALL_DEPTH / 2)),
        position: new CANNON.Vec3(side ? sign * wallOff : 0, WALL_TOP / 2, side ? 0 : sign * wallOff),
      }));
    }
  }
  return bodies;
}

// Drive the kinematic rig root to the fighter's world position. Y tracks p.y + 0.9
// so a fighter stepping onto a downed body lifts their collider with them.
export function syncRigRoot(rigRoot, fighter) {
  const p = fighter.rig.root.position;
  rigRoot.position.x = p.x;
  rigRoot.position.z = p.z;
  rigRoot.position.y = p.y + 0.9;
}
