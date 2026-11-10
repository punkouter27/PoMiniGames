import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Same loading trick as pocapitol-world.test.mjs: each module is a data: URL with its relative
// imports rewritten, so the test runs the files the browser does.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const read = path => readFileSync(new URL(path, client), 'utf8');
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const yuka = url(read('lib/yuka/yuka.module.js'));
const physicsUrl = url(read('js/pocapitol/physics.js'));
const physics = await import(physicsUrl);
const steering = url(read('js/pocapitol/steering.js').replace("'yuka'", `'${yuka}'`).replace("'./physics.js'", `'${physicsUrl}'`));
const world = await import(url(read('js/pocapitol/world.js').replace("'./steering.js'", `'${steering}'`).replace("'./physics.js'", `'${physicsUrl}'`)));
const { createAttempt, advance, shove, walkable, columns } = world;
const { sweep, segmentCircle, firstBlocked, exchange, strike, createGrid, massOf, slide, MIN_GAP } = physics;

test('a round that moves further per step than a body is wide still hits it (continuous collision)', () => {
    // 1.5 m step, 1.2 m body: sampling the end point alone misses a body 0.75 m ahead.
    const t = segmentCircle(0, 0, 1.5, 0, 0.75, 0, 0.6);
    assert.ok(t >= 0 && t < 0.5, `Swept test missed (t=${t})`);
    assert.equal(segmentCircle(0, 0, 1.5, 0, 0.75, 1.0, 0.6), -1, 'A round passing wide of the body hit it');
    assert.equal(segmentCircle(0, 0, 0, 0, 5, 5, 0.6), -1);
});

test('sweeping stops at a wall and slides along it, however long the move', () => {
    const open = x => x < 5;
    const out = sweep(0, 0, 200, 3, open);
    assert.ok(out.x < 5 && out.x > 4.8, `Stopped at ${out.x}`);
    assert.ok(out.hitX && !out.hitZ);
    assert.ok(out.z > 0, 'Did not slide along the wall');
    assert.ok(firstBlocked(0, 0, 100, 0, open) >= 0.04 && firstBlocked(0, 0, 100, 0, open) <= 0.05);
    assert.equal(firstBlocked(0, 0, 4, 0, open), -1);
});

test('a collision conserves momentum and the lighter body leaves faster', () => {
    const heavy = { mass: 100, kx: 0, kz: 0 }, light = { mass: 50, kx: 0, kz: 0 };
    const energy = exchange(heavy, light, 1, 0, 2);
    assert.ok(energy > 0);
    assert.ok(Math.abs(heavy.mass * heavy.kx + light.mass * light.kx) < 1e-9, 'Momentum was not conserved');
    assert.ok(light.kx > 0 && heavy.kx < 0 && Math.abs(light.kx) > Math.abs(heavy.kx) * 1.9, 'Velocities do not follow the mass ratio');
    assert.equal(exchange(heavy, light, 1, 0, -1), 0, 'Bodies moving apart collided');
    // A harder hit loses more energy, and more of it as the square of the speed.
    const hard = exchange({ mass: 80 }, { mass: 80 }, 1, 0, 4), soft = exchange({ mass: 80 }, { mass: 80 }, 1, 0, 2);
    assert.ok(Math.abs(hard / soft - 4) < 1e-9);
});

test('a heavier target is shoved less than a lighter one by the same blow', () => {
    const attacker = { mass: 80 };
    const light = { mass: 55 }, heavy = { mass: 110 };
    strike(attacker, light, 0, 1, 'shove'); strike({ mass: 80 }, heavy, 0, 1, 'shove');
    assert.ok(light.kz > heavy.kz && heavy.kz > 0);
    assert.ok(attacker.kz < 0, 'The striker did not recoil');
    // Knockback is bled off by ground friction until the body stops, and never reverses.
    const slider = { kx: 0, kz: 2 };
    let steps = 0;
    while (slide(slider, 1 / 60) > 0 && steps++ < 600);
    assert.ok(steps > 10 && steps < 40 && slider.kz === 0);
    assert.equal(massOf({}), 75);
});

test('the spatial hash finds every neighbor in range and no one far away', () => {
    const grid = createGrid(1.25), points = [];
    for (let i = 0; i < 400; i++) points.push({ x: (i * 7919 % 1000) / 10, z: (i * 104729 % 1000) / 10 });
    points.forEach((p, i) => grid.insert(i, p.x, p.z));
    for (const probe of [0, 57, 133, 399]) {
        const found = new Set();
        grid.query(points[probe].x, points[probe].z, 1.25, i => { if (Math.hypot(points[i].x - points[probe].x, points[i].z - points[probe].z) < 1.25) found.add(i); });
        const expected = points.map((p, i) => i).filter(i => Math.hypot(points[i].x - points[probe].x, points[i].z - points[probe].z) < 1.25);
        assert.deepEqual([...found].sort((a, b) => a - b), expected);
    }
    grid.clear();
    let seen = 0; grid.query(10, 10, 100, () => seen++);
    assert.equal(seen, 0);
});

test('everyone has a mass: officers carry gear, the human has a mass of their own', () => {
    const state = createAttempt('standard');
    assert.ok(state.enemies.every(e => e.mass >= 90 && e.mass <= 102));
    assert.ok(state.companions.every(c => c.mass >= 58 && c.mass < 93));
    assert.equal(state.player.mass, 80);
    assert.equal(createAttempt('standard', false, 'police').player.mass, 92);
    const masses = new Set(state.companions.map(c => c.mass));
    assert.ok(masses.size > 10, 'Everyone in the crowd weighs the same');
});

test('in the armed demo a round crossing a body in one step still hits it', () => {
    const state = createAttempt('standard', true);
    const target = state.enemies[3];
    const before = target.health;
    // 0.75 m ahead: one 30 m/s step is 1.5 m, so the end point lands 0.75 m beyond the body.
    state.shots.push({ x: target.x, z: target.z + 0.75, dx: 0, dz: -1, life: 1, faction: 'raider' });
    advance(state, {}, 0.05);
    assert.ok(target.health < before, 'The round passed through the officer');
    assert.ok(state.events.some(e => e.type === 'impact' && e.round && e.material === 'body'), 'No impact event for the hit');
    assert.equal(state.shots.length, 0);
});

test('a round cannot pass a column in one step, and the wall is struck', () => {
    const state = createAttempt('standard', true);
    const column = columns.find(c => c.z > 20 && c.z < 30) ?? columns[0];
    state.enemies.forEach(e => { e.cooldown = 999; });
    state.companions.forEach(c => { c.delay = 999; });
    state.shots.push({ x: column.x, z: column.z + 1.6, dx: 0, dz: -1, life: 1, faction: 'raider' });
    advance(state, {}, 0.05);
    assert.equal(state.shots.length, 0, 'The round went through the column');
    const hit = state.events.find(e => e.type === 'impact' && e.round);
    assert.ok(hit && hit.material === 'marble' && hit.energy > 100);
});

test('a hard shove into a column stops at the column and reports the energy', () => {
    const state = createAttempt('standard', true);
    const column = columns[0];
    state.enemies.forEach(e => { e.cooldown = 999; });
    state.companions.forEach(c => { c.delay = 999; });
    const raider = state.companions[0];
    Object.assign(raider, { x: column.x, z: column.z + 1.9, kx: 0, kz: -6, delay: 999 });
    let impact = null;
    for (let i = 0; i < 30; i++) {
        advance(state, {}, 1 / 60);
        assert.ok(walkable(raider.x, raider.z), `Knockback put the raider inside the column at frame ${i}`);
        impact ??= state.events.find(e => e.type === 'impact' && e.material === 'marble');
    }
    assert.ok(impact && impact.energy > 100, 'The wall hit made no impact event');
    assert.ok(Math.hypot(raider.x - column.x, raider.z - column.z) >= 1.14);
});

test('crowded bodies are pushed apart in proportion to their mass and never end up stacked', () => {
    const state = createAttempt('standard', true);
    state.enemies.forEach(e => { e.cooldown = 999; });
    const [a, b] = state.companions;
    state.companions.forEach(c => { c.delay = 999; c.health = 30; });
    Object.assign(a, { x: 0, z: 70, mass: 120 });
    Object.assign(b, { x: 0.1, z: 70, mass: 40 });
    const ax = a.x, bx = b.x;
    for (let i = 0; i < 30; i++) advance(state, {}, 1 / 60);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= MIN_GAP - 0.05, 'Two bodies still overlap');
    assert.ok(Math.abs(b.x - bx) + Math.abs(b.z - 70) > 2 * (Math.abs(a.x - ax) + Math.abs(a.z - 70)), 'The light one did not give way more');
});
