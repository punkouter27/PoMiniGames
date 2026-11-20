// tactics.js — how the CPU picks a tactic in neutral (layer 2 of ai.js).
//
// Two small pieces, both pure so they run headless:
//
//   1. A behaviour tree per ARCHETYPE (aggressor / counter-puncher / turtle). It reads
//      a handful of facts about the moment and answers with a *stance*: a bias per
//      tactic family. The tree only chooses which family the CPU prefers; it never
//      throws a punch itself.
//   2. A utility scorer. Each candidate tactic (attack, guard, retreat, circle,
//      charge, bait, punish, grab) gets a score from health, energy, distance, rope
//      proximity, mood and the predictor, times the stance bias. ai.js picks one by
//      weighted choice. The difficulty rung stays the dial: the caller passes in the
//      rung's own weights (`base`) and this only reshapes them for the situation.

export const TACTICS = ['attack', 'guard', 'retreat', 'circle', 'charge', 'bait', 'punish', 'grab'];

// ── tiny behaviour tree ──────────────────────────────────────────────────────
// A node is a function (facts) => stance | null. null = failure, a stance = success.
/** First child that succeeds. */
export const selector = (...kids) => (f) => {
  for (const k of kids) { const r = k(f); if (r) return r; }
  return null;
};
/** All conditions must hold; the last node's stance is the result. */
export const sequence = (...kids) => (f) => {
  let r = null;
  for (const k of kids) { r = k(f); if (!r) return null; }
  return r;
};
/** Succeeds (with an empty stance) when the predicate holds. */
export const condition = (pred) => (f) => (pred(f) ? {} : null);
/** Leaf: succeeds with this stance. */
export const stance = (name, bias) => () => ({ name, bias });

// Neutral stance: every family at 1.
const flat = {};

// Facts the trees read (built by `facts`): hurt, ahead, behind, oppGassed, oppStunned,
// oppRecovering, oppTurtling, predSwing (0..1), cornered, late.
const hurt = condition((f) => f.hurt);
const ahead = condition((f) => f.ahead && f.late);
const behind = condition((f) => f.behind && f.late);
const oppOpen = condition((f) => f.oppGassed || f.oppStunned);
const swingComing = condition((f) => f.predSwing > 0.45);
const oppRecovering = condition((f) => f.oppRecovering);
const oppTurtling = condition((f) => f.oppTurtling);

export const ARCHETYPES = {
  // Presses the issue; guards only when hurt, presses harder when behind or when the
  // opponent is open.
  aggressor: selector(
    sequence(hurt, stance('survive', { attack: 0.6, guard: 1.6, retreat: 1.4, punish: 1.2 })),
    sequence(oppOpen, stance('press', { attack: 1.35, charge: 1.6, punish: 1.5, guard: 0.6 })),
    sequence(behind, stance('chase', { attack: 1.3, charge: 1.2, guard: 0.7 })),
    stance('pressure', { attack: 1.2, retreat: 0.7, circle: 0.9, guard: 0.85 }),
  ),
  // Waits for the opponent to commit, then answers: guards and baits on a read,
  // punishes the recovery, otherwise gives ground and circles.
  counter: selector(
    sequence(swingComing, stance('read', { guard: 1.5, bait: 2.2, retreat: 1.4, attack: 0.5 })),
    sequence(oppRecovering, stance('answer', { punish: 2.0, attack: 1.2 })),
    sequence(oppOpen, stance('cash-in', { attack: 1.3, charge: 1.4, punish: 1.4 })),
    stance('wait', { attack: 0.8, circle: 1.35, retreat: 1.1, bait: 1.4 }),
  ),
  // Shell up: a held guard, baits against the opponent's swings, short bursts when
  // they are open or have gassed themselves, hangs on to a lead.
  turtle: selector(
    sequence(ahead, stance('protect', { attack: 0.5, guard: 1.6, retreat: 1.4, circle: 1.2 })),
    sequence(oppOpen, stance('burst', { attack: 1.3, charge: 1.5, punish: 1.5 })),
    sequence(oppTurtling, stance('stalemate', { attack: 0.8, bait: 1.5, circle: 1.3, charge: 0.4, grab: 1.5 })),
    stance('shell', { attack: 0.7, guard: 1.5, bait: 1.6, retreat: 1.1 }),
  ),
};

// Every personality in personalities.js maps to one. Read off their tells:
// walk-in dancers and haymakers press; the long-guard / lure / feint players wait;
// the slow-and-solid ones turtle. `archetypeFor` covers anything unlisted (and BOB).
export const ARCHETYPE_OF = {
  trump: 'aggressor', biden: 'aggressor', bush: 'aggressor', lbj: 'aggressor',
  jfk: 'aggressor', truman: 'aggressor', reagan: 'aggressor',
  obama: 'counter', clinton: 'counter', nixon: 'counter', ford: 'counter', fdr: 'counter',
  bushsr: 'turtle', carter: 'turtle', eisenhower: 'turtle', hoover: 'turtle',
};

/** The archetype name for a president id (aggressor when none / unknown). */
export function archetypeFor(charId) {
  return ARCHETYPE_OF[charId] || 'aggressor';
}

/** The BT stance for an archetype and a facts object. */
export function chooseStance(archetype, facts) {
  return (ARCHETYPES[archetype] || ARCHETYPES.aggressor)(facts) || { name: 'neutral', bias: flat };
}

/**
 * Digest ctx + ai state into the facts the trees read.
 * @param ctx       the per-tick context
 * @param mood      ai.js `_mood(ctx)` result
 * @param predSwing 0..1 chance the human is about to swing (already rung-scaled)
 * @param turtle    ai.js `_turtleRead()` (0..)
 */
export function facts(ctx, mood, predSwing, turtle) {
  const self = ctx.selfHp ?? 1, opp = ctx.opponentHp ?? 1;
  const left = (ctx.timeLimit ?? Infinity) - (ctx.clock ?? 0);
  return {
    hurt: self < 0.3,
    ahead: self - opp > 0.08,
    behind: self - opp < -0.08,
    late: left < 15,
    oppGassed: !!ctx.opponentExhausted,
    oppStunned: Math.max(ctx.opponentHitstunLeft || 0, ctx.opponentBlockStun || 0) > 0.1,
    oppRecovering: !!(ctx.opponentRecover || ctx.opponentActive),
    oppTurtling: turtle > 0.1 || ctx.opponentState === 'block',
    predSwing,
    cornered: (ctx.backRoom ?? 9) < 1.1,
    protect: mood.protect,
  };
}

/**
 * Utility of each tactic right now. `base` is the rung's own weights (attack, guard,
 * space, charge, bait, punish — already scaled by aggro, blockP, baitP, chargeP,
 * punishP, mood and habit reads); this multiplies in the situation.
 *
 * `base.grab` is optional (0 when the fight has no grab, as online and in the self-play harness).
 *
 * @returns {Record<string, number>} non-negative score per tactic in TACTICS
 */
export function scoreTactics(base, ctx, f, st, strength = 1) {
  const selfHp = ctx.selfHp ?? 1;
  const energy = ctx.selfEnergy ?? 1;
  const bias = st.bias || flat;
  const danger = (1 - selfHp) * f.predSwing;               // low health and a swing coming
  const ropeNear = f.cornered || (ctx.ropeDist ?? 9) < 1.6;
  const tired = energy < 0.45;                              // swings are about to gas us
  const sc = {
    // Attacking is worth less when tired, hurt in the face of a swing, or boxed in.
    attack: base.attack * (tired ? 0.55 : 1) * (1 - 0.5 * danger) * (1 + 0.25 * (energy - 0.6)),
    // Guarding rises with a read swing, with low health, and when tired (it refills fastest).
    guard: base.guard * (1 + 2.2 * f.predSwing + 1.2 * (selfHp < 0.35 ? 1 : 0) + (tired ? 0.8 : 0)),
    // Stepping out: a swing read at distance, but never into the ropes.
    retreat: base.space * 0.35 * (1 + 1.5 * f.predSwing + (f.protect ? 0.8 : 0)) * (ropeNear ? 0.15 : 1),
    // Circling: the answer to ropes, and the neutral default.
    circle: base.space * 0.65 * (ropeNear ? 2.2 : 1),
    charge: base.charge * (energy > 0.65 ? 1 : 0.3) * (1 - 0.6 * f.predSwing) * (ctx.opponentState === 'idle' ? 1 : 0.4),
    // A fake opening is likelier when a swing is expected.
    bait: base.bait * (0.5 + 1.5 * f.predSwing),
    // Punish only has a target when the opponent is open.
    punish: f.oppRecovering || f.oppStunned ? base.punish : 0,
    // The grab (constants.js GRAB) only takes a standing fighter, and it costs a swing's
    // energy for a whiff a strike punishes: worth it against a guard, rarely otherwise.
    grab: (base.grab || 0) * (tired ? 0.4 : 1)
      * (ctx.opponentState === 'block' ? 1 : ctx.opponentState === 'idle' ? 0.35 : 0),
  };
  for (const t of TACTICS) sc[t] = Math.max(0, sc[t] * (bias[t] ?? 1) ** strength);
  return sc;
}

/** Weighted choice over scores with a uniform roll in [0,1); null if nothing scores. */
export function pickWeighted(scores, roll) {
  let total = 0;
  for (const t of TACTICS) total += scores[t] || 0;
  if (total <= 0) return null;
  let r = roll * total;
  for (const t of TACTICS) {
    r -= scores[t] || 0;
    if (r < 0) return t;
  }
  return TACTICS[TACTICS.length - 1];
}
