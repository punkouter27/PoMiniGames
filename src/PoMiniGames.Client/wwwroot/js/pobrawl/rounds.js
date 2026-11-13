// rounds.js — best-of-three bookkeeping for the modes a human fights in (1P ladder
// and 2P local). Pure: the engine (cinematics.js _roundOver) feeds it each round's
// winner and asks whether the match is over. The Cup, online and the training room
// stay single-round and never build one of these.
//
// A round is won by KO or on health at the bell; a bell too close to call is a
// drawn round and nobody's point. First to ROUNDS_TO_WIN takes the match. After
// MAX_ROUNDS the fighter ahead on rounds takes it, and level on rounds is a draw.

export const ROUNDS_TO_WIN = 2;
export const MAX_ROUNDS = 3;

const blankStats = () => ({ hits: 0, blocks: 0, biggestHit: 0, bestCombo: 0, knockdowns: 0 });

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
      t.hits += s.hits || 0;
      t.blocks += s.blocks || 0;
      t.knockdowns += s.knockdowns || 0;
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
  if (a >= ROUNDS_TO_WIN) return { winner: 1 };
  if (b >= ROUNDS_TO_WIN) return { winner: 2 };
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

/** Would a round won by `winner` end the match? (Decides whether the KO gets its replay.) */
export function wouldDecide(match, winner) {
  const next = { wins: [...match.wins], played: match.played };
  next.played += 1;
  if (winner === 1 || winner === 2) next.wins[winner - 1] += 1;
  return matchVerdict(next) !== null;
}

/** The splash heading for the round about to start. */
export function roundLabel(match) {
  const n = match.played + 1;
  const [a, b] = match.wins;
  if (n >= MAX_ROUNDS) return 'FINAL ROUND';
  // Someone is one round from the match: say so.
  if (a === ROUNDS_TO_WIN - 1 || b === ROUNDS_TO_WIN - 1) return `ROUND ${n} · MATCH POINT`;
  return `ROUND ${n}`;
}
