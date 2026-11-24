// director.js — Game mixin: which marble the camera follows, and the rivals drawn in glass.
// Mixed into Game.prototype by game.js.
import * as THREE from 'three-eco/webgpu';
import { PLAYER_INDEX } from './marbles.js';
import {
  ROAD_BIAS, FINAL_STRETCH, BED_NEAR_RANGE, BED_NEAR_EASE, LEADERS, SHOT_MIN_HOLD, SHOT_LEAD_MARGIN,
} from './tuning.js';

// Camera anchor scratch. centerAt() hands back a SHARED scratch unless given an output, so
// _camRoad has to be its own object or the lerp would read the vector it is writing into.
const _camAnchor = new THREE.Vector3();
const _camRoad = new THREE.Vector3();
const _cUp = new THREE.Vector3();
const _cGround = new THREE.Vector3();
// The key light's direction of travel (scene.js parks it at +28, +70, -18 from what it lights).
const KEY_DIR = new THREE.Vector3(-28, -70, 24).normalize();
const CAUSTIC_MAX = 4;     // yours + LEADERS
const CAUSTIC_FADE = 7;    // units of air under a marble at which its caustic has faded out

export class DirectorMixin {
  // ── Camera director ──
  // This is a game you steer, so the camera stays LOCKED to your own marble the whole race —
  // you must always see the marble you're controlling. The only times it leaves you: when
  // you're out of the race (eliminated/finished → follow the leader so there's still a race to
  // watch), and the slow-motion finish (the leader's money shot — unless YOU are that leader,
  // in which case staying on you already frames it).
  // `order` is this frame's post-step leaderboard(), computed once in _frame and shared with
  // the audio bed — leaderboard() is an O(n log n) pass over the 101-marble field, so it's
  // not re-derived here.
  _pickShot(order) {
    const leader = order[0];
    const now = performance.now();
    // Stamp the subject on every change so the hysteresis below can measure how long the current
    // shot has run. Cheap, and it keeps _shotSince honest for the non-demo cuts too.
    const take = (marble) => {
      if (marble !== this._shotMarble) { this._shotMarble = marble; this._shotSince = now; }
      return marble;
    };

    if (this.demo) {
      const cur = this._shotMarble;
      // Nothing to hold on to, or the subject is out of the race → take the leader outright.
      if (!cur || cur.eliminated || cur.finished) return take(leader);
      if (cur === leader) return take(leader);
      // Hold the shot: only cut once it has run its minimum AND the leader has genuinely gone.
      // Returning `cur` without take() deliberately leaves _shotSince alone — the shot is
      // continuing, not restarting.
      const held = (now - this._shotSince) / 1000;
      const behind = leader.s - cur.s;
      if (held < SHOT_MIN_HOLD || behind < SHOT_LEAD_MARGIN) return cur;
      return take(leader);
    }

    const me = this.marbleSet.marbles[this.chosen];
    const meAlive = me && !me.eliminated && !me.finished;
    // 1-player: stay LOCKED to your own marble the entire race — including the
    // slow-mo finish. You must always see the marble you're steering. The camera
    // only leaves you once you're out of the race (eliminated or finished), when
    // it falls back to the leader so there's still a race to watch.
    if (!meAlive) return take(leader);

    return take(me);
  }

  // The top rivals, for the glass and trails. Never the red marble: it is always trailed, and it
  // is a Mesh of its own rather than a pack instance, so it has nothing to swap into the glass.
  _topRivals(order) {
    const out = [];
    for (const m of order) {
      if (m.index === PLAYER_INDEX) continue;
      out.push(m);
      if (out.length === LEADERS) break;
    }
    return out;
  }

  // Everything a racing frame presents once the standings are settled, on the host and on the
  // online guest alike: the audio beds, the colour grade, the camera and the sector splits.
  // `order` is this frame's post-step leaderboard(), computed once by the caller.
  _presentRace(order, dt, surface) {
    // Audio beds ride the focused marble's speed and how close the race is to resolving, eased
    // (BED_NEAR_EASE) so the bed ramps up harder and sooner as the leader runs at the line.
    const leaderNow = order[0];
    const nearRaw = leaderNow
      ? 1 - Math.max(0, Math.min(1, (this.track.finishS - leaderNow.s) / BED_NEAR_RANGE))
      : 0;
    const nearFinish = Math.pow(nearRaw, BED_NEAR_EASE);
    // The rolling bed rides the marble on camera (not the leader) and what it is touching.
    const rolling = this._lastFocus || leaderNow;
    const racing = this.phase === 'racing';
    this.audio.updateBeds(rolling ? rolling.speed : 0, nearFinish, racing, surface);
    this.audio.updateRivals(this.scene.camera, this.marbleSet.marbles, rolling, racing);

    // FINAL STRETCH grade, keyed off the leader's progress. _resolve overrides it with win/loss
    // the instant the race is decided.
    if (racing) this._setGrade(this.marbleSet.progress() >= FINAL_STRETCH ? 'final' : 'racing');

    // Frame the SUBJECT, biased toward the road: the marble's own position pulled ROAD_BIAS of
    // the way back toward the centerline. A pure centerline anchor lost the marble on the authored
    // courses' 160-unit catch pans; a pure marble anchor inherits per-frame physics jitter.
    // A shot change snaps (a director's cut is a cut) rather than lerping across the track.
    const focus = this._pickShot(order);
    if (focus) {
      const fs = focus.s;
      const anchor = _camAnchor.copy(focus.mesh.position).lerp(this.track.centerAt(fs, _camRoad), ROAD_BIAS);
      this.scene.followTarget(anchor, dt, focus !== this._lastFocus, this.track.dirAt(fs), focus.speed);
      this._lastFocus = focus;
    }
    this._leaders = this._topRivals(order);
    // The water on the lens (#15): coming up out of the flume, the camera wears it for a few seconds.
    if (this._prevSurface === 'water' && surface !== 'water') this.scene.splash?.(16);
    this._prevSurface = surface;
    this._showcaseRace(order, dt);   // showcase.js: tower, arrows, place history, Doppler passes
    this._checkSectors();
    this._stepFlume(dt);          // flume.js: wakes and foam
    this._animateSetPieces(dt);   // course.js: pads spring back, magnets glow
    this._updateCaustics();
  }

  // ── Glass caustics (#13) ──
  // A glass marble is a ball lens: the key light passing through it is focused into a bright
  // spot with a chromatic ring, landing on the floor down-light of the marble (not under it).
  // Drawn for the marbles the eye is on — yours and the top rivals — as additive decals by
  // scene.js (caustics.js). Here: where each lands, how big, how bright, what tint.
  _updateCaustics() {
    if (!this.scene.setCaustics) return;
    const list = this._causticList || (this._causticList = []);
    list.length = 0;
    const ms = this.marbleSet.marbles;
    const want = [this.chosen, ...this._leaders.map((m) => m.index)];
    for (const i of want) {
      const m = ms[i];
      if (!m || m.finished || m.eliminated || !m.proj || list.length >= CAUSTIC_MAX) continue;
      if (list.some((c) => c.m === m)) continue;
      const up = this.track.upAt(m.s, _cUp);
      const gap = m.proj.height - m.radius;                 // daylight under the marble
      if (gap > CAUSTIC_FADE) continue;
      // Where the light through the marble lands: straight down the light ray to the floor, then
      // on past the contact point along the light's ground direction — a glass ball (n ≈ 1.5)
      // focuses about 1.5 radii from its centre, so the hot spot sits just beyond its shadow's
      // core rather than hidden under the marble. Sized so the fringe ring clears the silhouette.
      const lu = KEY_DIR.x * up.x + KEY_DIR.y * up.y + KEY_DIR.z * up.z;
      const cosL = -lu;
      const t = cosL > 0.2 ? m.proj.height / cosL : 0;
      _cGround.copy(KEY_DIR).addScaledVector(up, -lu);
      if (_cGround.lengthSq() > 1e-6) _cGround.normalize();
      const pool = this._causticPool || (this._causticPool = []);
      const e = pool[list.length] || (pool[list.length] = { pos: new THREE.Vector3(), up: new THREE.Vector3() });
      e.m = m;
      e.pos.copy(m.mesh.position).addScaledVector(KEY_DIR, t)
        // Lifted over the road's visual lumps (track-procedural.js bumpAt, up to 0.55 above the
        // collider plane); at 0.09 the decal was buried under them and never showed.
        .addScaledVector(_cGround, m.radius * 1.3).addScaledVector(up, 0.6);
      e.up.copy(up);
      e.size = m.radius * (4.2 + Math.max(0, gap) * 0.35);
      e.strength = (m.index === this.chosen ? 1 : 0.7) * (1 - Math.max(0, gap) / CAUSTIC_FADE);
      e.color = m.spec.color;
      // The pattern turns with the marble's roll, so a fast marble's caustic swirls.
      m._causticSpin = (m._causticSpin || 0) + (m.speed || 0) * 0.002;
      e.spin = m._causticSpin;
      list.push(e);
    }
    this.scene.setCaustics(list);
  }
}
