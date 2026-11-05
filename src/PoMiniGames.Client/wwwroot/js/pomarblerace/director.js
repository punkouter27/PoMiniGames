// director.js — Game mixin: which marble the camera follows, and the rivals drawn in glass.
// Mixed into Game.prototype by game.js.
import * as THREE from 'three';
import { PLAYER_INDEX } from './marbles.js';
import {
  ROAD_BIAS, FINAL_STRETCH, BED_NEAR_RANGE, BED_NEAR_EASE, LEADERS, SHOT_MIN_HOLD, SHOT_LEAD_MARGIN,
} from './tuning.js';

// Camera anchor scratch. centerAt() hands back a SHARED scratch unless given an output, so
// _camRoad has to be its own object or the lerp would read the vector it is writing into.
const _camAnchor = new THREE.Vector3();
const _camRoad = new THREE.Vector3();

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
    this._checkSectors();
  }
}
