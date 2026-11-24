// course.js — Game mixin: everything the course does to the field each physics step — boost
// pads, brake strips, the course drive, containment, contacts, unsticking and kickers — plus
// reading what a marble is rolling on. Every feature is optional per map (see maps.js) and
// feature-detected here. Mixed into Game.prototype by game.js.
import * as THREE from 'three-eco/webgpu';
import * as CANNON from '../platform/physics/cannonCompat.js';
import {
  LOST_AIR, REACQUIRE_AFTER, RESPAWN_HOLD, RESPAWN_SPEED, RESPAWN_LIFT, AIR_HOLD, BRAKE_RATE, STALL_AFTER, STALL_REPEAT, STALL_GAIN, STALL_NUDGE, STALL_STEP, STALL_MAX, STALL_LOOKAHEAD, STALL_SIDESTEP, STALL_SIDE_SHARE, BOOST_ACCEL, BOOST_MAX_SPEED, KICK_DV, KICK_UP, KICK_CHARGE,
  TRAMP_V, TRAMP_FWD, TRAMP_COOLDOWN, CONVEYOR_SPEED, CONVEYOR_GRIP, MAGNET_ACCEL, MAGNET_PERIOD, MAGNET_DUTY,
  SAND_DRAG, SAND_MIN_SPEED, FLUME_CURRENT, FLUME_DRAG, FLUME_FLOOR,
} from './tuning.js';

// Scratch: centerAt()/dirAt() hand back a shared vector unless given an output.
const _camRoad = new THREE.Vector3();
const _guardPoint = new THREE.Vector3();
const _guardNormal = new THREE.Vector3();
const _side = new THREE.Vector3();
const _spawn = new THREE.Vector3();
const _spawnUp = new THREE.Vector3();

export class CourseMixin {
  // Boost pads. A no-op on maps that have none — see the track interface in maps.js.
  _applyBoost(sdt) {
    if (!this.track.inBoost) return;
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;
    let playerBoosting = false;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated) continue;
      const pad = this.track.inBoost(m.s);
      if (!pad) continue;
      // A pad may carry its own push (a lift up a climb, track-glb.js boostBands); else the default.
      const accel = typeof pad === 'number' ? pad : BOOST_ACCEL;
      const v = m.body.velocity;
      // A map may lower the ceiling. It has to be able to: the default is 150, but an authored
      // course whose collider is a zero-thickness shell tunnels above ~120 u/s (see
      // boostMaxSpeed in track-glb.js), and a marble that leaves through the floor is gone.
      if (v.length() < (this.track.boostMaxSpeed || BOOST_MAX_SPEED)) {
        const d = this.track.dirAt(m.s);
        v.x += d.x * accel * sdt;
        v.y += d.y * accel * sdt;
        v.z += d.z * accel * sdt;
      }
      if (m === me) playerBoosting = true;
      if (Math.random() < 0.25) this.scene.burstSparks(m.mesh.position, 0x22d3ee, 2, 0.5);
      // #24 GPU chevron streaks shed backwards off the pad (always for yours, now and then for the pack).
      if (m === me ? Math.random() < 0.5 : Math.random() < 0.04) this.scene.burstFx?.('boost', m.mesh.position, this.track.dirAt(m.s));
    }
    // Edge-trigger the whoosh so it fires once per pad, not every frame you're on one.
    if (playerBoosting && !this._wasBoosting) {
      this.audio.playWhoosh(this.scene.audioCue(me.mesh.position));   // #9 placed at the pad
      this.scene.shockwave?.(me.mesh.position, 0.45);                  // #12 the pad's punch
      this._rumble(0.15, 0.6, 200);                                     // #20
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
      if (!sweep(m.prev, m.body.position, m.radius, _guardPoint, _guardNormal, m.s)) continue;
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
      // An elevated stall should drop back into the track, not jump up into an overpass.
      m.body.velocity.y += d.y * push + (this.track.dropStallAssist && m.proj?.height > 4 ? -3 : 3);
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
      if (m.index === this.chosen) this._rumble(0.85, 0.5, 150);   // #20 the kick lands on you
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
      this.scene.shockwave?.(lastHitPos, 1);            // #12 and the lens bends with it
    }
  }

  // ── #9 / #10 / #14: the dealt set-pieces and surfaces (composer.js) ──
  // All push-only or free-moving (the non-trapping rule): each nudges velocity, none holds a marble.
  // Host-only physics, run after _markContacts (several only act on a marble touching the course).
  // The visual half that a guest also needs lives in _animateSetPieces.
  _applySetPieces(sdt) {
    this._applyTrampolines();
    this._applyConveyors(sdt);
    this._applyMagnets(sdt);
    this._applySurfaces(sdt);
    this._applyFlume(sdt);
  }

  // Trampolines: a marble rolling onto a pad is thrown up off it (and a little on), once per
  // TRAMP_COOLDOWN. Pads are circles in (s, lateral).
  _applyTrampolines() {
    const pads = this.track.trampolines;
    if (!pads || !pads.length) return;
    const lo = pads[0].s - pads[0].r - 1, hi = pads[pads.length - 1].s + pads[pads.length - 1].r + 1;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj || m.s < lo || m.s > hi) continue;
      if (!this._touch.has(m.body) || this.raceClock - (m._trampAt ?? -9) < TRAMP_COOLDOWN) continue;
      for (const p of pads) {
        const ds = m.s - p.s, dl = m.proj.lateral - p.lateral;
        if (ds * ds + dl * dl > p.r * p.r) continue;
        const v = m.body.velocity, u = p.up, d = p.dir;
        const add = TRAMP_V - (v.x * u.x + v.y * u.y + v.z * u.z);
        if (add > 0) { v.x += u.x * add; v.y += u.y * add; v.z += u.z * add; }
        v.x += d.x * TRAMP_FWD; v.y += d.y * TRAMP_FWD; v.z += d.z * TRAMP_FWD;
        m._trampAt = this.raceClock;
        p.squash = 1;
        this.scene.burstSparks(m.mesh.position, 0xfacc15, 10, 1.1);
        if (m.index === this.chosen || Math.random() < 0.12) this.audio.playImpact(16, 'bump', this.scene.audioCue(m.mesh.position));
        break;
      }
    }
  }

  // Cross conveyors: a marble on a belt is dragged toward the belt's sideways speed. Only the
  // across-the-road component is touched, so a belt bends a line without slowing the race.
  _applyConveyors(sdt) {
    const belts = this.track.conveyors;
    if (!belts || !belts.length) return;
    const k = Math.min(1, CONVEYOR_GRIP * sdt);
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !this._touch.has(m.body)) continue;
      for (const b of belts) {
        if (m.s < b.from || m.s > b.to) continue;
        const r = this.track.rightAt(m.s, _side), v = m.body.velocity;
        const dv = (b.dir * CONVEYOR_SPEED - (v.x * r.x + v.y * r.y + v.z * r.z)) * k;
        v.x += r.x * dv; v.y += r.y * dv; v.z += r.z * dv;
        break;
      }
    }
  }

  // Magnets: while a coil is live it pulls marbles within its reach toward its line across the
  // road (÷ mass, so a Heavy shrugs more of it off). Never along the road, so it cannot hold one.
  _applyMagnets(sdt) {
    const mags = this.track.magnets;
    if (!mags || !mags.length) return;
    for (const g of mags) g.on = ((this.raceClock + g.offset) % MAGNET_PERIOD) / MAGNET_PERIOD < MAGNET_DUTY;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj) continue;
      for (const g of mags) {
        if (!g.on) continue;
        const ds = m.s - g.s;
        if (ds > g.reach || ds < -g.reach) continue;
        const dl = g.lateral - m.proj.lateral;
        const dist = Math.hypot(ds, dl);
        if (dist >= g.reach) continue;
        // Eased off over the last 3 units so a marble on the coil's line is not flicked across it.
        const a = MAGNET_ACCEL * (1 - dist / g.reach) * Math.min(1, Math.abs(dl) / 3) * Math.sign(dl) / m.body.mass;
        const r = this.track.rightAt(m.s, _side), v = m.body.velocity;
        v.x += r.x * a * sdt; v.y += r.y * a * sdt; v.z += r.z * a * sdt;
        if (Math.random() < 0.02) this.scene.burstSparks(m.mesh.position, 0xc084fc, 4, 0.6);
      }
    }
  }

  // Sand bleeds speed from a marble rolling in it, down to SAND_MIN_SPEED and never below, so a
  // trap costs places but cannot stop anyone. Ice needs nothing here: its contact material
  // (physics.js) is the whole effect.
  _applySurfaces(sdt) {
    if (!this.track.surfaceAt) return;
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || this.track.surfaceAt(m.s) !== 'sand' || !this._touch.has(m.body)) continue;
      const v = m.body.velocity, sp = v.length();
      if (sp > SAND_MIN_SPEED) v.scale(Math.max(SAND_MIN_SPEED / sp, 1 - SAND_DRAG * sdt), v);
      if (Math.random() < (m.index === this.chosen ? 0.5 : 0.03)) this.scene.burstFx?.('dust', m.mesh.position, null, 14);
    }
  }

  // The water flume: in the water, a marble is dragged toward the water's own velocity — the
  // current down the flume plus whatever the wakes are doing across it (flume.js's fluid grid,
  // when it is running). The current never reads below FLUME_FLOOR of itself, so the water always
  // carries a marble on. A marble bouncing clear over the surface is left alone.
  _applyFlume(sdt) {
    const fl = this.track.flume;
    if (!fl) return;
    const grid = this._flume ? this._flume.grid : null;
    const k = Math.min(1, FLUME_DRAG * sdt);
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj) continue;
      if (m.s < fl.from || m.s > fl.to) { m._wet = false; continue; }
      if (m.proj.height > fl.waterH + m.radius + 1.5) continue;
      const d = this.track.dirAt(m.s, _camRoad), r = this.track.rightAt(m.s, _side);
      let wx = 0, wz = FLUME_CURRENT;
      if (grid) {
        const f = grid.flow(m.proj.lateral, m.s);
        wx = f.x;
        wz = Math.max(FLUME_CURRENT * FLUME_FLOOR, f.z);
      }
      const v = m.body.velocity;
      const da = (wz - (v.x * d.x + v.y * d.y + v.z * d.z)) * k;
      const dl = (wx - (v.x * r.x + v.y * r.y + v.z * r.z)) * k;
      v.x += d.x * da + r.x * dl; v.y += d.y * da + r.y * dl; v.z += d.z * da + r.z * dl;
      if (!m._wet) {
        // Splashdown.
        m._wet = true;
        m._wetAt = this.raceClock;
        this.scene.burstSparks(m.mesh.position, 0xbfe9ff, 16, 1.4);
        if (m.index === this.chosen || Math.random() < 0.15) {
          this.audio.playImpact(Math.min(40, 10 + m.speed * 0.3), 'water', this.scene.audioCue(m.mesh.position));
        }
      }
    }
  }

  // The visual half of the set-pieces, on every browser (the online guest included): trampoline
  // pads spring back, magnet coils glow while live and flicker just before they switch on.
  _animateSetPieces(dt) {
    const pads = this.track.trampolines;
    if (pads) {
      for (const p of pads) {
        if (p.squash <= 0) continue;
        p.squash = Math.max(0, p.squash - dt * 5);
        p.disc.scale.y = 1 - 0.45 * p.squash;
      }
    }
    const mags = this.track.magnets;
    if (mags && mags.length) {
      const t = this.raceClock;
      for (const g of mags) {
        const ph = ((t + g.offset) % MAGNET_PERIOD) / MAGNET_PERIOD;
        const on = ph < MAGNET_DUTY;
        const tell = ph > 0.88 ? (ph - 0.88) / 0.12 : 0;   // the wind-up before it bites
        g.coilMat.emissiveIntensity = on ? 1.8 + 0.5 * Math.sin(t * 31) : 0.35 + tell * tell * 1.6;
        g.reachMat.opacity = on ? 0.42 : 0.12 + tell * 0.2;
        if (on && !g._shown) this.scene.pulseLight(g.pos, 0xc084fc, 0.7);
        g._shown = on;
      }
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
    // In the flume the water is what you hear, whatever is under it.
    const fl = this.track.flume;
    if (fl && m.s >= fl.from && m.s <= fl.to && m.proj && m.proj.height <= fl.waterH + m.radius + 1.5) return 'water';
    if (this.isGuest) {
      // No physics on the guest, so no contacts to read; the course still says what is underfoot.
      const k = this.track.surfaceAt && this.track.surfaceAt(m.s);
      return k === 'ice' || k === 'sand' ? k : 'surface';
    }
    let kind = null;
    for (const c of this.world.contacts) {
      const other = c.bi === m.body ? c.bj : c.bj === m.body ? c.bi : null;
      if (!other) continue;
      const name = other.material ? other.material.name : '';
      if (name === 'marble') { kind = kind || 'surface'; continue; }
      kind = name === 'rumble' || name === 'bump' || name === 'ice' || name === 'sand' ? name
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
  // A marble a human steers is put back instead (see RESPAWN_* in tuning.js).
  _sweepLost(sdt) {
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj) continue;
      if (m.respawnT > 0) { this._holdRespawn(m, sdt); continue; }
      const onTrack = this._touch.has(m.body);
      m.airT = onTrack ? 0 : (m.airT || 0) + sdt;
      if (!this.track.isOutOfBounds(m.proj)) {
        m.lostT = 0;
        // Rolling on the course, inside it: this is where a respawn would put the marble back.
        if (onTrack && this._isHuman(m)) {
          const sf = m.safe || (m.safe = { s: 0, lane: -1, ring: 0 });
          sf.s = m.s; sf.lane = m.proj.lane; sf.ring = m.proj.ring;
        }
        continue;
      }
      if (onTrack) {
        m.lostT = (m.lostT || 0) + sdt;
        if (m.lostT > REACQUIRE_AFTER) { m.pathIndex = -1; m.lostT = 0; }
      } else if (m.airT > LOST_AIR) {
        if (this._isHuman(m)) this._respawn(m);
        else { this._shatter(m); this.marbleSet.eliminate(m); }   // #16
      }
    }
  }

  // The marbles people steer: yours, and on the online host the guest's too. Never in the demo.
  _isHuman(m) {
    if (this.demo) return false;
    return m.index === this.chosen || (!!this.online && !this.isGuest && m.index === this.guestIndex);
  }

  // Put a marble that left the course back above the last spot it was safely rolling on, and
  // hold it there: no collisions, no motion, until _holdRespawn lets it go.
  _respawn(m) {
    const t = this.track;
    const sf = m.safe || { s: Math.min(6, t.finishS * 0.5), lane: -1, ring: 0 };
    const lift = m.radius + RESPAWN_LIFT;
    if (t.respawnPoint) t.respawnPoint(sf, lift, _spawn);
    else { t.centerAt(sf.s, _spawn); _spawn.addScaledVector(t.upAt(sf.s, _spawnUp), lift); }
    (m.spawn || (m.spawn = new CANNON.Vec3())).set(_spawn.x, _spawn.y, _spawn.z);
    m.body.position.copy(m.spawn);
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    m.body.collisionResponse = false;
    if (m.prev) m.prev.copy(m.spawn);   // the swept guard must not trace the teleport
    m.respawnT = RESPAWN_HOLD;
    m.respawns = (m.respawns || 0) + 1;
    m.airT = 0; m.lostT = 0;
    m.pathIndex = -1;                   // re-acquire the projection from scratch
    m.stallS = undefined;               // and the unstick timer with it
    this.scene.burstSparks(_spawn, m.spec.color, 14, 1.2);
    this.scene.pulseLight(_spawn, 0x7dd3fc, 1.2);
    if (m.index === this.chosen) {
      this._rumble(0.6, 0.4, 240);   // #20
      this.audio.playWhoosh(this.scene.audioCue(_spawn));
      this.audio.say('Back on track');
      this._invoke('OnRespawn', m.respawns);
    }
  }

  _holdRespawn(m, sdt) {
    m.respawnT -= sdt;
    m.body.position.copy(m.spawn);
    m.body.angularVelocity.set(0, 0, 0);
    if (m.respawnT > 0) { m.body.velocity.set(0, 0, 0); return; }
    m.respawnT = 0;
    m.body.collisionResponse = true;
    const d = this.track.flowDir && m.proj.lane >= 0 ? this.track.flowDir(m.proj, _spawnUp) : this.track.dirAt(m.s, _spawnUp);
    m.body.velocity.set(d.x * RESPAWN_SPEED, d.y * RESPAWN_SPEED, d.z * RESPAWN_SPEED);
  }
}
