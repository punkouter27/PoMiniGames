// node --test tests/pofighter-humans.test.mjs
// The fight rules with people in them: human corners (arcade, 2P), combos, ducking, mirror
// palettes and CPU difficulty — versus.js driven against the shipped roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ARENA, COMBO_WINDOW, MAX_HP, createMatch, stepMatch, setInput }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/versus.js';

const load = id => JSON.parse(readFileSync(
    new URL(`../src/PoMiniGames.Client/wwwroot/data/pofighter/${id}.json`, import.meta.url), 'utf8'));
const nick = { id: 'p1', name: 'Nick', data: load('p1') };
const kim = { id: 'kim', name: 'Kim', data: load('kim') };
const DT = 1 / 60;
const NONE = { left: false, right: false, up: false, down: false, attack: null };

function toFight(m) {
    for (let t = 0; t < 20 && m.phase !== 'fight'; t += DT) stepMatch(m, DT);
    assert.equal(m.phase, 'fight');
}

/** Steps with fixed inputs per corner (null = leave that corner alone) and collects the events. */
function play(m, seconds, inputs) {
    const events = [];
    for (let t = 0; t < seconds; t += DT) {
        inputs.forEach((input, i) => { if (input) setInput(m, i, input); });
        events.push(...stepMatch(m, DT));
    }
    return events;
}

test('a human corner walks where its controls say and never thinks for itself', () => {
    const m = createMatch([{ ...nick, control: 'human' }, kim], 4, { rematch: false });
    toFight(m);
    const [me] = m.fighters;
    const x0 = me.x;
    play(m, 0.5, [{ ...NONE, right: true }, null]);
    assert.equal(me.move, 'walkF');
    assert.ok(me.x > x0, 'walked toward the foe');
    play(m, 0.3, [NONE, null]);
    assert.equal(me.plan, 'idle', 'no CPU plan on a human corner');
    play(m, 0.3, [{ ...NONE, left: true }, null]);
    assert.equal(me.move, 'walkB', 'holding away walks back (the block)');
});

test('a press during a swing is buffered, and Kim (no filmed jump) jumps on a computed arc', () => {
    const m = createMatch([{ ...kim, control: 'human' }, { ...nick, control: 'human' }], 6, { rematch: false });
    toFight(m);
    const [k] = m.fighters;
    play(m, DT, [{ ...NONE, up: true }, NONE]);
    assert.equal(k.move, 'jump');
    assert.ok(k.air, 'in the air');
    play(m, 1.2, [NONE, NONE]);
    assert.equal(k.air, null, 'landed');
    play(m, DT, [{ ...NONE, attack: 'kick' }, NONE]);
    assert.equal(k.move, 'kick');
    play(m, 0.25, [NONE, NONE]);
    play(m, DT, [{ ...NONE, attack: 'punchMid' }, NONE]);   // pressed mid-kick
    play(m, 0.6, [NONE, NONE]);
    assert.ok(['punchMid', 'idle'].includes(k.move));
    assert.equal(k.bufferT, 0, 'the buffered punch came out (or expired), it does not linger');
});

test('two hits inside the combo window chain: a combo event, and the second hit does less', () => {
    const m = createMatch([{ ...nick, control: 'human' }, { ...kim, control: 'human' }], 8, { rematch: false });
    toFight(m);
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;   // in range, the defender at the wall
    const hits = [], combos = [];
    for (let t = 0; t < 3 && hits.length < 2; t += DT) {
        setInput(m, 0, { ...NONE, attack: a.move === 'idle' ? 'punchMid' : null });
        setInput(m, 1, NONE);
        for (const e of stepMatch(m, DT)) {
            if (e.type === 'hit') hits.push(e);
            if (e.type === 'combo') combos.push(e);
        }
    }
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map(h => h.combo), [1, 2]);
    assert.ok(hits[1].damage < hits[0].damage, `${hits[1].damage} < ${hits[0].damage}`);
    assert.deepEqual(combos.map(c => c.count), [2]);
    assert.equal(b.hp, MAX_HP - hits[0].damage - hits[1].damage);
    play(m, COMBO_WINDOW + 0.1, [NONE, NONE]);
    assert.equal(a.combo, 0, 'the chain drops once the window passes');
});

test('crouching ducks a punch, but a kick still lands', () => {
    const m = createMatch([{ ...nick, control: 'human' }, { ...kim, control: 'human' }], 2, { rematch: false });
    toFight(m);
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;
    const duck = { ...NONE, down: true };
    let events = play(m, DT, [{ ...NONE, attack: 'punchMid' }, duck]);
    events = events.concat(play(m, 0.8, [NONE, duck]));
    assert.equal(b.move, 'crouch');
    assert.ok(!events.some(e => e.type === 'hit'), 'the punch whiffed');
    events = play(m, DT, [{ ...NONE, attack: 'kick' }, duck]).concat(play(m, 0.8, [NONE, duck]));
    assert.ok(events.some(e => e.type === 'hit' && e.move === 'kick'));
});

test('a mirror match gives the second corner an alternate palette', () => {
    assert.deepEqual(createMatch([nick, nick], 1).fighters.map(f => f.palette), [0, 1]);
    assert.deepEqual(createMatch([nick, { ...nick, palette: 1 }], 1).fighters.map(f => f.palette), [0, 1]);
    assert.deepEqual(createMatch([{ ...nick, palette: 1 }, { ...nick, palette: 1 }], 1).fighters.map(f => f.palette), [1, 2]);
    assert.deepEqual(createMatch([nick, kim], 1).fighters.map(f => f.palette), [0, 0]);
});

test('a hard CPU blocks more than an easy one against the same attacks', () => {
    const blocks = difficulty => {
        let n = 0;
        for (const seed of [1, 2, 3, 4, 5]) {
            const m = createMatch([nick, kim], seed, { rematch: false, difficulty });
            for (let t = 0; t < 400 && m.phase !== 'done'; t += DT) n += stepMatch(m, DT).filter(e => e.type === 'block').length;
        }
        return n;
    };
    assert.ok(blocks('hard') > blocks('easy'));
});
