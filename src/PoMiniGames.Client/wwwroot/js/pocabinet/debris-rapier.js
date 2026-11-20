// pocabinet/debris-rapier.js
//
// The Rapier solver for debris.js (medium and high tiers; the low tier and any device where
// Rapier cannot load keep debris.js's own solver). Rapier is a rigid-body engine compiled to
// WASM (@dimforge/rapier3d-compat, the `rapier` entry of the import map): what it adds over the
// built-in solver is real shapes against each other. A bumper lies across a wheel, shards pile
// up against a wreck, a hubcap rolls into a parked car and falls over.
//
// Render only, like everything in debris.js: the cars are kinematic bodies fed from the poses
// race.js already drew, so a piece feels a car and a car never feels a piece. Nothing here is
// read by physics.js or the lap proof.
//
// The world, built once per track (world units, y up):
//   • the road and its run-off, a triangle ribbon from barrier to barrier: the road's own plane
//     (track.z along, tilted by track.bank across), the surface race.js stands the cars on. A
//     ribbon, not a heightfield: where the lap crosses over itself there are two decks.
//   • the barriers, a wall of triangles on the face physics.js stops a car against.
//   • one box per car, moved every step to where the car is drawn, with the car's velocity.
//
// Each piece is a box or a cylinder (a wheel, a hubcap) with continuous collision detection:
// a shard is thinner than the distance it falls in a step. What the piece lies on (gravel
// grabs it, grass a little less) is read from the track every step, as the built-in solver
// does, and applied as damping, friction and bounce. No imports from three or util.js: this
// file also runs in node, where scripts/pocabinet/debris-check.mjs drops pieces on the real
// circuit.

import { runOffAt, surfaceAt, SURF_GRAVEL, SURF_GRASS } from './physics.js';

const GRAVITY = 11;
const STEP = 1 / 60;
const ROAD_LIFT = 0.02;        // the tarmac's top over the road's plane (debris.js ROAD_LIFT)
const EDGE_PAD = 5;            // sim units of ribbon past the barrier's face
const WALL_TOP = 12;           // world units of barrier over the road: nothing clears it
const WALL_FOOT = 1.5;
const MIN_HALF = 0.012;        // the thinnest collider (a shard is drawn thinner)
const HULL = { l: 1.95, h: 0.55, w: 0.85, lift: 0.62 };   // a car: half extents and its centre over the road
const NEW_PIECE_S = 0.6;       // a piece does not touch a car until it is this old and clear of every car (it is thrown from inside one)

// Collision groups: membership in the high 16 bits, what it touches in the low 16.
const G_WORLD = 1, G_PIECE = 2, G_CAR = 4;
const groups = (member, filter) => ((member << 16) | filter) >>> 0;

let loading = null;

/** The Rapier module, loaded and initialised once (null if it cannot be: offline, blocked, no WASM). */
export function loadRapier() {
    if (!loading) {
        loading = import('rapier')
            .then(async (m) => {
                const R = m.default || m;
                await R.init();
                return R;
            })
            .catch((e) => {
                console.warn('pocabinet/debris: Rapier did not load, keeping the built-in solver', e);
                return null;
            });
    }
    return loading;
}

/** The ribbon and the barriers of `track` as two triangle soups (world units). */
export function trackMesh(track, ws) {
    const n = track.count;
    const ground = new Float32Array(n * 6);
    const wall = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        // The across direction at a sample: the mean of the two segments that meet there.
        let tx = track.tx[p] + track.tx[i], ty = track.ty[p] + track.ty[i];
        const len = Math.hypot(tx, ty) || 1;
        tx /= len; ty /= len;
        const rx = -ty, ry = tx;
        const z = track.z ? track.z[i] : 0, bank = track.bank ? track.bank[i] : 0;
        const faceR = track.hwAt(i) + runOffAt(track, i, 1), faceL = track.hwAt(i) + runOffAt(track, i, -1);
        const put = (arr, o, lat, lift) => {
            arr[o] = (track.x[i] + rx * lat) / ws;
            arr[o + 1] = (z + lat * bank) / ws + lift;
            arr[o + 2] = (track.y[i] + ry * lat) / ws;
        };
        put(ground, i * 6, -(faceL + EDGE_PAD), ROAD_LIFT);
        put(ground, i * 6 + 3, faceR + EDGE_PAD, ROAD_LIFT);
        put(wall, i * 12, -faceL, -WALL_FOOT);
        put(wall, i * 12 + 3, -faceL, WALL_TOP);
        put(wall, i * 12 + 6, faceR, -WALL_FOOT);
        put(wall, i * 12 + 9, faceR, WALL_TOP);
    }
    const gi = new Uint32Array(n * 6), wi = new Uint32Array(n * 12);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
        // Wound so the road faces up and each barrier faces the road.
        gi.set([a, b, c, b, d, c], i * 6);
        const l0 = i * 4, l1 = i * 4 + 1, r0 = i * 4 + 2, r1 = i * 4 + 3;
        const m0 = j * 4, m1 = j * 4 + 1, s0 = j * 4 + 2, s1 = j * 4 + 3;
        wi.set([l0, m0, l1, l1, m0, m1, r0, r1, s0, r1, s1, s0], i * 12);
    }
    return { ground, groundIndex: gi, wall, wallIndex: wi };
}

export class RapierDebris {
    /**
     * @param R     the Rapier module (loadRapier)
     * @param track runtime track (track.js)
     * @param ws    sim units per world unit (util.js WORLD_SCALE)
     */
    constructor(R, track, ws) {
        this.R = R;
        this.track = track;
        this.ws = ws;
        this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
        this.world.timestep = STEP;
        this.cars = new Map();       // car -> { body, seen }
        this.frame = 0;
        const mesh = trackMesh(track, ws);
        const flags = R.TriMeshFlags?.FIX_INTERNAL_EDGES ?? 0;
        // Friction and bounce are the piece's own (set from the surface under it): the world's
        // are 1 and the pieces multiply.
        const fixed = (verts, index, friction) => this.world.createCollider(
            R.ColliderDesc.trimesh(verts, index, flags)
                .setFriction(friction).setRestitution(1)
                .setCollisionGroups(groups(G_WORLD, G_PIECE)));
        fixed(mesh.ground, mesh.groundIndex, 1);
        fixed(mesh.wall, mesh.wallIndex, 0.6);
    }

    /** A rigid body for debris piece `b` (debris.js newBody), at its pose and velocity. */
    add(b) {
        if (b.rb) return;
        const R = this.R;
        const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
            .setTranslation(b.p.x, b.p.y, b.p.z)
            .setRotation({ x: b.q.x, y: b.q.y, z: b.q.z, w: b.q.w })
            .setLinvel(b.v.x, b.v.y, b.v.z)
            .setAngvel({ x: b.w.x, y: b.w.y, z: b.w.z })
            .setCcdEnabled(true));
        const shape = b.shape === 1
            ? R.ColliderDesc.cylinder(Math.max(MIN_HALF, b.w2), b.R)
            : R.ColliderDesc.cuboid(Math.max(MIN_HALF, b.hx), Math.max(MIN_HALF, b.hy), Math.max(MIN_HALF, b.hz));
        b.withCars = b.age >= NEW_PIECE_S;
        b.col = this.world.createCollider(shape
            .setDensity(1)
            .setFriction(0.5).setRestitution(b.e)
            .setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
            .setRestitutionCombineRule(R.CoefficientCombineRule.Multiply)
            .setCollisionGroups(groups(G_PIECE, G_WORLD | G_PIECE | (b.withCars ? G_CAR : 0))), body);
        b.rb = body;
        b.mu = 0.5; b.rest0 = b.e;
        if (b.asleep) body.sleep();
    }

    remove(b) {
        if (!b.rb) return;
        this.world.removeRigidBody(b.rb);
        b.rb = null; b.col = null;
    }

    /** A piece debris.js moved by hand (a car kicked it): its pose and velocity into the engine. */
    push(b) {
        if (!b.rb) return;
        b.rb.setTranslation({ x: b.p.x, y: b.p.y, z: b.p.z }, true);
        b.rb.setLinvel({ x: b.v.x, y: b.v.y, z: b.v.z }, true);
        b.rb.setAngvel({ x: b.w.x, y: b.w.y, z: b.w.z }, true);
    }

    /** Every car's box to where it is drawn, moving the way it is going. `cars`: race.js's (car.render). */
    syncCars(cars) {
        const R = this.R, ws = this.ws;
        this.frame++;
        for (const car of cars || []) {
            const r = car.render;
            if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.heading)) continue;
            let c = this.cars.get(car);
            if (!c) {
                const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicVelocityBased());
                this.world.createCollider(R.ColliderDesc.cuboid(HULL.l, HULL.h, HULL.w)
                    .setFriction(1).setRestitution(1)
                    .setCollisionGroups(groups(G_CAR, G_PIECE)), body);
                c = { body, seen: 0, x: 0, y: 0, z: 0, fx: 1, fz: 0 };
                this.cars.set(car, c);
            }
            c.seen = this.frame;
            c.x = r.x / ws; c.y = (Number(r.h) || 0) + HULL.lift; c.z = r.y / ws;
            c.fx = Math.cos(r.heading); c.fz = Math.sin(r.heading);
            const half = -r.heading / 2;     // a turn of -heading about +Y takes +X to the car's nose
            const sp = (Number(r.speed) || 0) / ws;
            // Placed, not moved there: the velocity is the car's own, so a slow-motion frame or a
            // dropped one never throws a piece harder than the car was going.
            c.body.setTranslation({ x: r.x / ws, y: (Number(r.h) || 0) + HULL.lift, z: r.y / ws }, false);
            c.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, false);
            c.body.setLinvel({ x: Math.cos(r.heading) * sp, y: 0, z: Math.sin(r.heading) * sp }, false);
        }
        for (const [car, c] of this.cars) {
            if (c.seen === this.frame) continue;
            this.world.removeRigidBody(c.body);
            this.cars.delete(car);
        }
    }

    /** Is piece `b` in (or reaching into) a car's box? Such a piece is not given to the cars yet. */
    insideCar(b) {
        // Half the piece's size of margin: one falling onto a roof is clear of it and lands there.
        const m = Math.min(b.rad, 0.3) * 0.5;
        for (const c of this.cars.values()) {
            const dx = b.p.x - c.x, dz = b.p.z - c.z;
            if (Math.abs(b.p.y - c.y) > HULL.h + m) continue;
            if (Math.abs(dx * c.fx + dz * c.fz) < HULL.l + m && Math.abs(-dx * c.fz + dz * c.fx) < HULL.w + m) return true;
        }
        return false;
    }

    /** What piece `b` lies on, as damping, friction and bounce (the built-in solver's numbers). */
    surface(b) {
        const t = this.track, ws = this.ws;
        const pr = t.project(b.p.x * ws, b.p.z * ws, b.hint);
        b.hint = pr.index;
        const lat = pr.lateral;
        const h = (t.heightAt(pr.along) + lat * t.bankAt(pr.along)) / ws + ROAD_LIFT;
        const grounded = b.p.y - h < b.rad + 0.04;
        let mu = 0.5, e = 1, damp = 0.12;
        const surf = surfaceAt(t, pr.index, lat);
        if (surf === SURF_GRAVEL) { mu = 1.0; e = 0.25; damp = 2.6; }
        else if (surf === SURF_GRASS) { mu = 0.85; e = 0.6; damp = 0.9; }
        // All but stopped on the ground: damped hard, so a long part lying across a change of
        // slope stops rocking and a wheel lies down instead of creeping on its rim for a minute.
        const v2 = b.v.x * b.v.x + b.v.y * b.v.y + b.v.z * b.v.z;
        const w2 = b.w.x * b.w.x + b.w.y * b.w.y + b.w.z * b.w.z;
        const dying = grounded && v2 < (b.shape === 1 ? 1.5 : 0.08) && w2 < (b.shape === 1 ? 16 : 0.5);
        b.rb.setLinearDamping(grounded ? damp + (dying ? 3 : 0) : 0);
        b.rb.setAngularDamping(grounded ? b.roll + (dying ? 6 : 0) : 0.15);
        b.grounded = grounded;
        // No bounce once it has all but stopped: a resting contact that still bounces buzzes.
        const rest = dying ? 0 : b.e * e;
        if (mu !== b.mu) { b.mu = mu; b.col.setFriction(mu); }
        if (rest !== b.rest0) { b.rest0 = rest; b.col.setRestitution(rest); }
        // Under the road (it should never be): back on it, still.
        if (b.p.y < h - b.rad - 1) {
            b.rb.setTranslation({ x: b.p.x, y: h + b.rad, z: b.p.z }, true);
            b.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
        return h;
    }

    /**
     * One 60 Hz step of every piece in `bodies` that is in the engine. Leaves each piece's pose
     * and velocity in its record (pp/pq the pose before, for the interpolated draw) and calls
     * `onImpact(b, dv)` where a piece's velocity changed sharply (a bounce: the clatter).
     */
    step(bodies, onImpact) {
        for (const b of bodies) {
            if (!b.rb) continue;
            b.pp.copy(b.p); b.pq.copy(b.q);
            if (b.rb.isSleeping()) continue;
            this.surface(b);
            // A piece still inside a car when its time is up would be shot out of the box: it
            // waits until it is clear (debris.js's kick moves it out of a stopped car).
            if (!b.withCars && b.age >= NEW_PIECE_S && !this.insideCar(b)) {
                b.withCars = true;
                b.col.setCollisionGroups(groups(G_PIECE, G_WORLD | G_PIECE | G_CAR));
            }
        }
        this.world.step();
        for (const b of bodies) {
            if (!b.rb) continue;
            const sleeping = b.rb.isSleeping();
            if (sleeping && b.settled) continue;
            const p = b.rb.translation(), q = b.rb.rotation(), v = b.rb.linvel(), w = b.rb.angvel();
            // At rest for debris.js (its clock for clearing a piece away, and a pose that is
            // drawn still): the pose has not left a 2 cm, 2 degree window for half a second. The
            // engine's own sleep waits for the whole pile, and a long part lying across a change
            // of slope twitches by a few millimetres for ever. Putting one body of a pile to
            // sleep by hand is no answer: whatever lies on it drops straight through.
            const a = b.anchor || (b.anchor = { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, t: 0 });
            const dx = p.x - a.x, dy = p.y - a.y, dz = p.z - a.z;
            const left = dx * dx + dy * dy + dz * dz > 0.0004
                || Math.abs(q.x * a.qx + q.y * a.qy + q.z * a.qz + q.w * a.qw) < 0.99985;
            if (left) {
                a.x = p.x; a.y = p.y; a.z = p.z; a.qx = q.x; a.qy = q.y; a.qz = q.z; a.qw = q.w; a.t = 0;
            } else {
                a.t += STEP;
            }
            const resting = sleeping || (a.t > 0.5 && b.grounded);
            if (resting) {
                b.p.set(a.x, a.y, a.z); b.q.set(a.qx, a.qy, a.qz, a.qw);
                b.v.set(0, 0, 0); b.w.set(0, 0, 0);
                b.pp.copy(b.p); b.pq.copy(b.q);
            } else {
                if (onImpact) {
                    const dv = Math.hypot(v.x - b.v.x, v.y - b.v.y + GRAVITY * STEP, v.z - b.v.z);
                    if (dv > 2.4) onImpact(b, dv);
                }
                b.p.set(p.x, p.y, p.z); b.q.set(q.x, q.y, q.z, q.w);
                b.v.set(v.x, v.y, v.z); b.w.set(w.x, w.y, w.z);
            }
            b.settled = sleeping;
            b.asleep = resting;
        }
    }

    dispose() {
        try { this.world.free(); } catch { /* already gone */ }
        this.cars.clear();
        this.world = null;
    }
}
