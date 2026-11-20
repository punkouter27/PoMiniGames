// ragdoll.js — primitive-box ragdolls (plan decision 7). Quadruped: torso, head, four
// legs; biped: pelvis, chest, head, two arms, two legs. Parts spawn from the creature's
// standing pose (the renderer's animation is cosmetic, so there is no pop), joined by
// ConeTwistConstraints whose zero is the spawn pose — the same pivot construction as
// pobrawl/ragdollPhysics.js. `sizeIndex` picks the render box from PROP_SIZES.
import { PROP_KIND, propOwner } from '../core/config.js';
import { SPECIES_ID } from '../creatures/species.js';

// offset = part centre relative to the creature origin (ground under it), forward = +Z.
export const RIGS = Object.freeze({
  quadruped: Object.freeze({
    parts: Object.freeze([
      { name: 'torso', size: [0.5, 0.3, 0.8], offset: [0, 0.55, 0], sizeIndex: 0, mass: 3 },
      { name: 'head', size: [0.3, 0.3, 0.3], offset: [0, 0.75, 0.55], sizeIndex: 1, mass: 1 },
      { name: 'legFL', size: [0.12, 0.4, 0.12], offset: [-0.18, 0.2, 0.3], sizeIndex: 2, mass: 0.5 },
      { name: 'legFR', size: [0.12, 0.4, 0.12], offset: [0.18, 0.2, 0.3], sizeIndex: 2, mass: 0.5 },
      { name: 'legBL', size: [0.12, 0.4, 0.12], offset: [-0.18, 0.2, -0.3], sizeIndex: 2, mass: 0.5 },
      { name: 'legBR', size: [0.12, 0.4, 0.12], offset: [0.18, 0.2, -0.3], sizeIndex: 2, mass: 0.5 },
    ]),
    // [child, parent, joint point relative to origin, cone, twist]
    links: Object.freeze([
      ['head', 'torso', [0, 0.7, 0.4], 0.8, 0.5],
      ['legFL', 'torso', [-0.18, 0.4, 0.3], 0.9, 0.3],
      ['legFR', 'torso', [0.18, 0.4, 0.3], 0.9, 0.3],
      ['legBL', 'torso', [-0.18, 0.4, -0.3], 0.9, 0.3],
      ['legBR', 'torso', [0.18, 0.4, -0.3], 0.9, 0.3],
    ]),
  }),
  biped: Object.freeze({
    parts: Object.freeze([
      { name: 'pelvis', size: [0.36, 0.24, 0.26], offset: [0, 1.0, 0], sizeIndex: 1, mass: 3 },
      { name: 'chest', size: [0.4, 0.5, 0.28], offset: [0, 1.4, 0], sizeIndex: 4, mass: 4 },
      { name: 'head', size: [0.26, 0.26, 0.26], offset: [0, 1.85, 0], sizeIndex: 1, mass: 1.2 },
      { name: 'armL', size: [0.12, 0.6, 0.12], offset: [-0.3, 1.35, 0], sizeIndex: 2, mass: 0.8 },
      { name: 'armR', size: [0.12, 0.6, 0.12], offset: [0.3, 1.35, 0], sizeIndex: 2, mass: 0.8 },
      { name: 'legL', size: [0.14, 0.9, 0.14], offset: [-0.12, 0.45, 0], sizeIndex: 2, mass: 1.5 },
      { name: 'legR', size: [0.14, 0.9, 0.14], offset: [0.12, 0.45, 0], sizeIndex: 2, mass: 1.5 },
    ]),
    links: Object.freeze([
      ['chest', 'pelvis', [0, 1.15, 0], 0.5, 0.4],
      ['head', 'chest', [0, 1.7, 0], 0.8, 0.8],
      ['armL', 'chest', [-0.3, 1.62, 0], 1.2, 0.5],
      ['armR', 'chest', [0.3, 1.62, 0], 1.2, 0.5],
      ['legL', 'pelvis', [-0.12, 0.9, 0], 1.0, 0.4],
      ['legR', 'pelvis', [0.12, 0.9, 0], 1.0, 0.4],
    ]),
  }),
});

// Species → rig and a uniform body scale (rabbits are small quadrupeds, deer large).
const SPECIES_RIG = Object.freeze({
  [SPECIES_ID.RABBIT]: { rig: 'quadruped', scale: 0.5 },
  [SPECIES_ID.DEER]: { rig: 'quadruped', scale: 1.25 },
  [SPECIES_ID.WOLF]: { rig: 'quadruped', scale: 1.0 },
  [SPECIES_ID.HUMAN]: { rig: 'biped', scale: 1.0 },
});
export const rigFor = (species) => SPECIES_RIG[species] ?? SPECIES_RIG[SPECIES_ID.WOLF];

const rotY = (x, z, yaw) => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
const propKind = (sizeIndex) => PROP_KIND.ragdollPart * 8 + sizeIndex;

// How a body lies. A carcass rolled onto its side as one rigid piece has four legs sticking
// straight out like a toy tipped over; a real one goes slack. Each part takes this extra
// turn about the joint that holds it to the body ([x, y, z] radians in the creature's own
// frame, before the roll): the legs fold fore and aft, the ones on the upper side sag toward
// the ground, and the head comes down to rest. After the roll the rig's +x is uppermost, so
// the FR / BR legs and the right arm and leg are the upper ones.
const REST = Object.freeze({
  quadruped: Object.freeze({
    head: [0.3, -0.6, 0], legFL: [-0.6, 0, 0], legFR: [-0.25, 0, -0.55], legBL: [0.5, 0, 0], legBR: [0.15, 0, -0.55],
  }),
  biped: Object.freeze({
    chest: [0.14, 0, 0], head: [0.25, -0.3, -0.2], armL: [-0.9, 0, 0.35], armR: [-0.4, 0, -0.5], legL: [-0.6, 0, 0], legR: [-0.2, 0, -0.35],
  }),
});
// How far the rig's centre line lies over the ground, in rig units: half the torso's width,
// or for a person a little less than the shoulder's.
const REST_LIFT = Object.freeze({ quadruped: 0.3, biped: 0.27 });

const quatOf = ([x, y, z]) => mulQuat([0, Math.sin(y / 2), 0, Math.cos(y / 2)], mulQuat([Math.sin(x / 2), 0, 0, Math.cos(x / 2)], [0, 0, Math.sin(z / 2), Math.cos(z / 2)]));
/** v turned by the unit quaternion q. */
function turn(q, v) {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0]; const cy = z * v[0] - x * v[2] + w * v[1]; const cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}

/** World-space poses for a creature lying on its side, gone slack: static carcasses and snapshots. */
export function lyingPose(species, x, y, z, yaw, scale = 1) {
  const { rig, scale: rs } = rigFor(species);
  const s = rs * scale;
  const half = Math.PI / 2;
  // A 90° roll about the creature's forward axis, composed with the yaw.
  const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const qr = [0, 0, Math.sin(half / 2), Math.cos(half / 2)];
  const q = mulQuat(qy, qr);
  const def = RIGS[rig];
  return def.parts.map((p, k) => {
    // The part's own slackening, about the joint that ties it to its parent.
    const rest = REST[rig][p.name];
    const joint = def.links.find((l) => l[0] === p.name)?.[2];
    let c = p.offset; let qp = q;
    if (rest && joint) {
      const local = quatOf(rest);
      const arm = turn(local, [p.offset[0] - joint[0], p.offset[1] - joint[1], p.offset[2] - joint[2]]);
      c = [joint[0] + arm[0], joint[1] + arm[1], joint[2] + arm[2]];
      qp = mulQuat(q, local);
    }
    // Rolled onto its side: height becomes a lateral spread and the sideways offset a height,
    // so the near legs lie over the far ones.
    const lx = -c[1] * s; const ly = Math.max(0.04, REST_LIFT[rig] + c[0]) * s; const lz = c[2] * s;
    const [wx, wz] = rotY(lx, lz, yaw);
    return { x: x + wx, y: y + ly, z: z + wz, qx: qp[0], qy: qp[1], qz: qp[2], qw: qp[3], propKind: propKind(p.sizeIndex), owner: propOwner(species, k, scale) };
  });
}

function mulQuat(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * Build the jointed rigid bodies for a creature at (x, y, z, yaw). `launch` is a world
 * velocity applied to every part (the death impulse); the cosmetic rng adds spin.
 */
export function buildRagdoll(CANNON, world, material, filter, info, rng, launch = { x: 0, y: 0, z: 0 }, physicsCfg) {
  const { rig, scale: rs } = rigFor(info.species);
  const s = rs * (info.scale || 1);
  const def = RIGS[rig];
  const bodies = new Map();
  const parts = [];
  for (const [k, p] of def.parts.entries()) {
    const [ox, oz] = rotY(p.offset[0] * s, p.offset[2] * s, info.yaw);
    const body = new CANNON.Body({
      mass: p.mass * s, material,
      shape: new CANNON.Box(new CANNON.Vec3(p.size[0] * s / 2, p.size[1] * s / 2, p.size[2] * s / 2)),
      collisionFilterGroup: filter.group, collisionFilterMask: filter.mask,
      linearDamping: physicsCfg.linearDamping, angularDamping: physicsCfg.angularDamping,
      allowSleep: true, sleepSpeedLimit: physicsCfg.sleepSpeedLimit, sleepTimeLimit: physicsCfg.sleepTimeLimit,
    });
    body.position.set(info.x + ox, info.y + p.offset[1] * s, info.z + oz);
    body.quaternion.setFromEuler(0, info.yaw, 0);
    body.velocity.set(launch.x + (rng.next() - 0.5) * 0.6, launch.y + (rng.next() - 0.5) * 0.6, launch.z + (rng.next() - 0.5) * 0.6);
    body.angularVelocity.set((rng.next() - 0.5) * 2, (rng.next() - 0.5) * 2, (rng.next() - 0.5) * 2);
    world.addBody(body);
    bodies.set(p.name, body);
    parts.push({ body, kind: PROP_KIND.ragdollPart, sizeIndex: p.sizeIndex, owner: propOwner(info.species, k, info.scale) });
  }
  const constraints = [];
  for (const [childName, parentName, joint, cone, twist] of def.links) {
    const child = bodies.get(childName); const parent = bodies.get(parentName);
    const [jx, jz] = rotY(joint[0] * s, joint[2] * s, info.yaw);
    const jw = new CANNON.Vec3(info.x + jx, info.y + joint[1] * s, info.z + jz);
    // Pivots are the joint in each body's local frame (bodies share the yaw rotation).
    const pivotA = child.pointToLocalFrame(jw);
    const pivotB = parent.pointToLocalFrame(jw);
    const axis = new CANNON.Vec3(0, 1, 0);
    const c = new CANNON.ConeTwistConstraint(child, parent, {
      pivotA, pivotB, axisA: axis, axisB: axis, angle: cone, twistAngle: twist, collideConnected: false, maxForce: 1e6,
    });
    world.addConstraint(c);
    constraints.push(c);
  }
  return { parts, constraints, born: 0, settled: false };
}

/** Freeze a ragdoll in place: drop the joints, make every part static. */
export function freezeRagdoll(CANNON, world, rag) {
  for (const c of rag.constraints) world.removeConstraint(c);
  rag.constraints = [];
  for (const { body } of rag.parts) {
    body.velocity.set(0, 0, 0); body.angularVelocity.set(0, 0, 0);
    body.mass = 0; body.type = CANNON.Body.STATIC; body.updateMassProperties();
  }
  rag.settled = true;
}

export const ragdollAsleep = (CANNON, rag) => rag.parts.every(({ body }) => body.sleepState === CANNON.Body.SLEEPING);
