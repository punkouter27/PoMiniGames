// pofighter/moves.js — the two attacks' rules (their frame data). Pure: no DOM, no clock.
//
// A fighter is the 10 filmed moves of scripts/pofighter/shot-list.html (stance, walk forward and
// back, crouch, jump, punch, kick, cheer, knockout fall, get up). The only attacks are the punch
// and the kick, standing: down plus a button gives the same attack, and a jump is just a jump.
//
// Frame data (seconds, from the clip): startup is the time to the first picture whose reach
// passes the clip's hitMin, active how long the limb stays out, recovery the rest of the clip.
// A fighter's data may override any of them with `frameData: { <move>: { startup, active,
// recovery } }` in 60 fps frames. `whiff` is extra recovery when the attack hits nothing.
// Levels: high (ducked by a crouch) and mid.

export const MOVES = Object.freeze({
    punchMid: { button: 'punch', damage: 11, level: 'high',
        hitStun: 0.32, blockStun: 0.18, whiff: 0.06, hitY: 265 },
    kick: { button: 'kick', damage: 16, level: 'mid',
        hitStun: 0.36, blockStun: 0.2, whiff: 0.16, hitY: 245, heavy: true },
});

export const isAttack = move => Object.hasOwn(MOVES, move);

/** The attack a press asks for: input.js names a press after the standing move. */
export const attackOf = pressed => (pressed === 'kick' ? 'kick' : pressed === 'punchMid' || pressed === 'punch' ? 'punchMid' : null);

/** How a fighter's data plays an attack: { def (the clip), rate (playback speed), own }. */
export function clipFor(data, move) {
    const def = data.moves[move];
    return def ? { def, rate: 1, own: true } : { def: data.moves.idle, rate: 1, own: false };
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
