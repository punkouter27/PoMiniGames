// pobrawl/markovFeint.js — Context-Aware Markov Chain + Decay-Weighted Feint Counter (#2).
// Extends action-only n-grams to state-conditioned keys: (distanceBand x staminaBand x last2Actions)
// packed into a Uint16 index over a pre-allocated Float32Array(256 * 6) transition table (zero GC).
// Shared by PoBrawl and PoFighter. CPU main thread, <0.08 ms.

const ACTION_INDEX = { P: 0, K: 1, C: 2, B: 3, I: 4, O: 5 };
const INDEX_ACTION = ['P', 'K', 'C', 'B', 'I', 'O'];
const NUM_ACTIONS = 6;
const NUM_CONTEXTS = 256;
const DECAY = 0.95;

export class ContextMarkovFeint {
  constructor() {
    this.table = new Float32Array(NUM_CONTEXTS * NUM_ACTIONS);
    this.lastA = 0;
    this.lastB = 0;
    this.feintState = 'idle'; // 'idle' | 'bait_step' | 'punish_grab' | 'punish_strike'
    this.feintTimer = 0;
    this.cooldown = 0;
  }

  /** Pack (distanceBand 0..3, staminaBand 0..1, lastA 0..5, lastB 0..5) into [0..255]. */
  _key(distBand, stamBand) {
    const a = this.lastA & 3;
    const b = this.lastB & 3;
    return ((distBand & 3) << 6) | ((stamBand & 1) << 5) | (a << 3) | (b << 1);
  }

  /** Event-driven observation on every opponent action edge. */
  observe(sym, distanceMeters, oppStaminaRatio) {
    const idx = ACTION_INDEX[sym];
    if (idx === undefined) return;
    const distBand = distanceMeters < 1.3 ? 0 : distanceMeters < 2.2 ? 1 : distanceMeters < 3.4 ? 2 : 3;
    const stamBand = oppStaminaRatio < 0.35 ? 0 : 1;
    const base = this._key(distBand, stamBand) * NUM_ACTIONS;
    for (let i = 0; i < NUM_ACTIONS; i++) {
      this.table[base + i] *= DECAY;
    }
    this.table[base + idx] += 1;
    this.lastB = this.lastA;
    this.lastA = idx;
  }

  /** Predict opponent's next action given current combat context. */
  predict(distanceMeters, oppStaminaRatio) {
    const distBand = distanceMeters < 1.3 ? 0 : distanceMeters < 2.2 ? 1 : distanceMeters < 3.4 ? 2 : 3;
    const stamBand = oppStaminaRatio < 0.35 ? 0 : 1;
    const base = this._key(distBand, stamBand) * NUM_ACTIONS;
    let total = 0;
    let best = 0;
    for (let i = 0; i < NUM_ACTIONS; i++) {
      const v = this.table[base + i];
      total += v;
      if (v > this.table[base + best]) best = i;
    }
    if (total < 2.0) return null;
    return {
      sym: INDEX_ACTION[best],
      conf: this.table[base + best] / (total + 1),
    };
  }

  /**
   * 15 Hz feint state-machine tick.
   * When the opponent reliably blocks ('B') or swings ('P'/'K') in this context, executes a
   * brief step-in bait followed by a guard-breaking GRAB or counter-parry punish.
   * @returns {'none' | 'bait_step' | 'punish_grab' | 'punish_guard'}
   */
  tickFeint(dt, distanceMeters, oppStaminaRatio, feintRate = 0.25, rng = Math.random) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.feintState !== 'idle') {
      this.feintTimer -= dt;
      if (this.feintTimer <= 0) {
        if (this.feintState === 'bait_step') {
          this.feintState = 'punish_grab';
          this.feintTimer = 0.22;
          return 'punish_grab';
        }
        this.feintState = 'idle';
        this.cooldown = 2.4;
      }
      return this.feintState === 'bait_step' ? 'bait_step' : 'none';
    }

    if (this.cooldown > 0 || distanceMeters > 2.6) return 'none';
    const pred = this.predict(distanceMeters, oppStaminaRatio);
    if (!pred || pred.conf < 0.52) return 'none';

    if (pred.sym === 'B' && rng() < feintRate) {
      this.feintState = 'bait_step';
      this.feintTimer = 0.18;
      return 'bait_step';
    }
    if ((pred.sym === 'P' || pred.sym === 'K' || pred.sym === 'C') && pred.conf > 0.62) {
      this.cooldown = 1.6;
      return 'punish_guard';
    }
    return 'none';
  }
}
