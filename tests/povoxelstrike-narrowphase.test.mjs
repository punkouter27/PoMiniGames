import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = (await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/povoxelstrike/physics.js', import.meta.url), 'utf8'))
  .replace("import * as CANNON from 'cannon-es';", `
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  dot(other) { return this.x * other.x + this.y * other.y + this.z * other.z; }
}
class Quaternion {
  conjugate(target) { return Object.assign(target, this); }
  mult(rotation, target) { return Object.assign(target, rotation); }
}
class Narrowphase {
  convexConvex(...args) { this.calls ??= []; this.calls.push(args); return 'contact'; }
}
const CANNON = {
  Vec3, Quaternion, Narrowphase, Body: { STATIC: 2 }, Shape: { types: { BOX: 4, HEIGHTFIELD: 32 } },
  ConvexPolyhedron: {
    project(shape, axis, position, rotation, out) { shape.project(out); },
  },
  Transform: {
    pointToLocalFrame(origin, rotation, position, target) {
      Object.assign(target, { x: position.x - origin.x, y: position.y - origin.y, z: position.z - origin.z });
    },
    pointToWorldFrame(origin, rotation, position, target) { Object.assign(target, position); },
    vectorToLocalFrame(origin, rotation, vector, target) { Object.assign(target, vector); },
  },
};`);
const { VoxelNarrowphase } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const q = { x: 0, y: 0, z: 0, w: 1 };
const point = (x = 0, y = 0, z = 0) => ({ x, y, z });
function box(half = 1) {
  return {
    evaluations: 0,
    calculateWorldAABB(p, rotation, lower, upper) {
      this.evaluations++;
      for (const axis of ['x', 'y', 'z']) {
        lower[axis] = p[axis] - half;
        upper[axis] = p[axis] + half;
      }
    },
  };
}

test('rejects separated bounds on all axes and delegates touching/overlapping pairs unchanged', () => {
  const n = new VoxelNarrowphase({ stepnumber: 0 }), a = box(), b = box();
  const ba = { shapes: [] }, bb = { shapes: [] }, originalA = {}, originalB = {};
  for (const axis of ['x', 'y', 'z']) for (const sign of [-1, 1]) {
    const p = point(); p[axis] = sign * 3;
    assert.equal(n.convexConvex(a, b, point(), p, q, q, ba, bb), false);
  }
  assert.equal(n.calls, undefined);
  for (const x of [0, 1, 2, 2 + 5e-7]) {
    const args = [a, b, point(), point(x), q, q, ba, bb, originalA, originalB, true, [1], [2]];
    assert.equal(n.convexConvex(...args), 'contact');
    assert.deepEqual(n.calls.at(-1), args);
  }
});

test('caches repeated terrain pairs but refreshes each step, transform and body', () => {
  const world = { stepnumber: 0 }, n = new VoxelNarrowphase(world);
  const a = box(), b = box(), ba = { shapes: [] }, bb = { shapes: [] };
  for (let i = 0; i < 10000; i++) n.convexConvex(a, b, point(), point(8), q, q, ba, bb);
  assert.equal(a.evaluations, 1);
  assert.equal(b.evaluations, 1);
  assert.equal(n.calls, undefined);
  world.stepnumber++;
  n.convexConvex(a, b, point(), point(8), q, q, ba, bb);
  n.convexConvex(a, b, point(1), point(8), q, q, ba, bb);
  n.convexConvex(a, b, point(1), point(8), { ...q, z: 1, w: 0 }, q, ba, bb);
  n.convexConvex(a, b, point(1), point(8), q, q, { shapes: [] }, bb);
  assert.equal(a.evaluations, 5);
  assert.equal(b.evaluations, 2);
});

test('cached separating axes project current geometry and never reject touching pairs', () => {
  const n = new VoxelNarrowphase({ stepnumber: 0 }), a = box(), b = box();
  a.project = out => { out[0] = 1; out[1] = 0; };
  let lower = 2;
  b.project = out => { out[0] = lower + 1; out[1] = lower; };
  n.separationCache.set(a, new WeakMap([[b, point(1)]]));
  const args = [a, b, point(), point(), q, q, { shapes: [] }, { shapes: [] }];
  assert.equal(n.convexConvex(...args), false);
  assert.equal(n.calls, undefined);
  lower = 1 + 5e-7;
  assert.equal(n.convexConvex(...args), 'contact', 'near-touching geometry delegates');
  lower = 0.5;
  assert.equal(n.convexConvex(...args), 'contact', 'previous separation does not suppress new contacts');
  assert.equal(n.calls.length, 2);
});

test('box SAT retains each edge direction once without changing arbitrary convex hulls', () => {
  const n = new VoxelNarrowphase({ stepnumber: 0 });
  const shape = {
    uniqueEdges: [point(-1), point(0, 1), point(1), point(0, -1), point(0, 0, 1), point(0, 0, -1)],
  };
  const original = shape.uniqueEdges;
  n._prepareBox(shape, { type: 16 });
  assert.equal(shape.uniqueEdges, original, 'non-box geometry is untouched');
  n._prepareBox(shape, { type: 4 });
  assert.deepEqual(shape.uniqueEdges, [original[0], original[1], original[4]]);
  const prepared = shape.uniqueEdges;
  n._prepareBox(shape, { type: 4 });
  assert.equal(shape.uniqueEdges, prepared, 'preparation runs once');
});

test('box projections use current extents and refresh after movement without changing penetration depth', () => {
  const n = new VoxelNarrowphase({ stepnumber: 0 });
  const a = { uniqueEdges: [] }, b = { uniqueEdges: [] };
  const half = point(3, 2, 1);
  n._prepareBox(a, { type: 4, halfExtents: half });
  n._prepareBox(b, { type: 4, halfExtents: point(1, 1, 1) });
  const out = [];
  n._project(a, point(2, -1, 0.5), point(5, 3, -2), q, out);
  assert.deepEqual(out, [14.5, -2.5]);
  n._project(a, point(1), point(10), q, out);
  assert.deepEqual(out, [13, 7]);
  half.x = 4;
  n._project(a, point(1), point(10), q, out);
  assert.deepEqual(out, [14, 6]);
  assert.equal(a.testSepAxis(point(1), b, point(), q, point(4), q), 1);
  assert.equal(a.testSepAxis(point(1), b, point(), q, point(5), q), 0);
  assert.equal(a.testSepAxis(point(1), b, point(), q, point(6), q), false);
});

test('cached terrain pillars survive steps but invalidate on dig replacement and uncached terrain does not', () => {
  const world = { stepnumber: 0 }, n = new VoxelNarrowphase(world);
  const body = { type: 2, shapes: [{ type: 32, cacheEnabled: true }] };
  const pillar = box();
  n._bounds(pillar, point(), q, body);
  world.stepnumber++;
  n._bounds(pillar, point(), q, body);
  assert.equal(pillar.evaluations, 1);
  const replacement = box(2);
  assert.equal(n._bounds(replacement, point(), q, body).upper.x, 2);
  assert.equal(replacement.evaluations, 1);
  const uncached = { type: 2, shapes: [{ type: 32, cacheEnabled: false }] };
  n._bounds(pillar, point(), q, uncached);
  world.stepnumber++;
  n._bounds(pillar, point(), q, uncached);
  assert.equal(pillar.evaluations, 3);
  const structure = { type: 2, shapes: [], voxelBoundsStatic: true };
  const chunk = box();
  n._bounds(chunk, point(), q, structure);
  world.stepnumber++;
  n._bounds(chunk, point(), q, structure);
  assert.equal(chunk.evaluations, 1, 'immutable structure colliders keep bounds across steps');
  n._bounds(chunk, point(1), q, structure);
  assert.equal(chunk.evaluations, 2, 'static-body movement still refreshes cached bounds');
});

test('terrain traversal uses the convex footprint and preserves triangle order and overlap queries', () => {
  const n = new VoxelNarrowphase({ stepnumber: 0 });
  const shape = box(0.5);
  shape.boundingSphereRadius = 20;
  const visits = [];
  const terrain = {
    elementSize: 1, data: Array.from({ length: 100 }, () => Array(100).fill(0)),
    pillarConvex: { boundingSphereRadius: 100 },
    pillarOffset: point(),
    getRectMinMax(x, y, endX, endY, out) { out[0] = -100; out[1] = 100; },
    getConvexTrianglePillar(x, y, upper) { visits.push([x, y, upper]); },
  };
  n.convexConvex = (...args) => {
    assert.equal(args[8], null);
    assert.equal(args[9], null);
    assert.deepEqual(args[11], [0]);
    return true;
  };
  const p = { ...point(50, 50), distanceTo: () => 0 };
  const rotation = new (class {
    conjugate(target) { return target; }
  })();
  n.convexHeightfield(shape, terrain, p, point(), q, rotation, {}, {}, null, null, false);
  assert.equal(visits.length, 8, 'two by two cells, not the sphere rectangle');
  assert.deepEqual(visits[0], [49, 49, false]);
  assert.deepEqual(visits[1], [49, 49, true]);
  assert.deepEqual(visits.at(-1), [50, 50, true]);
  visits.length = 0;
  assert.equal(n.convexHeightfield(shape, terrain, p, point(), q, rotation, {}, {}, null, null, true), true);
  assert.equal(visits.length, 1, 'overlap-only queries return on the first hit');
  visits.length = 0;
  p.z = 1;
  n.convexHeightfield(shape, terrain, p, point(), q, rotation, {}, {}, null, null, false);
  assert.equal(visits.length, 0, 'cells below the convex bounds never build pillars');
  p.z = 0;
  p.x = -50;
  n.convexHeightfield(shape, terrain, p, point(), q, rotation, {}, {}, null, null, false);
  assert.equal(visits.length, 0, 'out-of-terrain bounds have no candidate cells');
});
