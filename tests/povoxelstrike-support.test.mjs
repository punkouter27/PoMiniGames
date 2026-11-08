import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/povoxelstrike/', import.meta.url);
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const workerSource = await readFile(new URL('supportWorker.js', root), 'utf8');
const { solve } = await import(url(`const self = {}; ${workerSource}\nexport { solve };`));
const structureSource = (await readFile(new URL('structure.js', root), 'utf8'))
    .replace(/^import .*;\r?$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('structure.js', root).href));

function fixture(Structure, variant) {
    const dims = [12, 8, 5], [nx, ny, nz] = dims;
    const cells = new Uint8Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        cells[x + y * nx + z * nx * ny] = ((x * 7 + y * 3 + z * 11 + variant) % 5 !== 0) ? 1 + x % 2 : 0;
    }
    const grounded = new Uint8Array(nx * nz);
    for (let i = 0; i < grounded.length; i++) grounded[i] = (i + variant) % 3 ? 1 : 0;
    const s = Object.assign(Object.create(Structure.prototype), {
        dims, cells, grounded, scale: 0.25, stepCost: [0, 3, 7],
        crushStress: [0, 8000, 16000], voxelWeight: [0, 370, 200],
        damage: Float32Array.from(cells, (_, i) => (i + variant) % 11 === 0 ? 0.7 : 0),
        solidCount: cells.reduce((n, v) => n + !!v, 0),
        solveGeneration: 0, solveInFlight: false, solveAgain: false,
        dirtyChunks: new Set(), colliderDirtyChunks: new Set(),
        _damaged: new Set(), stress: new Map(), _stressBands: new Map(),
        _groundIntact(x, z) { return this.grounded[x + z * nx] === 1; },
        // Random fracture partition is orthogonal to the solver; preserve cluster order.
        _fracture(voxels) { return [voxels]; },
    });
    return s;
}

test('worker and original inline solve remove identical clusters and retain matching stress under undermining', async () => {
    const { Structure } = await import(url(structureSource));
    for (let variant = 0; variant < 12; variant++) {
        const inline = fixture(Structure, variant);
        const async = fixture(Structure, variant);
        const expected = inline._detachUnsupported();
        const result = solve({
            dims: async.dims, cells: async.cells.slice(), grounded: async.grounded,
            stepCost: async.stepCost, crushStress: async.crushStress, voxelWeight: async.voxelWeight,
            scale: async.scale, resolution: 64, damage: async.damage,
        });
        let actual = [];
        async.onClusters = (_, clusters) => { actual = clusters; };
        async._applySolve(result.failing, 0, result.stressedIdx, result.stressedRatio);
        assert.deepEqual(actual, expected, `cluster order/voxel accounting variant ${variant}`);
        assert.deepEqual(async.cells, inline.cells);
        assert.equal(async.solidCount, inline.solidCount);
        assert.deepEqual(async.dirtyChunks, inline.dirtyChunks);
        assert.deepEqual(async.colliderDirtyChunks, inline.colliderDirtyChunks);
        assert.equal(async.colliderDirty, inline.colliderDirty);
        assert.equal(async.stress.size, inline.stress.size);
        for (const [i, value] of inline.stress) assert.ok(Math.abs(async.stress.get(i) - value) < 1e-6);
    }
});

test('terrain checks dispatch one job, coalesce repeats, then use existing collapse/score callback exactly once', async () => {
    const { Structure, workers } = await import(url(`
        const workers = [];
        class Worker {
            constructor() { this.jobs = []; workers.push(this); }
            postMessage(job) { this.jobs.push(job); }
        }
        ${structureSource}
        export { workers };
    `));
    const s = fixture(Structure, 2);
    let inlineCalls = 0, scoredVoxels = 0, delivered = [];
    s._detachUnsupported = () => { inlineCalls++; assert.fail('main-thread solve'); };
    s.onClusters = (_, clusters) => {
        delivered.push(...clusters);
        for (const cluster of clusters) scoredVoxels += cluster.voxels.length;
    };
    const originalCount = s.solidCount;
    for (let i = 0; i < 20; i++) assert.deepEqual(s.recheckSupport(), []);
    assert.equal(inlineCalls, 0);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].jobs.length, 1);
    assert.equal(s.solveInFlight, true);
    assert.equal(s.solveAgain, true);
    assert.equal(s.solidCount, originalCount, 'grid changes only on result delivery');
    const first = workers[0].jobs[0];
    const firstResult = solve(first);
    workers[0].onmessage({ data: { id: first.id, generation: 0, ...firstResult } });
    assert.equal(workers[0].jobs.length, 2, 'all repeats become one follow-up job');
    const second = workers[0].jobs[1];
    workers[0].onmessage({ data: { id: second.id, generation: 0, ...solve(second) } });
    assert.equal(workers[0].jobs.length, 2);
    assert.equal(s.solveInFlight, false);
    assert.equal(scoredVoxels, originalCount - s.solidCount);
    const indices = delivered.flatMap(c => c.voxels.map(v => `${v.x},${v.y},${v.z}`));
    assert.equal(new Set(indices).size, indices.length, 'no duplicate score/collider removals');
    s.solidCount = 0;
    assert.deepEqual(s.recheckSupport(), []);
    assert.equal(workers[0].jobs.length, 2);
});

test('worker-unavailable path still returns synchronous clusters and marks colliders dirty', async () => {
    const { Structure } = await import(url(`
        class Worker { constructor() { throw new Error('unavailable'); } }
        const console = { warn() {} };
        ${structureSource}
    `));
    const s = fixture(Structure, 3);
    const expected = fixture(Structure, 3)._detachUnsupported();
    assert.ok(expected.length > 0);
    assert.deepEqual(s.recheckSupport(), expected);
    assert.equal(s.colliderDirty, true);
});
