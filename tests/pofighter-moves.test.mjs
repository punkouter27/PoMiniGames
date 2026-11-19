// node --test tests/pofighter-moves.test.mjs
// Frame data, motions and the attacks built on them (moves.js, versus.js) against the shipped roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOVES, frameData, numpad, record, matchMotion, specialFor, MOTION_WINDOW }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/moves.js';
import { ARENA, MAX_HP, createMatch, stepMatch, setInput, liftOf, poseOf }
    from '../src/PoMiniGames.Client/wwwroot/js/pofighter/versus.js';

const load = id => JSON.parse(readFileSync(
    new URL(`../src/PoMiniGames.Client/wwwroot/data/pofighter/${id}.json`, import.meta.url), 'utf8'));
const nick = { id: 'p1', name: 'Nick', data: load('p1') };
const kim = { id: 'kim', name: 'Kim', data: load('kim') };
// Crouch attacks are filmed-only (a sprite is never shrunk); these fighters "have" them filmed.
const withLows = f => ({ ...f, data: { ...f.data, moves: { ...f.data.moves, sweep: f.data.moves.kick, crouchPunch: f.data.moves.punchMid } } });
const DT = 1 / 60;
const NONE = { left: false, right: false, up: false, down: false, attack: null };

const hist = steps => steps.reduce((h, [d, t]) => record(h, d, t), []);

function humans(seed = 3, lows = true) {
    const [a, b] = lows ? [withLows(nick), withLows(kim)] : [nick, kim];
    const m = createMatch([{ ...a, control: 'human' }, { ...b, control: 'human' }], seed, { rematch: false });
    for (let t = 0; t < 20 && m.phase !== 'fight'; t += DT) stepMatch(m, DT);
    assert.equal(m.phase, 'fight');
    return m;
}

function play(m, seconds, inputs) {
    const events = [];
    for (let t = 0; t < seconds; t += DT) {
        inputs.forEach((input, i) => { if (input) setInput(m, i, typeof input === 'function' ? input(t) : input); });
        events.push(...stepMatch(m, DT));
    }
    return events;
}

/** Feeds a motion as numpad directions (facing right), one every `gap` seconds, then a press. */
function motion(m, index, dirs, attack, gap = 0.05) {
    const pad = d => ({ ...NONE, left: [1, 4, 7].includes(d), right: [3, 6, 9].includes(d),
        down: [1, 2, 3].includes(d), up: [7, 8, 9].includes(d) });
    const events = [];
    for (const d of dirs) events.push(...play(m, gap, [index === 0 ? pad(d) : NONE, index === 1 ? pad(d) : NONE]));
    const last = pad(dirs.at(-1));
    events.push(...play(m, DT, [index === 0 ? { ...last, attack } : NONE, index === 1 ? { ...last, attack } : NONE]));
    return events;
}

test('frame data: startup, active and recovery add up to the clip, and a sweep is slower to recover than a jab', () => {
    for (const f of [nick, kim]) {
        for (const move of Object.keys(MOVES)) {
            const fd = frameData(f.data, move);
            assert.ok(fd.startup > 0 && fd.active > 0 && fd.recovery >= 0, `${f.id} ${move}`);
            assert.ok(Math.abs(fd.startup + fd.active + fd.recovery - fd.total) < 1e-9);
        }
        assert.ok(MOVES.sweep.whiff > MOVES.crouchPunch.whiff);
    }
    const custom = { ...nick.data, frameData: { kick: { startup: 6, active: 3, recovery: 12 } } };
    assert.deepEqual(frameData(custom, 'kick'), { startup: 0.1, active: 0.05, recovery: 0.2, total: frameData(nick.data, 'kick').total });
});

test('no move shrinks a fighter: without a filmed crouch attack, down + a button stands up and attacks', () => {
    for (const mv of Object.values(MOVES)) assert.equal(mv.squash, undefined);
    const m = humans(3, false);
    const [a] = m.fighters;
    play(m, DT, [{ ...NONE, down: true, attack: 'kick' }, NONE]);
    assert.equal(a.move, 'kick');
    assert.deepEqual(Object.keys(poseOf(a)), ['lift']);
    const cpu = createMatch([nick, kim], 4, { rematch: false });
    for (let t = 0; t < 120 && cpu.phase !== 'done'; t += DT) {
        stepMatch(cpu, DT);
        for (const f of cpu.fighters) assert.ok(!['sweep', 'crouchPunch'].includes(f.move), 'the CPU never plays a crouch attack it has no clip for');
    }
});

test('numpad directions follow the way the fighter faces', () => {
    assert.equal(numpad({ right: true }, 1), 6);
    assert.equal(numpad({ right: true }, -1), 4);
    assert.equal(numpad({ down: true, left: true }, -1), 3);
    assert.equal(numpad({}, 1), 5);
    assert.equal(numpad({ up: true, right: true }, 1), 9);
});

test('motions: quarter circles, forward-down-forward, keyboard leniency and the time window', () => {
    assert.ok(matchMotion(hist([[5, 0], [2, 0.1], [3, 0.15], [6, 0.2]]), 0.25, 'qcf'));
    assert.ok(matchMotion(hist([[2, 0.1], [6, 0.2]]), 0.25, 'qcf'), 'the diagonal may be skipped');
    assert.ok(matchMotion(hist([[2, 0.1], [1, 0.15], [4, 0.2]]), 0.25, 'qcb'));
    assert.ok(!matchMotion(hist([[2, 0.1], [6, 0.2]]), 0.25 + MOTION_WINDOW, 'qcf'), 'too slow');
    assert.ok(!matchMotion(hist([[6, 0.1], [2, 0.2]]), 0.25, 'qcf'), 'wrong order');
    assert.ok(!matchMotion(hist([[2, 0.1], [6, 0.2], [5, 0.25]]), 0.6, 'qcf'), 'let go of forward too long ago');
    assert.ok(matchMotion(hist([[2, 0.1], [6, 0.2], [5, 0.3]]), 0.35, 'qcf'), 'released forward a beat before the press');
    // Walking forward then forward-down-down-forward is a Rising Fist; ending on forward is a Po Blast.
    assert.equal(specialFor(hist([[6, 0], [5, 0.2], [2, 0.25], [3, 0.3]]), 0.33, 'punch'), 'risingPunch');
    assert.equal(specialFor(hist([[6, 0], [5, 0.2], [2, 0.25], [3, 0.3], [6, 0.35]]), 0.38, 'punch'), 'blast');
    assert.equal(specialFor(hist([[2, 0.1], [6, 0.2]]), 0.25, 'kick'), null, 'a quarter circle forward has no kick special');
    assert.equal(specialFor(hist([[5, 0]]), 0.1, 'punch'), null);
});

test('a quarter circle forward + punch throws one Po Blast that crosses the arena and hits', () => {
    const m = humans();
    const [a, b] = m.fighters;
    a.x = 300; b.x = 800;
    const events = motion(m, 0, [2, 3, 6], 'punchMid').concat(play(m, 2, [NONE, NONE]));
    assert.deepEqual(events.filter(e => e.type === 'special').map(e => e.move), ['blast']);
    assert.equal(events.filter(e => e.type === 'projectile').length, 1);
    const hit = events.find(e => e.type === 'hit');
    assert.ok(hit && hit.move === 'blast', 'the blast landed');
    assert.equal(b.hp, MAX_HP - MOVES.blast.projectile.damage);
    assert.equal(m.projectiles.length, 0);
});

test('two blasts cancel each other out', () => {
    const m = humans();
    const [a, b] = m.fighters;
    a.x = 250; b.x = 900;
    const pad = d => ({ ...NONE, down: d <= 3, right: d === 3 || d === 6 });
    const mirror = d => ({ ...NONE, down: d <= 3, left: d === 3 || d === 6 });
    const events = [];
    for (const d of [2, 3, 6]) events.push(...play(m, 0.05, [pad(d), mirror(d)]));
    events.push(...play(m, DT, [{ ...pad(6), attack: 'punchMid' }, { ...mirror(6), attack: 'punchMid' }]));
    events.push(...play(m, 2, [NONE, NONE]));
    assert.equal(events.filter(e => e.type === 'projectile').length, 2);
    assert.equal(events.filter(e => e.type === 'clash').length, 1);
    assert.ok(!events.some(e => e.type === 'hit'));
});

test('a sweep is low: a standing guard loses to it and gets knocked down, a crouching guard blocks it', () => {
    let m = humans();
    let [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;
    const standGuard = { ...NONE, right: true };   // b faces left: right is back
    let events = play(m, DT, [{ ...NONE, down: true, attack: 'kick' }, standGuard]).concat(play(m, 0.8, [{ ...NONE, down: true }, standGuard]));
    assert.ok(events.some(e => e.type === 'hit' && e.move === 'sweep'));
    assert.ok(events.some(e => e.type === 'knockdown'));

    m = humans();
    [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;
    const lowGuard = { ...NONE, right: true, down: true };
    play(m, 0.1, [NONE, lowGuard]);
    events = play(m, DT, [{ ...NONE, down: true, attack: 'kick' }, lowGuard]).concat(play(m, 0.8, [{ ...NONE, down: true }, lowGuard]));
    assert.ok(events.some(e => e.type === 'block' && e.move === 'sweep'));
    assert.ok(b.hp > MAX_HP - 5);
});

test('a jump-in kick is an overhead: a crouching guard does not stop it', () => {
    const m = humans();
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - 300;
    const lowGuard = { ...NONE, right: true, down: true };
    play(m, DT, [{ ...NONE, up: true, right: true }, lowGuard]);
    assert.ok(a.air, 'jumped forward');
    const events = play(m, 0.25, [NONE, lowGuard]);
    events.push(...play(m, DT, [{ ...NONE, attack: 'kick' }, lowGuard]));
    assert.equal(a.move, 'jumpKick');
    assert.ok(liftOf(a) > 0);
    events.push(...play(m, 1, [NONE, lowGuard]));
    assert.ok(events.some(e => e.type === 'hit' && e.move === 'jumpKick'), 'the jump kick landed through a low guard');
});

test('a whiffed sweep leaves the fighter open for its whiff recovery', () => {
    const m = humans();
    const [a, b] = m.fighters;
    a.x = 200; b.x = 900;
    play(m, DT, [{ ...NONE, down: true, attack: 'kick' }, NONE]);
    assert.equal(a.move, 'sweep');
    play(m, frameData(a.data, 'sweep').total + 0.02, [NONE, NONE]);
    assert.ok(a.lag > 0, 'still recovering after the clip ended');
});

test('the Rising Fist rises, is invulnerable at first and knocks a jumper down', () => {
    const m = humans();
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - 200;
    play(m, DT, [NONE, { ...NONE, up: true, left: true }]);   // b jumps in
    play(m, 0.2, [NONE, NONE]);
    const events = motion(m, 0, [6, 5, 2, 3], 'punchMid', 0.03).concat(play(m, 1.2, [NONE, NONE]));
    assert.ok(events.some(e => e.type === 'special' && e.move === 'risingPunch'));
    assert.ok(events.some(e => e.type === 'knockdown'), 'the jumper was knocked out of the air');
});

test('the first hit of a round is called, and a round won untouched is perfect', () => {
    const m = humans();
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - ARENA.minGap;
    b.hp = 5;
    const events = [];
    for (let t = 0; t < 3 && m.phase === 'fight'; t += DT) {
        setInput(m, 0, { ...NONE, attack: a.move === 'idle' ? 'kick' : null });
        setInput(m, 1, NONE);
        events.push(...stepMatch(m, DT));
    }
    assert.deepEqual(events.filter(e => e.type === 'first').map(e => e.by), [0]);
    const ko = events.find(e => e.type === 'ko');
    assert.equal(ko.winner, 0);
    assert.equal(ko.perfect, true);
    assert.equal(ko.double, false);
});

test('a fighter with a filmed signature throws it with a half circle forward; one without has none', async () => {
    const { specOf, canPlay } = await import('../src/PoMiniGames.Client/wwwroot/js/pofighter/moves.js');
    const sig = { ...nick, data: { ...nick.data, moves: { ...nick.data.moves, signature: nick.data.moves.kick },
        signature: { name: 'Test Slam', button: 'kick', kind: 'rush', damage: 20 } } };
    assert.ok(canPlay(sig.data, 'signature'));
    assert.ok(!canPlay(nick.data, 'signature'), 'nothing until it is filmed');
    assert.equal(specOf(sig.data, 'signature').rush, 520);
    assert.equal(specOf(sig.data, 'signature').name, 'TEST SLAM');

    const m = createMatch([{ ...sig, control: 'human' }, { ...kim, control: 'human' }], 3, { rematch: false });
    for (let t = 0; t < 20 && m.phase !== 'fight'; t += DT) stepMatch(m, DT);
    const [a, b] = m.fighters;
    b.x = ARENA.maxX; a.x = ARENA.maxX - 260;
    const events = motion(m, 0, [4, 1, 2, 3, 6], 'kick', 0.04).concat(play(m, 1.2, [NONE, NONE]));
    assert.deepEqual(events.filter(e => e.type === 'special').map(e => [e.move, e.name]), [['signature', 'TEST SLAM']]);
    const hit = events.find(e => e.type === 'hit');
    assert.ok(hit && hit.move === 'signature' && hit.damage === 20, 'the rush slid in and landed');

    // The same half circle from a fighter with no signature is just a quarter circle: a Po Blast on punch.
    const plain = humans(3, false);
    const ev = motion(plain, 0, [4, 1, 2, 3, 6], 'punchMid', 0.04);
    assert.deepEqual(ev.filter(e => e.type === 'special').map(e => e.move), ['blast']);
});
