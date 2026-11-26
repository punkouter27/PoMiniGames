// pofighter/bracket.js — the 8-slot single-elimination tournament. Pure: no DOM, no clock, so
// tests/pofighter-bracket.test.mjs drives it directly.
//
// Real fighters are seeded by rating (best first) into the standard
// 8-seed order, so the top two can only meet in the final; BYE slots (no player) take the bottom seeds
// and forfeit — their opponent advances on a bye, and BYE vs BYE sends a BYE on (which
// then forfeits to whoever it meets). Only bouts between two real fighters are fought.

export const SIZE = 8;
// Seed numbers (1 = best) in bracket order: 1v8, 4v5, 2v7, 3v6.
export const SEED_ORDER = [1, 8, 4, 5, 2, 7, 3, 6];
export const ROUND_NAMES = ['Quarterfinals', 'Semifinals', 'Final'];

/**
 * roster: [{ id, name, empty? }] (8 slots); ratings: { [id]: elo } (missing = 1000, the board's seed).
 * Returns { rounds: [[match]], champion: null }, match = { a, b, winner, bye, round, index }.
 */
export function createBracket(roster, ratings = {}) {
    const elo = f => ratings[f.id] ?? 1000;   // the server board's seed (PairwiseEloOptions.SeedElo)
    const real = roster.filter(f => !f.empty).sort((x, y) => elo(y) - elo(x) || x.name.localeCompare(y.name));
    const empties = roster.filter(f => f.empty);
    const bySeed = [...real, ...empties].slice(0, SIZE);
    while (bySeed.length < SIZE) bySeed.push({ id: `empty-${bySeed.length + 1}`, name: 'BYE', empty: true });
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

// Decide every match that has both sides and at least one BYE: never fought, the real side advances.
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
