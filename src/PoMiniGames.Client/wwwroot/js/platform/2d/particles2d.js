// particles2d.js — one pooled 2D particle system for every canvas game.
//
// Flat typed arrays, fixed capacity, oldest slot recycled when full: nothing is allocated per
// particle, so a burst of sparks never feeds the GC. The visible cap follows the quality tier
// (low keeps a quarter, like platform/instancedPool.js does for 3D).

const SHARE = Object.freeze({ low: 0.25, medium: 0.6, high: 1 });

export function createParticles2D(capacity = 512) {
    const x = new Float32Array(capacity), y = new Float32Array(capacity);
    const vx = new Float32Array(capacity), vy = new Float32Array(capacity);
    const life = new Float32Array(capacity), maxLife = new Float32Array(capacity);
    const size = new Float32Array(capacity), grav = new Float32Array(capacity), drag = new Float32Array(capacity);
    const color = new Array(capacity).fill('#fff');
    let cursor = 0;
    let cap = capacity;

    const sys = {
        capacity,
        /** Live count (for tests and debug HUDs). */
        get alive() { let n = 0; for (let i = 0; i < capacity; i++) if (life[i] > 0) n++; return n; },
        setTier(tier) { cap = Math.max(1, Math.floor(capacity * (SHARE[tier] ?? 1))); },

        /**
         * Spray `n` particles from (px, py).
         * @param {{n?:number, speed?:number, spread?:number, angle?:number, life?:number,
         *          size?:number, gravity?:number, drag?:number, color?:string|string[], rand?:()=>number}} [o]
         */
        burst(px, py, o = {}) {
            const rand = o.rand ?? Math.random;
            const n = o.n ?? 12;
            const speed = o.speed ?? 180;
            const spread = o.spread ?? Math.PI * 2;
            const angle = o.angle ?? 0;
            const l = o.life ?? 0.5;
            const colors = Array.isArray(o.color) ? o.color : [o.color ?? '#fff'];
            for (let k = 0; k < n; k++) {
                const i = cursor;
                cursor = (cursor + 1) % cap;
                const a = angle + (rand() - 0.5) * spread;
                const s = speed * (0.4 + 0.6 * rand());
                x[i] = px; y[i] = py;
                vx[i] = Math.cos(a) * s; vy[i] = Math.sin(a) * s;
                maxLife[i] = life[i] = l * (0.6 + 0.4 * rand());
                size[i] = (o.size ?? 3) * (0.6 + 0.4 * rand());
                grav[i] = o.gravity ?? 600;
                drag[i] = o.drag ?? 2;
                color[i] = colors[(k % colors.length)];
            }
        },

        step(dt) {
            for (let i = 0; i < capacity; i++) {
                if (life[i] <= 0) continue;
                life[i] -= dt;
                const f = Math.exp(-drag[i] * dt);
                vx[i] *= f; vy[i] = vy[i] * f + grav[i] * dt;
                x[i] += vx[i] * dt; y[i] += vy[i] * dt;
            }
        },

        /** Draw as squares (cheap, crisp). Pass `blend: 'lighter'` for sparks. */
        draw(ctx, o = {}) {
            const prevOp = ctx.globalCompositeOperation;
            const prevA = ctx.globalAlpha;
            if (o.blend) ctx.globalCompositeOperation = o.blend;
            for (let i = 0; i < capacity; i++) {
                if (life[i] <= 0) continue;
                const t = life[i] / maxLife[i];
                const s = size[i] * (0.4 + 0.6 * t);
                ctx.globalAlpha = prevA * t;
                ctx.fillStyle = color[i];
                ctx.fillRect(x[i] - s / 2, y[i] - s / 2, s, s);
            }
            ctx.globalAlpha = prevA;
            ctx.globalCompositeOperation = prevOp;
        },

        clear() { life.fill(0); cursor = 0; },
    };
    return sys;
}
