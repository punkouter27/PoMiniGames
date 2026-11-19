// hitboxes.js — capsule-vs-capsule hit detection for PoBrawl.
//
// Each fighter is decomposed into a small set of capsules (line segment +
// radius). At runtime we sample world-space endpoints for each capsule from
// the rig's THREE.Group hierarchy, then for an active attack we test its
// "striker" capsules against the defender's "hurt" capsules. A hit is only
// registered if at least one striker-hurt capsule pair intersects.
//
// This is the standard fighting-game approach: capsule-capsule tests are O(N*M),
// stable under rotation, and read as "real polygon contact" to a player without
// the cost of a true mesh-mesh pipeline. It is the only hit path: game.js polls
// it every active-attack tick, and the clash test runs on the same geometry.
//
// ── A strike counts when it touches ───────────────────────────────────────
// The shapes below are the body as it is drawn: a capsule the size of the head where the
// head is, one the size of the chest where the chest is, one down each limb. The strikers
// are the fist and the foot (with the shin behind it), nothing wider. So a punch scores
// when the glove reaches the face or the body, and a swing that stops short, or passes
// beside a head, is a miss.
// Arms count too, but as cover: a glove that reaches an arm first has been blocked by it
// (the engine's arm block), which is why a swept striker reports the FIRST thing on its path
// rather than the part it ended up deepest in.
// A fist crosses 10-15 cm in one sim tick, more than half a head: tested only where it is
// each tick it could step straight over a face and never be "in" it. So the fist and foot
// are tested along the path they travelled since the last tick (a sweep), not at a point.
// The battle royale's small fighters keep the older, more generous shapes (`loose`): its
// pacing is tuned on them, and at that size nobody can see the difference.
//
// ── Capsule anatomy ───────────────────────────────────────────────────────
// A capsule is { jointA, jointB, radius } where jointA/jointB are rig joint
// names; its world endpoints are those joints' world positions at test time.
// Sets: striker (deals damage) and hurt (receives). The guard is not a
// capsule set but an arc — see `guardCovers`.
//
// ── Why capsules not boxes ───────────────────────────────────────────────
// Boxes would be slightly more accurate to the visible primitives but require
// an OBB-OBB SAT test; the rig uses axis-aligned boxes parented to rotated
// joints, so even the "boxes" rotate with the limb. Capsules capture the same
// silhouette with a single segment-segment distance check.

import * as THREE from 'three-eco/webgpu';

// jointA/jointB are the rig's joint names; offA/offB move an end along that joint's own axes
// (metres at scale 1); radius is the capsule thickness in world units at scale 1.
// `wide` parts follow the fighter's build as well as their height.
const HURT_CAPSULES = {
  // The skull: a box about 26 cm across, centred 16 cm above the neck joint.
  head:      { jointA: 'head',  offA: [0, 0.13, 0], jointB: 'head',  offB: [0, 0.19, 0], radius: 0.145 },
  // The chest: 46 x 62 x 32 cm, standing on the waist joint.
  torso:     { jointA: 'torso', offA: [0, 0.16, 0], jointB: 'torso', offB: [0, 0.46, 0], radius: 0.19, wide: true },
  // Pelvis and belly, between the hips and the waist.
  belly:     { jointA: 'hips',  jointB: 'torso',    radius: 0.16, wide: true },
  hipL:      { jointA: 'hips',  jointB: 'hipL',     radius: 0.11 },
  hipR:      { jointA: 'hips',  jointB: 'hipR',     radius: 0.11 },
  thighL:    { jointA: 'hipL',  jointB: 'kneeL',    radius: 0.095 },
  thighR:    { jointA: 'hipR',  jointB: 'kneeR',    radius: 0.095 },
  shinL:     { jointA: 'kneeL', jointB: 'footL',    radius: 0.08 },
  shinR:     { jointA: 'kneeR', jointB: 'footR',    radius: 0.08 },
  // The arms. A glove that meets one of these before it meets the head or the body has
  // been taken on the arm: the engine treats it as a block, not a scoring blow.
  upperArmL: { jointA: 'shoulderL', jointB: 'elbowL', radius: 0.08 },
  upperArmR: { jointA: 'shoulderR', jointB: 'elbowR', radius: 0.08 },
  forearmL:  { jointA: 'elbowL', jointB: 'fistL',   radius: 0.075 },
  forearmR:  { jointA: 'elbowR', jointB: 'fistR',   radius: 0.075 },
};

// The shapes this used before, kept for the battle royale and for anything that only needs
// "roughly where did that land": about twice the thickness of the body they stand for.
const LOOSE_HURT_CAPSULES = {
  head:      { jointA: 'torso', jointB: 'head',     radius: 0.30 },
  torso:     { jointA: 'hips',  jointB: 'torso',    radius: 0.34 },
  hipL:      { jointA: 'hips',  jointB: 'hipL',     radius: 0.18 },
  hipR:      { jointA: 'hips',  jointB: 'hipR',     radius: 0.18 },
  thighL:    { jointA: 'hipL',  jointB: 'kneeL',    radius: 0.16 },
  thighR:    { jointA: 'hipR',  jointB: 'kneeR',    radius: 0.16 },
  shinL:     { jointA: 'kneeL', jointB: 'footL',    radius: 0.14 },
  shinR:     { jointA: 'kneeR', jointB: 'footR',    radius: 0.14 },
  upperArmL: { jointA: 'torso', jointB: 'elbowL',   radius: 0.13 },
  upperArmR: { jointA: 'torso', jointB: 'elbowR',   radius: 0.13 },
  forearmL:  { jointA: 'shoulderL', jointB: 'elbowL', radius: 0.11 },
  forearmR:  { jointA: 'shoulderR', jointB: 'elbowR', radius: 0.11 },
};

// Half-angle of the guard, measured from the defender's facing. A held guard
// stops every strike thrown from inside it — the classic fighting-game rule.
// It used to be two forearm capsules the striker had to touch, which let most
// strikes slip past a guard that was visibly up (1 block in 10 against a
// player holding the button all round). 100° covers the whole front and both
// flanks, so only a strike from behind the shoulder line still lands.
const GUARD_HALF_ARC_COS = Math.cos(THREE.MathUtils.degToRad(100));

// Per-attack striker capsules.
//   active   what scores: the fist, or the foot and the shin behind it. `sweep` strikers
//            are tested along the path they moved since the last tick. `forwardReach` is the
//            knuckle / toe ahead of the joint.
//   recover  nothing: a limb on its way back does not score.
//   clash    what two simultaneous swings meet on (the whole forearm or shin, as before).
//   loose    the older, fatter strikers, with the forearm scoring too (battle royale).
const fistOf = (side) => ({
  active: {
    fist: { jointA: `fist${side}`, jointB: `fist${side}`, radius: 0.085, forwardReach: 0.02, sweep: true },
  },
  recover: {},
  clash: {
    forearm: { jointA: `elbow${side}`, jointB: `fist${side}`, radius: 0.11 },
    fist:    { jointA: `fist${side}`,  jointB: `fist${side}`, radius: 0.12, forwardReach: 0.06 },
  },
  loose: {
    active: {
      forearm: { jointA: `elbow${side}`, jointB: `fist${side}`, radius: 0.11 },
      fist:    { jointA: `fist${side}`,  jointB: `fist${side}`, radius: 0.12, forwardReach: 0.06 },
    },
    recover: {
      forearm: { jointA: `elbow${side}`, jointB: `fist${side}`, radius: 0.08 },
    },
  },
});
const ATTACK_CAPSULES = {
  punch: fistOf('R'),
  // The left hand (combat.js pickPunchArm): the same shapes on the other arm.
  punchL: fistOf('L'),
  kick: {
    active: {
      shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.07 },
      foot: { jointA: 'footR', jointB: 'footR', radius: 0.08, forwardReach: 0.12, sweep: true },
    },
    recover: {},
    clash: {
      shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.13 },
      foot: { jointA: 'footR', jointB: 'footR', radius: 0.14, forwardReach: 0.08 },
    },
    loose: {
      active: {
        shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.13 },
        foot: { jointA: 'footR', jointB: 'footR', radius: 0.14, forwardReach: 0.08 },
      },
      recover: {
        shin: { jointA: 'kneeR', jointB: 'footR', radius: 0.09 },
      },
    },
  },
};

// Where each sweep striker was on the last tick it was tested: rig -> name -> { p, t, attack }.
const _swept = new WeakMap();
const SWEEP_MAX_GAP = 0.06;    // seconds; older than this is another swing, not this one's path

// Compute the two world-space endpoints of a capsule from the rig's joints.
// `forwardReach` extends the second endpoint along the rig's local +Z (the
// direction the fighter is facing) so a swing can "reach past" the fist.
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _fwd = new THREE.Vector3();
function capsuleEndpoints(joints, cap, forwardDir, scale = 1) {
  const a = joints[cap.jointA];
  const b = joints[cap.jointB];
  if (!a || !b) return null;
  // An offset end is a point in the joint's own space (the skull above the neck joint).
  if (cap.offA) a.localToWorld(_vA.fromArray(cap.offA)); else a.getWorldPosition(_vA);
  if (cap.offB) b.localToWorld(_vB.fromArray(cap.offB)); else b.getWorldPosition(_vB);
  if (cap.forwardReach && forwardDir) {
    _fwd.copy(forwardDir).multiplyScalar(cap.forwardReach * scale);
    _vB.add(_fwd);
  }
  return { a: _vA.clone(), b: _vB.clone() };
}

// Closest points between two line segments in 3D, plus the distance between
// them. Returns { d, pa, pb } where pa/pb are the closest points on each
// segment, or null if the segments are degenerate.
//
// Standard segment-segment distance (Real-Time Collision Detection, Ericson).
function closestPointsOnSegments(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y, d2z = p4.z - p3.z;
  const rx = p1.x - p3.x, ry = p1.y - p3.y, rz = p1.z - p3.z;
  const a = d1x*d1x + d1y*d1y + d1z*d1z; // |d1|^2
  const e = d2x*d2x + d2y*d2y + d2z*d2z; // |d2|^2
  const f = d2x*rx + d2y*ry + d2z*rz;
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return null; // both degenerate
  if (a <= 1e-9) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x*rx + d1y*ry + d1z*rz;
    if (e <= 1e-9) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1x*d2x + d1y*d2y + d1z*d2z;
      const denom = a*e - b*b;
      if (denom !== 0) {
        s = Math.max(0, Math.min(1, (b*f - c*e) / denom));
      } else {
        s = 0;
      }
      t = (b*s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const pa = new THREE.Vector3(p1.x + d1x*s, p1.y + d1y*s, p1.z + d1z*s);
  const pb = new THREE.Vector3(p3.x + d2x*t, p3.y + d2y*t, p3.z + d2z*t);
  return { d: pa.distanceTo(pb), pa, pb };
}

/**
 * Test a single attacker capsule against all defender capsules.
 * Returns the first intersection { capsule, point, distance } or null.
 */
// A rig's facing direction flattened to world XZ.
function facing(rig, out) {
  rig.root.getWorldDirection(out);
  out.y = 0;
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  return out.normalize();
}

// How big a rig's shapes are: its height, and for `wide` parts its build as well.
function rigScale(rig, cap) {
  const c = rig.config || {};
  return (c.heightScale ?? 1) * (cap.wide ? (c.buildScale ?? 1) : 1);
}

function testCapsuleAgainstSet(attackerRig, name, attackerCaps, defenderRig, defenderCaps, scale, o) {
  const atk = capsuleEndpoints(attackerRig.joints, attackerCaps, facing(attackerRig, _fwd), scale);
  if (!atk) return null;
  if (attackerCaps.sweep && o.t != null) {
    // From where the fist was a tick ago to where it is now: the path it actually took.
    let memo = _swept.get(attackerRig);
    if (!memo) _swept.set(attackerRig, memo = {});
    const was = memo[name];
    const tip = atk.b.clone();
    if (was && was.attack === o.attack && o.t - was.t >= 0 && o.t - was.t < SWEEP_MAX_GAP) atk.a.copy(was.p);
    memo[name] = { p: tip, t: o.t, attack: o.attack };
  }
  const atkRadius = attackerCaps.radius * rigScale(attackerRig, attackerCaps) * scale;
  let best = null;
  for (const [capName, cap] of Object.entries(defenderCaps)) {
    const def = capsuleEndpoints(defenderRig.joints, cap, null);
    if (!def) continue;
    const hit = closestPointsOnSegments(atk.a, atk.b, def.a, def.b)
      // Two points (a still fist against a sphere-like head): plain distance.
      || { d: atk.a.distanceTo(def.a), pa: atk.a.clone(), pb: def.a.clone() };
    const threshold = atkRadius + cap.radius * rigScale(defenderRig, cap) * scale;
    if (hit.d <= threshold) {
      // Which part: for a swept striker, the first one along its path (an arm in front of
      // the chest is met before the chest); otherwise the one it is deepest into.
      const order = attackerCaps.sweep ? hit.pa.distanceTo(atk.a) : hit.d;
      if (!best || order < best.order) {
        best = { capsule: capName, point: hit.pa.clone(), distance: hit.d, order, hurtPoint: hit.pb.clone() };
      }
    }
  }
  return best;
}

/**
 * Test every attacker striker capsule against the defender's hurt set.
 * Returns { capsule, hurtBone, point, distance } on the first hit, or null.
 * Picks the deepest intersection across all striker capsules.
 * `scale` shrinks the capsule radii for rigs drawn smaller than life (FFA), so
 * contact still means the visible limb touched the visible body.
 *
 * @param {{t?: number, loose?: boolean}} [o]
 *   t      the sim clock, which lets a fist or foot be swept along its path since the last
 *          tick (leave it out and each test is of where the striker is now)
 *   loose  the older, generous shapes (see the header)
 */
export function testAttackHit(attackerRig, attackName, phase, defenderRig, scale = 1, o = {}) {
  const set = ATTACK_CAPSULES[attackName];
  if (!set) return null;
  const atkSet = o.loose ? set.loose : set;
  const def = o.loose ? LOOSE_HURT_CAPSULES : HURT_CAPSULES;
  const caps = phase === 'recover' ? atkSet.recover : atkSet.active;
  if (!caps) return null;
  const opts = { t: o.t, attack: attackName };
  let best = null;
  for (const [capName, cap] of Object.entries(caps)) {
    const hit = testCapsuleAgainstSet(attackerRig, capName, cap, defenderRig, def, scale, opts);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) {
      best = { ...hit, striker: capName };
    }
  }
  return best;
}

/**
 * Does a guard facing the way `defenderRig` faces cover a strike coming from
 * `fromPos` (world XZ)? Facing includes the spin a hook knocked into the
 * defender, so a fighter twisted off-line can be hit round the guard.
 */
export function guardCovers(defenderRig, fromPos) {
  const fwd = facing(defenderRig, new THREE.Vector3());
  const p = defenderRig.root.position;
  const dx = fromPos.x - p.x, dz = fromPos.z - p.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return true; // overlapping roots: no side to come from
  return (fwd.x * dx + fwd.z * dz) / len >= GUARD_HALF_ARC_COS;
}

/**
 * Striker-vs-striker: do two simultaneous swings' limbs meet? Returns the
 * midpoint of the closest approach (a new Vector3), or null.
 */
export function testAttackClash(rigA, attackA, phaseA, rigB, attackB, phaseB) {
  // Swings meet limb on limb, whatever phase each is in: the `clash` shapes.
  const capsA = ATTACK_CAPSULES[attackA]?.clash;
  const capsB = ATTACK_CAPSULES[attackB]?.clash;
  if (!capsA || !capsB) return null;
  const fwdA = facing(rigA, new THREE.Vector3());
  const fwdB = facing(rigB, new THREE.Vector3());
  for (const ca of Object.values(capsA)) {
    const a = capsuleEndpoints(rigA.joints, ca, fwdA);
    if (!a) continue;
    for (const cb of Object.values(capsB)) {
      const b = capsuleEndpoints(rigB.joints, cb, fwdB);
      if (!b) continue;
      const hit = closestPointsOnSegments(a.a, a.b, b.a, b.b);
      if (hit && hit.d <= ca.radius + cb.radius) return hit.pa.add(hit.pb).multiplyScalar(0.5);
    }
  }
  return null;
}

// ── Region classification ───────────────────────────────────────────────
// Map a hurt-bone name to one of the game's damage regions. Used by the engine
// after a hit is registered.
const HURT_BONE_TO_REGION = {
  head: 'head',
  torso: 'torso',
  belly: 'torso',
  upperArmL: 'arms', upperArmR: 'arms',
  forearmL: 'arms', forearmR: 'arms',
  hipL: 'legs', hipR: 'legs',
  thighL: 'legs', thighR: 'legs',
  shinL: 'legs', shinR: 'legs',
};
export function regionForHurtBone(boneName) {
  return HURT_BONE_TO_REGION[boneName] || 'torso';
}