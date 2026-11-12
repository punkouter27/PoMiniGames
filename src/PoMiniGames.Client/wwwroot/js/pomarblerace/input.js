// input.js — Game mixin: the player's one verb (held lateral steering) and its key bindings.
// Mixed into Game.prototype by game.js.
import { STEER_ACCEL } from './tuning.js';
import { setPref } from './store.js';

export class InputMixin {
  // The player's in-race input: hold a direction to steer the picked marble sideways. dir is
  // -1 (left) or +1 (right); active toggles the hold. Keyboard drives this on keydown/keyup,
  // the on-screen pads on pointer down/up. The force itself is applied every physics step in
  // _applySteer — this just records which way, if any, is currently held.
  setSteer(dir, active) {
    if (dir < 0) this._steerLeft = !!active;
    else if (dir > 0) this._steerRight = !!active;
    // Guest: the host applies the force, so what crosses the wire is the net held direction,
    // and only when it changes — a held key must not stream a packet per keydown auto-repeat.
    if (this.isGuest) {
      const net = (this._steerRight ? 1 : 0) - (this._steerLeft ? 1 : 0);
      if (net !== this._sentSteer) { this._sentSteer = net; this._invoke('OnSteer', net); }
    }
  }

  // Host: the guest's steering as relayed by the hub. Applied every physics step in _applySteer.
  setGuestSteer(dir) { this._guestSteer = Math.max(-1, Math.min(1, dir | 0)); }

  // Applied once per physics step while racing. Left+right held cancel out. The push is along
  // the track's LOCAL right vector, so it stays intuitive through banked turns and hairpins
  // where world-space X would flip under the player.
  _applySteer(sdt) {
    if (this.demo || this.phase !== 'racing') return;
    const dir = (this._steerRight ? 1 : 0) - (this._steerLeft ? 1 : 0);
    if (dir) this._pushMarble(this.marbleSet.marbles[this.chosen], dir, sdt);
    // Online host: the guest's held direction drives the guest's marble through the SAME push
    // below, so both humans steer with identical physics.
    if (this.online && !this.isGuest && this._guestSteer) {
      this._pushMarble(this.marbleSet.marbles[this.guestIndex], this._guestSteer, sdt);
    }
  }

  // One steering push on one marble. Separate from _applySteer so the online host can apply
  // it to the guest's marble too.
  _pushMarble(m, dir, sdt) {
    if (!m || m.finished || m.eliminated) return;

    const rb = this.track.rightAt(m.s);
    // A lateral acceleration (÷ mass so it's independent of the mass unit), applied along the
    // track's local right vector.
    //
    // NOT negated. The baked basis defines right = dir x up, and a camera's screen-right is
    // likewise forward x up, so track-right is already screen-right whenever the shot is
    // anchored on the subject (it anchors on the marble itself, see ROAD_BIAS).
    //
    // Every track must publish `right` as dir x up. The chute's generator produces -(dir x up),
    // so maps.js adaptProceduralTrack negates its vector at the boundary; flipping the sign here
    // instead would break the two baked GLB courses.
    //
    // Steering feel is a property of the CAMERA, not of the track basis. If it ever feels
    // backwards, check first whether it is backwards on EVERY map. If it is, look at the camera,
    // then flip this sign. If it is only one map, that map's basis is what disagrees.
    const dv = (STEER_ACCEL / m.body.mass) * dir * sdt;
    m.body.velocity.x += rb.x * dv;
    m.body.velocity.y += rb.y * dv;
    m.body.velocity.z += rb.z * dv;

    // Throttled sparks off the steered marble — feedback that the input is landing, without
    // the every-frame audio a held key would otherwise spam.
    this._steerSparkAccum += sdt;
    if (this._steerSparkAccum >= 0.08) {
      this._steerSparkAccum = 0;
      this.scene.burstSparks(m.mesh.position, m.spec.color, 3, 0.7);
    }
  }

  _bindKeys() {
    this._keyHandler = (e) => {
      // Typing (the online join code, a settings field) and browser shortcuts (Ctrl+R) are not race keys.
      if (e.ctrlKey || e.metaKey || e.altKey || e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.regenerate(); }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        const muted = this.audio.toggleMuted();
        setPref('muted', muted);
        this._invoke('OnMuted', muted);
      }
      // G: show or hide the ghost of your best run (local races on the authored courses).
      if (e.key === 'g' || e.key === 'G') { e.preventDefault(); this.toggleGhost(); }
      // Held-key steering: keydown starts the hold (auto-repeat re-sets the same flag, which
      // is idempotent), keyup below ends it.
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); this.setSteer(-1, true); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); this.setSteer(1, true); }
    };
    this._keyUpHandler = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { this.setSteer(-1, false); }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { this.setSteer(1, false); }
    };
    // Losing focus (alt-tab, click away) has no keyup, so release steering here or the marble
    // keeps drifting into the wall with nothing held.
    this._blurHandler = () => { this._steerLeft = this._steerRight = false; };
    window.addEventListener('keydown', this._keyHandler);
    window.addEventListener('keyup', this._keyUpHandler);
    window.addEventListener('blur', this._blurHandler);
  }
  _unbindKeys() {
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    if (this._keyUpHandler) window.removeEventListener('keyup', this._keyUpHandler);
    if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
  }
}
