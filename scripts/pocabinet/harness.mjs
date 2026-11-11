// Node harness for PoCabinet: a full 64-car solo race on the repo's own physics.js/track.js,
// the same loop as race.js soloTick + lapBookkeeping (and PoCabinetLapVerifier.Replay).
//
//   node harness.mjs race <trackId> [driver=clean|messy|wild] [wet=0|1]   → stats + proof line
//   node harness.mjs svg <trackId>                                        → <worlds>/<id>.svg top-down preview
//   node harness.mjs profile <trackId> [stepsPerKnot]                     → speed / slow / off-road share per knot
//   node harness.mjs log <trackId>                                        → wrecks and stalled cars through the race
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const js = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/js/pocabinet');
// Worlds dumped by dump.cs (gitignored): dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds <ids>
const WORLDS = path.resolve(here, '../../artifacts/pocabinet-worlds');
const { buildTrack, rubberAt } = await import(pathToFileURL(path.join(js, 'track.js')));
const ph = await import(pathToFileURL(path.join(js, 'physics.js')));

const TICK = ph.TICK_SECONDS;
const COUNTDOWN = 3;
const MAX_TICKS = 30 * 60 * 8;
const world = (id) => JSON.parse(fs.readFileSync(path.join(WORLDS, id + '.json'), 'utf8'));

export function race(id, driver = 'clean', wet = false, opts = {}) {
    const w = world(id);
    const track = buildTrack(w);
    const grip = wet ? 0.85 : 1;
    const cond = { wet, rubber: 0 };
    const mk = (meta) => ({ ...meta, body: ph.createBody(), lapsDone: 0, lapStart: 0, bestLap: 0, lastLap: 0, finished: false, finishOrder: 0, prevDistance: 0, invalid: false, invalidLaps: 0 });
    const cars = [];
    const player = mk({ id: 0, isPlayer: true });
    ph.gridSlot(track, player.body, ph.PLAYER_SLOT);
    cars.push(player);
    ph.soloField().forEach((o, i) => {
        const c = mk({ id: i + 1, persona: o.persona, maxSpeed: o.maxSpeed, corneringSkill: o.corneringSkill, name: o.name });
        ph.gridSlot(track, c.body, i < ph.PLAYER_SLOT ? i : i + 1);
        cars.push(c);
    });
    const bodies = cars.map(c => c.body);
    const totalLaps = Number(w.totalLaps) || 3;
    const L = track.lapLength;
    const persona = driver === 'messy'
        ? { ...ph.AUTOPILOT, lateralOffset: opts.messyOffset ?? 0.3, brakingAggression: 0.9 }
        : ph.AUTOPILOT;
    const skill = driver === 'messy' ? 0.95 : 0.8;
    const proof = [];
    let clock = 0, finishOrder = 0;
    const stuck = new Map();
    let stuckEvents = 0, maxStuck = 0;
    while (proof.length < MAX_TICKS && !player.finished && !player.body.wrecked) {
        clock += TICK;
        const elapsed = clock - COUNTDOWN;
        if (elapsed < 0) continue;
        cond.rubber = rubberAt(elapsed);
        const tickStart = Math.max(0, elapsed - TICK);
        const stepDt = elapsed - tickStart;
        // Player controls, quantised before stepping exactly as race.js does.
        let c = ph.aiControls(track, player.body, persona, ph.MAX_SPEED, skill, bodies, grip);
        if (driver === 'wild') {
            const t = elapsed % (opts.wildPeriod ?? 8);
            if (t < 0.6) c = { throttle: 1, brake: 0, steer: 0.8 };
        }
        const q = [Math.round(c.throttle * 1000), Math.round(c.brake * 1000), Math.round(c.steer * 1000)];
        proof.push(q);
        const pc = { throttle: q[0] / 1000, brake: q[1] / 1000, steer: q[2] / 1000 };
        for (const car of cars) {
            car.prevDistance = car.body.distance;
            car.wasWrecked = car.body.wrecked;
            const cc = car.isPlayer ? pc
                : ph.aiControls(track, car.body, car.persona, car.finished ? car.maxSpeed * track.coolDownAt(car.body.distance) : car.maxSpeed,
                    car.corneringSkill, bodies, grip);
            ph.step(track, car.body, cc, stepDt, grip, cond);
        }
        ph.resolveContacts(track, bodies);
        if (opts.log) {
            for (const car of cars) {
                if (!car.wasWrecked && car.body.wrecked) opts.log.push(`${elapsed.toFixed(1)} WRECK car ${car.id} seg ${car.body.segHint} lat ${car.body.lateral.toFixed(0)} fin ${car.finished} laps ${car.lapsDone}`);
            }
            if (Math.abs(elapsed % 10) < TICK / 2) {
                const s = cars.filter(c => !c.finished && !c.body.wrecked && Math.abs(c.body.speed) < 5).map(c => `${c.body.segHint}/${c.body.lateral.toFixed(0)}`);
                const f = cars.filter(c => c.finished).length;
                opts.log.push(`${elapsed.toFixed(0)} slow ${s.length} finished ${f}: ${s.slice(0, 16).join(' ')}`);
            }
        }
        if (opts.profile && elapsed > 8) {
            for (const car of cars) {
                if (car.finished || car.body.wrecked) continue;
                const k = Math.floor(car.body.segHint / opts.profile.steps);
                const p = opts.profile.knots[k] || (opts.profile.knots[k] = { n: 0, v: 0, slow: 0, off: 0 });
                p.n++; p.v += car.body.speed; if (car.body.speed < 30) p.slow++; if (car.body.surface >= 3) p.off++;
            }
        }
        for (const car of cars) {
            if (car.finished || car.body.wrecked) continue;
            while (car.body.distance >= (car.lapsDone + 1) * L) {
                const boundary = (car.lapsDone + 1) * L;
                const span = car.body.distance - car.prevDistance;
                const frac = span > 1e-9 ? Math.min(1, Math.max(0, (boundary - car.prevDistance) / span)) : 1;
                const crossedAt = tickStart + frac * stepDt;
                const lapTime = crossedAt - car.lapStart;
                car.lapStart = crossedAt;
                car.lastLap = lapTime;
                if (car.invalid) car.invalidLaps++;
                else if (car.bestLap <= 0 || lapTime < car.bestLap) car.bestLap = lapTime;
                car.invalid = false;
                car.lapsDone++;
                if (car.lapsDone >= totalLaps) { car.finished = true; car.finishOrder = ++finishOrder; break; }
            }
            if (car.body.wide) car.invalid = true;
        }
        // Stuck: a running, unwrecked car under 5 u/s for 4 s after the start shook out.
        if (elapsed > 6) {
            for (const car of cars) {
                if (car.finished || car.body.wrecked || track.parked(car.body.distance)) continue;
                const s = Math.abs(car.body.speed) < 5 ? (stuck.get(car) || 0) + TICK : 0;
                if (s > 4 && (stuck.get(car) || 0) <= 4) stuckEvents++;
                stuck.set(car, s);
                maxStuck = Math.max(maxStuck, s);
            }
        }
    }
    const finished = cars.filter(c => c.finished).length;
    const wrecked = cars.filter(c => c.body.wrecked).length;
    const best = cars.filter(c => c.bestLap > 0).map(c => c.bestLap).sort((a, b) => a - b);
    const bytes = Buffer.alloc(proof.length * 6);
    proof.forEach((q, i) => { bytes.writeInt16LE(q[0], i * 6); bytes.writeInt16LE(q[1], i * 6 + 2); bytes.writeInt16LE(q[2], i * 6 + 4); });
    return {
        id, driver, wet, raceTime: +(clock - COUNTDOWN).toFixed(1), playerBest: player.bestLap, playerFinished: player.finished,
        playerWrecked: player.body.wrecked, playerInvalid: player.invalidLaps,
        finished, wrecked, fieldBest: best[0] ?? -1, median: best[Math.floor(best.length / 2)] ?? -1,
        invalidLaps: cars.reduce((s, c) => s + c.invalidLaps, 0), stuckEvents, maxStuck: +maxStuck.toFixed(1),
        meanDamage: +(cars.reduce((s, c) => s + c.body.damage, 0) / cars.length).toFixed(3),
        lapLength: Math.round(L), inputs: bytes.toString('base64'),
    };
}

function svg(id) {
    const w = world(id);
    const t = buildTrack(w);
    const n = t.count;
    const hw = (i) => (w.halfWidths?.[i] ?? t.halfWidth);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minX = Math.min(minX, t.x[i]); maxX = Math.max(maxX, t.x[i]); minY = Math.min(minY, t.y[i]); maxY = Math.max(maxY, t.y[i]); }
    const pad = 160;
    const pt = (i, lat) => [t.x[i] - t.ty[i] * lat, t.y[i] + t.tx[i] * lat];
    const poly = (lat, color, width = 1, pick = () => true) => {
        let d = '';
        for (let i = 0; i <= n; i++) { const k = i % n; if (!pick(k)) { d += ' '; continue; } const [x, y] = pt(k, lat(k)); d += `${i && pick((k - 1 + n) % n) ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
    };
    const RUN = ['#4caf50', '#d7b87a', '#9aa0a8'];
    const parts = [];
    // Run-off bands, the road, kerbs, the line.
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!t.drawn(i)) continue;
        for (const s of [-1, 1]) {
            const kind = (s < 0 ? w.runoffLeft : w.runoffRight)?.[i] ?? 0;
            const a = pt(i, s * hw(i)), b = pt(j, s * hw(j)), c = pt(j, s * (hw(j) + 30)), d = pt(i, s * (hw(i) + 30));
            parts.push(`<polygon points="${[a, b, c, d].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${RUN[kind]}"/>`);
        }
        const a = pt(i, -hw(i)), b = pt(j, -hw(j)), c = pt(j, hw(j)), d = pt(i, hw(i));
        parts.push(`<polygon points="${[a, b, c, d].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="#555"/>`);
        const k = w.kerbs?.[i] ?? 0;
        if (k) {
            const s = Math.sign(k);
            const e = pt(i, s * hw(i)), f = pt(j, s * hw(j)), g = pt(j, s * (hw(j) + 12)), h = pt(i, s * (hw(i) + 12));
            parts.push(`<polygon points="${[e, f, g, h].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${Math.abs(k) > 1 ? '#ffeb3b' : '#e53935'}"/>`);
        }
    }
    for (const p of w.patches || []) {
        for (let i = p.from; i !== p.to; i = (i + 1) % n) {
            const j = (i + 1) % n;
            const a = pt(i, p.latFrom), b = pt(j, p.latFrom), c = pt(j, p.latTo), d = pt(i, p.latTo);
            const col = { puddle: '#2196f3', dusty: '#c8a165', bumpy: '#8d6e63', resurfaced: '#222', paint: '#fff', dirt: '#a1887f' }[p.kind] || '#f0f';
            parts.push(`<polygon points="${[a, b, c, d].map(q => q.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${col}" opacity="0.7"/>`);
        }
    }
    for (const s of w.islands || []) {
        for (let i = s.from; i !== s.to; i = (i + 1) % n) {
            const j = (i + 1) % n;
            const a = pt(i, s.latFrom), b = pt(j, s.latFrom), c = pt(j, s.latTo), d = pt(i, s.latTo);
            parts.push(`<polygon points="${[a, b, c, d].map(q => q.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="#ff5722"/>`);
        }
    }
    if (w.racingLine?.length) parts.push(poly((i) => w.racingLine[i], '#00e5ff', 2, (i) => t.drawn(i)));
    parts.push(poly(() => 0, 'rgba(255,255,255,0.25)', 1, (i) => t.drawn(i)));
    // Start line, knot labels every `steps` samples, heights.
    const s0 = pt(0, -hw(0)), s1 = pt(0, hw(0));
    parts.push(`<line x1="${s0[0]}" y1="${s0[1]}" x2="${s1[0]}" y2="${s1[1]}" stroke="#fff" stroke-width="6"/>`);
    const steps = Math.round(n / (w.knots || 1));
    for (let i = 0; i < n; i += 4) {
        const z = w.centerZ?.[i];
        if (z !== undefined && i % 12 === 0) { const [x, y] = pt(i, -hw(i) - 60); parts.push(`<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" font-size="22" fill="#ffd54f">${Math.round(z)}</text>`); }
    }
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}" width="1100" style="background:#1d2b1d">${parts.join('')}</svg>`;
    fs.writeFileSync(path.join(WORLDS, id + '.svg'), out);
    console.log('wrote', id + '.svg', 'length', Math.round(t.length), 'samples', n);
}

const [cmd, id, driver, wet] = process.argv[1]?.endsWith('harness.mjs') ? process.argv.slice(2) : [];
if (cmd === 'svg') svg(id);
else if (cmd === 'log') {
    const log = [];
    const r = race(id, driver || 'clean', wet === '1', { log });
    console.log(log.join('\n'));
    console.log(JSON.stringify({ playerBest: r.playerBest, median: r.median, stuck: r.stuckEvents, wrecked: r.wrecked, meanDamage: r.meanDamage }));
}
else if (cmd === 'profile') {
    const w = world(id);
    const steps = Math.round(w.centerXY.length / 2 / (w.knotCount || 1));
    const prof = { steps: Number(driver) || 12, knots: [] };
    const r = race(id, 'clean', false, { profile: prof });
    console.log(JSON.stringify({ playerBest: r.playerBest, median: r.median, stuck: r.stuckEvents, wrecked: r.wrecked, meanDamage: r.meanDamage }));
    prof.knots.forEach((p, k) => p && console.log(`knot ${String(k).padStart(3)}  cars ${String(p.n).padStart(6)}  avg ${(p.v / p.n).toFixed(0).padStart(4)}  slow ${(100 * p.slow / p.n).toFixed(0).padStart(3)}%  off ${(100 * p.off / p.n).toFixed(0).padStart(3)}%`));
}
else if (cmd === 'race') {
    const t0 = Date.now();
    const r = race(id, driver || 'clean', wet === '1');
    const { inputs, ...rest } = r;
    console.log(JSON.stringify(rest), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (process.env.PROOF) fs.appendFileSync(process.env.PROOF, `${process.env.PROOF_NAME || id + '-' + (driver || 'clean')} ${id} ${wet === '1' ? 1 : 0} ${inputs} ${r.playerBest}\n`);
}
