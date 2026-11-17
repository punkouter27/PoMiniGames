// acoustics.js — per-game reverb spaces and doppler.
//
// THE PROBLEM WITH ONE REVERB
// audioBus.js shipped with a single synthesised impulse response: 1.9 s of
// exponentially-decaying noise. That is a serviceable "generic room", and it is
// wrong in every game. PoBrawl is a hard-walled arena where a hit should slap
// back off the far side. PoRacer is outdoors — there is nothing to reflect off,
// and a 1.9 s tail there sounds like driving inside a cathedral. ConnectFive is
// a plastic board an arm's length away, where the only reverb is the room you
// are sitting in.
//
// HOW THESE IRs ARE BUILT
// Not just decaying noise. A real impulse response has two parts and the ear
// reads them differently:
//
//   EARLY REFLECTIONS — a handful of discrete, sparse taps in the first ~80 ms.
//   These are what tell you the SIZE and SHAPE of the space; their delays are
//   the actual path lengths off the nearest surfaces. Noise alone has no early
//   structure, which is why a pure-noise reverb always sounds like "reverb"
//   rather than like a place.
//
//   LATE DIFFUSE TAIL — exponentially decaying noise, additionally darkened
//   over time by a one-pole lowpass whose coefficient tightens as the tail
//   decays. Air and soft surfaces absorb high frequencies faster than low ones,
//   so a tail that keeps its brightness to the end sounds synthetic.
//
// The two channels get different tap patterns and independent noise, which is
// what produces stereo width. Identical channels collapse to a mono image in
// the middle of your head.
//
// Everything is generated at runtime: no IR files to download, and the buffers
// are cached per space per sample rate.

import * as AudioBus from './audioBus.js';

/**
 * Space definitions.
 *  seconds    — tail length
 *  decay      — exponent of the amplitude falloff; higher = faster
 *  damping    — 0..1, how fast the tail darkens (1 = very absorbent)
 *  predelay   — ms before the first early reflection; reads as distance to the
 *               nearest wall, and is the single strongest "how big" cue
 *  taps       — [delayMs, gain] early reflections
 *  send       — the default wet level for this space
 */
const SPACES = {
    /** Default. Neutral small-to-medium room; the menu and leaderboard spaces. */
    room: {
        seconds: 0.9, decay: 4.2, damping: 0.55, predelay: 7,
        taps: [[11, 0.42], [19, 0.30], [27, 0.24], [41, 0.16], [58, 0.11]],
        send: 0.16,
    },
    /** PoBrawl. Hard concrete bowl — long, bright, obvious slapback. */
    arena: {
        seconds: 2.6, decay: 2.4, damping: 0.28, predelay: 22,
        taps: [[24, 0.55], [37, 0.44], [61, 0.38], [88, 0.30], [124, 0.22], [171, 0.15]],
        send: 0.34,
    },
    /** PoMarbleRace. Enclosed channel: strong, regularly-spaced flutter echoes. */
    tunnel: {
        seconds: 1.5, decay: 3.0, damping: 0.42, predelay: 9,
        taps: [[9, 0.52], [18, 0.46], [27, 0.40], [36, 0.35], [45, 0.30], [54, 0.26], [63, 0.21]],
        send: 0.28,
    },
    /**
     * PoRacer. Outdoors: almost no early reflections (nothing near enough to
     * reflect off) and a short, very dark tail that stands in for distant
     * scenery plus air absorption.
     */
    outdoor: {
        seconds: 0.7, decay: 5.5, damping: 0.86, predelay: 34,
        taps: [[41, 0.16], [77, 0.09]],
        send: 0.11,
    },
    /** Cavernous, dark, slow — for a space that should feel oppressive. */
    cavern: {
        seconds: 3.4, decay: 2.0, damping: 0.62, predelay: 41,
        taps: [[38, 0.40], [67, 0.34], [103, 0.29], [158, 0.22], [216, 0.16]],
        send: 0.38,
    },
    /** The quizzes. Smooth, flattering, mid-sized hall. */
    hall: {
        seconds: 1.8, decay: 3.1, damping: 0.45, predelay: 18,
        taps: [[19, 0.40], [33, 0.33], [52, 0.27], [79, 0.20]],
        send: 0.22,
    },
    /**
     * TicTacToe / ConnectFive. A board on a table: the tail is the listener's
     * own room, so it is very short and the early taps are close and quiet.
     */
    tabletop: {
        seconds: 0.34, decay: 7.0, damping: 0.72, predelay: 3,
        taps: [[4, 0.30], [8, 0.22], [13, 0.15]],
        send: 0.10,
    },
    /** No reverb at all. */
    dry: { seconds: 0.1, decay: 12, damping: 0.9, predelay: 0, taps: [], send: 0 },
    /**
     * PoMule. An 8-bit sound chip through a television speaker in a living room:
     * barely any tail, two close taps off the cabinet, and dark — a square wave
     * with a bright reverb on it stops sounding like 1983.
     */
    crt: {
        seconds: 0.26, decay: 8.0, damping: 0.82, predelay: 2,
        taps: [[3, 0.20], [7, 0.12]],
        send: 0.07,
    },
    /** PoCabinet. A grandstand straight: the outdoor shape plus one long slap off the stands. */
    grandstand: {
        seconds: 0.9, decay: 4.8, damping: 0.8, predelay: 30,
        taps: [[36, 0.18], [118, 0.22], [171, 0.10]],
        send: 0.13,
    },
    /** PoEcosystem. An island under open sky: far, soft, damp — foliage eats the highs. */
    island: {
        seconds: 1.1, decay: 4.6, damping: 0.9, predelay: 46,
        taps: [[53, 0.12], [97, 0.07]],
        send: 0.12,
    },
    /** SandPlayground. A glass-walled sandbox on a desk: short, bright and boxy. */
    sandbox: {
        seconds: 0.5, decay: 5.6, damping: 0.36, predelay: 4,
        taps: [[5, 0.34], [10, 0.27], [16, 0.20], [23, 0.13]],
        send: 0.14,
    },
};

/** @type {Map<string, AudioBuffer>} */
const _cache = new Map();
let _cacheRate = 0;
let _current = null;

/**
 * Build the impulse response for a space.
 * @param {BaseAudioContext} ctx
 * @param {object} def
 * @returns {AudioBuffer}
 */
function buildIR(ctx, def) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * def.seconds));
    const buf = ctx.createBuffer(2, len, rate);

    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);

        // ── Late diffuse tail ──────────────────────────────────────────
        // One-pole lowpass state. The coefficient is recomputed per sample so
        // the filter closes as the tail decays; a fixed coefficient gives a
        // tail that is uniformly dull instead of one that gets duller.
        let lp = 0;
        for (let i = 0; i < len; i++) {
            const t = i / len;
            const env = Math.pow(1 - t, def.decay);
            const white = Math.random() * 2 - 1;
            // a → 1 means "pass everything"; it falls toward 0 as t rises,
            // scaled by how absorbent this space is.
            const a = 1 - def.damping * t * 0.92;
            lp += (white - lp) * a;
            d[i] = lp * env;
        }

        // ── Early reflections ──────────────────────────────────────────
        // Written on top of the tail as discrete spikes. Each channel gets its
        // delays scaled slightly differently — a real listener's two ears are
        // never equidistant from a wall, and that inequality IS the stereo
        // image. Identical taps in both channels would collapse it to mono.
        const skew = c === 0 ? 0.94 : 1.07;
        const pre = Math.floor((def.predelay / 1000) * rate * skew);
        for (const [ms, g] of def.taps) {
            const idx = pre + Math.floor((ms / 1000) * rate * skew);
            if (idx >= len) continue;
            // Alternating polarity. Same-sign taps sum into a single thickened
            // transient; alternating them keeps the reflections distinguishable.
            const sign = (idx & 1) ? 1 : -1;
            d[idx] += g * sign;
            // A short smear after each tap so it reads as a reflection off a
            // surface with texture rather than as a click.
            const smear = Math.floor(rate * 0.0015);
            for (let k = 1; k < smear && idx + k < len; k++) {
                d[idx + k] += g * sign * (1 - k / smear) * (Math.random() * 0.6);
            }
        }

        // ── Normalise ──────────────────────────────────────────────────
        // Without this, `arena` is ~4× louder than `tabletop` for the same send
        // level and switching spaces mid-session is a volume jump.
        let peak = 0;
        for (let i = 0; i < len; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
        if (peak > 0) {
            const k = 0.92 / peak;
            for (let i = 0; i < len; i++) d[i] *= k;
        }
    }
    return buf;
}

/**
 * Switch the app to a named acoustic space. Call on route entry / scene change,
 * never mid-play — see the truncation note on AudioBus.setSpaceBuffer.
 *
 * @param {'room'|'arena'|'tunnel'|'outdoor'|'cavern'|'hall'|'tabletop'|'dry'} name
 * @param {number} [send] override the space's default wet level (0..1)
 */
export async function setSpace(name, send) {
    const def = SPACES[name] || SPACES.room;
    const ctx = await AudioBus.context();
    if (!ctx) return;

    // Sample rate can change when the output device changes (headphones
    // plugged in). An IR built at the old rate would play back at the wrong
    // length and pitch, so the cache is keyed on it.
    if (_cacheRate !== ctx.sampleRate) {
        _cache.clear();
        _cacheRate = ctx.sampleRate;
    }

    let buf = _cache.get(name);
    if (!buf) {
        buf = buildIR(ctx, def);
        _cache.set(name, buf);
    }
    await AudioBus.setSpaceBuffer(buf);
    await AudioBus.setReverb(send == null ? def.send : send);
    _current = name;
}

export function currentSpace() { return _current; }

/**
 * Route key → space. paletteBus.setGame() hands every route here, so the space follows
 * the page the way the accent does. A route not listed gets the neutral room.
 * PoVoxelStrike is dry because its own audio.js runs indoor/outdoor convolvers already.
 */
const GAME_SPACES = {
    menu: 'room',
    pobrawl: 'arena',
    pomarblerace: 'tunnel',
    poracer: 'outdoor',
    tictactoe: 'tabletop',
    connectfive: 'tabletop',
    funquiz: 'hall',
    couplequiz: 'hall',
    povoxelstrike: 'dry',
    pocabinet: 'grandstand',
    pomule: 'crt',
    poecosystem: 'island',
    sandplayground: 'sandbox',
};

let _wanted = null;
let _armed = false;

function applyWanted() {
    _armed = false;
    for (const evt of ['pointerdown', 'keydown']) window.removeEventListener(evt, applyWanted, true);
    if (_wanted && _wanted !== _current) setSpace(_wanted);
}

/**
 * Switch to a game's space. Never creates the AudioContext itself: before the first
 * gesture it only remembers the choice and applies it on that gesture, so a route
 * change never builds an IR (or wakes audio) for a player who has not made a sound.
 * @param {string} gameKey
 */
export function useGame(gameKey) {
    _wanted = GAME_SPACES[gameKey] || 'room';
    if (_wanted === _current) return;
    if (AudioBus.hasContext()) { setSpace(_wanted); return; }
    if (_armed || typeof window === 'undefined') return;
    _armed = true;
    for (const evt of ['pointerdown', 'keydown']) window.addEventListener(evt, applyWanted, { capture: true, passive: true });
}

/**
 * Pre-build a space's IR without switching to it. Worth doing on a lobby screen
 * for the space the game itself will use: generating a 3.4 s stereo IR is a
 * few million Math.random() calls on the main thread, which is a visible hitch
 * if it happens on the frame the round starts.
 * @param {string} name
 */
export async function prewarm(name) {
    const def = SPACES[name];
    if (!def) return;
    const ctx = await AudioBus.context();
    if (!ctx) return;
    if (_cacheRate !== ctx.sampleRate) { _cache.clear(); _cacheRate = ctx.sampleRate; }
    if (!_cache.has(name)) _cache.set(name, buildIR(ctx, def));
}

// ── Doppler ────────────────────────────────────────────────────────────────
//
// The Web Audio PannerNode used to implement doppler itself; that was removed
// from the spec because it was underspecified and nobody implemented it the
// same way. Since every sound here is synthesised, applying it ourselves is
// both easy and more controllable: shift the requested frequency and let the
// voice play at the shifted pitch.

/** Speed of sound, in whatever world units the caller uses per second. */
const SPEED_OF_SOUND = 343;

/**
 * Doppler frequency ratio for a source moving relative to a listener.
 *
 * Only the component of velocity ALONG the line between them matters — a marble
 * whipping past at right angles is not approaching or receding at that instant,
 * so it is not pitch-shifted. Projecting onto the unit separation vector is
 * what produces the characteristic rise-then-fall as something passes you,
 * rather than a pitch that just tracks speed.
 *
 * @param {{x:number,y:number,z:number}} sourcePos
 * @param {{x:number,y:number,z:number}} sourceVel   units/s
 * @param {{x:number,y:number,z:number}} [listenerPos]
 * @param {{x:number,y:number,z:number}} [listenerVel]
 * @returns {number} multiply the source frequency by this
 */
export function dopplerRatio(sourcePos, sourceVel, listenerPos, listenerVel) {
    const lp = listenerPos || { x: 0, y: 0, z: 0 };
    const lv = listenerVel || { x: 0, y: 0, z: 0 };
    let dx = sourcePos.x - lp.x;
    let dy = sourcePos.y - lp.y;
    let dz = sourcePos.z - lp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return 1;
    dx /= dist; dy /= dist; dz /= dist;

    // Positive = receding.
    const vSource = sourceVel.x * dx + sourceVel.y * dy + sourceVel.z * dz;
    const vListener = lv.x * dx + lv.y * dy + lv.z * dz;

    // Clamp well below Mach 1. Approaching the speed of sound the denominator
    // goes to zero and the ratio to infinity — a marble clipping through a wall
    // for one frame would otherwise emit a 200 kHz voice.
    const s = Math.max(-0.7 * SPEED_OF_SOUND, Math.min(0.7 * SPEED_OF_SOUND, vSource));
    const l = Math.max(-0.7 * SPEED_OF_SOUND, Math.min(0.7 * SPEED_OF_SOUND, vListener));
    const ratio = (SPEED_OF_SOUND - l) / (SPEED_OF_SOUND + s);
    return Math.max(0.5, Math.min(2.0, ratio));
}

/**
 * Convenience for the 2D games (PoRacer), where everything happens on
 * a plane and the listener is stationary at the origin.
 * @param {number} dx  source position relative to listener
 * @param {number} dy
 * @param {number} vx  source velocity
 * @param {number} vy
 */
export function dopplerRatio2D(dx, dy, vx, vy) {
    return dopplerRatio({ x: dx, y: 0, z: dy }, { x: vx, y: 0, z: vy });
}

if (typeof window !== 'undefined') {
    window.PoAcoustics = { setSpace, currentSpace, useGame, prewarm, dopplerRatio, dopplerRatio2D };
    // paletteBus (a classic script) may have run its first setGame before this module
    // evaluated; pick the route up here so a direct load into a game gets its space.
    useGame((location.pathname.split('/')[1] || '').toLowerCase() || 'menu');
}
