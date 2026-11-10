// PoCapitol's contact physics: presentation-free, deterministic, and cheap enough for 250 bodies.
//
// What it adds over "move if the end point is walkable":
//   continuous collision   every move is swept in sub-steps no longer than SWEEP_STEP, and a
//                          round is tested as a segment against each body, so nothing hops a
//                          column, a wall or a person however fast it goes
//   real masses            every body has a mass in kilograms; a collision shares the
//                          correction and the momentum by mass ratio, so a 95 kg officer in
//                          gear barely gives way to a 58 kg raider and the reverse is not true
//   momentum exchange      a strike is an impulse J = (1 + e) * v_closing * m1 * m2 / (m1 + m2),
//                          the target leaves with J / m2 and the striker recoils with J / m1;
//                          the energy lost is reported so sound and effects can scale with it
//   a spatial hash         neighbors come from a uniform grid, not from comparing everyone with
//                          everyone
//
// Knockback is a velocity (`kx`, `kz`) that ground friction bleeds off, never a teleport.

export const SWEEP_STEP = 0.15;
/** Closest two standing bodies can sit (shoulder width plus a little air), meters. */
export const MIN_GAP = 0.68;
/** Bounce of body against body, and of a body against a wall. */
export const BODY_RESTITUTION = 0.12;
export const WALL_RESTITUTION = 0.25;
/** Shoes on stone or turf: deceleration while sliding, m/s^2. */
export const GROUND_FRICTION = 6;
export const MAX_KNOCK = 6;
export const DEFAULT_MASS = 75;

export const massOf = actor => actor.mass > 0 ? actor.mass : DEFAULT_MASS;

/**
 * What a strike is: how much of the striker's mass is behind it and how fast it lands.
 * A shove is the torso leaning in; a baton is an arm and a stick; a rammed barrier is the
 * whole crowd at a walking pace.
 */
export const STRIKES = {
    shove: { share: 0.8, speed: 4.2 },
    baton: { share: 0.03, speed: 13 },
    lean: { share: 0.7, speed: 3.2 },
};

/** A uniform grid of items by position. Rebuilt every step; allocation-free once warm. */
export function createGrid(cell = 1.25) {
    const buckets = new Map(), pool = [];
    const keyOf = (cx, cz) => (cx + 1024) * 4096 + (cz + 1024);
    return {
        clear() {
            for (const bucket of buckets.values()) { bucket.length = 0; pool.push(bucket); }
            buckets.clear();
        },
        insert(item, x, z) {
            const key = keyOf(Math.floor(x / cell), Math.floor(z / cell));
            let bucket = buckets.get(key);
            if (!bucket) { bucket = pool.pop() ?? []; buckets.set(key, bucket); }
            bucket.push(item);
        },
        /** Calls visit(item) for every item in a cell the circle (x, z, radius) touches. */
        query(x, z, radius, visit) {
            const x0 = Math.floor((x - radius) / cell), x1 = Math.floor((x + radius) / cell);
            const z0 = Math.floor((z - radius) / cell), z1 = Math.floor((z + radius) / cell);
            for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
                const bucket = buckets.get(keyOf(cx, cz));
                if (bucket) for (const item of bucket) visit(item);
            }
        },
    };
}

/**
 * Moves (x, z) toward (nx, nz) in sub-steps, sliding along whatever blocks one axis.
 * `ok(x, z)` says whether a point can be stood on. Returns `out` with the final position
 * and which axes were stopped.
 */
export function sweep(x, z, nx, nz, ok, out = {}) {
    const dx = nx - x, dz = nz - z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SWEEP_STEP));
    const sx = dx / steps, sz = dz / steps;
    let cx = x, cz = z, hitX = false, hitZ = false;
    for (let i = 0; i < steps && !(hitX && hitZ); i++) {
        if (!hitX) { if (ok(cx + sx, cz)) cx += sx; else hitX = sx !== 0; }
        if (!hitZ) { if (ok(cx, cz + sz)) cz += sz; else hitZ = sz !== 0; }
    }
    out.x = cx; out.z = cz; out.hitX = hitX; out.hitZ = hitZ;
    return out;
}

/** Fraction (0..1) along a segment where it first enters a circle, or -1 if it never does. */
export function segmentCircle(ax, az, bx, bz, cx, cz, radius) {
    const dx = bx - ax, dz = bz - az, fx = ax - cx, fz = az - cz;
    const c = fx * fx + fz * fz - radius * radius;
    if (c <= 0) return 0;
    const a = dx * dx + dz * dz;
    if (a < 1e-12) return -1;
    const b = 2 * (fx * dx + fz * dz), disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
}

/** Fraction (0..1) along a segment up to the last point that is still open, or -1 if all of it is. */
export function firstBlocked(ax, az, bx, bz, ok, step = 0.2) {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let i = 1; i <= steps; i++) {
        if (!ok(ax + (bx - ax) * i / steps, az + (bz - az) * i / steps)) return (i - 1) / steps;
    }
    return -1;
}

const velocityAlong = (actor, nx, nz) => (actor.kx ?? 0) * nx + (actor.kz ?? 0) * nz;

/**
 * Shares one impact between two bodies. `n` is the unit vector from `a` toward `b`;
 * `closing` is how fast they approach along it (m/s). Both bodies' knockback velocities are
 * changed and the kinetic energy that went into the collision (joules) is returned.
 * `aMass` lets a strike bring only part of the striker's mass (an arm, not a whole body).
 */
export function exchange(a, b, nx, nz, closing, restitution = BODY_RESTITUTION, aMass = massOf(a)) {
    if (closing <= 0) return 0;
    const bMass = massOf(b), reduced = aMass * bMass / (aMass + bMass);
    const impulse = (1 + restitution) * closing * reduced;
    // The striker's recoil is its own whole body: only the striking part carried the momentum.
    const recoil = impulse / massOf(a);
    addKnock(b, nx * impulse / bMass, nz * impulse / bMass);
    addKnock(a, -nx * recoil, -nz * recoil);
    return 0.5 * reduced * closing * closing * (1 - restitution * restitution);
}
function addKnock(actor, vx, vz) {
    const x = (actor.kx ?? 0) + vx, z = (actor.kz ?? 0) + vz;
    const speed = Math.hypot(x, z), scale = speed > MAX_KNOCK ? MAX_KNOCK / speed : 1;
    actor.kx = x * scale; actor.kz = z * scale;
}

/**
 * A deliberate strike (shove, baton) from `attacker` toward unit (dx, dz) at `target`.
 * Returns the energy of the blow in joules.
 */
export function strike(attacker, target, dx, dz, kind = 'shove') {
    const { share, speed } = STRIKES[kind];
    const closing = speed + velocityAlong(attacker, dx, dz) - velocityAlong(target, dx, dz);
    return exchange(attacker, target, dx, dz, closing, BODY_RESTITUTION, massOf(attacker) * share);
}

/** Bleeds a body's knockback with ground friction. Returns its speed before this step. */
export function slide(actor, dt) {
    const kx = actor.kx ?? 0, kz = actor.kz ?? 0, speed = Math.hypot(kx, kz);
    if (speed === 0) return 0;
    const left = Math.max(0, speed - GROUND_FRICTION * dt);
    if (left < 0.04) { actor.kx = actor.kz = 0; return speed; }
    actor.kx = kx * left / speed; actor.kz = kz * left / speed;
    return speed;
}

/** Reflects the knockback components a wall stopped; returns the impact energy (joules). */
export function bounce(actor, hitX, hitZ, speedBefore) {
    if (!hitX && !hitZ) return 0;
    if (hitX) actor.kx = -(actor.kx ?? 0) * WALL_RESTITUTION;
    if (hitZ) actor.kz = -(actor.kz ?? 0) * WALL_RESTITUTION;
    return 0.5 * massOf(actor) * speedBefore * speedBefore * (1 - WALL_RESTITUTION * WALL_RESTITUTION);
}
