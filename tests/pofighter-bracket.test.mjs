// node --test tests/pofighter-bracket.test.mjs
// The 16-slot tournament: seeding, byes for EMPTY slots, progression to one champion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, createBracket, nextBout, recordResult, isOver }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/bracket.js';

const roster = n => Array.from({ length: SIZE }, (_, i) => i < n
    ? { id: `f${i + 1}`, name: `Fighter ${i + 1}` }
    : { id: `empty-${i + 1}`, name: 'EMPTY', empty: true });

function playOut(bracket, pick = m => m.a.id) {
    const fought = [];
    for (let m = nextBout(bracket); m; m = nextBout(bracket)) { fought.push(m); recordResult(bracket, m, pick(m)); }
    return fought;
}

test('two real fighters skip straight to the final on byes, and the higher rating is seed 1', () => {
    const b = createBracket([{ id: 'p1', name: 'Nick' }, { id: 'kim', name: 'Kim' }, ...roster(0).slice(2)], { kim: 1600, p1: 1500 });
    assert.equal(b.rounds[0].filter(m => m.bye).length, 8);
    const bout = nextBout(b);
    assert.equal(bout.round, 3, 'their first bout is the final');
    assert.deepEqual([bout.a.id, bout.b.id], ['kim', 'p1']);
    recordResult(b, bout, 'p1');
    assert.equal(b.champion.id, 'p1');
    assert.ok(isOver(b));
});

test('a full field fights 15 bouts and every round halves the field', () => {
    const b = createBracket(roster(16));
    const fought = playOut(b);
    assert.equal(fought.length, 15);
    assert.deepEqual([0, 1, 2, 3].map(r => fought.filter(m => m.round === r).length), [8, 4, 2, 1]);
    assert.equal(b.champion.id, 'f1', 'the top seed wins when every bout goes to side a');
});

test('the top two seeds sit in opposite halves', () => {
    const ratings = Object.fromEntries(roster(16).map((f, i) => [f.id, 2000 - i * 10]));
    const b = createBracket(roster(16), ratings);
    const half = id => b.rounds[0].findIndex(m => m.a.id === id || m.b.id === id) < 4 ? 0 : 1;
    assert.notEqual(half('f1'), half('f2'));
});

test('a partly filled field: only real-vs-real bouts are fought, EMPTY never advances past a fighter', () => {
    for (let n = 1; n <= SIZE; n++) {
        const b = createBracket(roster(n));
        const fought = playOut(b, m => m.b.id);
        assert.equal(fought.length, Math.max(0, n - 1), `${n} fighters fight ${n - 1} bouts`);
        assert.ok(fought.every(m => !m.a.empty && !m.b.empty));
        assert.ok(b.champion && !b.champion.empty, `${n}: a real champion`);
    }
});

test('a draw game goes to the higher seed, and a decided bout cannot be recorded twice', () => {
    const b = createBracket(roster(2));
    const bout = nextBout(b);
    assert.equal(recordResult(b, bout, null).seed, 1);
    assert.throws(() => recordResult(b, bout, bout.a.id));
});
