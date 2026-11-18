// hudLiquid.js — PoBrawl's liquid-glass HUD: health as liquid in a glass tube, energy as
// plasma. One WebGL2 canvas laid over the whole .pb-hud (PoBrawlHud.razor), one SDF fragment
// shader, four scissored draws a frame (one per tube). Decoration only: the CSS bars and their
// role="meter" tracks stay in the DOM, and they are what shows whenever this is not live.
//
// DATA PATH — no interop on the pump. The engine already pumps ~4×/sec into the Blazor HUD,
// which patches aria-valuenow on the four meters (and the danger / energy-state classes) only
// when a value changed. A MutationObserver on those two attributes is the cheapest way to
// hear it: no .NET → JS marshalling per pump, no extra call, and the tubes can never disagree
// with what a screen reader reads. The thresholds (danger, gassed, hot) stay in C#: this
// module reads the classes the component already sets instead of copying the numbers.
//
// SMOOTHING — between the 4 Hz pumps the level eases toward the target, a hit kicks a damped
// slosh (the liquid front tilts and rings) and a surface wave sized by the damage, and the
// lost slice stays as a pale chip that holds 0.45 s and then drains down in 0.6 s, dripping
// (the old CSS ghost's timings).
//
// GATES — live only with WebGL2, off the low tier (<html data-gfx="low"> keeps the CSS bars),
// and with a sane context. Under reduced motion (<html data-motion="reduce">) the tubes are
// drawn static: one frame per change, no slosh, no plasma swirl. The rAF loop runs only while
// the HUD is on screen (IntersectionObserver) and the tab is visible.

import { createShaderQuad } from '../platform/2d/shaderQuad.js';
const MAX_DPR = 2;
const PAD_CSS = 5;          // glow / drips / sparks margin around each tube, in CSS px
const CHIP_HOLD_MS = 450;   // the old CSS ghost's delay
const CHIP_DRAIN_S = 0.6;   // ...and its drain

// Everything is measured in device pixels around the tube's centre, x mirrored for P2 so
// both tubes fill from their outer end and drain toward the clock.
const FS = `#version 300 es
precision highp float;
uniform vec4 uTube;      // centre (gl_FragCoord space) and size, device px
uniform float uDpr, uPad, uKind, uFlip;
uniform float uLevel, uChip, uDrain, uSlosh, uWave, uDanger, uTime, uFull, uPower;
uniform vec3 uColA, uColB, uChipA, uChipB;
out vec4 o;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 q) {
    vec2 i = floor(q), f = fract(q);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
               mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float cover(float d) { return clamp(0.5 - d, 0.0, 1.0); }
void over(inout vec4 dst, vec3 c, float a) { dst = vec4(c * a, a) + dst * (1.0 - a); }
vec2 cp(vec2 a, vec2 hs, vec2 sc) { return vec2(a.x * sc.x - hs.x, hs.y - a.y * sc.y); }
float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

void main() {
    float px = uDpr;
    vec2 hs = uTube.zw * 0.5;
    vec2 p = gl_FragCoord.xy - uTube.xy;
    if (uFlip > 0.5) p.x = -p.x;
    float r = hs.y;
    float a = max(hs.x - r, 0.0);
    float d = length(vec2(p.x - clamp(p.x, -a, a), p.y)) - r;     // capsule
    float gt = max(1.0, 1.25 * px);                                 // glass wall
    float di = d + gt;                                              // cavity
    float tube = cover(d);
    float inside = cover(di);
    float L = max(uTube.z - 2.0 * gt, 1.0);
    float ih = max(hs.y - gt, 0.5);
    float xi = p.x + hs.x - gt;                                     // 0 at the anchor end
    float v = clamp(p.y / ih, -1.0, 1.0);
    float wall = exp(di / (1.4 * px)) * inside;                     // ~1 against the glass
    float t = uTime;
    vec4 col = vec4(0.0);

    // ── Under the glass: drop shadow, the danger / plasma halo ──────────────────
    float dShadow = length(vec2(p.x - clamp(p.x, -a, a), p.y + 1.5 * px)) - r;
    over(col, vec3(0.0), 0.42 * exp(-max(dShadow, 0.0) / (2.4 * px)) * (1.0 - tube));
    float outside = max(d, 0.0);
    if (uDanger > 0.01) {
        over(col, vec3(1.0, 0.22, 0.18), 0.5 * uDanger * exp(-outside / (3.0 * px)) * (1.0 - tube));
    }
    if (uKind > 0.5) {
        float along = smoothstep(uLevel * L + 3.0 * px, uLevel * L - 3.0 * px, xi);
        float halo = (0.12 + 0.55 * uFull) * uPower * along * exp(-outside / (3.2 * px)) * (1.0 - tube);
        over(col, uColB, halo);
    }

    // ── The cavity: a dark well behind the contents ────────────────────────────
    over(col, vec3(0.016, 0.027, 0.07), 0.62 * inside);
    over(col, vec3(0.55, 0.65, 0.95), (0.05 + 0.07 * smoothstep(-ih, ih, p.y)) * inside);

    if (uKind < 0.5) {
        // ── Health: liquid with a meniscus, a sloshing front and a live surface ──
        float fx = uLevel * L;
        float men = 2.0 * px;
        float front = fx + men * (v * v - 0.35) + uSlosh * ih * 1.5 * v;
        float env = exp(-max(fx - xi, 0.0) / (L * 0.3 + 1.0));
        float k = 0.3 / px;
        float wv = uWave * 1.5 * px * env * sin(xi * k * 0.9 - t * 9.0)
                 + 0.35 * px * sin(xi * k * 0.37 + t * 2.1)
                 + uDanger * 0.7 * px * sin(xi * k * 1.7 - t * 13.0);
        float top = ih - 1.7 * px + wv;
        float liq = cover(max(xi - front, p.y - top)) * inside * smoothstep(0.0, 0.006, uLevel);

        float depth = clamp((top - p.y) / (2.0 * ih), 0.0, 1.0);
        vec3 lc = mix(mix(uColB, vec3(1.0), 0.15), uColA * 0.42, smoothstep(0.0, 0.9, depth));
        // Soft caustic blobs drifting through the body (noise, not stripes).
        vec2 cq = vec2(xi / px * 0.11 - t * 0.35, p.y / px * 0.32 + t * 0.6);
        float ca = vnoise(cq) * 0.65 + vnoise(cq * 2.1 + vec2(t * 0.5, 0.0)) * 0.35 - 0.5;
        lc += mix(uColB, vec3(1.0), 0.3) * 0.34 * ca * (1.0 - 0.6 * depth);
        lc += mix(uColB, vec3(1.0), 0.55)
            * (exp(-abs(p.y - top) / (0.9 * px)) * 0.5 + exp(-abs(xi - front) / (1.0 * px)) * 0.85);
        lc *= 1.0 - 0.38 * wall;                                    // thick glass darkens the edge

        if (uDanger > 0.01) {
            // Boiling: rising bubble rings, one lane every 7 px.
            float cell = 7.0 * px;
            float ci = floor(xi / cell);
            float h1 = hash(ci + 1.7), h2 = hash(ci + 19.3);
            float by = -ih + fract(t * (0.45 + 0.6 * h2) + h1) * (2.0 * ih + 2.0 * px);
            float bx = (ci + 0.3 + 0.4 * h2) * cell + sin(t * 5.0 + h1 * 6.3) * 0.8 * px;
            float bd = length(vec2(xi - bx, p.y - by)) - (0.7 + 0.7 * h1) * px;
            lc += vec3(1.0) * 0.65 * uDanger * exp(-abs(bd) / (0.5 * px)) * step(bx, front - px);
        }
        over(col, lc, liq * 0.96);

        // ── The chip: the slice just lost, pale, holding, then draining down ──
        float cx = uChip * L;
        if (cx > fx + 0.5) {
            float cfront = cx + men * (v * v - 0.35);
            float ctop = mix(ih - 1.7 * px, -ih - 1.5 * px, uDrain);
            float cm = cover(max(max(xi - cfront, p.y - ctop), front - xi)) * inside;
            float cdepth = clamp((ctop - p.y) / (2.0 * ih), 0.0, 1.0);
            vec3 cc = mix(mix(uChipA, uChipB, cdepth), uColB, 0.28) + vec3(1.0) * 0.4 * exp(-abs(p.y - ctop) / (0.8 * px));
            over(col, cc, cm * (0.72 - 0.2 * cdepth));

            float span = step(fx, xi) * step(xi, cx);
            float lane = 4.0 * px;
            float li = floor(xi / lane);
            float hh = hash(li + 5.1);
            float lx = (li + 0.5) * lane;
            // Beads left on the glass above the falling surface, sliding after it.
            float bead = clamp(uDrain * 1.7 - hh * 0.7, 0.0, 1.0);
            float byy = mix(ih - 1.2 * px, ctop, bead * bead);
            float bdd = length(vec2(xi - lx, (p.y - byy) * 0.8)) - 0.75 * px;
            over(col, uChipA, cover(bdd) * inside * span * (1.0 - uDrain) * step(0.72, hh) * step(0.001, uDrain));
            // Drips off the underside of the tube while it drains.
            float fall = fract(t * 1.7 + hh * 3.1) * uPad;
            float dy = -hs.y - 0.5 * px - fall;
            float dd = length(vec2((xi - lx) * 1.15, p.y - dy)) - 0.85 * px;
            float dripOn = smoothstep(0.0, 0.12, uDrain) * (1.0 - smoothstep(0.75, 1.0, uDrain));
            over(col, uChipB, cover(dd) * (1.0 - tube) * span * dripOn * (1.0 - fall / uPad) * step(0.62, hh));
        }
    } else {
        // ── Energy: swirling plasma, brighter with the charge, crackling when full ──
        float fx = uLevel * L;
        float fill = cover(xi - fx) * inside * smoothstep(0.0, 0.006, uLevel);
        float x = xi / px, y = p.y / px;
        // Domain-warped noise streaming toward the front; ridges are the bright filaments.
        vec2 q = vec2(x * 0.16 - t * 1.8, y * 0.42);
        vec2 warp = vec2(vnoise(q * 1.3 + vec2(0.0, t * 0.9)), vnoise(q * 1.3 + vec2(5.2, -t * 0.7)));
        float n = vnoise(q + warp * 1.8) * 0.7 + vnoise(q * 2.4 - warp - vec2(t * 0.6, 0.0)) * 0.3;
        float fil = pow(1.0 - abs(2.0 * n - 1.0), 7.0);
        float I = 0.35 + 0.65 * uPower;
        vec3 pc = mix(uColA * 0.85, uColB, smoothstep(0.3, 0.75, n));
        pc += mix(uColB, vec3(1.0), 0.7) * fil * 0.9 * I;
        pc *= (0.55 + 0.6 * (1.0 - v * v)) * I;
        pc += uColB * exp(-abs(xi - fx) / (1.2 * px)) * 0.9;
        if (uFull > 0.01) {
            float seed = floor(t * 14.0);
            float ay = (sin(x * 0.5 + seed * 7.1) * 0.5 + sin(x * 1.3 + seed * 3.7) * 0.3) * ih * 0.8;
            pc += vec3(1.0, 0.97, 0.88) * exp(-abs(p.y - ay) / (0.35 * px)) * step(0.6, hash(seed)) * uFull;
        }
        over(col, pc, fill * 0.95);

        if (uFull > 0.01) {
            // Sparks jumping off the full tube, a few per time slice.
            float cell = 9.0 * px;
            float ci = floor(xi / cell);
            float slice = floor(t * 9.0 + hash(ci) * 4.0);
            float hs1 = hash(ci * 3.1 + slice), hs2 = hash(ci * 7.7 + slice * 1.3);
            float age = fract(t * 9.0 + hash(ci) * 4.0);
            float side = hs2 > 0.5 ? 1.0 : -1.0;
            vec2 sp = vec2((ci + hs1) * cell, side * (hs.y + age * uPad * 0.9));
            float sd = length(vec2((xi - sp.x) * 0.7, p.y - sp.y)) - 0.7 * px;
            over(col, mix(uColB, vec3(1.0), 0.6), cover(sd) * (1.0 - tube) * (1.0 - age) * step(0.55, hs1) * uFull);
        }
    }

    // ── The glass itself: rim lit from above, a specular streak, a glint ──────
    float lit = 0.5 + 0.5 * clamp(p.y / hs.y, -1.0, 1.0);
    vec3 rimCol = mix(vec3(0.82, 0.88, 1.0), vec3(1.0, 0.55, 0.5), uDanger * 0.7);
    over(col, rimCol, (tube - inside) * (0.22 + 0.55 * lit));
    float ends = smoothstep(0.0, 6.0 * px, xi) * smoothstep(L, L - 6.0 * px, xi);
    over(col, vec3(1.0), exp(-abs(p.y - ih * 0.52) / (0.6 * px)) * 0.3 * ends * inside);
    over(col, vec3(1.0), exp(-abs(p.y + ih * 0.62) / (0.8 * px)) * 0.07 * ends * inside);
    float glint = smoothstep(2.0 * px, 4.0 * px, xi) * smoothstep(16.0 * px, 9.0 * px, xi);
    over(col, vec3(1.0), exp(-abs(p.y - ih * 0.5) / (0.9 * px)) * 0.5 * glint * inside);

    if (uDanger > 0.01 && uKind < 0.5) {
        // The old SVG fractures (viewBox 100 x 12, stretched to the tube), now in the glass.
        vec2 sc = vec2(uTube.z / 100.0, uTube.w / 12.0);
        float c = 1e9;
        c = min(c, seg(p, cp(vec2(9.0, 0.0), hs, sc), cp(vec2(12.0, 4.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(12.0, 4.0), hs, sc), cp(vec2(10.0, 7.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(10.0, 7.0), hs, sc), cp(vec2(14.0, 12.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(12.0, 4.0), hs, sc), cp(vec2(17.0, 5.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(17.0, 5.0), hs, sc), cp(vec2(19.0, 3.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(47.0, 0.0), hs, sc), cp(vec2(45.0, 5.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(45.0, 5.0), hs, sc), cp(vec2(49.0, 8.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(49.0, 8.0), hs, sc), cp(vec2(47.0, 12.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(45.0, 5.0), hs, sc), cp(vec2(40.0, 7.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(81.0, 0.0), hs, sc), cp(vec2(84.0, 3.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(84.0, 3.0), hs, sc), cp(vec2(82.0, 6.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(82.0, 6.0), hs, sc), cp(vec2(86.0, 9.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(86.0, 9.0), hs, sc), cp(vec2(85.0, 12.0), hs, sc)));
        c = min(c, seg(p, cp(vec2(84.0, 3.0), hs, sc), cp(vec2(90.0, 2.0), hs, sc)));
        float cpx = c;
        over(col, vec3(1.0), cover(cpx - 0.35 * px) * 0.75 * uDanger * tube);
    }

    o = vec4(min(col.rgb, vec3(col.a)), col.a);
}`;

const root = document.documentElement;
const lowTier = () => root.getAttribute('data-gfx') === 'low';
const reducedMotion = () => root.getAttribute('data-motion') === 'reduce';

/** '#rgb', '#rrggbb' or 'rgb(a)(…)' → [r, g, b] in 0..1; null when it cannot tell. */
function parseColor(s) {
    s = (s || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
    m = /^#([0-9a-f]{6})/i.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [m[1], m[2], m[3]].map((n) => Number(n) / 255);
    return null;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);

class LiquidHud {
    constructor(hud) {
        this.hud = hud;
        this.canvas = hud.querySelector('canvas.pb-liquid');
        this.gl = null;
        this.failed = !this.canvas;
        this.lost = false;
        this.live = false;
        this.visible = true;
        this.raf = 0;
        this.last = 0;
        this.time = 0;
        this.dpr = 1;
        this.stat = { frames: 0, ms: 0, maxMs: 0 };

        const sides = [...hud.querySelectorAll('.pb-hp-side')];
        this.bars = [];
        sides.forEach((side, s) => {
            const hp = side.querySelector('.pb-hp-track');
            const en = side.querySelector('.pb-en-track');
            if (en) this.bars.push(this.makeBar(1, s, side, en));
            if (hp) this.bars.push(this.makeBar(0, s, side, hp));
        });
        this.readValues(true);

        this.onFrame = (now) => this.frame(now);
        this.sync = () => this.syncState();
        this.mo = new MutationObserver(() => this.readValues(false));
        this.mo.observe(hud, { subtree: true, attributes: true, attributeFilter: ['aria-valuenow', 'class'] });
        this.rootMo = new MutationObserver(this.sync);
        this.rootMo.observe(root, { attributes: true, attributeFilter: ['data-gfx', 'data-motion'] });
        this.ro = new ResizeObserver(() => this.measure());
        this.ro.observe(hud);
        for (const el of hud.querySelectorAll('.pb-hp-side, .pb-hp-name, .pb-hp-track, .pb-en-track')) this.ro.observe(el);
        this.io = new IntersectionObserver((entries) => {
            this.visible = entries[entries.length - 1].isIntersecting;
            this.syncState();
        });
        this.io.observe(hud);
        document.addEventListener('visibilitychange', this.sync);
        document.fonts?.ready?.then(() => this.measure()).catch(() => { });
        this.syncState();
    }

    makeBar(kind, side, plate, track) {
        return {
            kind, side, plate, track,
            fill: kind ? track.querySelector('.pb-en-fill') : null,
            x: 0, y: 0, w: 0, h: 0,
            target: 1, level: 1, chip: 0, holdUntil: 0, drain: 0,
            slosh: 0, sloshVel: 0, wave: 0,
            danger: 0, dangerTarget: 0, full: 0, state: 0,
            colA: [0, 0, 0], colB: [0, 0, 0],
        };
    }

    // ── Values: read from the meters Blazor just patched ─────────────────────
    readValues(initial) {
        const now = performance.now();
        for (const b of this.bars) {
            const n = Number(b.track.getAttribute('aria-valuenow'));
            const t = Number.isFinite(n) ? clamp01(n / 100) : b.target;
            if (b.kind === 0) {
                b.dangerTarget = b.plate.classList.contains('pb-hp-side--danger') ? 1 : 0;
            } else {
                const cl = b.fill ? b.fill.classList : null;
                b.state = cl?.contains('pb-en-spent') ? 2 : cl?.contains('pb-en-hot') ? 1 : 0;
            }
            if (initial) {
                b.target = b.level = t;
                b.danger = b.dangerTarget;
                b.full = t >= 1 && b.kind === 1 ? 1 : 0;
                continue;
            }
            if (t === b.target) continue;
            const delta = t - b.target;
            if (b.kind === 0 && delta < 0) {
                // A hit: keep the lost slice as the chip, kick the slosh and the surface.
                const dmg = -delta;
                b.chip = Math.max(b.chip > b.level ? b.chip : 0, b.target, b.level);
                b.holdUntil = now + CHIP_HOLD_MS;
                b.drain = 0;
                b.sloshVel -= Math.min(1, dmg * 5) * 7;
                b.wave = Math.min(1.5, b.wave + 0.35 + dmg * 6);
            } else if (b.kind === 0) {
                if (delta > 0.3) { b.chip = 0; b.drain = 0; }        // a new round refills
                b.sloshVel += Math.min(1, delta * 3) * 4;
                b.wave = Math.min(1, b.wave + 0.25);
            } else {
                b.sloshVel += Math.max(-1, Math.min(1, delta * 4)) * 2;
            }
            b.target = t;
        }
        if (this.live && (reducedMotion() || !this.raf)) this.drawStatic();
    }

    // ── Gates: tier, motion, WebGL2, visibility ──────────────────────────────
    syncState() {
        if (this.disposed) return;
        const allowed = !this.failed && !lowTier();
        if (allowed && !this.gl) this.initGl();
        const live = allowed && !!this.gl && !this.lost && !this.failed;
        if (live !== this.live) {
            this.live = live;
            this.hud.toggleAttribute('data-liquid', live);
            if (live) { this.readColors(); this.measure(); }
        }
        const run = live && this.visible && !document.hidden && !reducedMotion();
        if (run && !this.raf) { this.last = 0; this.raf = requestAnimationFrame(this.onFrame); }
        else if (!run && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
        if (live && !run) this.drawStatic();
    }

    initGl() {
        let q = null;
        try {
            q = createShaderQuad(this.canvas, {
                frag: FS,
                contextOptions: { alpha: true, premultipliedAlpha: true, powerPreference: 'default' },
                onLost: () => { this.lost = true; this.syncState(); },
                onRestored: () => { this.lost = false; this.syncState(); },
            });
        } catch { q = null; }
        if (!q) { this.failed = true; return; }
        this.q = q;
        this.gl = q.gl;
    }

    readColors() {
        const cs = getComputedStyle(this.hud);
        const c = (name, fb) => parseColor(cs.getPropertyValue(name)) || fb;
        this.pal = {
            hp: [
                [c('--pb-p1', [0.13, 0.77, 0.37]), c('--pb-p1-light', [0.53, 0.94, 0.67])],
                [c('--pb-p2', [0.94, 0.27, 0.27]), c('--pb-p2-light', [0.97, 0.44, 0.44])],
            ],
            chip: [c('--pb-chip-hi', [1, 0.96, 0.86]), c('--pb-chip-lo', [1, 0.69, 0.54])],
            en: [
                [c('--pb-energy', [0.36, 0.49, 0.98]), c('--pb-energy-light', [0.54, 0.64, 1])],
                [c('--pb-energy-hot', [1, 0.69, 0.13]), c('--pb-gold-bright', [1, 0.82, 0.34])],
                [c('--pb-energy-spent', [0.76, 0.21, 0.29]), c('--pb-energy-spent-light', [0.95, 0.39, 0.48])],
            ],
        };
        for (const b of this.bars) {
            const src = b.kind === 0 ? this.pal.hp[b.side] : this.pal.en[b.state];
            b.colA = src[0].slice();
            b.colB = src[1].slice();
        }
    }

    measure() {
        if (this.disposed || !this.live) return;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const hr = this.hud.getBoundingClientRect();
        const w = Math.max(1, Math.round(hr.width * dpr));
        const h = Math.max(1, Math.round(hr.height * dpr));
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        this.dpr = dpr;
        for (const b of this.bars) {
            const r = b.track.getBoundingClientRect();
            b.x = (r.left - hr.left) * dpr;
            b.y = (r.top - hr.top) * dpr;
            b.w = r.width * dpr;
            b.h = r.height * dpr;
        }
        if (!this.raf) this.drawStatic();
    }

    // ── Simulation: ease the 4 Hz values into motion ─────────────────────────
    step(dt, now) {
        for (const b of this.bars) {
            b.level += (b.target - b.level) * ease(dt, b.kind ? 7 : 13);
            b.danger += (b.dangerTarget - b.danger) * ease(dt, 4);
            b.full += ((b.kind === 1 && b.target >= 1 ? 1 : 0) - b.full) * ease(dt, 6);
            if (b.chip > b.level && now > b.holdUntil) {
                b.drain += dt / CHIP_DRAIN_S;
                if (b.drain >= 1) { b.chip = 0; b.drain = 0; }
            }
            // A damped oscillator for the front's tilt; substepped so a long frame stays stable.
            const w = 2 * Math.PI * 2.4, z = 0.14;
            for (let left = dt; left > 0; left -= 1 / 120) {
                const h = Math.min(left, 1 / 120);
                b.sloshVel += (-w * w * b.slosh - 2 * z * w * b.sloshVel) * h;
                b.slosh = Math.max(-0.6, Math.min(0.6, b.slosh + b.sloshVel * h));
            }
            b.wave *= Math.exp(-dt * 1.5);
            if (b.kind === 1) {
                const dest = this.pal.en[b.state];
                const k = ease(dt, 6);
                for (let i = 0; i < 3; i++) {
                    b.colA[i] += (dest[0][i] - b.colA[i]) * k;
                    b.colB[i] += (dest[1][i] - b.colB[i]) * k;
                }
            }
        }
    }

    frame(now) {
        this.raf = 0;
        if (!this.hud.isConnected) { this.dispose(); return; }
        const t0 = performance.now();
        const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
        this.last = now;
        this.time += dt;
        if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== this.dpr) this.measure();
        this.step(dt, now);
        this.draw(false);
        const ms = performance.now() - t0;
        this.stat.frames++;
        this.stat.ms += ms;
        if (ms > this.stat.maxMs) this.stat.maxMs = ms;
        this.raf = requestAnimationFrame(this.onFrame);
    }

    /** One still frame: reduced motion, or a change while the loop is parked. */
    drawStatic() {
        if (!this.live || !this.q) return;
        for (const b of this.bars) {
            b.level = b.target; b.chip = 0; b.drain = 0; b.slosh = 0; b.sloshVel = 0; b.wave = 0;
            b.danger = b.dangerTarget;
            b.full = b.kind === 1 && b.target >= 1 ? 1 : 0;
            if (b.kind === 1 && this.pal) { b.colA = this.pal.en[b.state][0].slice(); b.colB = this.pal.en[b.state][1].slice(); }
        }
        this.draw(true);
    }

    draw(still) {
        const gl = this.gl;
        const q = this.q;
        if (!gl || !q || gl.isContextLost()) return;
        const W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.SCISSOR_TEST);
        const pad = Math.round(PAD_CSS * dpr);
        q.set('uDpr', dpr);
        q.set('uPad', pad);
        q.set('uChipA', ...this.pal.chip[0]);
        q.set('uChipB', ...this.pal.chip[1]);
        for (const b of this.bars) {
            if (b.w < 2 || b.h < 2) continue;
            // The scissor is the bar's box; the oversized triangle is clipped to it, and
            // gl_FragCoord stays in canvas space, which is what uTube is measured in.
            gl.scissor(Math.floor(b.x - pad), Math.floor(H - (b.y + b.h) - pad), Math.ceil(b.w + 2 * pad), Math.ceil(b.h + 2 * pad));
            q.set('uTube', b.x + b.w / 2, H - (b.y + b.h / 2), b.w, b.h);
            q.set('uKind', b.kind);
            q.set('uFlip', b.side);
            q.set('uLevel', b.level);
            q.set('uChip', b.chip);
            q.set('uDrain', b.drain);
            q.set('uSlosh', b.slosh);
            q.set('uWave', b.wave);
            q.set('uDanger', b.kind === 0 ? b.danger : 0);
            q.set('uTime', still ? 1.3 + b.side * 2.1 : this.time + b.side * 13.7);
            q.set('uFull', b.full);
            q.set('uPower', b.kind === 1 ? b.level * (b.state === 2 ? 0.6 : 1) : 1);
            q.set('uColA', ...b.colA);
            q.set('uColB', ...b.colB);
            q.draw(W, H);
        }
    }

    stats() {
        const s = this.stat;
        return {
            live: this.live, running: !!this.raf, failed: this.failed, dpr: this.dpr,
            canvas: this.canvas ? [this.canvas.width, this.canvas.height] : null,
            frames: s.frames, avgMs: s.frames ? Math.round((s.ms / s.frames) * 1000) / 1000 : 0,
            maxMs: Math.round(s.maxMs * 1000) / 1000,
            bars: this.bars.map((b) => ({ kind: b.kind, side: b.side, target: b.target, level: Math.round(b.level * 1000) / 1000, chip: b.chip, danger: b.dangerTarget, state: b.state })),
        };
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.mo.disconnect();
        this.rootMo.disconnect();
        this.ro.disconnect();
        this.io.disconnect();
        document.removeEventListener('visibilitychange', this.sync);
        this.hud.removeAttribute('data-liquid');
        this.q?.dispose();
        try { this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
        this.gl = this.q = null;
    }
}

const mounted = new WeakMap();
let lastMounted = null;

/** Called by PoBrawlHud after its first render. Idempotent per element. */
export function mount(hud) {
    if (!hud || mounted.has(hud) || typeof WebGL2RenderingContext === 'undefined') return;
    const inst = new LiquidHud(hud);
    mounted.set(hud, inst);
    lastMounted = inst;
}

/** Called from PoBrawlHud.DisposeAsync. */
export function unmount(hud) {
    const inst = hud && mounted.get(hud);
    if (!inst) return;
    inst.dispose();
    mounted.delete(hud);
    if (lastMounted === inst) lastMounted = null;
}

// Diagnostics for headless checks: window.__pbLiquid.stats().
window.__pbLiquid = { stats: () => (lastMounted ? lastMounted.stats() : null) };
