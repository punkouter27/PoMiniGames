// debrisField.js — directed rigid-body debris (deck idea #10).
//
// A generic "chunks fly everywhere" burst throws away the one thing the player just
// saw: which way the hit went. Here every chunk's launch velocity is built from
//   • the blast direction (a cone around it, never a sphere),
//   • the chunk's mass (impactMaterials density × volume — stone flies less than wood),
//   • the parent's momentum (a crate knocked off a moving car keeps the car's motion),
// and the field keeps a strict budget: a max live count (oldest go first), a max age,
// and chunks that leave the view or come to rest next to another resting chunk are
// despawned or merged.
//
// Pure and seeded: spawnBatch() with the same seed returns the same chunks, so a replay
// or a test sees exactly the burst the player saw. No three.js — engines copy x/y/z and
// the angular velocity onto their own meshes.

import { material } from './impactMaterials.js';

/** Small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function unit(v) {
    const l = Math.hypot(v.x || 0, v.y || 0, v.z || 0);
    return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 1, z: 0 };
}

/**
 * One batch of chunks for one blast.
 * @param {object} o
 * @param {{x,y,z}} o.origin
 * @param {{x,y,z}} o.dir           blast direction (need not be unit)
 * @param {number}  o.impulse       N·s handed to the batch, shared across chunks
 * @param {string}  [o.material]    impactMaterials tag
 * @param {{x,y,z}} [o.parentVelocity]  momentum carried from the broken object
 * @param {number}  [o.count=6]
 * @param {number}  [o.seed=1]
 * @param {number}  [o.spread=0.45] cone half-width (0 = all along dir, 1 ≈ hemisphere)
 * @param {number}  [o.volume=0.002] m³ per chunk
 * @param {number}  [o.lift=0.35]   extra upward bias so chunks arc instead of skimming
 * @param {number}  [o.maxSpeed=14]
 * @param {number}  [o.life=1.6]    seconds
 */
export function spawnBatch(o) {
    const rnd = mulberry32(o.seed ?? 1);
    const m = material(o.material);
    const count = Math.max(0, Math.floor(o.count ?? 6));
    const spread = o.spread ?? 0.45;
    const lift = o.lift ?? 0.35;
    const maxSpeed = o.maxSpeed ?? 14;
    const vol = o.volume ?? 0.002;
    const pv = o.parentVelocity || { x: 0, y: 0, z: 0 };
    const d = unit(o.dir || { x: 0, y: 1, z: 0 });
    const origin = o.origin || { x: 0, y: 0, z: 0 };
    const share = (o.impulse ?? 10) / Math.max(1, count);
    const out = [];
    for (let i = 0; i < count; i++) {
        // Per-chunk volume jitter → per-chunk mass: small chips fly further.
        const v = vol * (0.5 + rnd());
        const mass = m.density * v * 1000;
        const speed = Math.min(maxSpeed, (share / mass) * (0.7 + rnd() * 0.6));
        const jx = (rnd() * 2 - 1) * spread, jy = (rnd() * 2 - 1) * spread + lift, jz = (rnd() * 2 - 1) * spread;
        const dir = unit({ x: d.x + jx, y: d.y + jy, z: d.z + jz });
        out.push({
            x: origin.x, y: origin.y, z: origin.z,
            vx: dir.x * speed + pv.x, vy: dir.y * speed + pv.y, vz: dir.z * speed + pv.z,
            ax: (rnd() - 0.5) * 10, ay: (rnd() - 0.5) * 10, az: (rnd() - 0.5) * 10,
            mass, size: Math.cbrt(v), age: 0, life: (o.life ?? 1.6) * (0.8 + rnd() * 0.4),
            restitution: m.restitution, resting: false, ref: null,
        });
    }
    return out;
}

/**
 * A budgeted live set of chunks.
 * @param {object} [opts]
 * @param {number} [opts.maxCount=64]
 * @param {number} [opts.maxAge=4]
 * @param {number} [opts.gravity=-9.8]
 * @param {number} [opts.floorY=0]
 * @param {number} [opts.mergeRadius=0.12] resting chunks closer than this merge
 * @param {(c:object)=>void} [opts.onRemove] release an engine mesh
 */
export function createDebrisField(opts = {}) {
    const maxCount = opts.maxCount ?? 64;
    const maxAge = opts.maxAge ?? 4;
    const g = opts.gravity ?? -9.8;
    const floorY = opts.floorY ?? 0;
    const mergeR2 = (opts.mergeRadius ?? 0.12) ** 2;
    const onRemove = opts.onRemove || null;
    const items = [];

    function removeAt(i) {
        const c = items[i];
        items[i] = items[items.length - 1];
        items.pop();
        if (onRemove) onRemove(c);
    }

    return {
        items,
        get count() { return items.length; },
        /** Add a batch; the oldest chunks go first if the budget overflows. */
        add(batch) {
            for (const c of batch) items.push(c);
            if (items.length > maxCount) {
                items.sort((a, b) => b.age - a.age);
                while (items.length > maxCount) {
                    const c = items.shift();
                    if (onRemove) onRemove(c);
                }
            }
        },
        /**
         * Integrate. `isVisible(x,y,z)` (optional) despawns chunks that left the view
         * after their first quarter-second (so a burst at the frame edge still reads).
         */
        step(dt, isVisible) {
            for (let i = items.length - 1; i >= 0; i--) {
                const c = items[i];
                c.age += dt;
                if (c.age > c.life || c.age > maxAge) { removeAt(i); continue; }
                if (isVisible && c.age > 0.25 && !isVisible(c.x, c.y, c.z)) { removeAt(i); continue; }
                if (c.resting) continue;
                c.vy += g * dt;
                c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
                if (c.y < floorY + c.size * 0.5) {
                    c.y = floorY + c.size * 0.5;
                    c.vy = -c.vy * c.restitution;
                    c.vx *= 0.7; c.vz *= 0.7;
                    c.ax *= 0.6; c.ay *= 0.6; c.az *= 0.6;
                    if (Math.abs(c.vy) < 0.4 && Math.hypot(c.vx, c.vz) < 0.3) {
                        c.resting = true; c.vx = c.vy = c.vz = 0; c.ax = c.ay = c.az = 0;
                    }
                }
            }
            // Merge resting neighbours: the pile keeps its mass, the scene loses a mesh.
            for (let i = items.length - 1; i >= 0; i--) {
                const a = items[i];
                if (!a.resting) continue;
                for (let j = i - 1; j >= 0; j--) {
                    const b = items[j];
                    if (!b.resting) continue;
                    const dx = a.x - b.x, dz = a.z - b.z;
                    if (dx * dx + dz * dz < mergeR2) {
                        b.mass += a.mass;
                        b.size = Math.cbrt(b.size ** 3 + a.size ** 3);
                        removeAt(i);
                        break;
                    }
                }
            }
        },
        clear() { while (items.length) removeAt(items.length - 1); },
    };
}
