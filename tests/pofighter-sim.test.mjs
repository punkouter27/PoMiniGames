// node --test tests/pofighter-sim.test.mjs
// The practice-room rules, driven against the shipped fighter data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORLD, ATTACKS, createState, reset, step, frameAt, maxX }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/sim.js';

const data = JSON.parse(readFileSync(
    new URL('../src/PoMiniGames.Client/wwwroot/data/pofighter/p1.json', import.meta.url), 'utf8'));
const NONE = { left: false, right: false, up: false, down: false, attack: null };
const DT = 1 / 60;

function runFor(state, input, seconds) {
    for (let t = 0; t < seconds; t += DT) step(state, input, DT, data);
    return state;
}
function atBag() {
    return runFor(createState(), { ...NONE, right: true }, 3);
}

test('the fighter data has an idle stance and every practice move', () => {
    for (const move of ['idle', 'walkF', 'walkB', 'crouch', 'jump', ...ATTACKS]) {
        assert.ok(data.moves[move]?.frames.length > 0, move);
    }
    for (const attack of ATTACKS) assert.ok(data.moves[attack].hitMin > 0, attack);
});

test('walking stops at the bag and at the left edge, and releasing returns to idle', () => {
    const s = atBag();
    assert.equal(s.x, maxX());
    assert.equal(s.move, 'walkF');
    step(s, NONE, DT, data);
    assert.equal(s.move, 'idle');
    runFor(s, { ...NONE, left: true }, 5);
    assert.equal(s.x, WORLD.minX);
});

test('opposite directions cancel out', () => {
    const s = runFor(createState(), { ...NONE, left: true, right: true }, 0.5);
    assert.equal(s.move, 'idle');
    assert.equal(s.x, WORLD.startX);
});

test('each attack next to the bag scores exactly one hit', () => {
    for (const attack of ATTACKS) {
        const s = atBag();
        step(s, { ...NONE, attack }, DT, data);
        runFor(s, NONE, 1.5);
        assert.equal(s.hits, 1, attack);
        assert.equal(s.move, 'idle', attack);
    }
});

test('an attack out of reach scores nothing', () => {
    for (const attack of ATTACKS) {
        const s = createState();
        step(s, { ...NONE, attack }, DT, data);
        runFor(s, NONE, 1.5);
        assert.equal(s.hits, 0, attack);
    }
});

test('an attack cannot be cancelled by walking or by another attack', () => {
    const s = createState();
    step(s, { ...NONE, attack: 'kick' }, DT, data);
    runFor(s, { ...NONE, left: true, attack: 'punchMid' }, 0.2);
    assert.equal(s.move, 'kick');
    assert.equal(s.x, WORLD.startX);
});

test('jump beats an attack pressed with it, lifts off, and lands back in idle', () => {
    const s = createState();
    step(s, { ...NONE, up: true, attack: 'kick' }, DT, data);
    assert.equal(s.move, 'jump');
    let peak = 0;
    for (let t = 0; t < 1.5; t += DT) { step(s, NONE, DT, data); peak = Math.max(peak, s.lift); }
    assert.ok(peak > WORLD.jumpLift * 0.9);
    assert.equal(s.move, 'idle');
    assert.equal(s.lift, 0);
    assert.equal(s.hits, 0);
});

test('crouch holds while down is held and blocks walking', () => {
    const s = runFor(createState(), { ...NONE, down: true, right: true }, 1);
    assert.equal(s.move, 'crouch');
    assert.equal(s.x, WORLD.startX);
    const def = data.moves.crouch;
    assert.equal(frameAt(def, s.t).index, def.frames.length - 1);
    step(s, NONE, DT, data);
    assert.equal(s.move, 'idle');
});

test('a move missing from the fighter shows the idle stance', () => {
    const partial = { ...data, moves: { idle: data.moves.idle } };
    const s = createState();
    for (let i = 0; i < 30; i++) step(s, { ...NONE, right: true, attack: 'kick' }, DT, partial);
    assert.equal(s.move, 'idle');
});

test('reset returns the fighter to the start and the counter to zero', () => {
    const s = atBag();
    step(s, { ...NONE, attack: 'kick' }, DT, data);
    runFor(s, NONE, 1);
    assert.equal(s.hits, 1);
    reset(s);
    assert.deepEqual(s, createState());
});
