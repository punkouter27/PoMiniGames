// pocabinet/terrain.js
//
// The ground a circuit with heights stands on (render only: the physics never sees it).
//
// The road (track.z, the centerline's height, tilted across by track.bank) is a fixed plane
// out to the barriers; the cars ride it (race.js place()). The terrain is a heightfield that
// lies on that plane under the road and its run-off (a hair below, so the road and its run-off
// strips always sit on top), then leaves it beyond the barrier: over BLEND it eases into a
// smooth average of the whole lap's heights, and further out into rolling hills (and, on the
// themes that have them, a ring of distant ones the fog fades). Every prop the scene puts
// trackside stands on heightAt(), the same grid the ground mesh is built from.
//
// The grid is fine (CELL) around the track and grows coarser out to FAR_PAD, so the hills
// reach well into the fog for a few thousand vertices more. Built once per track.
//
// Also the home of the theme lookup (track.theme with a fallback), so scene, scenery, sky
// and grass decide by the same word.

import * as THREE from 'three';
import { runOffAt } from './physics.js';
import { WORLD_SCALE as WS, hash, fnv1a, clamp01 } from './util.js';

const CELL = 15;          // sim units per grid cell near the track
const FINE_PAD = 800;     // fine grid this far past the centerline's bounds
const FAR_PAD = 9000;     // then coarser and coarser out to here
const GROWTH = 1.2;
const BLEND = 260;        // the ground leaves the road's plane over this much
const SHOULDER = 5;       // the barrier's thickness and a little: still on the road's plane
const DIP = 1.2;          // the ground under the road band sits this far below it
const BUCKET = 120;
const REACH = 420;        // segments further off than this have no say in the near ground

/** Rolling hills near (sim units) and the far ring's height, per theme. */
const HILLS = {
    capitol: { near: 70, far: 170 },
    maralago: { near: 30, far: 0 },
    pressbriefing: { near: 10, far: 0 },
    senate: { near: 170, far: 400 },
};

const THEMES = new Set(['capitol', 'maralago', 'pressbriefing', 'senate', 'playground', 'bedroom', 'court']);

/** The scenery theme a track is dressed in: its own word, else its id, else Capitol. */
export function themeOf(track) {
    const t = String(track?.theme || '');
    if (THEMES.has(t)) return t;
    const id = String(track?.id || '');
    return THEMES.has(id) ? id : 'capitol';
}

/** A toy track laid on a scanned room (Bedroom Floor GP): the model is the ground and the
 *  scenery, the road is plastic on the carpet and up on stilts where it climbs. */
export function isRoom(track) {
    return themeOf(track) === 'bedroom';
}

/** A toy track laid over a scan (models.js SCANS): the bedroom, indoors, and Center Court, the
 *  outdoor basketball court. The scan is the ground and the scenery; the road is moulded plastic,
 *  on stilts wherever it is off the floor. */
export function isScan(track) {
    const t = themeOf(track);
    return t === 'bedroom' || t === 'court';
}

/** The Playground run: a road in the air over a model, with its own (older) staging. */
export function isPlayground(track) {
    return (Number(track?.roadFrom) || 0) > 0 || track?.id === 'playground';
}

/** Lateral of the barrier's face at sample `i` on `side` (+1 right), sim units, unsigned. */
export function wallFace(track, i, side) {
    return track.hwAt(i) + runOffAt(track, i, side);
}

function smoothstep(a, b, x) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}

function vnoise(x, y, seed) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed);
    const c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** 0..1 fbm, `wave` sim units per lowest octave. */
function fbm(x, y, wave, seed) {
    let s = 0, amp = 0.5, total = 0, f = 1 / wave;
    for (let o = 0; o < 3; o++) {
        s += amp * vnoise(x * f, y * f, seed + o);
        total += amp;
        amp *= 0.5;
        f *= 2.1;
    }
    return s / total;
}

/** Grid axis: fine from lo - FINE_PAD to hi + FINE_PAD, then growing steps out to FAR_PAD. */
function axis(lo, hi) {
    const a = lo - FINE_PAD;
    const n = Math.ceil((hi + FINE_PAD - a) / CELL);
    const fine = [];
    for (let k = 0; k <= n; k++) fine.push(a + k * CELL);
    const left = [], right = [];
    let step = CELL, x = a;
    while (x > lo - FAR_PAD) { step *= GROWTH; x -= step; left.unshift(x); }
    step = CELL; x = fine[fine.length - 1];
    while (x < hi + FAR_PAD) { step *= GROWTH; x += step; right.push(x); }
    return { v: Float64Array.from([...left, ...fine, ...right]), from: left.length, count: fine.length };
}

/** Largest index k with v[k] <= x (clamped to [0, v.length - 2]). */
function cellOf(v, x) {
    let lo = 0, hi = v.length - 2;
    if (x <= v[0]) return 0;
    if (x >= v[hi]) return hi;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (v[mid] <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
}

export class Terrain {
    /** @param track runtime track (track.js); @param theme themeOf(track) */
    constructor(track, theme) {
        this.track = track;
        this.theme = theme;
        const n = track.count;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, zSum = 0;
        for (let i = 0; i < n; i++) {
            minX = Math.min(minX, track.x[i]); maxX = Math.max(maxX, track.x[i]);
            minY = Math.min(minY, track.y[i]); maxY = Math.max(maxY, track.y[i]);
            zSum += track.z ? track.z[i] : 0;
        }
        this.bounds = { minX, maxX, minY, maxY };
        this.base = zSum / n;
        this.hills = HILLS[theme] || HILLS.capitol;
        this.seed = fnv1a(`pocabinet-terrain:${track.id}`) % 100000;

        // Per-sample barrier (outer face + shoulder) either side, and the plane's height.
        this.wallL = new Float64Array(n);
        this.wallR = new Float64Array(n);
        this.wallMax = 0;
        for (let i = 0; i < n; i++) {
            this.wallL[i] = wallFace(track, i, -1) + SHOULDER;
            this.wallR[i] = wallFace(track, i, 1) + SHOULDER;
            this.wallMax = Math.max(this.wallMax, this.wallL[i], this.wallR[i]);
        }

        // Segment buckets: every segment that can be within REACH of a bucket's cell.
        this.bx0 = minX - REACH - 200; this.by0 = minY - REACH - 200;
        this.bnx = Math.ceil((maxX - minX + 2 * REACH + 400) / BUCKET);
        this.bny = Math.ceil((maxY - minY + 2 * REACH + 400) / BUCKET);
        this.buckets = Array.from({ length: this.bnx * this.bny }, () => []);
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const w = Math.max(this.wallL[i], this.wallR[i], this.wallL[j], this.wallR[j]) + REACH;
            const x0 = Math.min(track.x[i], track.x[j]) - w, x1 = Math.max(track.x[i], track.x[j]) + w;
            const y0 = Math.min(track.y[i], track.y[j]) - w, y1 = Math.max(track.y[i], track.y[j]) + w;
            const cx0 = Math.max(0, Math.floor((x0 - this.bx0) / BUCKET)), cx1 = Math.min(this.bnx - 1, Math.floor((x1 - this.bx0) / BUCKET));
            const cy0 = Math.max(0, Math.floor((y0 - this.by0) / BUCKET)), cy1 = Math.min(this.bny - 1, Math.floor((y1 - this.by0) / BUCKET));
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.buckets[cy * this.bnx + cx].push(i);
        }

        // The grid.
        const ax = axis(minX, maxX), ay = axis(minY, maxY);
        this.xs = ax.v; this.ys = ay.v;
        this.fine = { x: ax.from, nx: ax.count, y: ay.from, ny: ay.count };
        const W = this.xs.length, H = this.ys.length;
        this.h = new Float32Array(W * H);
        const band = new Uint8Array(W * H);
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < W; c++) {
                this.h[r * W + c] = this.compute(this.xs[c], this.ys[r]);
                band[r * W + c] = this.lastInBand ? 1 : 0;
            }
        }
        // Under the road band the ground is never seen (road and run-off strips cover it), but a
        // grid cell interpolating across a fold or a kink can still rise through a strip: one
        // pass of a 3 × 3 minimum there keeps it under.
        const src = this.h.slice();
        for (let r = 1; r < H - 1; r++) {
            for (let c = 1; c < W - 1; c++) {
                if (!band[r * W + c]) continue;
                let m = src[r * W + c];
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) m = Math.min(m, src[(r + dr) * W + c + dc]);
                this.h[r * W + c] = m;
            }
        }
        this.edge = this.base;   // the outer ring's height (compute() fades to it)
        this.heightTex = null;
    }

    /** The ground's height (sim units) at a sim point, straight from the formula. */
    compute(x, y) {
        const t = this.track, n = t.count;
        const bx = Math.floor((x - this.bx0) / BUCKET), by = Math.floor((y - this.by0) / BUCKET);
        const list = bx >= 0 && by >= 0 && bx < this.bnx && by < this.bny ? this.buckets[by * this.bnx + bx] : null;
        let eMin = Infinity, inBand = Infinity, inTop = -Infinity, sw = 0, sh = 0;
        if (list) {
            for (const i of list) {
                const j = (i + 1) % n;
                const len = t.segLen[i];
                if (!(len > 1e-9)) continue;
                const dx = x - t.x[i], dy = y - t.y[i];
                const a = dx * t.tx[i] + dy * t.ty[i];
                const l = -dx * t.ty[i] + dy * t.tx[i];
                const u = clamp01(a / len);
                const along = a - u * len;
                const wall = l > 0
                    ? this.wallR[i] + (this.wallR[j] - this.wallR[i]) * u
                    : this.wallL[i] + (this.wallL[j] - this.wallL[i]) * u;
                const out = Math.max(0, Math.abs(l) - wall);
                const e = Math.sqrt(along * along + out * out);
                if (e > REACH) continue;
                const zc = t.z ? t.z[i] + (t.z[j] - t.z[i]) * u : 0;
                const bk = t.bank ? t.bank[i] + (t.bank[j] - t.bank[i]) * u : 0;
                const h = zc + bk * Math.max(-wall, Math.min(wall, l));
                // Where the band folds over itself (inside a corner tighter than the run-off is
                // deep, a kink the cars cut across) every stretch that claims the point has its
                // say, and the ground goes under the lowest of them.
                if (e < 2) { inBand = Math.min(inBand, h); inTop = Math.max(inTop, h); }
                if (e < eMin) eMin = e;
                const w = 1 / ((e * e + 4) * (e * e + 4));
                sw += w; sh += w * h;
            }
        }
        const dip = DIP * (1 - smoothstep(0, 14, eMin));
        // (and as far again under it as they disagree: the grid cannot follow a fold exactly).
        this.lastInBand = inBand < Infinity;
        if (this.lastInBand) return inBand - dip - (inTop - inBand);
        const near = sw > 0 ? sh / sw : this.base;
        const s = smoothstep(0, BLEND, eMin);
        let far = this.base;
        if (s > 0) {
            // A smooth average of the lap's heights (so a high corner's infield stays high)...
            let fw = 0, fh = 0, near2 = Infinity;
            for (let i = 0; i < n; i += 2) {
                const d2 = (x - t.x[i]) ** 2 + (y - t.y[i]) ** 2;
                const w = 1 / (d2 + 62500);
                fw += w; fh += w * (t.z ? t.z[i] : 0);
                if (d2 < near2) near2 = d2;
            }
            far = fh / fw;
            // ...rolling hills that grow with the distance from the road, and the far ring.
            // (Past REACH no segment reported in: the distance to the nearest sample, less a
            // barrier's worth, stands in, so the hills grow on smoothly instead of starting at once.)
            const d = eMin < Infinity ? eMin : Math.max(REACH, Math.sqrt(near2) - this.wallMax);
            // (scattered mounds, not a wall: most of the ground stays near the average)
            const hills = Math.max(0, fbm(x, y, 800, this.seed) - 0.42) * 3 * this.hills.near * smoothstep(150, 900, d);
            const ring = this.hills.far > 0 ? fbm(x, y, 2600, this.seed + 7) * this.hills.far * smoothstep(3000, 6500, d) : 0;
            far += hills + ring;
        }
        let h = near + (far - near) * s - dip;
        // Fade to one level at the grid's edge, where the outer ring (flat, in the fog) takes over.
        const b = this.bounds;
        const outside = Math.max(b.minX - x, x - b.maxX, b.minY - y, y - b.maxY, 0);
        const k = smoothstep(FAR_PAD * 0.8, FAR_PAD * 0.98, outside);
        return h + (this.base - h) * k;
    }

    /** Ground height (sim units) at a sim point: bilinear over the grid the mesh is built from. */
    heightAt(x, y) {
        const xs = this.xs, ys = this.ys, W = xs.length;
        if (x < xs[0] || x > xs[W - 1] || y < ys[0] || y > ys[ys.length - 1]) return this.edge;
        const c = cellOf(xs, x), r = cellOf(ys, y);
        const fx = (x - xs[c]) / (xs[c + 1] - xs[c]), fy = (y - ys[r]) / (ys[r + 1] - ys[r]);
        const h = this.h;
        const a = h[r * W + c], b = h[r * W + c + 1], d = h[(r + 1) * W + c], e = h[(r + 1) * W + c + 1];
        return (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
    }

    /** Ground height in world units at a sim point. */
    worldHeight(x, y) {
        return this.heightAt(x, y) / WS;
    }

    /** Lowest and highest ground (world units) over a disc of radius `r` sim units. */
    rangeAround(x, y, r) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < 9; k++) {
            const a = k / 8 * Math.PI * 2;
            const h = k === 8 ? this.worldHeight(x, y) : this.worldHeight(x + Math.cos(a) * r, y + Math.sin(a) * r);
            lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
        return { lo, hi };
    }

    /**
     * The ground mesh: the grid plus a flat ring out to `reach` world units, uv = world xz / tile.
     */
    mesh(material, reach, tile) {
        const xs = [this.xs[0] - reach * WS, ...this.xs, this.xs[this.xs.length - 1] + reach * WS];
        const ys = [this.ys[0] - reach * WS, ...this.ys, this.ys[this.ys.length - 1] + reach * WS];
        const W = xs.length, H = ys.length, GW = this.xs.length;
        const pos = new Float32Array(W * H * 3), uv = new Float32Array(W * H * 2);
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < W; c++) {
                const inner = r > 0 && r < H - 1 && c > 0 && c < W - 1;
                const h = inner ? this.h[(r - 1) * GW + (c - 1)] : this.edge;
                const k = r * W + c;
                pos[k * 3] = xs[c] / WS; pos[k * 3 + 1] = h / WS; pos[k * 3 + 2] = ys[r] / WS;
                uv[k * 2] = xs[c] / WS / tile; uv[k * 2 + 1] = ys[r] / WS / tile;
            }
        }
        const idx = new Uint32Array((W - 1) * (H - 1) * 6);
        let q = 0;
        for (let r = 0; r < H - 1; r++) {
            for (let c = 0; c < W - 1; c++) {
                const a = r * W + c, b = a + 1, d = a + W, e = d + 1;
                // Wound so the face normal points up (+y): x right, z down the rows.
                idx[q++] = a; idx[q++] = d; idx[q++] = b;
                idx[q++] = b; idx[q++] = d; idx[q++] = e;
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geom.setIndex(new THREE.BufferAttribute(idx, 1));
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, material);
        mesh.name = 'pocabinet-terrain';
        mesh.receiveShadow = true;
        return mesh;
    }

    /**
     * The fine part of the grid as a half-float texture of world heights, for shaders that
     * place things on the ground (grass.js). rect = (x0, z0, width, depth) in world units,
     * texel-centre aligned: uv = (p - rect.xy) / rect.zw.
     */
    heightTexture() {
        if (this.heightTex) return this.heightTex;
        const f = this.fine, W = this.xs.length;
        const data = new Uint16Array(f.nx * f.ny);
        for (let r = 0; r < f.ny; r++) {
            for (let c = 0; c < f.nx; c++) {
                data[r * f.nx + c] = THREE.DataUtils.toHalfFloat(this.h[(f.y + r) * W + f.x + c] / WS);
            }
        }
        const tex = new THREE.DataTexture(data, f.nx, f.ny, THREE.RedFormat, THREE.HalfFloatType);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        const x0 = this.xs[f.x], y0 = this.ys[f.y];
        this.heightTex = {
            tex,
            rect: new THREE.Vector4((x0 - CELL / 2) / WS, (y0 - CELL / 2) / WS, f.nx * CELL / WS, f.ny * CELL / WS),
        };
        return this.heightTex;
    }

    dispose() {
        this.heightTex?.tex.dispose();
        this.heightTex = null;
    }
}
