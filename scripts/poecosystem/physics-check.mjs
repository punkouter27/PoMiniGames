// Runs PoEcosystem's Rapier physics (wwwroot/js/poecosystem/sim/physics/rapierWorld.js) on a
// real island, in node, and checks that it behaves:
//
//   npm ci --prefix scripts/pocabinet            (once: Rapier comes from PoCabinet's tools)
//   node scripts/poecosystem/physics-check.mjs
//
//   1. ground    rays cast straight down land on the island's own heights (the heightfield is
//                the right way round and in the right place)
//   2. ragdolls  bodies of every species come to rest on the ground, in one piece
//   3. tree      a felled trunk ends up lying down, on the ground
//   4. rocks     a planned rockslide lands, brings its scree, and the scree clears away
//   5. blast     an explosion moves what is near it and nothing else
//   6. save      settled props survive snapshot() / restore()
//   7. cost      the time a sim tick takes with the ragdoll cap in flight
//
// Exits non-zero if any check fails. Run it after changing rapierWorld.js or the island.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/js/poecosystem');
const load = (rel) => import(pathToFileURL(path.join(js, rel)));
const require = createRequire(path.resolve(here, '../pocabinet/package.json'));
const RAPIER = require('@dimforge/rapier3d-compat');
await RAPIER.init();

const { generateIsland } = await load('sim/terrain/island.js');
const { createPhysics } = await load('sim/physics/world.js');
const { isWalkable } = await load('sim/terrain/tiles.js');
const { PHYSICS, TICK_SECONDS } = await load('sim/core/config.js');

let seed = 20261120;
const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const rng = { next, range: (lo, hi) => lo + next() * (hi - lo) };

const terrain = generateIsland(4242);
const size = terrain.size;
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${detail}`); if (!ok) failed++; };

/** A walkable spot well inside the island: [x, y, z]. */
function land() {
  for (let tries = 0; tries < 5000; tries++) {
    const x = 20 + next() * (size - 40); const z = 20 + next() * (size - 40);
    const i = Math.floor(z) * size + Math.floor(x);
    if (isWalkable(terrain.type[i])) return [x, terrain.heightAt(x, z), z];
  }
  throw new Error('no land found');
}
const run = (physics, seconds) => { for (let t = 0; t < seconds; t += TICK_SECONDS) physics.step(TICK_SECONDS); };
/** The collider's own height under (x, z): a ray that sees only the terrain. */
const TERRAIN_ONLY = ((0xffff << 16) | 1) >>> 0;
const groundAt = (physics, x, z) => {
  const hit = physics.world.castRay(new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true, undefined, TERRAIN_ONLY);
  return hit ? 200 - hit.timeOfImpact : NaN;
};
/**
 * How far a point is inside the ground, measured to the nearest surface: 0 above it. (The
 * drop straight up says little on a cliff, where a hand's width in is metres down.)
 */
const buried = (physics, x, y, z) => {
  if (!(groundAt(physics, x, z) > y)) return 0;
  const hit = physics.world.projectPoint({ x, y, z }, false, undefined, TERRAIN_ONLY);
  return hit ? Math.hypot(hit.point.x - x, hit.point.y - y, hit.point.z - z) : Infinity;
};
const rows = (physics) => {
  const view = new Float32Array(512 * 8);
  const n = physics.readProps(view, 512);
  return Array.from({ length: n }, (_, k) => Array.from(view.subarray(k * 8, k * 8 + 8)));
};

// 1. ground
{
  const physics = createPhysics(RAPIER, terrain);
  check('engine', physics.kind === 'rapier', `kind=${physics.kind}`);
  physics.step(TICK_SECONDS);   // ray queries read the broad phase the first step builds
  // At the cell corners the collider and the heightmap must agree exactly. (Inside a cell
  // they differ: heightAt is bilinear, the collider is two triangles.)
  const cs = size + 1;
  let worst = 0;
  for (let k = 0; k < 400; k++) {
    const ix = 10 + Math.floor(next() * (size - 20)); const iz = 10 + Math.floor(next() * (size - 20));
    const got = groundAt(physics, ix + 0.001, iz + 0.001);
    const d = Math.abs(got - Math.max(-3, terrain.height[iz * cs + ix]));
    worst = Number.isNaN(d) ? Infinity : Math.max(worst, d);
  }
  check('ground', worst < 0.05, `worst difference from the heightmap ${worst.toFixed(3)} m over 400 corners`);
  physics.dispose();
}

// 2. ragdolls
{
  const physics = createPhysics(RAPIER, terrain);
  const spots = [];
  for (let species = 0; species < 4; species++) {
    for (let k = 0; k < 3; k++) {
      const [x, y, z] = land();
      spots.push([x, y, z]);
      physics.onDeath({ species, x, y, z, yaw: next() * 6.28, scale: 1 }, ['predation', 'lightning', 'eruption'][k], rng);
    }
  }
  const flying = physics.activeRagdolls;
  run(physics, PHYSICS.ragdollMaxSeconds + 1);
  let under = 0; let far = 0; let nan = 0; let deepest = 0;
  for (const r of rows(physics)) {
    if (!r.every(Number.isFinite)) { nan++; continue; }
    // A limb's centre may sit a few centimetres into a slope where its joint holds it; a part
    // that is properly buried went through the ground.
    const depth = buried(physics, r[0], r[1], r[2]);
    deepest = Math.max(deepest, depth);
    if (depth > 0.3) under++;
    if (!spots.some(s => Math.hypot(r[0] - s[0], r[2] - s[2]) < 12)) far++;
  }
  check('ragdolls', flying === 12 && physics.activeRagdolls === 0 && under === 0 && far === 0 && nan === 0,
    `${flying} thrown, ${physics.activeRagdolls} still loose, ${under} parts under the ground (deepest ${deepest.toFixed(2)} m), ${far} flung away, ${nan} broken`);
  physics.dispose();
}

// 3. tree
{
  const physics = createPhysics(RAPIER, terrain);
  let lying = 0; let onGround = 0; const n = 8;
  for (let k = 0; k < n; k++) {
    const [x, y, z] = land();
    physics.fellTree({ x, y, z, dirX: next() - 0.5, dirZ: next() - 0.5 }, rng);
  }
  run(physics, PHYSICS.settleTimeoutSeconds + 1);
  for (const r of rows(physics)) {
    // The trunk's long axis is its local +Y; lying down means that axis is near horizontal.
    const [qx, , qz] = [r[3], r[4], r[5]];
    const upY = 1 - 2 * (qx * qx + qz * qz);
    if (Math.abs(upY) < 0.6) lying++;
    const ground = groundAt(physics, r[0], r[2]);
    if (r[1] > ground - 0.05 && r[1] < ground + 1.6) onGround++;
  }
  check('tree', lying >= n - 1 && onGround === n, `${lying}/${n} lying down, ${onGround}/${n} on the ground`);
  physics.dispose();
}

// 4. rocks
{
  const physics = createPhysics(RAPIER, terrain);
  const [x, y, z] = land();
  const plan = Array.from({ length: 6 }, (_, k) => ({ x, y: y + 6, z, vx: 4 + k * 0.4, vy: 3, vz: -2 + k * 0.5, big: k % 3 === 0 }));
  physics.spawnRocks({ rocks: plan }, rng);
  const thrown = physics.propCount;
  run(physics, PHYSICS.settleTimeoutSeconds + 2);
  let under = 0;
  for (const r of rows(physics)) if (r[1] < groundAt(physics, r[0], r[2]) - 0.02) under++;
  const settled = physics.settledCount();
  run(physics, 40);
  check('rocks', thrown > plan.length && under === 0 && settled === thrown && physics.propCount === plan.length,
    `${plan.length} boulders + ${thrown - plan.length} scree thrown, ${settled} settled, ${under} under the ground, ${physics.propCount} left after the scree cleared`);
  physics.dispose();
}

// 5. blast
{
  const physics = createPhysics(RAPIER, terrain);
  const [x, y, z] = land();
  physics.spawnRocks({ projectile: true, rocks: [{ x, y: y + 0.6, z, vx: 0, vy: 0, vz: 0, big: false }, { x: x + 15, y: terrain.heightAt(x + 15, z) + 0.6, z, vx: 0, vy: 0, vz: 0, big: false }] }, rng);
  run(physics, 1);
  const before = rows(physics);
  const hit = physics.explode({ x: x + 0.5, y, z, radius: 6, strength: 40 });
  run(physics, 0.5);
  const after = rows(physics);
  const moved = after.map((r, k) => Math.hypot(r[0] - before[k][0], r[1] - before[k][1], r[2] - before[k][2]));
  // The far rock may still be rolling down its own slope; it must not have been thrown.
  check('blast', hit === 1 && moved[0] > 3 && moved[1] < moved[0] / 3, `${hit} body hit, near one moved ${moved[0].toFixed(2)} m, far one ${moved[1].toFixed(2)} m`);
  physics.dispose();
}

// 6. save
{
  const physics = createPhysics(RAPIER, terrain);
  const [x, y, z] = land();
  physics.fellTree({ x, y, z, dirX: 1, dirZ: 0 }, rng);
  run(physics, PHYSICS.settleTimeoutSeconds + 1);
  const saved = physics.snapshot();
  const again = createPhysics(RAPIER, terrain);
  again.restore(JSON.parse(JSON.stringify(saved)));
  const a = rows(physics)[0]; const b = rows(again)[0];
  const same = !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) < 1e-4);
  check('save', saved.length === 1 && same && again.settledCount() === 1, `${saved.length} prop saved, restored ${same ? 'in place' : 'somewhere else'}`);
  physics.dispose(); again.dispose();
}

// 7. cost
{
  const physics = createPhysics(RAPIER, terrain);
  for (let k = 0; k < PHYSICS.maxActiveRagdolls; k++) {
    const [x, y, z] = land();
    physics.onDeath({ species: k % 4, x, y, z, yaw: next() * 6.28, scale: 1 }, 'eruption', rng);
  }
  const [x, y, z] = land();
  physics.spawnRocks({ rocks: Array.from({ length: 8 }, (_, k) => ({ x, y: y + 5, z, vx: 3 + k * 0.3, vy: 2, vz: k - 4, big: k % 2 === 0 })) }, rng);
  const bodies = physics.propCount;
  const t0 = performance.now(); let ticks = 0;
  for (let t = 0; t < 3; t += TICK_SECONDS) { physics.step(TICK_SECONDS); ticks++; }
  const ms = (performance.now() - t0) / ticks;
  check('cost', ms < 4, `${ms.toFixed(3)} ms per sim tick with ${bodies} bodies in flight`);
  physics.dispose();
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all checks passed');
