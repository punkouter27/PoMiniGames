import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/poracer/snapshot.js', import.meta.url), 'utf8');
const { prepareSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function field(count = 100) {
    const cars = Array.from({ length: count }, (_, i) => ({
        id: i + 1, x: i + 0.1, y: i + 0.2, heading: i + 0.3, speed: i + 0.4,
        boostGlow: 0.5, skidIntensity: 0.6, damage: 0.7, surface: i % 2 ? 'sand' : 'asphalt',
        position: i + 1, lap: 2, finished: false, drafting: true, drift: 0.8, boostTimer: 0.9,
        currentLapSeconds: 12.345, bestLapSeconds: 11, lastLapSeconds: 13,
        slip: 0.12 - i * 0.001, tireHeat: 0.3, draft: 0.75,
    }));
    return {
        snapshot: { cars, serverTimeMs: 10000, elapsedRaceTime: 7, countdownMs: 0,
            countdownSeconds: 0, started: true, paused: false, finished: false },
        roster: cars.map(c => ({ id: c.id })),
    };
}

test('all 100 cars reach rendering, with the original 17-number stride', () => {
    const { snapshot, roster } = field();
    const { flat, hud, lapNow, running } = prepareSnapshot(snapshot, roster, 49);
    assert.equal(flat.length, 1700);
    for (let i = 0; i < snapshot.cars.length; i++) {
        const c = snapshot.cars[i];
        assert.deepEqual([...flat.slice(i * 17, (i + 1) * 17)],
            [c.x, c.y, c.heading, c.speed, c.boostGlow, c.skidIntensity, c.damage,
                c.surface === 'sand' ? 1 : 0, c.position, c.lap, 0, 1, c.drift, c.boostTimer,
                c.slip, c.tireHeat, c.draft]);
    }
    assert.deepEqual(hud.cars.map(c => c.position), [1, 49, 50, 51]);
    assert.equal(hud.serverTimeMs, snapshot.serverTimeMs);
    assert.equal(hud.cars.find(c => c.id === 50).bestLapSeconds, 11);
    assert.equal(lapNow, 12.345);
    assert.equal(running, true);
    assert.equal(snapshot.cars.length, 100);
});

test('spectators and drivers at either end retain four readable standings', () => {
    const { snapshot, roster } = field();
    for (const [local, positions] of [[-1, [1, 2, 3, 4]], [0, [1, 2, 3, 4]], [99, [1, 98, 99, 100]]]) {
        assert.deepEqual(prepareSnapshot(snapshot, roster, local).hud.cars.map(c => c.position), positions);
    }
    assert.equal(prepareSnapshot(snapshot, roster, -1).lapNow, 0);
});

test('trial and 8-car online fields preserve player, finish, pause and timing', () => {
    for (const count of [1, 8]) {
        const { snapshot, roster } = field(count);
        snapshot.cars[0].finished = true;
        snapshot.paused = true;
        let prepared = prepareSnapshot(snapshot, roster, 0);
        assert.equal(prepared.flat[10], 1);
        assert.equal(prepared.hud.cars.length, Math.min(4, count));
        assert.equal(prepared.running, false);
        snapshot.paused = false; snapshot.finished = true;
        assert.equal(prepareSnapshot(snapshot, roster, 0).running, false);
        snapshot.finished = false; snapshot.started = false;
        assert.equal(prepareSnapshot(snapshot, roster, 0).running, false);
    }
});

test('car IDs are resolved by roster order, not assumed to be positions', () => {
    const { snapshot, roster } = field();
    snapshot.cars[49].position = 1;
    snapshot.cars[0].position = 50;
    const prepared = prepareSnapshot(snapshot, roster, 49);
    assert.equal(prepared.flat[49 * 17 + 8], 1);
    assert.ok(prepared.hud.cars.some(c => c.id === 50));
});

test('invalid field sizes and changed car order fail explicitly', () => {
    const { snapshot, roster } = field();
    assert.throws(() => prepareSnapshot(snapshot, [], -1), /does not match/);
    assert.throws(() => prepareSnapshot({ cars: [] }, [], -1), /does not match/);
    snapshot.cars[0].id = 999;
    assert.throws(() => prepareSnapshot(snapshot, roster, -1), /order changed/);
});

// The ghost lap (js/ghostTrack.js): quantized Int16 deltas in base64, decoded back for playback.
const ghostSource = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/ghostTrack.js', import.meta.url), 'utf8');
const ghost = await import(`data:text/javascript;base64,${Buffer.from(ghostSource).toString('base64')}`);

test('a ghost lap survives encode and decode within one quantization step, with no drift', () => {
    // A 40 s lap at 20 Hz round a 3000-unit circuit, heading unwrapped past several turns,
    // plus one 5000-unit jump (a respawn) that no single Int16 delta can carry.
    const times = [], values = [];
    let h = 0;
    for (let i = 0; i <= 2000; i++) {
        const t = i * 0.02 + (i % 3) * 0.003;
        const a = t / 40 * Math.PI * 2;
        const jump = t > 20 && t < 20.5 ? 5000 : 0;
        h = ghost.unwrap(h, a + Math.PI / 2);
        times.push(t);
        values.push(1500 * Math.cos(a) + jump, 900 * Math.sin(a), h);
    }
    const grid = ghost.resample(times, values, 3, 20);
    assert.equal(grid.length / 3, Math.floor(times.at(-1) * 20) + 1);
    const text = ghost.encodeTrack(grid, 3, 20, [10, 10, 1000]);
    assert.match(text, /^[A-Za-z0-9+/]+=*$/);
    assert.ok(text.length < grid.length * 2 * 1.4 + 64, 'about two bytes a number, base64');

    const track = ghost.decodeTrack(text);
    assert.deepEqual([track.channels, track.hz, track.frames], [3, 20, grid.length / 3]);
    let worst = 0;
    for (let f = 0; f < track.frames; f++) {
        const t = f / 20;
        if (t > 19.9 && t < 21.5) continue;   // the respawn is caught up over a few frames
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(track.data[f * 3 + c] - grid[f * 3 + c]) * (c === 2 ? 1000 : 10));
    }
    assert.ok(worst <= 0.5001, `max error ${worst} quantization steps`);
    // Last frame exact to the step: deltas are taken against the reconstruction, so nothing drifts.
    assert.ok(Math.abs(track.data.at(-3) - grid.at(-3)) <= 0.05);

    const out = [0, 0, 0];
    assert.deepEqual(ghost.sampleAt(track, 0, out).map(v => Math.round(v)), [1500, 0, 2]);
    assert.equal(ghost.sampleAt(track, -1, out), null);
    assert.equal(ghost.sampleAt(track, track.frames / 20 + 1, out), null);
    for (const bad of ['', 'not base64!', text.slice(0, 20), null]) assert.equal(ghost.decodeTrack(bad), null);
});
