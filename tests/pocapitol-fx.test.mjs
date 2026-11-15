import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The picture-and-sound layers that are pure arithmetic: gas on a grid, loose racks, the wave
// through a packed crowd, hanging cloth, and the routes sound takes. None of them is read by the
// simulation, so these check that each behaves like the thing it stands for.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { createGasGrid } = await import(new URL('js/pocapitol/gasGrid.js', client));
const { createBarricades, STACK_LIFT } = await import(new URL('js/pocapitol/barricades.js', client));
const { createSurge, SURGE_SWAY } = await import(new URL('js/pocapitol/surge.js', client));
const { createCloth } = await import(new URL('js/pocapitol/cloth.js', client));

// audio.js imports world.js, which imports yuka by bare name: same data-URL trick as the other tests.
const read = path => readFileSync(new URL(path, client), 'utf8');
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const yuka = url(read('lib/yuka/yuka.module.js'));
const physicsUrl = url(read('js/pocapitol/physics.js'));
const steering = url(read('js/pocapitol/steering.js').replace("'yuka'", `'${yuka}'`).replace("'./physics.js'", `'${physicsUrl}'`));
const harm = url(read('js/pocapitol/harm.js'));
const barricadesUrl = url(read('js/pocapitol/barricades.js').replace("'./physics.js'", `'${physicsUrl}'`));
const surgeUrl = url(read('js/pocapitol/surge.js'));
const worldUrl = url(read('js/pocapitol/world.js')
    .replace("'./steering.js'", `'${steering}'`).replace("'./physics.js'", `'${physicsUrl}'`).replace("'./harm.js'", `'${harm}'`).replace("'./barricades.js'", `'${barricadesUrl}'`).replace("'./surge.js'", `'${surgeUrl}'`));
const audio = await import(url(read('js/pocapitol/audio.js').replace("'./world.js'", `'${worldUrl}'`)));

test('gas drifts downwind, stops at a wall and thins out', () => {
    // A wall across the middle of a 40 m square, with the gas let off on the near side of it.
    const wall = (x, z) => Math.abs(z - 20) < 1.5;
    const grid = createGasGrid({ x0: 0, z0: 0, w: 40, d: 40 }, 32, 32, wall, () => false);
    assert.equal(grid.step(0.05), false, 'An empty grid did work');
    for (let i = 0; i < 80; i++) grid.step(0.05, [{ x: 20, z: 10, rate: 1, r: 3 }], { x: 9, z: 0 });
    assert.ok(grid.sample(20, 10) > 0.2, 'No gas where it was released');
    assert.ok(grid.sample(27, 10) > grid.sample(13, 10) * 1.5, 'The cloud did not lean downwind');
    assert.equal(grid.sample(20, 20), 0, 'Gas is inside the wall');
    assert.ok(grid.sample(20, 30) < 0.01, 'Gas went through the wall');
    const before = grid.sample(24, 10);
    for (let i = 0; i < 2400; i++) grid.step(0.05, [], { x: 0, z: 0 });
    assert.ok(grid.sample(24, 10) < before * 0.1, 'The cloud never thinned');
    assert.ok(grid.bytes.every(b => b <= 255));
});

test('a released rack falls, lands once, and is shoved along by a walker', () => {
    const racks = createBarricades(3);
    racks.release(0, { x: 0, z: 0, yaw: 0, tip: 0.2 });
    let landings = 0;
    for (let i = 0; i < 120; i++) landings += racks.step(1 / 60).filter(e => e.type === 'land').length;
    const rack = racks.bodies[0];
    assert.equal(rack.tip, 1, 'The rack never reached the ground');
    assert.ok(landings >= 1 && landings <= 2, `Landed ${landings} times`);
    assert.ok(rack.landed);
    // Down on the ground it is in the way: whoever stands on it loses pace, and nobody else does.
    assert.ok(racks.dragAt(rack.x, rack.z) > 0.3, 'A rack on the ground slows nobody');
    assert.equal(racks.dragAt(rack.x + 6, rack.z), 0);
    // Someone walks into its middle heading +x at 2 m/s for a second.
    for (let i = 0; i < 60; i++) racks.step(1 / 60, [{ x: rack.x, z: rack.z, vx: 2, vz: 0, mass: 80 }]);
    assert.ok(rack.x > 0.5, `A walker moved the rack only ${rack.x.toFixed(2)} m`);
    const at = rack.x;
    for (let i = 0; i < 240; i++) racks.step(1 / 60);
    assert.ok(rack.x - at < 1.5 && Math.hypot(rack.vx, rack.vz) < 0.05, 'The rack never ground to a stop');
    // A wall stops it; a rack left on top of another rides up.
    racks.reset();
    racks.release(1, { x: 0, z: 0, yaw: 0, tip: 0.9 }); racks.release(2, { x: 0.1, z: 0.1, yaw: 0.2, tip: 0.9 });
    for (let i = 0; i < 180; i++) racks.step(1 / 60);
    const [a, b] = [racks.bodies[1], racks.bodies[2]];
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 0.3 || b.y > STACK_LIFT * 0.5, 'Two racks ended up inside each other on the ground');
});

test('a push through the crowd travels, rocks only the packed, and dies away', () => {
    const surge = createSurge({ x0: 0, z0: 0, w: 60, d: 60 }, 2);
    assert.equal(surge.step(0.02), false);
    surge.push(30, 30, 2, 4);
    const early = { x: 0, z: 0, lean: 0 }, late = { x: 0, z: 0, lean: 0 };
    let arrived = -1;
    for (let i = 0; i < 400; i++) {
        surge.step(1 / 60);
        if (i === 3) surge.sample(44, 30, 1, early);
        if (arrived < 0 && Math.abs(surge.heightAt(44, 30)) > 0.01) arrived = i / 60;
    }
    assert.ok(early.lean < 0.01, 'The push was felt 14 m away at once');
    assert.ok(arrived > 1 && arrived < 6, `The wave reached 14 m after ${arrived.toFixed(2)} s`);
    surge.sample(44, 30, 1, late);
    assert.ok(Math.hypot(late.x, late.z) <= SURGE_SWAY + 1e-9);
    // Someone with room to stand is not rocked at all.
    surge.reset(); surge.push(30, 30, 2, 4);
    for (let i = 0; i < 20; i++) surge.step(1 / 60);
    assert.equal(surge.sample(32, 30, 0).lean, 0);
    assert.ok(surge.sample(33, 30, 1).lean > 0, 'A packed neighbour of the push was not rocked');
    for (let i = 0; i < 1500; i++) surge.step(1 / 60);
    assert.equal(surge.active(), false, 'The wave never died away');
});

test('hung cloth keeps its length, stays pinned, and blows out downwind', () => {
    const cloth = createCloth({ width: 4, height: 2, cols: 12, rows: 7 });
    const bottom = i => cloth.positions.slice(((cloth.rows - 1) * cloth.cols + i) * 3, ((cloth.rows - 1) * cloth.cols + i) * 3 + 3);
    for (let i = 0; i < 300; i++) cloth.step(1 / 60, 0, i / 60);
    assert.ok(Math.abs(bottom(5)[1] + 2) < 0.12, `Still air: the hem hangs at ${bottom(5)[1].toFixed(2)}, not -2`);
    for (let i = 0; i < 300; i++) cloth.step(1 / 60, 6, 5 + i / 60);
    assert.ok(cloth.swing() > 0.1, 'Wind through the cloth did not move it');
    // The top row has not moved, and no point has stretched away from it.
    for (let i = 0; i < cloth.cols; i++) assert.equal(cloth.positions[i * 3 + 1], 0);
    for (let k = 0; k < cloth.positions.length; k += 3) {
        assert.ok(Math.hypot(cloth.positions[k + 1], cloth.positions[k + 2]) < 2.25, 'The cloth stretched');
    }
    cloth.impulse(20, -1);
    for (let i = 0; i < 12; i++) cloth.step(1 / 60, 0, 10 + i / 60);
    const kicked = cloth.swing();
    for (let i = 0; i < 600; i++) cloth.step(1 / 60, 0, 11 + i / 60);
    assert.ok(Math.abs(cloth.swing()) < Math.abs(kicked) + 0.05, 'A kicked banner never settled');
});

test('sound goes round through doorways, later and duller the more it turns', () => {
    const lawn = { x: 0, z: 40 }, crypt = { x: 0, z: 5 }, cryptCorner = { x: 8, z: 2 }, rotunda = { x: 14, z: -20 };
    // Same room: straight there.
    const direct = audio.soundPath({ x: 5, z: 50 }, lawn);
    assert.equal(direct.doors, 0);
    assert.ok(Math.abs(direct.length - Math.hypot(5, 10)) < 1e-9);
    // Straight through an open doorway on the centre line: one door, no turn, hardly dulled.
    const through = audio.soundPath(crypt, lawn);
    assert.equal(through.doors, 1);
    assert.ok(through.bend < 0.01 && Math.abs(through.length - 35) < 1e-6);
    assert.ok(audio.pathTone(through).cutoff > 9000);
    // Round a corner: longer than the straight line, heard from the doorway, and duller.
    const side = { x: -30, z: 16 };
    const round = audio.soundPath(cryptCorner, side);
    assert.ok(round.length > Math.hypot(38, 14) + 1, 'The route round the corner was not longer than through the wall');
    assert.ok(round.bend > 0.5);
    assert.ok(audio.pathTone(round).cutoff < audio.pathTone(through).cutoff / 2);
    // It is heard from the near edge of the doorway, not from where the source really is.
    const heard = Math.atan2(round.x - side.x, round.z - side.z), doorway = Math.atan2(-4.5 - side.x, 14.5 - side.z);
    assert.ok(Math.abs(heard - doorway) < 1e-6, 'The sound was not heard from the doorway');
    // Two rooms away: two doors, quieter again.
    const far = audio.soundPath(rotunda, lawn);
    assert.equal(far.doors, 2);
    assert.ok(audio.pathTone(far).level < audio.pathTone(through).level);
});

test('outdoor bangs echo off the faces that can see them, and duck the beds by nearness', () => {
    // In front of the west front, both on the centre line: one echo, off the building.
    const echoes = audio.facadeEchoes({ x: 0, z: 30 }, { x: 0, z: 34 });
    assert.equal(echoes.length, 1);
    assert.ok(Math.abs(echoes[0].length - (15.3 + 19.3)) < 1e-6, `Echo path ${echoes[0].length}`);
    // Out on the lawn beside a stand: the stand's own face answers as well.
    assert.ok(audio.facadeEchoes({ x: -25, z: 50 }, { x: -22, z: 60 }).length >= 2);
    // Indoors there are no facade echoes; the room's own reverb covers it.
    assert.equal(audio.facadeEchoes({ x: 0, z: 5 }, { x: 0, z: 8 }).length, 0);
    assert.equal(audio.duckDepth('shove', 30, 1), 0);
    assert.ok(audio.duckDepth('grenade', 0, 2) > audio.duckDepth('grenade', 0, 40));
    assert.ok(audio.duckDepth('flash', 0, 0) <= 0.75);
    assert.ok(audio.duckDepth('impact', 200, 3) > 0 && audio.duckDepth('impact', 40, 3) === 0);
});
