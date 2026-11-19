// pofighter/bracket.js — the 16-slot single-elimination tournament. Pure: no DOM, no clock, so
// tests/pofighter-bracket.test.mjs drives it directly.
//
// Every roster slot enters. Real fighters are seeded by rating (best first) into the standard
// 16-seed order, so the top two can only meet in the final; EMPTY slots take the bottom seeds
// and forfeit — their opponent advances on a bye, and EMPTY vs EMPTY sends an EMPTY on (which
// then forfeits to whoever it meets). Only bouts between two real fighters are fought.

export const SIZE = 16;
// Seed numbers (1 = best) in bracket order: 1v16, 8v9, 4v13, 5v12, 2v15, 7v10, 3v14, 6v11.
export const SEED_ORDER = [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11];
export const ROUND_NAMES = ['Round of 16', 'Quarterfinals', 'Semifinals', 'Final'];

/**
 * roster: [{ id, name, empty? }] (16 slots); ratings: { [id]: elo } (missing = 1500).
 * Returns { rounds: [[match]], champion: null }, match = { a, b, winner, bye, round, index }.
 */
export function createBracket(roster, ratings = {}) {
    const elo = f => ratings[f.id] ?? 1500;
    const real = roster.filter(f => !f.empty).sort((x, y) => elo(y) - elo(x) || x.name.localeCompare(y.name));
    const empties = roster.filter(f => f.empty);
    const bySeed = [...real, ...empties].slice(0, SIZE);
    while (bySeed.length < SIZE) bySeed.push({ id: `empty-${bySeed.length + 1}`, name: 'EMPTY', empty: true });
    const slots = SEED_ORDER.map(seed => ({ ...bySeed[seed - 1], seed }));

    const rounds = [];
    let size = SIZE / 2;
    for (let r = 0; size >= 1; r++, size /= 2) {
        rounds.push(Array.from({ length: size }, (_, index) => ({ round: r, index, a: null, b: null, winner: null, bye: false })));
    }
    rounds[0].forEach((m, i) => { m.a = slots[i * 2]; m.b = slots[i * 2 + 1]; });
    const bracket = { rounds, champion: null };
    settleByes(bracket);
    return bracket;
}

function advance(bracket, match, winner) {
    match.winner = winner;
    const next = bracket.rounds[match.round + 1];
    if (!next) { bracket.champion = winner.empty ? null : winner; return; }
    const target = next[Math.floor(match.index / 2)];
    if (match.index % 2 === 0) target.a = winner; else target.b = winner;
}

// Decide every match that has both sides and at least one EMPTY: those are byes, never fought.
function settleByes(bracket) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const round of bracket.rounds) {
            for (const m of round) {
                if (m.winner || !m.a || !m.b || !(m.a.empty || m.b.empty)) continue;
                m.bye = true;
                advance(bracket, m, m.a.empty ? m.b : m.a);
                changed = true;
            }
        }
    }
}

/** The next bout to fight (two real fighters, undecided), or null when the tournament is over. */
export function nextBout(bracket) {
    for (const round of bracket.rounds) {
        for (const m of round) if (!m.winner && m.a && m.b && !m.a.empty && !m.b.empty) return m;
    }
    return null;
}

/** Record a fought bout. A draw game is settled for the higher seed (lower seed number). */
export function recordResult(bracket, match, winnerId) {
    if (match.winner) throw new Error('bout already decided');
    const winner = winnerId === match.a.id ? match.a : winnerId === match.b.id ? match.b
        : (match.a.seed <= match.b.seed ? match.a : match.b);
    advance(bracket, match, winner);
    settleByes(bracket);
    return winner;
}

/** True once no bout is left to fight. */
export const isOver = bracket => nextBout(bracket) === null;
