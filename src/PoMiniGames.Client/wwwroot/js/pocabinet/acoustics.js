// pocabinet/acoustics.js
//
// What the car heard up close (the "ear": the player's, or in the demo the director's) hears from
// where it is, worked out each frame from the race and handed to audio.js. Render + audio only: it
// reads the race and never steps it.
//
//   • acoustic zone — 'metal' under the start gantry, under a bridge (a stretch of the course
//     passing overhead, found once at start) or between close barrier walls (a narrow section
//     with tight run-off both sides); 'stand' near the grandstand (scenery.crowd.center);
//     otherwise 'open' air, driest up on the hills. The bedroom (terrain.js isRoom) is one
//     'room' throughout: a small damped room, whatever the outdoor rules would say. The zone
//     and its wet level go to audio.setAcoustics, which crossfades its two convolvers.
//   • toy-track seams (the bedroom only) — the ear car's distance along the lap, counted in
//     audio.SEAM_SPACING joints, to audio.seams; audio.setRoom tells audio.js the track is plastic
//     (seams, plastic impacts and rail scrape).
//   • surface — what the tyres are on (the body's SURF_*, as fx.js reads it): gravel crunch,
//     sand drag (Mar-a-Lago's traps are beach sand), grass; wet tarmac hiss in the rain and a
//     splash through a puddle patch.
//   • slipstream — scene.fx.draft (slipstream.js works it out) to audio.setDraft, with the side
//     the car pulled out to for the whoosh.
//   • the score — phase (grid, race, finish, off), the battle the ear is in (broadcast.js's gap
//     to the car ahead or behind, faded in under BATTLE_LOST), the final lap, and a stinger
//     when the ear gains a place.

import * as ph from './physics.js';
import * as audio from './audio.js';
import { battleGap, BATTLE_LOST } from './broadcast.js';
import { currentEnvironment } from './environment.js';
import { WORLD_SCALE as WS } from './util.js';
import { isRoom } from './terrain.js';

const GANTRY_AT = 20;          // scenery.js buildGantry: the gantry stands this far along the lap
const GANTRY_REACH = 45;       // sim units either side of it that ring
const STAND_NEAR = 12;         // world units from the grandstand's centre: full slap
const STAND_FAR = 60;          // and where it has gone
const BRIDGE_CLEAR = 25;       // sim units of road overhead that count as a bridge
const CANYON_FROM = 150;       // wall-to-wall sim width under which the walls close in
const CANYON_SPAN = 45;
const BATTLE_FULL = 0.25;      // seconds of gap that is a full-on fight
const STING_HOLD = 2500;       // ms between two overtake stingers

export class Acoustics {
    constructor(race) {
        this.race = race;
        const t = race.track;
        this.track = t;
        this.covered = coverMap(t);
        this.walls = !(t.roadFrom > 0);         // the Playground's deck has no barrier walls
        this.beach = t.theme === 'maralago';
        this.puddles = t.patches.filter(p => p.kind === 'puddle');
        let lo = Infinity, hi = -Infinity;
        if (t.z) for (let i = 0; i < t.count; i++) { lo = Math.min(lo, t.z[i]); hi = Math.max(hi, t.z[i]); }
        this.zLo = lo; this.zSpan = hi - lo;
        this.earId = null;
        this.lastPos = 0;
        this.stingAt = 0;
        this.finished = false;
        this.raceStartAt = 0;
        this.room = isRoom(t);
        audio.setRoom(this.room);
        this.seamEar = null;       // whose seams are being counted, and where along the lap it was
        this.seamAlong = 0;
        this.seamAcc = 0;
        this.seamAt = 0;
    }

    /** Raining now: read live, so a weather change mid-race reaches the tyres' hiss and the puddles. */
    get wet() { return currentEnvironment().raining; }

    /** Per frame from race.js effects(). `ear` may be null. */
    update(ear, racing, preStart) {
        const r = this.race;
        const now = performance.now();
        if (!ear) {
            audio.setSurface('road', 0, false, 0);
            audio.setDraft(0, 0);
            audio.setMusic({ phase: r.replay ? 'off' : preStart ? 'grid' : 'off', battle: 0, finalLap: false });
            return;
        }
        const b = ear.body;
        const i = b.segHint >= 0 ? b.segHint : this.track.indexAt(ear.render.along);
        const kmh = Math.abs(ear.render.speed) * ph.KMH_PER_UNIT;

        const z = this.zone(ear, i);
        audio.setAcoustics(z.zone, z.wet);

        const kind = racing ? this.surface(b, i) : 'road';
        audio.setSurface(kind, racing ? kmh : 0, this.wet, racing ? this.puddle(i, b.lateral) : 0);
        if (this.room) this.seams(ear, racing && kind === 'road' && !b.wrecked, now);

        const fx = r.scene.fx;
        const draft = racing ? Math.min(1, Math.max(0, Number(fx?.draft) || 0)) : 0;
        audio.setDraft(draft, draft > 0 ? this.sideOf(ear, fx?.draftAhead) : this.lastSide || 0);

        // The score.
        if (racing && !this.raceStartAt) this.raceStartAt = now;
        if (ear.finished) this.finished = true;
        const phase = r.replay ? 'off' : this.finished ? 'finish' : preStart ? 'grid' : racing ? 'race' : 'off';
        const last = r.totalLaps - 1;
        let finalLap = r.totalLaps > 1 && !ear.finished && ear.lapsDone >= last;
        let ahead = null, behind = null, leader = null;
        for (const c of r.cars) {
            if (c.position === ear.position - 1) ahead = c;
            else if (c.position === ear.position + 1) behind = c;
            if (c.position === 1) leader = c;
        }
        // The demo's ear changes with every cut: the race's last lap is the leader's.
        if (r.mode === 'demo' && leader && leader.lapsDone >= last && r.totalLaps > 1 && !leader.finished) finalLap = true;
        let battle = 0;
        if (racing && !ear.finished && !b.wrecked) {
            for (const [a, c] of [[ahead, ear], [ear, behind]]) {
                if (!a || !c || a.finished || c.finished || a.body.wrecked || c.body.wrecked) continue;
                const gap = this.gap(a, c);
                if (gap >= 0) battle = Math.max(battle, Math.min(1, Math.max(0, (BATTLE_LOST - gap) / (BATTLE_LOST - BATTLE_FULL))));
            }
        }
        audio.setMusic({ phase, battle, finalLap });

        // A place gained by the car heard up close (the same car as last frame: a demo cut is not a pass).
        if (ear.id === this.earId && racing && ear.position < this.lastPos
            && now - this.raceStartAt > 2500 && now - this.stingAt > STING_HOLD) {
            this.stingAt = now;
            audio.musicStinger();
        }
        this.earId = ear.id;
        this.lastPos = ear.position;
    }

    /** Seconds between two cars nose to tail. Online, remote bodies carry no race distance: rebuild it. */
    gap(a, c) {
        if (this.race.mode !== 'net') return battleGap(a, c);
        const L = this.track.lapLength;
        const p = car => ({ body: { distance: car.lapsDone * L + car.render.along, speed: car.render.speed } });
        return battleGap(p(a), p(c));
    }

    /**
     * Toy-track joints the ear car's tyres crossed since last frame: its distance along the lap
     * (render.along, unwrapped across the line), in SEAM_SPACING steps, handed to audio.seams with
     * the frame's span so they land evenly. A new ear (demo cut), a reset or a teleport restarts it.
     */
    seams(ear, on, now) {
        const L = this.track.length;
        const along = ear.render.along;
        const span = this.seamAt ? (now - this.seamAt) / 1000 : 0;
        this.seamAt = now;
        if (ear !== this.seamEar || !on || !(span > 0) || span > 0.25) {
            this.seamEar = ear; this.seamAlong = along;
            return;
        }
        let d = along - this.seamAlong;
        if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
        this.seamAlong = along;
        d = Math.abs(d);
        const step = audio.SEAM_SPACING;
        if (d > step * 8) { this.seamAcc = 0; return; }   // a jump (reset to the road), not driving
        this.seamAcc += d;
        let n = 0;
        while (this.seamAcc >= step) { this.seamAcc -= step; n++; }
        if (n > 0) audio.seams(n, ear.render.speed, span);
    }

    zone(ear, i) {
        const t = this.track;
        // The bedroom: one small damped room everywhere (a touch drier up on the stilts, nearer the
        // middle of the room and further from the carpet).
        if (this.room) {
            const up = t.z && this.zSpan > 1 ? (t.z[i] - this.zLo) / this.zSpan : 0;
            return { zone: 'room', wet: 0.2 - 0.05 * up };
        }
        const rd = ear.render;
        // Metal: the gantry overhead, a bridge, or the walls closing in.
        let da = Math.abs(t.wrap(rd.along) - GANTRY_AT);
        da = Math.min(da, t.length - da);
        const gantry = Math.max(0, 1 - da / GANTRY_REACH);
        const bridge = this.covered[i] || 0;
        let canyon = 0;
        if (this.walls) {
            const w = ph.wallAt(t, i, -1) + ph.wallAt(t, i, 1);
            canyon = Math.min(1, Math.max(0, (CANYON_FROM - w) / CANYON_SPAN));
        }
        const metal = Math.max(gantry, bridge, canyon);
        // The grandstand.
        let stand = 0;
        const c = this.race.scene.scenery?.crowd?.center;
        if (c) {
            const d = Math.hypot(rd.x / WS - c.x, rd.y / WS - c.z);
            stand = Math.min(1, Math.max(0, 1 - (d - STAND_NEAR) / (STAND_FAR - STAND_NEAR)));
        }
        if (metal > 0.3 && metal >= stand) return { zone: 'metal', wet: 0.16 + 0.24 * metal };
        if (stand > 0.15) return { zone: 'stand', wet: 0.12 + 0.3 * stand };
        // Open air: a little ground bloom, less of it up on a hill.
        const hill = t.z && this.zSpan > 1 ? (t.z[i] - this.zLo) / this.zSpan : 0;
        return { zone: 'open', wet: 0.08 - 0.05 * hill };
    }

    surface(body, i) {
        const s = Number.isInteger(body.surface) && body.surface >= 0 ? body.surface : ph.surfaceAt(this.track, i, body.lateral);
        if (s === ph.SURF_GRAVEL) return this.beach ? 'sand' : 'gravel';
        if (s === ph.SURF_GRASS) return 'grass';
        return 'road';
    }

    /** 0..1 how far inside a puddle patch the car is (rain only). */
    puddle(i, lateral) {
        if (!this.wet) return 0;
        for (const p of this.puddles) {
            if (i >= p.from && i < p.to && lateral >= p.latFrom && lateral <= p.latTo) return 1;
        }
        return 0;
    }

    /** Which side of the ear the car it is towing behind sits (−1 left … +1 right). */
    sideOf(ear, ahead) {
        const a = ahead?.render;
        if (!a) return this.lastSide || 0;
        const h = ear.render.heading;
        const dx = a.x - ear.render.x, dy = a.y - ear.render.y;
        const lat = dy * Math.cos(h) - dx * Math.sin(h);
        // Pulling out goes the other way from where the wake is: the air comes from that side.
        this.lastSide = lat > 0 ? -1 : 1;
        return this.lastSide;
    }
}

/**
 * 0..1 per track sample: how covered the road is by another stretch of the same course passing
 * overhead (a bridge). Grid-hashed, once per race; smoothed a few samples either way so the ring
 * fades in under the deck's edge.
 */
function coverMap(t) {
    const n = t.count;
    const out = new Float32Array(n);
    if (!t.z) return out;
    const CELL = 80, key = (cx, cy) => cx * 73856093 ^ cy * 19349663;
    const grid = new Map();
    for (let i = 0; i < n; i++) {
        const k = key(Math.floor(t.x[i] / CELL), Math.floor(t.y[i] / CELL));
        let list = grid.get(k);
        if (!list) grid.set(k, list = []);
        list.push(i);
    }
    const hit = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
        const cx = Math.floor(t.x[i] / CELL), cy = Math.floor(t.y[i] / CELL);
        const reach = t.hwAt(i) + 20;
        for (let ox = -1; ox <= 1 && !hit[i]; ox++) {
            for (let oy = -1; oy <= 1 && !hit[i]; oy++) {
                for (const j of grid.get(key(cx + ox, cy + oy)) || []) {
                    let d = Math.abs(t.cum[j] - t.cum[i]);
                    d = Math.min(d, t.length - d);
                    if (d < 400 || t.z[j] - t.z[i] < BRIDGE_CLEAR) continue;
                    const dx = t.x[j] - t.x[i], dy = t.y[j] - t.y[i];
                    if (dx * dx + dy * dy < reach * reach) { hit[i] = 1; any = true; break; }
                }
            }
        }
    }
    if (!any) return out;
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += hit[(i + k + n) % n];
        out[i] = Math.min(1, s / 4);
    }
    return out;
}
