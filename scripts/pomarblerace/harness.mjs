// Node harness for PoMarbleRace: one full 101-marble race on the REAL engine (game.js and its
// mixins, maps, marbles, physics), with only the renderer, audio and the window-only effects
// swapped for headless stubs (loader.mjs). Stepped at a fixed 1/60 s, as fast as the CPU allows,
// with Math.random and the course seed pinned, so a run is repeatable.
//
//   node harness.mjs race <mapId|all> [seed]     → per-map stats as JSON
//   node harness.mjs tunnel <mapId|all>           → fire marbles at the speed cap into the course
//
// The same race the E2EUI map certification runs in a browser (MarbleRaceMapCertificationTests),
// minus the browser: CI runs it through tests/pomarblerace-map-health.test.mjs.
import * as nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBrowser, seedRandom } from './env.mjs';

// registerHooks (node 22.15+) runs the hooks in-thread; older nodes take the off-thread register().
if (nodeModule.registerHooks) {
  const hooks = await import('./loader.mjs');
  nodeModule.registerHooks({ resolve: hooks.resolve, load: hooks.load });
} else {
  nodeModule.register('./loader.mjs', import.meta.url);
}
installBrowser();

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
// PMR_ENGINE points the harness at another copy of the engine folder (e.g. an older revision
// extracted with git archive) to compare two versions on identical races.
const engineDir = process.env.PMR_ENGINE || path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/js/pomarblerace');
const engine = (f) => pathToFileURL(path.resolve(engineDir, f)).href;
const { Game } = await import(engine('game.js'));
const { mapById, mapMenu } = await import(engine('maps.js'));
// An engine copy from before tuning.js existed keeps the same values; read today's then.
const tuning = await import(engine('tuning.js')).catch(() =>
  import(pathToFileURL(path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/js/pomarblerace/tuning.js')).href));

export const MAP_IDS = mapMenu().map((m) => m.id);
const DT = 1 / 60;
// Progress a marble must make in STALL_WINDOW seconds to count as moving (the engine's own
// unstick threshold, so "stalled" here means "the engine would be nudging it").
const STALL_WINDOW = tuning.STALL_AFTER;
const STALL_GAIN = tuning.STALL_GAIN;

/** Build a demo game on `mapId` with a pinned seed, the race started. */
export async function bootRace(mapId, seed = 1) {
  const map = mapById(mapId);
  const asset = await map.load();
  seedRandom(seed);
  // Game derives the course seed from Date.now(); pin it so procedural maps are repeatable.
  const realNow = Date.now;
  Date.now = () => seed * 7919;
  let g;
  try { g = new Game('harness', null, true, map.id, asset, null, null); } finally { Date.now = realNow; }
  g.resume();
  g.pick(0);
  return g;
}

/**
 * One full race. `patch(g)` may adjust the game before the start (the tuner uses it).
 * @returns {{ map, name, seed, finished, eliminated, stalled, stallEvents, maxStall, winner, median, last, clock, ms }}
 */
export async function race(mapId, seed = 1, patch = null) {
  const t0 = performance.now();
  const g = await bootRace(mapId, seed);
  if (patch) patch(g);
  const ms = g.marbleSet.marbles;
  // Where marbles leave the course, as the browser certification reports it.
  const falls = [];
  const eliminate = g.marbleSet.eliminate;
  g.marbleSet.eliminate = (m) => {
    if (!m.eliminated && m.proj) falls.push(`s=${Math.round(m.s)} lat=${Math.round(m.proj.lateral)} h=${Math.round(m.proj.height)}`);
    eliminate(m);
  };
  const watch = ms.map((m) => ({ s: m.s, t: 0, stalled: false, longest: 0, since: 0 }));
  let stallEvents = 0;
  let frames = 0;
  const maxFrames = Math.ceil((tuning.RACE_TIMEOUT + 30) / DT / Math.min(1, tuning.SLOWMO_SCALE)) + 1;
  while (g.phase === 'racing' && frames < maxFrames) {
    g._frame(DT);
    frames++;
    const clock = g.raceClock;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i], w = watch[i];
      if (m.finished || m.eliminated) { w.stalled = false; continue; }
      if (m.s > w.s + STALL_GAIN) { w.s = m.s; w.t = clock; w.stalled = false; continue; }
      const still = clock - w.t;
      if (still >= STALL_WINDOW && !w.stalled) { w.stalled = true; stallEvents++; }
      if (still > w.longest) w.longest = still;
    }
  }
  const limit = tuning.RACE_TIMEOUT - 1;
  const times = ms.filter((m) => m.finished && !m.eliminated && m.finishTime < limit).map((m) => m.finishTime).sort((a, b) => a - b);
  const r1 = (v) => Math.round(v * 10) / 10;
  const out = {
    map: g.map.id,
    name: g.map.name,
    seed,
    finished: times.length,
    eliminated: ms.filter((m) => m.eliminated).length,
    stalled: ms.filter((m) => m.finished && !m.eliminated && m.finishTime >= limit).length,
    stallEvents,
    maxStall: r1(Math.max(...watch.map((w) => w.longest))),
    winner: r1(times[0] ?? 0),
    median: r1(times[Math.floor(times.length / 2)] ?? 0),
    last: r1(times[times.length - 1] ?? 0),
    clock: r1(g.raceClock),
    falls: falls.slice(0, 12),
    stalledAt: ms.filter((m) => m.finished && !m.eliminated && m.finishTime >= limit).map((m) => Math.round(m.s)).slice(0, 12),
    ms: Math.round(performance.now() - t0),
  };
  g.dispose();
  return out;
}

/**
 * Tunnelling check: every marble is placed on the course and fired at the engine's speed cap,
 * straight down into the floor and sideways into a wall, in turn, along the whole course. After
 * a short settle each must still be on the map: touching the course, or inside its envelope.
 * @returns {{ map, shots, escaped: string[] }}
 */
export async function tunnel(mapId) {
  const { MAX_SPEED } = await import(engine('marbles.js'));
  const CANNON = await import('cannon-es');
  const ray = new CANNON.RaycastResult();
  const rayOpts = { skipBackfaces: false, collisionFilterMask: -1 };
  const g = await bootRace(mapId, 1);
  const track = g.track;
  const ms = g.marbleSet.marbles;
  const escaped = [];
  let shots = 0, skipped = 0;
  for (const dirName of ['down', 'left', 'right']) {
    // Spread the field along the course, each on the centerline a little above the floor.
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const s = (track.finishS * (i + 0.5)) / ms.length;
      const p = track.centerAt(s).clone();
      const up = track.upAt(s, p.clone()), right = track.rightAt(s, p.clone());
      p.addScaledVector(up, 3);
      m.body.position.set(p.x, p.y, p.z);
      const d = dirName === 'down' ? up.multiplyScalar(-1) : right.multiplyScalar(dirName === 'left' ? -1 : 1);
      // Only a shot at a surface that is there tests tunnelling: over a funnel's open mouth or
      // past a lane's open end there is nothing to pass through, and the marble leaves by design.
      ray.reset();
      g.world.raycastClosest(new CANNON.Vec3(p.x, p.y, p.z), new CANNON.Vec3(p.x + d.x * 60, p.y + d.y * 60, p.z + d.z * 60), rayOpts, ray);
      if (!ray.hasHit || ray.body.mass !== 0) {
        m.body.position.set(0, -1e5 - i * 10, 0); m.body.velocity.set(0, 0, 0); m.skipShot = true; skipped++;
        continue;
      }
      m.skipShot = false;
      m.body.velocity.set(d.x * MAX_SPEED, d.y * MAX_SPEED, d.z * MAX_SPEED);
      m.body.angularVelocity.set(0, 0, 0);
      m.finished = false; m.eliminated = false; m.pathIndex = -1; m.airT = 0; m.lostT = 0;
      if (!g.world.bodies.includes(m.body)) g.world.addBody(m.body);   // retired by the last pass
      m.prev = null;
      shots++;
    }
    // Step physics + containment exactly as _frame does, and judge "left the course" with the
    // engine's own rule (course.js _sweepLost: outside the envelope AND in the air for LOST_AIR).
    for (let k = 0; k < 90; k++) {
      g._savePrev();
      g.world.step(DT, DT, 1);
      g.marbleSet.clampSpeeds();
      g._guardContainment();
      g.marbleSet.updateProgress(track);
      g._markContacts();
      g._sweepLost(DT);
    }
    for (const m of ms) {
      if (m.skipShot || !m.eliminated) continue;
      escaped.push(`${dirName} #${m.index} s=${Math.round(m.s)} lat=${Math.round(m.proj.lateral)} h=${Math.round(m.proj.height)}`);
    }
  }
  g.dispose();
  return { map: g.map.id, shots: shots - skipped, skipped, escaped };
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd = 'race', which = 'all', seedArg = '1'] = process.argv.slice(2);
  const ids = which === 'all' ? MAP_IDS : [Number(which)];
  for (const id of ids) {
    const r = cmd === 'tunnel' ? await tunnel(id) : await race(id, Number(seedArg));
    console.log(JSON.stringify(r));
  }
  process.exit(0);
}
