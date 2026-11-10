import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pocapitol/world.js', import.meta.url), 'utf8');
const { createAttempt, advance, fire, setPaused, walkable, milestones, obstacles, columns, seats, selectLeader, CROWD_SIZE } =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function tick(state, input = {}, seconds = 1) {
    for (let i = 0; i < Math.round(seconds * 60); i++) advance(state, input, 1 / 60);
}

test('fresh attempt starts outside with independent opponents and companions', () => {
    const a = createAttempt('standard'), b = createAttempt('standard');
    assert.equal(a.status, 'active');
    assert.equal(a.player.z, 58);
    assert.equal(a.health, 100);
    assert.equal(a.milestone, 0);
    assert.ok(a.enemies.length >= 6);
    assert.equal(a.companions.length, 99);
    assert.equal(a.companions.length + 1, CROWD_SIZE);
    assert.equal(new Set(a.companions.map(c => c.id)).size, 99);
    assert.ok(a.companions.every(c => c.z > 14 && walkable(c.x, c.z) && c.health > 0));
    assert.ok(a.enemies.every(e => e.faction === 'capitol-police'));
    assert.ok(a.enemies.every(e => walkable(e.x, e.z)), 'Police spawned inside scenery');
    a.enemies[0].health = 0;
    assert.equal(b.enemies[0].health, 3);
    assert.throws(() => createAttempt('unknown'), /difficulty/i);
});

test('demo has exactly 100 CPU raiders and no participating human', () => {
    const state = createAttempt('story', true);
    assert.equal(state.demo, true);
    assert.equal(state.companions.length, 100);
    assert.equal(state.companions.filter(c => c.human).length, 0);
    const player = { ...state.player };
    tick(state, { z: -1 }, 1);
    assert.deepEqual(state.player, player);
    assert.equal(fire(state, { x: 0, z: -1 }), null);
});

for (const difficulty of ['story', 'standard']) test(`NPCs navigate, fight police and finish the ${difficulty} demo`, () => {
    const state = createAttempt(difficulty, true);
    const original = state.companions.map(c => ({ ...c }));
    let policeShots = 0, raiderShots = 0;
    for (let i = 0; i < 5400 && state.status === 'active'; i++) {
        advance(state, {}, 1 / 60);
        policeShots += state.projectiles.filter(p => p.faction === 'police').length;
        raiderShots += state.companions.filter(c => c.attacking > 0).length;
        assert.ok(state.companions.every(c => walkable(c.x, c.z)), 'NPC left navigable space');
    }
    assert.ok(policeShots > 0, 'Police never attacked');
    assert.ok(raiderShots > 0, 'NPC raiders never fought');
    assert.ok(state.companions.some((c, i) => c.z < original[i].z - 40));
    assert.equal(state.status, 'completed');
    assert.equal(state.milestone, milestones.length);
    assert.equal(state.companions.length, 100);
});

test('camera leader uses reachable progress, ignores incapacitated raiders, and can switch', () => {
    const state = createAttempt('story', true);
    const [a, b] = state.companions;
    state.companions.forEach(c => { c.health = 0; });
    Object.assign(a, { health: 30, x: 0, z: -31, milestone: 3 });
    Object.assign(b, { health: 30, x: 0, z: -50, milestone: 0 });
    assert.equal(selectLeader(state).id, a.id, 'Destination teleport bypassed ordered progress');
    Object.assign(b, { milestone: 3, z: -41 });
    assert.equal(selectLeader(state).id, b.id);
    Object.assign(a, { z: -40.2 });
    Object.assign(b, { z: -40.4 });
    assert.equal(selectLeader(state).id, b.id, 'Sub-cell progress must distinguish nearby leaders');
    a.z = b.z;
    assert.equal(selectLeader(state).id, a.id, 'Equal progress must use a stable ID tie-break');
    a.z = -31;
    b.health = 0;
    assert.equal(selectLeader(state).id, a.id);
    a.health = 0;
    assert.equal(selectLeader(state), null);
});

test('police can incapacitate an NPC without friendly fire or ending a solo attempt', () => {
    const state = createAttempt();
    const c = state.companions[0];
    c.health = 1;
    state.projectiles.push({ x: c.x, z: c.z + 0.1, dx: 0, dz: -1, life: 3, faction: 'police' });
    advance(state, {}, 1 / 60);
    assert.equal(c.health, 0);
    assert.equal(state.health, 100);
    assert.equal(state.status, 'active');
    assert.equal(state.companions.length, 99);
});

test('demo fails when nobody can continue, and restart restores the exact population', () => {
    const state = createAttempt('standard', true);
    state.companions.forEach(c => { c.health = 0; });
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'failed');
    const frozen = JSON.stringify(state);
    tick(state);
    assert.equal(JSON.stringify(state), frozen);
    const next = createAttempt('standard', true);
    assert.equal(next.companions.length, 100);
    assert.ok(next.companions.every(c => c.health > 0 && c.milestone === 0));
});

test('movement is normalized, collision slides, and the map is bounded', () => {
    const straight = createAttempt(), diagonal = createAttempt();
    tick(straight, { x: 1 });
    tick(diagonal, { x: 1, z: 1 });
    assert.ok(Math.abs(Math.hypot(diagonal.player.x, diagonal.player.z - 58) - straight.player.x) < 0.01);
    tick(straight, { x: 1 }, 20);
    assert.ok(straight.player.x < 38);
    assert.ok(walkable(straight.player.x, straight.player.z));
    for (const obstacle of obstacles) assert.equal(walkable(obstacle.x, obstacle.z), false);
    for (const column of columns) assert.equal(walkable(column.x, column.z), false);
    for (const seat of seats) assert.equal(walkable(seat.x, seat.z), false);
    assert.equal(walkable(100, 100), false);
});

test('normal movement can finish every required milestone without a dead end', () => {
    const state = createAttempt('story');
    state.enemies.forEach(e => { e.health = 0; });
    for (let i = 0; i < 1800 && state.status === 'active'; i++) advance(state, { z: -1 }, 1 / 60);
    assert.equal(state.status, 'completed');
    assert.equal(state.milestone, milestones.length);
    assert.ok(state.elapsed > 0);
});

test('destination arrival cannot skip prerequisite milestones or be triggered by companions', () => {
    const state = createAttempt();
    state.player.z = -49;
    state.companions.forEach(c => { c.z = -49; });
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'active');
    assert.equal(state.milestone, 0);
});

test('pause freezes movement, projectiles, cooldowns, damage, and elapsed time', () => {
    const state = createAttempt();
    fire(state, { x: 0, z: -1 });
    setPaused(state, true);
    const before = JSON.stringify(state);
    tick(state, { z: -1 }, 5);
    assert.equal(fire(state, { x: 0, z: -1 }), null);
    assert.equal(JSON.stringify(state), before);
    setPaused(state, false);
    tick(state, { z: -1 });
    assert.ok(state.elapsed > 0);
    assert.ok(state.player.z < 58);
});

test('shots respect range, cooldown, friendly characters and solid cover', () => {
    const state = createAttempt();
    state.enemies = [{ id: 1, x: 0, z: 48, health: 3, cooldown: 99 }];
    const shot = fire(state, { x: 0, z: -1 });
    assert.equal(shot.hit, 1);
    assert.equal(state.enemies[0].health, 2);
    assert.equal(fire(state, { x: 0, z: -1 }), null);
    tick(state, {}, 0.3);
    assert.equal(fire(state, { x: 0, z: 0 }), null);
    const cover = obstacles[0];
    state.player = { x: cover.x, z: cover.z + cover.d / 2 + 2 };
    state.enemies[0] = { id: 1, x: cover.x, z: cover.z - cover.d / 2 - 2, health: 3, cooldown: 99 };
    tick(state, {}, 0.3);
    const blocked = fire(state, { x: 0, z: -1 });
    assert.equal(blocked.hit, null);
    assert.ok(blocked.z > cover.z);
    assert.equal(state.enemies[0].health, 3);
});

test('enemy projectiles can damage the player; incapacitation wins over arrival', () => {
    const state = createAttempt();
    state.milestone = milestones.length - 1;
    state.player = { x: 0, z: -49 };
    state.health = 1;
    state.projectiles.push({ x: 0, z: -48.9, dx: 0, dz: -1, life: 3 });
    advance(state, {}, 1 / 60);
    assert.equal(state.health, 0);
    assert.equal(state.status, 'failed');
    const terminal = JSON.stringify(state);
    tick(state, { z: -1 });
    assert.equal(JSON.stringify(state), terminal);
    setPaused(state, true);
    assert.equal(state.status, 'failed');
});

test('terminal completion cannot change and restarting creates a fully fresh attempt', () => {
    const state = createAttempt('story');
    state.milestone = milestones.length - 1;
    state.player = { x: 0, z: -49 };
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'completed');
    const completed = JSON.stringify(state);
    tick(state, { x: 1 });
    assert.equal(JSON.stringify(state), completed);
    assert.equal(fire(state, { x: 0, z: -1 }), null);
    const restart = createAttempt('story');
    assert.equal(restart.health, 100);
    assert.equal(restart.elapsed, 0);
    assert.equal(restart.milestone, 0);
    assert.equal(restart.projectiles.length, 0);
    assert.equal(restart.player.z, 58);
});

test('invalid input cannot corrupt an attempt and long frames are bounded', () => {
    const state = createAttempt();
    assert.throws(() => advance(state, {}, NaN), /time/i);
    assert.throws(() => advance(state, { x: Infinity }, 0.01), /input/i);
    assert.throws(() => fire(state, { x: NaN, z: 1 }), /direction/i);
    advance(state, { z: -1 }, 30);
    assert.ok(state.elapsed <= 0.05);
    assert.ok(state.player.z > 57);
});

async function engineHarness(rejectUpdates = false) {
    class Target extends EventTarget {
        constructor() { super(); this.dataset = {}; this.attributes = {}; }
        setAttribute(name, value) { this.attributes[name] = value; }
        focus() {}
        closest() { return null; }
    }
    const window = new Target(), document = new Target(), host = new Target(), canvas = new Target();
    host.parentElement = new Target();
    document.getElementById = () => host;
    document.exitPointerLock = () => { document.pointerLockElement = null; };
    const frames = new Map(), calls = [], errors = [];
    let frameId = 0, disposed = 0;
    const view = { canvas, render() {}, aim: () => ({ x: 0, z: -1 }), trace() {}, dispose() { disposed++; } };
    const context = vm.createContext({
        window, document, AbortController, createAttempt, advance, fire, setPaused, selectLeader,
        createScene: () => view, ensure: async () => true, remove() {},
        connectedPads: () => [], stick: () => ({ x: 0, y: 0 }), pressed: () => false,
        ButtonEdges: class { update() { return []; } },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
        console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    });
    const engine = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pocapitol/index.js', import.meta.url), 'utf8');
    vm.runInContext(engine.replace(/^import .*;\r?$/gm, ''), context);
    await window.PoCapitol.init('scene', {
        invokeMethodAsync(name, ...args) {
            calls.push([name, ...args]);
            return rejectUpdates ? Promise.reject(new Error('UI disconnected')) : Promise.resolve();
        },
    });
    return {
        api: window.PoCapitol, window, document, host, canvas, calls, errors, frames,
        state: () => vm.runInContext('game.state', context),
        disposed: () => disposed,
        async frame(now) {
            const [id, callback] = frames.entries().next().value;
            frames.delete(id); callback(now);
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        },
        key(code, down = true) {
            const event = new Event(down ? 'keydown' : 'keyup', { cancelable: true });
            Object.assign(event, { code, repeat: false });
            window.dispatchEvent(event);
        },
    };
}

test('engine preview never advances; live movement, pause and disposal honor lifecycle', async () => {
    const engine = await engineHarness();
    await engine.frame(1000); await engine.frame(1017);
    assert.equal(engine.state().elapsed, 0);
    engine.api.start('story');
    engine.key('KeyW');
    await engine.frame(1034);
    assert.ok(engine.state().player.z < 58);
    engine.api.pause(true);
    const frozen = JSON.stringify(engine.state());
    await engine.frame(2000);
    assert.equal(JSON.stringify(engine.state()), frozen);
    engine.api.pause(false);
    engine.key('Space');
    await engine.frame(2017);
    assert.equal(engine.state().shots, 1);
    engine.api.dispose();
    assert.equal(engine.frames.size, 0);
    assert.equal(engine.disposed(), 1);
    assert.equal(engine.errors.length, 0);
    engine.key('KeyW');
    engine.api.dispose();
    assert.equal(engine.disposed(), 1);
});

test('keyboard activation on interface buttons is not intercepted as firing', async () => {
    const engine = await engineHarness();
    engine.api.start('story');
    engine.window.closest = selector => selector.includes('button') ? {} : null;
    engine.key('Space');
    await engine.frame(1000); await engine.frame(1017);
    assert.equal(engine.state().shots, 0);
    engine.api.dispose();
});

test('losing focus pauses and a disconnected interface is explicitly reported', async () => {
    const engine = await engineHarness();
    engine.api.start('standard');
    engine.window.dispatchEvent(new Event('blur'));
    assert.equal(engine.state().status, 'paused');
    engine.api.dispose();
    const broken = await engineHarness(true);
    broken.api.start('story');
    await broken.frame(1000);
    assert.equal(broken.state().status, 'paused');
    assert.ok(broken.errors.length > 0);
    assert.match(broken.host.attributes['aria-label'], /could not update/);
    assert.match(broken.host.dataset.interfaceError, /could not update/);
    broken.api.dispose();
});

test('controller navigation leaves live PoCapitol input to its engine', () => {
    const bus = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/gamepadBus.js', import.meta.url), 'utf8');
    const declaration = bus.match(/const CANVAS_GAMES = (\/.*\/i);/)[1];
    const canvasGames = vm.runInNewContext(declaration);
    assert.equal(canvasGames.test('/pocapitol/1player'), true);
    assert.equal(canvasGames.test('/pocapitol'), true);
    assert.equal(canvasGames.test('/pocapitolfake'), false);
    assert.equal(canvasGames.test('/pobrawl/ffa'), true);
});

test('demo engine ignores human input, reports its subject, loops, pauses and disposes', async () => {
    const engine = await engineHarness();
    engine.api.start('story', true);
    engine.key('KeyW'); engine.key('Space');
    engine.window.dispatchEvent(new Event('blur'));
    await engine.frame(1000); await engine.frame(1050);
    assert.equal(engine.state().status, 'active');
    assert.equal(engine.state().player.z, 58);
    assert.equal(engine.state().shots, 0);
    const update = engine.calls.find(call => call[0] === 'OnUpdate');
    assert.equal(update[8], 100);
    assert.ok(update[10] > 0);
    assert.equal(update[11], true);
    engine.api.pause(true);
    const frozen = JSON.stringify(engine.state());
    await engine.frame(1100);
    assert.equal(JSON.stringify(engine.state()), frozen);
    engine.api.pause(false);
    engine.state().companions[0].milestone = 4;
    await engine.frame(1150);
    assert.equal(engine.state().status, 'completed');
    await engine.frame(5200);
    assert.equal(engine.state().status, 'active');
    assert.equal(engine.state().companions.length, 100);
    assert.ok(engine.state().elapsed <= 0.05);
    engine.api.start('story');
    assert.equal(engine.state().demo, false);
    assert.equal(engine.state().companions.length, 99);
    engine.api.dispose();
    assert.equal(engine.frames.size, 0);
    assert.equal(engine.errors.length, 0);
});
