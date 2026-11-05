// PoMarbleRace map health: every course runs one full 101-marble demo race on the real engine
// (scripts/pomarblerace/harness.mjs — rendering and audio stubbed, fixed 1/60 s steps, pinned
// seed), and the field must come home: few marbles lost, few left stalled at the timeout, no
// marble parked for long, and a field that is not strung out. Then the tunnelling check fires
// every marble at the speed cap into the floor and both walls along the whole course, and none
// may leave it. The bounds are today's figures (seed 1) plus headroom, so a change to a course,
// the collision shell, the containment, the unstick or the physics constants that makes things
// worse fails here — the browser version is the slower E2EUI MarbleRaceMapCertificationTests.
//
//   (cd scripts/pomarblerace && npm ci)
//   node --test tests/pomarblerace-map-health.test.mjs
//
// Each run is its own process, as many at once as there are cores, slowest maps first, so the
// wall time is about the slowest map (Grand Spiral, a few minutes) on a 4-core runner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const harness = path.resolve(here, '../scripts/pomarblerace/harness.mjs');

// lost = eliminated, stalled = still running at the 180 s timeout, maxStall = longest a marble
// went without the engine's own progress threshold, spread = median finish over the winner's.
// Measured on seed 1 (2026-11-05), each bound a little above it:
//   Neon Chute      101 home, 0 lost, 0 stalled, max stall 19 s, spread 1.41
//   Spiral Works     95 home, 6 lost, 0 stalled, max stall 60 s, spread 1.48
//   Grand Spiral     76 home, 17 lost, 8 stalled, max stall 116 s, spread 1.78
//   Canyon Run      101 home, 0 lost, 0 stalled, max stall 49 s, spread 1.67
//   Playground Run  101 home, 0 lost, 0 stalled, max stall 13 s, spread 1.61
// The two authored spirals still lose marbles through their shells (Spiral Works at the Merge ->
// Penalty drop and LowerA's mouth; Grand Spiral in LowerA and the SplitC fan), so their bounds
// record today's state, not a target: tighten them as those are fixed. The E2EUI certification
// keeps the zero-loss target and fails on both until then.
const BOUNDS = {
    1: { name: 'Neon Chute', lost: 1, stalled: 1, maxStall: 40, spread: 1.8 },
    2: { name: 'Spiral Works', lost: 9, stalled: 3, maxStall: 90, spread: 1.9 },
    3: { name: 'Grand Spiral', lost: 22, stalled: 12, maxStall: 150, spread: 2.2 },
    4: { name: 'Canyon Run', lost: 1, stalled: 1, maxStall: 80, spread: 2.0 },
    5: { name: 'Playground Run', lost: 1, stalled: 1, maxStall: 30, spread: 2.0 },
};

const slots = { free: Math.max(1, os.cpus().length), waiting: [] };
async function run(cmd, map) {
    if (slots.free === 0) await new Promise((r) => slots.waiting.push(r));
    else slots.free--;
    try { return await spawn(cmd, map); } finally {
        const next = slots.waiting.shift();
        if (next) next(); else slots.free++;
    }
}

function spawn(cmd, map) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [harness, cmd, String(map), '1'], { maxBuffer: 1 << 20, timeout: 20 * 60_000 },
            (err, stdout, stderr) => (err ? reject(new Error(`${cmd} ${map}: ${err.message}\n${stderr}`))
                : resolve(JSON.parse(stdout.trim().split('\n').pop()))));
    });
}

const ids = Object.keys(BOUNDS).map(Number);
// Start everything up front; each test awaits its own result.
// Longest first so the slowest course never starts last.
const races = new Map([3, 5, 2, 4, 1].map((id) => [id, run('race', id)]));
const tunnels = new Map(ids.map((id) => [id, run('tunnel', id)]));
// A run that fails before its test awaits it must not surface as an unhandled rejection.
for (const p of [...races.values(), ...tunnels.values()]) p.catch(() => {});

for (const id of ids) {
    const b = BOUNDS[id];
    test(`${b.name}: the field comes home`, async () => {
        const r = await races.get(id);
        const why = JSON.stringify(r);
        assert.ok(r.eliminated <= b.lost, `${b.name}: ${r.eliminated} marbles lost > ${b.lost} — ${why}`);
        assert.ok(r.stalled <= b.stalled, `${b.name}: ${r.stalled} still running at the timeout > ${b.stalled} — ${why}`);
        assert.ok(r.finished >= 101 - b.lost - b.stalled, `${b.name}: only ${r.finished} finished — ${why}`);
        assert.ok(r.maxStall <= b.maxStall, `${b.name}: a marble sat ${r.maxStall} s > ${b.maxStall} s — ${why}`);
        assert.ok(r.winner > 0 && r.median <= r.winner * b.spread, `${b.name}: the field is strung out — ${why}`);
    });
    test(`${b.name}: no marble tunnels out at the speed cap`, async () => {
        const t = await tunnels.get(id);
        assert.deepEqual(t.escaped, [], `${b.name}: ${t.escaped.length} of ${t.shots} shots left the course`);
    });
}
