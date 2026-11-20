// pocabinet/track.js
//
// Runtime track: arc-length tables, projection and curvature over the centerline
// the page hands us (PoCabinetTrackGeometry.BuildStaticWorld — the ONE source of
// track geometry; client and server resample the same knots).
//
// MIRROR CONTRACT: this is a line-for-line port of
// src/PoMiniGames.API/Features/PoCabinet/PoCabinetTrack.cs. Multiplayer prediction
// runs this projection against the server's; change the search window, the
// smoothing or the sample step on one side and predicted cars drift on the other.

const CURVATURE_SAMPLE_STEP = 8;
const HALF_PI = Math.PI / 2;
/** Track evolution (gripAt): rubber goes down on the racing line over this much race time; on it
 *  the grip rises (more again in the wet, where the line dries first), and well off it the
 *  marbles take a little away. MIRRORED: PoCabinetTrack. */
const RUBBER_SECONDS = 90;
const RUBBER_BAND = 24;
const RUBBER_DRY = 0.05;
const RUBBER_WET = 0.1;
const MARBLES_FROM = 50;
const MARBLES = 0.04;
/** Samples over which a road divider tapers to a point at either end. MIRRORED: PoCabinetTrack. */
const ISLAND_TAPER = 4;

/** How much rubber is down `elapsed` seconds into a race, 0..1. Mirrors PoCabinetTrack.RubberAt. */
export function rubberAt(elapsed) {
    return Math.min(1, Math.max(0, elapsed / RUBBER_SECONDS));
}

// ── Trig the sim can rely on ────────────────────────────────────────────────
// sin, cos and atan2 built from + − × ÷, floor and sqrt only, which IEEE 754 pins to the
// last bit, so Chrome, Firefox, node and .NET all get the SAME double. Math.sin and
// friends are not pinned: Chrome and node differed by one ulp sixteen ticks into a race,
// and a 100-car field is chaotic enough to turn that into a different race by the first
// corner, which the lap verifier then times as a crash. Everything that feeds the
// simulation (physics.js, the curvature table below) uses these; rendering may use Math.
// MIRRORED: PoCabinetTrack.Sin / Cos / Atan2, same operations in the same order.

/** sin(a + quarter·π/2): reduce to within π/4 of a multiple of π/2, then the Taylor series. */
function sinShifted(a, quarter) {
    const k = Math.floor(a / HALF_PI + 0.5);
    const r = a - k * HALF_PI;
    const r2 = r * r;
    const q = (((k + quarter) % 4) + 4) % 4;
    if (q === 0 || q === 2) {
        const s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110 * (1 - r2 / 156 * (1 - r2 / 210)))))));
        return q === 0 ? s : -s;
    }
    const c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90 * (1 - r2 / 132 * (1 - r2 / 182 * (1 - r2 / 240)))))));
    return q === 1 ? c : -c;
}

export function sin(a) { return sinShifted(a, 0); }
export function cos(a) { return sinShifted(a, 1); }

/** atan z for |z| ≤ 1: halve the angle three times (atan z = 2·atan(z / (1 + √(1 + z²)))), then the series. */
function atanUnit(z) {
    let t = z / (1 + Math.sqrt(1 + z * z));
    t = t / (1 + Math.sqrt(1 + t * t));
    t = t / (1 + Math.sqrt(1 + t * t));
    const t2 = t * t;
    return 8 * t * (1 - t2 * (1 / 3 - t2 * (1 / 5 - t2 * (1 / 7 - t2 * (1 / 9 - t2 * (1 / 11 - t2 * (1 / 13 - t2 / 15)))))));
}

export function atan2(y, x) {
    const ax = Math.abs(x), ay = Math.abs(y);
    if (ax >= ay) {
        if (ax === 0) return 0;
        const a = atanUnit(y / x);
        return x > 0 ? a : y >= 0 ? a + Math.PI : a - Math.PI;
    }
    const a = atanUnit(x / y);
    return y > 0 ? HALF_PI - a : -HALF_PI - a;
}

/** Signed angle normalised to (-π, π]. Same operation order as the C# WrapAngle. */
export function wrapAngle(a) {
    a %= 2 * Math.PI;
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a <= -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * Build a track from the static world ({ centerXY: number[], trackWidth, trackId }).
 * centerXY is flat [x0, y0, x1, y1, …] in sim units.
 */
export function buildTrack(world) {
    const xy = Array.isArray(world?.centerXY) ? world.centerXY : [];
    const count = Math.floor(xy.length / 2);
    if (count < 3) throw new Error('pocabinet/track: centerline is required');

    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        x[i] = Number(xy[i * 2]);
        y[i] = Number(xy[i * 2 + 1]);
    }

    const segLen = new Float64Array(count);
    const cum = new Float64Array(count + 1);
    const tx = new Float64Array(count);
    const ty = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const len = Math.sqrt(dx * dx + dy * dy);
        segLen[i] = len;
        cum[i + 1] = cum[i] + len;
        tx[i] = len > 1e-9 ? dx / len : 1;
        ty[i] = len > 1e-9 ? dy / len : 0;
    }
    const length = cum[count];

    const raw = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const p = (i - 1 + count) % count;
        const d = wrapAngle(atan2(ty[i], tx[i]) - atan2(ty[p], tx[p]));
        const span = Math.max(1e-6, (segLen[p] + segLen[i]) * 0.5);
        raw[i] = Math.abs(d) / span;
    }
    const curv = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        curv[i] = (raw[(i - 1 + count) % count] + raw[i] + raw[(i + 1) % count]) / 3.0;
    }

    return new Track(world, x, y, segLen, cum, tx, ty, curv, length, Number(world.trackWidth) * 0.5);
}

class Track {
    constructor(world, x, y, segLen, cum, tx, ty, curv, length, halfWidth) {
        this.id = String(world?.trackId || 'grandprix');
        this.x = x; this.y = y;
        this.segLen = segLen; this.cum = cum;
        this.tx = tx; this.ty = ty; this.curv = curv;
        this.count = x.length;
        this.length = length;
        this.halfWidth = halfWidth;

        // Point-to-point (world.finishIndex > 0): the lap ends at that
        // centerline sample instead of back at the line, and a finished car rolls on into the
        // run-out and parks half way down it instead of taking a cool-down lap. The loop still
        // closes — through a return link nobody drives — so every wrap in here keeps working.
        // MIRRORED: PoCabinetTrack.LapLength / CoolDownAt.
        const finish = Number(world?.finishIndex) || 0;
        this.hiddenFrom = Number(world?.hiddenFrom) || 0;
        this.hiddenTo = Number(world?.hiddenTo) || 0;
        this.pointToPoint = finish > 0 && finish < this.count;
        this.lapLength = this.pointToPoint ? cum[finish] : length;
        this.parkAt = this.pointToPoint ? (cum[finish] + cum[this.hiddenFrom]) / 2 : 0;

        // Road height per sample in sim units and the road's cross slope (tan of the bank, + =
        // right side higher): the physics reads them per segment (grade(), bankOf(): gravity on
        // a slope, grip in a banked turn), the scene interpolated (heightAt(), bankAt()).
        const perSample = (a) => Array.isArray(a) && a.length === this.count ? Float64Array.from(a, Number) : null;
        this.z = perSample(world?.centerZ);
        this.bank = perSample(world?.centerBank);

        // Track features (PoCabinetTrackFeatures, shipped with the world): road half width,
        // run-off either side (0 grass, 1 gravel, 2 tarmac), apex kerbs (±1 flat, ±2 raised, sign
        // = side), the racing line, grip patches and road dividers. A world without them (an old
        // payload) reads as the plain track it used to be.
        const ints = (a) => Array.isArray(a) && a.length === this.count ? Int8Array.from(a, Number) : new Int8Array(this.count);
        this.hw = perSample(world?.halfWidths) || new Float64Array(this.count).fill(halfWidth);
        this.runoffLeft = ints(world?.runoffLeft);
        this.runoffRight = ints(world?.runoffRight);
        this.kerbs = ints(world?.kerbs);
        this.line = perSample(world?.racingLine) || new Float64Array(this.count);
        this.theme = String(world?.theme || this.id);
        // Render-only: the scenery zone each sample is dressed as (capitol, senate, court,
        // maralago; '' where the world names none) and the scan the lap drives through
        // ({ x, y, scale, floorZ, halfLength, halfWidth } in sim units and metres), or null.
        this.zoneOf = new Array(this.count).fill('');
        for (const z of Array.isArray(world?.zones) ? world.zones : []) {
            const from = Number(z.from) | 0, to = Number(z.to) | 0;
            const span = ((to - from) % this.count + this.count) % this.count || this.count;
            for (let j = 0; j < span; j++) this.zoneOf[(from + j) % this.count] = String(z.theme || '');
        }
        const scan = world?.scan;
        this.scan = scan && Number(scan.scale) > 0 ? {
            x: Number(scan.x) || 0, y: Number(scan.y) || 0, scale: Number(scan.scale), floorZ: Number(scan.floorZ) || 0,
            halfLength: Number(scan.halfLength) || 0, halfWidth: Number(scan.halfWidth) || 0,
        } : null;
        this.patches = (Array.isArray(world?.patches) ? world.patches : []).map(p => ({
            from: Number(p.from) | 0, to: Number(p.to) | 0, latFrom: Number(p.latFrom), latTo: Number(p.latTo),
            dryGrip: Number(p.dryGrip), wetGrip: Number(p.wetGrip), kind: String(p.kind || ''),
        }));
        this.islands = (Array.isArray(world?.islands) ? world.islands : []).map(s => {
            const from = Number(s.from) | 0, to = Number(s.to) | 0;
            return {
                from, to, latFrom: Number(s.latFrom), latTo: Number(s.latTo), shortSide: Number(s.shortSide) || 1,
                fromAlong: cum[from], toAlong: cum[to], hw: this.hw[(from + ((to - from) >> 1)) % this.count],
            };
        });
        // Which divider (index into islands) stands on each sample, or -1, and how wide it is
        // there: it tapers to a point over its first and last ISLAND_TAPER samples, so a car that
        // meets its nose glances off instead of stopping dead.
        this.islandOf = new Int16Array(this.count).fill(-1);
        this.islandLo = new Float64Array(this.count);
        this.islandHi = new Float64Array(this.count);
        this.islands.forEach((s, k) => {
            const n = (s.to - s.from + this.count) % this.count;
            const mid = (s.latFrom + s.latTo) * 0.5, half = (s.latTo - s.latFrom) * 0.5;
            for (let j = 0; j < n; j++) {
                const i = (s.from + j) % this.count;
                const t = Math.min(1, (j + 1) / ISLAND_TAPER, (n - j) / ISLAND_TAPER);
                this.islandOf[i] = k;
                this.islandLo[i] = mid - half * t;
                this.islandHi[i] = mid + half * t;
            }
        });
    }

    /** Road half width at sample `i`. Mirrors PoCabinetTrack.HalfWidthAt. */
    hwAt(i) {
        return this.hw[i];
    }

    /** Run-off kind at sample `i` on `side` (+1 right): 0 grass, 1 gravel, 2 tarmac. Mirrors PoCabinetTrack.RunoffAt. */
    runoffAt(i, side) {
        return side > 0 ? this.runoffRight[i] : this.runoffLeft[i];
    }

    /** The divider standing on sample `i`, or null. Mirrors PoCabinetTrack.IslandAt. */
    islandAt(i) {
        const k = this.islandOf[i];
        return k >= 0 ? this.islands[k] : null;
    }

    /**
     * What the road itself does to grip at sample `i`, `lateral` from the centerline: its
     * patches, in order, then the rubber laid on the racing line (and the marbles off it).
     * Mirrors PoCabinetTrack.GripAt, operation for operation.
     */
    gripAt(i, lateral, wet, rubber) {
        let g = 1;
        for (const p of this.patches) {
            if (i >= p.from && i < p.to && lateral >= p.latFrom && lateral <= p.latTo) g *= wet ? p.wetGrip : p.dryGrip;
        }
        if (rubber > 0 && Math.abs(lateral) <= this.hw[i]) {
            const off = Math.abs(lateral - this.line[i]);
            if (off < RUBBER_BAND) g *= 1 + (wet ? RUBBER_WET : RUBBER_DRY) * rubber;
            else if (off > MARBLES_FROM && !wet) g *= 1 - MARBLES * rubber;
        }
        return g;
    }

    /** Share of its top speed a finished car at race distance `distance` holds. Mirrors PoCabinetTrack.CoolDownAt. */
    coolDownAt(distance) {
        return this.parked(distance) ? 0 : 0.6;
    }

    /**
     * True once a car has rolled to the parking point of a point-to-point track's run-out
     * (never on a circuit). A parked car is out of the race for good: it no longer collides
     * and the AI no longer sees it, or the first two dozen finishers would fill the run-out
     * and everyone behind would queue back over the finish line. Mirrors PoCabinetTrack.Parked.
     */
    parked(distance) {
        return this.pointToPoint && distance >= this.parkAt;
    }

    /** False for the segments from sample `i` that belong to the undrawn return link. */
    drawn(i) {
        return !(i >= this.hiddenFrom && i < this.hiddenTo);
    }

    /** The scenery zone sample `i` is dressed as: 'capitol', 'senate', 'court', 'maralago' or ''. */
    zoneAt(i) {
        return this.zoneOf[i];
    }

    /** True inside the drawn part of the scan (sim point), grown by `pad` sim units; false without one. */
    inScan(x, y, pad = 0) {
        const s = this.scan;
        return !!s && Math.abs(x - s.x) <= s.halfLength * s.scale + pad && Math.abs(y - s.y) <= s.halfWidth * s.scale + pad;
    }

    /** Rise per unit of road along segment `i` (+ = uphill in the direction of travel); 0 on a flat track. Mirrors PoCabinetTrack.Grade. */
    grade(i) {
        if (!this.z) return 0;
        const len = this.segLen[i];
        return len > 1e-9 ? (this.z[(i + 1) % this.count] - this.z[i]) / len : 0;
    }

    /** Cross slope at sample `i` (+ = right side higher); 0 on an unbanked track. Mirrors PoCabinetTrack.Bank. */
    bankOf(i) {
        return this.bank ? this.bank[i] : 0;
    }

    /** Cross slope (tan of the bank) at a distance along the loop; 0 on an unbanked track. */
    bankAt(distance) {
        if (!this.bank) return 0;
        const i = this.indexAt(distance);
        const f = this.segLen[i] > 1e-9 ? (this.wrap(distance) - this.cum[i]) / this.segLen[i] : 0;
        const a = this.bank[i], b = this.bank[(i + 1) % this.count];
        return a + (b - a) * f;
    }

    /** Road height (sim units) at a distance along the loop; 0 on a flat track. */
    heightAt(distance) {
        if (!this.z) return 0;
        const i = this.indexAt(distance);
        const f = this.segLen[i] > 1e-9 ? (this.wrap(distance) - this.cum[i]) / this.segLen[i] : 0;
        const a = this.z[i], b = this.z[(i + 1) % this.count];
        return a + (b - a) * f;
    }

    /** Closest centerline point. Returns { index, along, lateral, tx, ty } (lateral + = right). */
    project(px, py, hint) {
        let best = -1, bestD2 = Number.MAX_VALUE, bestT = 0;
        const consider = (i) => {
            const len = this.segLen[i];
            let t = len > 1e-9 ? ((px - this.x[i]) * this.tx[i] + (py - this.y[i]) * this.ty[i]) / len : 0;
            t = Math.min(1, Math.max(0, t));
            const qx = this.x[i] + this.tx[i] * t * len;
            const qy = this.y[i] + this.ty[i] * t * len;
            const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
            if (d2 < bestD2) { bestD2 = d2; best = i; bestT = t; }
        };
        if (hint >= 0 && hint < this.count) {
            for (let k = -6; k <= 10; k++) {
                consider((((hint + k) % this.count) + this.count) % this.count);
            }
            const limit = this.halfWidth * 3;
            if (bestD2 > limit * limit) best = -1;
        }
        if (best < 0) {
            bestD2 = Number.MAX_VALUE;
            for (let i = 0; i < this.count; i++) consider(i);
        }
        const qx = this.x[best] + this.tx[best] * bestT * this.segLen[best];
        const qy = this.y[best] + this.ty[best] * bestT * this.segLen[best];
        const lateral = (px - qx) * -this.ty[best] + (py - qy) * this.tx[best];
        return {
            index: best,
            along: this.cum[best] + bestT * this.segLen[best],
            lateral,
            tx: this.tx[best],
            ty: this.ty[best],
        };
    }

    /** Point at a distance along the loop: { x, y, tx, ty }. */
    pointAt(distance) {
        const i = this.indexAt(distance);
        const d = this.wrap(distance) - this.cum[i];
        return { x: this.x[i] + this.tx[i] * d, y: this.y[i] + this.ty[i] * d, tx: this.tx[i], ty: this.ty[i] };
    }

    /** Tightest smoothed curvature between two distances. */
    maxCurvature(fromDistance, toDistance) {
        let max = 0;
        for (let d = fromDistance; d <= toDistance; d += CURVATURE_SAMPLE_STEP) {
            const c = this.curv[this.indexAt(d)];
            if (c > max) max = c;
        }
        return max;
    }

    indexAt(distance) {
        const d = this.wrap(distance);
        let lo = 0, hi = this.count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.cum[mid] <= d) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Smoothed curvature at a point index — the racing-line overlay colours by it. */
    curvatureAt(index) {
        return this.curv[index] || 0;
    }

    wrap(distance) {
        const d = distance % this.length;
        return d < 0 ? d + this.length : d;
    }
}
