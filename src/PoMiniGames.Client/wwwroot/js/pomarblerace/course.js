// course.js — Game mixin: everything the course does to the field each physics step — boost
// pads, brake strips, the course drive, containment, contacts, unsticking and kickers — plus
// reading what a marble is rolling on. Every feature is optional per map (see maps.js) and
// feature-detected here. Mixed into Game.prototype by game.js.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  LOST_AIR, REACQUIRE_AFTER, AIR_HOLD, BRAKE_RATE, STALL_AFTER, STALL_REPEAT, STALL_GAIN, STALL_NUDGE, STALL_STEP, STALL_MAX, STALL_LOOKAHEAD, STALL_SIDESTEP, STALL_SIDE_SHARE, BOOST_ACCEL, BOOST_MAX_SPEED, KICK_DV, KICK_UP, KICK_CHARGE,
} from './tuning.js';

// Scratch: centerAt()/dirAt() hand back a shared vector unless given an output.
const _camRoad = new THREE.Vector3();
const _guardPoint = new THREE.Vector3();
const _guardNormal = new THREE.Vector3();
const _side = new THREE.Vector3();

export class CourseMixin {
  // Boost pads. A no-op on maps that have none — see the track interface in maps.js.
  _applyBoost(sdt) {
    if (!this.track.inBoost) return;
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;
    let playerBoosting = false;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      if (!this.track.inBoost(m.s)) continue;
      const v = m.body.velocity;
      // A map may lower the ceiling. It has to be able to: the default is 150, but an authored
      // course whose collider is a zero-thickness shell tunnels above ~120 u/s (see
      // boostMaxSpeed in track-glb.js), and a marble that leaves through the floor is gone.
      if (v.length() < (this.track.boostMaxSpeed || BOOST_MAX_SPEED)) {
        const d = this.track.dirAt(m.s);
        v.x += d.x * BOOST_ACCEL * sdt;
        v.y += d.y * BOOST_ACCEL * sdt;
        v.z += d.z * BOOST_ACCEL * sdt;
      }
      if (m === me) playerBoosting = true;
      if (Math.random() < 0.25) this.scene.burstSparks(m.mesh.position, 0x22d3ee, 2, 0.5);
      // #24 GPU chevron streaks shed backwards off the pad (always for yours, now and then for the pack).
      if (m === me ? Math.random() < 0.5 : Math.random() < 0.04) this.scene.burstFx?.('boost', m.mesh.position, this.track.dirAt(m.s));
    }
    // Edge-trigger the whoosh so it fires once per pad, not every frame you're on one.
    if (playerBoosting && !this._wasBoosting) {
      this.audio.playWhoosh(this.scene.audioCue(me.mesh.position));   // #9 placed at the pad
    }
    this._wasBoosting = playerBoosting;
    this.scene.setBoosting?.(playerBoosting);   // #28 the speed streak swells on a pad
  }

  // Brake strips (Spiral Works). Bleeds an over-speed marble down to the strip's cap; a no-op on maps
  // without any. Scaling the velocity rather than adding a force keeps the heading untouched.
  _applyBrakes(sdt) {
    if (!this.track.brakeAt) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const cap = this.track.brakeAt(m.s);
      if (!cap) continue;
      const v = m.body.velocity;
      const sp = v.length();
      if (sp > cap) v.scale(Math.max(cap / sp, 1 - BRAKE_RATE * sdt), v);
    }
  }

  // Course drive (track.driveAccel): a steady push along the course for marbles touching the track,
  // on a map whose grade is too gentle to race on under gravity alone (Playground Run). Only on the
  // track, so a free fall is untouched; clampSpeeds still caps the result. A no-op elsewhere.
  _applyDrive(sdt) {
    const a = this.track.driveAccel;
    if (!a) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj || !this._touch.has(m.body)) continue;
      const d = this.track.flowDir ? this.track.flowDir(m.proj, _camRoad) : this.track.dirAt(m.s, _camRoad);
      const v = m.body.velocity;
      v.x += d.x * a * sdt; v.y += d.y * a * sdt; v.z += d.z * a * sdt;
    }
  }

  _savePrev() {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      (m.prev || (m.prev = new CANNON.Vec3())).copy(m.body.position);
    }
  }

  _guardContainment() {
    const sweep = this.track.sweepGuard;
    if (!sweep) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.prev) continue;
      if (!sweep(m.prev, m.body.position, m.radius, _guardPoint, _guardNormal)) continue;
      m.body.position.set(_guardPoint.x, _guardPoint.y, _guardPoint.z);
      // Bounce off the inside of the surface it tried to pass (restitution 0.3).
      const v = m.body.velocity;
      const vn = v.x * _guardNormal.x + v.y * _guardNormal.y + v.z * _guardNormal.z;
      if (vn < 0) {
        v.x -= 1.3 * vn * _guardNormal.x;
        v.y -= 1.3 * vn * _guardNormal.y;
        v.z -= 1.3 * vn * _guardNormal.z;
      }
    }
  }

  // Which marbles are touching a static body (floor, wall, lid, obstacle) after this step. One
  // pass over the solver's contact list; marble-on-marble contacts do not count.
  _markContacts() {
    const t = this._touch;
    t.clear();
    const marble = this.materials.marble;
    for (const c of this.world.contacts) {
      const a = c.bi, b = c.bj;
      if (a.material === marble && b.material !== marble) t.add(a);
      else if (b.material === marble && a.material !== marble) t.add(b);
    }
  }

  // Unstick (see STALL_*): nudge a marble that has stopped making progress along the course. The
  // direction is the marble's own lane where the track can say (track.flowDir) — across a lane
  // junction the main line's tangent is turned ~90° to the channel, and the stalls cluster
  // exactly there — else toward the centerline a little ahead.
  _unstick(sdt) {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      if (m.stallS === undefined || m.s > m.stallS + STALL_GAIN) { m.stallS = m.s; m.stallT = 0; m.nudges = 0; continue; }
      m.stallT += sdt;
      if (m.stallT < STALL_AFTER) continue;
      m.stallT = STALL_AFTER - STALL_REPEAT;
      let d;
      // Along the lane when the marble is in one; otherwise (a funnel, a free fall) toward the
      // course a little ahead — in a funnel that is the throat. The main line's tangent there
      // points nowhere useful, and pushing along it shoved a marble resting on Grand Spiral's
      // funnel lip straight off the outside.
      if (this.track.flowDir && m.proj && m.proj.lane >= 0) {
        d = this.track.flowDir(m.proj, _camRoad);
      } else {
        const ahead = this.track.centerAt(m.s + STALL_LOOKAHEAD, _camRoad);
        const p = m.body.position;
        d = ahead.set(ahead.x - p.x, ahead.y - p.y, ahead.z - p.z).normalize();
      }
      const push = Math.min(STALL_MAX, STALL_NUDGE + STALL_STEP * (m.nudges || 0));
      m.nudges = (m.nudges || 0) + 1;
      m.body.velocity.x += d.x * push;
      m.body.velocity.y += d.y * push + 3;
      m.body.velocity.z += d.z * push;
      // Still stuck after a few straight pushes: add a sideways part, alternating sides (see
      // STALL_SIDESTEP), for the marble jammed at a turnstile's pivot.
      if (m.nudges > STALL_SIDESTEP) {
        const r = this.track.rightAt(m.s, _side);
        const side = ((m.nudges + m.index) % 2 ? 1 : -1) * push * STALL_SIDE_SHARE;
        m.body.velocity.x += r.x * side;
        m.body.velocity.y += r.y * side;
        m.body.velocity.z += r.z * side;
      }
    }
  }

  // #6 Kickers: drive the telegraph (brightening pad) and the fire moment. Push-only, so it
  // can scatter the pack and force a steering correction but never trap a marble. A no-op on
  // maps that have none.
  _applyKickers() {
    const kickers = this.track.kickers;
    if (!kickers) return;
    const t = this.raceClock;
    for (const k of kickers) {
      const phase = (t % k.period) / k.period;         // 0..1 within the charge->fire cycle
      // Tell: brighten over the last KICK_CHARGE of the cycle, easing in so it "winds up".
      const charge = phase > (1 - KICK_CHARGE) ? (phase - (1 - KICK_CHARGE)) / KICK_CHARGE : 0;
      k.mat.emissiveIntensity = 0.5 + charge * charge * 2.4;
      // Fire on the wrap, when phase resets from near-1 back toward 0.
      if (phase < k._lastPhase) this._fireKicker(k);
      k._lastPhase = phase;
    }
  }

  _fireKicker(k) {
    const [a, b] = k.band;
    const len = this.track.length;
    let hits = 0;
    let lastHitPos = null;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const frac = m.s / len;
      if (frac < a || frac > b) continue;
      lastHitPos = m.mesh.position;
      const rb = this.track.rightAt(m.s);
      // Alternate the kick direction by marble index so a fire splits the pack rather than
      // shoving everyone the same way — and the player has to steer back to their line.
      const dv = (KICK_DV / m.body.mass) * (m.index % 2 === 0 ? 1 : -1);
      m.body.velocity.x += rb.x * dv;
      m.body.velocity.y += rb.y * dv + KICK_UP;
      m.body.velocity.z += rb.z * dv;
      this.scene.burstSparks(m.mesh.position, 0xe879f9, 14, 1.5);
      this.scene.burstFx?.('pop', m.mesh.position);   // #24
      hits++;
    }
    k.mat.emissiveIntensity = 3.6;          // bright flash on fire (visible even when it hits nothing)
    if (hits > 0) {
      // ...but only make noise when it actually connects, and place it where it connected (#9).
      this.audio.playWhoosh(this.scene.audioCue(lastHitPos));
      // GFX #5 - a magenta flash off the band, which is what makes the kick read as a discharge
      // rather than the pack spontaneously scattering.
      this.scene.pulseLight(lastHitPos, 0xe879f9, 1.5);
      this.scene.burstFx?.('kicker', lastHitPos);     // #24 the discharge's shock ring
    }
  }

  // What `m` is rolling on, as an audio.js SURFACES key, read from the solver's contact list after
  // the step: the contact material of whatever non-marble body it touches. Riding on other marbles
  // counts as the plain surface. No contact for AIR_HOLD seconds is 'air' — a single substep
  // without contact is a bounce, not a jump, and would otherwise stutter the bed.
  _surfaceOf(m, dt) {
    if (!m || m.finished || m.eliminated) return 'surface';
    if (this.track.inBoost && this.track.inBoost(m.s)) return 'boost';
    if (this.track.brakeAt && this.track.brakeAt(m.s)) return 'rumble';
    if (this.isGuest) return 'surface';   // no physics on the guest, so no contacts to read
    let kind = null;
    for (const c of this.world.contacts) {
      const other = c.bi === m.body ? c.bj : c.bj === m.body ? c.bi : null;
      if (!other) continue;
      const name = other.material ? other.material.name : '';
      if (name === 'marble') { kind = kind || 'surface'; continue; }
      kind = name === 'rumble' || name === 'bump' || name === 'ice' ? name
        : name === 'obstacle' || name === 'spinner' ? 'obstacle' : 'surface';
      if (kind !== 'surface') break;
    }
    if (kind) { this._airT = 0; return kind; }
    this._airT += dt;
    return this._airT >= AIR_HOLD ? 'air' : this._surface;
  }

  // Retire a marble that has genuinely left the course: BOTH outside the course envelope AND
  // touching nothing for LOST_AIR seconds (see tuning.js). One touching track while the envelope
  // disagrees has reached another part of the course, so its position is re-acquired instead.
  // The envelope test lives in the track because it is made in the track's LOCAL (per-lane) frame.
  _sweepLost(sdt) {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj) continue;
      const onTrack = this._touch.has(m.body);
      m.airT = onTrack ? 0 : (m.airT || 0) + sdt;
      if (!this.track.isOutOfBounds(m.proj)) { m.lostT = 0; continue; }
      if (onTrack) {
        m.lostT = (m.lostT || 0) + sdt;
        if (m.lostT > REACQUIRE_AFTER) { m.pathIndex = -1; m.lostT = 0; }
      } else if (m.airT > LOST_AIR) {
        this.marbleSet.eliminate(m);
      }
    }
  }
}
