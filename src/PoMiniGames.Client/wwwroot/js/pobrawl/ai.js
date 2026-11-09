// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.

import { PERSONALITIES } from './personalities.js';
//
// Three layers decide what the CPU does on a tick, in priority order:
//   1. the signature PHRASE (personalities.js `aiPatterns`) — a fixed script
//      that owns the fighter for a couple of seconds when it opens;
//   2. the frame-data reactions — guard the wind-up until the swing is spent,
//      punish the blocked or whiffed swing, follow up a landed hit, coil at a
//      gassed or stunned opponent — gated by the rung's reaction time;
//   3. the signature FOOTWORK (personalities.js `footwork`) — a fixed cycle of
//      move/orbit beats that fills everything else.
// Layers 1 and 3 are never randomised, so they are learnable; layer 2 is the
// difficulty dial.
//
// Every intent passes through `_ringSafe` last: the CPU knows where the ropes
// are (game.js _aiContext backRoom / sideRoom*), so giving ground near them
// becomes circling out instead of walking itself into the corner.
//
// In-match adaptation over a rolling ~8 s window, scaled by rung:
//   • turtles draw more baits and fewer committed swings (a held guard stops
//     anything from the front, so swinging into it only buys block stun);
//   • spammers get guarded and whiff-punished more often.
// And a read of the scoreboard (`_mood`): hurt → careful, ahead late → protect
// the lead, behind late → press.

// Sixteen rungs for the 1-player presidents ladder. Difficulty is the PRODUCT of
// the columns, so keep each column strictly monotone and lift them together.
//   aggro     — scales how often the AI attacks at all.
//   comboP    — chance a punch is pre-planned as a punch→kick cancel string
//               (also how it follows up a landed hit). Zero at rung 1.
//   chargeP   — how readily this rung commits to a HELD coil instead of a tap.
//   punishGas — chance per opening to load a coil at a gassed opponent.
//   maxCharge — the fullest coil this rung ever throws (0..1 of a full charge).
//               The single biggest damage knob: a full coil is 4× a tap, and
//               an uncapped rung-1 coil was landing 48-80 HP in one hit.
// Rung 1 is tuned so a new player who walks in and mashes wins most fights.
const LEVELS = [
  /*  1 */ { reactionMs: 700, blockP: 0.06, baitP: 0.00, punishP: 0.06, aggro: 0.28, comboP: 0.00, chargeP: 0.05, punishGas: 0.08, maxCharge: 0.15 },
  /*  2 */ { reactionMs: 557, blockP: 0.16, baitP: 0.02, punishP: 0.16, aggro: 0.41, comboP: 0.05, chargeP: 0.10, punishGas: 0.16, maxCharge: 0.24 },
  /*  3 */ { reactionMs: 484, blockP: 0.26, baitP: 0.04, punishP: 0.26, aggro: 0.48, comboP: 0.10, chargeP: 0.16, punishGas: 0.26, maxCharge: 0.34 },
  /*  4 */ { reactionMs: 423, blockP: 0.35, baitP: 0.06, punishP: 0.35, aggro: 0.55, comboP: 0.16, chargeP: 0.20, punishGas: 0.34, maxCharge: 0.40 },
  /*  5 */ { reactionMs: 366, blockP: 0.44, baitP: 0.08, punishP: 0.44, aggro: 0.62, comboP: 0.22, chargeP: 0.24, punishGas: 0.42, maxCharge: 0.46 },
  /*  6 */ { reactionMs: 321, blockP: 0.52, baitP: 0.10, punishP: 0.52, aggro: 0.69, comboP: 0.29, chargeP: 0.28, punishGas: 0.50, maxCharge: 0.52 },
  /*  7 */ { reactionMs: 280, blockP: 0.60, baitP: 0.13, punishP: 0.60, aggro: 0.75, comboP: 0.36, chargeP: 0.32, punishGas: 0.57, maxCharge: 0.58 },
  /*  8 */ { reactionMs: 245, blockP: 0.66, baitP: 0.16, punishP: 0.67, aggro: 0.81, comboP: 0.43, chargeP: 0.36, punishGas: 0.64, maxCharge: 0.64 },
  /*  9 */ { reactionMs: 215, blockP: 0.72, baitP: 0.19, punishP: 0.73, aggro: 0.87, comboP: 0.50, chargeP: 0.40, punishGas: 0.70, maxCharge: 0.70 },
  /* 10 */ { reactionMs: 188, blockP: 0.78, baitP: 0.22, punishP: 0.80, aggro: 0.93, comboP: 0.56, chargeP: 0.44, punishGas: 0.76, maxCharge: 0.76 },
  /* 11 */ { reactionMs: 165, blockP: 0.82, baitP: 0.25, punishP: 0.85, aggro: 0.99, comboP: 0.62, chargeP: 0.47, punishGas: 0.81, maxCharge: 0.82 },
  /* 12 */ { reactionMs: 145, blockP: 0.87, baitP: 0.28, punishP: 0.89, aggro: 1.05, comboP: 0.68, chargeP: 0.50, punishGas: 0.86, maxCharge: 0.88 },
  /* 13 */ { reactionMs: 129, blockP: 0.90, baitP: 0.31, punishP: 0.93, aggro: 1.11, comboP: 0.74, chargeP: 0.53, punishGas: 0.90, maxCharge: 0.93 },
  /* 14 */ { reactionMs: 114, blockP: 0.94, baitP: 0.35, punishP: 0.97, aggro: 1.17, comboP: 0.80, chargeP: 0.56, punishGas: 0.94, maxCharge: 0.97 },
  /* 15 */ { reactionMs: 101, blockP: 0.95, baitP: 0.40, punishP: 0.98, aggro: 1.24, comboP: 0.86, chargeP: 0.60, punishGas: 0.97, maxCharge: 1.00 },
  /* 16 */ { reactionMs: 92, blockP: 0.97, baitP: 0.44, punishP: 0.99, aggro: 1.28, comboP: 0.90, chargeP: 0.62, punishGas: 0.99, maxCharge: 1.00 },
];

const MAX_RUNG = LEVELS.length;

// Habit tracker: exponential decay so recent behavior dominates.
const HABIT_TAU = 8;          // seconds of memory
const TURTLE_THRESHOLD = 0.35; // fraction of in-range time spent blocking
const SPAM_THRESHOLD = 0.5;    // opponent attacks per second

// Longest a footwork signature may keep a fighter out of range before the AI
// closes anyway, so a dance can never stall a round out.
const FOOT_STALL_MAX = 1.0;

// Longest a reactive guard is held. A coil can be held forever; past this the
// guard drops and the decision loop takes over (the coil may be jabbed).
const GUARD_HOLD_MAX = 1.8;

// Ring sense: under this much canvas behind (metres), giving ground becomes
// circling out; a circling direction with less than SIDE_MIN to spare flips.
const ROPE_MARGIN = 1.1;
const SIDE_MIN = 0.7;

// The last stretch of the round the scoreboard read (`_mood`) acts on.
const LATE_SECS = 15;

// How long a press the engine could not take yet (still blocking, stunned,
// recovering) is held for the next idle frame before it is dropped.
const PRESS_WINDOW = 0.3;

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

const NEUTRAL = Object.freeze({ move: 0, side: 0, punch: false, kick: false, block: false });

export class AiController {
  /** difficulty: 1-16 rung number, or 'easy' | 'medium' | 'hard'.
   *  charId: optional president id used to apply personality modifiers. */
  constructor(difficulty, rng = null, charId = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(MAX_RUNG, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    const k = (level - 1) / (MAX_RUNG - 1);   // 0 at rung 1 → 1 at rung 16
    this.level = level;
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
    this.comboP = p.comboP;
    this.punishGasP = p.punishGas;
    this.maxCharge = p.maxCharge;
    // How hard the habit reads bend the weights: level 1 ≈ 0.07, level 15 = 1.
    this.adapt = level / MAX_RUNG;

    // Phrases are written at low-rung tempo; the rung scales execution speed.
    // Dwell 1.02 → 0.76; below ~0.7 the tell itself becomes unreadable.
    this.patTempo = 1.02 - 0.26 * k;
    // Cadence 1.70 → 0.68 on a curve: a phrase opens every ~9 s at rung 1,
    // ~5 s mid-ladder, ~3.5 s at the top. The phrases carry most of a low
    // rung's offence, so the opener must give a new player room between them.
    this.patCadence = 0.68 + 1.02 * (1 - k) * (1 - k);
    // Share of this rung's swings that are kicks: 0.20 → 0.42. A rung-1
    // president mostly jabs — one clean kick is a quarter of the bar.
    this.kickShare = 0.20 + 0.22 * k;

    // Reactive-block reaction floor: how long an opponent's wind-up must be
    // visible before the guard may answer it (the AI reads state, not animation,
    // and a frame-0 guard is always "perfect" under hitResolution.js PERFECT_GUARD_WINDOW).
    // 0.24 s → 0.09 s against punch 0.06 s / kick 0.12 s wind-ups, so:
    //   • nobody can react to a bare jab;
    //   • only rungs 13-15 get under a kick's wind-up;
    //   • a held coil is answerable by anyone, so blockP alone decides it.
    this.reactFloor = 0.24 - 0.15 * k;
    // Once up, the guard is HELD until the swing it answered is spent, then for
    // `guardLinger` more: a top rung drops it the moment the strike is over (to
    // punish), a low rung is slow to trust it. A low rung also sometimes drops
    // it on a fixed beat instead of reading the swing (`guardSloppyP`) — the
    // guess that gets it hit by a delayed release.
    this.guardLinger = 0.08 + 0.18 * (1 - k);
    this.guardSloppyP = 0.35 * (1 - k);
    // Chance per held coil to jab it instead of guarding it: a charging fighter
    // is rooted, and any hit dumps the coil. A top-rung habit.
    this.interruptP = 0.04 + 0.40 * k;
    // Supers per second while one is ready and could fire: rung 1 sits on a
    // full meter for ~5 s on average, rung 16 for under a second.
    this.superRate = 0.2 + 1.1 * k;
    // Engine time the opponent's current wind-up began, or -1 between swings,
    // and whether this rung has already taken its single guard roll on it.
    this._oppWindupSince = -1;
    this._windupRolled = false;

    // Optional additive AI knobs from personalities.js `passiveAiBoost`.
    this.charId = charId;
    this._personalityMods = { blockP: 0, baitP: 0, punishP: 0 };
    if (this.charId && PERSONALITIES[this.charId]?.passiveAiBoost) {
      const b = PERSONALITIES[this.charId].passiveAiBoost;
      this._personalityMods = { ...b };
      // Scaled by rung: a +0.15 boost on a rung-1 guard of 0.08 would triple it.
      this.blockP = Math.min(0.98, this.blockP + (b.blockP || 0) * (0.3 + 0.7 * k));
      this.baitP = Math.min(0.6, this.baitP + (b.baitP || 0) * (0.3 + 0.7 * k));
      this.punishP = Math.min(0.98, this.punishP + (b.punishP || 0) * (0.3 + 0.7 * k));
    }

    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { ...NEUTRAL };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
    // Used to occasionally start a swing then cancel to block on the next decision.
    this.baitArmed = false;
    this.baitStartedAt = 0;
    // Hold-to-charge plan: while holdName is set the AI keeps the button
    // held (the engine charges the attack), releasing at holdUntil or at
    // maxCharge, whichever comes first.
    this.holdName = null;
    this.holdUntil = 0;
    this.holdSince = 0;
    this.chargeP = p.chargeP;
    // The reactive guard: `_guardSince` when it went up (-1 = down),
    // `_guardUntil` the earliest it may drop once the swing is spent.
    this._guardSince = -1;
    this._guardUntil = 0;
    this._guardSloppy = false;
    // One punish roll per block-stun / hitstun window.
    this._stunRolled = false;
    // A queued press (see PRESS_WINDOW): { name, until, combo }.
    this._queued = null;
    // The last two neutral choices, so one move is never picked three times running.
    this._recent = [];
    // Held escape direction off the ropes (+1/−1, 0 = none), with hysteresis.
    this._escSide = 0;
    this.superCooldownUntil = 0;

    // Footwork is deliberately NOT scaled by rung: the dance is who he is, and
    // a tempo that moved with the ladder would invalidate an earlier read.
    this.footwork = (this.charId && PERSONALITIES[this.charId]?.footwork) || null;
    this._footCycle = this.footwork
      ? this.footwork.reduce((s, b) => s + (b.secs || 0.3), 0) : 0;
    // True while in neutral rather than committed to a swing, guard or charge.
    // Only then are the feet refreshed every tick — see `update`.
    this._footLive = true;
    // Engine time we last closed ground; see FOOT_STALL_MAX.
    this._closedAt = 0;
    // `_pat` is the phrase currently playing, `_patReadyAt` when the next may open.
    this._pat = null;
    // Repertoire cursor: walks _unlockedPatterns in a fixed cycle, never random.
    this._patIdx = 0;
    // Stagger the first opening (and desync demo pairings). Seeded RNG, so
    // replays stay deterministic.
    this._patReadyAt = 1.2 + this.rng.random() * 1.5;
    // Pre-planned punch→kick cancel string: fire the kick edge when
    // t reaches comboAt, drop the plan if the window is missed.
    this.comboAt = 0;
    this.comboUntil = 0;
    // Rolling habit counters (exponentially decayed, HABIT_TAU memory).
    this.obsT = 0;       // decayed in-range observation time
    this.oppBlockT = 0;  // decayed in-range time the opponent spent blocking
    this.oppAtkN = 0;    // decayed count of opponent attack starts
    this.clockT = 0;     // decayed total time (normalizer for the attack rate)
    this.prevOppWindup = false;
  }

  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
    // Taking a hit dumps any charge the engine was holding for us, and any plan.
    this.holdName = null;
    this._queued = null;
    this.comboAt = 0;
    this._guardSince = -1;
    // ...and breaks the signature phrase: interrupting it is the reward for reading it.
    this._pat = null;
  }

  /**
   * ctx shape (built by game.js _aiContext):
   *   { dt, distance, kickRange,
   *     opponentState, opponentWindup, opponentActive, opponentRecover,
   *     opponentSwingLeft, opponentCharging, opponentChargeT,
   *     opponentBlockStun, opponentHitstunLeft,       // frame data
   *     selfState, selfCharge, selfExhausted, opponentExhausted, canSuper,
   *     backRoom, sideRoomPos, sideRoomNeg, ropeDist, // ring sense (metres)
   *     selfHp, opponentHp, clock, timeLimit,         // scoreboard
   *     ownAttacks: { punch: {...}, kick: {...} } }
   */
  // Decayed counters: multiply by exp(-dt/tau) each tick, then add this tick's
  // observation, so the read always reflects roughly the last HABIT_TAU seconds.
  _observe(ctx) {
    const decay = Math.exp(-ctx.dt / HABIT_TAU);
    const inRange = ctx.distance < ctx.kickRange * 1.25;
    this.obsT = this.obsT * decay + (inRange ? ctx.dt : 0);
    this.oppBlockT = this.oppBlockT * decay
      + (inRange && ctx.opponentState === 'block' ? ctx.dt : 0);
    this.clockT = this.clockT * decay + ctx.dt;
    this.oppAtkN *= decay;
    if (ctx.opponentWindup && !this.prevOppWindup) {
      this.oppAtkN += 1;
      // The reactive block measures its reaction floor from here.
      this._oppWindupSince = this.t;
      this._windupRolled = false;
    }
    if (!ctx.opponentWindup) this._oppWindupSince = -1;
    this.prevOppWindup = ctx.opponentWindup;
  }

  // 0..1 — how much of recent in-range time the opponent spent blocking.
  _turtleRead() {
    if (this.obsT < 1.5) return 0; // not enough evidence yet
    return Math.max(0, this.oppBlockT / this.obsT - TURTLE_THRESHOLD);
  }

  // Attacks/sec above the spam threshold (0 when calm).
  _spamRead() {
    if (this.clockT < 1.5) return 0;
    return Math.max(0, this.oppAtkN / this.clockT - SPAM_THRESHOLD);
  }

  /**
   * The scoreboard read. Hurt → careful; ahead in the last LATE_SECS →
   * protect the lead (fewer swings, more guard, keep the distance); behind →
   * press (more swings, less guard). Weighted by rung: a rung-1 president
   * barely notices the clock, a rung-15 one fights it.
   */
  _mood(ctx) {
    const w = 0.4 + 0.6 * this.adapt;
    const self = ctx.selfHp ?? 1;
    const lead = self - (ctx.opponentHp ?? 1);
    const left = (ctx.timeLimit ?? Infinity) - (ctx.clock ?? 0);
    const late = left < LATE_SECS ? Math.min(1, 1 - left / LATE_SECS) : 0;
    let aggro = 1;
    let guard = 0;
    let protect = false;
    if (self < 0.3) { aggro *= 1 - 0.2 * w; guard += 0.1 * w; }
    if (late > 0 && lead > 0.08) {
      protect = true;
      aggro *= 1 - 0.45 * late * w;
      guard += 0.15 * late * w;
    } else if (late > 0 && lead < -0.08) {
      aggro *= 1 + 0.5 * late * w;
      guard -= 0.15 * late * w;
    }
    return { aggro, guard, protect };
  }

  // Footwork is keyed off `this.t` alone, so the cycle never resets (not on a
  // hit, phrase or knockdown) — a dance that restarted would be unlearnable.

  /** The beat this president is on right now, or null when it has no dance. */
  _footBeat() {
    if (!this.footwork || this._footCycle <= 0) return null;
    let u = this.t % this._footCycle;
    for (const b of this.footwork) {
      const s = b.secs || 0.3;
      if (u < s) return b;
      u -= s;
    }
    return this.footwork[this.footwork.length - 1];
  }

  /**
   * The beat as a movement intent.
   * @param close true when we are out of range. A retreat beat is clamped to a
   *   hold, and if the dance has kept us out of range past FOOT_STALL_MAX we
   *   close regardless of what the beat says. The orbit component is never
   *   clamped, so the signature still reads at every distance.
   */
  _footIntent(close) {
    const beat = this._footBeat();
    // No signature (BOB, or no charId): walk in with an occasional random arc,
    // give ground in neutral.
    if (!beat) {
      const side = this.rng.random() < 0.18 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      return { move: close ? 1 : -1, side: close ? side : 0 };
    }
    let move = beat.move ?? 0;
    if (close) {
      move = Math.max(0, move);
      if (move > 0) this._closedAt = this.t;
      else if (this.t - this._closedAt > FOOT_STALL_MAX) move = 1;
    } else {
      this._closedAt = this.t;
    }
    return { move, side: beat.side || 0 };
  }

  // ── Signature pattern runner ──────────────────────────────────────────
  // Neither a phrase nor the order phrases play in is randomised — learnability
  // is the design constraint. It stays fair because it only opens in range and
  // off cooldown, a landed hit cancels it (notifyHit), and it is a phrase, not
  // a loop, so there is always recovery after.

  /**
   * How much of this president's repertoire this rung may use. `aiPatterns` is
   * ordered: index 1 is written as the answer to having learned index 0.
   */
  _unlockedPatterns() {
    const all = PERSONALITIES[this.charId]?.aiPatterns;
    if (!all || !all.length) return null;
    // 1..3 → 1 phrase, 4..9 → 2, 10..15 → 3 (clamped to what exists).
    const depth = Math.min(all.length, this.level >= 10 ? 3 : this.level >= 4 ? 2 : 1);
    return all.slice(0, depth);
  }

  _patternDue(ctx) {
    const set = this._unlockedPatterns();
    if (!set || this.holdName || this.t < this.retreatUntil) return false;
    if (this.t < this._patReadyAt) return false;
    // Range gate uses the NEXT phrase's own reach.
    const pat = set[this._patIdx % set.length];
    return ctx.distance < ctx.kickRange * (pat.range || 1.2);
  }

  _startPattern(ctx) {
    const set = this._unlockedPatterns();
    const pat = set[this._patIdx % set.length];
    // Advance on OPEN, not finish: an interrupted phrase still counts as played.
    this._patIdx = (this._patIdx + 1) % set.length;
    this._pat = {
      steps: pat.steps, i: 0, until: 0, fired: false, released: false, tempo: this.patTempo,
    };
    // Cadence runs start-to-start, so the gap a player counts is between openings.
    this._patReadyAt = this.t + (pat.everySecs || 5) * this.patCadence;
    // A phrase supersedes any half-formed plan and owns the feet outright.
    this._footLive = false;
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
    this._queued = null;
    this._guardSince = -1;
  }

  // Returns an intent while the phrase is mid-flight, or null once it ends
  // (letting the normal decision loop resume on the same tick).
  _runPattern(ctx) {
    const p = this._pat;
    const step = p.steps[p.i];
    if (!step) { this._pat = null; return null; }

    // Entering a step: stamp its dwell and let this tick carry the press edge.
    if (p.until === 0) {
      p.until = this.t + (step.secs || 0.2) * p.tempo;
      p.fired = false;
      p.released = false;
    }
    // A coil step lets go early once this rung's maxCharge is in the hand; the
    // rest of the dwell is spent standing in the strike's recovery.
    if (step.act === 'charge' && p.fired && ctx.selfState === 'charge'
        && (ctx.selfCharge ?? 0) >= this.maxCharge) {
      p.released = true;
    }

    const done = this.t >= p.until;
    const out = this._stepIntent(step, p.fired, p.released);
    p.fired = true;

    if (done) {
      p.i += 1;
      p.until = 0;
      // Dropping the held flag when a `charge` step ends releases the strike.
      if (p.i >= p.steps.length) {
        this._pat = null;
        this.sinceDecision = 0;
      }
    }
    return out;
  }

  // One step → one intent. `edgeSpent` suppresses the press edge on every frame
  // after the first: punch/kick are edge-triggered, and re-pressing each frame
  // would restart the swing the moment the engine returned to idle.
  _stepIntent(step, edgeSpent, released = false) {
    const base = { ...NEUTRAL, super: false };
    const atk = step.attack || 'punch';
    switch (step.act) {
      case 'punch':
      case 'kick':
        return edgeSpent ? base : { ...base, [step.act]: true };
      case 'charge': {
        // Press once, then hold; the engine throws when *Held drops
        // (_tickFighter), so the visible coil IS this step's duration.
        if (released) return base;
        const out = { ...base, [atk + 'Held']: true };
        if (!edgeSpent) out[atk] = true;
        return out;
      }
      case 'block':    return { ...base, block: true };
      case 'advance':  return { ...base, move: 1 };
      case 'retreat':  return { ...base, move: -1 };
      // Held for the whole step: `side` is a sustained orbit, not an edge.
      case 'sidestep': return { ...base, side: step.dir || -1 };
      case 'wait':
      default:         return base;
    }
  }

  /**
   * Commit to a held coil and return the intent that starts it. The engine
   * throws the strike when `<name>Held` drops, so the hold IS the visible wind-up.
   *
   * @param kickBias 0..1 chance the coil is a kick rather than a punch.
   * @param spread   seconds of extra hold on top of the 0.45 s base.
   */
  _loadCharge(kickBias, spread) {
    const name = this.rng.random() < kickBias ? 'kick' : 'punch';
    this.holdName = name;
    this.holdSince = this.t;
    this.holdUntil = this.t + 0.45 + this.rng.random() * spread;
    this._footLive = false;   // a loaded coil roots the feet
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
    this._queued = null;
    this.current = { ...NEUTRAL };
    const out = { ...this.current };
    out[name] = true;            // press edge starts the charge
    out[name + 'Held'] = true;   // and the hold keeps it winding
    return out;
  }

  /**
   * A tap of `name`. The engine only takes a press from idle (or a cancel
   * window), so a press made while still guarding or recovering is queued for
   * PRESS_WINDOW and fired on the first idle frame — a punish decided while the
   * guard was up used to be dropped on the floor. `combo` pre-plans the
   * punch→kick cancel string off it.
   */
  _press(ctx, name, combo = false) {
    this.current = { ...NEUTRAL };
    this.baitArmed = false;
    this._footLive = false;
    this._guardSince = -1;
    if (ctx.selfState && ctx.selfState !== 'idle') {
      this._queued = { name, until: this.t + PRESS_WINDOW, combo };
      return { ...this.current };
    }
    this._queued = null;
    if (combo && name === 'punch') {
      this.comboAt = this.t + ctx.ownAttacks.punch.cancelInto.kick + 0.04;
      this.comboUntil = this.comboAt + 0.15;
    }
    return { ...this.current, [name]: true };
  }

  _remember(choice) {
    this._recent.push(choice);
    if (this._recent.length > 2) this._recent.shift();
  }

  // Halved weight for a choice made on both of the last two decisions, so no
  // single move is spammed and the spacing keeps changing.
  _fresh(choice) {
    return this._recent.length === 2 && this._recent[0] === choice && this._recent[1] === choice
      ? 0.4 : 1;
  }

  /**
   * The ring check every intent passes through last. Backing up with no canvas
   * behind becomes circling out toward the open side, a circle into the ropes
   * flips, and while the ropes are close and the opponent is on us the CPU
   * slides out sideways on its own. A coil roots the feet, so none of this
   * touches a fighter that is charging.
   */
  _ringSafe(out, ctx) {
    if (ctx.backRoom === undefined) return out;
    const room = (s) => (s > 0 ? ctx.sideRoomPos : ctx.sideRoomNeg);
    const open = ctx.sideRoomPos >= ctx.sideRoomNeg ? 1 : -1;
    // Hysteresis: keep the chosen escape until well clear of the ropes.
    if (ctx.ropeDist > ROPE_MARGIN + 0.6) this._escSide = 0;
    if (this._escSide && room(this._escSide) < SIDE_MIN * 0.5) this._escSide = 0;
    const pinned = ctx.backRoom < ROPE_MARGIN;
    if (out.move < 0 && pinned) {
      out.move = 0;
      if (!this._escSide) this._escSide = open;
      out.side = this._escSide;
    } else if (pinned && !out.side && ctx.distance < ctx.kickRange * 1.3
        && (ctx.selfState === 'idle' || ctx.selfState === 'block')
        && !out.punch && !out.kick && !out.punchHeld && !out.kickHeld) {
      if (!this._escSide) this._escSide = open;
      out.side = this._escSide;
    }
    if (out.side && room(out.side) < SIDE_MIN) {
      out.side = room(-out.side) > room(out.side) ? -out.side : 0;
    }
    return out;
  }

  update(ctx) {
    return this._ringSafe(this._decide(ctx), ctx);
  }

  _decide(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;
    this._observe(ctx);

    // Habit- and score-adjusted probabilities for this tick; capped so low rungs stay beatable.
    const spam = this._spamRead();
    const turtle = this._turtleRead();
    const mood = this._mood(ctx);
    const effBlockP = Math.max(0, Math.min(0.95, this.blockP + spam * 0.5 * this.adapt + mood.guard));
    const effPunishP = Math.min(0.95, this.punishP + spam * 0.4 * this.adapt);
    const effBaitP = Math.min(0.5, this.baitP + turtle * 0.4 * this.adapt);

    // Edge-triggered flags are consumed each read; holds (move/side/block) persist.
    const intent = { ...this.current, punch: false, kick: false };

    // ── Gassed out ──────────────────────────────────────────────────────
    // The engine refuses attacks until the bar recovers (game.js _canAttack),
    // and blocking refills fastest. Ahead of the pattern runner and charge hold
    // so neither keeps feeding attacks into a closed gate. The back-off goes
    // through _ringSafe like everything else, so a gassed CPU slides along the
    // ropes instead of pinning itself on them.
    if (ctx.selfExhausted) {
      this._pat = null;
      this.holdName = null;
      this._queued = null;
      this.sinceDecision = 0;
      this._footLive = false;   // the dance is off while catching a breath
      const backoff = ctx.distance < ctx.kickRange * 0.9 ? -1 : 0;
      this.current = { ...NEUTRAL, move: backoff, block: true };
      return { ...this.current, super: false };
    }

    // ── Signature pattern ───────────────────────────────────────────
    // A running script owns the fighter until it finishes or is interrupted.
    if (this._pat) {
      const out = this._runPattern(ctx);
      if (out) return out;
    } else if (this._patternDue(ctx)) {
      this._startPattern(ctx);
      const out = this._runPattern(ctx);
      if (out) return out;
    }

    // ── Active charge hold ──────────────────────────────────────────────
    // Keep the button held until holdUntil or this rung's maxCharge, then drop
    // it so the engine throws. If the engine never took the press (we were not
    // idle), stop holding a coil that does not exist.
    if (this.holdName) {
      const lost = ctx.selfState && ctx.selfState !== 'charge' && this.t - this.holdSince > 0.05;
      const full = ctx.selfState === 'charge' && (ctx.selfCharge ?? 0) >= this.maxCharge;
      if (this.t < this.holdUntil && !lost && !full) {
        const out = { ...NEUTRAL, super: false };
        out[this.holdName + 'Held'] = true;
        return out;
      }
      this.holdName = null;
      this.sinceDecision = 0;
      return { ...NEUTRAL, super: false };
    }

    // ── Signature super activation ────────────────────────────────────
    // A per-SECOND rate (superRate) rather than a per-tick roll, which fired
    // within ~100 ms at every rung. Asked only when the engine will take it
    // (ctx.canSuper: idle, meter full), so the cooldown is never spent on a
    // request the guard swallowed. The follow-up swing is queued with it —
    // most supers load the NEXT swing (Biden's arrives fully charged).
    const superReady = ctx.canSuper ?? ctx.superMeterFull;
    if (superReady && this.t >= this.superCooldownUntil && ctx.distance < ctx.kickRange * 1.6
        && this.rng.random() < 1 - Math.exp(-this.superRate * ctx.dt)) {
      this.superCooldownUntil = this.t + 4.0;
      this.current = { ...NEUTRAL };
      this._queued = { name: this.rng.random() < 0.5 ? 'punch' : 'kick', until: this.t + 0.6, combo: false, notBefore: this.t + 0.05 };
      return { ...this.current, super: true };
    }

    // ── Queued press ────────────────────────────────────────────────────
    // Fires on the first idle frame (see _press), or is dropped once stale.
    if (this._queued) {
      const q = this._queued;
      if (this.t > q.until) this._queued = null;
      else if (ctx.selfState === 'idle' && this.t >= (q.notBefore || 0)) {
        this._queued = null;
        this.sinceDecision = 0;
        return this._press(ctx, q.name, q.combo);
      } else {
        return { ...NEUTRAL, super: false };
      }
    }

    // ── Pre-planned cancel string ───────────────────────────────────────
    // Fires outside the reaction gate — it was decided when the punch started.
    if (this.comboAt > 0 && this.t >= this.comboAt) {
      const missed = this.t > this.comboUntil
        || ctx.distance > ctx.kickRange * 1.1;
      this.comboAt = 0;
      this.comboUntil = 0;
      if (!missed) {
        this.current = { ...NEUTRAL };
        this.sinceDecision = 0;
        return { ...this.current, kick: true };
      }
    }

    // ── Reactive guard, held ────────────────────────────────────────────
    // Up until the swing it answered is spent (wind-up, coil and active frames)
    // plus guardLinger — it used to drop on the next decision tick, ~95 ms at
    // rung 16, against coils that wind up for up to a second. A swing that
    // bounces off it leaves the attacker in block stun: drop the guard and
    // punish with the fast string, which lands inside the 0.5 s freeze.
    if (this._guardSince >= 0) {
      if (ctx.opponentBlockStun > 0.12 && ctx.distance < ctx.kickRange * 1.1) {
        if (!this._stunRolled) {
          this._stunRolled = true;
          if (this.rng.random() < effPunishP) {
            this.sinceDecision = 0;
            return this._press(ctx, 'punch', this.rng.random() < Math.max(0.35, this.comboP));
          }
        }
      } else {
        this._stunRolled = false;
      }
      const threat = ctx.opponentWindup || ctx.opponentCharging || ctx.opponentSwingLeft > 0;
      if (threat && !this._guardSloppy) this._guardUntil = Math.max(this._guardUntil, this.t + this.guardLinger);
      if (this.t < this._guardUntil && this.t - this._guardSince < GUARD_HOLD_MAX) {
        this.current = { ...NEUTRAL, block: true };
        return { ...this.current };
      }
      this._guardSince = -1;
      this.current = { ...NEUTRAL };
      this.sinceDecision = 1e9;   // decide on this very tick, while they recover
    }

    // ── Reactive defense ────────────────────────────────────────────────
    // Answer a wind-up once it has been visible for reactFloor. ONE roll per
    // swing, not per tick: per-tick rolls compound over a long coil and make
    // blockP meaningless. A visible coil may instead be jabbed (interruptP).
    const windupSeen = this._oppWindupSince >= 0
      && (this.t - this._oppWindupSince) >= this.reactFloor;
    const guardRange = ctx.kickRange * (ctx.opponentCharging ? 1.7 : 1.25);
    if (windupSeen && !this._windupRolled && ctx.distance < guardRange) {
      this._windupRolled = true;
      const r = this.rng.random();
      if (ctx.opponentCharging && ctx.distance < ctx.kickRange * 0.95 && r < this.interruptP) {
        this.sinceDecision = 0;
        return this._press(ctx, 'punch');
      }
      if (r < effBlockP) {
        this._guardSince = this.t;
        this._guardSloppy = this.rng.random() < this.guardSloppyP;
        this._guardUntil = this.t + (this._guardSloppy ? 0.2 : this.guardLinger);
        this._stunRolled = false;
        this.current = { ...NEUTRAL, block: true };
        this.sinceDecision = 0;
        this._footLive = false;
        this.baitArmed = false;
        this.comboAt = 0;
        this.comboUntil = 0;
        this._queued = null;
        return { ...this.current };
      }
    }

    // ── Footwork between decisions ──────────────────────────────────────
    // The feet run on the engine clock, not the reactionMs decision clock, or
    // short beats would be dropped at low rungs. `_footLive` keeps this from
    // overriding a commitment (swing, guard, bait, charge).
    if (this._footLive && this.footwork) {
      const foot = this._footIntent(ctx.distance > ctx.kickRange);
      this.current.move = foot.move;
      this.current.side = foot.side;
      intent.move = foot.move;
      intent.side = foot.side;
    }

    if (this.sinceDecision < this.reactionMs) return intent;
    this.sinceDecision = 0;

    // ── Anti-stunlock retreat ───────────────────────────────────────────
    // Guard up while giving ground; _ringSafe turns it sideways at the ropes.
    if (this.t < this.retreatUntil) {
      this.current = { ...NEUTRAL, move: -1, block: true };
      this._footLive = false;
      return { ...this.current };
    }

    const inRange = ctx.distance < ctx.kickRange;

    // ── Gas punish ──────────────────────────────────────────────────────
    // A gassed opponent can only guard, so a coil is right either way. Ahead of
    // the hitstun follow-up: hitstun lasts 0.35 s, the gas window lasts seconds.
    if (ctx.opponentExhausted && ctx.distance < ctx.kickRange * 1.15
        && this.rng.random() < this.punishGasP) {
      return this._loadCharge(0.55, 0.55);
    }

    // ── Follow up a stunned opponent ───────────────────────────────────
    // Hitstun is 0.35 s and block stun 0.5 s; a coil takes at least 0.45 s, so
    // the victim was always back up first. The answer is the fast one — a tap,
    // or the punch→kick string, which lands inside the window. One roll per stun.
    const stunLeft = Math.max(ctx.opponentHitstunLeft || 0, ctx.opponentBlockStun || 0);
    if (stunLeft > 0.1 && inRange) {
      if (!this._stunRolled) {
        this._stunRolled = true;
        if (this.rng.random() < effPunishP) {
          this._remember('punch');
          return this._press(ctx, 'punch', this.rng.random() < this.comboP);
        }
      }
    } else if (stunLeft <= 0) {
      this._stunRolled = false;
    }

    // ── Open-guard coil: punish a player who never blocks ──────────────
    // Damped by the turtle read — a coil into a held guard is a gift to it.
    if (ctx.opponentState === 'idle' && inRange
        && this.rng.random() < this.chargeP * 0.5 * mood.aggro * (1 - Math.min(1, turtle * 2))) {
      this._remember('charge');
      return this._loadCharge(0.4, 0.45);
    }

    // ── Out of range: close on this president's own footwork ────────────
    // `side` is a held orbit, so it is stored ON this.current, not the returned copy.
    // Protecting a lead late, the CPU is in no hurry to close.
    if (!inRange) {
      const foot = this._footIntent(true);
      const wait = mood.protect && ctx.distance < ctx.kickRange * 1.8 && this.rng.random() < 0.5;
      this.current = { ...NEUTRAL, move: wait ? 0 : foot.move, side: foot.side };
      this._footLive = !wait;
      this.baitArmed = false;
      return { ...this.current };
    }

    // ── In range: frame-data aware choices ──────────────────────────────
    if (this.baitArmed && (this.t - this.baitStartedAt) > (ctx.ownAttacks.punch.windup + 0.02)) {
      // Cancel the bait into block — looks like the AI feinted.
      this.current = { ...NEUTRAL, block: true };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current };
    }

    if ((ctx.opponentActive || ctx.opponentRecover) && this.rng.random() < effPunishP) {
      // Punch is the fastest move — best for punishing recovery.
      this._remember('punch');
      return this._press(ctx, 'punch', this.rng.random() < this.comboP);
    }

    // The attack share is `aggro` × the scoreboard mood, split punch/kick by
    // kickShare (a low rung throws mostly jabs: a clean kick is a quarter of
    // the bar); guard and spacing take the rest. Against a turtle, swings give
    // way to baits and waiting — a held guard stops anything from the front.
    // A choice taken on both of the last two decisions is damped (_fresh), so
    // no move is spammed.
    const atk = Math.min(0.8, 0.6 * this.aggro * mood.aggro
      * (1 - Math.min(0.6, turtle * 1.2 * this.adapt)));
    const guardW = Math.min(0.3, 0.02 + 0.24 * effBlockP * this.adapt + (mood.protect ? 0.15 : 0));
    const w = {
      punch: atk * (1 - this.kickShare) * this._fresh('punch'),
      kick: atk * this.kickShare * this._fresh('kick'),
      guard: guardW * this._fresh('guard'),
      space: Math.max(0.15, 1 - atk - guardW) * this._fresh('space'),
    };
    const total = w.punch + w.kick + w.guard + w.space;
    let r = this.rng.random() * total;
    if ((r -= w.punch) < 0) {
      this._remember('punch');
      return this._press(ctx, 'punch', this.comboP > 0 && this.rng.random() < this.comboP);
    }
    if ((r -= w.kick) < 0) {
      this._remember('kick');
      return this._press(ctx, 'kick');
    }
    if ((r -= w.guard) < 0) {
      // A guard with intent — or a bait: start a punch, cancel into block next tick.
      this._remember('guard');
      this._footLive = false;
      if (this.rng.random() < effBaitP) {
        this.baitArmed = true;
        this.baitStartedAt = this.t;
        this.current = { ...NEUTRAL };
        return { ...this.current, punch: true };
      }
      // Held for a beat through the reactive-guard machinery, so a swing that
      // bounces off it is punished the same way (it used to drop on the next
      // decision tick — under 100 ms at rung 16, too short to stop anything).
      this._guardSince = this.t;
      this._guardSloppy = false;
      this._guardUntil = this.t + 0.3 + this.rng.random() * 0.3;
      this._stunRolled = false;
      this.current = { ...NEUTRAL, block: true };
      return { ...this.current };
    }
    // Spacing: the signature walks it; without one, vary it — step out, circle
    // to an angle, or hold. Protecting a lead, the CPU prefers stepping out.
    this._remember('space');
    let foot;
    if (this.footwork && !mood.protect) {
      foot = this._footIntent(false);
    } else {
      const s = this.rng.random();
      const orbit = this.rng.random() < 0.5 ? 1 : -1;
      foot = s < (mood.protect ? 0.6 : 0.35) ? { move: -1, side: 0 }
        : s < 0.8 ? { move: 0, side: orbit }
        : { move: 0, side: 0 };
    }
    this.current = { ...NEUTRAL, move: foot.move, side: foot.side };
    this._footLive = !!this.footwork && !mood.protect;
    this.baitArmed = false;
    return { ...this.current };
  }

  dispose() {}
}
