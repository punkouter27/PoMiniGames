// PoCabinet race health: a 100-car field races Capitol (the reference) and the Bedroom Floor GP
// (the toy track laid in a room scan) in the browser physics, and the race must flow: cars
// finish, nobody sits stalled for long, and the field is not wrecked wholesale. The harness is
// deterministic (same world, same driver, same numbers), so the bounds are fixed, with headroom
// over today's figures (capitol clean: 1 wreck, 2 stuck; bedroom clean: 12 wrecks, 0 stuck;
// bedroom messy: 23 wrecks, 8 stuck, longest stall 15 s).
//
// Needs the worlds the page hands race.js, from the shared C#:
//   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol bedroom
//   node --test tests/pocabinet-race-health.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { race } = await import(new URL('../scripts/pocabinet/harness.mjs', import.meta.url));

const BOUNDS = {
    capitol: { wrecked: 5, stuckEvents: 15, maxStuck: 10 },
    bedroom: { wrecked: 30, stuckEvents: 25, maxStuck: 30 },
};

for (const [id, max] of Object.entries(BOUNDS)) {
    for (const driver of ['clean', 'messy']) {
        test(`${id} (${driver}): the field finishes, flows and mostly survives`, () => {
            const r = race(id, driver, false);
            assert.ok(r.finished > 0, `${id}: someone finishes (${r.finished})`);
            assert.ok(r.wrecked <= max.wrecked, `${id}: ${r.wrecked} wrecks > ${max.wrecked}`);
            assert.ok(r.stuckEvents <= max.stuckEvents, `${id}: ${r.stuckEvents} stalls > ${max.stuckEvents}`);
            assert.ok(r.maxStuck <= max.maxStuck, `${id}: a car stalled ${r.maxStuck} s > ${max.maxStuck} s`);
            assert.ok(r.median > 0 && r.median < r.fieldBest * 1.8, `${id}: the field is not strung out (median ${r.median}, best ${r.fieldBest})`);
        });
    }
}
