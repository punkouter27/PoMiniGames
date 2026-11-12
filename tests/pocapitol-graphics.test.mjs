import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Same loading trick as the other PoCapitol tests: each module is a data: URL with its relative
// imports rewritten, so these run the exact files the browser loads.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const read = path => readFileSync(new URL(path, client), 'utf8');
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const yuka = url(read('lib/yuka/yuka.module.js'));
const physicsUrl = url(read('js/pocapitol/physics.js'));
const physics = await import(physicsUrl);
const steering = url(read('js/pocapitol/steering.js').replace("'yuka'", `'${yuka}'`).replace("'./physics.js'", `'${physicsUrl}'`));
const harm = url(read('js/pocapitol/harm.js'));
const worldUrl = url(read('js/pocapitol/world.js')
    .replace("'./steering.js'", `'${steering}'`)
    .replace("'./physics.js'", `'${physicsUrl}'`)
    .replace("'./harm.js'", `'${harm}'`));
const world = await import(worldUrl);
const audio = await import(url(read('js/pocapitol/audio.js').replace("'./world.js'", `'${worldUrl}'`)));
const quality = await import(url(read('js/pocapitol/quality.js')));

const { firstBodyHit, SWEPT_RADIUS } = physics;

test('a hard knockback cannot pass through the body it was aimed at', () => {
    const target = { x: 1.2, z: 0, health: 100 };
    const hit = firstBodyHit(0, 0, 4, 0, [target]);
    assert.ok(hit && hit.body === target, 'The swept path missed a body standing in it');
    // The contact is where the swept radius first touches the target, not at the end point.
    const expected = (1.2 - SWEPT_RADIUS) / 4;
    assert.ok(Math.abs(hit.t - expected) < 1e-9, `Contact at ${hit.t}, expected ${expected}`);
    // A body that has already fallen is stepped over, not hit again.
    assert.equal(firstBodyHit(0, 0, 4, 0, [{ x: 1.2, z: 0, health: 0 }]), null);
    // Nor does a path clip someone walking just wide of it, or find a body behind the start.
    assert.equal(firstBodyHit(0, 0, 4, 0, [{ x: 2, z: 0.5, health: 100 }]), null);
    assert.equal(firstBodyHit(0, 0, 4, 0, [{ x: -2, z: 0, health: 100 }]), null);
    // The mover never collides with itself.
    const self = { x: 0, z: 0, health: 100 };
    assert.equal(firstBodyHit(0, 0, 4, 0, [self], { skip: self }), null);
});

test('the graphics tier falls back to what the browser actually reports', () => {
    assert.equal(quality.detectTier({ webgl2: false }), 'low');
    assert.equal(quality.detectTier({ webgl2: true, maxTexture: 2048, memory: 16, cores: 16 }), 'low');
    assert.equal(quality.detectTier({ webgl2: true, maxTexture: 4096, memory: 4, cores: 4 }), 'medium');
    assert.equal(quality.detectTier({ webgl2: true, maxTexture: 16384, memory: 8, cores: 16 }), 'high');
    // A stored mode from another build is ignored rather than trusted.
    assert.equal(quality.preferredMode('ultra'), 'auto');
    assert.equal(quality.preferredMode('low'), 'low');
    assert.equal(quality.preferredMode(null, 'high'), 'high');
});

test('a hidden tab cannot walk the quality ladder down', () => {
    const governor = quality.createGovernor({ tier: 'high', mode: 'auto' });
    const start = governor.settings();
    governor.suspend(true);
    // Sixty 20 fps frames: enough slow windows to drop a rung twice if they were counted.
    for (let i = 0; i < 60; i++) assert.equal(governor.sample(0.05), null);
    assert.equal(governor.settings(), start, 'A backgrounded tab changed the graphics settings');
    governor.suspend(false);
    let changed = null;
    for (let i = 0; i < 240 && !changed; i++) changed = governor.sample(0.05);
    assert.ok(changed, 'The governor stopped adapting once sampling resumed');
    assert.ok(changed.scale < start.scale, 'The governor did not ease the settings down under load');
});

test('footsteps agree with the ground the renderer draws', () => {
    assert.equal(audio.footstepMaterial(0, 4), 'marble', 'Indoors is not a marble floor');
    assert.equal(audio.footstepMaterial(0, 18), 'marble', 'The terrace treads lost their stone');
    assert.equal(audio.footstepMaterial(0, 26), 'marble', 'The paved approach lost its stone');
    assert.equal(audio.footstepMaterial(22, 26), 'ground', 'The lawn beside the walk is not turf');
    assert.equal(audio.footstepMaterial(0, 80), 'ground', 'The grass the crowd starts on is not turf');
});

test('air only ever dulls a sound as it travels', () => {
    const near = audio.airAbsorption(0), far = audio.airAbsorption(60), beyond = audio.airAbsorption(400);
    assert.equal(near, 18000);
    assert.ok(far < near && beyond < far, 'Air absorption did not fall with distance');
    assert.equal(beyond, 2200, 'Air absorption has no floor, so distant sound goes silent');
});

test('heavy impacts gain weight and hard impacts gain a crack', () => {
    const light = audio.impactLayers(30, 75);
    assert.deepEqual(light, { sub: 0, crack: 0 });
    const heavy = audio.impactLayers(30, 220), hard = audio.impactLayers(400, 75);
    assert.ok(heavy.sub > 0 && heavy.crack === 0, 'A heavy target did not add a low thump');
    assert.ok(hard.crack > 0 && hard.sub === 0, 'A hard blow did not add a crack');
    const biggest = audio.impactLayers(4000, 900);
    assert.ok(biggest.sub <= 0.5 && biggest.crack <= 0.5, 'Impact layers are not clamped');
});

test('room picks spread the crowd through the building', () => {
    const { interiorRooms, interiorRoomFor, areas } = world;
    const picks = Array.from({ length: 60 }, (_, id) => interiorRoomFor(id));
    const withRoom = picks.filter(i => i >= 0);
    assert.ok(withRoom.length >= 15 && withRoom.length <= 25, `Expected about a third to break off, got ${withRoom.length}/60`);
    assert.ok(new Set(withRoom).size >= 5, 'Everyone who broke off picked the same corner');
    for (const room of interiorRooms) {
        const area = areas.find(a => a.name === room.name);
        assert.ok(area, `Unknown room ${room.name}`);
        assert.ok(Math.abs(room.x - area.x) <= area.w / 2 && Math.abs(room.z - area.z) <= area.d / 2, `${room.name} anchor is outside its room`);
    }
    // A room anchor has to be somewhere a person can actually stand.
    assert.ok(interiorRooms.every(room => world.walkable(room.x, room.z)), 'A room anchor sits in geometry');
});

test('a blast weakens with distance and stops at its edge', () => {
    const { blastFalloff } = physics;
    assert.equal(blastFalloff(0, 6), 1);
    assert.ok(blastFalloff(3, 6) > blastFalloff(5, 6), 'A blast was stronger further away');
    assert.equal(blastFalloff(6, 6), 0);
    assert.equal(blastFalloff(9, 6), 0);
    assert.equal(blastFalloff(-1, 6), 0);
});

test('both sides field a few grenade carriers with three each', () => {
    const state = world.createAttempt('standard', false, 'raider');
    const raiderCarriers = state.companions.filter(c => c.grenades > 0);
    const officerCarriers = state.enemies.filter(e => e.grenades > 0);
    assert.ok(raiderCarriers.length >= 3 && raiderCarriers.length <= 12, `Raider carriers: ${raiderCarriers.length}`);
    assert.ok(officerCarriers.length >= 2, 'No officer on the other side carries one');
    assert.ok([...raiderCarriers, ...officerCarriers].every(a => a.grenades === 3));
    assert.equal(state.grenades.length, 0);
});

test('the one-player raider carries a machine gun and five grenades', () => {
    const state = world.createAttempt('standard', false, 'raider');
    assert.equal(state.weapon, 'mg');
    assert.equal(state.playerGrenades, 5);
    const target = state.enemies[0];
    state.player.x = target.x; state.player.z = target.z + 6;
    const before = target.health;
    const shot = world.fire(state, { x: 0, z: -1 });
    assert.ok(shot, 'The machine gun did not fire');
    assert.ok(state.shots.length >= 1, 'No tracer was drawn');
    assert.ok(state.events.some(e => e.type === 'gunshot'), 'The burst made no sound event');
    assert.ok(target.health < before, 'The burst missed an officer straight ahead');
    // The trigger has a rate limit, so holding it down is a burst, not a laser.
    assert.equal(world.fire(state, { x: 0, z: -1 }), null);
});

test('a thrown grenade lifts the people around it off their feet', () => {
    const state = world.createAttempt('standard', false, 'raider');
    state.player.x = 0; state.player.z = 20;
    const victim = state.companions[1];
    victim.x = 0; victim.z = 2.5;
    const thrown = world.throwPlayerGrenade(state, { x: 0, z: -1 });
    assert.ok(thrown, 'The grenade was not thrown');
    assert.equal(state.playerGrenades, 4, 'The grenade count did not fall');
    let exploded = false;
    for (let i = 0; i < 140 && state.status === 'active'; i++) {
        world.advance(state, {}, 1 / 60);
        if (state.events.some(e => e.type === 'grenade')) exploded = true;
        if (exploded) break;
    }
    assert.ok(exploded, 'The grenade never detonated');
    assert.ok((victim.y ?? 0) > 0 || (victim.vy ?? 0) > 0, 'The blast did not throw anyone into the air');
});

test('a walker rises over a body instead of clipping through it', () => {
    const state = world.createAttempt('standard', true);
    const fallen = state.companions[0], walker = state.companions[1];
    fallen.health = 0; fallen.x = 0; fallen.z = 40;
    walker.health = 30; walker.x = 0.2; walker.z = 40;
    world.advance(state, {}, 1 / 60);
    assert.ok((walker.step ?? 0) > 0.2, 'The walker did not step over the body');
});
