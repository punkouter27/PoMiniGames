// physics-rapier.js — Rapier WASM (@dimforge/rapier3d-compat) rigid-body adapter for PoMarbleRace.
//
// Presents the exact subset of CANNON.World that track-procedural.js, marbles.js, course.js, and
// game.js speak to, backed by Rust-compiled WASM physics with native BVH broadphase and
// Continuous Collision Detection (CCD) on every marble sphere. Loaded asynchronously via the
// importmap's `rapier` entry; if unavailable (Node harness, offline), physics.js transparently
// falls back to cannon-es.
import * as CANNON from 'cannon-es';

let _R = null;
let _loading = null;

/** Preload and initialize the Rapier WASM module once (returns null on failure). */
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
        console.warn('[PoMarbleRace] Rapier WASM unavailable, falling back to cannon-es:', err?.message || err);
        return null;
      });
  }
  return _loading;
}

/** Synchronous accessor once loadRapier() has resolved (null before or on failure). */
export function getRapier() { return _R; }

// Material table matching physics.js contact pairs (friction + restitution).
const MAT_PROPS = {
  marble: { friction: 0.12, restitution: 0.50 },
  surface: { friction: 0.09, restitution: 0.35 },
  obstacle: { friction: 0.25, restitution: 0.45 },
  rumble: { friction: 0.30, restitution: 0.12 },
  bump: { friction: 0.20, restitution: 0.25 },
  spinner: { friction: 0.15, restitution: 0.60 },
  ice: { friction: 0.02, restitution: 0.22 },
};

function matProps(mat) {
  return (mat && MAT_PROPS[mat.name]) || MAT_PROPS.surface;
}

/**
 * Build a Rapier-backed world with the same contract as CANNON.World.
 * @param {object} R initialized Rapier module
 * @param {number} gravity positive downward gravity magnitude
 */
export function createRapierWorld(R, gravity) {
  const rw = new R.World({ x: 0, y: -gravity, z: 0 });
  const eventQueue = new R.EventQueue(true);

  // Map CANNON.Body <-> Rapier RigidBody / Collider handle.
  const bodyToRb = new Map();
  const handleToBody = new Map();
  const dynamicEntries = [];   // { body, rb } — synced every step
  const kinematicEntries = []; // { body, rb } — velocity/pose pushed before step
  const joints = [];           // { cannonHinge, rapierJoint }
  const bodies = [];
  const contacts = [];
  let accum = 0;

  const world = {
    engineName: 'rapier-wasm',
    bodies,
    contacts,
    stepnumber: 0,

    addBody(body) {
      if (bodyToRb.has(body)) return;
      const isStatic = body.mass === 0 && body.type !== CANNON.Body.KINEMATIC;
      const isKinematic = body.type === CANNON.Body.KINEMATIC;

      const rbDesc = isStatic
        ? R.RigidBodyDesc.fixed()
        : isKinematic
          ? R.RigidBodyDesc.kinematicVelocityBased()
          : R.RigidBodyDesc.dynamic()
            .setLinearDamping(body.linearDamping || 0)
            .setAngularDamping(body.angularDamping || 0)
            .setCcdEnabled(true); // CCD prevents high-speed marble tunneling!

      rbDesc.setTranslation(body.position.x, body.position.y, body.position.z);
      rbDesc.setRotation({
        x: body.quaternion.x, y: body.quaternion.y,
        z: body.quaternion.z, w: body.quaternion.w,
      });

      const rb = rw.createRigidBody(rbDesc);
      const mp = matProps(body.material);
      const isMarble = body.material && body.material.name === 'marble';

      for (const shape of body.shapes) {
        let colDesc = null;
        if (shape instanceof CANNON.Sphere) {
          colDesc = R.ColliderDesc.ball(shape.radius);
        } else if (shape instanceof CANNON.Box) {
          colDesc = R.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
        } else if (shape instanceof CANNON.Cylinder) {
          // CANNON.Cylinder aligns along Y (height, radiusTop, radiusBottom)
          colDesc = R.ColliderDesc.cylinder(shape.height / 2, shape.radiusTop);
        }
        if (!colDesc) continue;
        colDesc.setFriction(mp.friction).setRestitution(mp.restitution);
        if (!isStatic && !isKinematic && body.mass > 0) {
          colDesc.setMass(body.mass);
        }
        if (isMarble) {
          colDesc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
        }
        const col = rw.createCollider(colDesc, rb);
        handleToBody.set(col.handle, body);
      }

      bodyToRb.set(body, rb);
      bodies.push(body);
      if (isKinematic) kinematicEntries.push({ body, rb });
      else if (!isStatic) dynamicEntries.push({ body, rb });
    },

    removeBody(body) {
      const rb = bodyToRb.get(body);
      if (!rb) return;
      for (let i = 0; i < rb.numColliders(); i++) {
        handleToBody.delete(rb.collider(i).handle);
      }
      rw.removeRigidBody(rb);
      bodyToRb.delete(body);
      const idx = bodies.indexOf(body);
      if (idx >= 0) bodies.splice(idx, 1);
      const dIdx = dynamicEntries.findIndex((e) => e.body === body);
      if (dIdx >= 0) dynamicEntries.splice(dIdx, 1);
      const kIdx = kinematicEntries.findIndex((e) => e.body === body);
      if (kIdx >= 0) kinematicEntries.splice(kIdx, 1);
    },

    addConstraint(c) {
      if (!c || !c.bodyA || !c.bodyB) return;
      const rbA = bodyToRb.get(c.bodyA);
      const rbB = bodyToRb.get(c.bodyB);
      if (!rbA || !rbB) return;
      const jd = R.JointData.revolute(
        { x: c.pivotA.x, y: c.pivotA.y, z: c.pivotA.z },
        { x: c.pivotB.x, y: c.pivotB.y, z: c.pivotB.z },
        { x: c.axisA.x, y: c.axisA.y, z: c.axisA.z },
      );
      const joint = rw.createImpulseJoint(jd, rbA, rbB, true);
      // Hook motor methods on the CANNON.HingeConstraint so track-procedural.js driveMotors() drives Rapier.
      let motorSpeed = 0;
      let motorMaxForce = 70;
      let motorEnabled = false;
      const applyMotor = () => {
        if (!motorEnabled) return;
        joint.configureMotorVelocity(motorSpeed, 12.0);
        if (typeof joint.configureMotorMaxForce === 'function') {
          joint.configureMotorMaxForce(motorMaxForce);
        }
      };
      const origSetSpeed = c.setMotorSpeed?.bind(c);
      const origSetMax = c.setMotorMaxForce?.bind(c);
      const origEnable = c.enableMotor?.bind(c);
      c.enableMotor = () => { motorEnabled = true; origEnable?.(); applyMotor(); };
      c.setMotorSpeed = (s) => { motorSpeed = s; origSetSpeed?.(s); applyMotor(); };
      c.setMotorMaxForce = (f) => { motorMaxForce = f; origSetMax?.(f); applyMotor(); };
      if (c.motorEnabled) {
        motorEnabled = true;
        motorSpeed = c.motorTargetVelocity || 0;
        applyMotor();
      }
      joints.push({ cannonHinge: c, rapierJoint: joint });
    },

    step(fixedDt, dt, maxSubsteps) {
      accum += Math.min(dt, 0.05);
      let steps = 0;
      rw.timestep = fixedDt;

      // Push any external position/velocity mutations (steering, boosts, respawns, kinematic rotors)
      // from CANNON.Body proxies into Rapier before stepping.
      for (const { body, rb } of dynamicEntries) {
        const t = rb.translation();
        if (Math.abs(body.position.x - t.x) > 1e-4 || Math.abs(body.position.y - t.y) > 1e-4 || Math.abs(body.position.z - t.z) > 1e-4) {
          rb.setTranslation({ x: body.position.x, y: body.position.y, z: body.position.z }, true);
        }
        rb.setLinvel({ x: body.velocity.x, y: body.velocity.y, z: body.velocity.z }, true);
        rb.setAngvel({ x: body.angularVelocity.x, y: body.angularVelocity.y, z: body.angularVelocity.z }, true);
      }
      for (const { body, rb } of kinematicEntries) {
        rb.setAngvel({ x: body.angularVelocity.x, y: body.angularVelocity.y, z: body.angularVelocity.z }, true);
      }

      while (accum >= fixedDt && steps < maxSubsteps) {
        rw.step(eventQueue);
        accum -= fixedDt;
        steps++;
        world.stepnumber++;
      }

      // Sync Rapier poses & velocities back to CANNON.Body proxies.
      for (const { body, rb } of dynamicEntries) {
        const t = rb.translation();
        const r = rb.rotation();
        const lv = rb.linvel();
        const av = rb.angvel();
        body.position.set(t.x, t.y, t.z);
        body.quaternion.set(r.x, r.y, r.z, r.w);
        body.velocity.set(lv.x, lv.y, lv.z);
        body.angularVelocity.set(av.x, av.y, av.z);
      }
      for (const { body, rb } of kinematicEntries) {
        const t = rb.translation();
        const r = rb.rotation();
        body.position.set(t.x, t.y, t.z);
        body.quaternion.set(r.x, r.y, r.z, r.w);
      }

      // Refresh active contacts list & fire collision callbacks for audio/sparks.
      contacts.length = 0;
      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        const b1 = handleToBody.get(h1);
        const b2 = handleToBody.get(h2);
        if (!b1 || !b2) return;
        contacts.push({ bi: b1, bj: b2 });
        const dvx = b1.velocity.x - b2.velocity.x;
        const dvy = b1.velocity.y - b2.velocity.y;
        const dvz = b1.velocity.z - b2.velocity.z;
        const speed = Math.hypot(dvx, dvy, dvz);
        const contact = { getImpactVelocityAlongNormal: () => speed };
        if (b1.hasEventListener?.('collide')) b1.dispatchEvent({ type: 'collide', body: b2, contact });
        if (b2.hasEventListener?.('collide')) b2.dispatchEvent({ type: 'collide', body: b1, contact });
      });
      // Also record persistent floor/track contacts for dynamic marbles so _markContacts() sees grounded marbles.
      for (const { body, rb } of dynamicEntries) {
        if (!body.material || body.material.name !== 'marble') continue;
        const col = rb.numColliders() > 0 ? rb.collider(0) : null;
        if (!col) continue;
        rw.contactPairsWith(col, (otherCol) => {
          const other = handleToBody.get(otherCol.handle);
          if (other && other !== body) contacts.push({ bi: body, bj: other });
        });
      }
    },

    free() {
      try { eventQueue.free(); } catch { }
      try { rw.free(); } catch { }
    },
  };

  const materials = {
    marble: new CANNON.Material('marble'),
    surface: new CANNON.Material('surface'),
    obstacle: new CANNON.Material('obstacle'),
    rumble: new CANNON.Material('rumble'),
    bump: new CANNON.Material('bump'),
    spinner: new CANNON.Material('spinner'),
    ice: new CANNON.Material('ice'),
  };

  return { world, materials };
}
