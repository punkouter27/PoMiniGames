// pocabinet/debris.js
//
// Rigid-body debris for PoCabinet: what comes off a car in a shunt, and lies on the road
// afterwards. Render only: nothing here is read by physics.js, and no piece ever touches a
// car's body (the sim is deterministic: online prediction mirrors the server and lap proofs
// replay bit-exact). Pieces read the cars' drawn poses; they never write them.
//
// Two sorts of piece. The small bits fx.js throws off every hard hit (throwChunks(): shards
// of painted panel, chunks of black trim, glass and now and then a hubcap) are drawn as one
// InstancedMesh per kind, four draw calls however many are lying about. The whole parts
// cars.js tears off a car (throwPiece(): a bumper, the wing, a mirror, the tailgate, a wheel
// off a wreck) are each their own mesh, handed over at the pose they were hanging at.
//
// The solver is a compact sequential-impulse one, each body on its own against the world (no
// piece hits another). A piece is an oriented box (its eight corners touch) or a disc (the
// rim points nearest the plane touch, so a wheel or a hubcap rolls on its edge and lies flat
// on its face), mass 1, inertia from its shape. The world is the ground and the barriers: on
// the road and its run-off, the road's own plane (track.z along, tilted by track.bank across:
// what race.js place() stands the cars on); past it the terrain (scene.groundHeight). The
// barriers are vertical planes at the face physics.js stops a car against (terrain.js
// wallFace). Every contact has restitution (only above a closing speed, so nothing buzzes)
// and Coulomb friction with accumulated impulses over a few iterations; gravel grabs a piece
// and kills its bounce, grass a little less. Penetration is pushed straight out. It steps
// at a fixed 60 Hz on the render clock (slow motion slows it, a pause stops it) and draws
// every piece interpolated between steps. A piece still for half a second sleeps.
//
// On the track a piece is an obstacle one way only: a car (any of them, by its drawn pose)
// that runs into one kicks it out of its footprint the way the car was going, with a spark
// off metal (fx.js). The car never feels it. Caps by quality tier (SceneHandle.quality):
// 24 / 64 / 160 pieces, of which 6 / 14 / 28 whole parts; past the cap, or once it has lain
// there a while, the oldest sinks into the ground and is gone. Reduced motion
// (scene.fx.reduced) throws a third as many and gently: they drop off rather than fly.
//
// race.js drives it: updateDebris(dt, race) once a rendered frame (race supplies the track,
// the cars, the scene handle and fx), clearDebris() when the race goes.

import * as THREE from 'three';
import { wallFace } from './terrain.js';
import { surfaceAt, SURF_GRAVEL, SURF_GRASS } from './physics.js';
import { WORLD_SCALE as WS } from './util.js';

const STEP = 1 / 60;
const MAX_STEPS = 6;
const GRAVITY = 11;
const ITERATIONS = 6;
const SLOP = 0.003;
const SPEC = 0.05;              // a point this near a plane is a contact already (speculative: it may close the gap, not cross it)
const BOUNCE_FROM = 0.9;       // closing speed (world units/s) under which a contact does not bounce
const ROAD_LIFT = 0.02;        // the tarmac's top over the road's plane
const CAPS = { low: 24, medium: 64, high: 160 };
const PART_CAPS = { low: 6, medium: 14, high: 28 };
const LIFE = { low: 30, medium: 50, high: 80 };   // seconds a settled piece lies there
const SINK_S = 1.4;            // seconds to sink out
const CAPACITY = 220;          // instances per kind: the top cap and the ones sinking out
const MAX_W = 40;              // rad/s

const BOX = 0, DISC = 1;
const PANEL = 0, CHUNK = 1, GLASS = 2, HUBCAP = 3, PART = 4;

const bodies = [];
let world = null;              // the race (track, cars, scene, fx), from updateDebris
let acc = 0;
let kinds = null;              // the instanced meshes, built on the first throw
let sparkBudget = 0;
let clatterAt = 0;

function emitClatter(b, strength) {
    if (!world?.onClatter || strength < 0.08) return;
    const now = performance.now();
    if (now - clatterAt < 75 || (b.clatterAt && now - b.clatterAt < 140)) return;
    clatterAt = b.clatterAt = now;
    const mat = b.kind === GLASS ? 'glass_shard' : b.metal ? 'debris_metal' : 'bedroom_plastic';
    world.onClatter(mat, Math.min(1, strength), b.p);
}

// ── Instanced kinds ─────────────────────────────────────────────────────

/** A jagged plate in the unit cube, thickness along Y: a shard of panel or glass. */
function shardGeometry() {
    const pts = [[0.5, 0.08], [0.2, 0.5], [-0.28, 0.4], [-0.5, -0.06], [-0.16, -0.5], [0.34, -0.36]];
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
    g.translate(0, 0, -0.5);
    g.rotateX(Math.PI / 2);
    return g;
}

function buildKinds(parent) {
    const shard = shardGeometry();
    const make = (geom, mat, colored) => {
        const m = new THREE.InstancedMesh(geom, mat, CAPACITY);
        m.frustumCulled = false;      // its bounds are wherever the shunts were
        m.castShadow = true;
        m.receiveShadow = true;
        m.count = 0;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (colored) {
            const white = new THREE.Color(1, 1, 1);
            for (let i = 0; i < CAPACITY; i++) m.setColorAt(i, white);
            m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        m.name = 'pocabinet-debris';
        return m;
    };
    return [
        make(shard, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide }), true),
        make(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1 }), true),
        make(shard, new THREE.MeshStandardMaterial({
            color: '#a9c2cc', roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.62, side: THREE.DoubleSide,
        }), false),
        make(new THREE.CylinderGeometry(1, 1, 1, 18, 1), new THREE.MeshStandardMaterial({ color: '#d2d6dc', roughness: 0.28, metalness: 0.85 }), false),
    ].map(mesh => { parent.add(mesh); return mesh; });
}

function attach(parent) {
    if (!parent) return false;
    if (!kinds) kinds = buildKinds(parent);
    else if (kinds[0].parent !== parent) for (const m of kinds) parent.add(m);
    return true;
}

function tier() {
    const q = world?.scene?.quality;
    return q === 'low' || q === 'medium' ? q : 'high';
}

function reduced() {
    return !!world?.scene?.fx?.reduced;
}

// ── Bodies ──────────────────────────────────────────────────────────────

function newBody(kind, shape, p, q, v, w) {
    const b = {
        kind, shape, obj: null, dispose: null, owner: null, color: null,
        hx: 0, hy: 0, hz: 0, R: 0, w2: 0, rad: 0, ii: new THREE.Vector3(),
        p: p.clone(), q: q.clone().normalize(), v: v.clone(), w: w.clone(),
        pp: p.clone(), pq: q.clone().normalize(), qi: new THREE.Quaternion(),
        e: 0.35, roll: 2, metal: true, floor: p.y - 0.5, hint: -1,
        asleep: false, still: 0, age: 0, rest: 0, sink: -1, kickT: 0,
    };
    return b;
}

/** Box half extents (hx, hy, hz): mass 1, so the inertia is the shape's alone. */
function asBox(b, hx, hy, hz) {
    b.shape = BOX;
    b.hx = hx; b.hy = hy; b.hz = hz;
    b.rad = Math.hypot(hx, hy, hz);
    // A shard is drawn paper thin but turns as a thicker slab: a body near a flat plate's
    // inertia rocks on its edges forever instead of settling.
    const m = Math.max(hx, hy, hz) * 0.45;
    const x = Math.max(hx, m), y = Math.max(hy, m), z = Math.max(hz, m);
    b.ii.set(3 / (y * y + z * z), 3 / (x * x + z * z), 3 / (x * x + y * y));
    return b;
}

/** Disc of radius R, half thickness w, its axis local +Y. */
function asDisc(b, R, w) {
    b.shape = DISC;
    b.R = R; b.w2 = w;
    b.rad = Math.hypot(R, w);
    const across = (3 * R * R + 4 * w * w) / 12;
    b.ii.set(1 / across, 2 / (R * R), 1 / across);
    b.roll = 0.7;
    return b;
}

function add(b) {
    b.hint = world?.track ? b.hint : -1;
    bodies.push(b);
    enforceCaps();
}

function removeAt(i) {
    const b = bodies[i];
    if (b.obj) {
        b.obj.parent?.remove(b.obj);
        b.dispose?.();
    }
    bodies.splice(i, 1);
}

/** Past the tier's caps the oldest pieces sink out; far past it they go at once. */
function enforceCaps() {
    const t = tier();
    const cap = CAPS[t], partCap = PART_CAPS[t];
    let live = 0, parts = 0;
    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i];
        if (b.sink >= 0) continue;
        if (b.kind === PART && ++parts > partCap) { b.sink = 0; continue; }
        if (++live > cap) b.sink = 0;
    }
    for (let i = 0; bodies.length > cap + 40 && i < bodies.length;) {
        if (bodies[i].sink >= 0) removeAt(i); else i++;
    }
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const XAX = new THREE.Vector3(1, 0, 0);
const rnd = Math.random;

/** Spin about the disc's own axis that rolls it along `v` on the ground (ω = ŷ × v / R, on the axis). */
function rollSpin(b) {
    const a = _p.set(0, 1, 0).applyQuaternion(b.q);
    const s = _w.crossVectors(UP, b.v).dot(a) / b.R;
    b.w.addScaledVector(a, s);
}

/**
 * The bits off a shunt at world (x, y, z): shards of `paint` (a THREE.Color), black trim,
 * glass from a hard one and now and then a hubcap. They leave with the car's velocity
 * (vx, vz world units/s), thrown out along (ox, oz) (unit, away from the car) as hard as
 * `strength` 0..1. `owner` (the car's pose object) does not kick its own bits for a moment.
 */
export function throwChunks(parent, o) {
    if (!attach(parent)) return;
    const s = Math.min(1, Math.max(0, Number(o.strength) || 0));
    const calm = reduced();
    const k = calm ? 0.35 : 1;
    const n = (m) => Math.max(0, Math.round(m * k));
    const list = [];
    for (let i = n(1 + s * 3.4); i > 0; i--) list.push(PANEL);
    for (let i = n(1 + s * 3); i > 0; i--) list.push(CHUNK);
    if (s > 0.5) for (let i = n(1 + s * 4); i > 0; i--) list.push(GLASS);
    if (s > 0.6 && rnd() < 0.35 * (calm ? 0.5 : 1)) list.push(HUBCAP);
    if (!list.length) list.push(CHUNK);
    const vx = Number(o.vx) || 0, vz = Number(o.vz) || 0;
    const ox = Number(o.ox) || 0, oz = Number(o.oz) || 0;
    const fly = calm ? 0.25 : 1;
    for (const kind of list) {
        _p.set(o.x + (rnd() - 0.5) * 0.3, o.y + (rnd() - 0.2) * 0.25, o.z + (rnd() - 0.5) * 0.3);
        const out = (0.8 + rnd() * 2.6) * (0.4 + s) * fly;
        _v.set(vx * (0.7 + rnd() * 0.25) + ox * out + (rnd() - 0.5) * 2 * fly,
            (calm ? 0.3 : 1.4) + rnd() * 3.4 * s * fly,
            vz * (0.7 + rnd() * 0.25) + oz * out + (rnd() - 0.5) * 2 * fly);
        const spin = (kind === GLASS ? 22 : 14) * fly;
        _w.set((rnd() - 0.5) * spin, (rnd() - 0.5) * spin, (rnd() - 0.5) * spin);
        _q.setFromEuler(_e.set(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
        const b = newBody(kind, BOX, _p, _q, _v, _w);
        b.owner = o.owner || null;
        b.floor = Number.isFinite(o.floor) ? o.floor : o.y - 0.45;
        b.hint = Number.isInteger(o.hint) ? o.hint : -1;
        if (kind === PANEL) {
            asBox(b, 0.07 + rnd() * 0.15, 0.012, 0.05 + rnd() * 0.11);
            b.color = (o.paint || new THREE.Color(0.5, 0.5, 0.5)).clone().multiplyScalar(0.8 + rnd() * 0.3);
            b.e = 0.3;
        } else if (kind === CHUNK) {
            asBox(b, 0.04 + rnd() * 0.08, 0.025 + rnd() * 0.04, 0.03 + rnd() * 0.07);
            const g = 0.03 + rnd() * 0.07;
            b.color = new THREE.Color(g, g, g * 1.06);
            b.e = 0.4; b.metal = false;
        } else if (kind === GLASS) {
            asBox(b, 0.025 + rnd() * 0.06, 0.006, 0.02 + rnd() * 0.05);
            b.e = 0.18; b.metal = false;
        } else {
            asDisc(b, 0.2, 0.022);
            b.roll = 1.6;
            // Off on its edge, rolling the way it was thrown.
            _q.setFromUnitVectors(UP, _w.set(-(b.v.z), 0, b.v.x).normalize());
            if (_w.lengthSq() > 0.5) b.q.copy(_q);
            b.pq.copy(b.q);
            b.v.y = Math.min(b.v.y, 1.2);
            b.w.set(0, 0, 0);
            rollSpin(b);
            b.e = 0.35;
        }
        add(b);
    }
}

/**
 * A whole part off a car: `obj` (already placed in the world: position and quaternion) becomes
 * a rigid body here. o: { box: [hx, hy, hz] } or { disc: [R, w] } (axis obj's local +Y),
 * v / w (THREE.Vector3, world), e, metal, owner, roll (true: spin it to roll along v),
 * dispose (called once it is gone). Returns false (and leaves `obj` alone) with no parent.
 */
export function throwPiece(parent, obj, o) {
    if (!parent || !obj) return false;
    const b = newBody(PART, BOX, obj.position, obj.quaternion, o.v || _v.set(0, 0, 0), o.w || _w.set(0, 0, 0));
    if (o.disc) asDisc(b, o.disc[0], o.disc[1]);
    else asBox(b, ...(o.box || [0.2, 0.1, 0.2]).map(x => Math.max(0.02, x)));
    if (o.roll && b.shape === DISC) rollSpin(b);
    b.obj = obj;
    b.dispose = o.dispose || null;
    b.owner = o.owner || null;
    b.e = Number.isFinite(o.e) ? o.e : 0.3;
    b.metal = o.metal !== false;
    b.floor = Number.isFinite(o.floor) ? o.floor : obj.position.y - 0.6;
    b.hint = Number.isInteger(o.hint) ? o.hint : -1;
    obj.traverse(m => { if (m.isMesh) m.castShadow = tier() !== 'low'; });
    parent.add(obj);
    add(b);
    return true;
}

// ── World: ground and barriers ─────────────────────────────────────────

const G = { h: 0, px: 0, pz: 0, n: new THREE.Vector3(0, 1, 0), lat: 0, rx: 1, rz: 0, faceR: 0, faceL: 0, walls: false, mu: 0.5, e: 1, damp: 0.1 };

/** Ground plane under body `b` (height at its centre, normal), the barriers beside it, and what it lies on. */
function probe(b) {
    const t = world?.track;
    G.walls = false; G.mu = 0.5; G.e = 1; G.damp = 0.12;
    G.px = b.p.x; G.pz = b.p.z;
    if (!t) { G.h = b.floor; G.n.set(0, 1, 0); return; }
    const pr = t.project(b.p.x * WS, b.p.z * WS, b.hint);
    b.hint = pr.index;
    const i = pr.index, lat = pr.lateral;
    const faceR = wallFace(t, i, 1), faceL = wallFace(t, i, -1);
    G.rx = -pr.ty; G.rz = pr.tx;
    G.lat = lat / WS;
    if (lat <= faceR + 5 && -lat <= faceL + 5) {
        // The road's plane (out to the barriers): its height along, tilted by the bank across.
        const k = t.bankAt(pr.along), g = t.grade(i);
        G.h = (t.heightAt(pr.along) + lat * k) / WS + ROAD_LIFT;
        G.n.set(-(g * pr.tx - k * pr.ty), 1, -(g * pr.ty + k * pr.tx)).normalize();
        G.faceR = faceR / WS; G.faceL = faceL / WS;
        G.walls = true;
        const surf = surfaceAt(t, i, lat);
        if (surf === SURF_GRAVEL) { G.mu = 1.0; G.e = 0.25; G.damp = 2.6; }
        else if (surf === SURF_GRASS) { G.mu = 0.85; G.e = 0.6; G.damp = 0.9; }
    } else {
        // Beyond the barriers (it never gets there, but be safe): the terrain.
        const sh = world?.scene;
        const H = (x, z) => (sh?.groundHeight ? sh.groundHeight(x * WS, z * WS) : 0);
        const x = b.p.x, z = b.p.z, d = 0.4;
        G.h = H(x, z);
        G.n.set(-(H(x + d, z) - H(x - d, z)) / (2 * d), 1, -(H(x, z + d) - H(x, z - d)) / (2 * d)).normalize();
        G.mu = 0.85; G.e = 0.6; G.damp = 0.9;
    }
}

// ── Contacts ────────────────────────────────────────────────────────────

const MAXC = 40;
const C = Array.from({ length: MAXC }, () => ({
    r: new THREE.Vector3(), n: new THREE.Vector3(), t1: new THREE.Vector3(), t2: new THREE.Vector3(),
    rn: new THREE.Vector3(), irn: new THREE.Vector3(), r1: new THREE.Vector3(), i1: new THREE.Vector3(),
    r2: new THREE.Vector3(), i2: new THREE.Vector3(), k: 1, k1: 1, k2: 1, target: 0, mu: 0.5, jn: 0, j1: 0, j2: 0,
}));
let nc = 0;
const PTS = Array.from({ length: 8 }, () => new THREE.Vector3());
const CORNERS = Array.from({ length: 8 }, () => new THREE.Vector3());
const AX = new THREE.Vector3(), D = new THREE.Vector3(), E = new THREE.Vector3(), WN = new THREE.Vector3();

/** R I⁻¹ Rᵀ x into `out`. */
function invInertia(b, x, out) {
    out.copy(x).applyQuaternion(b.qi);
    out.x *= b.ii.x; out.y *= b.ii.y; out.z *= b.ii.z;
    return out.applyQuaternion(b.q);
}

function addContact(b, r, n, mu, e, dist, h) {
    if (nc >= MAXC) return;
    const c = C[nc++];
    c.r.copy(r); c.n.copy(n);
    c.rn.crossVectors(c.r, n); invInertia(b, c.rn, c.irn); c.k = 1 + c.rn.dot(c.irn);
    c.t1.crossVectors(n, Math.abs(n.y) < 0.9 ? UP : XAX).normalize();
    c.t2.crossVectors(n, c.t1);
    c.r1.crossVectors(c.r, c.t1); invInertia(b, c.r1, c.i1); c.k1 = 1 + c.r1.dot(c.i1);
    c.r2.crossVectors(c.r, c.t2); invInertia(b, c.r2, c.i2); c.k2 = 1 + c.r2.dot(c.i2);
    const vn = b.v.dot(n) + b.w.dot(c.rn);
    // Apart and not closing the gap this step: it may close it, no faster. Touching (or about to,
    // fast enough): it bounces.
    if (dist > 0 && vn * h + dist > 0) c.target = -dist / h;
    else c.target = vn < -BOUNCE_FROM ? -e * vn : dist > 0 ? -dist / h : 0;
    c.mu = mu; c.jn = 0; c.j1 = 0; c.j2 = 0;
}

/** The box's corners, from its centre, in the world's axes. */
function corners(b) {
    let k = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        CORNERS[k++].set(sx * b.hx, sy * b.hy, sz * b.hz).applyQuaternion(b.q);
    }
    return 8;
}

/**
 * The disc's points that can touch a plane of normal `n`: the rim point furthest down on each
 * face, and two more round the lower face's rim (so lying flat it rests on three).
 */
function discPoints(b, n) {
    const a = AX.set(0, 1, 0).applyQuaternion(b.q);
    const an = a.dot(n);
    D.copy(a).multiplyScalar(an).sub(n);
    let len = D.length();
    if (len < 1e-4) { D.crossVectors(a, Math.abs(a.y) < 0.9 ? UP : XAX); len = D.length(); }
    D.multiplyScalar(1 / len);
    E.crossVectors(a, D);
    const lower = an > 0 ? -b.w2 : b.w2;
    const R = b.R;
    PTS[0].copy(a).multiplyScalar(lower).addScaledVector(D, R);
    PTS[1].copy(a).multiplyScalar(-lower).addScaledVector(D, R);
    const c = -0.5, s = 0.8660254;
    PTS[2].copy(a).multiplyScalar(lower).addScaledVector(D, R * c).addScaledVector(E, R * s);
    PTS[3].copy(a).multiplyScalar(lower).addScaledVector(D, R * c).addScaledVector(E, -R * s);
    return 4;
}

function stepBody(b, h) {
    b.pp.copy(b.p); b.pq.copy(b.q);
    b.v.y -= GRAVITY * h;
    b.qi.copy(b.q).conjugate();
    probe(b);
    nc = 0;

    // Ground.
    const n = G.n;
    let pts = PTS, count;
    if (b.shape === BOX) { corners(b); pts = CORNERS; count = 8; } else count = discPoints(b, n);
    const ax = b.p.x - G.px, ay = b.p.y - G.h, az = b.p.z - G.pz;
    let deepest = 0, grounded = false;
    for (let k = 0; k < count; k++) {
        const o = pts[k];
        const dist = (ax + o.x) * n.x + (ay + o.y) * n.y + (az + o.z) * n.z;
        if (dist < SPEC) { addContact(b, o, n, G.mu, b.e * G.e, Math.max(0, dist), h); deepest = Math.max(deepest, -dist); }
        if (dist < 0.01) grounded = true;
    }
    if (deepest > SLOP) b.p.addScaledVector(n, deepest - SLOP);

    // Barriers: vertical planes where a car is stopped.
    if (G.walls) {
        for (const side of [1, -1]) {
            const face = side > 0 ? G.faceR : G.faceL;
            if (side * G.lat + b.rad + SPEC < face) continue;
            WN.set(-side * G.rx, 0, -side * G.rz);
            let wp = CORNERS, wc = 8;
            if (b.shape === DISC) { wc = discPoints(b, WN); wp = PTS; }
            let deep = 0;
            for (let k = 0; k < wc; k++) {
                const o = wp[k];
                const pen = side * (G.lat + o.x * G.rx + o.z * G.rz) - face;
                if (pen > -SPEC) { addContact(b, o, WN, 0.3, Math.min(0.6, b.e + 0.15), Math.max(0, -pen), h); deep = Math.max(deep, pen); }
            }
            if (deep > 0) b.p.addScaledVector(WN, deep);
        }
    }

    // Sequential impulses: normal (accumulated, never pulling), then friction in the contact's plane.
    const v = b.v, w = b.w;
    const impactSpeed = nc ? Math.abs(v.dot(n)) : 0;
    for (let it = 0; it < ITERATIONS && nc; it++) {
        for (let i = 0; i < nc; i++) {
            const c = C[i];
            const vn = v.dot(c.n) + w.dot(c.rn);
            let jn = Math.max(0, c.jn + (c.target - vn) / c.k);
            let d = jn - c.jn;
            c.jn = jn;
            v.addScaledVector(c.n, d); w.addScaledVector(c.irn, d);
            const lim = c.mu * c.jn;
            const v1 = v.dot(c.t1) + w.dot(c.r1);
            jn = Math.min(lim, Math.max(-lim, c.j1 - v1 / c.k1));
            d = jn - c.j1; c.j1 = jn;
            v.addScaledVector(c.t1, d); w.addScaledVector(c.i1, d);
            const v2 = v.dot(c.t2) + w.dot(c.r2);
            jn = Math.min(lim, Math.max(-lim, c.j2 - v2 / c.k2));
            d = jn - c.j2; c.j2 = jn;
            v.addScaledVector(c.t2, d); w.addScaledVector(c.i2, d);
        }
    }
    if (deepest > 0.008 && impactSpeed > 2.6) {
        emitClatter(b, (impactSpeed - 2.2) / 10);
    }

    if (grounded) {
        const k = Math.exp(-h * G.damp);
        v.x *= k; v.z *= k;
        w.multiplyScalar(Math.exp(-h * b.roll));
    } else {
        w.multiplyScalar(Math.exp(-h * 0.15));
    }
    const ws = w.length();
    if (ws > MAX_W) w.multiplyScalar(MAX_W / ws);

    b.p.addScaledVector(v, h);
    const q = b.q, hh = h * 0.5;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    q.set(qx + hh * (w.x * qw + w.y * qz - w.z * qy),
        qy + hh * (w.y * qw + w.z * qx - w.x * qz),
        qz + hh * (w.z * qw + w.x * qy - w.y * qx),
        qw - hh * (w.x * qx + w.y * qy + w.z * qz)).normalize();
    // Where the step left it inside the ground or a barrier, out again (position only), so
    // no drawn pose is ever in either.
    pushOut(b);

    // Still on the ground for half a second: asleep until a car kicks it.
    if (v.lengthSq() < 0.012 && w.lengthSq() < 0.08) {
        b.still += grounded ? h : h * 0.3;
        if (b.still > 0.5) { b.asleep = true; v.set(0, 0, 0); w.set(0, 0, 0); b.pp.copy(b.p); b.pq.copy(b.q); }
    } else {
        b.still = 0;
    }
    // Never through the ground, whatever happened.
    if (b.p.y < G.h - b.rad - 0.5) { b.p.y = G.h + b.rad; v.set(0, 0, 0); }
}

/** Move `b` out of the ground plane and the barriers found by this step's probe (G). */
function pushOut(b) {
    const n = G.n;
    let pts = PTS, count;
    if (b.shape === BOX) { corners(b); pts = CORNERS; count = 8; } else count = discPoints(b, n);
    const ax = b.p.x - G.px, ay = b.p.y - G.h, az = b.p.z - G.pz;
    let deepest = 0;
    for (let k = 0; k < count; k++) {
        const o = pts[k];
        deepest = Math.max(deepest, -((ax + o.x) * n.x + (ay + o.y) * n.y + (az + o.z) * n.z));
    }
    if (deepest > SLOP) b.p.addScaledVector(n, deepest - SLOP);
    if (!G.walls) return;
    for (const side of [1, -1]) {
        const face = side > 0 ? G.faceR : G.faceL;
        const lat = G.lat + (b.p.x - G.px) * G.rx + (b.p.z - G.pz) * G.rz;
        if (side * lat + b.rad < face) continue;
        WN.set(-side * G.rx, 0, -side * G.rz);
        let wp = CORNERS, wc = 8;
        if (b.shape === DISC) { wc = discPoints(b, WN); wp = PTS; }
        let deep = 0;
        for (let k = 0; k < wc; k++) {
            const o = wp[k];
            deep = Math.max(deep, side * (lat + o.x * G.rx + o.z * G.rz) - face);
        }
        if (deep > 0) b.p.addScaledVector(WN, deep);
    }
}

// ── Cars kick it ────────────────────────────────────────────────────────

const HALF_L = 1.95, HALF_W = 0.85;

/** Every piece inside a car's footprint is knocked out of it the way the car was going. One way only. */
function kicks(dt) {
    const cars = world?.cars;
    if (!Array.isArray(cars) || !cars.length) return;
    sparkBudget = Math.min(12, sparkBudget + dt * 25);
    for (const b of bodies) {
        if (b.sink >= 0) continue;
        if (b.kickT > 0) { b.kickT -= dt; continue; }
        for (const car of cars) {
            const r = car.render;
            if (!r || !Number.isFinite(r.x)) continue;
            if (b.owner && b.age < 0.6 && (b.owner === r || b.owner === car.mesh)) continue;
            const dx = b.p.x - r.x / WS, dz = b.p.z - r.y / WS;
            if (dx > 2.6 || dx < -2.6 || dz > 2.6 || dz < -2.6) continue;
            const up = Number(r.h) || 0;
            if (b.p.y - up > 1.2 || up - b.p.y > 0.6) continue;
            const fx = Math.cos(r.heading), fz = Math.sin(r.heading);
            const al = dx * fx + dz * fz, ac = -dx * fz + dz * fx;
            const grow = Math.min(0.25, b.rad * 0.6);
            const hl = HALF_L + grow, hw = HALF_W + grow;
            if (Math.abs(al) > hl || Math.abs(ac) > hw) continue;
            const sp = (Number(r.speed) || 0) / WS;
            const cvx = fx * sp, cvz = fz * sp;
            let ex, ez, push;
            if (hl - Math.abs(al) < hw - Math.abs(ac)) { const s = al >= 0 ? 1 : -1; ex = fx * s; ez = fz * s; push = hl - Math.abs(al); }
            else { const s = ac >= 0 ? 1 : -1; ex = -fz * s; ez = fx * s; push = hw - Math.abs(ac); }
            b.p.x += ex * push; b.p.z += ez * push;
            const along = cvx * ex + cvz * ez;
            const want = Math.max(0, along) * (1.08 + rnd() * 0.3) + 0.5;
            const have = b.v.x * ex + b.v.z * ez;
            if (have < want) { b.v.x += ex * (want - have); b.v.z += ez * (want - have); }
            // Dragged along a little by a car going past it.
            b.v.x += (cvx - ex * along) * 0.3; b.v.z += (cvz - ez * along) * 0.3;
            const hard = Math.min(1, Math.abs(sp) / 12);
            const calm = reduced() ? 0.3 : 1;
            b.v.y = Math.max(b.v.y, (0.5 + rnd() * 2.6 * hard) * calm);
            b.w.x += (rnd() - 0.5) * 18 * hard * calm; b.w.y += (rnd() - 0.5) * 12 * hard * calm; b.w.z += (rnd() - 0.5) * 18 * hard * calm;
            if (b.shape === DISC) rollSpin(b);
            b.asleep = false; b.still = 0; b.rest = 0; b.kickT = 0.12;
            if (b.metal && hard > 0.25 && sparkBudget >= 1 && world.fx?.spark) {
                sparkBudget -= 1;
                for (let k = 0; k < 3; k++) world.fx.spark(b.p.x, b.p.y + 0.05, b.p.z, b.v.x * 0.5 + (rnd() - 0.5) * 2, 0.6 + rnd() * 1.5, b.v.z * 0.5 + (rnd() - 0.5) * 2);
            }
            emitClatter(b, Math.min(1, hard * 0.85));
            break;
        }
    }
}

const GRID_CELL = 0.9;
const hashGrid = new Map();

/** Spatial-hash debris-to-debris impulse resolution & acoustic clatter (#9). */
function collidePieces() {
    if (bodies.length < 2) return;
    hashGrid.clear();
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.sink >= 0) continue;
        const cx = Math.floor(b.p.x / GRID_CELL);
        const cz = Math.floor(b.p.z / GRID_CELL);
        const key = (cx + 16384) * 32768 + (cz + 16384);
        let bucket = hashGrid.get(key);
        if (!bucket) { bucket = []; hashGrid.set(key, bucket); }
        bucket.push(i);
    }
    for (const bucket of hashGrid.values()) {
        for (const i of bucket) {
            const a = bodies[i];
            if (a.asleep || a.sink >= 0) continue;
            const cx = Math.floor(a.p.x / GRID_CELL);
            const cz = Math.floor(a.p.z / GRID_CELL);
            for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nb = hashGrid.get((cx + dx + 16384) * 32768 + (cz + dz + 16384));
                    if (!nb) continue;
                    for (const j of nb) {
                        if (j <= i) continue;
                        const b = bodies[j];
                        if (b.sink >= 0) continue;
                        const rx = b.p.x - a.p.x, ry = b.p.y - a.p.y, rz = b.p.z - a.p.z;
                        const rSum = (a.rad + b.rad) * 0.82;
                        const d2 = rx * rx + ry * ry + rz * rz;
                        if (d2 >= rSum * rSum || d2 < 1e-8) continue;
                        const d = Math.sqrt(d2);
                        const nx = rx / d, ny = ry / d, nz = rz / d;
                        const rvx = a.v.x - b.v.x, rvy = a.v.y - b.v.y, rvz = a.v.z - b.v.z;
                        const closing = rvx * nx + rvy * ny + rvz * nz;
                        const pen = rSum - d;
                        if (pen > SLOP) {
                            const push = (pen - SLOP) * 0.5;
                            a.p.x -= nx * push; a.p.y -= ny * push; a.p.z -= nz * push;
                            b.p.x += nx * push; b.p.y += ny * push; b.p.z += nz * push;
                        }
                        if (closing <= 0.25) continue;
                        const jn = 0.5 * (1 + Math.min(0.7, (a.e + b.e) * 0.5)) * closing;
                        a.v.x -= nx * jn; a.v.y -= ny * jn; a.v.z -= nz * jn;
                        b.v.x += nx * jn; b.v.y += ny * jn; b.v.z += nz * jn;
                        const spinKick = Math.min(6, closing * 1.4);
                        a.w.x += nz * spinKick; a.w.z -= nx * spinKick;
                        b.w.x -= nz * spinKick; b.w.z += nx * spinKick;
                        if (b.asleep && closing > 1.2) { b.asleep = false; b.still = 0; b.rest = 0; }
                        if (closing > 2.2) emitClatter(a, Math.min(1, (closing - 1.5) / 10));
                    }
                }
            }
        }
    }
}

// ── Frame ───────────────────────────────────────────────────────────────

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _dp = new THREE.Vector3();
const _dq = new THREE.Quaternion();

function draw(alpha) {
    if (!kinds) {
        for (const b of bodies) if (b.obj) place(b, alpha, b.obj.position, b.obj.quaternion);
        return;
    }
    const shadows = tier() !== 'low';
    for (const m of kinds) { m.count = 0; m.castShadow = shadows; }
    for (const b of bodies) {
        if (b.obj) { place(b, alpha, b.obj.position, b.obj.quaternion); continue; }
        const mesh = kinds[b.kind];
        if (mesh.count >= CAPACITY) continue;
        place(b, alpha, _dp, _dq);
        const shrink = b.sink > 0 ? 1 - 0.4 * b.sink : 1;
        if (b.shape === DISC) _s.set(b.R * shrink, b.w2 * 2 * shrink, b.R * shrink);
        else _s.set(b.hx * 2 * shrink, b.hy * 2 * shrink, b.hz * 2 * shrink);
        _m.compose(_dp, _dq, _s);
        mesh.setMatrixAt(mesh.count, _m);
        if (b.color) mesh.setColorAt(mesh.count, b.color);
        mesh.count++;
    }
    for (const m of kinds) {
        if (!m.count) continue;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
}

/** The pose drawn: between the last two steps, sunk into the ground as it goes. */
function place(b, alpha, pos, quat) {
    if (b.asleep) { pos.copy(b.p); quat.copy(b.q); }
    else { pos.copy(b.pp).lerp(b.p, alpha); quat.copy(b.pq).slerp(b.q, alpha); }
    if (b.sink > 0) pos.y -= b.sink * b.sink * (b.rad * 2 + 0.05);
}

/**
 * Step the pieces `dt` seconds (already scaled for slow motion; 0 when paused: they are still
 * drawn) and draw them. `race` gives the world: { track, cars, scene, fx }.
 */
export function updateDebris(dt, race) {
    if (race !== undefined) world = race || null;
    if (!bodies.length) { if (kinds) for (const m of kinds) m.count = 0; return; }
    if (dt > 0) {
        enforceCaps();
        acc += Math.min(dt, 0.1);
        let steps = 0;
        while (acc >= STEP && steps < MAX_STEPS) {
            for (const b of bodies) if (!b.asleep && b.sink < 0) stepBody(b, STEP);
            collidePieces();
            acc -= STEP;
            steps++;
        }
        if (acc >= STEP) acc %= STEP;
        kicks(dt);
        const life = LIFE[tier()];
        for (let i = bodies.length - 1; i >= 0; i--) {
            const b = bodies[i];
            b.age += dt;
            if (b.asleep) b.rest += dt;
            if (b.sink < 0 && (b.rest > life || b.age > life * 2)) b.sink = 0;
            if (b.sink >= 0) {
                b.sink += dt / SINK_S;
                if (b.sink >= 1) removeAt(i);
            }
        }
    }
    draw(Math.min(1, acc / STEP));
}

/** Every piece off the road, and forget the race (it is over). */
export function clearDebris() {
    while (bodies.length) removeAt(bodies.length - 1);
    if (kinds) for (const m of kinds) { m.count = 0; m.parent?.remove(m); }
    world = null;
    acc = 0;
}
