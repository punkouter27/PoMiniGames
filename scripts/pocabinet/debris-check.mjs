// Drops debris on the real circuit through the game's own Rapier solver
// (wwwroot/js/pocabinet/debris-rapier.js), in node, and checks that it behaves:
//
//   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds     (once: the world)
//   npm ci --prefix scripts/pocabinet                                      (once)
//   node scripts/pocabinet/debris-check.mjs
//
//   1. settle   pieces thrown all round the lap come to rest on the road, between the barriers
//               (a wheel may still be rolling down a hill)
//   2. stack    a bumper dropped on a wheel ends up lying on it, not through it
//   3. wall     a piece thrown hard at a barrier stays on the track
//   4. parked   a piece dropped on a stopped car does not end up inside it
//   5. driven   a car driven through a pile clears it out of its path
//   6. cost     the time a 60 Hz step takes with the high tier's 160 pieces
//
// Exits non-zero if any check fails. Run it after changing debris-rapier.js or the track.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const here = path.dirname(fileURLToPath(import.meta.url));
const js = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/js/pocabinet');
const worldFile = path.resolve(here, '../../artifacts/pocabinet-worlds/grandprix.json');
if (!fs.existsSync(worldFile)) {
    console.error(`no world at ${worldFile}: run  dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds`);
    process.exit(2);
}
const { buildTrack } = await import(pathToFileURL(path.join(js, 'track.js')));
const { RapierDebris } = await import(pathToFileURL(path.join(js, 'debris-rapier.js')));
const ph = await import(pathToFileURL(path.join(js, 'physics.js')));
await RAPIER.init();

const WS = 10;
const track = buildTrack(JSON.parse(fs.readFileSync(worldFile, 'utf8')));
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** A debris.js body record, as newBody / asBox / asDisc make it. */
function piece(shape, dims, p, v = [0, 0, 0], w = [0, 0, 0]) {
    const b = {
        shape, hx: 0, hy: 0, hz: 0, R: 0, w2: 0, rad: 0,
        p: new THREE.Vector3(...p), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6)),
        v: new THREE.Vector3(...v), w: new THREE.Vector3(...w),
        pp: new THREE.Vector3(...p), pq: new THREE.Quaternion(),
        e: 0.35, roll: 2, hint: -1, asleep: false, age: 1, rb: null, col: null,
    };
    if (shape === 1) { b.R = dims[0]; b.w2 = dims[1]; b.rad = Math.hypot(b.R, b.w2); b.roll = 0.7; }
    else { [b.hx, b.hy, b.hz] = dims; b.rad = Math.hypot(...dims); }
    return b;
}

/** A point on the lap: `along` sim units round it, `lat` sim units right of the centerline. World units. */
function at(along, lat = 0, up = 0) {
    const s = track.pointAt(along);
    return {
        x: (s.x - s.ty * lat) / WS, z: (s.y + s.tx * lat) / WS,
        y: (track.heightAt(along) + lat * track.bankAt(along)) / WS + up,
        tx: s.tx, tz: s.ty,
    };
}

/** How far `b` is over the road's plane under it, and how far inside the barriers (world units). */
function where(b) {
    const pr = track.project(b.p.x * WS, b.p.z * WS, -1);
    const h = (track.heightAt(pr.along) + pr.lateral * track.bankAt(pr.along)) / WS;
    const side = pr.lateral > 0 ? 1 : -1;
    const face = track.hwAt(pr.index) + ph.runOffAt(track, pr.index, side);
    return { over: b.p.y - h, inside: (face - Math.abs(pr.lateral)) / WS };
}

function run(solver, bodies, seconds, each) {
    for (let i = 0, n = Math.round(seconds * 60); i < n; i++) {
        each?.(i);
        solver.step(bodies);
    }
}

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };

// 1. settle
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const bodies = [];
    for (let k = 0; k < 120; k++) {
        const along = rnd() * track.length;
        const pr = track.indexAt(along);
        const reach = track.hwAt(pr) * 0.8;
        const o = at(along, (rnd() * 2 - 1) * reach, 0.6 + rnd() * 1.2);
        const kind = k % 4;
        const b = kind === 3
            ? piece(1, [0.2 + rnd() * 0.15, 0.022 + rnd() * 0.09], [o.x, o.y, o.z])
            : piece(0, kind === 0 ? [0.07 + rnd() * 0.15, 0.012, 0.05 + rnd() * 0.11]
                : kind === 1 ? [0.04 + rnd() * 0.08, 0.025 + rnd() * 0.04, 0.03 + rnd() * 0.07]
                    : [0.3 + rnd() * 0.5, 0.06, 0.1 + rnd() * 0.1], [o.x, o.y, o.z]);
        b.v.set((rnd() - 0.5) * 12, rnd() * 4, (rnd() - 0.5) * 12);
        b.w.set((rnd() - 0.5) * 14, (rnd() - 0.5) * 14, (rnd() - 0.5) * 14);
        solver.add(b);
        bodies.push(b);
    }
    run(solver, bodies, 12);
    let low = 0, high = 0, out = 0, awake = 0, worst = 0, boxes = 0;
    for (const b of bodies) {
        const w = where(b);
        if (w.over < -0.03) low++;
        if (w.over > b.rad + 0.12) { high++; worst = Math.max(worst, w.over - b.rad); }
        if (w.inside < -0.05) out++;
        if (!b.asleep) {
            awake++;
            // DEBRIS_VERBOSE=1 lists the pieces that never came to rest.
            if (process.env.DEBRIS_VERBOSE) console.log(`   moving: ${b.shape ? 'disc' : 'box'}, speed ${b.v.length().toFixed(3)}, spin ${b.w.length().toFixed(3)}, ${w.over.toFixed(3)} over the road`);
        }
        if (!b.asleep && !b.shape) boxes++;
    }
    check('settle', low === 0 && high === 0 && out === 0 && boxes === 0 && awake <= 10,
        `${bodies.length} pieces after 12 s: ${low} under the road, ${high} still in the air (worst ${worst.toFixed(2)}), ${out} past a barrier, ${awake} still moving (${boxes} of them not wheels: a wheel on a hill keeps rolling)`);
    solver.dispose();
}

// 2. stack
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const o = at(track.length * 0.02, 0, 0);
    const wheel = piece(1, [0.33, 0.11], [o.x, o.y + 0.13, o.z]);
    wheel.q.set(0, 0, 0, 1);
    const bumper = piece(0, [0.8, 0.06, 0.12], [o.x, o.y + 1.0, o.z]);
    bumper.q.set(0, 0, 0, 1);
    const bodies = [wheel, bumper];
    for (const b of bodies) solver.add(b);
    run(solver, bodies, 5);
    const top = where(bumper).over, wheelOver = where(wheel).over;
    // Lying on the wheel (one end on the road, the middle on the rim): well clear of flat on the road.
    const near = Math.hypot(bumper.p.x - wheel.p.x, bumper.p.z - wheel.p.z);
    check('stack', wheelOver > 0.05 && wheelOver < 0.2 && (top > 0.1 || near > 0.5),
        `wheel centre ${wheelOver.toFixed(3)} over the road, bumper centre ${top.toFixed(3)} over it, ${near.toFixed(2)} from the wheel`);
    solver.dispose();
}

// 3. wall
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const bodies = [];
    for (let k = 0; k < 24; k++) {
        const along = (k + 0.5) / 24 * track.length;
        const o = at(along, 0, 0.4);
        const b = k % 3 === 2 ? piece(1, [0.33, 0.11], [o.x, o.y, o.z]) : piece(0, [0.08, 0.012, 0.06], [o.x, o.y, o.z]);
        const side = k % 2 ? 1 : -1;
        // Straight at the barrier, at a car's top speed.
        b.v.set(-o.tz * side * 32, 1.5, o.tx * side * 32);
        solver.add(b);
        bodies.push(b);
    }
    run(solver, bodies, 6);
    const out = bodies.filter(b => where(b).inside < -0.05).length;
    const low = bodies.filter(b => where(b).over < -0.03).length;
    check('wall', out === 0 && low === 0, `24 pieces at 32 u/s into the barriers: ${out} got through, ${low} under the road`);
    solver.dispose();
}

// 4. parked car
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const o = at(track.length * 0.05, 0, 0);
    const heading = Math.atan2(o.tz, o.tx);
    const car = { render: { x: o.x * WS, y: o.z * WS, h: o.y, heading, speed: 0 } };
    const bodies = [];
    for (let k = 0; k < 12; k++) {
        const b = piece(0, [0.08 + rnd() * 0.1, 0.02, 0.06], [o.x + (rnd() - 0.5) * 2.4, o.y + 2 + rnd(), o.z + (rnd() - 0.5) * 1.2]);
        solver.add(b);
        bodies.push(b);
    }
    run(solver, bodies, 6, () => solver.syncCars([car]));
    let inside = 0;
    for (const b of bodies) {
        const dx = b.p.x - o.x, dz = b.p.z - o.z;
        const al = dx * Math.cos(heading) + dz * Math.sin(heading), ac = -dx * Math.sin(heading) + dz * Math.cos(heading);
        const up = b.p.y - o.y;
        if (Math.abs(al) < 1.9 && Math.abs(ac) < 0.8 && up < 1.1) inside++;
    }
    check('parked', inside === 0, `12 pieces dropped on a stopped car: ${inside} ended up inside it`);
    solver.dispose();
}

// 5. driven
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const start = track.length * 0.08;
    const bodies = [];
    for (let k = 0; k < 30; k++) {
        const o = at(start + 120 + rnd() * 40, (rnd() - 0.5) * 12, 0.05);
        const b = piece(0, [0.06 + rnd() * 0.12, 0.02 + rnd() * 0.03, 0.05 + rnd() * 0.08], [o.x, o.y + 0.05, o.z]);
        solver.add(b);
        bodies.push(b);
    }
    run(solver, bodies, 2);
    const before = bodies.map(b => b.p.clone());
    const speed = 300;                       // sim units/s: 30 world units/s
    const car = { render: { x: 0, y: 0, h: 0, heading: 0, speed } };
    let along = start, hit = 0;
    run(solver, bodies, 3, () => {
        along += speed / 60;
        const o = at(along, 0, 0);
        Object.assign(car.render, { x: o.x * WS, y: o.z * WS, h: o.y, heading: Math.atan2(o.tz, o.tx) });
        solver.syncCars([car]);
    });
    run(solver, bodies, 4, () => solver.syncCars([car]));
    let moved = 0, far = 0, low = 0, out = 0;
    bodies.forEach((b, i) => {
        const d = b.p.distanceTo(before[i]);
        if (d > 0.5) moved++;
        far = Math.max(far, d);
        const w = where(b);
        if (w.over < -0.03) low++;
        if (w.inside < -0.05) out++;
    });
    hit = moved;
    check('driven', hit >= 6 && low === 0 && out === 0, `a car at 30 u/s through 30 pieces: ${moved} thrown (furthest ${far.toFixed(1)}), ${low} under the road, ${out} past a barrier`);
    solver.dispose();
}

// 6. cost
{
    const solver = new RapierDebris(RAPIER, track, WS);
    const bodies = [];
    const o = at(track.length * 0.3, 0, 0);
    for (let k = 0; k < 160; k++) {
        const b = piece(k % 5 === 4 ? 1 : 0, k % 5 === 4 ? [0.2, 0.03] : [0.05 + rnd() * 0.15, 0.012 + rnd() * 0.03, 0.04 + rnd() * 0.1],
            [o.x + (rnd() - 0.5) * 5, o.y + 0.5 + rnd() * 3, o.z + (rnd() - 0.5) * 5]);
        b.v.set((rnd() - 0.5) * 6, rnd() * 3, (rnd() - 0.5) * 6);
        solver.add(b);
        bodies.push(b);
    }
    const t0 = performance.now();
    run(solver, bodies, 2);
    const ms = (performance.now() - t0) / 120;
    check('cost', ms < 4, `160 pieces falling in a heap: ${ms.toFixed(2)} ms a step`);
    solver.dispose();
}

process.exit(results.every(Boolean) ? 0 : 1);
