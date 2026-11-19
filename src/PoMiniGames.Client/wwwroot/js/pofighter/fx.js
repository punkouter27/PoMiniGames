// pofighter/fx.js — the fight's world effects, in world units (versus.js ARENA), drawn by demo.js.
//
//   hit lights  every landed hit is a short-lived point light: a warm pool on the wall and the
//               floor around it (drawn after the room, before the fighters) and a warm rim on the
//               side of each fighter facing it (glowFor → FighterPainter's opts.glow);
//   motes       dust drifting slowly through the window shafts, behind the fighters;
//   sparks      a profile per kind of blow (PROFILES): a punch is a tight hot spray, a kick a
//               wide heavy one, a block a cold blue shower, a knockout adds sweat and floor dust.
//               Sparks fly the way the blow went (the attacker's facing), not in a random ring;
//   droplets    sweat thrown by a hard hit: real little bodies that fall, bounce on the floor
//               twice and settle;
//   dust        a puff where feet skid back under a hit, a jump lands, or a body hits the floor.
//
// Everything is pooled or capped (the shared particles2d pool follows the quality tier) and
// reduced motion keeps only the lights.

import { createParticles2D } from '../platform/2d/particles2d.js';

/** How each kind of blow throws sparks. Pure data (tests read it). */
export const PROFILES = Object.freeze({
    punch: { n: 18, speed: 440, spread: 1.3, life: 0.42, size: 7, colors: ['#fff6c8', '#ffd65a', '#ff9f1c'], light: 0.8, drops: 3 },
    kick: { n: 28, speed: 600, spread: 1.7, life: 0.5, size: 8, colors: ['#fff6c8', '#ffd65a', '#ff9f1c', '#ff5a3c'], light: 1, drops: 6 },
    block: { n: 12, speed: 260, spread: 2.2, life: 0.35, size: 5, colors: ['#d8f1ff', '#9fd8ff', '#4fc3ff'], light: 0.45, drops: 0 },
    ko: { n: 40, speed: 700, spread: 2.0, life: 0.65, size: 9, colors: ['#ffffff', '#fff6c8', '#ffd65a', '#ff5a3c'], light: 1.4, drops: 12 },
});

/** The profile for a versus.js hit/block event; final: it ended the round. Pure. */
export function profileFor(e, final = false) {
    if (e.type === 'block') return PROFILES.block;
    if (final) return PROFILES.ko;
    return (e.heavy ?? e.move === 'kick') ? PROFILES.kick : PROFILES.punch;
}

const LIGHT_LIFE = 0.32;
const MAX_DROPS = 48;
const MAX_DUST = 60;
const reduced = () => document.documentElement.dataset.motion === 'reduce'
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const tier = () => document.documentElement.dataset.gfx ?? 'high';

export function createFightFx({ ground }) {
    const sparks = createParticles2D(360);
    const dust = [];     // soft round puffs: { x, y, vx, vy, r, grow, life, max }
    const lights = [];   // { x, y, k, life }
    const drops = [];    // { x, y, vx, vy, life, bounces }
    const motes = Array.from({ length: 46 }, () => ({
        x: 100 + Math.random() * 600, y: 170 + Math.random() * (ground - 220),
        vx: 4 + Math.random() * 8, vy: -3 + Math.random() * 6, r: 1 + Math.random() * 1.8, ph: Math.random() * 6.3,
    }));

    const fx = {
        /**
         * A hit or block event; dir: the attacker's facing (+1 right); final: it ended the round;
         * sweat: false for a target that does not sweat (the practice room's bag).
         */
        hit(e, dir, final = false, { sweat = true } = {}) {
            const p = profileFor(e, final);
            lights.push({ x: e.x, y: e.y, k: p.light, life: LIGHT_LIFE * (final ? 2 : 1) });
            if (lights.length > 6) lights.shift();
            if (reduced()) return;
            sparks.setTier(tier());
            const angle = dir > 0 ? -0.2 : Math.PI + 0.2;   // along the blow, a little upward
            sparks.burst(e.x, e.y, { n: p.n, speed: p.speed, spread: p.spread, angle, life: p.life,
                size: p.size, gravity: 900, drag: 2.5, color: p.colors });
            for (let i = 0; sweat && i < p.drops && drops.length < MAX_DROPS; i++) {
                const a = angle + (Math.random() - 0.5) * 1.4;
                const s = 180 + Math.random() * 260;
                drops.push({ x: e.x, y: e.y - 20 + Math.random() * 30, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 160,
                    life: 1.4 + Math.random() * 0.6, bounces: 0 });
            }
        },

        /** A dust puff at the feet (x on the floor); strength 0..1; push: the way it is thrown. */
        puff(x, strength = 0.5, push = 0) {
            if (reduced()) return;
            const n = Math.round((tier() === 'low' ? 3 : 5) + 7 * strength);
            for (let i = 0; i < n && dust.length < MAX_DUST; i++) {
                const side = push ? Math.sign(push) : (i % 2 ? 1 : -1);
                const s = (60 + 150 * strength) * (0.4 + 0.6 * Math.random());
                const max = 0.6 + 0.4 * Math.random();
                dust.push({ x: x + side * Math.random() * 20, y: ground - 4 - Math.random() * 8,
                    vx: side * s, vy: -10 - Math.random() * 30, r: 6 + 6 * strength * Math.random(),
                    grow: 26 + 30 * strength, life: max, max });
            }
        },

        /** The warm rim a fighter at x, facing dir, gets from the hit lights: { side, k } or null. */
        glowFor(x, dir) {
            let best = null;
            for (const l of lights) {
                const d = l.x - x;
                const k = l.k * (l.life / LIGHT_LIFE) * Math.max(0, 1 - Math.abs(d) / 260);
                if (k > 0.05 && (!best || k > best.k)) best = { side: Math.sign(d || dir) * dir, k };
            }
            return best;
        },

        step(dt) {
            sparks.step(dt);
            for (const p of dust) {
                const f = Math.exp(-3 * dt);
                p.vx *= f; p.vy *= f;
                p.x += p.vx * dt; p.y += p.vy * dt;
                p.r += p.grow * dt;
                p.life -= dt;
            }
            for (let i = dust.length - 1; i >= 0; i--) if (dust[i].life <= 0) dust.splice(i, 1);
            for (const l of lights) l.life -= dt;
            for (let i = lights.length - 1; i >= 0; i--) if (lights[i].life <= 0) lights.splice(i, 1);
            for (const d of drops) {
                d.life -= dt;
                d.vy += 1300 * dt;
                d.x += d.vx * dt;
                d.y += d.vy * dt;
                if (d.y > ground - 2 && d.vy > 0) {   // the floor: lose most of the bounce and the slide
                    d.y = ground - 2;
                    d.vy *= -0.32;
                    d.vx *= 0.5;
                    if (++d.bounces > 2) d.vy = 0;
                }
            }
            for (let i = drops.length - 1; i >= 0; i--) if (drops[i].life <= 0) drops.splice(i, 1);
            for (const m of motes) {
                m.x += m.vx * dt;
                m.y += m.vy * dt + Math.sin(m.ph += dt * 0.7) * 0.15;
                if (m.x > 780 || m.y < 160 || m.y > ground - 40) { m.x = 120 + Math.random() * 200; m.y = 200 + Math.random() * (ground - 260); }
            }
        },

        /** Behind the fighters: the hit lights on the wall and floor, and the dust motes. */
        drawBack(ctx, t) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (const l of lights) {
                const k = l.k * (l.life / LIGHT_LIFE);
                const g = ctx.createRadialGradient(l.x, l.y, 10, l.x, l.y, 420);
                g.addColorStop(0, `rgba(255,190,110,${0.28 * Math.min(1, k)})`);
                g.addColorStop(1, 'rgba(255,190,110,0)');
                ctx.fillStyle = g;
                ctx.fillRect(l.x - 420, l.y - 420, 840, 840);
                // The pool it throws on the floor, flattened.
                ctx.save();
                ctx.translate(l.x, ground);
                ctx.scale(1, 0.18);
                const f = ctx.createRadialGradient(0, 0, 0, 0, 0, 300);
                f.addColorStop(0, `rgba(255,200,130,${0.3 * Math.min(1, k)})`);
                f.addColorStop(1, 'rgba(255,200,130,0)');
                ctx.fillStyle = f;
                ctx.fillRect(-300, -300, 600, 600);
                ctx.restore();
            }
            if (!reduced() && tier() !== 'low') {
                ctx.fillStyle = '#cfe0ff';
                for (const m of motes) {
                    ctx.globalAlpha = 0.18 + 0.14 * Math.sin(t * 1.3 + m.ph);
                    ctx.fillRect(m.x, m.y, m.r, m.r);
                }
            }
            ctx.restore();
        },

        /** In front of the fighters: dust, droplets, sparks. */
        drawFront(ctx) {
            ctx.save();
            for (const p of dust) {   // soft round puffs that spread and thin out
                const k = p.life / p.max;
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                g.addColorStop(0, `rgba(222,200,170,${0.32 * k})`);
                g.addColorStop(1, 'rgba(222,200,170,0)');
                ctx.fillStyle = g;
                ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
            }
            ctx.restore();
            ctx.save();
            ctx.fillStyle = 'rgba(220,240,255,0.85)';
            for (const d of drops) {
                ctx.globalAlpha = Math.min(1, d.life * 2);
                ctx.beginPath();
                ctx.ellipse(d.x, d.y, 2.6, d.bounces > 2 ? 1.4 : 3.2, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            sparks.draw(ctx, { blend: 'lighter' });
        },

        clear() { sparks.clear(); dust.length = 0; lights.length = 0; drops.length = 0; },
    };
    return fx;
}
