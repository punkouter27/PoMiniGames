// instancedPool.js — fixed GPU pools for recurring bursts (deck idea #5).
//
// Sparks, chips, grit, tyre spray: every engine spawns these by the hundred, and the
// expensive way is a Mesh (or a Points buffer re-uploaded whole) per burst, plus a few
// small objects per particle that the GC then has to find. A pool is one InstancedMesh
// per EFFECT TYPE, allocated once at its full capacity and never resized:
//
//   • state lives in flat Float32Arrays (position, velocity, life, size, spin) — spawn()
//     writes numbers into a slot; nothing is allocated per particle, ever;
//   • update() integrates and writes the instance matrices straight into the attribute's
//     array (no Matrix4/Quaternion per instance), then sets `count` to the live high-water
//     mark so the GPU draws only what is alive;
//   • the VISIBLE cap follows the quality tier (tierCap): a low-tier device keeps a quarter
//     of the slots, and a spawn past the cap recycles the oldest live slot instead of growing.
//
// THREE is passed in, so this module carries no import of its own and engines on either of
// the app's three builds can use it. tierCap() is pure, for tests.

/** Share of a pool's capacity that may be visible at each PoQuality tier. */
export const TIER_SHARE = Object.freeze({ low: 0.25, medium: 0.6, high: 1 });

/** Visible slots for `capacity` at `tier`, never below 1 for a non-empty pool. */
export function tierCap(capacity, tier) {
    const c = Math.max(0, capacity | 0);
    if (c === 0) return 0;
    const share = TIER_SHARE[tier] ?? 1;
    return Math.max(1, Math.floor(c * share));
}

function liveTier() {
    try { return (typeof window !== 'undefined' && window.PoQuality?.tier?.()) || 'high'; } catch { return 'high'; }
}

export class InstancedPool {
    /**
     * @param {typeof import('three')} THREE
     * @param {import('three').Object3D} parent scene or group to add the mesh to
     * @param {{ capacity:number, geometry?:any, material?:any, gravity?:number, drag?:number,
     *           floorY?:number, bounce?:number, name?:string, tier?:string }} opts
     */
    constructor(THREE, parent, opts) {
        this.THREE = THREE;
        this.capacity = Math.max(1, opts.capacity | 0);
        this.gravity = opts.gravity ?? -9.8;
        this.drag = opts.drag ?? 0.6;
        this.floorY = opts.floorY ?? -Infinity;
        this.bounce = opts.bounce ?? 0.3;
        const n = this.capacity;
        this.pos = new Float32Array(n * 3);
        this.vel = new Float32Array(n * 3);
        this.life = new Float32Array(n);      // seconds left; <= 0 is a free slot
        this.maxLife = new Float32Array(n);
        this.size = new Float32Array(n);
        this.spin = new Float32Array(n * 2);  // angle, angular speed
        this.floor = new Float32Array(n);     // per-slot ground height (uneven terrain)
        this.cursor = 0;
        this.highWater = 0;
        this.setTier(opts.tier ?? liveTier());

        const geometry = opts.geometry ?? new THREE.BoxGeometry(1, 1, 1);
        const material = opts.material ?? new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
        this.mesh = new THREE.InstancedMesh(geometry, material, n);
        this.mesh.name = opts.name || 'po-instanced-pool';
        this.mesh.frustumCulled = false;   // the instances roam; one bounding sphere would be wrong
        this.mesh.count = 0;
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Per-instance colour, written directly into the attribute like the matrices.
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
        this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        this._ownsGeometry = !opts.geometry;
        this._ownsMaterial = !opts.material;
        parent?.add?.(this.mesh);
        this.parent = parent;
    }

    /** Re-read the tier cap (call from a PoQuality.onChange listener or each burst). */
    setTier(tier) {
        this.cap = tierCap(this.capacity, tier);
        if (this.cursor >= this.cap) this.cursor = 0;
    }

    /**
     * Claim a slot. Returns the slot index. Colour is 0xRRGGBB; `floor` is where this one
     * lands (defaults to the pool's floorY).
     * Past the tier cap the oldest slot inside the cap is recycled.
     */
    spawn(x, y, z, vx, vy, vz, life, size, color = 0xffffff, floor = this.floorY) {
        const i = this.cursor;
        this.cursor = (i + 1) % this.cap;
        const o = i * 3;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
        this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
        this.life[i] = life; this.maxLife[i] = life;
        this.size[i] = size;
        this.floor[i] = floor;
        this.spin[i * 2] = (i * 2.399) % 6.283;
        this.spin[i * 2 + 1] = 4 + ((i * 7) % 9);
        const c = this.mesh.instanceColor.array;
        c[o] = ((color >> 16) & 255) / 255;
        c[o + 1] = ((color >> 8) & 255) / 255;
        c[o + 2] = (color & 255) / 255;
        this.mesh.instanceColor.needsUpdate = true;
        if (i + 1 > this.highWater) this.highWater = i + 1;
        return i;
    }

    /** Integrate and write matrices. Allocation-free. */
    update(dt) {
        if (!(dt > 0)) return;
        const m = this.mesh.instanceMatrix.array;
        const damp = Math.exp(-this.drag * dt);
        let top = 0;
        for (let i = 0; i < this.highWater; i++) {
            const k = i * 16;
            if (this.life[i] <= 0) {
                // Free slot: collapse to zero scale so it draws nothing.
                m[k] = 0; m[k + 5] = 0; m[k + 10] = 0; m[k + 15] = 1;
                continue;
            }
            top = i + 1;
            this.life[i] -= dt;
            const o = i * 3;
            this.vel[o + 1] += this.gravity * dt;
            this.vel[o] *= damp; this.vel[o + 1] *= damp; this.vel[o + 2] *= damp;
            this.pos[o] += this.vel[o] * dt;
            this.pos[o + 1] += this.vel[o + 1] * dt;
            this.pos[o + 2] += this.vel[o + 2] * dt;
            if (this.pos[o + 1] < this.floor[i]) {
                this.pos[o + 1] = this.floor[i];
                this.vel[o + 1] = -this.vel[o + 1] * this.bounce;
                this.vel[o] *= 0.6; this.vel[o + 2] *= 0.6;
            }
            const a = (this.spin[i * 2] += this.spin[i * 2 + 1] * dt);
            // Shrink over the last 40% of life.
            const t = this.life[i] / this.maxLife[i];
            const s = Math.max(0, this.size[i] * (t < 0.4 ? t / 0.4 : 1));
            const c = Math.cos(a) * s, sn = Math.sin(a) * s;
            // Rotation about Y then X tilt baked as a simple Y-spin: cheap and reads as tumbling.
            m[k] = c;   m[k + 1] = 0; m[k + 2] = -sn; m[k + 3] = 0;
            m[k + 4] = 0; m[k + 5] = s; m[k + 6] = 0;  m[k + 7] = 0;
            m[k + 8] = sn; m[k + 9] = 0; m[k + 10] = c; m[k + 11] = 0;
            m[k + 12] = this.pos[o]; m[k + 13] = this.pos[o + 1]; m[k + 14] = this.pos[o + 2]; m[k + 15] = 1;
        }
        this.highWater = top;
        this.mesh.count = top;
        this.mesh.instanceMatrix.needsUpdate = true;
    }

    clear() {
        this.life.fill(0);
        this.highWater = 0;
        this.mesh.count = 0;
    }

    dispose() {
        this.parent?.remove?.(this.mesh);
        if (this._ownsGeometry) this.mesh.geometry.dispose();
        if (this._ownsMaterial) this.mesh.material.dispose();
        this.mesh.dispose?.();
    }
}

/**
 * Warm pools keyed by effect type, created on first use and kept for the engine's life.
 * `registry.get('sparks', () => ({ capacity: 256, … }))`.
 */
export function createPoolRegistry(THREE, parent) {
    const pools = new Map();
    let tierBound = false;
    function bindTier() {
        if (tierBound || typeof window === 'undefined' || !window.PoQuality?.onChange) return;
        tierBound = true;
        window.PoQuality.onChange((t) => { for (const p of pools.values()) p.setTier(t); });
    }
    return {
        get(type, optsFactory) {
            let p = pools.get(type);
            if (!p) {
                p = new InstancedPool(THREE, parent, { name: `po-pool-${type}`, ...optsFactory() });
                pools.set(type, p);
                bindTier();
            }
            return p;
        },
        update(dt) { for (const p of pools.values()) p.update(dt); },
        clear() { for (const p of pools.values()) p.clear(); },
        dispose() { for (const p of pools.values()) p.dispose(); pools.clear(); },
        get size() { return pools.size; },
    };
}

if (typeof window !== 'undefined') {
    window.PoInstancedPool = { TIER_SHARE, tierCap, InstancedPool, createPoolRegistry };
}
