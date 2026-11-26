// pocabinet/scenery.js
//
// Everything trackside that is not the road: apex kerbs, the start-light gantry,
// street lamps, each zone's
// landmarks and planting, satirical billboards, and a press pen of
// photographers whose flashbulbs race.js fires on a personal-best lap or a
// photo finish (and whenever something fast goes by).
//
// The grandstand holds a crowd that jumps when race.js excites it
// (a pass by, an overtake, a PB, the finish); `crowd.center` is where audio.js
// puts its murmur and cheers.
//
// Deterministic: placement uses an RNG seeded by the track id, so every player
// sees the same island of props. Everything is placed outside the barrier line
// (checked against the full centerline, at each sample's own width and run-off depth), so
// nothing sits where physics runs, and off the scan (track.inScan): the court is its own
// scenery. What a stretch of the lap is dressed as (landmark, planting, billboards) is its
// zone (track.zoneAt: capitol, senate, court, maralago); everything stands on the terrain
// (terrain.js heightAt), the kerbs on the road's plane.
//
// Built once per SceneHandle.setTrack and added to the track group, so the
// group's traversal disposes geometry and materials; textures are cached per
// module (a handful of small canvases) and live for the page.

import * as THREE from './three.js';
import { KERB_INNER, KERB_OUTER } from './physics.js';
import { raised } from './kerbs.js';
import { wind, water, flutter } from './materials.js';
import { themeOf, wallFace } from './terrain.js';
import { WORLD_SCALE as WS, fnv1a, roadPlane, canvasTexture } from './util.js';

/** A raised kerb's hump starts this far past the edge line (sim units); the flat band stops there. */
const SAUSAGE_FROM = 2;

// ── Small helpers ────────────────────────────────────────────────────────────

function seededRng(text) {
    let s = fnv1a(text);
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const lam = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...(extra || {}) });
/** HDR colour: > 1 so the post pass blooms it. */
const hdr = (color, k) => new THREE.Color(color).multiplyScalar(k);

/** Sim point at `dist` along the loop, `lat` to the right; plus the tangent. */
function simAt(track, dist, lat) {
    const p = track.pointAt(dist);
    return { x: p.x + -p.ty * lat, y: p.y + p.tx * lat, tx: p.tx, ty: p.ty };
}

/** Clear of the road and run-off by at least `margin` sim units, anywhere on the loop. */
function clearOfTrack(track, x, y, margin) {
    const proj = track.project(x, y, -1);
    return Math.abs(proj.lateral) > wallFace(track, proj.index, proj.lateral > 0 ? 1 : -1) + margin;
}

/** The barrier's face at a distance along the loop on `side` (sim units from the centerline). */
function wallAtDist(track, dist, side) {
    return wallFace(track, track.indexAt(dist), side);
}

/** rotation.y that turns an object's local +Z toward world direction (dx, dz). */
const yawTo = (dx, dz) => Math.atan2(dx, dz);

let glowTex = null;
function glowTexture() {
    return glowTex || (glowTex = canvasTexture(64, 64, (g) => {
        const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 64, 64);
    }));
}

const textTextures = new Map();
function textTexture(text, bg, fg, w = 512, h = 128) {
    const key = `${text}|${bg}|${fg}|${w}x${h}`;
    if (textTextures.has(key)) return textTextures.get(key);
    const tex = canvasTexture(w, h, (g) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);
        g.strokeStyle = fg;
        g.globalAlpha = 0.5;
        g.lineWidth = 6;
        g.strokeRect(8, 8, w - 16, h - 16);
        g.globalAlpha = 1;
        let size = Math.floor(h * 0.5);
        g.font = `800 ${size}px system-ui, sans-serif`;
        while (size > 12 && g.measureText(text).width > w - 48) {
            size -= 2;
            g.font = `800 ${size}px system-ui, sans-serif`;
        }
        g.fillStyle = fg;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(text, w / 2, h / 2 + 2);
    }, { anisotropy: 4 });
    textTextures.set(key, tex);
    return tex;
}

let flagTex = null;
function flagTexture() {
    return flagTex || (flagTex = canvasTexture(190, 100, (g) => {
        for (let i = 0; i < 13; i++) {
            g.fillStyle = i % 2 ? '#f4f4f4' : '#b22234';
            g.fillRect(0, i * 100 / 13, 190, 100 / 13 + 1);
        }
        g.fillStyle = '#3c3b6e';
        g.fillRect(0, 0, 76, 54);
        g.fillStyle = '#ffffff';
        for (let r = 0; r < 5; r++) for (let k = 0; k < 6; k++) g.fillRect(6 + k * 12, 6 + r * 10, 3, 3);
    }));
}

const BILLBOARDS = {
    capitol: ['SPEED LIMIT: VETOED', 'BREAKING: LAP RECORD', 'NO OVERTAKING WITHOUT A QUORUM', 'PIT STOP OF THE UNION', 'ALTERNATIVE LAP TIMES'],
    maralago: ['MEMBERS ONLY', 'GOLF CARTS YIELD', 'RESORT SPEED LIMIT: NEGOTIABLE', 'VALET PARKING ONLY'],
    senate: ['CLOTURE AHEAD', 'FILIBUSTER HILL', 'NO AMENDMENTS PAST THIS POINT', 'MAJORITY LEADER PARKING'],
    court: ['HOME COURT ADVANTAGE', 'TRAVELING IS ENCOURAGED', 'SHOT CLOCK: ONE LAP', 'NO DUNKING FROM THE PIT LANE'],
};

// ── The scenery handle ───────────────────────────────────────────────────────

export class Scenery {
    constructor(track, world) {
        this.track = track;
        this.trackId = track.id;
        this.theme = world.theme || themeOf(track);
        this.terrain = world.terrain || null;
        this.atmosphere = world.atmosphere || {};
        this.group = new THREE.Group();
        this.group.name = 'pocabinet-scenery';
        this.rng = seededRng(`pocabinet:${track.id}`);
        this.flashes = [];       // photographers
        this.blinkers = [];      // aviation lights
        this.onFlash = null;
        this.time = 0;
        this.exclusions = [];    // { x, y, r } sim — landmark footprints
        this.crowd = null;       // { center, level, fans } — see buildGrandstand

        const accent = new THREE.Color(this.atmosphere.accentHex || '#c6a35a');
        this.accent = accent;

        this.buildKerbs(world.kerbs);
        this.buildGantry();
        this.buildLandmarks();
        this.buildLamps();
        this.buildPlanting();
        this.buildBillboards();
        this.buildPressPen();
        this.buildGrandstand();
        this.group.traverse(o => {
            if (!o.isMesh || o.userData.noShadow) return;
            const m = o.material;
            if (m && (m.isMeshBasicMaterial || m.blending === THREE.AdditiveBlending)) return;
            o.castShadow = true;
            o.receiveShadow = true;
        });
    }

    // ── Kerbs ──
    buildKerbs(kerbs) {
        if (!kerbs) return;
        const t = this.track;
        const n = t.count;
        const pos = [], col = [];
        const red = new THREE.Color('#d42a2a'), white = new THREE.Color('#f0f0f0');
        // [x, z, y]: y is the road's plane (height and bank) at that lateral.
        const edge = (i, lat) => {
            const k = i % n;
            return [(t.x[k] + -t.ty[k] * lat) / WS, (t.y[k] + t.tx[k] * lat) / WS, 0.045 + roadPlane(t, k, lat) / WS];
        };
        const humps = [];
        for (let i = 0; i < n; i++) {
            const s = kerbs[i];
            if (!s || kerbs[(i + 1) % n] !== s) continue;
            const j = (i + 1) % n;
            // A raised ("sausage") kerb: the flat red and white band stops at the edge line and the
            // hump takes the rest of the band (buildSausages).
            const hump = raised(t, i);
            if (hump) humps.push(i);
            const inLat = (k) => s * (t.hw[k] - KERB_INNER), outLat = (k) => s * (t.hw[k] + (hump ? SAUSAGE_FROM : KERB_OUTER));
            const a0 = edge(i, inLat(i)), a1 = edge(i, outLat(i)), b0 = edge(j, inLat(j)), b1 = edge(j, outLat(j));
            for (let h = 0; h < 2; h++) {
                const f0 = h / 2, f1 = (h + 1) / 2;
                const lerp = (p, q, f) => p.map((v, j) => v + (q[j] - v) * f);
                const p0 = lerp(a0, b0, f0), p1 = lerp(a1, b1, f0), q0 = lerp(a0, b0, f1), q1 = lerp(a1, b1, f1);
                pos.push(p0[0], p0[2], p0[1], p1[0], p1[2], p1[1], q0[0], q0[2], q0[1]);
                pos.push(p1[0], p1[2], p1[1], q1[0], q1[2], q1[1], q0[0], q0[2], q0[1]);
                const c = (i * 2 + h) % 2 ? white : red;
                for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
            }
        }
        if (!pos.length) return;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, lam(0xffffff, {
            vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
        }));
        mesh.name = 'pocabinet-kerbs';
        mesh.userData.noShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        if (humps.length) this.buildSausages(humps, kerbs);
    }

    /**
     * Raised kerbs: a yellow and black hump from just outside the edge line to the outer edge
     * of the kerb band (where physics.js scrubs speed and throws the car out), built on the
     * road's plane. One mesh, vertex colours, faceted on purpose so the hump reads.
     */
    buildSausages(list, kerbs) {
        const t = this.track, n = t.count;
        // Cross-section: fraction across the hump, height (world units).
        const profile = [[0, 0], [0.12, 0.09], [0.3, 0.15], [0.7, 0.15], [0.88, 0.09], [1, 0]];
        const yellow = new THREE.Color('#f2c21b'), black = new THREE.Color('#1a1a1a');
        const pos = [], col = [];
        const at = (k, s, f, up) => {
            const lat = s * (t.hw[k] + SAUSAGE_FROM + (KERB_OUTER - SAUSAGE_FROM) * f);
            return [(t.x[k] - t.ty[k] * lat) / WS, roadPlane(t, k, lat) / WS + 0.04 + up, (t.y[k] + t.tx[k] * lat) / WS];
        };
        for (const i of list) {
            const s = Math.sign(kerbs[i]);
            const j = (i + 1) % n;
            for (let h = 0; h < 2; h++) {
                const f0 = h / 2, f1 = (h + 1) / 2;
                const c = (i * 2 + h) % 2 ? black : yellow;
                for (let p = 0; p < profile.length - 1; p++) {
                    const quad = [];
                    const A = (pf) => {
                        const a = at(i, s, profile[pf][0], profile[pf][1]), b = at(j, s, profile[pf][0], profile[pf][1]);
                        return [a.map((v, q) => v + (b[q] - v) * f0), a.map((v, q) => v + (b[q] - v) * f1)];
                    };
                    const [p0, q0] = A(p), [p1, q1] = A(p + 1);
                    quad.push(p0, p1, q0, p1, q1, q0);
                    // Wound so the outside faces up on either side of the road.
                    const tri = s > 0 ? quad : [p1, p0, q0, q1, p1, q0];
                    for (const v of tri) pos.push(v[0], v[1], v[2]);
                    const shade = 0.85 + 0.15 * Math.sin(Math.PI * (p + 0.5) / (profile.length - 1));
                    for (let v = 0; v < 6; v++) col.push(c.r * shade, c.g * shade, c.b * shade);
                }
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, lam(0xffffff, { vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
        mesh.name = 'pocabinet-sausages';
        mesh.userData.noShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
    }

    /** Ground height (world units) under a sim point: the terrain's, or 0 without one. */
    gy(x, y) {
        return this.terrain ? this.terrain.worldHeight(x, y) : 0;
    }

    // ── Start gantry: five pods, red one by one, then all green ──
    buildGantry() {
        const t = this.track;
        const p = simAt(t, 20, 0);
        const g = new THREE.Group();
        g.name = 'pocabinet-gantry';
        const y0 = t.heightAt(20) / WS;
        g.position.set(p.x / WS, y0, p.y / WS);
        g.rotation.y = yawTo(p.tx, p.ty);
        const steel = lam('#2b2f38', { roughness: 0.45, metalness: 0.6 });
        // Posts stand just outside the barrier, so no car can ever drive through one, each down
        // to the ground where it stands (the road may be banked, the ground may fall away).
        const half = Math.max(wallAtDist(t, 20, -1), wallAtDist(t, 20, 1)) + 4;
        const span = half * 2 / WS;
        for (const s of [-1, 1]) {
            // Local +X is the driver's left once the gantry faces down the straight.
            const q = simAt(t, 20, -s * half);
            const foot = this.terrain
                ? Math.min(this.gy(q.x, q.y), y0 + roadPlane(t, t.indexAt(20), -s * half) / WS - t.heightAt(20) / WS) - y0 - 0.3
                : 0;
            const len = 5 - foot;
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, len, 0.35), steel);
            post.position.set(s * span / 2, foot + len / 2, 0);
            g.add(post);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.4, 0.55, 0.5), steel);
        beam.position.y = 4.75;
        g.add(beam);
        const band = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(span * 0.5, 8), 0.4),
            new THREE.MeshBasicMaterial({ map: textTexture('CABINET GRAND PRIX', '#101010', '#ffffff', 512, 64) }));
        band.position.set(0, 4.75, -0.26);
        band.rotation.y = Math.PI;
        g.add(band);

        const podGeom = new THREE.BoxGeometry(0.7, 1.3, 0.35);
        const lampGeom = new THREE.CircleGeometry(0.2, 16);
        const glowMatBase = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
        this.startLamps = [];
        for (let i = 0; i < 5; i++) {
            // Local +X is the driver's left once the gantry faces down the straight,
            // so pod 0 (first to light) sits at +2: they fill left to right.
            const x = (2 - i) * 1.0;
            const pod = new THREE.Mesh(podGeom, steel);
            pod.position.set(x, 3.8, 0);
            g.add(pod);
            const row = [];
            for (const dy of [0.3, -0.3]) {
                const mat = new THREE.MeshBasicMaterial({ color: '#1a0606' });
                const lamp = new THREE.Mesh(lampGeom, mat);
                lamp.position.set(x, 3.8 + dy, -0.18);
                lamp.rotation.y = Math.PI;
                g.add(lamp);
                const glow = new THREE.Sprite(glowMatBase.clone());
                glow.material.opacity = 0;
                glow.scale.set(1.5, 1.5, 1);
                glow.position.set(x, 3.8 + dy, -0.3);
                g.add(glow);
                row.push({ mat, glow });
            }
            this.startLamps.push(row);
        }
        glowMatBase.dispose();
        this.group.add(g);
        this.setStartLights(0, false);
    }

    /** lit = pods showing red (0..5); go = all green. */
    setStartLights(lit, go) {
        if (!this.startLamps) return;
        this.startLamps.forEach((row, i) => {
            const on = go || i < lit;
            const color = go ? '#22ff66' : '#ff1c1c';
            row.forEach(({ mat, glow }, k) => {
                const show = on && (go ? k === 1 : k === 0);
                mat.color.copy(show ? hdr(color, 7) : new THREE.Color('#1a0606'));
                glow.material.opacity = show ? 0.9 : 0;
                if (show) glow.material.color.copy(hdr(color, 2.5));
            });
        });
    }

    // ── Street lamps ──
    buildLamps() {
        const t = this.track;
        const count = Math.max(8, Math.round(t.length / 150));
        const armLen = 2.6;
        const postGeom = new THREE.CylinderGeometry(0.11, 0.17, 9, 6);
        postGeom.translate(0, 4.5, 0);
        const armGeom = new THREE.BoxGeometry(0.12, 0.12, armLen);
        const headGeom = new THREE.BoxGeometry(0.48, 0.18, 0.95);
        const posts = new THREE.InstancedMesh(postGeom, lam('#3a3d44', { roughness: 0.5, metalness: 0.7 }), count);
        const arms = new THREE.InstancedMesh(armGeom, lam('#3a3d44', { roughness: 0.5, metalness: 0.7 }), count);
        const heads = new THREE.InstancedMesh(headGeom, lam('#8f8a78'), count);
        const dummy = new THREE.Object3D();
        let used = 0;
        for (let i = 0; i < count; i++) {
            const s = i % 2 ? 1 : -1;
            const d = (i + 0.5) * t.length / count;
            const base = simAt(t, d, s * (wallAtDist(t, d, s) + 8));
            if (!clearOfTrack(t, base.x, base.y, 4) || this.excluded(base.x, base.y)) continue;
            const inward = { x: s * t.pointAt(d).ty, z: -s * t.pointAt(d).tx };   // toward the road
            const bx = base.x / WS, bz = base.y / WS;
            const y = this.gy(base.x, base.y);
            dummy.position.set(bx, y - 0.2, bz);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            posts.setMatrixAt(used, dummy.matrix);
            dummy.position.set(bx + inward.x * armLen / 2, y + 8.7, bz + inward.z * armLen / 2);
            dummy.rotation.set(0, yawTo(inward.x, inward.z), 0);
            dummy.updateMatrix();
            arms.setMatrixAt(used, dummy.matrix);
            const hx = bx + inward.x * armLen, hz = bz + inward.z * armLen;
            dummy.position.set(hx, y + 8.62, hz);
            dummy.updateMatrix();
            heads.setMatrixAt(used, dummy.matrix);
            used++;
        }
        for (const m of [posts, arms, heads]) {
            m.count = used;
            m.instanceMatrix.needsUpdate = true;
            m.frustumCulled = false;
            this.group.add(m);
        }
    }

    /** On a landmark's footprint, or on the scan (and a little round it). */
    excluded(x, y) {
        return this.track.inScan(x, y, 20) || this.exclusions.some(e => (x - e.x) ** 2 + (y - e.y) ** 2 < e.r * e.r);
    }

    // ── Landmarks ──
    /**
     * A clear spot for a landmark: beside the road at `dist` along the lap on `side` (+1 right),
     * stepped outward from `push` past the barrier until a footprint of `clear` sim units is off
     * every stretch of road and off the scan. Returns { x, y, face } (face: toward the road).
     */
    landmarkSpot(dist, side, push, clear = 200) {
        const t = this.track;
        const wall = wallAtDist(t, dist, side);
        const road = simAt(t, dist, 0);
        let out = simAt(t, dist, side * (wall + push));
        for (let k = 0; k < 16 && (!clearOfTrack(t, out.x, out.y, clear) || t.inScan(out.x, out.y, clear)); k++) {
            push += 60;
            out = simAt(t, dist, side * (wall + push));
        }
        return { x: out.x, y: out.y, face: { x: road.x - out.x, y: road.y - out.y } };
    }

    /** Distance along the lap of the middle of the first run of samples dressed as `zone` (0 if none). */
    zoneMiddle(zone) {
        const t = this.track, n = t.count;
        let from = -1, len = 0;
        for (let i = 0; i < n; i++) {
            if (t.zoneAt(i) !== zone || t.zoneAt((i - 1 + n) % n) === zone) continue;
            from = i;
            while (len < n && t.zoneAt((i + len) % n) === zone) len++;
            break;
        }
        return from < 0 ? 0 : t.cum[(from + (len >> 1)) % n];
    }

    /**
     * One landmark per zone, each on open ground beside its stretch of the lap: the Capitol's
     * dome and the briefing-room wall outside the stadium straight (the wall behind the
     * grandstand), the obelisk and its pool inside it; the temple on the crest of Senate Hill;
     * the mansion outside the beach road and the golf greens inside it.
     */
    buildLandmarks() {
        const t = this.track;
        let sx = 0, sy = 0, crest = 0;
        for (let i = 0; i < t.count; i++) {
            sx += t.x[i]; sy += t.y[i];
            if (t.z && t.z[i] > t.z[crest]) crest = i;
        }
        const centroid = { x: sx / t.count, y: sy / t.count };
        // Which side of the road at `dist` faces away from the middle of the circuit.
        const outside = (dist) => {
            const p = t.pointAt(dist);
            return (centroid.x - p.x) * -p.ty + (centroid.y - p.y) * p.tx > 0 ? -1 : 1;
        };
        const L = t.length;

        const dome = this.landmarkSpot(L * 0.08, outside(L * 0.08), 330);
        this.landmarkOut = dome;
        this.buildCapitol(dome, dome.face);
        const wall = this.landmarkSpot(L - 420, outside(L - 420), 260, 300);
        this.buildBriefingRoom(wall, wall.face);
        const obelisk = simAt(t, L - 260, -outside(L - 260) * (wallAtDist(t, L - 260, -outside(L - 260)) + 150));
        this.buildMonument(obelisk);

        const hill = this.landmarkSpot(t.cum[crest], outside(t.cum[crest]), 300);
        this.buildTemple(hill, hill.face);

        const beach = this.zoneMiddle('maralago');
        const mansion = this.landmarkSpot(beach, outside(beach), 330);
        this.buildMansion(mansion, mansion.face);
        this.buildGolf(simAt(t, beach, -outside(beach) * (wallAtDist(t, beach, -outside(beach)) + 380)));
    }

    /**
     * Stand a landmark on the ground: at the highest point under its footprint (`r` sim
     * units), on a terrace of `stone` that runs down into the slope, so no corner floats.
     */
    placeGroup(g, at, face, r = 0, terrace = null) {
        let y = 0;
        if (this.terrain && r > 0) {
            const range = this.terrain.rangeAround(at.x, at.y, r);
            y = range.hi;
            if (terrace && range.hi - range.lo > 0.05) {
                const depth = range.hi - range.lo + 1;
                const base = new THREE.Mesh(new THREE.BoxGeometry(terrace.w, depth, terrace.d), terrace.mat);
                base.position.y = -depth / 2 + 0.02;
                g.add(base);
            }
        } else if (this.terrain) {
            y = this.gy(at.x, at.y);
        }
        g.position.set(at.x / WS, y, at.y / WS);
        g.rotation.y = yawTo(face.x, face.y);
        this.group.add(g);
    }

    buildCapitol(at, face) {
        const g = new THREE.Group();
        g.name = 'pocabinet-capitol';
        const marble = lam('#e8e3d4');
        const shade = lam('#cfc8b6');
        const add = (geom, mat, x, y, z) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); g.add(m); return m; };
        add(new THREE.BoxGeometry(16, 7, 10), marble, 0, 3.5, 0);
        for (const s of [-1, 1]) {
            add(new THREE.BoxGeometry(11, 5.5, 8), marble, s * 13.5, 2.75, 0);
            add(new THREE.BoxGeometry(11.4, 0.5, 8.4), shade, s * 13.5, 5.75, 0);
        }
        add(new THREE.BoxGeometry(8, 1.2, 2.4), shade, 0, 6.6, 5.6);
        const colGeom = new THREE.CylinderGeometry(0.26, 0.3, 6, 8);
        const cols = new THREE.InstancedMesh(colGeom, marble, 8 + 20);
        const dummy = new THREE.Object3D();
        let k = 0;
        for (let i = 0; i < 8; i++) {
            dummy.position.set(-3.5 + i, 3, 6.4);
            dummy.updateMatrix();
            cols.setMatrixAt(k++, dummy.matrix);
        }
        for (let i = 0; i < 20; i++) {
            const a = i / 20 * Math.PI * 2;
            dummy.position.set(Math.cos(a) * 4.9, 8.9, Math.sin(a) * 4.9);
            dummy.scale.set(0.8, 0.6, 0.8);
            dummy.updateMatrix();
            cols.setMatrixAt(k++, dummy.matrix);
        }
        cols.instanceMatrix.needsUpdate = true;
        cols.frustumCulled = false;
        g.add(cols);
        add(new THREE.CylinderGeometry(4.3, 4.7, 4, 20), marble, 0, 9, 0);
        add(new THREE.CylinderGeometry(5.2, 5.2, 0.4, 20), shade, 0, 11, 0);
        const dome = add(new THREE.SphereGeometry(4.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), marble, 0, 11.2, 0);
        dome.scale.y = 1.3;
        add(new THREE.CylinderGeometry(0.8, 0.9, 1.8, 10), marble, 0, 17.8, 0);
        add(new THREE.ConeGeometry(0.4, 1.4, 8), shade, 0, 19.4, 0);
        this.placeGroup(g, at, face, 200, { w: 44, d: 18, mat: shade });
        this.exclusions.push({ x: at.x, y: at.y, r: 260 });
    }

    buildMonument(c) {
        const t = this.track;
        if (!clearOfTrack(t, c.x, c.y, 30)) return;
        const g = new THREE.Group();
        g.name = 'pocabinet-monument';
        // (c: a point on the infield lawn; skipped if a stretch of road is too near)
        const stone = lam('#ece6d8');
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.15, 26, 4, 1), stone);
        shaft.rotation.y = Math.PI / 4;
        shaft.position.y = 13;
        g.add(shaft);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.78, 1.9, 4), stone);
        cap.rotation.y = Math.PI / 4;
        cap.position.y = 26.95;
        g.add(cap);
        const blink = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: hdr('#ff2a2a', 5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
        blink.position.y = 26.4;
        blink.scale.set(2, 2, 1);
        g.add(blink);
        this.blinkers.push(blink);
        g.position.set(c.x / WS, (this.terrain ? this.terrain.rangeAround(c.x, c.y, 12).lo : 0) - 0.1, c.y / WS);
        this.group.add(g);

        // Reflecting pool alongside, if the infield has room for it.
        const start = t.pointAt(0);
        const ax = start.tx, ay = start.ty;
        const px = c.x + ax * 170, py = c.y + ay * 170;
        const ends = [[px - ax * 140, py - ay * 140], [px + ax * 140, py + ay * 140]];
        // (and only on level ground: water does not lie on a slope)
        const level = !this.terrain || [[px, py], ...ends].every(([x, y]) => Math.abs(this.gy(x, y) - this.gy(px, py)) < 0.12);
        if (level && ends.every(([x, y]) => clearOfTrack(t, x, y, 25)) && clearOfTrack(t, px, py, 25)) {
            const pool = new THREE.Mesh(new THREE.PlaneGeometry(28, 3.4),
                water(new THREE.MeshStandardMaterial({ color: '#0e1e2a', roughness: 0.04, metalness: 0 }), 0.12));
            pool.userData.noShadow = true;
            pool.rotation.x = -Math.PI / 2;
            pool.rotation.z = -Math.atan2(ay, ax);
            pool.position.set(px / WS, this.gy(px, py) + 0.04, py / WS);
            this.group.add(pool);
        }
        this.exclusions.push({ x: c.x, y: c.y, r: 60 }, { x: px, y: py, r: 160 });
    }

    buildMansion(at, face) {
        const g = new THREE.Group();
        g.name = 'pocabinet-mansion';
        const stucco = lam('#f0d3b6');
        const roof = lam('#b5532e');
        const add = (geom, mat, x, y, z) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); g.add(m); return m; };
        const pyramid = (w, d, h, x, y, z) => {
            const m = add(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4), roof, x, y + h / 2, z);
            m.rotation.y = Math.PI / 4;
            m.scale.set(w, h, d);
            return m;
        };
        add(new THREE.BoxGeometry(20, 6, 9), stucco, 0, 3, 0);
        pyramid(21, 10, 3, 0, 6, 0);
        for (const s of [-1, 1]) {
            add(new THREE.BoxGeometry(8, 4.5, 8), stucco, s * 14, 2.25, 1);
            pyramid(8.8, 8.8, 2.4, s * 14, 4.5, 1);
        }
        add(new THREE.BoxGeometry(4, 13, 4), stucco, -4, 6.5, -1);
        pyramid(4.8, 4.8, 3.4, -4, 13, -1);
        const swim = new THREE.Mesh(new THREE.PlaneGeometry(12, 5),
            water(new THREE.MeshStandardMaterial({ color: '#1b8fb0', roughness: 0.05, metalness: 0 }), 0.1));
        swim.userData.noShadow = true;
        swim.rotation.x = -Math.PI / 2;
        swim.position.set(0, 0.03, 10);
        g.add(swim);
        this.placeGroup(g, at, face, 210, { w: 40, d: 30, mat: lam('#e2c9a6') });
        this.exclusions.push({ x: at.x, y: at.y, r: 260 });
    }

    buildGolf(c) {
        const t = this.track;
        const green = lam('#7fbf5a');
        const pole = lam('#e8e8e8');
        // The pin flags ripple (materials.js flutter): held on the pole side, eight quads across.
        const flagMat = flutter(lam('#d8262b', { side: THREE.DoubleSide }), 0.8, -1, 0.09);
        for (let i = 0; i < 5; i++) {
            const a = i / 5 * Math.PI * 2 + this.rng();
            const r = 60 + this.rng() * 180;
            const x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
            if (!clearOfTrack(t, x, y, 50)) continue;
            // The green lies on the ground: each vertex at the terrain's height.
            const discGeom = new THREE.CircleGeometry(3.2, 24);
            discGeom.rotateX(-Math.PI / 2);
            const dp = discGeom.attributes.position;
            for (let v = 0; v < dp.count; v++) dp.setY(v, this.gy(x + dp.getX(v) * WS, y + dp.getZ(v) * WS) + 0.03);
            discGeom.computeVertexNormals();
            const disc = new THREE.Mesh(discGeom, green);
            disc.position.set(x / WS, 0, y / WS);
            disc.userData.noShadow = true;
            disc.receiveShadow = true;
            this.group.add(disc);
            const gyc = this.gy(x, y);
            const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5), pole);
            p.position.set(x / WS, gyc + 1.2, y / WS);
            this.group.add(p);
            const f = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5, 8, 3), flagMat);
            f.position.set(x / WS + 0.4, gyc + 2.1, y / WS);
            this.group.add(f);
            this.exclusions.push({ x, y, r: 40 });
        }
    }

    buildBriefingRoom(at, face) {
        const g = new THREE.Group();
        g.name = 'pocabinet-briefing';
        const navy = lam('#1c2c66');
        const add = (geom, mat, x, y, z) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); g.add(m); return m; };
        add(new THREE.BoxGeometry(58, 13, 1), navy, 0, 6.5, 0);
        const gold = new THREE.MeshBasicMaterial({ color: '#c9a445' });
        const inner = new THREE.MeshBasicMaterial({ color: '#223a7a' });
        for (const x of [-19, 0, 19]) {
            add(new THREE.CircleGeometry(2.7, 36), gold, x, 7.5, 0.52);
            add(new THREE.CircleGeometry(2.25, 36), inner, x, 7.5, 0.54);
            add(new THREE.CircleGeometry(0.7, 5), gold, x, 7.5, 0.56);
        }
        const wood = lam('#5a3a22');
        add(new THREE.BoxGeometry(3, 2.6, 2), wood, 0, 1.3, 4);
        add(new THREE.CircleGeometry(0.6, 24), gold, 0, 1.6, 5.02);
        const poleMat = lam('#c9a445');
        for (const x of [-6, 6]) {
            add(new THREE.CylinderGeometry(0.07, 0.07, 7, 6), poleMat, x, 3.5, 2);
            // Each flag hangs away from the lectern, so its pole is on the inner edge: a
            // material each, rippling from its own pole (materials.js flutter).
            const flag = flutter(new THREE.MeshBasicMaterial({ map: flagTexture(), side: THREE.DoubleSide }), 3.2, -Math.sign(x), 0.24);
            add(new THREE.PlaneGeometry(3.2, 1.7, 14, 5), flag, x + 1.65 * Math.sign(x), 5.9, 2);
        }
        const screen = new THREE.MeshBasicMaterial({ map: textTexture('NO FURTHER QUESTIONS', '#b0102a', '#ffffff', 1024, 160) });
        add(new THREE.BoxGeometry(30, 4.6, 0.4), lam('#111111'), 0, 16, 0);
        add(new THREE.PlaneGeometry(29, 4), screen, 0, 16, 0.22);
        const truss = lam('#262628');
        const spot = new THREE.SpriteMaterial({ map: glowTexture(), color: hdr('#ffe6f2', 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 });
        for (const x of [-31, 31]) {
            add(new THREE.BoxGeometry(0.6, 20, 0.6), truss, x, 10, 1);
            for (const y of [14, 17, 20]) {
                const s = new THREE.Sprite(spot);
                s.position.set(x, y, 1.6);
                s.scale.set(3, 3, 1);
                g.add(s);
            }
        }
        this.placeGroup(g, at, face, 300, { w: 66, d: 12, mat: lam('#8a8f99') });
        this.exclusions.push({ x: at.x, y: at.y, r: 340 });
    }

    /**
     * Senate Hill's landmark: a classical stone temple on a stepped podium, a colonnade on
     * every side under a pediment at each end, and a low dome behind.
     */
    buildTemple(at, face) {
        const g = new THREE.Group();
        g.name = 'pocabinet-temple';
        const stone = lam('#ddd5c4');
        const shade = lam('#c3b9a4');
        const add = (geom, mat, x, y, z) => { const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); g.add(m); return m; };
        for (let k = 0; k < 3; k++) add(new THREE.BoxGeometry(30 - k * 1.4, 0.6, 18 - k * 1.4), k % 2 ? shade : stone, 0, 0.3 + k * 0.6, 0);
        const W = 26, D = 14, H = 7.5;
        add(new THREE.BoxGeometry(W - 4, H, D - 5), shade, 0, 1.8 + H / 2, 0);   // the cella
        const colGeom = new THREE.CylinderGeometry(0.42, 0.5, H, 10);
        const across = 9, deep = 5;
        const cols = new THREE.InstancedMesh(colGeom, stone, across * 2 + (deep - 2) * 2);
        const dummy = new THREE.Object3D();
        let k = 0;
        for (let i = 0; i < across; i++) {
            for (const z of [-D / 2 + 0.6, D / 2 - 0.6]) {
                dummy.position.set(-W / 2 + 0.8 + i * (W - 1.6) / (across - 1), 1.8 + H / 2, z);
                dummy.updateMatrix();
                cols.setMatrixAt(k++, dummy.matrix);
            }
        }
        for (let i = 1; i < deep - 1; i++) {
            for (const x of [-W / 2 + 0.8, W / 2 - 0.8]) {
                dummy.position.set(x, 1.8 + H / 2, -D / 2 + 0.6 + i * (D - 1.2) / (deep - 1));
                dummy.updateMatrix();
                cols.setMatrixAt(k++, dummy.matrix);
            }
        }
        cols.instanceMatrix.needsUpdate = true;
        cols.frustumCulled = false;
        g.add(cols);
        add(new THREE.BoxGeometry(W + 0.6, 1.2, D + 0.6), stone, 0, 1.8 + H + 0.6, 0);   // entablature
        // Pediments: a low triangular prism along the roof.
        const roof = new THREE.Shape();
        roof.moveTo(-(D + 0.6) / 2, 0); roof.lineTo((D + 0.6) / 2, 0); roof.lineTo(0, 2.6); roof.closePath();
        const prism = new THREE.ExtrudeGeometry(roof, { depth: W + 0.6, bevelEnabled: false });
        prism.translate(0, 0, -(W + 0.6) / 2);
        prism.rotateY(Math.PI / 2);
        add(prism, shade, 0, 1.8 + H + 1.2, 0);
        add(new THREE.CylinderGeometry(3.2, 3.4, 2.2, 20), stone, 0, 1.8 + H + 4.2, 0);
        const dome = add(new THREE.SphereGeometry(3.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), lam('#8aa39a', { roughness: 0.5, metalness: 0.3 }), 0, 1.8 + H + 5.3, 0);
        dome.scale.y = 0.9;
        this.placeGroup(g, at, face, 170, { w: 32, d: 20, mat: shade });
        this.exclusions.push({ x: at.x, y: at.y, r: 240 });
    }

    // ── Trees / palms ──
    /**
     * Up to `target` clear spots beside the samples dressed as `zone`: `near` to `near + reach`
     * sim units past the barrier (thicker near the road, `pow`), at least `gap` apart, off every
     * stretch of road, every landmark and the scan.
     */
    scatter(zone, target, near, reach, pow, gap) {
        const t = this.track;
        const samples = [];
        for (let i = 0; i < t.count; i++) if (t.zoneAt(i) === zone) samples.push(i);
        const spots = [];
        if (!samples.length) return spots;
        for (let tries = 0; tries < target * 8 && spots.length < target; tries++) {
            const i = samples[Math.floor(this.rng() * samples.length)];
            const d = t.cum[i] + this.rng() * t.segLen[i];
            const s = this.rng() < 0.5 ? -1 : 1;
            const lat = s * (wallAtDist(t, d, s) + near + Math.pow(this.rng(), pow) * reach);
            const p = simAt(t, d, lat);
            if (!clearOfTrack(t, p.x, p.y, near - 8) || this.excluded(p.x, p.y)) continue;
            if (spots.some(q => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < gap * gap)) continue;
            spots.push(p);
        }
        return spots;
    }

    /** Each zone's planting: dark conifers round the stadium and the court, an autumn forest
     *  on Senate Hill, palms along the beach road. A zone's share follows its length. */
    buildPlanting() {
        const t = this.track;
        const share = (zone) => t.zoneOf.filter(z => z === zone).length / t.count;
        const conifers = [
            ...this.scatter('capitol', Math.round(560 * share('capitol')), 30, 520, 1.6, 28),
            ...this.scatter('court', Math.round(300 * share('court')), 30, 520, 1.6, 28),
        ];
        this.plantConifers(conifers);
        this.plantForest(this.scatter('senate', Math.round(900 * share('senate')), 24, 640, 1.4, 22));
        this.plantPalms(this.scatter('maralago', Math.round(340 * share('maralago')), 30, 520, 1.6, 28));
    }

    plantConifers(spots) {
        if (!spots.length) return;
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        const trunkGeom = new THREE.CylinderGeometry(0.18, 0.28, 1, 5);
        trunkGeom.translate(0, 0.5, 0);
        const coneGeom = new THREE.ConeGeometry(1, 1, 7);
        coneGeom.translate(0, 0.5, 0);
        const trunks = new THREE.InstancedMesh(trunkGeom, lam('#5a4230'), spots.length);
        const crowns = new THREE.InstancedMesh(coneGeom, wind(lam('#ffffff', { roughness: 0.9 }), 0.07), spots.length);
        spots.forEach((p, i) => {
            const h = 9 + this.rng() * 7;
            const r = 2.0 + this.rng() * 1.4;
            const y = this.gy(p.x, p.y) - 0.15;
            dummy.position.set(p.x / WS, y, p.y / WS);
            dummy.rotation.set(0, this.rng() * 6.28, 0);
            dummy.scale.set(1, h * 0.35, 1);
            dummy.updateMatrix();
            trunks.setMatrixAt(i, dummy.matrix);
            dummy.position.y = y + h * 0.28;
            dummy.scale.set(r, h * 0.8, r);
            dummy.updateMatrix();
            crowns.setMatrixAt(i, dummy.matrix);
            color.setHSL(0.27 + this.rng() * 0.08, 0.45, 0.2 + this.rng() * 0.1);
            crowns.setColorAt(i, color);
        });
        for (const m of [trunks, crowns]) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.frustumCulled = false;
            this.group.add(m);
        }
    }

    plantPalms(spots) {
        if (!spots.length) return;
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        const LEAVES = 7;
        const trunkGeom = new THREE.CylinderGeometry(0.15, 0.26, 1, 6);
        trunkGeom.translate(0, 0.5, 0);
        const leafGeom = new THREE.BoxGeometry(3.2, 0.06, 0.58);
        leafGeom.translate(1.6, 0, 0);
        const trunks = new THREE.InstancedMesh(trunkGeom, lam('#8a6a48'), spots.length);
        const leaves = new THREE.InstancedMesh(leafGeom, wind(lam('#ffffff', { roughness: 0.75, side: THREE.DoubleSide }), 0.09, 'x', 0.45), spots.length * LEAVES);
        const top = new THREE.Vector3();
        spots.forEach((p, i) => {
            const h = 8 + this.rng() * 6;
            const lean = (this.rng() - 0.5) * 0.3;
            const yaw = this.rng() * 6.28;
            dummy.position.set(p.x / WS, this.gy(p.x, p.y) - 0.15, p.y / WS);
            dummy.rotation.set(lean, yaw, 0);
            dummy.scale.set(1, h, 1);
            dummy.updateMatrix();
            trunks.setMatrixAt(i, dummy.matrix);
            top.set(0, 1, 0).applyMatrix4(dummy.matrix);
            for (let k = 0; k < LEAVES; k++) {
                dummy.position.copy(top);
                dummy.rotation.set(0, yaw + k / LEAVES * Math.PI * 2 + this.rng() * 0.3, -0.25 - this.rng() * 0.35);
                dummy.scale.set(0.8 + this.rng() * 0.4, 1, 1);
                dummy.updateMatrix();
                leaves.setMatrixAt(i * LEAVES + k, dummy.matrix);
                color.setHSL(0.24 + this.rng() * 0.07, 0.5, 0.26 + this.rng() * 0.08);
                leaves.setColorAt(i * LEAVES + k, color);
            }
        });
        for (const m of [trunks, leaves]) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.frustumCulled = false;
            this.group.add(m);
        }
    }

    /**
     * Senate Hill: an autumn forest. Broadleaf trees in orange, red and gold (two lumpy
     * crowns each), a few dark firs between them, thicker near the road and on out into the
     * hills. Instanced: four draw calls for the lot.
     */
    plantForest(spots) {
        if (!spots.length) return;
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        const firs = spots.filter(() => this.rng() < 0.18);
        const broad = spots.filter(p => !firs.includes(p));
        const trunkGeom = new THREE.CylinderGeometry(0.12, 0.2, 1, 5);
        trunkGeom.translate(0, 0.5, 0);
        const crownGeom = new THREE.IcosahedronGeometry(1, 1);
        const coneGeom = new THREE.ConeGeometry(1, 1, 7);
        coneGeom.translate(0, 0.5, 0);
        const trunks = new THREE.InstancedMesh(trunkGeom, lam('#4a3626'), spots.length);
        const crowns = new THREE.InstancedMesh(crownGeom, wind(lam('#ffffff', { roughness: 0.85, flatShading: true }), 0.05), broad.length * 2);
        const cones = new THREE.InstancedMesh(coneGeom, wind(lam('#ffffff', { roughness: 0.9 }), 0.06), firs.length);
        // Autumn: orange, rust red, gold and a few hanging on to green.
        const hues = [[0.07, 0.75, 0.42], [0.02, 0.7, 0.36], [0.11, 0.8, 0.48], [0.09, 0.65, 0.4], [0.2, 0.4, 0.3]];
        let tr = 0, cr = 0, co = 0;
        for (const p of spots) {
            const y = this.gy(p.x, p.y) - 0.15;
            const fir = firs.includes(p);
            const h = fir ? 11 + this.rng() * 8 : 8 + this.rng() * 7;
            dummy.position.set(p.x / WS, y, p.y / WS);
            dummy.rotation.set(0, this.rng() * 6.28, 0);
            dummy.scale.set(1, h * (fir ? 0.3 : 0.55), 1);
            dummy.updateMatrix();
            trunks.setMatrixAt(tr++, dummy.matrix);
            if (fir) {
                const r = 1.9 + this.rng() * 1.1;
                dummy.position.y = y + h * 0.22;
                dummy.scale.set(r, h * 0.85, r);
                dummy.updateMatrix();
                cones.setMatrixAt(co, dummy.matrix);
                color.setHSL(0.36 + this.rng() * 0.05, 0.4, 0.16 + this.rng() * 0.06);
                cones.setColorAt(co++, color);
                continue;
            }
            const hue = hues[Math.floor(this.rng() * hues.length)];
            for (let k = 0; k < 2; k++) {
                const r = (2.2 + this.rng() * 1.6) * (k ? 0.75 : 1);
                dummy.position.set(p.x / WS + (this.rng() - 0.5) * 0.9 * k, y + h * (0.62 + 0.25 * k), p.y / WS + (this.rng() - 0.5) * 0.9 * k);
                dummy.rotation.set(this.rng(), this.rng() * 6.28, 0);
                dummy.scale.set(r, r * (0.8 + this.rng() * 0.3), r);
                dummy.updateMatrix();
                crowns.setMatrixAt(cr, dummy.matrix);
                color.setHSL(hue[0] + (this.rng() - 0.5) * 0.03, hue[1], hue[2] * (0.85 + this.rng() * 0.3));
                crowns.setColorAt(cr++, color);
            }
        }
        trunks.count = tr; crowns.count = cr; cones.count = co;
        for (const m of [trunks, crowns, cones]) {
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.frustumCulled = false;
            this.group.add(m);
        }
    }

    // ── Billboards ──
    /** Eight round the lap, each with a line from the zone it stands in. */
    buildBillboards() {
        const t = this.track;
        const bg = '#' + this.accent.clone().multiplyScalar(0.35).getHexString();
        const frame = lam('#202226');
        const used = {};
        for (let i = 0; i < 8; i++) {
            const d = t.length * (0.07 + i * 0.12);
            const zone = t.zoneAt(t.indexAt(d));
            const texts = BILLBOARDS[zone] || BILLBOARDS.capitol;
            const text = texts[(used[zone] = (used[zone] ?? -1) + 1) % texts.length];
            for (const s of [1, -1]) {
                const lat = s * (wallAtDist(t, d, s) + 40);
                const p = simAt(t, d, lat);
                if (!clearOfTrack(t, p.x, p.y, 12) || this.excluded(p.x, p.y)) continue;
                const g = new THREE.Group();
                // Face the oncoming traffic, angled a little toward the road.
                const fx = -p.tx + s * p.ty * 0.35, fz = -p.ty - s * p.tx * 0.35;
                g.position.set(p.x / WS, this.terrain ? this.terrain.rangeAround(p.x, p.y, 32).lo : 0, p.y / WS);
                g.rotation.y = yawTo(fx, fz);
                for (const x of [-3.2, 3.2]) {
                    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.6, 0.2), frame);
                    post.position.set(x, 1.2, -0.1);
                    g.add(post);
                }
                const board = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.4, 0.2), frame);
                board.position.y = 4.1;
                g.add(board);
                const face = new THREE.Mesh(new THREE.PlaneGeometry(8, 2),
                    new THREE.MeshBasicMaterial({ map: textTexture(text, bg, '#ffffff'), color: '#d8d8d8' }));
                face.position.set(0, 4.1, 0.11);
                g.add(face);
                this.group.add(g);
                break;
            }
        }
    }

    // ── Press pen: photographers with flashbulbs, on the right of the start straight ──
    buildPressPen() {
        const t = this.track;
        const sides = [1];
        const perSide = 14;
        const bodyGeom = new THREE.CylinderGeometry(0.22, 0.26, 1.2, 6);
        const headGeom = new THREE.SphereGeometry(0.17, 8, 6);
        const camGeom = new THREE.BoxGeometry(0.24, 0.18, 0.3);
        const total = sides.length * perSide;
        const bodies = new THREE.InstancedMesh(bodyGeom, lam('#ffffff'), total);
        const heads = new THREE.InstancedMesh(headGeom, lam('#d9a982'), total);
        const cams = new THREE.InstancedMesh(camGeom, lam('#111111'), total);
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        let n = 0;
        for (const s of sides) {
            for (let i = 0; i < perSide; i++) {
                const d = -200 + i * 24 + this.rng() * 8;
                const lat = s * (wallAtDist(t, d, s) + 10 + this.rng() * 6);
                const p = simAt(t, d, lat);
                // Near a kinked start the offset point can land on another stretch of road.
                if (!clearOfTrack(t, p.x, p.y, 6)) continue;
                const inward = { x: s * p.ty, z: -s * p.tx };
                const x = p.x / WS, z = p.y / WS;
                const gy = this.gy(p.x, p.y);
                const yaw = yawTo(inward.x - p.tx * 0.4, inward.z - p.ty * 0.4);
                dummy.rotation.set(0, yaw, 0);
                dummy.position.set(x, gy + 0.6, z);
                dummy.updateMatrix();
                bodies.setMatrixAt(n, dummy.matrix);
                color.setHSL(this.rng(), 0.25, 0.18 + this.rng() * 0.2);
                bodies.setColorAt(n, color);
                dummy.position.set(x, gy + 1.35, z);
                dummy.updateMatrix();
                heads.setMatrixAt(n, dummy.matrix);
                const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
                const cx = x + fwd.x * 0.25, cz = z + fwd.z * 0.25;
                dummy.position.set(cx, gy + 1.35, cz);
                dummy.updateMatrix();
                cams.setMatrixAt(n, dummy.matrix);
                const flash = new THREE.Sprite(new THREE.SpriteMaterial({
                    map: glowTexture(), color: hdr('#eef4ff', 8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
                }));
                flash.position.set(cx + fwd.x * 0.2, gy + 1.4, cz + fwd.z * 0.2);
                flash.scale.set(2.6, 2.6, 1);
                this.group.add(flash);
                this.flashes.push({ sprite: flash, t: 0, delay: -1, pos: { x: cx, y: gy + 1.4, z: cz } });
                n++;
            }
        }
        for (const m of [bodies, heads, cams]) {
            m.count = n;
            m.instanceMatrix.needsUpdate = true;
            if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.frustumCulled = false;
            this.group.add(m);
        }
    }

    // ── Grandstand: four stepped rows of fans facing the start straight ──
    buildGrandstand() {
        const t = this.track;
        // Opposite the press pen.
        const mid = 0;
        const side = -1;
        const cols = 26, rows = 4, spacing = 6;
        const stepGeom = new THREE.BoxGeometry(0.62, 0.5, 1.1);
        const bodyGeom = new THREE.BoxGeometry(0.34, 0.55, 0.26);
        const headGeom = new THREE.SphereGeometry(0.15, 8, 6);
        const steps = new THREE.InstancedMesh(stepGeom, lam('#8d8f94'), cols * rows);
        const bodies = new THREE.InstancedMesh(bodyGeom, lam('#ffffff'), cols * rows);
        const heads = new THREE.InstancedMesh(headGeom, lam('#ffffff'), cols * rows);
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        const fans = [];
        let n = 0, sx = 0, sy = 0, sz = 0;
        for (let c = 0; c < cols; c++) {
            const d = mid + (c - cols / 2) * spacing;
            const wall = wallAtDist(t, d, side);
            const base = simAt(t, d, side * (wall + 9));
            const back = simAt(t, d, side * (wall + 9 + rows * 11));
            if (!clearOfTrack(t, base.x, base.y, 4) || !clearOfTrack(t, back.x, back.y, 4) || this.excluded(base.x, base.y)) continue;
            const inward = { x: side * base.ty, z: -side * base.tx };
            const yaw = yawTo(inward.x, inward.z);
            // The stand is built level off the ground at its front row; every step runs down
            // into the slope wherever the ground falls away behind.
            const front = this.gy(base.x, base.y);
            for (let r = 0; r < rows; r++) {
                const p = simAt(t, d, side * (wall + 9 + r * 11));
                const x = p.x / WS, z = p.y / WS;
                const top = front + 0.5 + r, bottom = Math.min(front, this.gy(p.x, p.y)) - 0.3;
                dummy.rotation.set(0, yaw, 0);
                dummy.scale.set(1, (top - bottom) / 0.5, 1);
                dummy.position.set(x, (top + bottom) / 2, z);
                dummy.updateMatrix();
                steps.setMatrixAt(n, dummy.matrix);
                dummy.scale.set(1, 1, 1);
                const seat = top + 0.02;   // top of this row's step
                color.setHSL(this.rng(), 0.55, 0.35 + this.rng() * 0.25);
                bodies.setColorAt(n, color);
                color.setHSL(0.07, 0.4, 0.35 + this.rng() * 0.35);
                heads.setColorAt(n, color);
                fans.push({ x, z, seat, yaw, phase: this.rng() * Math.PI * 2, rate: 7 + this.rng() * 4, i: n });
                sx += x; sy += front; sz += z;
                n++;
            }
        }
        for (const m of [steps, bodies, heads]) {
            m.count = n;
            m.frustumCulled = false;
            this.group.add(m);
        }
        if (!n) return;
        this.crowd = { center: { x: sx / n, y: sy / n + 2, z: sz / n }, level: 0, fans, bodies, heads, dummy, pose: 0 };
        this.poseCrowd(0);
    }

    /** Lift the crowd: `amount` 0..1, decays over a couple of seconds. */
    exciteCrowd(amount) {
        if (this.crowd) this.crowd.level = Math.max(this.crowd.level, Math.min(1, amount));
    }

    poseCrowd(e) {
        const c = this.crowd;
        const { dummy, bodies, heads } = c;
        for (const f of c.fans) {
            const jump = e > 0.01 ? Math.max(0, Math.sin(this.time * f.rate + f.phase)) * 0.35 * e : 0;
            dummy.rotation.set(0, f.yaw, 0);
            dummy.scale.set(1, 1, 1);
            dummy.position.set(f.x, f.seat + 0.28 + jump, f.z);
            dummy.updateMatrix();
            bodies.setMatrixAt(f.i, dummy.matrix);
            dummy.position.y = f.seat + 0.7 + jump;
            dummy.updateMatrix();
            heads.setMatrixAt(f.i, dummy.matrix);
        }
        bodies.instanceMatrix.needsUpdate = true;
        heads.instanceMatrix.needsUpdate = true;
    }

    /** Fire the press pen: `strength` 0..1 is the share of cameras that go off. */
    flashBurst(strength = 1) {
        for (const f of this.flashes) {
            if (this.rng() < strength) f.delay = this.rng() * 0.9;
        }
    }

    // ── Per frame ──
    /**
     * @param dt seconds
     * @param focus { x, z, speed01 } world-space camera focus (the player's car),
     *        or null — drives the paparazzi: the pen fires as it goes by at speed.
     */
    update(dt, focus) {
        this.time += dt;
        const paparazzi = focus && focus.speed01 > 0.35;
        for (const f of this.flashes) {
            if (paparazzi && f.delay < 0 && f.t <= 0) {
                const d2 = (f.pos.x - focus.x) ** 2 + (f.pos.z - focus.z) ** 2;
                if (d2 < 22 * 22 && this.rng() < dt * 2.5 * focus.speed01) f.delay = 0;
            }
            if (f.delay >= 0) {
                f.delay -= dt;
                if (f.delay < 0) {
                    f.t = 0.14;
                    try { this.onFlash?.(f.pos); } catch { /* audio is decoration */ }
                }
            }
            if (f.t > 0) {
                f.t -= dt;
                f.sprite.material.opacity = Math.max(0, f.t / 0.14);
                const s = 2.6 + (0.14 - f.t) * 10;
                f.sprite.scale.set(s, s, 1);
            } else if (f.sprite.material.opacity !== 0) {
                f.sprite.material.opacity = 0;
            }
        }
        if (this.crowd) {
            const c = this.crowd;
            c.level *= Math.exp(-dt * 0.6);
            if (c.level > 0.01 || c.pose > 0) {
                this.poseCrowd(c.level);
                c.pose = c.level > 0.01 ? 1 : 0;
            }
        }
        const on = (this.time % 1.6) < 0.18;
        for (const b of this.blinkers) b.material.opacity = on ? 0.6 : 0;
    }


    dispose() {
        // Geometry + materials go with the track group's traversal; sprite
        // materials are reached the same way. Textures are module-cached.
        this.onFlash = null;
        this.flashes = [];
    }
}
