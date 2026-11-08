import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/povoxelstrike/', import.meta.url);
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const boxesUrl = moduleUrl(await readFile(new URL('voxelboxes.js', root), 'utf8'));
const source = (await readFile(new URL('structure.js', root), 'utf8')).replace(/^import .*;\r?$/gm, '');
// The same offset-length + shape-radius rule used by Cannon's updateBoundingRadius.
const { Structure } = await import(moduleUrl(`
import { greedyBoxes } from ${JSON.stringify(boxesUrl)};
class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; }
}
class Box {
    constructor(halfExtents) { this.halfExtents = halfExtents; }
}
class Body {
    static STATIC = 2;
    constructor() {
        this.position = new Vec3();
        this.quaternion = { setFromEuler(x, y, z) { this.y = y; } };
        this.shapes = [];
        this.shapeOffsets = [];
        this.boundingRadius = 0;
    }
    addShape(shape, offset) {
        this.shapes.push(shape);
        this.shapeOffsets.push(offset);
        const h = shape.halfExtents;
        this.boundingRadius = Math.max(this.boundingRadius,
            Math.hypot(offset.x, offset.y, offset.z) + Math.hypot(h.x, h.y, h.z));
    }
}
const CANNON = { Vec3, Box, Body };
${source}
`));

function wall(rotation = 0, active = true) {
    const dims = [256, 35, 5];
    const [nx, ny, nz] = dims;
    const cells = new Uint8Array(nx * ny * nz).fill(1);
    // Preserve a door-sized hole crossing a chunk boundary.
    for (let z = 0; z < nz; z++) for (let y = 0; y < 9; y++) {
        for (let x = 29; x < 36; x++) cells[x + y * nx + z * nx * ny] = 0;
    }
    const bodies = new Set();
    const structure = Object.assign(Object.create(Structure.prototype), {
        dims, cells, scale: 0.25, cx: nx / 2, cz: nz / 2,
        group: { position: { x: 7, y: 2, z: -11 }, rotation: { y: rotation } },
        physicsWorld: { addBody: b => bodies.add(b), removeBody: b => bodies.delete(b) },
        colliderBodies: new Map(), colliderDirty: true, colliderDirtyChunks: new Set(),
        colliderActive: active,
    });
    for (let j = 0; j < 2; j++) for (let i = 0; i < 8; i++) {
        structure.colliderDirtyChunks.add(`${i},${j},0`);
    }
    structure.rebuildCollider();
    return { structure, bodies };
}

function inverseWorld(point, s) {
    const p = s.group.position, ry = s.group.rotation.y;
    const x = point.x - p.x, z = point.z - p.z;
    return [
        (Math.cos(ry) * x - Math.sin(ry) * z) / s.scale + s.cx,
        (point.y - p.y) / s.scale,
        (Math.sin(ry) * x + Math.cos(ry) * z) / s.scale + s.cz,
    ];
}

function shapeBounds(body, i, s) {
    const o = body.shapeOffsets[i], ry = s.group.rotation.y;
    const center = inverseWorld({
        x: body.position.x + Math.cos(ry) * o.x + Math.sin(ry) * o.z,
        y: body.position.y + o.y,
        z: body.position.z - Math.sin(ry) * o.x + Math.cos(ry) * o.z,
    }, s);
    const h = body.shapes[i].halfExtents;
    const half = [h.x, h.y, h.z].map(v => v / s.scale);
    return { lo: center.map((c, a) => c - half[a]), hi: center.map((c, a) => c + half[a]) };
}

test('recentered colliders preserve every solid voxel and opening under translation/rotation', () => {
    for (const rotation of [0, Math.PI / 2, Math.PI, -0.73]) {
        const { structure: s, bodies } = wall(rotation);
        const occupancy = new Uint8Array(s.cells.length);
        const [nx, ny] = s.dims;
        for (const body of bodies) for (let i = 0; i < body.shapes.length; i++) {
            const { lo, hi } = shapeBounds(body, i, s);
            for (let a = 0; a < 3; a++) {
                assert.ok(Math.abs(lo[a] - Math.round(lo[a])) < 1e-8);
                assert.ok(Math.abs(hi[a] - Math.round(hi[a])) < 1e-8);
            }
            for (let z = Math.round(lo[2]); z < Math.round(hi[2]); z++) {
                for (let y = Math.round(lo[1]); y < Math.round(hi[1]); y++) {
                    for (let x = Math.round(lo[0]); x < Math.round(hi[0]); x++) {
                        occupancy[x + y * nx + z * nx * ny] = 1;
                    }
                }
            }
        }
        assert.deepEqual(occupancy, s.cells, `world-space shape coverage at rotation ${rotation}`);
    }
});

test('chunk-local radius eliminates distant broadphase candidates without removing any body', () => {
    const { structure: s, bodies } = wall();
    assert.equal(bodies.size, 16);
    const chunk = s.colliderBodies.get('0,0,0');
    const oldRadius = Math.hypot(28, 4, 0) + Math.hypot(4, 4, 0.625);
    assert.ok(chunk.boundingRadius < 12, 'radius is bounded by chunk size, not building offset');
    assert.ok(chunk.boundingRadius < oldRadius / 2);
    // Cannon's sphere intersection predicate for a chip at the left end of the wall.
    const chip = { x: s.group.position.x - 29, y: 4, z: s.group.position.z };
    const chipRadius = 0.3;
    const overlaps = (position, radius) =>
        Math.hypot(position.x - chip.x, position.y - chip.y, position.z - chip.z) <= radius + chipRadius;
    let oldCandidates = 0, candidates = 0;
    for (const body of bodies) {
        if (overlaps(body.position, body.boundingRadius)) candidates++;
        let inflated = 0;
        for (let i = 0; i < body.shapes.length; i++) {
            const o = body.shapeOffsets[i], h = body.shapes[i].halfExtents;
            inflated = Math.max(inflated, Math.hypot(
                body.position.x + o.x - s.group.position.x,
                body.position.y + o.y - s.group.position.y,
                body.position.z + o.z - s.group.position.z) + Math.hypot(h.x, h.y, h.z));
        }
        if (overlaps(s.group.position, inflated)) oldCandidates++;
    }
    assert.ok(candidates <= 2, `${candidates} nearby candidates`);
    assert.ok(oldCandidates >= candidates * 3, `${oldCandidates} inflated candidates vs ${candidates}`);
});

test('carve rebuild and collider streaming still replace/remove/re-add the correct bodies', () => {
    const { structure: s, bodies } = wall();
    const old = s.colliderBodies.get('7,1,0');
    s.cells.fill(0);
    s.colliderDirty = true;
    s.colliderDirtyChunks.add('7,1,0');
    s.rebuildCollider();
    assert.equal(bodies.has(old), false);
    assert.equal(s.colliderBodies.has('7,1,0'), false);
    s.setColliderActive(false);
    assert.equal(bodies.size, 0);
    s.setColliderActive(true);
    assert.equal(bodies.size, 15);
    const inactive = wall(0.73, false);
    assert.equal(inactive.bodies.size, 0);
    assert.equal(inactive.structure.colliderBodies.size, 16);
    inactive.structure.setColliderActive(true);
    assert.equal(inactive.bodies.size, 16);
});
