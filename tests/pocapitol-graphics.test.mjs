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

test('a smoke grenade hides the street and hurts nobody', () => {
    const state = world.createAttempt('standard', false, 'raider');
    assert.equal(state.playerSmoke, 2, 'The solo raider should carry two smoke grenades');
    assert.ok([...state.companions, ...state.enemies].some(a => a.grenadeType === 'smoke'), 'Nobody carries smoke');
    state.player.x = 0; state.player.z = 20;
    const thrown = world.throwPlayerGrenade(state, { x: 0, z: -1 }, 'smoke');
    assert.ok(thrown, 'The smoke grenade was not thrown');
    assert.equal(state.playerSmoke, 1);
    let smoked = false;
    for (let i = 0; i < 160 && state.status === 'active'; i++) {
        world.advance(state, {}, 1 / 60);
        if (state.events.some(e => e.type === 'smoke')) { smoked = true; break; }
    }
    assert.ok(smoked, 'The smoke never vented');
    const cloud = state.effects.find(e => e.type === 'smoke');
    assert.ok(cloud && cloud.life > 10, 'The cloud did not linger');
    assert.ok(world.smokeObscures(state.effects, 0, 12, 0, -6), 'The cloud does not block a sight line');
    assert.ok(!world.smokeObscures(state.effects, 30, 12, 30, -6), 'A cloud blocked a line nowhere near it');
    assert.ok(!state.events.some(e => e.type === 'grenade'), 'Smoke detonated as a blast');
});

test('a corpse thrown into the air comes back down', () => {
    const state = world.createAttempt('standard', true);
    const officer = state.enemies[0];
    officer.health = 0; officer.y = 0; officer.vy = 6;
    for (let i = 0; i < 150; i++) world.advance(state, {}, 1 / 60);
    assert.equal(officer.y ?? 0, 0, 'The body is still floating');
});

test('the demo holds fire for seven seconds, then the police open up and the crowd scatters', () => {
    const state = world.createAttempt('standard', true);
    const officer = state.enemies[0], spot = state.companions[0];
    spot.x = officer.x; spot.z = officer.z + 3; spot.health = 30;
    for (let i = 0; i < 60 * 6 && state.status === 'active'; i++) world.advance(state, {}, 1 / 60);
    assert.equal(state.openedFire, false, 'The volley came before the seven seconds were up');
    assert.equal(state.shots.length, 0, 'Someone fired during the calm');
    let volley = false, panic = false;
    for (let i = 0; i < 60 * 2 && state.status === 'active'; i++) {
        world.advance(state, {}, 1 / 60);
        if (state.events.some(e => e.type === 'openfire')) volley = true;
        if (state.companions.some(c => (c.panic ?? 0) > 0)) panic = true;
    }
    assert.equal(state.openedFire, true, 'The police never opened fire');
    assert.ok(volley, 'No opening-volley event was raised');
    assert.ok(panic, 'The crowd did not scatter');
});

test('a protestor round can hit another protestor', () => {
    const state = world.createAttempt('standard', true);
    const mate = state.companions[3];
    mate.x = 0; mate.z = 38; mate.health = 30;
    const before = mate.health;
    state.openedFire = true;
    state.shots.push({ x: 0, z: 40, dx: 0, dz: -1, life: 1, faction: 'raider', owner: state.companions[0].id });
    for (let i = 0; i < 30 && state.status === 'active'; i++) world.advance(state, {}, 1 / 60);
    assert.ok(mate.health < before, 'The round passed through the protestor in front of it');
});

test('a walker rises over a body instead of clipping through it', () => {
    const state = world.createAttempt('standard', true);
    const fallen = state.companions[0], walker = state.companions[1];
    fallen.health = 0; fallen.x = 0; fallen.z = 40;
    walker.health = 30; walker.x = 0.2; walker.z = 40;
    world.advance(state, {}, 1 / 60);
    assert.ok((walker.step ?? 0) > 0.2, 'The walker did not step over the body');
});

test('a wall takes most of a blast: the same distance hurts far less from the next room', () => {
    const { blastExposure, BLAST_SHADOW, walkable } = world;
    // Inside the Rotunda, open floor between the two points.
    assert.ok(walkable(-13, -20) && walkable(-10, -20));
    assert.equal(blastExposure(-13, -20, -10, -20), 1);
    // The Crypt is 18 m wide and the Rotunda 34 m: x = -13 is behind the Crypt's side wall.
    assert.ok(walkable(-8, -1) && walkable(-11, -3.5));
    assert.equal(blastExposure(-8, -1, -11, -3.5), BLAST_SHADOW);
    assert.ok(BLAST_SHADOW > 0 && BLAST_SHADOW < 0.5, "pressure still gets round a corner, just much less of it");

    // Two blasts at the same 3.9 m: one across open floor, one through the Crypt wall.
    const open = world.createAttempt("standard", false, "raider");
    const shielded = world.createAttempt("standard", false, "raider");
    for (const state of [open, shielded]) {
        state.companions.length = 1; state.enemies.length = 0;
        state.lines.forEach(line => { line.state = "broken"; });
    }
    Object.assign(open.companions[0], { x: -10, z: -20, health: 30, stun: 0 });
    Object.assign(shielded.companions[0], { x: -11, z: -3.5, health: 30, stun: 0 });
    for (const [state, at] of [[open, { x: -13.9, z: -20 }], [shielded, { x: -8, z: -1 }]]) {
        state.grenades.push({ fromX: at.x, fromZ: at.z, x: at.x, z: at.z, toX: at.x, toZ: at.z, t: 0, fuse: 0.01, kind: "concussion" });
        world.advance(state, {}, 1 / 60); world.advance(state, {}, 1 / 60);
    }
    const openLoss = 30 - open.companions[0].health, shieldedLoss = 30 - shielded.companions[0].health;
    assert.ok(openLoss > 0, 'an open blast should hurt');
    assert.ok(shieldedLoss > 0, 'some pressure still gets round the wall');
    assert.ok(shieldedLoss < openLoss * 0.5, `the wall did not shield anyone (${shieldedLoss} vs ${openLoss})`);
});

test('every chant beat is a vowel the choir can shape', () => {
    assert.ok(audio.CHANTS.length >= 2, 'The crowd only knows one chant');
    for (const chant of audio.CHANTS) {
        assert.equal(chant.length, 3, 'A chant is three beats and a rest');
        for (const beat of chant) {
            for (const vowel of [beat.from, beat.to]) {
                const formants = audio.VOWELS[vowel];
                assert.ok(formants, `No formants for the vowel "${vowel}"`);
                assert.ok(formants[0] < formants[1] && formants[1] < formants[2], 'Formants are out of order');
            }
        }
    }
});

test('the helicopter stays high over the grounds and keeps moving', () => {
    const a = audio.helicopterAt(0), b = audio.helicopterAt(20);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 30, 'The helicopter is hovering in one spot');
    for (let t = 0; t < 400; t += 7) {
        const at = audio.helicopterAt(t);
        assert.ok(at.y >= 90 && at.y <= 130, 'The helicopter left its altitude band');
        assert.ok(Math.hypot(at.x, at.z - 35) <= 100, 'The helicopter wandered off the grounds');
    }
});

test('wind on the microphone rises with the wind and never clips', () => {
    assert.equal(audio.micBuffet(0, 3), 0, 'Still air buffeted the microphone');
    for (let t = 0; t < 30; t += 0.37) {
        const calm = audio.micBuffet(3, t), gale = audio.micBuffet(12, t);
        assert.ok(gale >= calm, 'A stronger wind buffeted less');
        assert.ok(gale >= 0 && gale <= 1, 'Buffet left 0..1');
    }
});

test('the curfew alert lands in the afternoon, before the curfew itself', () => {
    assert.ok(audio.CURFEW_ALERT_ELAPSED > 0, 'The alert fires before the scenario starts');
    assert.ok(audio.CURFEW_ALERT_ELAPSED < world.CURFEW_ELAPSED, 'The alert fires after the curfew it announces');
    assert.equal(world.clockLabel(audio.CURFEW_ALERT_ELAPSED), '2:31 PM');
});
