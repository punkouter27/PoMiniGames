// node --test tests/pofighter-versus.test.mjs
// The demo's rules (two CPU fighters, best of three), driven against the shipped roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ARENA, MAX_HP, WINS_NEEDED, HIT_STOP, createMatch, stepMatch, reachOf }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/versus.js';

const load = id => {
    const url = new URL(`../src/PoMiniGames.Client/wwwroot/data/pofighter/${id}.json`, import.meta.url);
    return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null;
};
const nick = load('p1');
const kim = load('kim') ?? nick;   // until Kim's sheet is packed, both corners use Nick
const roster = [{ name: 'Kim', data: kim }, { name: 'Nick', data: nick }];
const DT = 1 / 60;

function runUntil(m, done, seconds = 600) {
    const events = [];
    for (let t = 0; t < seconds && !done(m); t += DT) events.push(...stepMatch(m, DT));
    return events;
}

test('a match opens on the VS card, then calls round one and fights', () => {
    const m = createMatch(roster, 7);
    assert.equal(m.phase, 'vs');
    assert.deepEqual(m.fighters.map(f => f.name), ['Kim', 'Nick']);
    const events = runUntil(m, x => x.phase === 'fight');
    assert.deepEqual(events.filter(e => e.type === 'round'), [{ type: 'round', round: 1 }]);
    assert.ok(m.fighters.every(f => f.hp === MAX_HP));
});

test('the CPUs land hits, and a match ends when someone has two rounds', () => {
    for (const seed of [1, 2, 3]) {
        const m = createMatch(roster, seed);
        const events = runUntil(m, x => x.phase === 'winner');
        assert.equal(m.phase, 'winner', `seed ${seed} finished`);
        assert.ok(events.some(e => e.type === 'hit'), `seed ${seed} landed a hit`);
        const wins = m.fighters.map(f => f.wins);
        if (m.winner === -1) assert.deepEqual(wins, [WINS_NEEDED, WINS_NEEDED]);
        else {
            assert.equal(wins[m.winner], WINS_NEEDED);
            assert.ok(wins[1 - m.winner] < WINS_NEEDED);
        }
        assert.ok(m.round >= 2 && m.round <= 3, `seed ${seed}: ${m.round} rounds`);
    }
});

test('the same seed plays the same match', () => {
    const a = createMatch(roster, 42), b = createMatch(roster, 42);
    runUntil(a, x => x.phase === 'winner');
    runUntil(b, x => x.phase === 'winner');
    assert.equal(a.winner, b.winner);
    assert.deepEqual(a.fighters.map(f => f.hp), b.fighters.map(f => f.hp));
});

test('fighters face each other, never overlap, and stay in the arena', () => {
    const m = createMatch(roster, 5);
    for (let t = 0; t < 120; t += DT) {
        stepMatch(m, DT);
        const [a, b] = m.fighters;
        assert.ok(b.x - a.x >= ARENA.minGap - 0.01 || a.x - b.x >= ARENA.minGap - 0.01);
        for (const f of m.fighters) assert.ok(f.x >= ARENA.minX && f.x <= ARENA.maxX);
    }
});

test('a walking-back fighter blocks: a hit costs one point, not a full blow', () => {
    const m = createMatch(roster, 9);
    runUntil(m, x => x.phase === 'fight');
    const [a, b] = m.fighters;
    // The defender backs into the wall, so the kick (which reaches past the closest gap) lands.
    assert.ok(reachOf(a.data, 'kick') > ARENA.minGap + 30);
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;
    a.think = b.think = 99;   // hold both brains still
    a.plan = 'kick'; b.plan = 'block';
    b.planLeft = 99;
    let kicked = false;
    const events = runUntil(m, () => (kicked ||= a.move === 'kick') && a.move !== 'kick', 3);
    assert.deepEqual(events.filter(e => e.type === 'block').map(e => e.damage), [1]);
    assert.equal(b.hp, MAX_HP - 1);
});

test('after the match card a rematch starts with the corners swapped', () => {
    const m = createMatch(roster, 3);
    runUntil(m, x => x.phase === 'winner');
    runUntil(m, x => x.phase === 'vs');
    assert.equal(m.matchNo, 1);
    assert.deepEqual(m.fighters.map(f => f.name), ['Nick', 'Kim']);
    assert.ok(m.fighters.every(f => f.wins === 0 && f.hp === MAX_HP));
});

test('a tournament bout (no rematch) stops in the done phase after the match card', () => {
    const m = createMatch(roster.map((f, i) => ({ ...f, id: i ? 'p1' : 'kim' })), 11, { rematch: false });
    const events = runUntil(m, x => x.phase === 'done');
    assert.equal(m.phase, 'done');
    assert.equal(m.matchNo, 0);
    assert.equal(events.filter(e => e.type === 'match').length, 1);
    for (let t = 0; t < 10; t += DT) stepMatch(m, DT);
    assert.equal(m.phase, 'done', 'it stays done');
});

test('a landed hit freezes the fight for the hit-stop, then it carries on', () => {
    const m = createMatch(roster, 9);
    runUntil(m, x => x.phase === 'fight');
    let events = [];
    for (let t = 0; t < 30 && !events.some(e => e.type === 'hit'); t += DT) events = stepMatch(m, DT);
    assert.ok(events.some(e => e.type === 'hit'));
    const frozen = { clock: m.clock, xs: m.fighters.map(f => f.x), ts: m.fighters.map(f => f.t) };
    stepMatch(m, DT);
    assert.equal(m.clock, frozen.clock);
    assert.deepEqual(m.fighters.map(f => f.t), frozen.ts);
    for (let t = 0; t < HIT_STOP + 0.05; t += DT) stepMatch(m, DT);
    assert.ok(m.clock < frozen.clock, 'the clock runs again after the hit-stop');
});
