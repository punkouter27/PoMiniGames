// grandprix.js — the Grand Prix: every course in turn, points for the top GP_POINTS.length of
// each round, and one table across all of them. A map is chosen when the engine is built, so each
// round is a NEW Game; the table therefore lives here, at module level, and outlives them.
// Rivals keep their index (and their personality, rivals.js) from round to round, so the table is
// the whole 101-marble field's, not just yours.
import { update as updateSave } from './store.js';

/** Points for 1st..10th in a round. Anything lower, or leaving the race, scores nothing. */
export const GP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

let state = null;   // { rounds, round, scored, points: Int32Array, places: Int32Array }

/**
 * Enter round `round` (1-based) of `rounds`. Round 1 always starts a fresh table; a later round
 * keeps it (and starts one anyway if there is none, e.g. after a page reload).
 */
export function gpBegin(round, rounds, count) {
  if (round <= 1 || !state || state.rounds !== rounds || state.points.length !== count) {
    state = { rounds, round: 0, scored: 0, points: new Int32Array(count), places: new Int32Array(count) };
  }
  state.round = round;
  return state;
}

/**
 * Score one finished round. `order` is the final leaderboard (marbles with `index`, in place
 * order); a marble that is not in it left the race. Scoring the same round twice (an engine
 * reload after the result) is a no-op.
 * @returns {{ round, rounds, gained, points, rank, final, top: {index, points}[] }} for `me`
 */
export function gpScore(order, me, count) {
  const st = state || gpBegin(1, 1, count);
  let gained = 0;
  if (st.scored < st.round) {
    st.scored = st.round;
    const seen = new Uint8Array(count);
    order.forEach((m, i) => {
      seen[m.index] = 1;
      const pts = i < GP_POINTS.length ? GP_POINTS[i] : 0;
      st.points[m.index] += pts;
      st.places[m.index] += i + 1;
      if (m.index === me) gained = pts;
    });
    // Out of the race: no points, and the worst place on the tiebreak.
    for (let i = 0; i < count; i++) if (!seen[i]) st.places[i] += count + 1;
  }
  // Most points first; level on points, the better run of places.
  const table = Array.from({ length: count }, (_, i) => i)
    .sort((a, b) => st.points[b] - st.points[a] || st.places[a] - st.places[b] || a - b);
  const rank = table.indexOf(me) + 1;
  const final = st.round >= st.rounds;
  if (final && me >= 0) {
    updateSave((s) => {
      const gp = s.gp ||= { best: 0, bestRank: 0 };
      if (st.points[me] > gp.best) gp.best = st.points[me];
      if (!gp.bestRank || rank < gp.bestRank) gp.bestRank = rank;
    });
  }
  return {
    round: st.round, rounds: st.rounds, gained, points: me >= 0 ? st.points[me] : 0, rank, final,
    top: table.slice(0, 5).map((i) => ({ index: i, points: st.points[i] })),
  };
}
