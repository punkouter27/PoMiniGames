// rivals.js — Game mixin: rival personalities. Every CPU marble has a fixed temperament, derived
// from its index alone (marble #37 is the same bully every race, on every map, in every browser):
//
//   steady    rides the pack and never steers (the plurality, so the field still flows as before)
//   cautious  drifts back toward the middle of the channel, away from the walls
//   liner     takes the inside of the next bend, the short way round
//   bully     leans on the marble just ahead of it in the standings
//   wildcard  picks a new line every few seconds, for no reason at all
//
// Each pushes with the SAME lateral force a human gets (input.js _pushMarble), scaled down to
// RIVAL_STEER_SHARE of it, so a personality changes where a marble runs, never how fast it can
// go. Rules only, no randomness at run time beyond the wildcard's seeded line changes. Applied
// on the simulating browser only — an online guest renders the host's stream and never runs it.
// Mixed into Game.prototype by game.js.
import * as THREE from 'three';
import { STEER_ACCEL, RIVAL_STEER_SHARE, RIVAL_DEADBAND, RIVAL_GAIN, RIVAL_LOOKAHEAD } from './tuning.js';

/** Personality names, with each one's share of the pack (they sum to 1). */
export const PERSONALITIES = [
  ['steady', 0.4], ['cautious', 0.2], ['liner', 0.15], ['bully', 0.15], ['wildcard', 0.1],
];

// Stable 32-bit hash of an integer (lowbias32), so a marble's temperament is a pure function of
// its index.
function hash(n) {
  let x = (n + 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** The personality of marble `index` (a pure function of the index). */
export function personalityOf(index) {
  const u = hash(index) / 4294967296;
  let acc = 0;
  for (const [name, share] of PERSONALITIES) {
    acc += share;
    if (u < acc) return name;
  }
  return 'steady';
}

const _c = new THREE.Vector3();
const _r = new THREE.Vector3();
const _d = new THREE.Vector3();
const _d2 = new THREE.Vector3();

export class RivalsMixin {
  // Signed position across the channel, -1 at the left wall, +1 at the right, measured along the
  // same right vector the steering pushes along, so "steer toward target" is always the right sign.
  _rivalLateral(m) {
    const t = this.track;
    t.centerAt(m.s, _c);
    t.rightAt(m.s, _r);
    const p = m.body.position;
    const off = (p.x - _c.x) * _r.x + (p.y - _c.y) * _r.y + (p.z - _c.z) * _r.z;
    return off / Math.max(1, t.halfWidthAt(m.s));
  }

  // Where this marble wants to be across the channel, -1..1, or null for "leave it be".
  _rivalTarget(m, ahead) {
    switch (m.personality) {
      case 'cautious':
        return 0;
      case 'liner': {
        // The bend ahead turns toward whichever side its far tangent leans to; the inside is there.
        const t = this.track;
        t.dirAt(m.s, _d);
        t.dirAt(m.s + RIVAL_LOOKAHEAD, _d2);
        t.rightAt(m.s, _r);
        const turn = _d2.x * _r.x + _d2.y * _r.y + _d2.z * _r.z;   // > 0: bends right
        if (Math.abs(turn) < 0.05) return null;                     // straight: no inside to take
        return turn > 0 ? 0.6 : -0.6;
      }
      case 'bully':
        // Lean on the marble just ahead, if it is close enough to reach.
        if (!ahead || ahead.finished || ahead.eliminated || ahead.s - m.s > 10) return null;
        return this._rivalLateral(ahead);
      case 'wildcard': {
        // A new line every 2-4 s of race clock, from the marble's own hash: repeatable per race.
        const slot = Math.floor(this.raceClock / (2 + (hash(m.index) % 3)));
        return ((hash(m.index * 7919 + slot) / 4294967296) * 1.4) - 0.7;
      }
      default:
        return null;
    }
  }

  // Applied once per frame while racing, before the step (alongside _applySteer).
  _steerRivals(sdt) {
    if (this.phase !== 'racing' || this.isGuest || !this.marbleSet) return;
    const order = this.marbleSet.leaderboard();
    const cap = STEER_ACCEL * RIVAL_STEER_SHARE;
    for (let k = 0; k < order.length; k++) {
      const m = order[k];
      // Humans steer themselves: the player (outside the demo) and an online guest.
      if (!this.demo && m.index === this.chosen) continue;
      if (this.online && m.index === this.guestIndex) continue;
      if (m.finished || m.eliminated) continue;
      m.personality ||= personalityOf(m.index);
      if (m.personality === 'steady') continue;
      // On a side lane the main line's frame says nothing useful; in the air, a push is a no-op
      // a human could not make either.
      if (!m.proj || m.proj.lane >= 0 || !this._touch.has(m.body)) continue;
      const target = this._rivalTarget(m, k > 0 ? order[k - 1] : null);
      if (target === null) continue;
      const err = target - this._rivalLateral(m);
      if (Math.abs(err) < RIVAL_DEADBAND) continue;
      const dir = Math.max(-1, Math.min(1, err * RIVAL_GAIN));
      const rb = this.track.rightAt(m.s, _r);
      const dv = (cap / m.body.mass) * dir * sdt;
      m.body.velocity.x += rb.x * dv;
      m.body.velocity.y += rb.y * dv;
      m.body.velocity.z += rb.z * dv;
    }
  }
}
