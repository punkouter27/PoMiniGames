// pocabinet/wake.js
//
// The air the cars leave behind them, as a field the particles drift on. Render only: it is
// built from the poses race.js already drew and nothing in physics.js reads it (the sim has no
// drafting force; slipstream.js is the felt tow, this is the seen one).
//
// A square grid of horizontal air velocity (WAKE_N cells a side, WAKE_CELL world units each,
// about 160 units across) that rides with the camera. Every frame:
//
//   1. carry    the air moves itself along (semi-Lagrangian, a fraction of its own speed), dies
//               away over about a second and spreads into its neighbours;
//   2. stir     every car at speed drags the air behind it along at two thirds of its own speed, and
//               shoves the air at its nose out to either side.
//
// Smoke, dust, spray and confetti are pulled toward the field where it is moving
// (fx.js Pool.step on the CPU; gpucompute.js's WGSL kernel reads the same grid, uploaded once a
// frame, when the particles are stepped on the GPU). So a car driving through a hanging cloud
// of tyre smoke parts it and takes a streak of it along, and the spray of the car ahead rolls
// into the hole it leaves. The field itself is stepped here, on the CPU, on every tier that has
// it: 4096 cells is a tenth of a millisecond, and the medium tier and the CPU fallback need it
// here anyway.
//
// The sampling rule (cell centres at origin + (i + 0.5) * cell, bilinear, zero outside) is
// mirrored in WGSL (gpucompute.js wakeAt): change both together.

export const WAKE_N = 64;
export const WAKE_CELL = 2.5;

const DECAY = 1.0;          // 1/s: the wake dies away
const CARRY = 0.55;         // the air moves at this share of its own speed
const SPREAD = 2.4;         // 1/s into the four neighbours
const DRAG = 0.65;          // the air behind a car, as a share of the car's speed
const STIR = 20;            // 1/s: how fast a car brings the air it touches up to that
const MIN_SPEED = 8;        // world units/s: slower than this a car stirs nothing
const TAIL = 1.8, NOSE = 2.2, SIDE = 1.1, REACH = 2.6;   // where a car stirs (world units from its centre)
const QUIET = 0.02;         // a field quieter than this everywhere is not stepped

/** How strongly a particle follows the field: the kernel's constants, shared with the CPU step. */
export const WAKE_COUPLE = 4.5;       // 1/s toward the air's velocity at full strength
export const WAKE_HEAVY = 6;          // a particle this heavy (its gravity) ignores the air
export const WAKE_CEILING = 4;        // world units over its floor where the wake no longer reaches

export class WakeField {
    constructor() {
        this.n = WAKE_N;
        this.cell = WAKE_CELL;
        this.u = new Float32Array(WAKE_N * WAKE_N * 2);
        this.tmp = new Float32Array(WAKE_N * WAKE_N * 2);
        this.ox = 0;            // world x of the corner of cell (0, 0)
        this.oz = 0;
        this.peak = 0;          // the fastest air in the field after the last step
        this.version = 0;       // bumped whenever the grid's contents or origin change
        this.placed = false;
    }

    /** Keep the window centred on (cx, cz), a whole number of cells at a time, taking the air with it. */
    recenter(cx, cz) {
        const n = this.n, cell = this.cell;
        const ox = (Math.round(cx / cell) - n / 2) * cell, oz = (Math.round(cz / cell) - n / 2) * cell;
        if (!this.placed) { this.ox = ox; this.oz = oz; this.placed = true; this.version++; return; }
        const di = Math.round((ox - this.ox) / cell), dj = Math.round((oz - this.oz) / cell);
        if (!di && !dj) return;
        this.ox = ox; this.oz = oz;
        this.version++;
        if (this.peak <= 0) return;
        const src = this.u, dst = this.tmp;
        // A cut to another camera: nothing of the old window is in the new one.
        if (Math.abs(di) >= n || Math.abs(dj) >= n) { src.fill(0); this.peak = 0; return; }
        dst.fill(0);
        for (let j = 0; j < n; j++) {
            const sj = j + dj;
            if (sj < 0 || sj >= n) continue;
            for (let i = 0; i < n; i++) {
                const si = i + di;
                if (si < 0 || si >= n) continue;
                const d = (j * n + i) * 2, s = (sj * n + si) * 2;
                dst[d] = src[s]; dst[d + 1] = src[s + 1];
            }
        }
        this.u = dst; this.tmp = src;
    }

    /** The air at world (x, z) into out[0], out[1]; zero outside the window. */
    sample(x, z, out) {
        const n = this.n;
        const gx = (x - this.ox) / this.cell - 0.5, gz = (z - this.oz) / this.cell - 0.5;
        if (gx < 0 || gz < 0 || gx >= n - 1 || gz >= n - 1) { out[0] = 0; out[1] = 0; return out; }
        const i = Math.floor(gx), j = Math.floor(gz);
        const fx = gx - i, fz = gz - j;
        const u = this.u;
        const a = (j * n + i) * 2, b = a + 2, c = a + n * 2, d = c + 2;
        const top0 = u[a] + (u[b] - u[a]) * fx, top1 = u[a + 1] + (u[b + 1] - u[a + 1]) * fx;
        const bot0 = u[c] + (u[d] - u[c]) * fx, bot1 = u[c + 1] + (u[d + 1] - u[c + 1]) * fx;
        out[0] = top0 + (bot0 - top0) * fz;
        out[1] = top1 + (bot1 - top1) * fz;
        return out;
    }

    /**
     * One frame of the field. `cars`: [{ x, y, heading, speed }] in sim units (fx.js's list);
     * `ws`: sim units per world unit. Returns true if the grid changed.
     */
    step(dt, cars, ws) {
        if (!(dt > 0)) return false;
        const h = Math.min(dt, 0.05);
        let changed = false;
        if (this.peak > QUIET) { this.carry(h); changed = true; }
        if (this.stir(h, cars, ws)) changed = true;
        if (changed) this.version++;
        return changed;
    }

    carry(h) {
        const n = this.n, cell = this.cell;
        const src = this.u, dst = this.tmp;
        const keep = Math.exp(-h * DECAY);
        const back = h * CARRY / cell;
        const blend = Math.min(0.2, h * SPREAD);
        let peak = 0;
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const o = (j * n + i) * 2;
                const ux = src[o], uz = src[o + 1];
                // Where this cell's air came from (in cells), clamped to the grid.
                let gx = i - ux * back, gz = j - uz * back;
                gx = gx < 0 ? 0 : gx > n - 1.001 ? n - 1.001 : gx;
                gz = gz < 0 ? 0 : gz > n - 1.001 ? n - 1.001 : gz;
                const i0 = Math.floor(gx), j0 = Math.floor(gz);
                const fx = gx - i0, fz = gz - j0;
                const a = (j0 * n + i0) * 2, b = a + 2, c = a + n * 2, d = c + 2;
                let vx = (src[a] + (src[b] - src[a]) * fx) * (1 - fz) + (src[c] + (src[d] - src[c]) * fx) * fz;
                let vz = (src[a + 1] + (src[b + 1] - src[a + 1]) * fx) * (1 - fz) + (src[c + 1] + (src[d + 1] - src[c + 1]) * fx) * fz;
                // Into the neighbours (the edge cells have none on one side: they leak away).
                const l = i > 0 ? o - 2 : -1, r = i < n - 1 ? o + 2 : -1, up = j > 0 ? o - n * 2 : -1, dn = j < n - 1 ? o + n * 2 : -1;
                const ax = ((l < 0 ? 0 : src[l]) + (r < 0 ? 0 : src[r]) + (up < 0 ? 0 : src[up]) + (dn < 0 ? 0 : src[dn])) * 0.25;
                const az = ((l < 0 ? 0 : src[l + 1]) + (r < 0 ? 0 : src[r + 1]) + (up < 0 ? 0 : src[up + 1]) + (dn < 0 ? 0 : src[dn + 1])) * 0.25;
                vx = (vx + (ax - vx) * blend) * keep;
                vz = (vz + (az - vz) * blend) * keep;
                dst[o] = vx; dst[o + 1] = vz;
                const m = vx * vx + vz * vz;
                if (m > peak) peak = m;
            }
        }
        this.u = dst; this.tmp = src;
        this.peak = Math.sqrt(peak);
    }

    /** Pull the air round world (x, z) toward (tx, tz), fully at the point and not at all `REACH` away. */
    stamp(x, z, tx, tz, rate) {
        const n = this.n, cell = this.cell, u = this.u;
        const gx = (x - this.ox) / cell - 0.5, gz = (z - this.oz) / cell - 0.5;
        const r = REACH / cell;
        const i0 = Math.max(0, Math.ceil(gx - r)), i1 = Math.min(n - 1, Math.floor(gx + r));
        const j0 = Math.max(0, Math.ceil(gz - r)), j1 = Math.min(n - 1, Math.floor(gz + r));
        let hit = false;
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const dx = i - gx, dz = j - gz;
                const w = 1 - (dx * dx + dz * dz) / (r * r);
                if (w <= 0) continue;
                const o = (j * n + i) * 2, k = rate * w * w;
                u[o] += (tx - u[o]) * k;
                u[o + 1] += (tz - u[o + 1]) * k;
                hit = true;
            }
        }
        return hit;
    }

    stir(h, cars, ws) {
        if (!Array.isArray(cars)) return false;
        const span = this.n * this.cell;
        const rate = 1 - Math.exp(-h * STIR);
        let any = false;
        for (const c of cars) {
            const sp = (Number(c.speed) || 0) / ws;
            if (Math.abs(sp) < MIN_SPEED || !Number.isFinite(c.heading)) continue;
            const x = c.x / ws, z = c.y / ws;
            if (x < this.ox || z < this.oz || x > this.ox + span || z > this.oz + span) continue;
            const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
            const vx = fx * sp, vz = fz * sp;
            // Behind it: the air comes along.
            if (this.stamp(x - fx * TAIL, z - fz * TAIL, vx * DRAG, vz * DRAG, rate)) any = true;
            // At its nose: out of the way, to either side (and a little forward).
            const out = Math.abs(sp) * 0.28;
            for (const side of [-1, 1]) {
                const sx = -fz * side, sz = fx * side;
                this.stamp(x + fx * NOSE + sx * SIDE, z + fz * NOSE + sz * SIDE, sx * out + vx * 0.12, sz * out + vz * 0.12, rate * 0.6);
            }
            this.peak = Math.max(this.peak, Math.abs(sp) * DRAG * rate);
        }
        return any;
    }

    clear() {
        this.u.fill(0);
        this.peak = 0;
        this.version++;
    }
}
