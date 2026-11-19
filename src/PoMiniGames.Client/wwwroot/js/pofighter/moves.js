// pofighter/moves.js — every attack's rules (its frame data) and the joystick motions that call
// the specials. Pure: no DOM, no clock, so tests/pofighter-moves.test.mjs drives it directly.
//
// An attack borrows a filmed clip (`anim`) until a clip of its own is filmed: a fighter whose
// data has a move named after the attack (say `sweep`) plays that instead. An air attack is the
// standing clip carried along the jump's arc. A sprite is never drawn shrunk, so the crouching
// attacks (`filmedOnly`) exist only for a fighter with that clip filmed; without it, down plus a
// button gives the standing attack.
//
// Frame data (seconds, from the clip): startup is the time to the first picture whose reach
// passes the clip's hitMin, active how long the limb stays out, recovery the rest of the clip.
// A fighter's data may override any of them with `frameData: { <move>: { startup, active,
// recovery } }` in 60 fps frames. `whiff` is extra recovery when the attack hits nothing, so a
// missed sweep or Rising Fist can be punished. Levels: high (ducked by a crouch), mid, low (must
// be blocked crouching, jumped over) and overhead (must be blocked standing).

export const MOVES = Object.freeze({
    punchMid: { button: 'punch', stance: 'stand', anim: 'punchMid', damage: 11, level: 'high',
        hitStun: 0.32, blockStun: 0.18, whiff: 0.06, hitY: 265 },
    kick: { button: 'kick', stance: 'stand', anim: 'kick', damage: 16, level: 'mid',
        hitStun: 0.36, blockStun: 0.2, whiff: 0.16, hitY: 245, heavy: true },
    crouchPunch: { button: 'punch', stance: 'crouch', anim: 'punchMid', filmedOnly: true, damage: 7,
        level: 'mid', hitStun: 0.26, blockStun: 0.14, whiff: 0.04, hitY: 200 },
    sweep: { button: 'kick', stance: 'crouch', anim: 'kick', filmedOnly: true, damage: 12, level: 'low',
        knockdown: true, hitStun: 0.3, blockStun: 0.22, whiff: 0.3, hitY: 80, heavy: true },
    jumpPunch: { button: 'punch', stance: 'air', anim: 'punchMid', rate: 1.2, damage: 10, level: 'overhead',
        hitStun: 0.3, blockStun: 0.16, hitY: 290 },
    jumpKick: { button: 'kick', stance: 'air', anim: 'kick', rate: 1.2, damage: 13, level: 'overhead',
        hitStun: 0.34, blockStun: 0.18, hitY: 270, heavy: true },
    // Specials. The projectile leaves the hand when the punch reaches its active frames.
    blast: { button: 'punch', stance: 'stand', anim: 'punchMid', special: 'qcf', name: 'PO BLAST',
        projectile: { speed: 560, damage: 10, chip: 3, hitStun: 0.34, blockStun: 0.2 }, whiff: 0.2, hitY: 265 },
    risingPunch: { button: 'punch', stance: 'stand', anim: 'punchMid', special: 'dp', name: 'RISING FIST',
        rise: { h: 175, T: 0.72, vx: 70 }, invuln: 0.16, damage: 15, chip: 2, level: 'mid', knockdown: true,
        hitStun: 0.4, blockStun: 0.22, whiff: 0.32, hitY: 320, heavy: true },
    rushKick: { button: 'kick', stance: 'stand', anim: 'kick', special: 'qcb', name: 'RUSH KICK', rate: 0.9,
        rush: 560, damage: 13, chip: 2, level: 'mid', hitStun: 0.42, blockStun: 0.24, whiff: 0.3, hitY: 245, heavy: true },
    // Every fighter's own move, found in their recording (scripts/pofighter/shot-list.html): its
    // clip is the fighter's `signature` move and its name, button and kind come from the fighter's
    // data (`signature: { name, button, kind, damage? }`). A fighter without one has none.
    signature: { button: 'punch', stance: 'stand', anim: 'punchMid', special: 'hcf', name: 'SIGNATURE', filmedOnly: true,
        damage: 18, chip: 3, level: 'mid', knockdown: true, hitStun: 0.45, blockStun: 0.26, whiff: 0.35, hitY: 260, heavy: true },
});

/**
 * What a signature's `kind` adds: a plain strike, a rush that slides in, a rise that leaves the
 * floor (an anti-air), or a projectile thrown at the clip's active frames.
 */
export const SIGNATURE_KINDS = Object.freeze({
    strike: {},
    rush: { rush: 520 },
    rise: { rise: { h: 170, T: 0.72, vx: 70 }, invuln: 0.16 },
    projectile: { projectile: { speed: 620, damage: 14, chip: 4, hitStun: 0.4, blockStun: 0.22 }, knockdown: false },
});

/** The rules for `move` as fighter `data` plays it (a signature reads the fighter's own entry). */
export function specOf(data, move) {
    if (move !== 'signature') return MOVES[move];
    const own = data?.signature ?? {};
    const name = String(own.name ?? 'SIGNATURE').toUpperCase();
    const button = own.button === 'kick' ? 'kick' : 'punch';
    const damage = Number.isFinite(own.damage) ? Math.max(5, Math.min(30, own.damage)) : MOVES.signature.damage;
    return { ...MOVES.signature, ...(SIGNATURE_KINDS[own.kind] ?? {}), name, button, damage };
}

export const isAttack = move => Object.hasOwn(MOVES, move);

/** input.js names a press after the standing move; the rules think in buttons. */
export const BUTTON_OF = Object.freeze({ punchMid: 'punch', kick: 'kick', punch: 'punch' });

/** Whether a fighter's data can play an attack (a filmed-only one needs its own clip). */
export const canPlay = (data, move) => !!MOVES[move] && (!MOVES[move].filmedOnly || !!data.moves[move])
    && (move !== 'signature' || !!data.signature);

/** The normal attack a button gives in a stance; a crouch attack the fighter lacks stands up. */
export function normalFor(button, stance, data = null) {
    if (stance === 'air') return button === 'kick' ? 'jumpKick' : 'jumpPunch';
    const stand = button === 'kick' ? 'kick' : 'punchMid';
    if (stance === 'crouch') {
        const low = button === 'kick' ? 'sweep' : 'crouchPunch';
        return !data || canPlay(data, low) ? low : stand;
    }
    return stand;
}

/**
 * How a fighter's data plays an attack: { def (the clip), rate (playback speed), own (the
 * fighter has a clip of this name) }.
 */
export function clipFor(data, move) {
    const moves = data.moves;
    if (moves[move]) return { def: moves[move], rate: 1, own: true };
    const mv = MOVES[move];
    if (!mv) return { def: moves.idle, rate: 1, own: false };
    return { def: moves[mv.anim] ?? moves.idle, rate: mv.rate ?? 1, own: false };
}

const cache = new WeakMap();   // data → { move: frame data }

/** { startup, active, recovery, total } in seconds for `move` as `data` plays it. */
export function frameData(data, move) {
    let byMove = cache.get(data);
    if (!byMove) cache.set(data, byMove = {});
    if (byMove[move]) return byMove[move];
    const { def, rate } = clipFor(data, move);
    const per = 1 / (def.fps * rate);
    const frames = def.frames;
    const total = frames.length * per;
    const min = def.hitMin ?? Math.max(...frames.map(f => f.r)) * 0.85;
    let first = frames.findIndex(f => f.r >= min);
    let last = frames.length - 1 - [...frames].reverse().findIndex(f => f.r >= min);
    if (first < 0) { first = Math.floor(frames.length / 2); last = first; }
    let fd = { startup: first * per, active: (last - first + 1) * per };
    fd.recovery = Math.max(0, total - fd.startup - fd.active);
    const own = data.frameData?.[move];
    if (own) {
        const s = k => (typeof own[k] === 'number' ? own[k] / 60 : fd[k]);
        fd = { startup: s('startup'), active: s('active'), recovery: s('recovery') };
    }
    fd.total = Math.max(total, fd.startup + fd.active + fd.recovery);
    return (byMove[move] = Object.freeze(fd));
}

// ---- motions ----
//
// Directions are numpad notation relative to the way the fighter faces: 6 toward the foe,
// 4 away, 2 down, 3 down-forward, 1 down-back, 8 up, 5 neutral.

export const MOTIONS = Object.freeze({
    qcf: [2, 3, 6],   // quarter circle forward
    qcb: [2, 1, 4],   // quarter circle back
    dp: [6, 2, 3],    // forward, down, down-forward
    hcf: [4, 1, 2, 3, 6],   // half circle forward: every fighter's signature
});
// A keyboard rolls 2 → 6 without ever holding both, so the diagonal of a quarter circle is optional.
const OPTIONAL = Object.freeze({ qcf: [3], qcb: [1], dp: [], hcf: [1, 3] });
export const MOTION_WINDOW = 0.5;   // seconds the whole motion may take, up to the press
export const PRESS_GRACE = 0.14;    // the motion's last direction may end this long before the press

/** Checked in this order, so forward-down-forward is a Rising Fist, not a Po Blast. */
export const SPECIALS = Object.freeze([
    { move: 'risingPunch', motion: 'dp', button: 'punch' },
    { move: 'blast', motion: 'qcf', button: 'punch' },
    { move: 'rushKick', motion: 'qcb', button: 'kick' },
]);

/** The numpad direction held: input { left, right, up, down }, dir +1 facing right. */
export function numpad(input, dir) {
    const fwd = dir > 0 ? input.right : input.left, back = dir > 0 ? input.left : input.right;
    const h = fwd && !back ? 1 : back && !fwd ? -1 : 0;
    const v = input.up && !input.down ? 1 : input.down && !input.up ? -1 : 0;
    return 5 + h + 3 * v;
}

/** Adds a direction to a history ([{ d, t }], oldest first) when it changed; keeps it short. */
export function record(hist, d, now) {
    if (hist.at(-1)?.d !== d) hist.push({ d, t: now });
    while (hist.length > 16) hist.shift();
    return hist;
}

/**
 * Whether the history ends in `motion` for a press at `now`: its directions in order, inside
 * MOTION_WINDOW, the last one held at the press or let go (to neutral) at most PRESS_GRACE before it.
 */
export function matchMotion(hist, now, motion) {
    const seq = MOTIONS[motion], optional = OPTIONAL[motion];
    let k = seq.length - 1;
    for (let i = hist.length - 1; i >= 0 && k >= 0; i--) {
        const end = i + 1 < hist.length ? hist[i + 1].t : now;   // the direction was held until the next one
        if (end < now - MOTION_WINDOW) return false;
        const d = hist[i].d;
        if (k === seq.length - 1) {
            // The last direction has to be fresh, with at most a let-go (neutral) after it.
            if (end < now - PRESS_GRACE) return false;
            if (d === seq[k]) k--;
            else if (d !== 5) return false;
            continue;
        }
        if (d === seq[k]) { k--; continue; }
        if (optional.includes(seq[k]) && d === seq[k - 1]) { k -= 2; continue; }
    }
    while (k >= 0 && optional.includes(seq[k])) k--;
    return k < 0;
}

/**
 * The special a press of `button` at `now` calls, or null. With `data` (the fighter's), its
 * signature is checked first: a half circle is a longer motion than the quarter circle inside it.
 */
export function specialFor(hist, now, button, data = null) {
    if (data && canPlay(data, 'signature') && specOf(data, 'signature').button === button && matchMotion(hist, now, 'hcf')) {
        return 'signature';
    }
    return SPECIALS.find(s => s.button === button && matchMotion(hist, now, s.motion))?.move ?? null;
}
