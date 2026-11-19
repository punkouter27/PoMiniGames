// pofighter/stages.js — the arenas. Every fighter has a home stage, and a fight is held on the
// home stage of the fighter in the right-hand corner (in the arcade, the opponent), so each
// arcade stage looks different. All drawn on the canvas, no images:
//
//   gym      the training gym (art.js drawWall / drawFloor): high windows and light shafts
//   dojo     paper screens lit warm from behind, a brush-circle scroll, two swaying lanterns,
//            tatami mats
//   rooftop  a city at night: a moon, two layers of skyline with lit windows that switch on and
//            off, a water tower and a blinking mast, a gravel roof
//   street   a brick alley at dusk: a flickering neon sign, a crowd of silhouettes that bobs and
//            jumps on a big hit (cheer()), wet asphalt with a painted line
//
// stageFor(id) is pure (the tests read it); the drawing helpers need a 2D context.

import { drawWall, drawFloor } from './art.js';

export const STAGES = Object.freeze({
    gym: { id: 'gym', name: 'The Gym' },
    dojo: { id: 'dojo', name: 'Paper Dojo' },
    rooftop: { id: 'rooftop', name: 'Night Rooftop' },
    street: { id: 'street', name: 'Neon Alley' },
});

const HOME = { p1: 'rooftop', kim: 'dojo' };
const SPARE = ['street', 'gym', 'dojo', 'rooftop'];

/** A fighter's home stage id: built-in fighters have one, a Studio fighter gets one from its id. */
export function stageFor(id) {
    if (HOME[id]) return HOME[id];
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return SPARE[h % SPARE.length];
}

const FAR = 4000;   // the backdrop runs past the world so wide screens show no bars

// A small seeded generator, so the skyline and the crowd are the same every frame.
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- dojo ----

function dojoWall(ctx, width, ground, t) {
    const wall = ctx.createLinearGradient(0, 0, 0, ground);
    wall.addColorStop(0, '#2a1a10');
    wall.addColorStop(1, '#5a3a22');
    ctx.fillStyle = wall;
    ctx.fillRect(-FAR, -FAR, FAR * 2 + width, FAR + ground);
    // Paper screens lit from behind, in dark wooden frames.
    for (let x = -1300; x < width + 1300; x += 240) {
        const top = 70, h = ground - 150;
        const glow = ctx.createLinearGradient(0, top, 0, top + h);
        glow.addColorStop(0, 'rgba(255,214,150,0.30)');
        glow.addColorStop(1, 'rgba(255,190,120,0.16)');
        ctx.fillStyle = glow;
        ctx.fillRect(x + 12, top, 210, h);
        ctx.fillStyle = 'rgba(40,22,12,0.85)';
        for (let gx = 1; gx < 4; gx++) ctx.fillRect(x + 12 + gx * 52.5 - 2, top, 4, h);
        for (let gy = 1; gy < 6; gy++) ctx.fillRect(x + 12, top + gy * (h / 6) - 2, 210, 4);
        ctx.fillRect(x, top - 10, 234, 12);
        ctx.fillRect(x, top + h, 234, 12);
        ctx.fillRect(x, top - 10, 12, h + 22);
    }
    // The scroll in the middle: a brushed circle that does not quite close.
    const cx = width / 2;
    ctx.fillStyle = '#efe3c8';
    ctx.fillRect(cx - 70, 60, 140, 250);
    ctx.fillStyle = '#3a2214';
    ctx.fillRect(cx - 80, 52, 160, 10);
    ctx.fillRect(cx - 80, 308, 160, 10);
    ctx.strokeStyle = 'rgba(25,15,10,0.9)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(cx, 175, 48, -1.2, 4.6);
    ctx.stroke();
    ctx.fillStyle = '#b3261e';
    ctx.fillRect(cx + 34, 270, 18, 18);   // the seal
    // Two lanterns that sway on their cords.
    for (const [lx, ph] of [[220, 0], [width - 220, 1.4]]) {
        const sway = Math.sin(t * 1.3 + ph) * 0.08;
        ctx.save();
        ctx.translate(lx, 0);
        ctx.rotate(sway);
        ctx.strokeStyle = 'rgba(20,12,8,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 120); ctx.stroke();
        const halo = ctx.createRadialGradient(0, 160, 6, 0, 160, 150);
        halo.addColorStop(0, 'rgba(255,170,80,0.35)');
        halo.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(-150, 10, 300, 300);
        ctx.fillStyle = '#d2452b';
        ctx.beginPath(); ctx.ellipse(0, 160, 34, 44, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,220,150,0.5)';
        ctx.beginPath(); ctx.ellipse(-8, 152, 12, 26, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1c120c';
        ctx.fillRect(-18, 112, 36, 8);
        ctx.fillRect(-18, 200, 36, 8);
        ctx.restore();
    }
    ctx.fillStyle = '#2b1a0f';
    ctx.fillRect(-FAR, ground - 70, FAR * 2 + width, 70);
}

function dojoFloor(ctx, width, ground, height) {
    const floor = ctx.createLinearGradient(0, ground - 34, 0, height);
    floor.addColorStop(0, '#b8a96a');
    floor.addColorStop(1, '#6f6436');
    ctx.fillStyle = floor;
    ctx.fillRect(-FAR, ground - 34, FAR * 2 + width, FAR);
    // Tatami borders.
    ctx.fillStyle = 'rgba(40,30,15,0.55)';
    for (let x = -1320; x < width + 1320; x += 330) ctx.fillRect(x, ground - 34, 6, height - ground + 34);
    ctx.fillRect(-FAR, ground + 14, FAR * 2 + width, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let x = -1320; x < width + 1320; x += 11) ctx.fillRect(x, ground - 34, 1, height - ground + 34);
}

// ---- rooftop ----

const skyline = (() => {
    const rnd = seeded(7);
    const layer = (n, minH, maxH, w0, w1) => {
        const list = [];
        let x = -1400;
        for (let i = 0; i < n && x < 2600; i++) {
            const w = w0 + rnd() * (w1 - w0), h = minH + rnd() * (maxH - minH);
            const lit = [];
            for (let wy = 14; wy < h - 14; wy += 22) {
                for (let wx = 10; wx < w - 12; wx += 18) if (rnd() < 0.35) lit.push([wx, wy, rnd() * 40]);
            }
            list.push({ x, w, h, lit });
            x += w + 6 + rnd() * 20;
        }
        return list;
    };
    return { far: layer(60, 120, 260, 60, 130), near: layer(40, 80, 200, 90, 170) };
})();

function rooftopWall(ctx, width, ground, t) {
    const sky = ctx.createLinearGradient(0, -200, 0, ground);
    sky.addColorStop(0, '#05061a');
    sky.addColorStop(0.6, '#1b1846');
    sky.addColorStop(1, '#4a2a5e');
    ctx.fillStyle = sky;
    ctx.fillRect(-FAR, -FAR, FAR * 2 + width, FAR + ground);
    // Stars and the moon.
    const rnd = seeded(3);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 90; i++) {
        const sx = -1300 + rnd() * (width + 2600), sy = rnd() * 260, k = 0.5 + 0.5 * Math.sin(t * 2 + i);
        ctx.globalAlpha = 0.3 + 0.5 * k;
        ctx.fillRect(sx, sy, 2, 2);
    }
    ctx.globalAlpha = 1;
    const moon = ctx.createRadialGradient(840, 110, 10, 840, 110, 140);
    moon.addColorStop(0, 'rgba(255,245,220,0.45)');
    moon.addColorStop(1, 'rgba(255,245,220,0)');
    ctx.fillStyle = moon;
    ctx.fillRect(700, -30, 280, 280);
    ctx.fillStyle = '#f4ecd6';
    ctx.beginPath(); ctx.arc(840, 110, 42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(180,170,150,0.35)';
    ctx.beginPath(); ctx.arc(828, 100, 9, 0, Math.PI * 2); ctx.arc(852, 124, 6, 0, Math.PI * 2); ctx.fill();
    // Two skylines: the far one hazy, the near one darker, windows switching on and off.
    const base = ground - 70;
    for (const [list, color, lit] of [[skyline.far, '#231f4a', 'rgba(255,214,140,0.35)'], [skyline.near, '#120f2a', 'rgba(255,220,150,0.75)']]) {
        for (const b of list) {
            ctx.fillStyle = color;
            ctx.fillRect(b.x, base - b.h, b.w, b.h);
            ctx.fillStyle = lit;
            for (const [wx, wy, ph] of b.lit) if (Math.sin(t * 0.25 + ph) > -0.7) ctx.fillRect(b.x + wx, base - b.h + wy, 8, 10);
        }
    }
    // The parapet, a water tower on the left and a mast with a blinking light on the right.
    ctx.fillStyle = '#0c0a1e';
    ctx.fillRect(40, base - 190, 120, 110);
    ctx.fillRect(50, base - 80, 8, 80);
    ctx.fillRect(142, base - 80, 8, 80);
    ctx.beginPath(); ctx.moveTo(30, base - 190); ctx.lineTo(100, base - 230); ctx.lineTo(170, base - 190); ctx.fill();
    ctx.fillRect(width - 140, base - 260, 6, 260);
    if (Math.floor(t * 1.2) % 2 === 0) {
        const red = ctx.createRadialGradient(width - 137, base - 262, 1, width - 137, base - 262, 22);
        red.addColorStop(0, 'rgba(255,60,60,1)');
        red.addColorStop(1, 'rgba(255,60,60,0)');
        ctx.fillStyle = red;
        ctx.fillRect(width - 160, base - 285, 46, 46);
    }
    const parapet = ctx.createLinearGradient(0, base, 0, ground);
    parapet.addColorStop(0, '#3a3854');
    parapet.addColorStop(1, '#25233a');
    ctx.fillStyle = parapet;
    ctx.fillRect(-FAR, base, FAR * 2 + width, 70);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-FAR, base, FAR * 2 + width, 4);
}

function rooftopFloor(ctx, width, ground, height) {
    const floor = ctx.createLinearGradient(0, ground - 34, 0, height);
    floor.addColorStop(0, '#4a4860');
    floor.addColorStop(1, '#22202f');
    ctx.fillStyle = floor;
    ctx.fillRect(-FAR, ground - 34, FAR * 2 + width, FAR);
    const rnd = seeded(11);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 260; i++) ctx.fillRect(-1300 + rnd() * (width + 2600), ground - 30 + rnd() * (height - ground + 30), 2, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-FAR, ground - 34, FAR * 2 + width, 3);
}

// ---- street ----

const crowd = (() => {
    const rnd = seeded(5);
    return Array.from({ length: 46 }, (_, i) => ({ x: -1300 + i * 82 + rnd() * 40, s: 0.8 + rnd() * 0.45, ph: rnd() * 6.3,
        shade: 18 + Math.floor(rnd() * 16) }));
})();
let crowdJump = 0, crowdAt = 0;   // a cheer makes the crowd jump for a moment

/** The crowd reacts to a big moment (street stage). k: 0..1. */
export function cheer(k = 1) {
    crowdJump = Math.max(crowdJump, k);
    crowdAt = performance.now() / 1000;
}

function streetWall(ctx, width, ground, t) {
    const wall = ctx.createLinearGradient(0, 0, 0, ground);
    wall.addColorStop(0, '#1a1020');
    wall.addColorStop(1, '#4a2630');
    ctx.fillStyle = wall;
    ctx.fillRect(-FAR, -FAR, FAR * 2 + width, FAR + ground);
    // Bricks.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let row = 0, y = 20; y < ground - 70; row++, y += 26) {
        ctx.fillRect(-FAR, y, FAR * 2 + width, 3);
        for (let x = -1320 + (row % 2) * 30; x < width + 1320; x += 60) ctx.fillRect(x, y, 3, 26);
    }
    // A fire escape on the left.
    ctx.strokeStyle = 'rgba(10,6,12,0.9)';
    ctx.lineWidth = 4;
    for (const y of [150, 290]) {
        ctx.strokeRect(60, y, 230, 8);
        for (let x = 66; x < 290; x += 22) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 40); ctx.stroke(); }
        ctx.strokeRect(60, y - 40, 230, 2);
    }
    ctx.beginPath(); ctx.moveTo(100, 158); ctx.lineTo(240, 250); ctx.stroke();
    // The neon sign: flickers now and then.
    const flick = Math.sin(t * 37) > 0.93 || Math.sin(t * 0.7) > 0.985 ? 0.25 : 1;
    const nx = width - 330, ny = 90;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(nx + 110, ny + 50, 10, nx + 110, ny + 50, 220);
    halo.addColorStop(0, `rgba(255,60,180,${0.35 * flick})`);
    halo.addColorStop(1, 'rgba(255,60,180,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(nx - 120, ny - 170, 460, 440);
    ctx.restore();
    ctx.lineWidth = 6;
    ctx.strokeStyle = `rgba(255,90,200,${flick})`;
    ctx.strokeRect(nx, ny, 220, 100);
    ctx.font = "64px 'Arial Black', Impact, sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(120,240,255,${0.4 + 0.6 * flick})`;
    ctx.fillText('PO', nx + 110, ny + 52);
    ctx.fillStyle = '#1a0e16';
    ctx.fillRect(-FAR, ground - 70, FAR * 2 + width, 70);
    // The crowd along the back, bobbing; a cheer makes it jump.
    const now = performance.now() / 1000;
    const jump = crowdJump * Math.max(0, 1 - (now - crowdAt) / 1.2);
    if (jump <= 0) crowdJump = 0;
    for (const p of crowd) {
        const bob = Math.abs(Math.sin(t * 2.2 + p.ph)) * 4 + jump * Math.abs(Math.sin(now * 12 + p.ph)) * 16;
        const y = ground - 52 - bob;
        ctx.fillStyle = `rgb(${p.shade},${p.shade - 6},${p.shade + 8})`;
        ctx.beginPath();
        ctx.ellipse(p.x, y + 30 * p.s, 26 * p.s, 34 * p.s, 0, Math.PI, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, y - 14 * p.s, 13 * p.s, 0, Math.PI * 2);
        ctx.fill();
        if (jump > 0.3) {   // arms up
            ctx.fillRect(p.x - 24 * p.s, y - 34 * p.s, 5, 34 * p.s);
            ctx.fillRect(p.x + 19 * p.s, y - 34 * p.s, 5, 34 * p.s);
        }
    }
}

function streetFloor(ctx, width, ground, height) {
    const floor = ctx.createLinearGradient(0, ground - 34, 0, height);
    floor.addColorStop(0, '#3a3440');
    floor.addColorStop(1, '#17141c');
    ctx.fillStyle = floor;
    ctx.fillRect(-FAR, ground - 34, FAR * 2 + width, FAR);
    ctx.fillStyle = 'rgba(255,214,90,0.5)';
    for (let x = -1300; x < width + 1300; x += 140) ctx.fillRect(x, ground + 30, 80, 5);
    // A puddle catching the neon.
    const puddle = ctx.createRadialGradient(width - 220, ground + 10, 4, width - 220, ground + 10, 140);
    puddle.addColorStop(0, 'rgba(255,90,200,0.22)');
    puddle.addColorStop(1, 'rgba(255,90,200,0)');
    ctx.fillStyle = puddle;
    ctx.beginPath();
    ctx.ellipse(width - 220, ground + 10, 150, 18, 0, 0, Math.PI * 2);
    ctx.fill();
}

const PAINTERS = {
    gym: { wall: drawWall, floor: drawFloor },
    dojo: { wall: dojoWall, floor: dojoFloor },
    rooftop: { wall: rooftopWall, floor: rooftopFloor },
    street: { wall: streetWall, floor: streetFloor },
};

/** The backdrop of `stage` (drawn on the slower, far camera). t: seconds, for what moves. */
export function drawStageWall(ctx, stage, width, ground, t = 0) {
    (PAINTERS[stage] ?? PAINTERS.gym).wall(ctx, width, ground, t);
}

/** The floor of `stage`. */
export function drawStageFloor(ctx, stage, width, ground, height) {
    (PAINTERS[stage] ?? PAINTERS.gym).floor(ctx, width, ground, height);
}
