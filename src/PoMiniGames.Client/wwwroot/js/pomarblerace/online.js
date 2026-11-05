// online.js — Game mixin: the host-authoritative relay. The host streams the field; the guest
// renders it and sends only its steering. See PoMarbleRaceShared.cs. Mixed in by game.js.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  RESULT_MS, TICK_INTERVAL, NET_INTERVAL, NET_SMOOTH,
} from './tuning.js';

const _rollAxis = new CANNON.Vec3();
const _rollQ = new CANNON.Quaternion();

export class OnlineMixin {
  // ── Online ──

  // Host: stream the field to the guest. float32 x,y,z per marble in index order, one flag byte
  // per marble (0 live, 1 finished, 2 eliminated), plus the guest marble's place so the guest page
  // can show it without a simulation of its own.
  _netSend(dt) {
    this._netAccum += dt;
    if (this._netAccum < NET_INTERVAL) return;
    this._netAccum = 0;
    const ms = this.marbleSet.marbles;
    const pos = new Float32Array(ms.length * 3);
    const flags = new Uint8Array(ms.length);
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const p = m.body.position;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      flags[i] = m.eliminated ? 2 : m.finished ? 1 : 0;
    }
    const order = this.marbleSet.leaderboard();
    const g = ms[this.guestIndex];
    this._invoke('OnHostFrame',
      ++this._netTick, Math.round(this.raceClock * 100) / 100, this.phase,
      new Uint8Array(pos.buffer), flags,
      g && !g.eliminated ? g.place : -1, order.length);
  }

  // Guest: a streamed snapshot from the host. Positions become easing targets (applied in
  // _guestRacingFrame), flags fire the same finish/elimination cues the host saw, and the first
  // racing frame is what starts the guest's race.
  applyFrame(tick, clock, phase, positions, flags, guestPlace, field) {
    if (!this.isGuest || !this.marbleSet) return;
    if (phase === 'racing' && this.phase === 'pick') this.pick(this.guestIndex);
    if (this.phase !== 'racing') return;
    const ms = this.marbleSet.marbles;
    // The interop layer hands a byte[] over as a Uint8Array; view it as the float32 it carries.
    const pos = new Float32Array(positions.buffer, positions.byteOffset, Math.floor(positions.byteLength / 4));
    for (let i = 0; i < ms.length && i * 3 + 2 < pos.length; i++) {
      const m = ms[i];
      if (m.eliminated) continue;
      if (!m.netTarget) {
        m.netTarget = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        m.body.position.set(m.netTarget.x, m.netTarget.y, m.netTarget.z);
      } else {
        m.netTarget.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      }
      const f = flags[i];
      if (f === 2) { this.marbleSet.eliminate(m); continue; }
      if (f === 1 && !m.finished) {
        m.finished = true;
        m.finishOrder = this._netFinish++;
        m.finishTime = clock;
        m.body.position.set(m.netTarget.x, m.netTarget.y, m.netTarget.z);
        this.scene.burstConfetti(m.mesh.position);
        this.audio.playFinish(this.scene.audioCue(m.mesh.position));
        if (m.finishOrder === 0 && m === this._lastFocus) { this.scene.photoFinish(); this.scene.finishSwoop?.(); }
        // Same photo-finish sting as the host: 2nd within a hair of the winner (frame clock).
        if (m.finishOrder === 1) {
          const first = ms.find((o) => o.finishOrder === 0);
          if (first && m.finishTime - first.finishTime < 0.05) this.audio.playPhotoFinish?.();
        }
        if (m.index === this.guestIndex) this._celebrateOwnFinish(m, m.finishOrder + 1);
      }
    }
    this.raceClock = clock;
    this._guestHud = { guestPlace, field };
  }

  // Guest: no physics. Ease every live marble toward its streamed target, fake the roll from the
  // distance covered, then run the same progress/sync/camera/HUD path as the host's frame.
  _guestRacingFrame(dt) {
    const k = Math.min(1, dt * NET_SMOOTH);
    const inv = 1 / Math.max(dt, 1e-3);
    for (const m of this.marbleSet.marbles) {
      if (m.eliminated || m.finished || !m.netTarget) continue;
      const p = m.body.position;
      const dx = (m.netTarget.x - p.x) * k, dy = (m.netTarget.y - p.y) * k, dz = (m.netTarget.z - p.z) * k;
      p.x += dx; p.y += dy; p.z += dz;
      // sync() reads speed off the body's velocity; derive it from the easing step.
      m.body.velocity.set(dx * inv, dy * inv, dz * inv);
      // A rolling sphere turns by distance/radius about the axis perpendicular to its travel.
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 1e-4) {
        _rollAxis.set(dz, 0, -dx);
        if (_rollAxis.lengthSquared() > 1e-8) {
          _rollAxis.normalize();
          _rollQ.setFromAxisAngle(_rollAxis, dist / m.radius);
          _rollQ.mult(m.body.quaternion, m.body.quaternion);
        }
      }
    }
    this.marbleSet.updateProgress(this.track);
    this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
    for (const p of this.track.paddles) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }

    const order = this.marbleSet.leaderboard();
    this._presentRace(order, dt, this._surfaceOf(this._lastFocus || order[0], dt));

    this.tickAccum += dt;
    if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendGuestTick(order); }
  }

  // Guest: the HUD tick, with the guest marble's place taken from the host's frame rather than
  // measured here. Same OnRaceTick contract as _sendTick.
  _sendGuestTick(order) {
    if (!this.dotnet) return;
    const h = this._guestHud || {};
    const place = h.guestPlace ?? -1;
    // The same race stings the host hears (results.js), with the host's place for this marble.
    this._raceStings(order, this.marbleSet.marbles[this.guestIndex], this._guestPrevPlace ?? -1, place);
    this._guestPrevPlace = place;
    this._invoke('OnRaceTick', place, h.field || order.length);
  }

  // Guest: the host resolved the race. Mirror _resolve's presentation without its scoring.
  guestResult(won) {
    if (!this.isGuest || this.phase !== 'racing') return;
    this.audio.silenceBeds();
    this._leaderIdx = -1;
    this._guestPrevPlace = -1;
    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    this._setGrade(won ? 'win' : 'loss');
    this.audio.playSting(!!won);
  }

  // Host: both players agreed to a rematch (the hub's handshake). Roll the next race from the
  // result screen; its pick phase reaches the guest with the new seed through the phase relay.
  // A guest has nothing to do here: it rebuilds when that phase arrives (nextTrack below).
  rematch() {
    if (!this.online || this.isGuest || this.phase !== 'result') return;
    this._nextTrack();
  }

  // Guest: the host has moved on to the next race, on this seed.
  nextTrack(seed) {
    if (!this.isGuest) return;
    this._nextTrack(seed >>> 0);
  }
}
