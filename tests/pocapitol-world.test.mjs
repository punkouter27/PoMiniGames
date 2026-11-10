import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// The engine's modules import each other and Yuka by bare or relative specifiers. Each is
// loaded here as a data: URL with those specifiers rewritten, so the test runs the same
// files the browser does (including the vendored Yuka build) without a bundler.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const read = path => readFileSync(new URL(path, client), 'utf8');
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const yuka = url(read('lib/yuka/yuka.module.js'));
const physics = url(read('js/pocapitol/physics.js'));
const steering = url(read('js/pocapitol/steering.js').replace("'yuka'", `'${yuka}'`).replace("'./physics.js'", `'${physics}'`));
const world = await import(url(read('js/pocapitol/world.js').replace("'./steering.js'", `'${steering}'`).replace("'./physics.js'", `'${physics}'`)));
const { createAttempt, advance, shove, setPaused, walkable, milestones, obstacles, columns, statues, lineDefs,
    selectLeader, frontLine, clockLabel, CROWD_SIZE, MAX_POLICE, CIVILIANS, CURFEW_ELAPSED } = world;
const { createGovernor, RUNGS } = await import(url(read('js/pocapitol/quality.js')));

function tick(state, input = {}, seconds = 1) {
    for (let i = 0; i < Math.round(seconds * 60); i++) advance(state, input, 1 / 60);
}
const breakLines = state => state.lines.forEach(line => { line.state = 'broken'; line.integrity = 0; });

test('fresh attempt starts outside with a mostly passive crowd and five manned lines', () => {
    const a = createAttempt('standard'), b = createAttempt('standard');
    assert.equal(a.status, 'active');
    assert.equal(a.role, 'raider');
    assert.equal(a.player.z, 100);
    assert.equal(a.health, 100);
    assert.equal(a.companions.length, 127);
    assert.equal(a.companions.length + 1, CROWD_SIZE);
    assert.equal(new Set(a.companions.map(c => c.id)).size, 127);
    assert.ok(a.companions.every(c => c.z > 14 && walkable(c.x, c.z) && c.health > 0));
    const pushers = a.companions.filter(c => c.temperament === 'pusher').length;
    assert.ok(pushers > 20 && pushers < 50, `Pushers should be a minority, got ${pushers}`);
    assert.equal(CROWD_SIZE, 128);
    assert.equal(a.enemies.length + 20, MAX_POLICE);
    assert.equal(MAX_POLICE, 64);
    assert.equal(a.civilians.length, 64);
    assert.equal(CIVILIANS, 64);
    assert.ok(a.companions.every(c => c.z >= 80), 'The crowd must start out on the grass, well back from the building');
    assert.ok(a.civilians.every(p => p.z < -53 && !walkable(p.x, p.z)), 'Staff and members must be behind the chamber doors');
    assert.ok(a.companions.some(c => c.temperament === 'bystander' && c.filming));
    assert.ok(a.companions.some(c => c.temperament === 'medic'));
    assert.equal(a.lines.length, lineDefs.length);
    assert.ok(a.lines.every(line => line.state === 'holding' && line.integrity === 100));
    assert.ok(a.enemies.every(e => e.faction === 'capitol-police' && walkable(e.x, e.z)), 'Police spawned inside scenery');
    assert.ok(lineDefs.every((def, i) => a.enemies.filter(e => e.line === i).length === def.officers));
    a.enemies[0].health = 0;
    assert.equal(b.enemies[0].health, 10);
    assert.throws(() => createAttempt('unknown'), /difficulty/i);
    assert.throws(() => createAttempt('story', false, 'general'), /role/i);
});

test('demo has exactly 128 CPU raiders and no participating human', () => {
    const state = createAttempt('story', true, 'police');
    assert.equal(state.demo, true);
    assert.equal(state.role, 'none');
    assert.equal(state.companions.length, 128);
    const player = { ...state.player };
    tick(state, { z: -1 }, 1);
    assert.deepEqual(state.player, player);
    assert.equal(shove(state, { x: 0, z: -1 }), null);
});

test('a holding line stops the crowd and the human; a broken one lets them through', () => {
    const state = createAttempt('story');
    state.enemies.forEach(e => { e.cooldown = 999; });
    state.lines[0].integrity = 100;
    const limit = lineDefs[0].z + 0.6;
    for (let i = 0; i < 1500; i++) {
        advance(state, { z: -1 }, 1 / 60);
        state.lines[0].integrity = 100;
    }
    assert.ok(state.player.z >= limit - 1e-6, 'The human walked through a holding line');
    assert.ok(state.companions.every(c => c.z >= limit - 1e-6), 'A raider walked through a holding line');
    assert.equal(state.milestone, 0);
    assert.ok(state.companions.filter(c => c.z < limit + 2.5).length >= 10, 'Nobody pressed the line');
    assert.ok(state.lines[0].pressure > 0);
    state.lines[0].state = 'broken';
    tick(state, { z: -1 }, 3);
    assert.ok(state.player.z < limit);
    assert.equal(state.milestone, 1);
});

test('the crowd keeps its distance from one another instead of stacking', () => {
    const state = createAttempt('story', true);
    state.enemies.forEach(e => { e.cooldown = 999; });
    tick(state, {}, 26);
    const moving = state.companions.filter(c => c.health > 0);
    let tight = 0;
    for (const a of moving) for (const b of moving) {
        if (a.id < b.id && Math.hypot(a.x - b.x, a.z - b.z) < 0.25) tight++;
    }
    assert.ok(tight <= 2, `${tight} pairs of raiders are standing on the same spot`);
    assert.ok(state.companions.every(c => walkable(c.x, c.z)), 'NPC left navigable space');
    assert.ok(state.companions.some(c => c.crowding >= 3), 'Nobody registered a crush at the line');
});

test('the armed story demo eliminates people on both sides, breaks every line in order and ends at the doors', () => {
    const state = createAttempt('story', true);
    assert.equal(state.armed, true);
    const start = state.companions.map(c => c.z);
    const seen = new Set(), broken = [];
    let police = state.enemies.length;
    while (state.status === 'active') {
        advance(state, {}, 1 / 60);
        for (const e of state.events) {
            seen.add(e.type);
            if (e.type === 'break') broken.push(e.line);
        }
        police = Math.max(police, state.enemies.length);
        assert.ok(state.enemies.length <= MAX_POLICE);
    }
    assert.deepEqual(broken, [0, 1, 2, 3, 4], 'Lines must fall back in order');
    for (const type of ['gunshot', 'down', 'gas', 'flash', 'reinforce', 'milestone']) {
        assert.ok(seen.has(type), `Never happened: ${type}`);
    }
    assert.ok(police > lineDefs.reduce((n, def) => n + def.officers, 0), 'No reinforcements arrived');
    assert.ok(seen.has('evacuation'));
    assert.ok(state.civilians.every(p => p.evacuated), 'Someone was still in the chamber when the crowd reached its doors');
    assert.equal(state.status, 'completed');
    assert.equal(state.outcome, 'doors');
    assert.equal(state.milestone, milestones.length);
    assert.ok(state.elapsed < CURFEW_ELAPSED);
    assert.equal(state.companions.length, 128);
    assert.ok(state.companions.every(c => walkable(c.x, c.z)), 'NPC left navigable space');
    const out = state.companions.filter(c => c.health <= 0);
    assert.ok(out.length > 0 && out.length < 128, `${out.length} raiders were eliminated`);
    assert.ok(out.every(c => !c.helped && !c.resting), 'Eliminated raiders must stay out, not walk away');
    assert.ok(state.enemies.some(e => e.health <= 0), 'No officer was eliminated');
    // Most of the crowd never goes deep into the building.
    const deep = state.companions.filter(c => c.milestone >= 3).length;
    assert.ok(deep < 110 && deep > 0, `${deep} raiders went deep inside`);
    assert.ok(state.companions.filter(c => c.temperament === 'bystander').every(c => c.milestone <= 2));
    assert.ok(state.companions.some((c, i) => c.z < start[i] - 80));
});

test('outside the demo nobody is armed: police use batons and spray, and the crowd shoves', () => {
    const state = createAttempt('story', false, 'observer');
    assert.equal(state.armed, false);
    const seen = new Set();
    for (let i = 0; i < 60 * 25; i++) {
        advance(state, {}, 1 / 60);
        for (const e of state.events) seen.add(e.type);
        assert.equal(state.shots.length, 0);
    }
    for (const type of ['shove', 'baton', 'spray']) assert.ok(seen.has(type), `Never happened: ${type}`);
    assert.ok(!seen.has('gunshot'));
});

test('gas drives people back and worn-out raiders are helped away by street medics', () => {
    const state = createAttempt('standard', false, 'observer');
    state.enemies.forEach(e => { e.cooldown = 999; });
    const c = state.companions[0];
    // A pusher held at the first line, with the canister landing on top of them.
    Object.assign(c, { x: 0, z: lineDefs[0].z + 0.7, morale: 0.85, delay: 0 });
    state.effects.push({ type: 'gas', x: 0, z: lineDefs[0].z + 1, r: 4, life: 6, span: 6 });
    tick(state, {}, 4.5);
    assert.ok(c.retreating, 'Gas did not break their nerve');
    assert.ok(c.health < 30);
    const down = state.companions[1], medic = state.companions.find(m => m.temperament === 'medic');
    Object.assign(down, { x: 20, z: 50, health: 0 });
    Object.assign(medic, { x: 22, z: 51, delay: 0 });
    tick(state, {}, 3);
    assert.equal(down.helped, true, 'The medic never reached them');
    const from = Math.hypot(down.x + 30, down.z - 62);
    tick(state, {}, 6);
    assert.ok(Math.hypot(down.x + 30, down.z - 62) < from - 4, 'Helped raider did not walk to the aid station');
    assert.equal(down.health, 0);
    assert.equal(state.companions.length, 128);
});

test('staff and members are evacuated on the clock and can never be harmed', () => {    const state = createAttempt('standard', true);
    const before = JSON.stringify(state.civilians);
    tick(state, {}, 20);
    assert.equal(JSON.stringify(state.civilians), before, 'Nobody moves before the evacuation');
    // Rounds, gas and a flash-bang in the middle of the chamber change nothing for them.
    state.shots.push({ x: 0, z: -66, dx: 0, dz: -1, life: 1, faction: 'raider' }, { x: 0, z: -66, dx: 1, dz: 0, life: 1, faction: 'police' });
    state.effects.push({ type: 'gas', x: 0, z: -66, r: 20, life: 5, span: 5 }, { type: 'flash', x: 0, z: -66, r: 20, life: 0.5, span: 0.5 });
    tick(state, {}, 2);
    assert.ok(state.civilians.every(p => !('health' in p) && !p.evacuated));
    state.elapsed = 85;
    tick(state, {}, 50);
    assert.ok(state.civilians.every(p => p.evacuated), 'The chamber was not emptied');
    const early = createAttempt('story', true);
    early.lines[1].state = 'broken';
    advance(early, {}, 1 / 60);
    assert.ok(early.evacuation >= 0, 'Entering the building must start the evacuation');
});

test('camera leader uses reachable progress, ignores incapacitated raiders, and can switch', () => {
    const state = createAttempt('story', true);
    const [a, b] = state.companions;
    const last = milestones.length - 1;
    state.companions.forEach(c => { c.health = 0; });
    Object.assign(a, { health: 30, x: 0, z: -31, milestone: last });
    Object.assign(b, { health: 30, x: 0, z: -50, milestone: 0 });
    assert.equal(selectLeader(state).id, a.id, 'Destination teleport bypassed ordered progress');
    Object.assign(b, { milestone: last, z: -41 });
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

test('demo ends when nobody can continue or at the curfew, and restart restores the population', () => {
    const state = createAttempt('standard', true);
    state.companions.forEach(c => { c.health = 0; });
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'failed');
    assert.equal(state.outcome, 'dispersed');
    const frozen = JSON.stringify(state);
    tick(state);
    assert.equal(JSON.stringify(state), frozen);
    const late = createAttempt('standard', true);
    late.elapsed = CURFEW_ELAPSED - 0.01;
    advance(late, {}, 1 / 60);
    assert.equal(late.outcome, 'curfew');
    assert.equal(late.status, 'failed');
    assert.equal(clockLabel(0), '12:50 PM');
    assert.equal(clockLabel(CURFEW_ELAPSED), '6:00 PM');
    const next = createAttempt('standard', true);
    assert.equal(next.companions.length, 128);
    assert.ok(next.companions.every(c => c.health > 0 && c.milestone === 0));
    assert.ok(next.lines.every(line => line.state === 'holding'));
});

test('movement is normalized, collision slides, and the map is bounded', () => {
    const straight = createAttempt(), diagonal = createAttempt();
    for (const state of [straight, diagonal]) { state.companions = []; state.enemies = []; }
    tick(straight, { x: 1 });
    tick(diagonal, { x: 1, z: 1 });
    assert.ok(Math.abs(Math.hypot(diagonal.player.x, diagonal.player.z - 100) - straight.player.x) < 0.01);
    tick(straight, { x: 1 }, 20);
    assert.ok(straight.player.x < 38);
    assert.ok(walkable(straight.player.x, straight.player.z));
    for (const obstacle of obstacles) assert.equal(walkable(obstacle.x, obstacle.z), false);
    for (const column of columns) assert.equal(walkable(column.x, column.z), false);
    for (const statue of statues) assert.equal(walkable(statue.x, statue.z), false);
    for (const milestone of milestones) assert.equal(walkable(milestone.x, milestone.z), true);
    assert.equal(walkable(0, -60), false, 'The chamber behind the doors must not be enterable');
    assert.equal(walkable(100, 100), false);
});

test('with the lines down, walking straight in reaches the doors without a dead end', () => {
    const state = createAttempt('story');
    breakLines(state);
    state.enemies.forEach(e => { e.health = 0; });
    for (let i = 0; i < 2400 && state.status === 'active'; i++) advance(state, { z: -1 }, 1 / 60);
    assert.equal(state.status, 'completed');
    assert.equal(state.outcome, 'doors');
    assert.equal(state.milestone, milestones.length);
    assert.ok(state.player.z > -53, 'The human ended up inside the chamber');
});

test('destination arrival cannot skip prerequisite milestones or be triggered by companions', () => {
    const state = createAttempt();
    breakLines(state);
    state.player.z = -50;
    state.companions.forEach(c => { c.z = -50; c.x = 0; });
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'active');
    assert.equal(state.milestone, 0);
});

test('pause freezes the crowd, the lines, cooldowns, damage and the clock', () => {
    const state = createAttempt();
    tick(state, {}, 2);
    shove(state, { x: 0, z: -1 });
    setPaused(state, true);
    const before = JSON.stringify(state);
    tick(state, { z: -1 }, 5);
    assert.equal(shove(state, { x: 0, z: -1 }), null);
    assert.equal(JSON.stringify(state), before);
    setPaused(state, false);
    const elapsed = state.elapsed, z = state.player.z;
    tick(state, { z: -1 });
    assert.ok(state.elapsed > elapsed);
    assert.ok(state.player.z < z);
});

test('a raider shove staggers one officer in reach and adds weight to the line', () => {
    const state = createAttempt('story');
    state.companions = [];
    state.enemies = state.enemies.filter(e => e.line === 0);
    state.enemies.forEach(e => { e.cooldown = 999; });
    state.player = { x: state.enemies[2].x, z: lineDefs[0].z + 0.7 };
    advance(state, {}, 1 / 60);
    const idle = state.lines[0].pressure;
    const pushed = shove(state, { x: 0, z: -1 });
    assert.equal(pushed.hit, state.enemies[2].id);
    assert.ok(state.enemies[2].stagger > 0);
    assert.equal(state.enemies[2].health, 9);
    assert.equal(shove(state, { x: 0, z: -1 }), null, 'Shoves must respect the cooldown');
    advance(state, {}, 1 / 60);
    assert.ok(state.lines[0].pressure > idle + 3, 'A shove should add real pressure');
    tick(state, {}, 0.6);
    assert.equal(shove(state, { x: 0, z: 0 }), null);
    assert.equal(shove(state, { x: 0, z: 1 }).hit, null, 'Shoving away from the line reached an officer');
    assert.equal(state.pushes, 2);
});

test('police role: the human holds the line, pushes raiders back, and wins at the curfew', () => {
    const state = createAttempt('story', false, 'police');
    assert.equal(state.companions.length, 128);
    assert.ok(state.player.z < lineDefs[0].z, 'The officer starts behind the first line');
    const z = state.player.z;
    tick(state, { z: 1 }, 2);
    assert.ok(state.player.z > lineDefs[0].z + 0.6, 'Police are not held by their own line');
    assert.ok(state.player.z > z);
    const raider = state.companions[0];
    Object.assign(raider, { x: state.player.x, z: state.player.z + 1.2, delay: 0, health: 30 });
    tick(state, {}, 0.5);
    const before = raider.z;
    const pushed = shove(state, { x: 0, z: 1 });
    assert.ok(pushed.hit !== null);
    assert.ok(raider.health < 30 && raider.stun > 0 && raider.kz > 0, 'The shove did not pass momentum to the raider');
    tick(state, {}, 0.3);
    assert.ok(raider.z > before, 'The raider was not pushed back');
    state.elapsed = CURFEW_ELAPSED - 0.01;
    advance(state, {}, 1 / 60);
    assert.equal(state.outcome, 'curfew');
    assert.equal(state.status, 'completed');
    const lost = createAttempt('story', false, 'police');
    lost.companions[0].milestone = milestones.length;
    advance(lost, {}, 1 / 60);
    assert.equal(lost.outcome, 'doors');
    assert.equal(lost.status, 'failed');
});

test('observer role: free to walk, never targeted, cannot push, cannot be overcome', () => {
    const state = createAttempt('standard', false, 'observer');
    breakLines(state);
    state.player = { x: 0, z: lineDefs[0].z + 1 };
    assert.equal(shove(state, { x: 0, z: -1 }), null);
    state.effects.push({ type: 'gas', x: state.player.x, z: state.player.z, r: 5, life: 5, span: 5 });
    tick(state, {}, 5);
    assert.equal(state.health, 100);
    assert.equal(state.status, 'active');
    state.health = 0;
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'active', 'An observer has no stamina to lose');
});

test('police tools wear the human down; incapacitation wins over arrival', () => {
    const state = createAttempt();
    breakLines(state);
    state.milestone = milestones.length - 1;
    state.player = { x: 0, z: -50 };
    state.health = 0.05;
    state.effects.push({ type: 'gas', x: 0, z: -50, r: 4, life: 5, span: 5 });
    advance(state, {}, 1 / 60);
    assert.equal(state.health, 0);
    assert.equal(state.status, 'failed');
    assert.equal(state.outcome, 'overcome');
    const terminal = JSON.stringify(state);
    tick(state, { z: -1 });
    assert.equal(JSON.stringify(state), terminal);
    setPaused(state, true);
    assert.equal(state.status, 'failed');
    const hit = createAttempt('standard');
    hit.companions = [];
    hit.player = { x: hit.enemies[0].x, z: lineDefs[0].z + 0.7 };
    hit.enemies[0].cooldown = 0;
    tick(hit, {}, 0.1);
    assert.ok(hit.health < 100, 'An officer in reach never used the baton');
    assert.ok(hit.damageFlash > 0);
});

test('terminal completion cannot change and restarting creates a fully fresh attempt', () => {
    const state = createAttempt('story');
    breakLines(state);
    state.milestone = milestones.length - 1;
    state.player = { x: 0, z: -50 };
    advance(state, {}, 1 / 60);
    assert.equal(state.status, 'completed');
    const completed = JSON.stringify(state);
    tick(state, { x: 1 });
    assert.equal(JSON.stringify(state), completed);
    assert.equal(shove(state, { x: 0, z: -1 }), null);
    const restart = createAttempt('story');
    assert.equal(restart.health, 100);
    assert.equal(restart.elapsed, 0);
    assert.equal(restart.milestone, 0);
    assert.equal(restart.effects.length, 0);
    assert.equal(restart.player.z, 100);
    assert.equal(frontLine(restart).id, 0);
});

test('invalid input cannot corrupt an attempt and long frames are bounded', () => {
    const state = createAttempt();
    assert.throws(() => advance(state, {}, NaN), /time/i);
    assert.throws(() => advance(state, { x: Infinity }, 0.01), /input/i);
    assert.throws(() => shove(state, { x: NaN, z: 1 }), /direction/i);
    advance(state, { z: -1 }, 30);
    assert.ok(state.elapsed <= 0.05);
    assert.ok(state.player.z > 99);
});

test('graphics governor steps down on slow frames, recovers once, and honors the tier and manual modes', () => {
    const feed = (governor, ms, seconds) => {
        let last = null;
        for (let t = 0; t < seconds; t += ms / 1000) last = governor.sample(ms / 1000) ?? last;
        return last;
    };
    const auto = createGovernor({ tier: 'high', mode: 'auto' });
    assert.equal(auto.settings(), RUNGS[0]);
    assert.equal(feed(auto, 16, 10), null, 'Smooth frames must not change anything');
    // Three seconds spans one mixed window and one wholly slow one.
    assert.equal(feed(auto, 40, 3), RUNGS[1]);
    assert.equal(auto.sample(3), null, 'A long hitch is not a measurement');
    assert.equal(feed(auto, 8, 6), RUNGS[0], 'Clear headroom should restore quality');
    feed(auto, 40, 3.2);
    feed(auto, 8, 30);
    assert.equal(auto.settings(), RUNGS[1], 'A rung that failed twice must not be retried');
    feed(auto, 60, 30);
    assert.equal(auto.settings(), RUNGS[RUNGS.length - 1]);
    assert.ok(RUNGS.every((rung, i) => i === 0 || rung.scale <= RUNGS[i - 1].scale));
    assert.equal(createGovernor({ tier: 'low' }).settings(), RUNGS[3]);
    const medium = createGovernor({ tier: 'medium' });
    feed(medium, 8, 30);
    assert.equal(medium.settings(), RUNGS[1], 'Auto must never exceed the app tier');
    const manual = createGovernor({ tier: 'low', mode: 'high' });
    assert.equal(manual.settings(), RUNGS[0]);
    assert.equal(feed(manual, 80, 10), null, 'A pinned mode ignores frame time');
    assert.equal(manual.setMode('low'), RUNGS[3]);
    assert.match(manual.label(), /^Low · 60%$/);
    assert.throws(() => manual.setMode('ultra'), /mode/i);
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
    host.isConnected = true;
    document.getElementById = () => host;
    document.exitPointerLock = () => { document.pointerLockElement = null; };
    const stored = new Map();
    window.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    const frames = new Map(), calls = [], errors = [], sounds = [], quality = [];
    let frameId = 0, disposed = 0, audioDisposed = 0;
    const view = { canvas, render() {}, aim: () => ({ x: 0, z: -1 }), applyQuality: s => quality.push(s), dispose() { disposed++; } };
    const context = vm.createContext({
        window, document, AbortController, createAttempt, advance, shove, setPaused, selectLeader, frontLine,
        createScene: () => view, loadFigure: async () => null, createUiFx: () => ({ dispose() {} }), createGovernor, MODES: ['auto', 'low', 'high'],
        fetchWeather: async () => ({ temperature: 4.4, condition: 'Overcast', windSpeed: 14.5 }),
        createRadar: () => ({ render() {}, update() {}, resize() {}, destroy() {}, dispose() {} }),
        createInspector: () => ({ select() {}, clear() {}, update() {}, raycastFromCamera() { return null; }, getSelected() { return null; }, isLatched() { return false; }, toggleLatch() { return false; }, dispose() {} }),
        createAudio: () => ({ update() {}, event: e => sounds.push(e.type), dispose() { audioDisposed++; } }),
        ensure: async () => true, remove() {},
        connectedPads: () => [], stick: () => ({ x: 0, y: 0 }), pressed: () => false,
        ButtonEdges: class { update() { return []; } },
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
        console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    });
    vm.runInContext(read('js/pocapitol/index.js').replace(/^import .*;\r?$/gm, ''), context);
    await window.PoCapitol.init('scene', {
        invokeMethodAsync(name, ...args) {
            calls.push([name, ...args]);
            return rejectUpdates ? Promise.reject(new Error('UI disconnected')) : Promise.resolve();
        },
    });
    return {
        api: window.PoCapitol, window, document, host, canvas, calls, errors, frames, sounds, quality, stored,
        state: () => vm.runInContext('game.state', context),
        disposed: () => disposed, audioDisposed: () => audioDisposed,
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

test('engine preview never advances; live movement, pushing, pause and disposal honor lifecycle', async () => {
    const engine = await engineHarness();
    await engine.frame(1000); await engine.frame(1017);
    assert.equal(engine.state().elapsed, 0);
    engine.api.start('story');
    engine.key('KeyW');
    await engine.frame(1034);
    assert.ok(engine.state().player.z < 100);
    engine.api.pause(true);
    const frozen = JSON.stringify(engine.state());
    await engine.frame(2000);
    assert.equal(JSON.stringify(engine.state()), frozen);
    engine.api.pause(false);
    engine.key('Space');
    await engine.frame(2017);
    assert.equal(engine.state().pushes, 1);
    assert.ok(engine.sounds.includes('shove'), 'The push made no sound');
    engine.api.dispose();
    assert.equal(engine.frames.size, 0);
    assert.equal(engine.disposed(), 1);
    assert.equal(engine.audioDisposed(), 1);
    assert.equal(engine.errors.length, 0);
    engine.key('KeyW');
    engine.api.dispose();
    assert.equal(engine.disposed(), 1);
});

test('engine applies and remembers the graphics choice', async () => {
    const engine = await engineHarness();
    assert.equal(engine.api.getGraphics(), 'auto');
    assert.equal(engine.quality.at(-1), RUNGS[0]);
    assert.match(engine.api.setGraphics('low'), /^Low/);
    assert.equal(engine.quality.at(-1), RUNGS[3]);
    assert.equal(engine.stored.get('pocapitol.graphics'), 'low');
    assert.equal(engine.api.getGraphics(), 'low');
    assert.throws(() => engine.api.setGraphics('ultra'), /mode/i);
    engine.api.dispose();
});

test('keyboard activation on interface buttons is not intercepted as a push', async () => {
    const engine = await engineHarness();
    engine.api.start('story');
    engine.window.closest = selector => selector.includes('button') ? {} : null;
    engine.key('Space');
    await engine.frame(1000); await engine.frame(1017);
    assert.equal(engine.state().pushes, 0);
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
    const bus = read('js/gamepadBus.js');
    const declaration = bus.match(/const CANVAS_GAMES = (\/.*\/i);/)[1];
    const canvasGames = vm.runInNewContext(declaration);
    assert.equal(canvasGames.test('/pocapitol/1player'), true);
    assert.equal(canvasGames.test('/pocapitol'), true);
    assert.equal(canvasGames.test('/pocapitolfake'), false);
    assert.equal(canvasGames.test('/pobrawl/ffa'), true);
});

test('demo engine ignores human input, reports its subject and line, loops, pauses and disposes', async () => {
    const engine = await engineHarness();
    engine.api.start('story', true);
    engine.key('KeyW'); engine.key('Space');
    engine.window.dispatchEvent(new Event('blur'));
    await engine.frame(1000); await engine.frame(1050);
    assert.equal(engine.state().status, 'active');
    assert.equal(engine.state().player.z, 100);
    assert.equal(engine.state().pushes, 0);
    const update = engine.calls.find(call => call[0] === 'OnUpdate');
    assert.equal(update[8], 128);
    assert.equal(update[9], 44);
    assert.ok(update[10] > 0);
    assert.equal(update[11], true);
    assert.equal(update[12], '');
    assert.equal(update[13], 44);
    assert.equal(update[14], 0);
    assert.equal(update[15], 100);
    assert.match(update[16], /^Auto · 100%$/);
    engine.api.pause(true);
    const frozen = JSON.stringify(engine.state());
    await engine.frame(1100);
    assert.equal(JSON.stringify(engine.state()), frozen);
    engine.api.pause(false);
    engine.state().companions[0].milestone = milestones.length;
    await engine.frame(1150);
    assert.equal(engine.state().status, 'completed');
    await engine.frame(7200);
    assert.equal(engine.state().status, 'active');
    assert.equal(engine.state().companions.length, 128);
    assert.ok(engine.state().elapsed <= 0.05);
    engine.api.start('story');
    assert.equal(engine.state().demo, false);
    assert.equal(engine.state().companions.length, 127);
    engine.api.start('standard', false, 'observer');
    assert.equal(engine.state().role, 'observer');
    engine.key('Space');
    await engine.frame(7300); await engine.frame(7317);
    assert.equal(engine.state().pushes, 0);
    engine.api.dispose();
    assert.equal(engine.frames.size, 0);
    assert.equal(engine.errors.length, 0);
});

test('a round records where it landed, which way it came from, and who it disturbed', () => {
    const state = createAttempt('standard', true);
    state.companions = [];                       // nobody else firing this frame
    const victim = state.enemies[0], neighbour = state.enemies[1];
    Object.assign(victim, { x: 0, z: 30, health: 0.2, armor: 0, kx: 0, kz: 0, stagger: 0 });
    Object.assign(neighbour, { x: 0.9, z: 30, health: 10, armor: 0, kx: 0, kz: 0 });
    // A round travelling -Z, i.e. into the officer's front.
    state.shots.push({ x: 0, z: 30, dx: 0, dz: -1, life: 1, faction: 'raider', y: 1.35, speed: 30 });
    tick(state, {}, 2);

    assert.equal(victim.hitZone, 'torso');
    assert.ok(victim.iz < 0, 'the line of the round is remembered for the reaction');
    assert.ok(victim.hitPower > 0 && victim.hitPower <= 1, 'impact strength is bounded');
    assert.ok((victim.stagger ?? 0) > 0, 'a hit staggers before it drops');
    assert.equal(victim.health, 0);
    // The people pressed against the body check their step, and that costs the simulation nothing.
    assert.ok(typeof neighbour.startle === 'number', 'a neighbour is marked startled');
    assert.ok(neighbour.startleDx > 0.9, 'leaning away from the body, not into it');
    assert.equal(neighbour.kx, 0, 'the flinch must not move anyone');
});
