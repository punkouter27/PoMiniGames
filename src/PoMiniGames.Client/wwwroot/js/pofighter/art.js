// pofighter/art.js — what the practice room and the demo draw the same way: loading a fighter,
// the room behind the fight, and one fighter picture (facing either way).
//
// Built-in fighters ship as data/pofighter/<id>.json + its sprite sheet (scripts/pofighter/);
// any other id is a fighter made in the in-browser Studio (studio.js, saved in IndexedDB).

import { getCustomFighter, listCustomFighters } from './studio.js';

/** The fighters that ship with the game, in roster order. */
export const ROSTER = [
    { id: 'p1', name: 'Nick' },
    { id: 'kim', name: 'Kim' },
];
export const isBuiltIn = id => ROSTER.some(f => f.id === id);

/**
 * Alternate colours (index 0 is the filmed look). A canvas filter over the whole picture, so a
 * mirror match (Kim vs Kim) reads at a glance; the arcade's last boss is the Shadow palette.
 * A browser without canvas filters draws the original colours.
 */
export const PALETTES = [
    { id: 'original', name: '', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'grayscale(1) sepia(1) hue-rotate(185deg) saturate(2.6) brightness(0.72)' },
    { id: 'crimson', name: 'Crimson', filter: 'sepia(0.85) hue-rotate(-35deg) saturate(2.2) brightness(0.92)' },
    { id: 'jade', name: 'Jade', filter: 'sepia(0.8) hue-rotate(75deg) saturate(1.9)' },
    { id: 'gold', name: 'Gold', filter: 'sepia(1) saturate(2.4) brightness(1.05)' },
];
const paletteFilter = i => PALETTES[i]?.filter ?? 'none';

/** The portrait for a fighter: the shipped webp, or the Studio's cut-out data URL. */
export const portraitUrl = (id, custom = null) => (isBuiltIn(id) ? `data/pofighter/${id}-portrait.webp` : custom?.portrait ?? '');

/**
 * Every fighter, built-in first and then the Studio's (oldest first), loaded:
 * [{ id, name, data, sheet, custom, portrait }]. A built-in that fails makes it null; a Studio
 * fighter that fails is left out.
 */
export async function loadAllFighters() {
    const customs = await listCustomFighters();
    const built = await Promise.all(ROSTER.map(f => loadFighter(f.id)));
    if (built.some(f => !f)) return null;
    const own = await Promise.all(customs.map(c => loadFighter(c.id)));
    return [
        ...ROSTER.map((f, i) => ({ ...f, ...built[i], custom: false, portrait: portraitUrl(f.id) })),
        ...customs.map((c, i) => own[i] && { id: c.id, name: c.name, ...own[i], custom: true, portrait: c.portrait })
            .filter(Boolean),
    ];
}

const assetUrl = path => new URL(path, document.baseURI).href;

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`PoFighter: could not load ${src}`));
        img.src = src;
    });
}

/** { data, sheet } for a fighter id, or null when a Studio fighter is gone. */
export async function loadFighter(id = 'p1') {
    if (!isBuiltIn(id)) {
        const custom = await getCustomFighter(id);
        return custom ? { data: custom.data, sheet: await loadImage(custom.sheetDataUrl) } : null;
    }
    const data = await (await fetch(assetUrl(`data/pofighter/${id}.json`))).json();
    return { data, sheet: await loadImage(assetUrl(`data/pofighter/${data.sheet}`)) };
}

/** The room: a wall with panel lines, a skirting band and a wooden floor from `ground` down. */
export function drawRoom(ctx, width, ground, height) {
    drawWall(ctx, width, ground);
    drawFloor(ctx, width, ground, height);
}

/**
 * The wall alone (the fight draws it on a slower camera than the floor, for depth). `t` (seconds)
 * sways the two light shafts that fall from the high windows; omit it for still shafts.
 */
export function drawWall(ctx, width, ground, t = 0) {
    const far = 4000;   // the wall and floor run past the world so wide screens have no bars
    const wall = ctx.createLinearGradient(0, 0, 0, ground);
    wall.addColorStop(0, '#232a45');
    wall.addColorStop(1, '#4a5580');
    ctx.fillStyle = wall;
    ctx.fillRect(-far, -far, far * 2 + width, far + ground);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    for (let x = -1320; x < width + 1400; x += 220) ctx.fillRect(x, 0, 6, ground - 70);
    // The high windows on the key-light side and the shafts they throw toward the floor.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [wx, phase] of [[150, 0], [430, 1.7]]) {
        const sway = Math.sin(t * 0.21 + phase) * 14;
        ctx.fillStyle = 'rgba(160,190,255,0.10)';
        ctx.fillRect(wx, 40, 90, 120);
        const shaft = ctx.createLinearGradient(0, 160, 0, ground);
        shaft.addColorStop(0, 'rgba(170,200,255,0.10)');
        shaft.addColorStop(1, 'rgba(170,200,255,0)');
        ctx.fillStyle = shaft;
        ctx.beginPath();
        ctx.moveTo(wx, 160); ctx.lineTo(wx + 90, 160);
        ctx.lineTo(wx + 330 + sway, ground); ctx.lineTo(wx + 150 + sway, ground);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#2d3558';
    ctx.fillRect(-far, ground - 70, far * 2 + width, 70);
}

/** The skirting shadow and the wooden floor from `ground` down. */
export function drawFloor(ctx, width, ground, height) {
    const far = 4000;
    const floor = ctx.createLinearGradient(0, ground - 34, 0, height);
    floor.addColorStop(0, '#8a6a4c');
    floor.addColorStop(1, '#4f3a29');
    ctx.fillStyle = floor;
    ctx.fillRect(-far, ground - 34, far * 2 + width, far);
    // Board seams, so the reflection has a surface to sit on.
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let x = -1300; x < width + 1300; x += 120) ctx.fillRect(x, ground - 34, 2, height - ground + 34);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(-far, ground - 34, far * 2 + width, 3);
}

/**
 * One picture `f` of a fighter with its anchor at (x, ground), with no lighting (the VS card's
 * portraits). Sheets face right; dir −1 mirrors about the anchor. `flash` (0–1) brightens it.
 */
export function drawPicture(ctx, sheet, data, f, x, ground, dir = 1, flash = 0, palette = 0) {
    const res = data.res ?? 1;   // sheet pixels per world unit
    const w = f.w / res, h = f.h / res;
    ctx.save();
    ctx.translate(x, ground);
    if (dir < 0) ctx.scale(-1, 1);
    if (palette) ctx.filter = paletteFilter(palette);
    ctx.drawImage(sheet, f.x, f.y, f.w, f.h, -f.ax, -f.ay, w, h);
    ctx.filter = 'none';
    if (flash > 0) {
        // Brighten only the fighter's own pixels: draw the picture again additively.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, flash);
        ctx.drawImage(sheet, f.x, f.y, f.w, f.h, -f.ax, -f.ay, w, h);
    }
    ctx.restore();
}

// ---- the lit fighter ----
//
// A photo cut from a phone video sits flat on a painted arena unless it shares the arena's light.
// FighterPainter draws one fighter the way the room would light it:
//   shadow     the fighter's own silhouette laid on the floor behind it (key light front left),
//              blurred, plus a small dark contact patch under the feet, so a kick, a crouch or a
//              body on the canvas casts the shape it is, not a fixed oval;
//   light      the arena's cool key light: a faint bluish rim on the edges facing the light and a
//              little shade toward the floor, the same for every fighter. There is no per-fighter
//              colour change: the videos are correctly balanced, so skin and clothes keep their
//              real colours;
//   cross-fade into or out of a one-shot move (attack, crouch, fall, get-up, cheer) the previous
//              picture fades out over the new one (60 ms), so a pose change between two clips
//              never pops; stance and walks switch freely without it;
//   flash      a landed hit lights the fighter white for a moment;
//   glow       a hit nearby lights the side of the body facing it, warm (opts.glow);
//   reflection a faint copy on the wooden floor, fading with height (opts.reflect);
//   trail      fading after-images on the frames of a punch or kick (opts.trail).
// Each fighter on screen owns one painter (it remembers that fighter's last picture).

const LIGHT = { x: -1, y: -0.8 };                  // toward the key light (front left, above)
/** Moves the key light (the fight drifts it slowly). x, y: the direction toward the light. */
export function setKeyLight(x, y) { LIGHT.x = x; LIGHT.y = y; }
const RIM = 'rgba(176, 205, 255, 1)';
const RIM_ALPHA = 0.2;
const GLOW = 'rgba(255, 196, 120, 1)';
const TRAIL_SECONDS = 0.12;   // how long an after-image lingers
const TRAIL_MOVES = new Set(['punchMid', 'kick']);
const FADE_SECONDS = 0.06;
const FADE_FROM = 0.5;    // the old picture starts part-faded, so a big pose change never doubles up
// Stance and walks hand over to each other many times a second and share a pose: no fade there.
const FLUID = new Set(['idle', 'walkF', 'walkB']);
const reduceFx = () => document.documentElement.dataset.motion === 'reduce';

function layer() {
    const c = document.createElement('canvas');
    return { c, g: c.getContext('2d') };
}

function fit(l, W, H) {
    if (l.c.width < W || l.c.height < H) {
        l.c.width = Math.max(l.c.width, W);
        l.c.height = Math.max(l.c.height, H);
    }
    l.g.setTransform(1, 0, 0, 1, 0, 0);
    l.g.globalCompositeOperation = 'source-over';
    l.g.globalAlpha = 1;
    l.g.clearRect(0, 0, W, H);
}

export class FighterPainter {
    constructor() {
        this.body = layer();     // the lit picture, at sheet resolution
        this.mask = layer();     // scratch: silhouettes for the rim and the shadow
        this.last = null;        // { f, move, x, dir } drawn last frame
        this.prev = null;        // the picture being faded out, and where it stood: { f, x, dir }
        this.fadeAt = 0;
        this.ghosts = [];        // after-images: { f, x, dir, at }
    }

    /**
     * Draws the fighter with its anchor at (x, ground). opts: { move, dir, flash (0–1),
     * now (seconds), shadow (default true), light (default true), palette (PALETTES index),
     * glow ({ side: +1 the way it faces, -1 behind; k 0-1 }), reflect (0-1 floor reflection alpha),
     * trail (bool: keep after-images while attacking), attacking (bool: the move is an attack;
     * default: punchMid or kick), lift (raise the body off the floor: a jump arc) }. The picture is
     * always drawn at its filmed size: nothing squashes or shrinks a fighter.
     */
    paint(ctx, sheet, data, f, x, ground, opts = {}) {
        const { move = '', dir = 1, flash = 0, now = performance.now() / 1000, palette = 0, lift = 0 } = opts;
        const res = data.res ?? 1;
        const y = ground - lift;   // the body rises; its shadow stays on the floor
        // A new move starts a cross-fade from the last picture of the old one.
        // It stays where it stood in the room: a stepping attack moves the fighter's x when it ends.
        if (this.last && this.last.move !== move && this.last.f !== f && !(FLUID.has(move) && FLUID.has(this.last.move))) {
            this.prev = { f: this.last.f, x: this.last.x, dir: this.last.dir };
            this.fadeAt = now;
        }
        this.last = { f, move, x, dir };
        const fade = this.prev && !reduceFx() ? FADE_FROM * (1 - (now - this.fadeAt) / FADE_SECONDS) : 0;
        if (fade <= 0 || (this.prev && this.prev.dir !== dir)) this.prev = null;   // a turn never cross-fades
        const prev = this.prev && fade > 0 ? { ...this.prev.f, ax: this.prev.f.ax - (this.prev.x - x) * dir } : null;

        // The layer covers both pictures, in sheet pixels, around the shared anchor.
        const box = { x0: -f.ax * res, y0: -f.ay * res, x1: f.w - f.ax * res, y1: f.h - f.ay * res };
        if (prev) {
            box.x0 = Math.min(box.x0, -prev.ax * res); box.y0 = Math.min(box.y0, -prev.ay * res);
            box.x1 = Math.max(box.x1, prev.w - prev.ax * res); box.y1 = Math.max(box.y1, prev.h - prev.ay * res);
        }
        const pad = 8;
        const W = Math.ceil(box.x1 - box.x0) + pad * 2, H = Math.ceil(box.y1 - box.y0) + pad * 2;
        const ox = -box.x0 + pad, oy = -box.y0 + pad;     // the anchor inside the layer

        const { c, g } = this.body;
        fit(this.body, W, H);
        g.filter = paletteFilter(palette);
        g.drawImage(sheet, f.x, f.y, f.w, f.h, ox - f.ax * res, oy - f.ay * res, f.w, f.h);
        if (prev) {
            g.globalAlpha = Math.min(1, fade);
            g.drawImage(sheet, prev.x, prev.y, prev.w, prev.h, ox - prev.ax * res, oy - prev.ay * res, prev.w, prev.h);
            g.globalAlpha = 1;
        }
        g.filter = 'none';
        if (opts.light !== false) this.light(W, H, dir, res, opts.glow);
        if (flash > 0) {
            // Additive: light skin and clothes flare, black clothes stay dark (a white wash greys them).
            g.globalCompositeOperation = 'lighter';
            g.globalAlpha = Math.min(0.9, flash);
            g.drawImage(c, 0, 0, W, H, 0, 0, W, H);
            g.globalAlpha = 1;
            g.globalCompositeOperation = 'source-over';
        }
        const reflect = (opts.reflect ?? 0) * Math.max(0, 1 - lift / 80);
        if (reflect > 0) this.reflection(ctx, W, H, ox, oy, x, ground, dir, res, reflect);
        if (opts.shadow !== false) this.shadow(ctx, W, H, ox, oy, x, ground, dir, res, lift);
        this.trail(ctx, sheet, data, f, y, now, !!opts.trail && (opts.attacking ?? TRAIL_MOVES.has(move)) && !reduceFx(), x, dir);

        ctx.save();
        ctx.translate(x, y);
        if (dir < 0) ctx.scale(-1, 1);
        ctx.drawImage(c, 0, 0, W, H, -ox / res, -oy / res, W / res, H / res);
        ctx.restore();
    }

    // After-images: the last few attack pictures, pale and additive behind the body.
    trail(ctx, sheet, data, f, ground, now, keep, x, dir) {
        if (keep && this.ghosts.at(-1)?.f !== f) this.ghosts.push({ f, x, dir, at: now });
        this.ghosts = this.ghosts.filter(g => now - g.at < TRAIL_SECONDS && g.f !== f);
        if (!this.ghosts.length) return;
        const res = data.res ?? 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = 'brightness(1.5) saturate(0.2)';
        for (const g of this.ghosts) {
            ctx.globalAlpha = 0.22 * (1 - (now - g.at) / TRAIL_SECONDS);
            ctx.save();
            ctx.translate(g.x, ground);
            if (g.dir < 0) ctx.scale(-1, 1);
            ctx.drawImage(sheet, g.f.x, g.f.y, g.f.w, g.f.h, -g.f.ax, -g.f.ay, g.f.w / res, g.f.h / res);
            ctx.restore();
        }
        ctx.restore();
    }

    // A faint mirror image on the floor, strongest at the feet and gone by the knees.
    reflection(ctx, W, H, ox, oy, x, ground, dir, res, alpha) {
        const { c } = this.body;
        const m = this.mask;
        fit(m, W, H);
        m.g.drawImage(c, 0, 0, W, H, 0, 0, W, H);
        m.g.globalCompositeOperation = 'destination-in';
        const fade = m.g.createLinearGradient(0, oy - 160 * res, 0, oy);
        fade.addColorStop(0, 'rgba(0,0,0,0)');
        fade.addColorStop(1, 'rgba(0,0,0,1)');
        m.g.fillStyle = fade;
        m.g.fillRect(0, 0, W, H);
        m.g.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.translate(x, ground);
        ctx.scale(dir < 0 ? -1 : 1, -0.5);   // flipped about the floor line, foreshortened
        ctx.globalAlpha = alpha;
        if (!reduceFx()) ctx.filter = 'blur(1.5px)';
        ctx.drawImage(m.c, 0, 0, W, H, -ox / res, -oy / res, W / res, H / res);
        ctx.restore();
    }

    // The arena's light on the body layer: a rim on the edges facing the key light, shade toward
    // the floor, and (glow) a warm rim on the side facing a hit that just landed nearby.
    light(W, H, dir, res, glow) {
        const { g } = this.body;
        const off = Math.max(2, Math.round(2.2 * res));   // rim thickness, in sheet px
        // The layer is drawn mirrored for dir -1, so the light's side flips inside it.
        this.rim(W, H, LIGHT.x * dir, LIGHT.y, off, RIM, RIM_ALPHA);
        if (glow?.k > 0) this.rim(W, H, glow.side, -0.25, off * 2, GLOW, 0.55 * Math.min(1, glow.k));
        g.globalCompositeOperation = 'source-atop';
        // Shade toward the floor and a faint cool cast overall, so the photo takes the room's tone.
        const shade = g.createLinearGradient(0, 0, 0, H);
        shade.addColorStop(0, 'rgba(120, 150, 255, 0.06)');
        shade.addColorStop(0.55, 'rgba(40, 50, 110, 0.06)');
        shade.addColorStop(1, 'rgba(10, 14, 40, 0.24)');
        g.fillStyle = shade;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
    }

    // A crescent of `color` on the edges facing (lx, ly): the silhouette minus itself moved away.
    rim(W, H, lx, ly, off, color, alpha) {
        const { c, g } = this.body;
        const m = this.mask;
        fit(m, W, H);
        m.g.drawImage(c, 0, 0, W, H, 0, 0, W, H);
        m.g.globalCompositeOperation = 'source-in';
        m.g.fillStyle = color;
        m.g.fillRect(0, 0, W, H);
        m.g.globalCompositeOperation = 'destination-out';
        m.g.drawImage(c, 0, 0, W, H, -lx * off, -ly * off, W, H);
        g.globalCompositeOperation = 'source-atop';
        g.globalAlpha = alpha;
        g.drawImage(m.c, 0, 0, W, H, 0, 0, W, H);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
    }

    // The silhouette laid on the floor behind the fighter, then a contact patch under the feet.
    shadow(ctx, W, H, ox, oy, x, ground, dir, res, lift = 0) {
        const away = Math.max(0.35, 1 - lift / 260);   // a body in the air casts a fainter shadow
        const { c } = this.body;
        const m = this.mask;
        fit(m, W, H);
        m.g.drawImage(c, 0, 0, W, H, 0, 0, W, H);
        m.g.globalCompositeOperation = 'source-in';
        m.g.fillStyle = '#000';
        m.g.fillRect(0, 0, W, H);
        m.g.globalCompositeOperation = 'source-over';

        ctx.save();
        ctx.translate(x, ground);
        // Heights fold onto the floor behind the body and lean away from the light.
        ctx.transform(1, 0, 0.42 * LIGHT.x, 0.09, 0, 0);   // a standing body (373) reaches 34 up: the floor's back edge
        if (dir < 0) ctx.scale(-1, 1);
        ctx.globalAlpha = 0.34 * away;
        if (!reduceFx()) ctx.filter = 'blur(3px)';
        ctx.drawImage(m.c, 0, 0, W, H, -ox / res, -oy / res, W / res, H / res);
        ctx.restore();

        ctx.save();
        const contact = ctx.createRadialGradient(x, ground - 3, 4, x, ground - 3, 70);
        contact.addColorStop(0, 'rgba(0,0,0,0.32)');
        contact.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = contact;
        ctx.beginPath();
        ctx.ellipse(x, ground - 3, 70, 12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}
