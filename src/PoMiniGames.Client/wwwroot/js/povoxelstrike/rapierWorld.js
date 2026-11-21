// rapierWorld.js — PoVoxelStrike's physics world, on Rapier (@dimforge/rapier3d-compat 0.21).
//
// WHY A FACADE. cannon-es used to be threaded through six modules (debris, shrapnel, structure,
// terrain, game, physics) as raw `body.position.x`, `body.velocity.set(...)`, `body.quaternion`,
// `body.type = STATIC`, `body.addEventListener('collide')`. Those call sites are the game's rules
// (frozen rubble is solid scenery, the crush check reads velocity x mass, the player is
// driven by writing velocity). Rewriting each into Rapier handle calls would have changed
// gameplay by accident, so this file keeps the *shape* of that API and swaps the engine
// underneath. A body is a plain JS object holding a CACHE of position / quaternion /
// velocity / angular velocity; reads are free (no WASM call), writes are write-through
// (flagged dirty, pushed to Rapier at the top of the next step). After every step the cache
// of each awake dynamic body is pulled back. One batched push + one batched pull per step
// is far cheaper than hundreds of per-field WASM calls from game code.
//
// WHAT RAPIER GIVES THAT CANNON DID NOT
//   * CCD. Shrapnel (a 0.25 m chip at up to ~60 m/s) is the classic tunnelling body; those
//     bodies are created with continuous collision detection. The swept-ray `sweep()` in
//     shrapnel.js stays because it tests the VOXEL GRID (which is what carves), but the
//     solver no longer relies on it to keep chips out of the ground.
//   * Real contact-force events. Every collider that can hit hard asks for
//     CONTACT_FORCE_EVENTS with a threshold of "force of a ~1.5 m/s impact", so resting
//     piles (m*g) never fire and the event queue stays empty most steps. The step then turns
//     the flagged bodies' velocity change into an impact speed, and `onImpact` (set by the
//     engine) hands it to debris fragmentation, the existing modal audio, impactSynth and
//     PoImpact. cannon's `collide` event is kept for the call sites as `body.onCollide`.
//   * A solver without the 1e8 stiffness tuning cannon needed: real masses (37 kg voxels
//     to tonne towers) just work with a handful of iterations.
//
// MATERIALS. cannon had a per-PAIR contact table. Rapier combines per collider. The table in
// physics.js was chosen to be reproducible with an AVERAGE rule on per-surface values
// (stone 0.75, wood 0.45, dirt 0.95 friction; stone .04, wood .2, dirt 0 restitution gives
// stone/dirt 0.85/.02, wood/dirt .70/.10, stone/wood .60/.12: within 0.05 of the old
// table), and the player collider uses the MIN rule, whose priority beats AVERAGE, so its
// zero friction wins against everything exactly as before.
//
// Terrain: a Rapier heightfield cannot be edited in place, so a dig replaces the collider.
// terrain.js throttles those rebuilds.

let _R = null;
let _loading = null;

/** Load + init the WASM once. Rejects if the module cannot load (offline, blocked). */
export function loadRapier() {
  if (_R) return Promise.resolve(_R);
  _loading ??= import('rapier').then(async (m) => {
    const R = m.default || m;
    await R.init();
    _R = R;
    return R;
  });
  return _loading;
}

export const TYPE = Object.freeze({ DYNAMIC: 1, STATIC: 2 });
export const WORLD_GROUP = 1;
export const PLAYER_GROUP = 2;

// Per-surface contact values (see MATERIALS above).
const SURFACE = {
  stone: { friction: 0.75, restitution: 0.04 },
  wood: { friction: 0.45, restitution: 0.2 },
  dirt: { friction: 0.95, restitution: 0.0 },
  player: { friction: 0.0, restitution: 0.0 },
};

// Smallest impact speed (m/s) that raises a contact-force event. Matches shrapnel's onHit gate.
const EVENT_MIN_SPEED = 1.5;

/** x/y/z that flags its owner when written, so game code can keep `v.y = JUMP_SPEED`. */
class Vec {
  constructor(owner, flag) {
    this._x = 0; this._y = 0; this._z = 0;
    this._owner = owner; this._flag = flag;
  }
  get x() { return this._x; }
  get y() { return this._y; }
  get z() { return this._z; }
  set x(v) { if (v !== this._x) { this._x = v; this._owner[this._flag] = true; } }
  set y(v) { if (v !== this._y) { this._y = v; this._owner[this._flag] = true; } }
  set z(v) { if (v !== this._z) { this._z = v; this._owner[this._flag] = true; } }
  set(x, y, z) { this._x = x; this._y = y; this._z = z; this._owner[this._flag] = true; return this; }
  setZero() { return this.set(0, 0, 0); }
  length() { return Math.sqrt(this._x * this._x + this._y * this._y + this._z * this._z); }
  /** Pull from the engine without raising the dirty flag. */
  _load(x, y, z) { this._x = x; this._y = y; this._z = z; }
}

class Quat {
  constructor(owner) { this._x = 0; this._y = 0; this._z = 0; this._w = 1; this._owner = owner; }
  get x() { return this._x; }
  get y() { return this._y; }
  get z() { return this._z; }
  get w() { return this._w; }
  set(x, y, z, w) { this._x = x; this._y = y; this._z = z; this._w = w; this._owner._dirtyRot = true; return this; }
  copy(q) { return this.set(q.x, q.y, q.z, q.w); }
  setFromEuler(ex, ey, ez) {
    // XYZ order, as THREE and cannon do; only yaw-only and the -90 deg X of the terrain are used.
    const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2);
    const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2);
    return this.set(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3);
  }
  _load(x, y, z, w) { this._x = x; this._y = y; this._z = z; this._w = w; }
}

/** A rigid body with a cannon-shaped surface; becomes real when added to a PhysWorld. */
export class PhysBody {
  /**
   * @param {object} o type (TYPE.*), mass, material ('stone'|'wood'|'dirt'|'player'),
   *   linearDamping, angularDamping, allowSleep, ccd, fixedRotation, group, mask,
   *   position {x,y,z}, velocity {x,y,z}
   */
  constructor(o = {}) {
    this.type = o.type ?? TYPE.DYNAMIC;
    this.mass = o.mass ?? 0;
    this.material = o.material ?? 'stone';
    this.linearDamping = o.linearDamping ?? 0.01;
    this.angularDamping = o.angularDamping ?? 0.01;
    this.allowSleep = o.allowSleep !== false;
    this.ccd = !!o.ccd;
    this.fixedRotation = !!o.fixedRotation;
    this.group = o.group ?? WORLD_GROUP;
    this.mask = o.mask ?? 0xffff;
    this.position = new Vec(this, '_dirtyPos');
    this.velocity = new Vec(this, '_dirtyVel');
    this.angularVelocity = new Vec(this, '_dirtyAng');
    this.quaternion = new Quat(this);
    if (o.position) this.position._load(o.position.x, o.position.y, o.position.z);
    if (o.velocity) this.velocity._load(o.velocity.x, o.velocity.y, o.velocity.z);
    this._dirtyPos = this._dirtyVel = this._dirtyAng = this._dirtyRot = false;
    this.shapes = [];            // { kind:'box', hx,hy,hz, ox,oy,oz } | { kind:'ball', r }
    this.onCollide = null;       // (speed, otherBody|null) => void — cannon's 'collide'
    this.eventSpeed = EVENT_MIN_SPEED;
    this.userData = null;
    this.rb = null;
    this.world = null;
    this._pendingImpulse = null;
    this._sleeping = false;
    this._impactSpeed = 0;
  }

  get isSleeping() { return this._sleeping; }

  addBox(hx, hy, hz, ox = 0, oy = 0, oz = 0) {
    this.shapes.push({ kind: 'box', hx, hy, hz, ox, oy, oz });
  }
  addBall(r) { this.shapes.push({ kind: 'ball', r }); }

  /** Resize a single-box body (shrapnel chips are pooled and reshaped per spawn). */
  setBoxHalf(h) {
    const s = this.shapes[0];
    s.hx = s.hy = s.hz = h;
  }

  wakeUp() {
    this._sleeping = false;
    this.rb?.wakeUp();
  }

  setType(t) {
    if (t === this.type) return;
    this.type = t;
    if (!this.rb || !_R) return;
    this.flush();
    this.rb.setBodyType(t === TYPE.STATIC ? _R.RigidBodyType.Fixed : _R.RigidBodyType.Dynamic, true);
    if (t === TYPE.STATIC) { this.velocity._load(0, 0, 0); this.angularVelocity._load(0, 0, 0); }
  }

  /** Impulse in kg*m/s. Safe before the body is in a world (applied when it is added). */
  applyImpulse(i) {
    if (!this.rb) {
      const p = this._pendingImpulse ??= { x: 0, y: 0, z: 0 };
      p.x += i.x; p.y += i.y; p.z += i.z;
      return;
    }
    this.flush();
    this.rb.applyImpulse({ x: i.x, y: i.y, z: i.z }, true);
    const v = this.rb.linvel();
    this.velocity._load(v.x, v.y, v.z);
  }

  /** Push JS-side writes into Rapier. */
  flush() {
    const rb = this.rb;
    if (!rb) return;
    if (this._dirtyPos) { rb.setTranslation({ x: this.position._x, y: this.position._y, z: this.position._z }, true); this._dirtyPos = false; }
    if (this._dirtyRot) { rb.setRotation({ x: this.quaternion._x, y: this.quaternion._y, z: this.quaternion._z, w: this.quaternion._w }, true); this._dirtyRot = false; }
    if (this._dirtyVel) { rb.setLinvel({ x: this.velocity._x, y: this.velocity._y, z: this.velocity._z }, true); this._dirtyVel = false; }
    if (this._dirtyAng) { rb.setAngvel({ x: this.angularVelocity._x, y: this.angularVelocity._y, z: this.angularVelocity._z }, true); this._dirtyAng = false; }
  }
}

export class PhysWorld {
  constructor(R, gravity = 9.81) {
    this.R = R;
    this.rw = new R.World({ x: 0, y: -gravity, z: 0 });
    this.rw.timestep = 1 / 60;
    // Solver work: real masses span 4 orders of magnitude, so more than the default 4 passes.
    this.rw.integrationParameters.numSolverIterations = 8;
    this.gravity = gravity;
    this.events = new R.EventQueue(true);
    this.dynamic = new Set();           // bodies in the world that can move
    this.handleToBody = new Map();      // collider handle -> body
    this.flagged = new Set();           // bodies that raised a contact-force event this step
    /** (body, other|null, speed m/s, impulse kg*m/s, worldPos?) — set by the engine. */
    this.onImpact = null;
    this.stepCount = 0;
    this._ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  addBody(body) {
    if (body.world === this) return;
    const R = this.R;
    const mat = SURFACE[body.material] ?? SURFACE.stone;
    const dynamic = body.type === TYPE.DYNAMIC;
    const desc = (dynamic ? R.RigidBodyDesc.dynamic() : R.RigidBodyDesc.fixed())
      .setTranslation(body.position._x, body.position._y, body.position._z)
      .setRotation({ x: body.quaternion._x, y: body.quaternion._y, z: body.quaternion._z, w: body.quaternion._w })
      .setLinearDamping(body.linearDamping)
      .setAngularDamping(body.angularDamping)
      .setCanSleep(body.allowSleep);
    if (dynamic) {
      desc.setLinvel(body.velocity._x, body.velocity._y, body.velocity._z);
      desc.setAngvel({ x: body.angularVelocity._x, y: body.angularVelocity._y, z: body.angularVelocity._z });
      if (body.ccd) desc.setCcdEnabled(true);
      if (body.fixedRotation) desc.lockRotations();
    }
    const rb = this.rw.createRigidBody(desc);

    // Density so that total mass is exactly body.mass for any set of (non-overlapping) boxes.
    let volume = 0;
    for (const s of body.shapes) {
      volume += s.kind === 'box' ? 8 * s.hx * s.hy * s.hz : (4 / 3) * Math.PI * s.r ** 3;
    }
    const density = dynamic && volume > 0 ? body.mass / volume : 1;
    const wantEvents = dynamic && body.onCollide;
    // Force is split across the colliders of a compound body, so the threshold is too.
    const threshold = wantEvents
      ? (body.mass * body.eventSpeed * 60) / Math.max(1, body.shapes.length * 0.5)
      : 0;
    const groups = ((body.group & 0xffff) << 16) | (body.mask & 0xffff);
    for (const s of body.shapes) {
      const cd = s.kind === 'box' ? R.ColliderDesc.cuboid(s.hx, s.hy, s.hz).setTranslation(s.ox, s.oy, s.oz)
        : R.ColliderDesc.ball(s.r);
      cd.setDensity(density).setFriction(mat.friction).setRestitution(mat.restitution)
        .setCollisionGroups(groups).setSolverGroups(groups);
      if (body.material === 'player') {
        cd.setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitutionCombineRule(R.CoefficientCombineRule.Min);
      }
      if (wantEvents) {
        cd.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(threshold);
      }
      const col = this.rw.createCollider(cd, rb);
      this.handleToBody.set(col.handle, body);
    }
    body.rb = rb;
    body.world = this;
    body._sleeping = false;
    body._dirtyPos = body._dirtyVel = body._dirtyAng = body._dirtyRot = false;
    if (dynamic) this.dynamic.add(body);
    if (body._pendingImpulse) {
      const p = body._pendingImpulse;
      body._pendingImpulse = null;
      body.applyImpulse(p);
    }
  }

  removeBody(body) {
    const rb = body.rb;
    if (!rb || body.world !== this) return;
    for (let i = 0, n = rb.numColliders(); i < n; i++) this.handleToBody.delete(rb.collider(i).handle);
    this.rw.removeRigidBody(rb);
    this.dynamic.delete(body);
    this.flagged.delete(body);
    body.rb = null;
    body.world = null;
  }

  step(dt = 1 / 60) {
    const flagged = this.flagged;
    flagged.clear();
    for (const b of this.dynamic) {
      if (b._dirtyPos || b._dirtyVel || b._dirtyAng || b._dirtyRot) b.flush();
      b._preVx = b.velocity._x; b._preVy = b.velocity._y; b._preVz = b.velocity._z;
    }
    this.rw.timestep = dt;
    this.rw.step(this.events);
    this.stepCount++;

    this.events.drainContactForceEvents((ev) => {
      const a = this.handleToBody.get(ev.collider1());
      const b = this.handleToBody.get(ev.collider2());
      if (a?.onCollide) flagged.add(a);
      if (b?.onCollide) flagged.add(b);
      // Remember who hit whom so callers can pick a material tag from the surface hit.
      if (a?.onCollide) a._other = b || null;
      if (b?.onCollide) b._other = a || null;
    });

    const g = this.gravity * dt;
    for (const b of this.dynamic) {
      const rb = b.rb;
      if (rb.isSleeping()) { b._sleeping = true; continue; }
      b._sleeping = false;
      const t = rb.translation(), q = rb.rotation(), v = rb.linvel(), w = rb.angvel();
      b.position._load(t.x, t.y, t.z);
      b.quaternion._load(q.x, q.y, q.z, q.w);
      b.velocity._load(v.x, v.y, v.z);
      b.angularVelocity._load(w.x, w.y, w.z);
    }

    // Impact speed = velocity change beyond gravity, across the step, for bodies whose
    // contact force crossed their threshold (~ (1+e) x the normal approach speed).
    if (flagged.size && this.onImpact) {
      for (const b of flagged) {
        if (b.world !== this) continue;
        const dx = b.velocity._x - b._preVx;
        const dy = b.velocity._y - b._preVy + g;
        const dz = b.velocity._z - b._preVz;
        const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / 1.05;
        if (speed < b.eventSpeed) continue;
        this.onImpact(b, b._other || null, speed, speed * b.mass);
      }
    }
  }

  /** Is there world geometry within `length` below (x,y,z), ignoring bodies outside `mask`? */
  rayDownHits(x, y, z, length, mask = WORLD_GROUP) {
    const ray = this._ray;
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
    const hit = this.rw.castRay(ray, length, false, undefined, (0xffff << 16) | (mask & 0xffff));
    return !!hit;
  }

  dispose() {
    try { this.events.free?.(); } catch { /* wasm already gone */ }
    try { this.rw.free(); } catch { /* ditto */ }
    this.dynamic.clear();
    this.handleToBody.clear();
  }
}

/**
 * A heightfield collider over a vertex grid, positioned in the world. `heights(i, j)` returns
 * the height at vertex (i along +x, j along -z); the grid is (n+1) x (n+1) with `spacing`
 * metres between vertices and its (0,0) corner at (originX, originZ).
 */
export class PhysHeightfield {
  constructor(world, n, spacing, originX, originZ, material = 'dirt') {
    this.world = world; this.n = n; this.spacing = spacing;
    this.originX = originX; this.originZ = originZ; this.material = material;
    this.body = null;
    this.collider = null;
  }

  /** (Re)build from a Float32Array laid out [i][j] row-major (i*(n+1)+j). */
  set(data) {
    const R = this.world.R, rw = this.world.rw, n = this.n;
    if (this.body) {
      this.world.handleToBody.delete(this.collider.handle);
      rw.removeRigidBody(this.body);
    }
    // Rapier's matrix is column-major with rows along Z and columns along X. Vertex (i, j) of
    // ours is at x = i*spacing, z = -j*spacing from the corner, so Rapier row r (z increasing)
    // is our j = n - r, and Rapier column c is our i.
    const rows = n + 1;
    const heights = new Float32Array(rows * rows);
    for (let c = 0; c <= n; c++) {
      for (let r = 0; r <= n; r++) heights[r + c * rows] = data[c * rows + (n - r)];
    }
    const size = n * this.spacing;
    const rb = rw.createRigidBody(R.RigidBodyDesc.fixed()
      .setTranslation(this.originX + size / 2, 0, this.originZ - size / 2));
    const mat = SURFACE[this.material] ?? SURFACE.dirt;
    const col = rw.createCollider(R.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size })
      .setFriction(mat.friction).setRestitution(mat.restitution)
      .setCollisionGroups(((WORLD_GROUP) << 16) | 0xffff), rb);
    this.body = rb;
    this.collider = col;
    this.world.handleToBody.set(col.handle, TERRAIN_BODY);
  }

  dispose() {
    if (!this.body) return;
    this.world.handleToBody.delete(this.collider.handle);
    this.world.rw.removeRigidBody(this.body);
    this.body = null;
  }
}

/** Stand-in "other body" for contacts against the ground (material tag 'dirt'). */
export const TERRAIN_BODY = Object.freeze({ material: 'dirt', terrain: true, mass: Infinity });
