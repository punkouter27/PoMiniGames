// platform/physics/cannonCompat.js — the cannon-es API, backed by Rapier (platform/physics/rapier.js).
//
// WHY this exists: PoMarbleRace and PoBrawl's rigid-body visuals were written against cannon-es
// (CANNON.Body proxies with .position/.velocity/.quaternion that gameplay code reads AND writes
// every frame: steering, boosts, respawns, speed caps, kinematic rotors). Rewriting that gameplay
// to Rapier handles would change tuned behaviour for no gain, so the proxies stay and this module
// supplies them: Vec3, Quaternion, Body, shapes, materials, hinge / cone-twist constraints and a
// World whose step() pushes game-side changes into Rapier, advances it in fixed steps, and syncs
// poses and velocities back. Only the subset the games use is implemented (add anything you need
// here, not in the games).
//
// Differences from cannon-es the games rely on:
//   * CCD is on for every dynamic body (cannon had none).
//   * Contact materials are pair tables in cannon; Rapier combines per-collider coefficients. The
//     world solves, once per addContactMaterial, the per-material friction/restitution whose
//     AVERAGE (Rapier's default combine rule) reproduces the registered pairs as closely as
//     non-negative coefficients allow (exact for the marble-hub tables used by the marble race).
//   * ConeTwist is a ball joint plus a per-step swing-limit correction (Rapier's JS joints have no
//     spherical limits); good enough for KO ragdolls, which are visuals.
//   * Material.impactTag opts a material into the contact->sound bridge (rapier.js).
import { getRapier, createPhysicsWorld, packGroups } from './rapier.js';

// ── Math ───────────────────────────────────────────────────────────────────────────────────────
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  setZero() { this.x = this.y = this.z = 0; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSquared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  norm() { return this.length(); }
  normalize() { const l = this.length(); if (l > 0) { this.x /= l; this.y /= l; this.z /= l; } return this; }
  scale(s, t = new Vec3()) { t.x = this.x * s; t.y = this.y * s; t.z = this.z * s; return t; }
  vadd(v, t = new Vec3()) { t.x = this.x + v.x; t.y = this.y + v.y; t.z = this.z + v.z; return t; }
  vsub(v, t = new Vec3()) { t.x = this.x - v.x; t.y = this.y - v.y; t.z = this.z - v.z; return t; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v, t = new Vec3()) {
    const x = this.y * v.z - this.z * v.y, y = this.z * v.x - this.x * v.z, z = this.x * v.y - this.y * v.x;
    t.x = x; t.y = y; t.z = z; return t;
  }
  negate(t = new Vec3()) { t.x = -this.x; t.y = -this.y; t.z = -this.z; return t; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, t, target = new Vec3()) {
    target.x = this.x + (v.x - this.x) * t; target.y = this.y + (v.y - this.y) * t; target.z = this.z + (v.z - this.z) * t;
    return target;
  }
  addScaledVector(s, v) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  almostZero(p = 1e-6) { return Math.abs(this.x) <= p && Math.abs(this.y) <= p && Math.abs(this.z) <= p; }
  toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; return a; }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    if (l === 0) { this.x = this.y = this.z = 0; this.w = 1; } else { this.x /= l; this.y /= l; this.z /= l; this.w /= l; }
    return this;
  }
  setFromAxisAngle(axis, angle) {
    const s = Math.sin(angle * 0.5);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(angle * 0.5);
    return this;
  }
  /** this * q -> target (cannon: `a.mult(b, out)`). */
  mult(q, t = new Quaternion()) {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    t.x = ax * bw + aw * bx + ay * bz - az * by;
    t.y = ay * bw + aw * by + az * bx - ax * bz;
    t.z = az * bw + aw * bz + ax * by - ay * bx;
    t.w = aw * bw - ax * bx - ay * by - az * bz;
    return t;
  }
  inverse(t = new Quaternion()) { const l = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w || 1; t.x = -this.x / l; t.y = -this.y / l; t.z = -this.z / l; t.w = this.w / l; return t; }
  vmult(v, t = new Vec3()) {
    const { x, y, z } = v, qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    t.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    t.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    t.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return t;
  }
  toArray(a = [], o = 0) { a[o] = this.x; a[o + 1] = this.y; a[o + 2] = this.z; a[o + 3] = this.w; return a; }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; this.w = a[o + 3]; return this; }
}

// ── Materials, shapes ──────────────────────────────────────────────────────────────────────────
export class Material {
  constructor(opts) {
    const o = typeof opts === 'string' ? { name: opts } : (opts || {});
    this.name = o.name || '';
    this.friction = o.friction ?? -1;
    this.restitution = o.restitution ?? -1;
    /** impactMaterials.js tag: set it and the world plays impact sound for this material's contacts. */
    this.impactTag = o.impactTag || null;
  }
}
export class ContactMaterial {
  constructor(m1, m2, o = {}) {
    this.materials = [m1, m2];
    this.friction = o.friction ?? 0.3;
    this.restitution = o.restitution ?? 0;
  }
}
export class Sphere { constructor(radius) { this.type = 'sphere'; this.radius = radius; } }
export class Box { constructor(halfExtents) { this.type = 'box'; this.halfExtents = halfExtents; } }
export class Cylinder {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, numSegments = 8) {
    this.type = 'cylinder'; this.radiusTop = radiusTop; this.radiusBottom = radiusBottom; this.height = height; this.numSegments = numSegments;
  }
}
/** Infinite plane, normal +Z in the body frame (cannon's convention). */
export class Plane { constructor() { this.type = 'plane'; } }
export class SAPBroadphase { constructor() { this.type = 'sap'; } }

// ── Bodies ─────────────────────────────────────────────────────────────────────────────────────
let _bodyId = 0;
export class Body {
  constructor(o = {}) {
    this.id = _bodyId++;
    this.index = -1;
    this.mass = o.mass ?? 0;
    this.material = o.material || null;
    this.type = o.type ?? (this.mass <= 0 ? Body.STATIC : Body.DYNAMIC);
    this.position = o.position ? new Vec3(o.position.x, o.position.y, o.position.z) : new Vec3();
    this.quaternion = o.quaternion ? new Quaternion(o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w) : new Quaternion();
    this.velocity = o.velocity ? new Vec3(o.velocity.x, o.velocity.y, o.velocity.z) : new Vec3();
    this.angularVelocity = o.angularVelocity ? new Vec3(o.angularVelocity.x, o.angularVelocity.y, o.angularVelocity.z) : new Vec3();
    this.linearDamping = o.linearDamping ?? 0.01;
    this.angularDamping = o.angularDamping ?? 0.01;
    this.collisionFilterGroup = o.collisionFilterGroup ?? 1;
    this.collisionFilterMask = o.collisionFilterMask ?? -1;
    this.userData = o.userData;
    /** Fill world.contacts with this body's live contacts every step (costs a query per body). */
    this.trackContacts = false;
    this.shapes = [];
    this.shapeOffsets = [];
    this.shapeOrientations = [];
    this._listeners = null;
    this._world = null;
    this._rec = null;
    this._collisionResponse = true;
    if (o.shape) this.addShape(o.shape);
  }

  addShape(shape, offset, orientation) {
    this.shapes.push(shape);
    this.shapeOffsets.push(offset || null);
    this.shapeOrientations.push(orientation || null);
    return this;
  }

  get collisionResponse() { return this._collisionResponse; }
  set collisionResponse(v) {
    this._collisionResponse = !!v;
    if (this._rec) for (const c of this._rec.colliders) c.setSensor(!this._collisionResponse);
  }

  get sleepState() { return this._rec && this._rec.rb.isSleeping() ? Body.SLEEPING : Body.AWAKE; }
  wakeUp() { this._rec?.rb.wakeUp(); }
  sleep() { this._rec?.rb.sleep(); }
  updateMassProperties() { /* mass is fixed when the body is added to a world */ }

  /** cannon: impulse (world), relativePoint = offset from the centre of mass (world axes). */
  applyImpulse(impulse, rel) {
    const rb = this._rec?.rb;
    if (!rb) return;
    this._world?._flushBody(this);
    if (rel) {
      const t = rb.translation();
      rb.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, { x: t.x + rel.x, y: t.y + rel.y, z: t.z + rel.z }, true);
    } else rb.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  addEventListener(type, fn) {
    (this._listeners || (this._listeners = {}))[type] = (this._listeners[type] || []).concat(fn);
    // A listener added after the body joined the world still needs the collider to report events.
    if (type === 'collide' && this._world) this._world._enableCollisionEvents(this);
  }
  removeEventListener(type, fn) { if (this._listeners?.[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn); }
  hasEventListener(type) { return !!(this._listeners && this._listeners[type] && this._listeners[type].length); }
  dispatchEvent(ev) { const l = this._listeners?.[ev.type]; if (l) for (const f of l) f.call(this, ev); }
}
Body.DYNAMIC = 1; Body.STATIC = 2; Body.KINEMATIC = 4;
Body.AWAKE = 0; Body.SLEEPY = 1; Body.SLEEPING = 2;

// ── Constraints ────────────────────────────────────────────────────────────────────────────────
export class HingeConstraint {
  constructor(bodyA, bodyB, o = {}) {
    this.bodyA = bodyA; this.bodyB = bodyB;
    this.pivotA = o.pivotA ? o.pivotA.clone() : new Vec3();
    this.pivotB = o.pivotB ? o.pivotB.clone() : new Vec3();
    this.axisA = o.axisA ? o.axisA.clone() : new Vec3(1, 0, 0);
    this.axisB = o.axisB ? o.axisB.clone() : new Vec3(1, 0, 0);
    this.collideConnected = o.collideConnected ?? true;
    this.motorEnabled = false;
    this.motorTargetVelocity = 0;
    this.motorMaxForce = o.maxForce ?? 1e6;
    this._h = null;
  }
  enableMotor() { this.motorEnabled = true; this._apply(); }
  disableMotor() { this.motorEnabled = false; this._m = null; this._h?.joint.configureMotorVelocity(0, 0); }
  setMotorSpeed(s) { this.motorTargetVelocity = s; this._apply(); }
  setMotorMaxForce(f) { this.motorMaxForce = f; this._apply(); }
  _apply() {
    if (!this._h || !this.motorEnabled) return;
    // Games re-assert the motor every frame; only touch Rapier when something changed.
    if (this._m && this._m[0] === this.motorTargetVelocity && this._m[1] === this.motorMaxForce) return;
    this._m = [this.motorTargetVelocity, this.motorMaxForce];
    this._h.setMotor(this.motorTargetVelocity, this.motorMaxForce);
  }
}
export class ConeTwistConstraint {
  constructor(bodyA, bodyB, o = {}) {
    this.bodyA = bodyA; this.bodyB = bodyB;
    this.pivotA = o.pivotA ? o.pivotA.clone() : new Vec3();
    this.pivotB = o.pivotB ? o.pivotB.clone() : new Vec3();
    this.axisA = o.axisA ? o.axisA.clone() : new Vec3(1, 0, 0);
    this.axisB = o.axisB ? o.axisB.clone() : new Vec3(1, 0, 0);
    this.angle = o.angle ?? 0;
    this.twistAngle = o.twistAngle ?? 0;
    this.collideConnected = o.collideConnected ?? true;
    this._h = null;
  }
}

// ── Contact-material solve ─────────────────────────────────────────────────────────────────────
// Find per-material coefficients v with (v_i + v_j)/2 == target for each registered pair, v >= 0.
// Projected Gauss-Seidel; exact when the table is "one hub material vs everything" (marble race).
function solveCoefficients(mats, pairs, key, fallback) {
  const v = new Map();
  for (const m of mats) v.set(m, m[key] >= 0 ? m[key] : fallback);
  if (!pairs.length) return v;
  for (let it = 0; it < 60; it++) {
    for (const m of mats) {
      let num = 0, n = 0;
      for (const p of pairs) {
        const [a, b] = p.materials;
        if (a === m && b === m) { num += p[key]; n++; } else if (a === m) { num += 2 * p[key] - v.get(b); n++; } else if (b === m) { num += 2 * p[key] - v.get(a); n++; }
      }
      if (n) v.set(m, Math.max(0, num / n));
    }
  }
  return v;
}

// ── World ──────────────────────────────────────────────────────────────────────────────────────
export class World {
  /**
   * @param {object} [o] { gravity:Vec3, fixedDt, impact (rapier.js bridge options|false), unitScale }
   */
  constructor(o = {}) {
    const R = getRapier();
    // No Rapier (CDN unreachable and not cached): a null world. Bodies exist and hold still, step()
    // does nothing - visuals-only users (brawl props) degrade to a static set, nothing throws.
    this._null = !R;
    if (!R) console.warn('[PoPhysics] Rapier not loaded - physics world is inert');
    const g = o.gravity || new Vec3(0, -9.82, 0);
    this.gravity = g;
    this.bodies = [];
    this.constraints = [];
    this.contacts = [];
    this.contactMaterials = [];
    this.defaultContactMaterial = { friction: 0.3, restitution: 0 };
    this.allowSleep = false;
    this.stepnumber = 0;
    this.engineName = 'rapier-wasm';
    this.broadphase = null;
    this._solverIterations = 0;
    const world = this;
    this.solver = {
      get iterations() { return world._solverIterations; },
      set iterations(n) { world._solverIterations = n; if (world._pw) world._pw.raw.integrationParameters.numSolverIterations = Math.max(4, Math.min(12, Math.ceil(n / 3))); },
      tolerance: 0.001,
    };
    this._pw = !R ? null : createPhysicsWorld(R, {
      gravity: -g.y, fixedDt: o.fixedDt ?? 1 / 60, maxSubsteps: 8, ccd: true,
      unitScale: o.unitScale ?? 1, impact: o.impact ?? {},
    });
    this._R = R;
    this._coef = null;
    this._joints = [];
    this._tracked = [];
    this._cones = [];
    this._byCollider = new Map();   // collider handle -> Body
    this._offStart = !R ? null : this._pw.onCollisionStart((c1, c2, h1, h2) => this._onStart(h1, h2));
  }

  addContactMaterial(cm) { this.contactMaterials.push(cm); this._coef = null; this._refreshColliders(); }

  _coefficients() {
    if (this._coef) return this._coef;
    const mats = new Set();
    for (const cm of this.contactMaterials) { mats.add(cm.materials[0]); mats.add(cm.materials[1]); }
    this._coef = {
      friction: solveCoefficients(mats, this.contactMaterials, 'friction', this.defaultContactMaterial.friction),
      restitution: solveCoefficients(mats, this.contactMaterials, 'restitution', this.defaultContactMaterial.restitution),
    };
    return this._coef;
  }
  _matFriction(m) { const c = this._coefficients().friction; return m && c.has(m) ? c.get(m) : (m && m.friction >= 0 ? m.friction : this.defaultContactMaterial.friction); }
  _matRestitution(m) { const c = this._coefficients().restitution; return m && c.has(m) ? c.get(m) : (m && m.restitution >= 0 ? m.restitution : this.defaultContactMaterial.restitution); }
  _refreshColliders() {
    for (const b of this.bodies) {
      if (!b._rec) continue;
      const f = this._matFriction(b.material), r = this._matRestitution(b.material);
      for (const c of b._rec.colliders) { c.setFriction(f); c.setRestitution(r); }
    }
  }

  _shapeDesc(b, i, isDyn) {
    const s = b.shapes[i];
    const off = b.shapeOffsets[i], rot = b.shapeOrientations[i];
    const d = {
      friction: this._matFriction(b.material), restitution: this._matRestitution(b.material),
      group: b.collisionFilterGroup, mask: b.collisionFilterMask,
      offset: off ? { x: off.x, y: off.y, z: off.z } : undefined,
      rotation: rot ? { x: rot.x, y: rot.y, z: rot.z, w: rot.w } : undefined,
      tag: b.material?.impactTag || null,
      collisionEvents: b.hasEventListener('collide'),
      sensor: !b._collisionResponse,
    };
    if (isDyn && b.mass > 0) d.mass = b.mass / Math.max(1, b.shapes.length);
    if (s.type === 'sphere') { d.kind = 'ball'; d.radius = s.radius; } else if (s.type === 'box') { d.kind = 'cuboid'; d.hx = s.halfExtents.x; d.hy = s.halfExtents.y; d.hz = s.halfExtents.z; } else if (s.type === 'cylinder') { d.kind = 'cylinder'; d.halfHeight = s.height / 2; d.radius = s.radiusTop; } else if (s.type === 'plane') {
      // A big slab whose top face is the plane: normal +Z locally, so it hangs off -Z.
      d.kind = 'cuboid'; d.hx = 500; d.hy = 500; d.hz = 0.5;
      const o = off || { x: 0, y: 0, z: 0 };
      d.offset = { x: o.x, y: o.y, z: o.z - 0.5 };
    } else return null;
    return d;
  }

  addBody(b) {
    if (b._rec || b._world === this) return;
    if (this._null) { b._world = this; b.index = this.bodies.length; this.bodies.push(b); return; }
    const type = b.type === Body.KINEMATIC ? 'kinematic' : (b.type === Body.STATIC || b.mass <= 0) ? 'fixed' : 'dynamic';
    const shapes = [];
    for (let i = 0; i < b.shapes.length; i++) { const d = this._shapeDesc(b, i, type === 'dynamic'); if (d) shapes.push(d); }
    const rec = this._pw.addBody({
      type, position: b.position, rotation: b.quaternion, linvel: b.velocity, angvel: b.angularVelocity,
      linearDamping: b.linearDamping, angularDamping: b.angularDamping, canSleep: this.allowSleep, userData: b.userData, shapes,
    });
    b._rec = rec; b._world = this; b.index = this.bodies.length;
    b._sp = [b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
    b._sv = [b.velocity.x, b.velocity.y, b.velocity.z, b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z];
    this.bodies.push(b);
    for (const c of rec.colliders) this._byCollider.set(c.handle, b);
    if (b.trackContacts) this._tracked.push(b);
  }

  removeBody(b) {
    if (this._null) { const i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1); b._world = null; return; }
    if (!b._rec) return;
    for (const c of b._rec.colliders) this._byCollider.delete(c.handle);
    this._pw.removeBody(b._rec);
    b._rec = null; b._world = null;
    const i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1);
    const t = this._tracked.indexOf(b); if (t >= 0) this._tracked.splice(t, 1);
    for (const c of this.constraints.filter((k) => k.bodyA === b || k.bodyB === b)) this._dropConstraint(c);
  }

  addConstraint(c) {
    const a = c.bodyA?._rec, b = c.bodyB?._rec;
    if (!a || !b) return;
    this.constraints.push(c);
    if (c instanceof HingeConstraint) {
      const jd = this._R.JointData.revoluteWithAxes
        ? this._R.JointData.revoluteWithAxes(c.pivotA, c.pivotB, c.axisA, c.axisB)
        : this._R.JointData.revolute(c.pivotA, c.pivotB, c.axisA);
      const joint = this._pw.raw.createImpulseJoint(jd, a.rb, b.rb, true);
      joint.setContactsEnabled(c.collideConnected);
      c._h = {
        joint, setMotor: (speed, maxForce) => {
          joint.configureMotorVelocity(speed, 12.0);
          if (typeof joint.configureMotorMaxForce === 'function') joint.configureMotorMaxForce(maxForce);
        },
      };
      c._apply();
    } else {
      const jd = this._R.JointData.spherical(c.pivotA, c.pivotB);
      const joint = this._pw.raw.createImpulseJoint(jd, a.rb, b.rb, true);
      joint.setContactsEnabled(c.collideConnected);
      c._h = { joint };
      this._cones.push(c);
    }
  }

  removeConstraint(c) { this._dropConstraint(c); }
  _dropConstraint(c) {
    const i = this.constraints.indexOf(c); if (i < 0) return;
    this.constraints.splice(i, 1);
    const k = this._cones.indexOf(c); if (k >= 0) this._cones.splice(k, 1);
    if (c._h) { try { this._pw.raw.removeImpulseJoint(c._h.joint, true); } catch { /* removed with its body */ } c._h = null; }
  }

  _enableCollisionEvents(b) {
    if (!b._rec) return;
    for (const c of b._rec.colliders) c.setActiveEvents(c.activeEvents() | this._R.ActiveEvents.COLLISION_EVENTS);
  }

  _onStart(h1, h2) {
    const b1 = this._byCollider.get(h1), b2 = this._byCollider.get(h2);
    if (!b1 || !b2) return;
    this.contacts.push({ bi: b1, bj: b2 });
    const l1 = b1.hasEventListener('collide'), l2 = b2.hasEventListener('collide');
    if (!l1 && !l2) return;
    // Pre-step velocities (what the body had when it hit), not the post-response ones.
    const v1 = b1._sv || [0, 0, 0], v2 = b2._sv || [0, 0, 0];
    const speed = Math.hypot(v1[0] - v2[0], v1[1] - v2[1], v1[2] - v2[2]);
    const contact = { getImpactVelocityAlongNormal: () => speed, bi: b1, bj: b2 };
    if (l1) b1.dispatchEvent({ type: 'collide', body: b2, contact });
    if (l2) b2.dispatchEvent({ type: 'collide', body: b1, contact });
  }

  /** Push a body's game-side edits (position/velocity writes) into Rapier. */
  _flushBody(b, first = true) {
    const rb = b._rec.rb, p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity, sp = b._sp, sv = b._sv;
    if (b.type === Body.KINEMATIC) {
      if (first && (p.x !== sp[0] || p.y !== sp[1] || p.z !== sp[2])) {
        // Drive by velocity so dynamic bodies are SHOVED, not teleported through.
        const t = rb.translation(), inv = 1 / this._pw.fixedDt;
        rb.setLinvel({ x: (p.x - t.x) * inv, y: (p.y - t.y) * inv, z: (p.z - t.z) * inv }, true);
      } else if (!first || (v.x === 0 && v.y === 0 && v.z === 0)) rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      if (w.x !== sv[3] || w.y !== sv[4] || w.z !== sv[5]) rb.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
      return;
    }
    if (p.x !== sp[0] || p.y !== sp[1] || p.z !== sp[2]) rb.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    if (q.x !== sp[3] || q.y !== sp[4] || q.z !== sp[5] || q.w !== sp[6]) rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    if (v.x !== sv[0] || v.y !== sv[1] || v.z !== sv[2]) rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    if (w.x !== sv[3] || w.y !== sv[4] || w.z !== sv[5]) rb.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    sp[0] = p.x; sp[1] = p.y; sp[2] = p.z; sp[3] = q.x; sp[4] = q.y; sp[5] = q.z; sp[6] = q.w;
    sv[0] = v.x; sv[1] = v.y; sv[2] = v.z; sv[3] = w.x; sv[4] = w.y; sv[5] = w.z;
  }

  _syncBack(b) {
    const rb = b._rec.rb, sp = b._sp, sv = b._sv;
    const t = rb.translation(), r = rb.rotation(), lv = rb.linvel(), av = rb.angvel();
    b.position.set(t.x, t.y, t.z); b.quaternion.set(r.x, r.y, r.z, r.w);
    sp[0] = t.x; sp[1] = t.y; sp[2] = t.z; sp[3] = r.x; sp[4] = r.y; sp[5] = r.z; sp[6] = r.w;
    if (b.type !== Body.KINEMATIC) {
      b.velocity.set(lv.x, lv.y, lv.z); sv[0] = lv.x; sv[1] = lv.y; sv[2] = lv.z;
    } else { sv[0] = b.velocity.x; sv[1] = b.velocity.y; sv[2] = b.velocity.z; }
    b.angularVelocity.set(av.x, av.y, av.z); sv[3] = av.x; sv[4] = av.y; sv[5] = av.z;
  }

  // Swing limit for cone-twist joints: when the two axes diverge past `angle`, damp the relative
  // spin about the swing axis and nudge it back. Mass-agnostic (acts on angular velocities).
  _limitCones() {
    for (const c of this._cones) {
      const ra = c.bodyA._rec?.rb, rb = c.bodyB._rec?.rb;
      if (!ra || !rb) continue;
      const qa = ra.rotation(), qb = rb.rotation();
      const aw = _rot(qa, c.axisA, _t1), bw = _rot(qb, c.axisB, _t2);
      const dot = Math.max(-1, Math.min(1, aw.x * bw.x + aw.y * bw.y + aw.z * bw.z));
      const ang = Math.acos(dot);
      const excess = ang - c.angle;
      if (excess <= 0) continue;
      let nx = aw.y * bw.z - aw.z * bw.y, ny = aw.z * bw.x - aw.x * bw.z, nz = aw.x * bw.y - aw.y * bw.x;
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-6) continue;
      nx /= nl; ny /= nl; nz /= nl;
      const wa = ra.angvel(), wb = rb.angvel();
      const rel = (wb.x - wa.x) * nx + (wb.y - wa.y) * ny + (wb.z - wa.z) * nz;   // spin opening the cone
      const fix = Math.max(0, rel) + excess * 18;
      // Bodies of the limb pair share the correction (the lighter one moves more).
      const ma = Math.max(ra.mass(), 1e-3), mb = Math.max(rb.mass(), 1e-3), tot = ma + mb;
      const sa = mb / tot, sb = ma / tot;
      if (ra.isDynamic()) ra.setAngvel({ x: wa.x + nx * fix * sa, y: wa.y + ny * fix * sa, z: wa.z + nz * fix * sa }, true);
      if (rb.isDynamic()) rb.setAngvel({ x: wb.x - nx * fix * sb, y: wb.y - ny * fix * sb, z: wb.z - nz * fix * sb }, true);
    }
  }

  /** cannon signature: step(fixedDt, dt, maxSubsteps). Returns nothing; read stepnumber. */
  step(fixedDt, dt = fixedDt, maxSubsteps = 10) {
    const pw = this._pw;
    if (!pw) return 0;
    if (pw.fixedDt !== fixedDt) pw.setFixedDt(fixedDt);
    pw.maxSubsteps = maxSubsteps;
    this.contacts.length = 0;
    const bodies = this.bodies;
    const n = pw.step(dt, (i) => {
      if (i === 0) for (let k = 0; k < bodies.length; k++) { const b = bodies[k]; if (b.type !== Body.STATIC) this._flushBody(b, true); }
      else for (let k = 0; k < bodies.length; k++) { const b = bodies[k]; if (b.type === Body.KINEMATIC) this._flushBody(b, false); }
      if (this._cones.length) this._limitCones();
    });
    this.stepnumber += n;
    if (n) {
      for (let k = 0; k < bodies.length; k++) { const b = bodies[k]; if (b.type !== Body.STATIC) this._syncBack(b); }
      // Persistent contacts for bodies that asked (grounded marbles read this).
      for (const b of this._tracked) {
        const col = b._rec.colliders[0]; if (!col) continue;
        this._pw.raw.contactPairsWith(col, (oc) => {
          const o = this._byCollider.get(oc.handle);
          if (o && o !== b) this.contacts.push({ bi: b, bj: o });
        });
      }
    }
    return n;
  }

  free() { this._offStart?.(); this._pw?.free(); this.bodies.length = 0; this.constraints.length = 0; }
}

const _t1 = { x: 0, y: 0, z: 0 }, _t2 = { x: 0, y: 0, z: 0 };
function _rot(q, v, t) {
  const { x, y, z } = v, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  t.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  t.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  t.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return t;
}

export { packGroups };
