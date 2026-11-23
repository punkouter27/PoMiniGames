// rounds.js — three-round bookkeeping for the modes a human fights in (1P ladder
// and 2P local). Pure: the engine (cinematics.js _roundOver) feeds it each round's
// winner and asks whether the match is over. The Cup, online and the training room
// stay single-round and never build one of these.
//
// Like a real bout: all MAX_ROUNDS rounds are fought, each scored on health at the
// bell (a bell too close to call is a drawn round and nobody's point), unless a KO
// (counted out, or health gone) ends the WHOLE match on the spot. After the last
// bell the fighter ahead on rounds takes it, and level on rounds is a draw.

export const MAX_ROUNDS = 3;

/**
 * One fighter's scorecard for one round. game.js spawns every fighter with a fresh one, so
 * the shape lives here once.
 *   hits / thrown      strikes landed / started (a landed grab is a hit, an attempt is thrown)
 *   blocks / perfects  guards that stopped a strike / of those, the ones timed on the wind-up
 *   kicks, coils       how many of `thrown` were kicks / were charged past half
 *   grabs, guardBreaks grabs landed / of those, the ones that took a held guard
 *   taunts             taunts finished
 *   gassed             times the energy bar ran dry
 *   crateHits          times this fighter was chipped by a crate or a turnbuckle
 *   taken              health lost, by where it landed
 *   lowHp              the lowest the health bar got
 *   phraseHits         CPU only: hits landed out of each signature phrase, by its index
 *   finisher           the blow that ended the round: 'punch' | 'kick' | 'counter' | 'wakeup'
 */
export const blankStats = () => ({
  hits: 0, blocks: 0, biggestHit: 0, bestCombo: 0, knockdowns: 0,
  thrown: 0, perfects: 0, kicks: 0, coils: 0, grabs: 0, guardBreaks: 0, taunts: 0, gassed: 0,
  crateHits: 0, taken: { head: 0, torso: 0, arms: 0, legs: 0 }, lowHp: 100, phraseHits: {},
  finisher: null,
});

// The counts a match adds up across its rounds (bests take the max; the rest stay per round).
const SUMMED = ['hits', 'blocks', 'knockdowns', 'thrown', 'perfects', 'grabs', 'taunts', 'gassed'];

/** A fresh match: no rounds played. */
export function newMatch() {
  return {
    wins: [0, 0],
    played: 0,
    /** Per-round winners in order (1, 2, or 0 for a drawn round). */
    log: [],
    /** How each round ended, in order: { winner, ko, secs } (secs = the round clock at the finish). */
    rounds: [],
    /** The scorecard summed over every round played, per corner. */
    stats: [blankStats(), blankStats()],
  };
}

/**
 * Record a finished round. `winner` is 1, 2 or 0 (drawn round); `stats` is the two
 * fighters' round scorecards, folded into the match totals (counts add, bests max).
 */
export function recordRound(match, winner, stats = null, { ko = false, secs = 0 } = {}) {
  match.played += 1;
  match.log.push(winner === 1 || winner === 2 ? winner : 0);
  match.rounds.push({ winner: winner === 1 || winner === 2 ? winner : 0, ko: !!ko, secs });
  if (winner === 1 || winner === 2) match.wins[winner - 1] += 1;
  if (stats) {
    for (let i = 0; i < 2; i++) {
      const t = match.stats[i], s = stats[i] || {};
      for (const k of SUMMED) t[k] += s[k] || 0;
      for (const r of Object.keys(t.taken)) t.taken[r] += s.taken?.[r] || 0;
      t.biggestHit = Math.max(t.biggestHit, s.biggestHit || 0);
      t.bestCombo = Math.max(t.bestCombo, s.bestCombo || 0);
    }
  }
  return match;
}

/**
 * Is the match over? Null while there is another round to fight, otherwise
 * `{ winner }` with 1, 2 or 0 (a drawn match).
 */
export function matchVerdict(match) {
  const [a, b] = match.wins;
  const last = match.rounds[match.rounds.length - 1];
  if (last?.ko && last.winner) return { winner: last.winner };
  if (match.played >= MAX_ROUNDS) return { winner: a === b ? 0 : a > b ? 1 : 2 };
  return null;
}

/**
 * The fastest-KO board's number: the round clock of a ROUND ONE knockout by `corner`, or 0 when
 * round one was not theirs by KO. Later rounds never count — the opponent is fresh in the first.
 */
export function firstRoundKo(match, corner) {
  const r = match.rounds[0];
  return r && r.ko && r.winner === corner ? r.secs : 0;
}

/** Would a round won by `winner` (by KO when `ko`) end the match? (Decides whether the KO gets its replay.) */
export function wouldDecide(match, winner, ko = false) {
  const w = winner === 1 || winner === 2 ? winner : 0;
  const next = { wins: [...match.wins], played: match.played + 1, rounds: [...match.rounds, { winner: w, ko }] };
  if (w) next.wins[w - 1] += 1;
  return matchVerdict(next) !== null;
}

/** The splash heading for the round about to start. */
export function roundLabel(match) {
  const n = match.played + 1;
  if (n >= MAX_ROUNDS) return 'FINAL ROUND';
  return `ROUND ${n} OF ${MAX_ROUNDS}`;
}
