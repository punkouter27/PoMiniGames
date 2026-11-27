// pocabinet/trackside.js
//
// The track features on and beside the road that the world now carries (render only; the
// physics reads the same data from track.js and never sees any of this):
//
//   • patches: subtle decals on the tarmac where the grip differs (resurfaced, dusty, bumpy
//     repairs, the joker lane's dirt) and standing water that only shows in the rain
//   • rubber: the racing line (track.line) darkening as rubber goes down (setRubber), and
//     staying drier than the rest of the road in the rain
//   • road dividers (track.islands): a low concrete wall following islandLo/islandHi, its
//     tapered noses in yellow and black chevrons, a JOKER sign on the nose pointing at the
//     short lane and another trackside on the approach
//   • braking boards (3, 2, 1) on the outside before every corner a car has to brake for, and
//     a corner number (T1, T2, …) on the inside at each apex; posts instanced, every board
//     face one merged mesh over one atlas
//
// Heights: everything on the road rides the road's plane (track.z, tilted by track.bank);
// everything beside it stands on the terrain (terrain.js).

import * as THREE from './three.js';
import { GRIP_ACCEL } from './physics.js';
import { asphalt, water, mirrorDecal } from './materials.js';
import { wallFace } from './terrain.js';
import { WORLD_SCALE as WS, roadPlane } from './util.js';
import { gravel, patchMask, repairs, chevrons, boardAtlas, arrowSign, jokerPanel } from './surfaces.js';

/** Samples over which a divider tapers (track.js ISLAND_TAPER). */
const TAPER = 4;
const ISLAND_HEIGHT = 0.75;
/** Corner detection: a stretch the cars cannot take flat (u/s), and a brake worth boards.
 *  BOARD_STEP = 500 sim units = 50.0 m (exact 50 m / 100 m / 150 m FIA braking boards). */
const CORNER_SPEED = 360;
const BRAKE_DROP = 65;
const BOARD_STEP = 500;

/**
 * A band across the road at each sample of [i0, i0 + count]: `cols(k)` gives its lateral
 * columns (sim units), `alpha` the vertex alpha of each column, `ends` fades the first and last
 * rows. uv = (lateral, distance) / tile.
 */
function band(track, i0, count, cols, alpha, height, tile, ends = true) {
    const n = track.count;
    const C = alpha.length;
    const pos = [], uv = [], col = [];
    for (let j = 0; j <= count; j++) {
        const k = (i0 + j) % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const lats = cols(k);
        const v = (track.cum[k] + (i0 + j >= n ? track.length : 0)) / tile;
        const fade = ends ? Math.min(1, j / 2, (count - j) / 2) : 1;
        for (let c = 0; c < C; c++) {
            const lat = lats[c];
            pos.push((track.x[k] + nx * lat) / WS, roadPlane(track, k, lat) / WS + height, (track.y[k] + ny * lat) / WS);
            uv.push(lat / tile, v);
            col.push(1, 1, 1, alpha[c] * fade);
        }
    }
    const idx = [];
    for (let j = 0; j < count; j++) {
        for (let c = 0; c < C - 1; c++) {
            const a0 = j * C + c, a1 = a0 + 1, b0 = a0 + C, b1 = b0 + 1;
            idx.push(a0, a1, b0, a1, b1, b0);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
}

const decal = (extra) => new THREE.MeshStandardMaterial({
    transparent: true, depthWrite: false, vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    roughness: 0.95, metalness: 0, ...extra,
});

export class Trackside {
    /**
     * @param track   runtime track (track.js)
     * @param opts    { theme, terrain, atmosphere, indoor }  (indoor: nothing stands beside the road)
     */
    constructor(track, opts = {}) {
        this.track = track;
        this.terrain = opts.terrain || null;
        this.atmosphere = opts.atmosphere || {};
        this.group = new THREE.Group();
        this.group.name = 'pocabinet-trackside';
        this.puddles = [];
        this.rubber = null;
        this.wet = false;
        this.level = 0;
        const steps = [
            () => this.buildPatches(),
            () => this.buildRubber(),
            () => this.buildIslands(),
        ];
        // Braking boards and corner numbers stand on the ground beside the road: indoors the
        // road is in the air and beside it is somebody's furniture.
        if (!opts.indoor) steps.push(() => this.buildBoards());
        for (const s of steps) {
            try { s(); } catch (e) { console.warn('pocabinet/trackside: part skipped', e); }
        }
        this.setRubber(0, false);
    }

    ground(x, y) {
        return this.terrain ? this.terrain.worldHeight(x, y) : 0;
    }

    // ── Patches ──
    buildPatches() {
        const t = this.track;
        const road = new THREE.Color(this.atmosphere.roadHex || '#393b42');
        const tar = asphalt();
        const mats = {
            resurfaced: () => decal({ color: road.clone().multiplyScalar(0.62), map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.45, 0.45), roughnessMap: tar.roughnessMap, roughness: 0.92 }),
            dusty: () => decal({ color: '#cdb78c', alphaMap: patchMask('dust'), opacity: 0.6, roughness: 1 }),
            bumpy: () => decal({ color: '#ffffff', map: repairs(), roughness: 0.9 }),
            dirt: () => decal({ color: '#9a7650', map: gravel().map, normalMap: gravel().normalMap, alphaMap: patchMask('dirt'), opacity: 0.95, roughness: 1 }),
            puddle: () => mirrorDecal(water(decal({ color: '#10151b', alphaMap: patchMask('puddle'), opacity: 0.85, roughness: 0.1, metalness: 0, envMapIntensity: 1.2 }), 0.06)),
        };
        const tiles = { resurfaced: 45, dusty: 70, bumpy: 50, dirt: 30, puddle: 55 };
        const order = { resurfaced: 1, bumpy: 2, dirt: 2, dusty: 3, puddle: 4 };
        const shared = {};
        for (const p of t.patches) {
            if (!mats[p.kind]) continue;   // 'paint' is the start line, drawn by the scene
            const count = (p.to - p.from + t.count) % t.count;
            if (count < 1) continue;
            const edge = p.kind === 'resurfaced' ? 1.5 : 8;
            const cols = (k) => {
                const hw = t.hw[k] - 0.5;
                const a = Math.max(-hw, p.latFrom), b = Math.min(hw, p.latTo);
                const f = Math.min(edge, Math.max(0, (b - a) / 3));
                return [a, a + f, b - f, b];
            };
            const geom = band(t, p.from, count, cols, [0, 1, 1, 0], 0.024 + order[p.kind] * 0.001, tiles[p.kind], p.kind !== 'resurfaced');
            const mesh = new THREE.Mesh(geom, shared[p.kind] || (shared[p.kind] = mats[p.kind]()));
            mesh.name = `pocabinet-patch-${p.kind}`;
            mesh.renderOrder = order[p.kind];
            mesh.receiveShadow = true;
            if (p.kind === 'puddle') {
                mesh.visible = false;
                this.puddles.push(mesh);
            }
            this.group.add(mesh);
        }
    }

    // ── Rubber on the racing line ──
    buildRubber() {
        const t = this.track;
        const cols = (k) => {
            const hw = t.hw[k] - 2.6, c = Math.max(-hw, Math.min(hw, t.line[k]));
            return [Math.max(-hw, c - 22), Math.max(-hw, c - 11), Math.min(hw, c + 11), Math.min(hw, c + 22)];
        };
        const geom = band(t, 0, t.count, cols, [0, 1, 1, 0], 0.027, 45, false);
        // The undrawn return link (a point-to-point run) gets none.
        if (t.hiddenTo > t.hiddenFrom) {
            const idx = geom.index.array, keep = [];
            for (let q = 0; q < idx.length; q += 6) {
                const row = Math.floor(idx[q] / 4);
                if (t.drawn(row % t.count)) keep.push(...idx.slice(q, q + 6));
            }
            geom.setIndex(keep);
        }
        const mat = decal({ color: '#0d0d0f', roughness: 0.6, opacity: 0, polygonOffsetUnits: -3 });
        this.rubber = new THREE.Mesh(geom, mat);
        this.rubber.name = 'pocabinet-rubber';
        this.rubber.renderOrder = 5;
        this.rubber.receiveShadow = true;
        this.group.add(this.rubber);
    }

    /** Rubber down (0..1) and rain: dark on a dry line, a drier (lighter, matte) one in the wet. */
    setRubber(r, wet) {
        this.level = Math.min(1, Math.max(0, Number(r) || 0));
        this.wet = !!wet;
        const m = this.rubber?.material;
        if (!m) return;
        if (this.wet) {
            m.color.set('#6c6c70');
            m.roughness = 0.92;
            m.opacity = 0.14 + 0.32 * this.level;
        } else {
            m.color.set('#0b0b0e');
            m.roughness = 0.56;
            m.opacity = 0.16 + 0.36 * this.level;
        }
    }

    /** Standing water shows only in the rain. */
    setWet(wet) {
        for (const p of this.puddles) p.visible = !!wet;
    }

    // ── Road dividers ──
    buildIslands() {
        const t = this.track;
        if (!t.islands.length) return;
        const n = t.count;
        const body = new THREE.MeshStandardMaterial({ color: '#8e8c86', roughness: 0.92, metalness: 0 });
        const nose = new THREE.MeshStandardMaterial({ map: chevrons(), roughness: 0.6, metalness: 0 });
        t.islands.forEach((s, k) => {
            const count = (s.to - s.from + n) % n;
            if (count < 2) return;
            // Rows: a pointed tip a little before the first sample and after the last, then the
            // physics' own tapered extent on every sample in between.
            const rows = [];
            const tip = (i, dir) => {
                const mid = (t.islandLo[i] + t.islandHi[i]) / 2;
                return { x: t.x[i] + t.tx[i] * 8 * dir, y: t.y[i] + t.ty[i] * 8 * dir, k: i, lo: mid, hi: mid, along: t.cum[i] + 8 * dir };
            };
            rows.push(tip(s.from, -1));
            for (let j = 0; j < count; j++) {
                const i = (s.from + j) % n;
                rows.push({ x: t.x[i], y: t.y[i], k: i, lo: t.islandLo[i], hi: t.islandHi[i], along: t.cum[i] + (s.from + j >= n ? t.length : 0), j });
            }
            const last = (s.from + count - 1) % n;
            rows.push(tip(last, 1));
            const isNose = (r) => r === 0 || r >= rows.length - 2 || rows[r].j < TAPER - 1 || rows[r].j >= count - TAPER;
            const build = (want) => {
                const pos = [], uv = [], idx = [];
                let v0 = 0;
                for (let r = 0; r < rows.length - 1; r++) {
                    if (isNose(r) !== want) continue;
                    for (const row of [rows[r], rows[r + 1]]) {
                        const nx = -t.ty[row.k], ny = t.tx[row.k];
                        const u = row.along / 30;
                        for (const [lat, up, vv] of [[row.lo, -0.2, 0], [row.lo, ISLAND_HEIGHT, 0.45], [row.hi, ISLAND_HEIGHT, 0.55], [row.hi, -0.2, 1]]) {
                            pos.push((row.x + nx * lat) / WS, roadPlane(t, row.k, lat) / WS + up, (row.y + ny * lat) / WS);
                            uv.push(u, vv);
                        }
                    }
                    for (let c = 0; c < 3; c++) {
                        const a0 = v0 + c, a1 = v0 + c + 1, b0 = v0 + 4 + c, b1 = v0 + 4 + c + 1;
                        idx.push(a0, b0, a1, a1, b0, b1);
                    }
                    v0 += 8;
                }
                if (!idx.length) return null;
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
                g.setIndex(idx);
                g.computeVertexNormals();
                return g;
            };
            for (const [want, mat] of [[false, body], [true, nose]]) {
                const g = build(want);
                if (!g) continue;
                const m = new THREE.Mesh(g, mat);
                m.material.side = THREE.DoubleSide;
                m.castShadow = true;
                m.receiveShadow = true;
                m.name = `pocabinet-divider-${k}`;
                this.group.add(m);
            }
            this.jokerSigns(s, count);
        });
    }

    /** JOKER on the divider's nose (arrow at the short lane) and on a board on the approach. */
    jokerSigns(s, count) {
        const t = this.track, n = t.count;
        const dir = s.shortSide > 0 ? 1 : -1;
        // On the nose, where the divider reaches full width.
        const i = (s.from + Math.min(count - 1, TAPER + 1)) % n;
        const width = Math.min(2.2, (t.islandHi[i] - t.islandLo[i]) / WS * 0.9);
        const mid = (t.islandLo[i] + t.islandHi[i]) / 2;
        const nx = -t.ty[i], ny = t.tx[i];
        const base = roadPlane(t, i, mid) / WS + ISLAND_HEIGHT;
        const g = new THREE.Group();
        g.position.set((t.x[i] + nx * mid) / WS, base, (t.y[i] + ny * mid) / WS);
        // Local +Z toward the oncoming traffic: local +X is then the driver's right.
        g.rotation.y = Math.atan2(-t.tx[i], -t.ty[i]);
        const h = width * 200 / 256;
        const face = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshBasicMaterial({ map: jokerPanel(dir), color: '#e6e6e6' }));
        face.position.y = 0.55 + h / 2;
        g.add(face);
        const back = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.7 }));
        back.position.set(0, 0.55 + h / 2, -0.02);
        back.rotation.y = Math.PI;
        g.add(back);
        const postMat = new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.5, metalness: 0.6 });
        for (const x of [-width * 0.35, width * 0.35]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6), postMat);
            post.position.set(x, 0.3, -0.03);
            g.add(post);
        }
        this.group.add(g);

        // On the approach, beyond the barrier on the short side.
        const at = t.cum[s.from] - 170;
        const k = t.indexAt(at);
        const lat = dir * (wallFace(t, k, dir) + 10);
        const p = t.pointAt(at);
        const x = p.x - p.ty * lat, y = p.y + p.tx * lat;
        if (!this.clear(x, y, 6)) return;
        const b = new THREE.Group();
        b.position.set(x / WS, this.ground(x, y), y / WS);
        b.rotation.y = Math.atan2(-p.tx + dir * p.ty * 0.3, -p.ty - dir * p.tx * 0.3);
        const bw = 4.2, bh = bw * 160 / 512;
        const board = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), new THREE.MeshBasicMaterial({ map: arrowSign('JOKER LAP', dir), color: '#e6e6e6' }));
        board.position.y = 2.3 + bh / 2;
        b.add(board);
        const bb = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.15, bh + 0.15, 0.08), postMat);
        bb.position.set(0, 2.3 + bh / 2, -0.06);
        b.add(bb);
        for (const px of [-bw * 0.38, bw * 0.38]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3, 0.14), postMat);
            post.position.set(px, 1.0, -0.08);
            b.add(post);
        }
        this.group.add(b);
    }

    /** Clear of every stretch of road and run-off by `margin` (sim units). */
    clear(x, y, margin) {
        const t = this.track;
        const p = t.project(x, y, -1);
        const side = p.lateral > 0 ? 1 : -1;
        return Math.abs(p.lateral) > wallFace(t, p.index, side) + margin;
    }

    // ── Braking boards and corner numbers ──
    buildBoards() {
        const t = this.track;
        const corners = findCorners(t);
        if (!corners.length) return;
        const items = [];   // { x, y, face: {x, y}, label, size, height }
        corners.forEach((c, num) => {
            const label = `T${num + 1}`;
            // Corner number on the inside at the apex.
            const ap = c.apex;
            const lat = c.dir * (wallFace(t, ap, c.dir) + 9);
            const x = t.x[ap] - t.ty[ap] * lat, y = t.y[ap] + t.tx[ap] * lat;
            if (this.clear(x, y, 4)) items.push({ x, y, fx: -t.tx[ap] + c.dir * t.ty[ap] * 0.6, fy: -t.ty[ap] - c.dir * t.tx[ap] * 0.6, label, size: 1.3, height: 1.7 });
            if (!c.brake) return;
            // 150m, 100m, 50m braking distance boards on the outside before every braking zone.
            for (let m = 1; m <= 3; m++) {
                const at = t.cum[c.start] - m * BOARD_STEP;
                const k = t.indexAt(at);
                const p = t.pointAt(at);
                const blat = -c.dir * (wallFace(t, k, -c.dir) + 7);
                const bx = p.x - p.ty * blat, by = p.y + p.tx * blat;
                if (!this.clear(bx, by, 3)) continue;
                items.push({ x: bx, y: by, fx: -p.tx - c.dir * p.ty * 0.25, fy: -p.ty + c.dir * p.tx * 0.25, label: `${m * 50}`, size: 1.15, height: 1.3 });
            }
        });
        if (!items.length) return;
        const labels = [...new Set(items.map(it => it.label))];
        const atlas = boardAtlas(labels, (l) => l.startsWith('T')
            ? { bg: '#173a8a', fg: '#ffffff', border: '#e8e8e8' }
            : { bg: '#f4f4f4', fg: '#111111', border: '#c8102e' });
        const front = [], fuv = [], back = [], frontIdx = [], backIdx = [];
        const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.06, 1, 6), new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.5, metalness: 0.6 }), items.length);
        const dummy = new THREE.Object3D();
        items.forEach((it, i) => {
            const gy = this.ground(it.x, it.y);
            const len = Math.hypot(it.fx, it.fy) || 1;
            const fx = it.fx / len, fz = it.fy / len;     // toward the oncoming traffic
            const rx = fz, rz = -fx;                       // the board's right as seen from the front
            const cx = it.x / WS, cz = it.y / WS;
            const y0 = gy + it.height, y1 = y0 + it.size, hs = it.size / 2;
            const quad = [[-hs, y0], [hs, y0], [-hs, y1], [hs, y1]].map(([s, y]) => [cx + rx * s, y, cz + rz * s]);
            const r = atlas.rects[labels.indexOf(it.label)];
            const base = front.length / 3;
            for (const q of quad) front.push(q[0] + fx * 0.03, q[1], q[2] + fz * 0.03);
            fuv.push(r.u0, r.v0, r.u1, r.v0, r.u0, r.v1, r.u1, r.v1);
            frontIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
            const bb = back.length / 3;
            for (const q of quad) back.push(q[0], q[1], q[2]);
            backIdx.push(bb, bb + 2, bb + 1, bb + 1, bb + 2, bb + 3);
            dummy.position.set(cx - fx * 0.02, (gy - 0.2 + y1) / 2, cz - fz * 0.02);
            dummy.scale.set(1, y1 - gy + 0.2, 1);
            dummy.updateMatrix();
            posts.setMatrixAt(i, dummy.matrix);
        });
        const mk = (pos, idx, uv) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            g.setIndex(idx);
            g.computeVertexNormals();
            return g;
        };
        const faces = new THREE.Mesh(mk(front, frontIdx, fuv), new THREE.MeshBasicMaterial({ map: atlas.tex, color: '#dcdcdc' }));
        faces.name = 'pocabinet-boards';
        const backs = new THREE.Mesh(mk(back, backIdx), new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.7 }));
        posts.instanceMatrix.needsUpdate = true;
        posts.frustumCulled = false;
        posts.castShadow = true;
        backs.castShadow = true;
        this.group.add(faces, backs, posts);
        this.corners = corners;
    }

    dispose() {
        this.puddles = [];
        this.rubber = null;
    }
}

/**
 * The lap's corners: runs of samples a car cannot take flat out (the overlay's corner speed,
 * GRIP_ACCEL · 0.9 / curvature, a few samples ahead), each with its apex (slowest sample),
 * direction (+1 right-hander) and whether the straight before it is fast enough that a car
 * has to brake for it.
 */
function findCorners(track) {
    const n = track.count;
    const cap = 1 / track.halfWidth;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let kappa = 0;
        for (let j = 0; j < 5; j++) kappa = Math.max(kappa, track.curv[(i + j) % n]);
        v[i] = Math.sqrt(GRIP_ACCEL * 0.9 / Math.max(Math.min(kappa, cap), 1e-5));
    }
    let s0 = -1;
    for (let i = 0; i < n; i++) if (v[i] >= CORNER_SPEED) { s0 = i; break; }
    if (s0 < 0) return [];
    // Signed turn per sample (+ = heading increasing = a right-hander), smoothed over three.
    const raw = new Float64Array(n), turnAt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        raw[i] = track.tx[p] * track.ty[i] - track.ty[p] * track.tx[i];
    }
    for (let i = 0; i < n; i++) turnAt[i] = (raw[(i - 1 + n) % n] + raw[i] + raw[(i + 1) % n]) / 3;
    const runs = [];
    let cur = null;
    for (let q = 0; q < n; q++) {
        const i = (s0 + q) % n;
        if (!track.drawn(i)) { cur = null; continue; }
        if (v[i] < CORNER_SPEED) {
            // A chicane is two corners: a run splits where the turn changes hands.
            const sign = Math.abs(turnAt[i]) > 0.012 ? Math.sign(turnAt[i]) : 0;
            const flip = cur && sign !== 0 && cur.sign !== 0 && sign !== cur.sign;
            if (cur && q - cur.lastQ <= 3 && !flip) { cur.lastQ = q; cur.end = i; if (!cur.sign) cur.sign = sign; }
            else { cur = { startQ: q, lastQ: q, start: i, end: i, sign }; runs.push(cur); }
        }
    }
    const out = [];
    for (const r of runs) {
        let apex = r.start, turn = 0;
        const len = r.lastQ - r.startQ + 1;
        // The apex is the tightest point of the run (raw curvature, not the look-ahead).
        for (let q = 0; q < len; q++) {
            const i = (r.start + q) % n;
            turn += raw[i];
            if (track.curv[i] > track.curv[apex]) apex = i;
        }
        if (Math.abs(turn) < 0.12) continue;   // a wiggle, not a corner
        let approach = 0;
        for (let d = 30; d <= 260; d += 10) {
            const i = track.indexAt(track.cum[r.start] - d);
            approach = Math.max(approach, v[i]);
        }
        out.push({ start: r.start, apex, dir: turn > 0 ? 1 : -1, brake: Math.min(140, approach) - v[apex] > BRAKE_DROP, along: track.cum[apex], end: r.end });
    }
    out.sort((a, b) => a.along - b.along);
    // Boards need a straight to stand on: none where the corner follows hard on the last one.
    out.forEach((c, k) => {
        const prev = out[(k - 1 + out.length) % out.length];
        const gap = ((track.cum[c.start] - track.cum[prev.end]) % track.length + track.length) % track.length;
        if (out.length > 1 && gap < BOARD_STEP * 3 + 30) c.brake = false;
    });
    return out;
}
