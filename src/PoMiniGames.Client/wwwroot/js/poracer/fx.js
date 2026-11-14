// PoRacer's effect layer: everything that sits on top of the drawn circuit.
//
// Split out of renderer.js so the scene (track, props, cars) and the effects over it can be
// read separately. Five systems live here, all pooled and all tier-gated by the `data-gfx`
// attribute qualityTiers.js owns:
//
//   • PARTICLES — one pool of soft sprites (tyre smoke, wet spray, sand dust, debris) plus
//     additive sparks. Every sprite is a pre-rendered radial gradient in a small atlas, so a
//     frame costs one drawImage a particle instead of a path, a gradient and a fill.
//   • LIGHTS — a half-resolution additive buffer that the scene is lit with: headlight pools,
//     brake glow, boost-pad light, neon bounce. Bloom is the same buffer blurred at quarter
//     resolution and added back, which is why neither costs a second scene pass.
//   • WEAR — the racing line darkens where the field actually drove, and marbles collect off
//     it. Stamped from the same car positions the renderer already has.
//   • STREAKS — edge-only radial streaks at speed. Sells velocity for a handful of lines.
//   • MINIMAP — the circuit polyline plus a dot per car, drawn into a HUD canvas.

const off = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

/* ── tier / motion ───────────────────────────────────────────────────────── */

let tier = 'high';
let tierAt = 0;

/** Re-read the app's quality tier. Cheap; called once a second rather than per frame. */
export function syncTier(now) {
    if (now - tierAt < 1000 && tierAt) return tier;
    tierAt = now || 1;
    try { tier = document.documentElement.getAttribute('data-gfx') || 'high'; }
    catch { tier = 'high'; }
    return tier;
}

export function getTier() { return tier; }

const calm = () => {
    try {
        return document.documentElement.getAttribute('data-motion') === 'reduce'
            || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch { return false; }
};

/** Particle ceiling for the tier: the whole pool, not per emitter. */
const capOf = () => (tier === 'low' ? 70 : tier === 'medium' ? 150 : 300);

/* ── sprite atlas ────────────────────────────────────────────────────────── */

const SPI = 64;             // one sprite, in atlas pixels
const atlas = {};           // kind → canvas

function soft(colour, hardness) {
    const c = off(SPI, SPI), g = c.getContext('2d');
    const r = SPI / 2;
    const grad = g.createRadialGradient(r, r, r * hardness, r, r, r);
    grad.addColorStop(0, colour);
    grad.addColorStop(0.55, colour.replace(/[\d.]+\)$/, '0.45)'));
    grad.addColorStop(1, colour.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grad;
    g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
    return c;
}

function ensureAtlas() {
    if (atlas.smoke) return;
    atlas.smoke = soft('rgba(196,200,208,0.55)', 0.02);
    atlas.dust = soft('rgba(214,178,120,0.6)', 0.05);
    atlas.spray = soft('rgba(214,232,244,0.5)', 0.05);
    atlas.glow = soft('rgba(255,226,140,1)', 0.2);
    atlas.ember = soft('rgba(255,255,255,0.9)', 0.35);
}

/* ── particles ───────────────────────────────────────────────────────────── */

const parts = [];           // { k, x, y, vx, vy, r, grow, rot, vr, life, max, a }

export function clearParticles() { parts.length = 0; }

function push(k, x, y, vx, vy, r, life, opts) {
    if (parts.length >= capOf()) return;
    parts.push({
        k, x, y, vx, vy, r,
        grow: opts?.grow ?? 0,
        rot: opts?.rot ?? 0,
        vr: opts?.vr ?? 0,
        a: opts?.a ?? 1,
        life, max: life,
    });
}

/** A car just hit something: glow sparks thrown back along travel, plus a little debris. */
export function impact(x, y, heading, strength) {
    if (calm()) return;
    ensureAtlas();
    const n = 6 + Math.round(strength * 10);
    for (let i = 0; i < n; i++) {
        const a = heading + Math.PI + (Math.random() - 0.5) * 2.3, v = 110 + Math.random() * 260;
        push('glow', x, y, Math.cos(a) * v, Math.sin(a) * v, 2.4 + Math.random() * 2.6,
            0.18 + Math.random() * 0.26, { a: 0.85 });
    }
    for (let i = 0; i < 3 + strength * 4; i++) {
        const a = heading + Math.PI + (Math.random() - 0.5) * 2.6, v = 60 + Math.random() * 140;
        push('smoke', x, y, Math.cos(a) * v, Math.sin(a) * v, 3 + Math.random() * 3,
            0.35 + Math.random() * 0.3, { grow: 26, a: 0.5 });
    }
}

/**
 * Emit what the cars are doing this frame. `env` carries the weather's grip and the camera so
 * spawns happen where the player can see them.
 */
export function emit(cars, dt, env) {
    if (calm() || !cars?.length) return;
    ensureAtlas();
    const wet = env.wet ?? 1;
    const budget = capOf();
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const speed = Math.abs(c.v || 0);
        if (speed < 20) continue;
        const cos = Math.cos(c.h), sin = Math.sin(c.h);
        const rx = c.x - cos * 12, ry = c.y - sin * 12;          // the rear axle
        const slip = Math.abs(c.slip || 0);

        // Tyre smoke: slip ratio, not a random roll. Two sprites a frame while it is really
        // sliding, one at the threshold, none on a clean line.
        if (slip > 0.14 && speed > 70 && parts.length < budget) {
            const rate = Math.min(1, (slip - 0.1) * 4) * dt * 90;
            if (Math.random() < rate) {
                push('smoke', rx + (Math.random() - 0.5) * 10, ry + (Math.random() - 0.5) * 10,
                    -cos * 30 + (Math.random() - 0.5) * 40, -sin * 30 + (Math.random() - 0.5) * 40,
                    5 + Math.random() * 4, 0.5 + Math.random() * 0.45,
                    { grow: 34, a: Math.min(0.62, 0.2 + slip) });
            }
        }
        // Wet spray, thrown up off the rear wheels.
        if (wet < 0.95 && parts.length < budget && Math.random() < dt * 40 * (1 - wet) * Math.min(1, speed / 120)) {
            push('spray', rx, ry, -cos * 60 + (Math.random() - 0.5) * 90, -sin * 60 + (Math.random() - 0.5) * 90,
                3 + Math.random() * 3, 0.3 + Math.random() * 0.25, { grow: 26, a: 0.35 });
        }
        // Loose sand: a dust plume, denser and browner than smoke.
        if (c.sand && parts.length < budget && Math.random() < dt * 26) {
            push('dust', rx, ry, -cos * 40 + (Math.random() - 0.5) * 70, -sin * 40 + (Math.random() - 0.5) * 70,
                5 + Math.random() * 4, 0.6 + Math.random() * 0.4, { grow: 30, a: 0.5 });
        }
    }
}

export function step(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= dt;
        if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
        const drag = p.k === 'glow' ? 3.4 : 2.1;
        p.vx *= 1 - drag * dt; p.vy *= 1 - drag * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.r += p.grow * dt;
        p.rot += p.vr * dt;
    }
}

/** World-space part of the effect layer, under the cars: smoke, dust and spray. */
export function drawWorld(g, camX, camY, scale, w, h) {
    blitParts(g, camX, camY, scale, w, h, false);
}

/** Additive half: sparks and hot glow, drawn over the cars. */
export function drawGlow(g, camX, camY, scale, w, h) {
    if (!parts.length) return;
    g.save();
    g.globalCompositeOperation = 'lighter';
    blitParts(g, camX, camY, scale, w, h, true);
    g.restore();
}

function blitParts(g, camX, camY, scale, w, h, additive) {
    const hw = w * 0.5, hh = h * 0.5;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if ((p.k === 'glow') !== additive) continue;
        const x = hw + (p.x - camX) * scale, y = hh + (p.y - camY) * scale;
        const r = p.r * scale;
        if (x + r < 0 || x - r > w || y + r < 0 || y - r > h) continue;
        const img = atlas[p.k];
        if (!img) continue;
        const fade = p.life / p.max;
        g.globalAlpha = Math.min(1, p.a * (additive ? fade : Math.min(1, fade * 1.6)));
        g.drawImage(img, x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
}

/* ── track wear ──────────────────────────────────────────────────────────── */
// The racing line: where the field has driven, the asphalt darkens and picks up rubber.
// Stamped from real car positions and drawn as one batched path, so it costs a stroke a frame
// rather than a bitmap rebuild (a rebuild is milliseconds; this is microseconds).

const WEAR_MAX = 520;
const wear = new Float32Array(WEAR_MAX * 4);   // x1, y1, x2, y2
let wearHead = 0, wearCount = 0;
const wheelLast = [];

export function clearWear() { wearHead = 0; wearCount = 0; wheelLast.length = 0; }

export function stampWear(cars, dt) {
    if (calm()) return;
    const budget = tier === 'low' ? 0.3 : 1;
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const cos = Math.cos(c.h), sin = Math.sin(c.h);
        // The two wheel tracks, a car's width apart.
        const lx = c.x - cos * 6 + sin * 7, ly = c.y - sin * 6 - cos * 7;
        const rx = c.x - cos * 6 - sin * 7, ry = c.y - sin * 6 + cos * 7;
        const was = wheelLast[i];
        if (was && Math.hypot(lx - was.lx, ly - was.ly) < 60 * budget) {
            if (wearCount < WEAR_MAX) {
                const o = (wearHead % WEAR_MAX) * 4;
                wear[o] = was.lx; wear[o + 1] = was.ly; wear[o + 2] = lx; wear[o + 3] = ly;
                wearHead++;
                if (wearCount < WEAR_MAX) wearCount++;
            }
        }
        wheelLast[i] = { lx, ly };
    }
}

export function drawWear(g, camX, camY, scale, w, h) {
    if (!wearCount) return;
    const hw = w * 0.5, hh = h * 0.5;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(8,8,10,0.16)';
    g.lineWidth = Math.max(2, 5.2 * scale);
    g.beginPath();
    for (let i = 0; i < wearCount; i++) {
        const o = i * 4;
        const x1 = hw + (wear[o] - camX) * scale, y1 = hh + (wear[o + 1] - camY) * scale;
        if (x1 < -30 || x1 > w + 30 || y1 < -30 || y1 > h + 30) continue;
        const x2 = hw + (wear[o + 2] - camX) * scale, y2 = hh + (wear[o + 3] - camY) * scale;
        g.moveTo(x1, y1); g.lineTo(x2, y2);
    }
    g.stroke();
}

/* ── lighting ────────────────────────────────────────────────────────────── */
// One half-resolution buffer. Everything that emits light is painted into it in screen space
// with plain `lighter`, then the buffer is added to the frame. Bloom is that same buffer
// downscaled and blurred once — a scene-shaped light pass, not a second render.

let lightCanvas = null, lightCtx = null, lightW = 0, lightH = 0;
let bloomCanvas = null, bloomCtx = null;
const LIGHT_SCALE = 0.5;

function ensureLight(w, h) {
    const lw = Math.max(1, Math.round(w * LIGHT_SCALE)), lh = Math.max(1, Math.round(h * LIGHT_SCALE));
    if (lightCanvas && lightW === lw && lightH === lh) return;
    lightW = lw; lightH = lh;
    lightCanvas = off(lw, lh); lightCtx = lightCanvas.getContext('2d');
    bloomCanvas = off(Math.max(1, Math.round(lw / 2)), Math.max(1, Math.round(lh / 2)));
    bloomCtx = bloomCanvas.getContext('2d');
}

export function disposeLights() { lightCanvas = lightCtx = bloomCanvas = bloomCtx = null; lightW = lightH = 0; }

/**
 * Paint the frame's light. `env` = { night, wet, now, theme }.
 * Cars are drawn as small bright bodies with a headlight pool ahead and a red pool behind.
 */
export function lightPass(g, cars, camX, camY, scale, w, h, env) {
    if (tier === 'low' || calm()) return;
    // Two full-screen additive blits are not free. In plain daylight, with every car coasting
    // and the road dry, there is nothing here worth the fill rate: skip the whole pass.
    const night = !!env.night;
    let emitting = night || env.wet < 0.98;
    if (!emitting) {
        for (let i = 0; i < cars.length && !emitting; i++) {
            const c = cars[i];
            if (c && (c.braking || (c.boostT || 0) > 0 || (c.boost || 0) > 0.55)) emitting = true;
        }
    }
    if (!emitting) return;
    ensureLight(w, h);
    const lc = lightCtx, k = LIGHT_SCALE, hw = w * 0.5, hh = h * 0.5;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, lightW, lightH);
    lc.globalCompositeOperation = 'lighter';

    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const x = (hw + (c.x - camX) * scale) * k, y = (hh + (c.y - camY) * scale) * k;
        if (x < -80 || x > lightW + 80 || y < -80 || y > lightH + 80) continue;
        const cos = Math.cos(c.h), sin = Math.sin(c.h);

        // Headlights: a cone, longer on the night track where it is the only light.
        const reach = (night ? 132 : 54) * scale * k;
        const spread = night ? 0.46 : 0.3;
        const grd = lc.createLinearGradient(x, y, x + cos * reach, y + sin * reach);
        const head = night ? 0.5 : 0.12;
        grd.addColorStop(0, `rgba(255,244,206,${head})`);
        grd.addColorStop(1, 'rgba(255,244,206,0)');
        lc.fillStyle = grd;
        lc.beginPath();
        lc.moveTo(x + sin * 3 * scale * k, y - cos * 3 * scale * k);
        lc.lineTo(x - sin * 3 * scale * k, y + cos * 3 * scale * k);
        lc.lineTo(x + Math.cos(c.h - spread) * reach, y + Math.sin(c.h - spread) * reach);
        lc.lineTo(x + Math.cos(c.h + spread) * reach, y + Math.sin(c.h + spread) * reach);
        lc.closePath(); lc.fill();

        // Tail lights: always a little red, a pool on a wet road.
        const tail = (c.braking ? 0.55 : 0.18) * (env.wet < 1 ? 1.5 : 1);
        lc.fillStyle = `rgba(255,42,42,${Math.min(0.8, tail)})`;
        lc.beginPath();
        lc.arc(x - cos * 16 * scale * k, y - sin * 16 * scale * k, Math.max(2, 7 * scale * k), 0, Math.PI * 2);
        lc.fill();

        // Boost: a warm corona out of the back of the car.
        if ((c.boostT || 0) > 0 || (c.boost || 0) > 0.55) {
            const b = Math.max(c.boostT > 0 ? 1 : 0, c.boost || 0);
            lc.fillStyle = `rgba(255,166,80,${0.25 + b * 0.45})`;
            lc.beginPath();
            lc.arc(x - cos * 20 * scale * k, y - sin * 20 * scale * k, (10 + b * 16) * scale * k, 0, Math.PI * 2);
            lc.fill();
        }
    }
    lc.globalCompositeOperation = 'source-over';

    // Add the light buffer to the frame, then the blurred copy for bloom.
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.drawImage(lightCanvas, 0, 0, w, h);
    const bc = bloomCtx;
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = 'copy';
    try { bc.filter = 'blur(3px)'; } catch { /* older engine: a hard downscale still reads as glow */ }
    bc.drawImage(lightCanvas, 0, 0, bloomCanvas.width, bloomCanvas.height);
    bc.filter = 'none';
    g.globalAlpha = night ? 0.55 : 0.4;
    g.drawImage(bloomCanvas, 0, 0, w, h);
    g.globalAlpha = 1;
    g.restore();
}

/* ── speed streaks ───────────────────────────────────────────────────────── */

/**
 * Edge-only radial streaks: the middle of the screen stays readable, the frame's rim rushes.
 * `intensity` is 0..1 (already the speed curve the caller chose).
 */
export function streaks(g, w, h, intensity, now) {
    if (intensity <= 0.02 || calm() || tier === 'low') return;
    const cx = w * 0.5, cy = h * 0.5;
    const count = Math.round(6 + intensity * 26);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = 0; i < count; i++) {
        // Deterministic per streak, animated by the clock: no allocation, no random walk.
        const a = (i * 2.399963) % (Math.PI * 2);
        const phase = ((now * 0.0016 + i * 0.137) % 1);
        const r0 = Math.min(w, h) * (0.34 + phase * 0.3);
        const len = Math.min(w, h) * (0.05 + intensity * 0.09);
        const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0;
        const x1 = cx + Math.cos(a) * (r0 + len), y1 = cy + Math.sin(a) * (r0 + len);
        if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > w || Math.max(y0, y1) < 0 || Math.min(y0, y1) > h) continue;
        g.strokeStyle = `rgba(226,244,255,${(0.05 + intensity * 0.16) * (1 - phase * 0.7)})`;
        g.lineWidth = 1 + intensity * 2;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    g.restore();
}

/* ── ambient motes ───────────────────────────────────────────────────────── */
// A themed haze of tiny drifting points over the whole frame. Screen-space, so it costs
// nothing to keep alive while the camera moves.

const MOTE_MIX = {
    circuit: 'rgba(190,235,180,',      // pollen
    desertdustway: 'rgba(240,206,150,', // dust
    neonskyline: 'rgba(150,240,255,',   // neon embers
    crossfire: 'rgba(255,214,120,',     // yard sparks
};
let motes = [], moteW = 0, moteH = 0, moteTheme = '';

function seedMotes(w, h, theme) {
    motes = []; moteW = w; moteH = h; moteTheme = theme;
    const n = tier === 'low' ? 0 : tier === 'medium' ? 26 : 54;
    const rng = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
    for (let i = 0; i < n; i++) {
        motes.push({ x: rng() * w, y: rng() * h, r: 0.7 + rng() * 1.9, v: 6 + rng() * 26, a: 0.12 + rng() * 0.28, p: rng() * 6.28 });
    }
}

export function ambient(g, w, h, theme, dt, now) {
    if (calm() || tier === 'low') return;
    if (moteW !== w || moteH !== h || moteTheme !== theme) seedMotes(w, h, theme);
    const tint = MOTE_MIX[theme] || MOTE_MIX.circuit;
    g.save();
    for (const m of motes) {
        m.y -= m.v * dt;
        m.x += Math.sin(now * 0.0004 + m.p) * 12 * dt;
        if (m.y < -4) { m.y = h + 4; m.x = Math.random() * w; }
        // Filled rects, not arcs: a mote is one or two pixels, and a path a point is the
        // difference between a free layer and 54 rasterizations a frame.
        g.fillStyle = tint + (m.a * (0.6 + 0.4 * Math.sin(now * 0.001 + m.p))).toFixed(3) + ')';
        g.fillRect(m.x, m.y, m.r * 2, m.r * 2);
    }
    g.restore();
}

/* ── car shadows ─────────────────────────────────────────────────────────── */
/** A soft ellipse under each car, offset away from the sun. Depth cue for a flat drawing. */
export function drawShadows(g, cars, camX, camY, scale, w, h) {
    if (tier === 'low' || !cars?.length) return;
    const hw = w * 0.5, hh = h * 0.5;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.26)';
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const x = hw + (c.x - camX) * scale + 3.5 * scale, y = hh + (c.y - camY) * scale + 4.5 * scale;
        if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;
        g.save();
        g.translate(x, y); g.rotate(c.h);
        g.beginPath(); g.ellipse(0, 0, 17 * scale, 8.5 * scale, 0, 0, Math.PI * 2); g.fill();
        g.restore();
    }
    g.restore();
}

/**
 * A wet road mirrors. Under each car goes a stretched smear of its own paint, brightest at the
 * back where the tail lights are — cheap to draw and immediately reads as water on asphalt.
 */
export function drawReflections(g, cars, camX, camY, scale, w, h, wet) {
    if (wet >= 0.98 || tier === 'low' || !cars?.length) return;
    const strength = 1 - wet;                  // 0 dry .. 0.4 in snow
    const hw = w * 0.5, hh = h * 0.5;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const x = hw + (c.x - camX) * scale, y = hh + (c.y - camY) * scale;
        if (x < -50 || x > w + 50 || y < -50 || y > h + 50) continue;
        g.save();
        g.translate(x, y); g.rotate(c.h);
        g.globalAlpha = 0.16 * strength;
        g.fillStyle = c.color || '#ffffff';
        g.beginPath(); g.ellipse(-2 * scale, 0, 22 * scale, 9 * scale, 0, 0, Math.PI * 2); g.fill();
        // The tail lights, smeared back along the road.
        g.globalAlpha = 0.28 * strength * (c.braking ? 1.6 : 0.9);
        g.fillStyle = '#ff3a3a';
        g.beginPath(); g.ellipse(-20 * scale, 0, 9 * scale, 4 * scale, 0, 0, Math.PI * 2); g.fill();
        g.restore();
    }
    g.restore();
    g.globalAlpha = 1;
}

/* ── slipstream ──────────────────────────────────────────────────────────── */
/**
 * The air being pushed: while a car is in another's tow, two faint streams curl in ahead of it
 * and the space between them brightens. Reads as "you are in the pocket" without a meter.
 */
export function drawSlipstream(g, cars, camX, camY, scale, w, h) {
    if (tier === 'low' || calm() || !cars?.length) return;
    const hw = w * 0.5, hh = h * 0.5;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const d = c?.draft || 0;
        if (d < 0.12) continue;
        const x = hw + (c.x - camX) * scale, y = hh + (c.y - camY) * scale;
        if (x < -80 || x > w + 80 || y < -80 || y > h + 80) continue;
        const cos = Math.cos(c.h), sin = Math.sin(c.h);
        const reach = (46 + d * 40) * scale;
        g.strokeStyle = `rgba(190,232,255,${(0.1 + d * 0.16).toFixed(3)})`;
        g.lineWidth = Math.max(1, 1.6 * scale);
        for (const side of [-1, 1]) {
            // A short curl off each flank, narrowing toward the car ahead.
            g.beginPath();
            g.moveTo(x + cos * 16 * scale + sin * side * 10 * scale, y + sin * 16 * scale - cos * side * 10 * scale);
            g.quadraticCurveTo(
                x + cos * (16 * scale + reach * 0.55) + sin * side * 6 * scale,
                y + sin * (16 * scale + reach * 0.55) - cos * side * 6 * scale,
                x + cos * (16 * scale + reach) + sin * side * 2 * scale,
                y + sin * (16 * scale + reach) - cos * side * 2 * scale);
            g.stroke();
        }
    }
    g.restore();
}

/* ── minimap ─────────────────────────────────────────────────────────────── */

let mapPath = null;
let mapW = 0, mapH = 0, mapCtx = null;

/** Draw the circuit and the field into the HUD's minimap canvas. */
export function minimap(canvas, centerXY, centerN, cars, localIdx) {
    if (!canvas || !centerXY || centerN < 3) return;
    if (!mapCtx || mapCtx.canvas !== canvas) {
        mapCtx = canvas.getContext('2d');
        if (!mapCtx) return;
        mapPath = null;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 132, cssH = canvas.clientHeight || 88;
    // Hidden on a phone (the strip carries the field instead): nothing to draw into a 0x0 box.
    if (cssW < 8 || cssH < 8) return;
    const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw; canvas.height = bh;
        mapPath = null;
    }
    if (mapPath && mapW === bw && mapH === bh) {
        // cached path is still valid for this size
    } else {
        mapW = bw; mapH = bh;
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let i = 0; i < centerN; i++) {
            const x = centerXY[i * 2], y = centerXY[i * 2 + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const pad = 5 * dpr;
        const k = Math.min((bw - pad * 2) / Math.max(1, maxX - minX), (bh - pad * 2) / Math.max(1, maxY - minY));
        const ox = (bw - (maxX - minX) * k) / 2 - minX * k, oy = (bh - (maxY - minY) * k) / 2 - minY * k;
        mapPath = { k, ox, oy };
        mapCtx.setTransform(1, 0, 0, 1, 0, 0);
        mapCtx.clearRect(0, 0, bw, bh);
        mapCtx.beginPath();
        for (let i = 0; i <= centerN; i++) {
            const j = i % centerN;
            const x = centerXY[j * 2] * k + ox, y = centerXY[j * 2 + 1] * k + oy;
            if (i === 0) mapCtx.moveTo(x, y); else mapCtx.lineTo(x, y);
        }
        mapCtx.closePath();
        mapCtx.strokeStyle = 'rgba(148,200,228,0.55)';
        mapCtx.lineWidth = Math.max(1.4, 2.2 * dpr);
        mapCtx.lineJoin = 'round';
        mapCtx.stroke();
    }

    const g = mapCtx, m = mapPath;
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Redraw the outline each frame over the previous dots: the canvas is tiny, and clearing
    // only the dots would need their old positions.
    g.clearRect(0, 0, bw, bh);
    g.beginPath();
    for (let i = 0; i <= centerN; i++) {
        const j = i % centerN;
        const x = centerXY[j * 2] * m.k + m.ox, y = centerXY[j * 2 + 1] * m.k + m.oy;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = 'rgba(148,200,228,0.4)';
    g.lineWidth = Math.max(1.2, 2 * dpr);
    g.stroke();

    for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c) continue;
        const x = c.x * m.k + m.ox, y = c.y * m.k + m.oy;
        if (i === localIdx) {
            g.fillStyle = '#ffe9a6';
            g.beginPath(); g.arc(x, y, 3.4 * dpr, 0, Math.PI * 2); g.fill();
            g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.stroke();
        } else {
            g.fillStyle = c.finished ? 'rgba(150,170,190,0.5)' : 'rgba(238,247,255,0.85)';
            g.beginPath(); g.arc(x, y, 2 * dpr, 0, Math.PI * 2); g.fill();
        }
    }
}

/** Ghost trail on the minimap: where your best lap went, faint. */
export function minimapGhost(canvas, points, k, ox, oy) {
    if (!canvas || !points?.length) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.strokeStyle = 'rgba(120,224,252,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < points.length; i += 2) {
        const x = points[i] * k + ox, y = points[i + 1] * k + oy;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
}
