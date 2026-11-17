// tensionMixer.js — adaptive musical tension engine (deck idea #15).
//
// musicLayers.js plays the stems; this decides how much of each to play. A game reports
// what is happening as a handful of 0..1 DRIVERS, and the mixer turns them into one tension
// value and then into per-stem gains, eased so a stem swells in or thins out instead of
// switching tracks:
//
//   clock      0..1  time pressure — 1 at the final seconds / final lap
//   position   0..1  standing — 0 leading, 1 last (fronts and close chases both tense up)
//   health     0..1  1 healthy, 0 nearly out
//   proximity  0..1  a rival / threat right on you
//   weather    0..1  storm severity
//   scoreDiff -1..1  you minus them, normalised; a close score late is the tensest state
//
// Anything a game does not track it simply leaves out (it counts as calm).
//
// Pure functions `tensionFromDrivers` and `stemGains` carry all the logic and are node-
// tested; `createTensionMixer` adds the smoothing and hands the result to a musicLayers
// instance. Music is off app-wide by default (audioBus music level 0): musicLayers already
// schedules nothing while it is inaudible, so driving the mixer costs nothing then either.

import { STEM_NAMES } from './musicLayers.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (x, d) => (Number.isFinite(x) ? x : d);

/** Weights for each driver's contribution; they sum to 1 so a full-on moment is tension 1. */
export const DRIVER_WEIGHTS = Object.freeze({
    clock: 0.28, position: 0.12, health: 0.16, proximity: 0.2, weather: 0.08, score: 0.16,
});

/**
 * One tension value from the drivers. Pure.
 * @param {{clock?:number, position?:number, health?:number, proximity?:number, weather?:number, scoreDiff?:number}} d
 * @returns {number} 0..1
 */
export function tensionFromDrivers(d = {}) {
    const clock = clamp01(num(d.clock, 0));
    // Being near the front matters more than being near the back: only someone in the hunt
    // has something to lose. Unknown position contributes nothing.
    const position = d.position == null ? 0 : 1 - clamp01(d.position) * 0.7;
    const danger = d.health == null ? 0 : 1 - clamp01(d.health);
    const proximity = clamp01(num(d.proximity, 0));
    const weather = clamp01(num(d.weather, 0));
    // A close score is tense, and more so as the clock runs out; a blowout is not.
    const score = d.scoreDiff == null ? 0 : (1 - Math.min(1, Math.abs(d.scoreDiff))) * (0.4 + 0.6 * clock);
    const w = DRIVER_WEIGHTS;
    const raw = clock * w.clock + position * w.position + danger * w.health
        + proximity * w.proximity + weather * w.weather + score * w.score;
    // Hard peaks: any single driver at full alarm pulls the whole mix most of the way up,
    // so a last-second near miss is never averaged away by calm drivers. Combined as a soft
    // union (not a max) so the other drivers still move the mix on top of a peak.
    const peak = Math.max(clock, danger, proximity) * 0.75;
    return clamp01(1 - (1 - peak) * (1 - raw));
}

/**
 * Per stem: where it starts fading in and where it is full, on the tension axis.
 * The pad is the exception — it is a calm bed that thins as the drums arrive, and comes
 * back under weather/danger.
 */
export const STEM_CURVE = Object.freeze({
    bass: Object.freeze([0, 0.1]),
    pad: Object.freeze([0, 0.15]),
    hats: Object.freeze([0.25, 0.45]),
    kick: Object.freeze([0.45, 0.65]),
    arp: Object.freeze([0.7, 0.88]),
    lead: Object.freeze([0.82, 0.97]),
});

function ramp(t, [lo, hi]) {
    return hi <= lo ? (t >= lo ? 1 : 0) : clamp01((t - lo) / (hi - lo));
}

/**
 * Stem gains for a tension value. Pure.
 * @param {number} tension 0..1
 * @param {{weather?:number, health?:number}} [d] drivers that colour the arrangement
 * @returns {Record<string, number>} one 0..1 gain per STEM_NAMES entry
 */
export function stemGains(tension, d = {}) {
    const t = clamp01(num(tension, 0));
    const out = {};
    for (const name of STEM_NAMES) out[name] = ramp(t, STEM_CURVE[name] || [0, 1]);
    // The pad gives way to the drums, but storms and low health keep a dark bed under them.
    const darkBed = Math.max(clamp01(num(d.weather, 0)), d.health == null ? 0 : 1 - clamp01(d.health));
    out.pad = clamp01(out.pad * (1 - out.kick * 0.7) + darkBed * 0.5);
    return out;
}

/**
 * Bind the engine to a musicLayers instance.
 * @param {ReturnType<import('./musicLayers.js').createMusicLayers>} music
 * @param {{attack?:number, release?:number}} [opts] time constants (s): tension rises fast, falls slow
 */
export function createTensionMixer(music, opts = {}) {
    const attack = Math.max(0.05, opts.attack ?? 0.6);
    const release = Math.max(0.05, opts.release ?? 3.5);
    let tension = 0;
    const gains = Object.fromEntries(STEM_NAMES.map((n) => [n, 0]));
    let lastAt = 0;

    return {
        /**
         * Feed the current drivers. Call at any rate (per frame or per snapshot); `dtSec` is
         * the time since the last call, measured here when omitted.
         */
        update(drivers, dtSec) {
            const now = typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
            const dt = Math.min(0.5, Math.max(0, dtSec ?? (lastAt ? now - lastAt : 0.016)));
            lastAt = now;
            const target = tensionFromDrivers(drivers);
            const tc = target > tension ? attack : release;
            tension += (target - tension) * (1 - Math.exp(-dt / tc));
            const want = stemGains(tension, drivers);
            // Stems ease on their own, a bit slower than the tension, so a stem crossfades
            // over roughly a bar at race tempo.
            const k = 1 - Math.exp(-dt / 0.9);
            for (const n of STEM_NAMES) gains[n] += (want[n] - gains[n]) * k;
            if (music) {
                music.setIntensity?.(tension);
                music.setStemGains?.(gains);
            }
            return tension;
        },
        /** Snap to calm (a new round). */
        reset() {
            tension = 0;
            for (const n of STEM_NAMES) gains[n] = 0;
            lastAt = 0;
            music?.setIntensity?.(0);
            music?.setStemGains?.(gains);
        },
        tension() { return tension; },
        gains() { return { ...gains }; },
    };
}

if (typeof window !== 'undefined') {
    window.PoTension = { tensionFromDrivers, stemGains, createTensionMixer, STEM_CURVE, DRIVER_WEIGHTS };
}
