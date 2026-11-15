import { GROUND_FRICTION, WALL_RESTITUTION, DEFAULT_MASS } from './physics.js';

// The bike racks once they are no longer a line: loose steel on the ground.
//
// While the first line holds, world.js owns each rack: it leans, rocks and finally goes over.
// From that moment the simulation is finished with it (the crowd simply stands closer), and until
// now the picture was too: a fallen rack lay where a formula put it. Here each one becomes a
// rigid body on the ground plane. It tips over under gravity and bounces once when it lands;
// people walking into it shove it along and spin it, in proportion to their mass and speed
// against its own; it grinds to a stop on friction; and two racks that meet push apart, or, if
// one is driven onto the other, ride up and rest across it.
//
// It is part of the simulation (world.js steps it): steel on the ground is in the way, so anyone
// crossing a loose rack is slowed for as long as they are on it. Pure arithmetic, so it can be
// tested without three.js.

/** A steel crowd-control barrier: about 2.5 m long and 18 kg, with flat feet that drag. */
export const RACK_MASS = 18, RACK_HALF = 1.35, RACK_DEPTH = 0.32;
/** Share of a step lost by someone crossing a rack on the ground, and a pile of two. */
export const RACK_DRAG = 0.42, PILE_DRAG = 0.6;
/** How far up a rack sits when it has come to rest across another. */
export const STACK_LIFT = 0.16;
const GRAVITY = 9.81;

/**
 * @param count  how many racks there are
 * @returns bodies and the functions that move them. Each body is
 *   `{ free, x, z, yaw, tip (0 upright .. 1 flat), y (lift), vx, vz, spin, roll }`.
 */
export function createBarricades(count) {
    const bodies = Array.from({ length: count }, (_, id) => ({
        id, free: false, x: 0, z: 0, yaw: 0, tip: 0, tipSpeed: 0, landed: false, y: 0, vx: 0, vz: 0, spin: 0, roll: 0,
    }));

    /**
     * Hands one rack over from the scripted line to the ground.
     * @param pose   where it stood: `{ x, z, yaw, tip }`
     * @param shove  the velocity it leaves with, m/s
     */
    function release(i, pose, shove = { x: 0, z: 0 }) {
        const b = bodies[i];
        if (!b || b.free) return;
        Object.assign(b, { free: true, x: pose.x, z: pose.z, yaw: pose.yaw ?? 0, tip: Math.min(0.95, pose.tip ?? 0),
            tipSpeed: 0.4, landed: false, y: 0, vx: shove.x ?? 0, vz: shove.z ?? 0, spin: 0, roll: (i % 2 ? 1 : -1) * 0.08 });
    }

    /** The two ends of a rack on the ground. */
    function ends(b) {
        const cx = Math.cos(b.yaw) * RACK_HALF, cz = -Math.sin(b.yaw) * RACK_HALF;
        return [b.x - cx, b.z - cz, b.x + cx, b.z + cz];
    }
    /** Closest point on a rack's length to (px, pz), as a 0..1 fraction and its distance. */
    function nearest(b, px, pz) {
        const [ax, az, bx, bz] = ends(b);
        const dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
        const qx = ax + dx * t, qz = az + dz * t;
        return { t, x: qx, z: qz, distance: Math.hypot(px - qx, pz - qz) };
    }

    /**
     * One step.
     * @param actors   people on their feet: `{ x, z, vx, vz, mass }`
     * @param blocked  (x, z) => true inside a wall, a column or the stands
     * @returns what happened, for dust and sound: `[{ type: 'land' | 'scrape' | 'clash', x, z, energy }]`
     */
    function step(dt, actors = [], blocked = () => false) {
        const events = [];
        for (const b of bodies) {
            if (!b.free) continue;
            // Going over: a falling rod, faster the further it has already gone.
            if (!b.landed) {
                b.tipSpeed += GRAVITY / 1.1 * Math.sin(Math.max(0.12, b.tip * Math.PI / 2)) * dt;
                b.tip += b.tipSpeed * dt * 0.64;
                if (b.tip >= 1) {
                    b.tip = 1;
                    const energy = 0.5 * RACK_MASS * (b.tipSpeed * 1.1) ** 2;
                    events.push({ type: 'land', x: b.x, z: b.z, energy });
                    // One bounce if it came down hard, then it stays down.
                    if (b.tipSpeed > 1.6 && !b.bounced) { b.bounced = true; b.tipSpeed = -b.tipSpeed * 0.28; b.tip = 0.999; }
                    else { b.landed = true; b.tipSpeed = 0; }
                }
            }
            // People wading through it: each one within reach shares momentum with the rack.
            const speedBefore = Math.hypot(b.vx, b.vz);
            for (const a of actors) {
                if (Math.abs(a.x - b.x) > RACK_HALF + 0.6 || Math.abs(a.z - b.z) > RACK_HALF + 0.6) continue;
                const hit = nearest(b, a.x, a.z);
                if (hit.distance > RACK_DEPTH + 0.3) continue;
                const avx = a.vx ?? 0, avz = a.vz ?? 0;
                if (avx * avx + avz * avz < 0.04) continue;
                const mass = a.mass > 0 ? a.mass : DEFAULT_MASS;
                // A person is four times the rack's mass, so the rack takes most of their speed.
                const share = Math.min(1, mass / (mass + RACK_MASS) * dt * 7);
                const dvx = (avx - b.vx) * share, dvz = (avz - b.vz) * share;
                b.vx += dvx; b.vz += dvz;
                // Pushed off-centre it turns: torque is the lever arm crossed with the push.
                const rx = hit.x - b.x, rz = hit.z - b.z;
                b.spin += (rz * dvx - rx * dvz) / (RACK_HALF * RACK_HALF) * 1.4;
            }
            const drag = Math.exp(-dt * GROUND_FRICTION * (b.landed ? 0.55 : 0.3));
            b.vx *= drag; b.vz *= drag; b.spin *= Math.exp(-dt * 3.5);
            const nx = b.x + b.vx * dt, nz = b.z + b.vz * dt;
            if (blocked(nx, nz)) {
                b.vx *= -WALL_RESTITUTION; b.vz *= -WALL_RESTITUTION;
            } else { b.x = nx; b.z = nz; }
            b.yaw += b.spin * dt;
            const speed = Math.hypot(b.vx, b.vz);
            if (b.landed && speed > 1.2 && speedBefore <= 1.2) events.push({ type: 'scrape', x: b.x, z: b.z, energy: 0.5 * RACK_MASS * speed * speed });
        }
        // Rack against rack. Each is three circles along its length; overlapping circles push
        // their racks apart, and a rack still overlapping another once that is done is on top of it.
        for (const b of bodies) b.over = 0;
        for (let i = 0; i < bodies.length; i++) {
            const a = bodies[i];
            if (!a.free) continue;
            for (let j = i + 1; j < bodies.length; j++) {
                const b = bodies[j];
                if (!b.free || Math.hypot(a.x - b.x, a.z - b.z) > RACK_HALF * 2 + 0.7) continue;
                let deepest = 0, px = 0, pz = 0;
                for (const s of [-0.75, 0, 0.75]) for (const t of [-0.75, 0, 0.75]) {
                    const ax = a.x + Math.cos(a.yaw) * RACK_HALF * s, az = a.z - Math.sin(a.yaw) * RACK_HALF * s;
                    const bx = b.x + Math.cos(b.yaw) * RACK_HALF * t, bz = b.z - Math.sin(b.yaw) * RACK_HALF * t;
                    const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz), overlap = 0.62 - d;
                    if (overlap > deepest) { deepest = overlap; px = d > 1e-4 ? dx / d : 1; pz = d > 1e-4 ? dz / d : 0; }
                }
                if (deepest <= 0) continue;
                const closing = (a.vx - b.vx) * px + (a.vz - b.vz) * pz;
                if (closing > 2.2 || (a.landed && b.landed && deepest > 0.34)) {
                    // Driven together hard, or still deep in each other at rest: the later one
                    // rides up and lies across the other.
                    b.over = Math.max(b.over, 1);
                } else {
                    a.x -= px * deepest * 0.5; a.z -= pz * deepest * 0.5;
                    b.x += px * deepest * 0.5; b.z += pz * deepest * 0.5;
                }
                if (closing > 0.5) {
                    const swap = closing * 0.6;
                    a.vx -= px * swap; a.vz -= pz * swap; b.vx += px * swap; b.vz += pz * swap;
                    events.push({ type: 'clash', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, energy: 0.5 * RACK_MASS * closing * closing });
                }
            }
        }
        const ease = 1 - Math.exp(-dt * 9);
        for (const b of bodies) if (b.free) b.y += ((b.over ? STACK_LIFT : 0) - b.y) * ease;
        return events;
    }

    /**
     * How much a loose rack slows someone standing at (x, z): 0 on clear ground, RACK_DRAG on a
     * rack that is down, PILE_DRAG where one lies across another. A rack still falling is not
     * yet underfoot.
     */
    function dragAt(x, z) {
        let drag = 0;
        for (const b of bodies) {
            if (!b.free || !b.landed || Math.abs(x - b.x) > RACK_HALF + 0.5 || Math.abs(z - b.z) > RACK_HALF + 0.5) continue;
            if (nearest(b, x, z).distance <= RACK_DEPTH + 0.12) drag = Math.max(drag, b.y > STACK_LIFT * 0.5 ? PILE_DRAG : RACK_DRAG);
        }
        return drag;
    }

    function reset() {
        for (const b of bodies) Object.assign(b, { free: false, tip: 0, tipSpeed: 0, landed: false, bounced: false, y: 0, vx: 0, vz: 0, spin: 0 });
    }

    return { bodies, release, step, reset, dragAt };
}
