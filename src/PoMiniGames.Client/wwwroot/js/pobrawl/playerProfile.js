// playerProfile.js — what the CPU remembers about the human across sessions.
//
// A small, fixed-shape tally of the habits ai.js can see from the scoreboard-level
// context: which strikes the human throws, how much of the in-range time is spent
// guarding, whether they guard when we swing, how much they coil, and the range they
// like to stand at. It is saved under a `pomini_` localStorage key, decayed on every
// load so it follows recent play (HALF_LIFE_FIGHTS), and bounded: the shape never
// grows (a handful of numbers), and every counter is clamped.
//
// Storage may be missing, blocked, full or hold junk. Every read and write is wrapped
// in try/catch and falls back to a blank profile, so the profile is only ever a
// bonus. ai.js seeds its in-match adaptation from `seed()` scaled by rung.
//
// Limits: the engine context carries the opponent's state, not which arm punched, so
// jab and cross both count as `punch`; coil (a held charge) and kick are separate.
// The human's get-up choice is not visible to the CPU, so `noteGetUp` is a hook for
// the game to call; nothing here fakes it.

export const PROFILE_KEY = 'pomini_pobrawl_profile';
const VERSION = 1;
// Each load multiplies the counters by this, so a habit halves in ~4 fights.
const DECAY_PER_LOAD = 0.84;
const CAP = 5000;               // no counter ever exceeds this: bounded size and no overflow
const SAVE_EVERY_SECS = 6;      // in-match autosave cadence

const blank = () => ({
  v: VERSION,
  fights: 0,
  strikes: { punch: 0, kick: 0, coil: 0 },
  totalT: 0,          // seconds observed
  inRangeT: 0,        // seconds the opponent was within 1.25 kick ranges
  blockT: 0,          // of which spent guarding
  ourSwings: 0,       // our swings that started with the human close enough to answer
  guardedOurSwings: 0, // ...and the human already had the guard up
  range: [0, 0, 0],   // seconds spent close / mid / far (< 0.7, < 1.25, beyond kickRange)
  getUp: { plain: 0, guard: 0, roll: 0, strike: 0 },
});

/** The browser's localStorage, or null when it is missing or the accessor throws. */
export function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const num = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(CAP, x)) : 0);
const numsOf = (src, keys) => Object.fromEntries(keys.map((k) => [k, num(src?.[k])]));

// Coerce whatever was stored into the fixed shape; unknown keys are dropped.
function sanitize(raw) {
  const b = blank();
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return b;
  b.fights = num(raw.fights);
  b.strikes = numsOf(raw.strikes, Object.keys(b.strikes));
  b.getUp = numsOf(raw.getUp, Object.keys(b.getUp));
  for (const k of ['totalT', 'inRangeT', 'blockT', 'ourSwings', 'guardedOurSwings']) b[k] = num(raw[k]);
  b.range = [0, 1, 2].map((i) => num(raw.range?.[i]));
  return b;
}

export class PlayerProfile {
  /** @param storage anything with getItem/setItem (null → in-memory only). */
  constructor(storage = defaultStorage()) {
    this.storage = storage;
    this.data = blank();
    this._sinceSave = 0;
    this._prevOpp = 'idle';
    this._prevSelf = 'idle';
  }

  /** Load (decayed) from storage; never throws. */
  static load(storage = defaultStorage()) {
    const p = new PlayerProfile(storage);
    try {
      const text = storage?.getItem(PROFILE_KEY);
      if (text) p.data = sanitize(JSON.parse(text));
    } catch { p.data = blank(); }
    p._decay(DECAY_PER_LOAD);
    p.data.fights = Math.min(CAP, p.data.fights + 1);
    return p;
  }

  _decay(f) {
    const d = this.data;
    for (const k of Object.keys(d.strikes)) d.strikes[k] *= f;
    for (const k of Object.keys(d.getUp)) d.getUp[k] *= f;
    for (const k of ['totalT', 'inRangeT', 'blockT', 'ourSwings', 'guardedOurSwings']) d[k] *= f;
    d.range = d.range.map((x) => x * f);
  }

  /** Persist; returns false (and swallows the error) when storage refuses. */
  save() {
    try {
      this.storage?.setItem(PROFILE_KEY, JSON.stringify(this.data));
      return !!this.storage;
    } catch { return false; }
  }

  /** One ai.js tick of the context: tally strikes on their start edge and times. */
  record(ctx) {
    const d = this.data;
    const dt = ctx.dt || 0;
    const opp = ctx.opponentState;
    if (opp !== this._prevOpp) {
      if (opp === 'punch') d.strikes.punch = num(d.strikes.punch + 1);
      else if (opp === 'kick') d.strikes.kick = num(d.strikes.kick + 1);
      else if (opp === 'charge') d.strikes.coil = num(d.strikes.coil + 1);
    }
    // Our own swing starting is the moment "did they have the guard up" is asked.
    const self = ctx.selfState;
    if (self !== this._prevSelf && (self === 'punch' || self === 'kick')
        && ctx.distance < ctx.kickRange * 1.25) {
      d.ourSwings = num(d.ourSwings + 1);
      if (opp === 'block') d.guardedOurSwings = num(d.guardedOurSwings + 1);
    }
    this._prevOpp = opp;
    this._prevSelf = self;

    d.totalT = num(d.totalT + dt);
    const inRange = ctx.distance < ctx.kickRange * 1.25;
    if (inRange) {
      d.inRangeT = num(d.inRangeT + dt);
      if (opp === 'block') d.blockT = num(d.blockT + dt);
    }
    const bin = ctx.distance < ctx.kickRange * 0.4 ? 0 : ctx.distance < ctx.kickRange * 0.71 ? 1 : 2;
    d.range[bin] = num(d.range[bin] + dt);

    this._sinceSave += dt;
    if (this._sinceSave >= SAVE_EVERY_SECS) { this._sinceSave = 0; this.save(); }
  }

  /** Game hook: how the human got up from the canvas ('plain' | 'guard' | 'roll' | 'strike'). */
  noteGetUp(choice) {
    if (choice in this.data.getUp) this.data.getUp[choice] = num(this.data.getUp[choice] + 1);
  }

  /** 0..1 share of in-range time spent guarding (0 with too little evidence). */
  guardRate() {
    const d = this.data;
    return d.inRangeT < 3 ? 0 : Math.min(1, d.blockT / d.inRangeT);
  }

  /** Human swings per second (0 with too little evidence). */
  swingRate() {
    const d = this.data;
    return d.totalT < 5 ? 0 : (d.strikes.punch + d.strikes.kick + d.strikes.coil) / d.totalT;
  }

  /** Share of the human's swings that were coils, kicks, punches (each 0..1). */
  strikeMix() {
    const s = this.data.strikes;
    const n = s.punch + s.kick + s.coil;
    return n < 4 ? { punch: 0, kick: 0, coil: 0 } : { punch: s.punch / n, kick: s.kick / n, coil: s.coil / n };
  }

  /** Chance the human is already guarding when we swing (0..1). */
  guardAtOurSwing() {
    const d = this.data;
    return d.ourSwings < 4 ? 0 : d.guardedOurSwings / d.ourSwings;
  }

  /** The range bin the human lives in: 0 close, 1 mid, 2 far (null when unknown). */
  favouriteRange() {
    const r = this.data.range;
    const sum = r[0] + r[1] + r[2];
    if (sum < 5) return null;
    return r.indexOf(Math.max(...r));
  }

  /**
   * Starting values for ai.js's decayed habit counters (obsT, oppBlockT, clockT,
   * oppAtkN), worth `secs` of observation at weight `w` (0 = ignore the profile).
   */
  seed(w, secs = 3) {
    if (w <= 0 || this.data.fights < 1) return null;
    const t = secs * w;
    const guard = Math.max(this.guardRate(), this.guardAtOurSwing() * 0.7);
    if (this.data.inRangeT < 3 && this.data.ourSwings < 4) return null;
    return { obsT: t, oppBlockT: t * guard, clockT: t, oppAtkN: t * this.swingRate() };
  }
}
