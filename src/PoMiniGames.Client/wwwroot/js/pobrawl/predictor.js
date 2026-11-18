// predictor.js — guess the human's next action from their last few.
//
// The opponent's behaviour is reduced to a stream of symbols (edges, not frames):
//   P punch · K kick · C coil (held charge) · B guard up · I steps in · O steps out
// and an order-3/2/1 n-gram with exponentially decayed counts predicts the next
// symbol. The longest context with enough evidence wins (back-off), and `conf` is
// that symbol's share of the context's decayed count, shrunk by +1 so a context seen
// once cannot read as certain.
//
// This is only a read. ai.js decides whether to act on it (rung-scaled threshold,
// reaction-time gate, a cap on acts per 10 s) so it stays beatable: a player who
// varies the pattern drops the confidence below the threshold.

export const SWING = new Set(['P', 'K', 'C']);

const MAX_ORDER = 3;
const DECAY = 0.97;          // per recorded symbol: old counts fade, recent play dominates
const MIN_EVIDENCE = 2.5;    // decayed observations a context needs before it speaks
const HISTORY = MAX_ORDER;

export class NGramPredictor {
  constructor() {
    this.tables = Array.from({ length: MAX_ORDER + 1 }, () => new Map());
    this.hist = [];
    this.count = 0;
  }

  /** Feed the opponent's next action. */
  push(sym) {
    // Learn: for every order, the context that preceded `sym` now points at it.
    for (let order = 1; order <= MAX_ORDER; order++) {
      if (this.hist.length < order) break;
      const key = this.hist.slice(-order).join('');
      const row = this.tables[order].get(key) || {};
      for (const k of Object.keys(row)) row[k] *= DECAY;
      row[sym] = (row[sym] || 0) + 1;
      this.tables[order].set(key, row);
    }
    this.hist.push(sym);
    if (this.hist.length > HISTORY) this.hist.shift();
    this.count++;
  }

  /** @returns {{sym:string, conf:number, order:number}|null} the likeliest next symbol. */
  predict() {
    for (let order = Math.min(MAX_ORDER, this.hist.length); order >= 1; order--) {
      const row = this.tables[order].get(this.hist.slice(-order).join(''));
      if (!row) continue;
      let total = 0, best = null;
      for (const [k, v] of Object.entries(row)) {
        total += v;
        if (!best || v > row[best]) best = k;
      }
      if (total < MIN_EVIDENCE) continue;
      return { sym: best, conf: row[best] / (total + 1), order };
    }
    return null;
  }

  /** Probability mass the current context puts on the next action being a swing. */
  swingProb() {
    for (let order = Math.min(MAX_ORDER, this.hist.length); order >= 1; order--) {
      const row = this.tables[order].get(this.hist.slice(-order).join(''));
      if (!row) continue;
      let total = 0, swing = 0;
      for (const [k, v] of Object.entries(row)) { total += v; if (SWING.has(k)) swing += v; }
      if (total >= MIN_EVIDENCE) return swing / (total + 1);
    }
    return 0;
  }
}

/**
 * Turns the per-tick ctx into the symbol stream. Strikes and guard come from the
 * opponent's state edge; stepping in/out from the distance changing faster than
 * STEP_SPEED metres per second while they are not mid-swing.
 */
const STEP_SPEED = 0.7;
const SAMPLE = 0.2;

export class ActionReader {
  constructor() { this.prev = 'idle'; this.prevDist = null; this.acc = 0; this.lastMove = null; }

  /** @returns a symbol if one happened this tick, else null */
  read(ctx) {
    const s = ctx.opponentState;
    let sym = null;
    if (s !== this.prev) {
      if (s === 'punch') sym = 'P';
      else if (s === 'kick') sym = 'K';
      else if (s === 'charge') sym = 'C';
      else if (s === 'block') sym = 'B';
      if (sym) this.lastMove = null;
    }
    this.prev = s;
    // Movement is sampled so a one-tick wobble is not a step.
    this.acc += ctx.dt || 0;
    if (this.acc >= SAMPLE) {
      if (this.prevDist != null && !sym && (s === 'idle' || s === 'block')) {
        const v = (ctx.distance - this.prevDist) / this.acc;
        const m = v < -STEP_SPEED ? 'I' : v > STEP_SPEED ? 'O' : null;
        // Collapse a run of the same step into one symbol.
        if (m && m !== this.lastMove) sym = m;
        this.lastMove = m;
      }
      this.prevDist = ctx.distance;
      this.acc = 0;
    }
    return sym;
  }
}
