import test from 'node:test';
import assert from 'node:assert/strict';
import { createBracket, nextBout, recordResult } from '../src/PoMiniGames.Client/wwwroot/js/pofighter/bracket.js';

const roster = count => Array.from({ length: count }, (_, i) =>
    ({ id: `f${i + 1}`, name: `Fighter ${i + 1}` }));

test('eight seeded fighters play seven bouts to a champion', () => {
    const fighters = roster(8);
    const ratings = Object.fromEntries(fighters.map((fighter, i) => [fighter.id, 1200 - i]));
    const bracket = createBracket(fighters, ratings);
    assert.deepEqual(bracket.rounds.map(round => round.length), [4, 2, 1]);
    assert.deepEqual(bracket.rounds[0].map(match => [match.a.seed, match.b.seed]),
        [[1, 8], [4, 5], [2, 7], [3, 6]]);
    let bouts = 0;
    for (let match = nextBout(bracket); match; match = nextBout(bracket)) {
        recordResult(bracket, match, null);
        bouts++;
    }
    assert.equal(bouts, 7);
    assert.equal(bracket.champion.id, 'f1');
});

test('byes advance fewer than eight fighters to the final', () => {
    const bracket = createBracket(roster(2), { f1: 1200, f2: 1100 });
    const final = nextBout(bracket);
    assert.equal(final.round, 2);
    recordResult(bracket, final, 'f2');
    assert.equal(bracket.champion.id, 'f2');
    assert.equal(nextBout(bracket), null);
});
