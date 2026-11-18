// PoCabinet race health: a 64-car field races Capitol (the reference), the Bedroom Floor GP (the
// toy track laid in a room scan) and Center Court (the toy track on a scanned basketball court) in
// the browser physics, and the race must flow: cars finish, nobody sits stalled for long, and the
// field is not wrecked wholesale. The harness is deterministic (same world, same driver, same
// numbers), so the bounds are fixed, with headroom over today's figures (capitol: 0 wrecks,
// 0 stuck; bedroom: 4-6 wrecks, 0 stuck; court: 0 wrecks, 0-1 stuck, longest stall 4 s).
//
// Needs the worlds the page hands race.js, from the shared C#. They are gitignored, so the test
// dumps any that are missing itself (CI's ci-checks.ps1 dumps them up front; a fresh clone used
// to fail here with ENOENT):
//   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol bedroom court
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const IDS = ['capitol', 'bedroom', 'court'];
const repo = fileURLToPath(new URL('..', import.meta.url));
const worlds = fileURLToPath(new URL('../artifacts/pocabinet-worlds/', import.meta.url));
const missing = IDS.filter((id) => !existsSync(`${worlds}${id}.json`));
if (missing.length) {
    const dump = spawnSync('dotnet', ['run', 'scripts/pocabinet/dump.cs', '--', 'artifacts/pocabinet-worlds', ...missing],
        { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32' });
    if (dump.status !== 0) throw new Error(`Could not dump the PoCabinet worlds (${missing.join(', ')}): ${dump.stderr || dump.stdout || dump.error}`);
}

const { race } = await import(new URL('../scripts/pocabinet/harness.mjs', import.meta.url));

const BOUNDS = {
    capitol: { wrecked: 5, stuckEvents: 15, maxStuck: 10 },
    bedroom: { wrecked: 30, stuckEvents: 25, maxStuck: 30 },
    court: { wrecked: 10, stuckEvents: 15, maxStuck: 15 },
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
