// damageSignature.js — material-true damage at the exact contact point (deck idea #3).
//
// A generic debris burst says "something was hit". A signature says WHAT: steel throws hot
// sparks and leaves a dent, stone cracks and smokes with dust, wood chips, glass glitters,
// dirt leaves a scuff and a cloud, water splashes. impactMaterials.js already knows those
// facts (shared with debris physics and impact audio); this module turns one signature into
// marks and particles:
//
//   • a decal — kind, size, colour and lifetime — handed to the engine's own decal field
//     through a tiny adapter ({ stamp(position, normal, {radius, color, life}) }), so each
//     engine keeps its projector and its budget;
//   • chips, sparks and dust in pooled InstancedMeshes (instancedPool.js), thrown into the
//     hemisphere of the surface normal: nothing allocated per particle.
//
// planSignature() is the pure half (numbers in, numbers out) for tests; createDamageSignature()
// wires it to three.js. Counts follow the quality tier and are capped per hit.

import { signature } from './impactMaterials.js';
import { createPoolRegistry } from './instancedPool.js';

/** Decal colour per kind (dark marks on a lit surface). */
const DECAL_TINT = Object.freeze({
    dent: 0x2a2c30, scorch: 0x140f0b, crack: 0x1d1b19, chip: 0x3b2a18, scuff: 0x2b2420, splash: 0x0d1a24,
});
const DECAL_LIFE = Object.freeze({ dent: 0, scorch: 0, crack: 0, chip: 40, scuff: 30, splash: 4 });

const TIER_MULT = Object.freeze({ low: 0.35, medium: 0.7, high: 1 });
const MAX_PER_HIT = 48;

/**
 * Pure plan for one hit.
 * @param {string} materialTag
 * @param {number} impulse
 * @param {{tier?:string, full?:number}} [opts]
 */
export function planSignature(materialTag, impulse, opts = {}) {
    const sig = signature(materialTag, impulse, { full: opts.full });
    const mult = TIER_MULT[opts.tier] ?? 1;
    const p = sig.particles;
    const total = Math.min(MAX_PER_HIT, Math.round(p.count * mult));
    // Split the budget by what the material throws.
    const wSpark = p.sparks, wDust = p.dust, wChip = Math.max(0.15, 1 - p.dust * 0.5 - p.wet);
    const wSum = wSpark + wDust + wChip + p.wet || 1;
    const sparks = Math.round(total * wSpark / wSum);
    const dust = Math.round(total * wDust / wSum);
    const drops = Math.round(total * p.wet / wSum);
    const chips = Math.max(0, total - sparks - dust - drops);
    const kind = sig.decal === 'dent' && p.heat > 0.45 ? 'scorch' : sig.decal;
    return {
        material: sig.material,
        energy: sig.energy,
        decal: kind === 'none' ? null : {
            kind,
            radius: sig.decalSize,
            color: DECAL_TINT[kind] ?? 0x1a1410,
            life: DECAL_LIFE[kind] ?? 0,
        },
        chips, sparks, dust, drops,
        palette: p.palette,
        heat: p.heat,
        speed: 2 + sig.energy * 7,
    };
}

/** Deterministic hemisphere direction around normal n for slot k (no allocation; writes out). */
export function hemisphereDir(nx, ny, nz, k, spread, out) {
    // Golden-angle spiral around the normal: an even spray without Math.random.
    const a = k * 2.39996;
    const r = spread * Math.sqrt(((k * 0.618034) % 1));
    // Any vector not parallel to n, then two tangents.
    let tx = Math.abs(ny) < 0.9 ? 0 : 1, ty = Math.abs(ny) < 0.9 ? 1 : 0, tz = 0;
    // t1 = normalize(cross(t, n))
    let ux = ty * nz - tz * ny, uy = tz * nx - tx * nz, uz = tx * ny - ty * nx;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    // t2 = cross(n, t1)
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    let dx = nx + ux * ca + vx * sa, dy = ny + uy * ca + vy * sa, dz = nz + uz * ca + vz * sa;
    const dl = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / dl; out[1] = dy / dl; out[2] = dz / dl;
    return out;
}

function liveTier() {
    try { return (typeof window !== 'undefined' && window.PoQuality?.tier?.()) || 'high'; } catch { return 'high'; }
}

/**
 * @param {{ THREE: any, parent: any, decals?: { stamp(p:any, n:any, o:any):void }, floorY?: number }} deps
 */
export function createDamageSignature({ THREE, parent, decals = null, floorY = -Infinity }) {
    const pools = createPoolRegistry(THREE, parent);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const flake = new THREE.PlaneGeometry(1, 1);
    const chipPool = () => pools.get('chips', () => ({
        capacity: 384, geometry: box, gravity: -14, drag: 0.4, floorY, bounce: 0.35,
        material: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    }));
    const sparkPool = () => pools.get('sparks', () => ({
        capacity: 256, geometry: box, gravity: -9, drag: 1.4, floorY, bounce: 0.5,
        material: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    }));
    const dustPool = () => pools.get('dust', () => ({
        capacity: 192, geometry: flake, gravity: 0.6, drag: 2.2,
        material: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
    }));
    const dir = [0, 1, 0];
    let seq = 0;

    /**
     * One hit.
     * @param {{x:number,y:number,z:number}} point
     * @param {{x:number,y:number,z:number}|null} normal
     * @param {string} materialTag
     * @param {number} impulse
     * @param {{full?:number, floorY?:number, decalScale?:number, decalLife?:number}} [opts]
     *        floorY — ground under the hit, so chips land on uneven terrain
     */
    function hit(point, normal, materialTag, impulse, opts = {}) {
        const tier = liveTier();
        const plan = planSignature(materialTag, impulse, { tier, full: opts.full });
        const nx = normal?.x ?? 0, ny = normal?.y ?? 1, nz = normal?.z ?? 0;
        if (plan.decal && decals && opts.decal !== false) {
            try { decals.stamp(point, normal, { radius: plan.decal.radius * (opts.decalScale ?? 1), color: plan.decal.color, life: opts.decalLife ?? plan.decal.life }); }
            catch { /* the engine's field may be disabled at this tier */ }
        }
        const pal = plan.palette;
        const lift = 0.02;
        const px = point.x + nx * lift, py = point.y + ny * lift, pz = point.z + nz * lift;
        const ground = Number.isFinite(opts.floorY) ? opts.floorY : floorY;
        if (plan.chips) {
            const pool = chipPool();
            for (let i = 0; i < plan.chips; i++) {
                hemisphereDir(nx, ny, nz, seq++, 0.9, dir);
                const v = plan.speed * (0.5 + ((seq * 0.37) % 0.6));
                pool.spawn(px, py, pz, dir[0] * v, dir[1] * v, dir[2] * v, 0.9 + ((seq * 0.13) % 0.8),
                    0.05 + plan.energy * 0.12, pal[i % pal.length], ground);
            }
        }
        if (plan.sparks) {
            const pool = sparkPool();
            const hot = plan.heat > 0.3 ? 0xffb347 : pal[0];
            for (let i = 0; i < plan.sparks; i++) {
                hemisphereDir(nx, ny, nz, seq++, 1.2, dir);
                const v = plan.speed * 1.6;
                pool.spawn(px, py, pz, dir[0] * v, dir[1] * v, dir[2] * v, 0.25 + ((seq * 0.11) % 0.3), 0.035, i & 1 ? hot : pal[0], ground);
            }
        }
        if (plan.dust || plan.drops) {
            const pool = dustPool();
            const n = plan.dust + plan.drops;
            for (let i = 0; i < n; i++) {
                hemisphereDir(nx, ny, nz, seq++, 1.4, dir);
                const v = plan.speed * 0.35;
                pool.spawn(px, py, pz, dir[0] * v, dir[1] * v, dir[2] * v, 1.2 + ((seq * 0.17) % 1),
                    0.3 + plan.energy * 0.8, i < plan.drops ? 0xd8eeff : pal[(i + 1) % pal.length]);
            }
        }
        return plan;
    }

    return {
        hit,
        update(dt) { pools.update(dt); },
        clear() { pools.clear(); },
        dispose() { pools.dispose(); box.dispose(); flake.dispose(); },
    };
}

if (typeof window !== 'undefined') {
    window.PoDamageSignature = { planSignature, hemisphereDir, createDamageSignature };
}
