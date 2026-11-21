// platform/physics/rapier.js — the ONE rigid-body engine for the mini games: a thin wrapper over
// @dimforge/rapier3d-compat 0.21 (the import-map entry 'rapier'; the WASM is inside the module).
//
// WHY a wrapper and not "use Rapier directly" in each game:
//   * init once. Every game awaited its own import('rapier') + R.init(); this is one cached promise.
//   * a fixed step with an accumulator and a render-time interpolation alpha, so a game that
//     renders at 144 Hz over a 60 Hz sim does not stutter (getPose(h, out, true) blends prev→curr).
//   * CCD on by default for dynamic bodies. cannon-es had none, and three games carried hand-rolled
//     anti-tunnelling guards (marble race's swept course guard, brawl's deep rope walls).
//   * collision groups in the cannon vocabulary (group bits + mask bits) so ported code keeps its
//     G_* constants; packed into Rapier's 16/16 membership/filter word here, once.
//   * material TAGS on colliders (the impactMaterials.js vocabulary: metal wood stone glass rubber
//     paint flesh dirt water). The contact bridge below reads them, so a game that tags its
//     colliders gets impact sound/feel with no per-game audio code (roadmap item 11).
//   * contact-force events drained every step -> window.PoImpactSynth.play(tag, impulse,
//     {position, velocity, size}) with a per-pair rate limit and an impulse threshold, plus
//     window.PoImpact.impact('heavy') for the big ones. `size` is the collider bounding radius in
//     METRES (world units * opts.unitScale) so a marble and a boulder of the same material ring at
//     different pitches (impactSynth scales the mode frequencies by typicalSize/size).
//   * an optional Web Worker mode (physicsWorker.js) that owns the world and streams poses back as
//     transferable Float32Arrays.
//
// The wrapper is deliberately engine-shaped, not game-shaped: it knows nothing about marbles,
// fighters or islands. platform/physics/cannonCompat.js layers the old cannon-es API on top of it
// so the three games that were written against cannon (marble race, brawl visuals, voxel-less
// props) moved without rewriting their gameplay code.

let _R = null;
let _loading = null;
let _synthLoading = false;

/** Load + init Rapier exactly once. Resolves null (never rejects) when the module can't load. */
export function loadRapier() {
  if (_R) return Promise.resolve(_R);
  if (!_loading) {
    _loading = import('rapier')
      .then(async (m) => {
        const R = m.default || m;
        await R.init();
        _R = R;
        return R;
      })
      .catch((err) => {
        console.warn('[PoPhysics] Rapier WASM unavailable:', err?.message || err);
        return null;
      });
  }
  return _loading;
}

/** Synchronous accessor once loadRapier() has resolved (null before, or on failure). */
export function getRapier() { return _R; }

/** Test hook / worker entry: adopt an already-initialised Rapier module. */
export function adoptRapier(R) { _R = R; return R; }

export const GROUP_ALL = 0xffff;
/** cannon-style (group bits, mask bits) -> Rapier's packed 16/16 interaction groups. */
export const packGroups = (group = 1, mask = GROUP_ALL) => ((((group & 0xffff) << 16) | (mask & 0xffff)) >>> 0);

const DEFAULT_IMPACT = Object.freeze({
  enabled: true,
  // Impulse (N·s in world units) below which a contact is silent. Tuned per game via opts.
  threshold: 1.2,
  // Minimum ms between two sounds from the SAME body pair, so a resting stack or a rolling ball
  // that micro-bounces does not machine-gun the synth.
  pairGapMs: 70,
  // Hard cap on voices started per physics step (the synth also caps its own polyphony).
  maxPerStep: 4,
  // Impulse at which PoImpact.impact('heavy') (screen punch / haptics) fires too. 0 = never.
  heavyImpulse: 0,
  // Impulse that counts as a "full strength" hit for the synth (its `full` option).
  full: 20,
});

/**
 * Create a physics world.
 * @param {object} R initialised Rapier module
 * @param {object} [o]
 * @param {number} [o.gravity=9.81] magnitude, down -Y
 * @param {number} [o.fixedDt=1/60]
 * @param {number} [o.maxSubsteps=4]
 * @param {boolean} [o.ccd=true] CCD on every dynamic body
 * @param {number} [o.unitScale=1] metres per world unit (marble race runs at 1 unit = 1 cm: 0.01)
 * @param {object|false} [o.impact] contact-event bridge options (see DEFAULT_IMPACT) or false
 */
export function createPhysicsWorld(R, o = {}) {
  const gravity = o.gravity ?? 9.81;
  let fixedDt = o.fixedDt ?? 1 / 60;
  const ccdDefault = o.ccd !== false;
  const unitScale = o.unitScale ?? 1;
  const impactOpts = o.impact === false ? null : { ...DEFAULT_IMPACT, ...(o.impact || {}) };

  const raw = new R.World({ x: 0, y: -gravity, z: 0 });
  raw.timestep = fixedDt;
  const events = new R.EventQueue(true);

  /** Body record: { rb, colliders, userData, prev: Float32Array(7), curr: Float32Array(7), type } */
  const bodies = new Set();
  const colliderInfo = new Map();   // collider handle -> { body, tag, radius, group, mask }
  const startListeners = new Set();
  let accum = 0;
  let alpha = 1;
  let steps = 0;
  const pairClock = new Map();      // "ha:hb" -> last sound time (ms)

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function shapeDesc(s) {
    let d = null;
    switch (s.kind) {
      case 'ball': d = R.ColliderDesc.ball(s.radius); break;
      case 'cuboid': d = R.ColliderDesc.cuboid(s.hx, s.hy, s.hz); break;
      case 'cylinder': d = R.ColliderDesc.cylinder(s.halfHeight, s.radius); break;
      case 'capsule': d = R.ColliderDesc.capsule(s.halfHeight, s.radius); break;
      case 'trimesh': d = R.ColliderDesc.trimesh(s.vertices, s.indices); break;
      default: return null;
    }
    return d;
  }

  function boundingRadius(s) {
    switch (s.kind) {
      case 'ball': return s.radius;
      case 'cuboid': return Math.hypot(s.hx, s.hy, s.hz);
      case 'cylinder': case 'capsule': return Math.hypot(s.halfHeight, s.radius);
      default: return 1;
    }
  }

  /**
   * Add a rigid body with its colliders.
   * @param {object} d { type:'dynamic'|'fixed'|'kinematic', position, rotation, linvel, angvel,
   *   linearDamping, angularDamping, ccd, canSleep, userData, shapes:[{kind, ...dims, offset,
   *   rotation, friction, restitution, mass, density, group, mask, tag, sensor, collisionEvents,
   *   forceEvents}] }
   */
  function addBody(d) {
    const type = d.type || 'dynamic';
    const desc = type === 'fixed' ? R.RigidBodyDesc.fixed()
      : type === 'kinematic' ? R.RigidBodyDesc.kinematicVelocityBased()
        : R.RigidBodyDesc.dynamic();
    const p = d.position || { x: 0, y: 0, z: 0 };
    const q = d.rotation || { x: 0, y: 0, z: 0, w: 1 };
    desc.setTranslation(p.x, p.y, p.z).setRotation(q);
    if (type === 'dynamic') {
      desc.setLinearDamping(d.linearDamping || 0).setAngularDamping(d.angularDamping || 0);
      desc.setCcdEnabled(d.ccd ?? ccdDefault);
      if (d.canSleep === false) desc.setCanSleep(false);
      if (d.linvel) desc.setLinvel(d.linvel.x, d.linvel.y, d.linvel.z);
      if (d.angvel) desc.setAngvel(d.angvel);
    }
    const rb = raw.createRigidBody(desc);
    const rec = {
      rb, type, userData: d.userData || {}, colliders: [],
      prev: new Float32Array(7), curr: new Float32Array(7),
    };
    for (const s of d.shapes || []) {
      const cd = shapeDesc(s);
      if (!cd) continue;
      if (s.offset) cd.setTranslation(s.offset.x, s.offset.y, s.offset.z);
      if (s.rotation) cd.setRotation(s.rotation);
      if (s.friction != null) cd.setFriction(s.friction);
      if (s.restitution != null) cd.setRestitution(s.restitution);
      if (s.combine) { cd.setFrictionCombineRule(s.combine); cd.setRestitutionCombineRule(s.combine); }
      if (type === 'dynamic') {
        if (s.mass > 0) cd.setMass(s.mass);
        else if (s.density > 0) cd.setDensity(s.density);
      }
      if (s.group != null || s.mask != null) cd.setCollisionGroups(packGroups(s.group ?? 1, s.mask ?? GROUP_ALL));
      if (s.sensor) cd.setSensor(true);
      let ev = 0;
      if (s.collisionEvents) ev |= R.ActiveEvents.COLLISION_EVENTS;
      const wantsSound = impactOpts && impactOpts.enabled && s.tag && s.forceEvents !== false;
      if (wantsSound || s.forceEvents) {
        ev |= R.ActiveEvents.CONTACT_FORCE_EVENTS;
        // Rapier reports force = impulse / dt; filter at the source so quiet contacts cost nothing.
        const thr = s.forceThreshold ?? (impactOpts ? impactOpts.threshold : 1);
        cd.setContactForceEventThreshold(thr / fixedDt);
      }
      if (ev) cd.setActiveEvents(ev);
      const col = raw.createCollider(cd, rb);
      const info = {
        body: rec, tag: s.tag || null, radius: boundingRadius(s), group: s.group ?? 1, mask: s.mask ?? GROUP_ALL,
        collider: col, mass: s.mass || 0,
      };
      colliderInfo.set(col.handle, info);
      rec.colliders.push(col);
    }
    capture(rec, rec.curr);
    rec.prev.set(rec.curr);
    bodies.add(rec);
    return rec;
  }

  function removeBody(rec) {
    if (!bodies.has(rec)) return;
    for (const c of rec.colliders) colliderInfo.delete(c.handle);
    try { raw.removeRigidBody(rec.rb); } catch { /* already gone */ }
    bodies.delete(rec);
  }

  function capture(rec, out) {
    const t = rec.rb.translation(), r = rec.rb.rotation();
    out[0] = t.x; out[1] = t.y; out[2] = t.z; out[3] = r.x; out[4] = r.y; out[5] = r.z; out[6] = r.w;
  }

  /** Revolute (hinge) joint with an optional velocity motor. Returns { joint, setMotor(speed,maxForce) }. */
  function addHinge(a, b, pivotA, pivotB, axis) {
    const jd = R.JointData.revolute(pivotA, pivotB, axis);
    const joint = raw.createImpulseJoint(jd, a.rb, b.rb, true);
    return {
      joint,
      setMotor(speed, maxForce = 70) {
        joint.configureMotorVelocity(speed, 12.0);
        if (typeof joint.configureMotorMaxForce === 'function') joint.configureMotorMaxForce(maxForce);
      },
    };
  }

  /** Ball-and-socket joint. */
  function addBall(a, b, pivotA, pivotB) {
    return { joint: raw.createImpulseJoint(R.JointData.spherical(pivotA, pivotB), a.rb, b.rb, true) };
  }

  function removeJoint(j) { try { raw.removeImpulseJoint(j.joint, true); } catch { /* gone */ } }

  // ── The contact bridge: force events -> impact sound + feel ──────────────────────────────────
  let _voicesThisStep = 0;
  const _pos = { x: 0, y: 0, z: 0 };
  const _vel = { x: 0, y: 0, z: 0 };
  /** Last bridge calls, for headless verification: window.__poImpactLog when present. */
  const log = (typeof window !== 'undefined' && window.__poPhysicsLog) || null;

  function bridgeEvent(ev) {
    if (!impactOpts || !impactOpts.enabled) return;
    const c1 = colliderInfo.get(ev.collider1());
    const c2 = colliderInfo.get(ev.collider2());
    if (!c1 || !c2 || (!c1.tag && !c2.tag)) return;
    const impulse = ev.totalForceMagnitude() * fixedDt;
    if (impulse < impactOpts.threshold) return;
    if (_voicesThisStep >= impactOpts.maxPerStep) return;
    const key = c1.collider.handle < c2.collider.handle ? `${c1.collider.handle}:${c2.collider.handle}` : `${c2.collider.handle}:${c1.collider.handle}`;
    const t = now();
    const last = pairClock.get(key) || 0;
    if (t - last < impactOpts.pairGapMs) return;
    pairClock.set(key, t);
    _voicesThisStep++;

    // The dynamic collider is the one that moves; place the sound on it.
    const mover = c1.body.type === 'dynamic' ? c1 : c2;
    const tr = mover.body.rb.translation();
    const lv = mover.body.rb.linvel();
    _pos.x = tr.x; _pos.y = tr.y; _pos.z = tr.z;
    _vel.x = lv.x * unitScale; _vel.y = lv.y * unitScale; _vel.z = lv.z * unitScale;

    // impactSynth.js publishes window.PoImpactSynth when it loads. A game that never imported it
    // gets it here, once, on its first loud contact (the hit that triggered the load is dropped).
    const synth = typeof window !== 'undefined' ? window.PoImpactSynth : null;
    if (!synth && !impactOpts.sink && !_synthLoading && typeof window !== 'undefined') {
      _synthLoading = true;
      import('../impactSynth.js').catch(() => { /* no synth: contacts stay silent */ });
    }
    // Both bodies ring: the tag of each side, the other side at a reduced strength.
    const play = (info, strength) => {
      if (!info.tag) return;
      const opts = {
        position: { x: _pos.x, y: _pos.y, z: _pos.z },
        velocity: { x: _vel.x, y: _vel.y, z: _vel.z },
        size: Math.min(3, Math.max(0.005, info.radius * unitScale)), full: impactOpts.full,
        mass: info.mass > 0 ? info.mass * unitScale : undefined,
      };
      if (log) log.push({ tag: info.tag, impulse: impulse * strength, size: opts.size });
      // sink: a worker world has no window; it forwards the hit to the page, which plays it.
      if (impactOpts.sink) impactOpts.sink(info.tag, impulse * strength, opts);
      else if (synth && synth.play) synth.play(info.tag, impulse * strength, opts);
    };
    play(mover, 1);
    const other = mover === c1 ? c2 : c1;
    if (other.tag && other.tag !== mover.tag) play(other, 0.6);

    if (impactOpts.heavyImpulse > 0 && impulse >= impactOpts.heavyImpulse && !impactOpts.sink && typeof window !== 'undefined' && window.PoImpact) {
      window.PoImpact.impact('heavy', Math.min(1.5, impulse / (impactOpts.heavyImpulse * 2)));
    }
  }

  function drain() {
    events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      for (const fn of startListeners) fn(colliderInfo.get(h1), colliderInfo.get(h2), h1, h2);
    });
    _voicesThisStep = 0;
    if (impactOpts && impactOpts.enabled) events.drainContactForceEvents(bridgeEvent);
    else events.clear();
  }

  // ── Stepping ────────────────────────────────────────────────────────────────────────────────
  /**
   * Advance by `dt` of wall time in fixed steps. Returns the number of fixed steps taken.
   * `before(stepIndex)` runs ahead of each fixed step (game code pushes kinematic targets there).
   */
  function step(dt, before) {
    const maxSubsteps = api.maxSubsteps;
    accum += Math.min(dt, maxSubsteps * fixedDt);
    let n = 0;
    while (accum >= fixedDt && n < maxSubsteps) {
      if (before) before(n);
      for (const rec of bodies) if (rec.type === 'dynamic') rec.prev.set(rec.curr);
      raw.step(events);
      for (const rec of bodies) if (rec.type !== 'fixed') capture(rec, rec.curr);
      drain();
      accum -= fixedDt;
      n++;
      steps++;
    }
    if (n === maxSubsteps) accum = 0;
    alpha = accum / fixedDt;
    return n;
  }

  /** Pose for rendering. interpolate=true blends the last two fixed steps by the leftover alpha. */
  function getPose(rec, out, interpolate = false) {
    const c = rec.curr;
    if (!interpolate || rec.type === 'fixed') {
      out.x = c[0]; out.y = c[1]; out.z = c[2]; out.qx = c[3]; out.qy = c[4]; out.qz = c[5]; out.qw = c[6];
      return out;
    }
    const p = rec.prev, a = alpha;
    out.x = p[0] + (c[0] - p[0]) * a; out.y = p[1] + (c[1] - p[1]) * a; out.z = p[2] + (c[2] - p[2]) * a;
    // nlerp: the two quaternions are one 1/60 s step apart, so the shortest-arc blend is exact enough.
    const dot = p[3] * c[3] + p[4] * c[4] + p[5] * c[5] + p[6] * c[6];
    const s = dot < 0 ? -1 : 1;
    let x = p[3] + (s * c[3] - p[3]) * a, y = p[4] + (s * c[4] - p[4]) * a;
    let z = p[5] + (s * c[5] - p[5]) * a, w = p[6] + (s * c[6] - p[6]) * a;
    const l = Math.hypot(x, y, z, w) || 1;
    out.qx = x / l; out.qy = y / l; out.qz = z / l; out.qw = w / l;
    return out;
  }

  /** Write every non-fixed body's pose into a Float32Array (7 floats per body, in `order`). */
  function writePoses(order, out) {
    for (let i = 0; i < order.length; i++) out.set(order[i].curr, i * 7);
    return out;
  }

  function raycast(origin, dir, maxToi = 100, solid = true) {
    const ray = new R.Ray(origin, dir);
    const hit = raw.castRay(ray, maxToi, solid);
    if (!hit) return null;
    const info = colliderInfo.get(hit.collider.handle);
    return { toi: hit.timeOfImpact ?? hit.toi, tag: info?.tag || null, body: info?.body || null };
  }

  function free() {
    try { events.free(); } catch { /* ok */ }
    try { raw.free(); } catch { /* ok */ }
    bodies.clear(); colliderInfo.clear();
  }

  const api = {
    R, raw, events, maxSubsteps: o.maxSubsteps ?? 4, unitScale, impact: impactOpts,
    get fixedDt() { return fixedDt; },
    setFixedDt(dt) { fixedDt = dt; raw.timestep = dt; },
    bodies, colliderInfo,
    addBody, removeBody, addHinge, addBall, removeJoint,
    step, getPose, writePoses, raycast, free,
    onCollisionStart(fn) { startListeners.add(fn); return () => startListeners.delete(fn); },
    get alpha() { return alpha; },
    get stepCount() { return steps; },
    setGravity(g) { raw.gravity = { x: 0, y: -g, z: 0 }; },
  };
  return api;
}
