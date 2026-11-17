// musicLayers.js — adaptive, synthesized music layers for the race and fight engines.
//
// No loops to download: a 4-bar pattern on a 16th-note grid, rendered voice by voice
// through dsp.js onto the shared 'music' bus. The game only says how intense the moment
// is (0..1) and, if it keeps its own beat clock, where that clock is:
//
//   intensity  ≥0     bass   — saw 8ths walking i–VI–VII–v, filter opening with intensity
//              ≥0.3   hats   — short noise ticks, the off-beat 8th accented
//              ≥0.55  kick   — four on the floor
//              ≥0.8   arp    — 16th-note minor triad two octaves up (a final lap, a last ten seconds)
//
// A layer enters or leaves only on a bar line, so a jump in intensity sounds like an
// arrangement change rather than a glitch. Free-running, the tempo follows intensity
// between `bpmLow` and `bpmHigh`; setBeat() instead locks the grid to a game's conductor.
//
// Nothing is scheduled while the music level, the master or the mute would make it
// silent (audioBus.isAudible), so music at 0 costs nothing, and stop() ends it for good.
// Voices are at most a beat long, so the ~150 ms already queued at stop() just rings out.

import * as AudioBus from './audioBus.js';
import * as Dsp from './dsp.js';

const LOOKAHEAD = 0.15;   // s of audio queued ahead of the clock
const TICK_MS = 40;       // scheduler wake-up; well inside LOOKAHEAD
const STEPS = 64;         // 4 bars of 16ths
const PROGRESSION = [0, -4, -2, -5];   // semitones from the root per bar: i, VI, VII, v
const ARP = [0, 3, 7, 12];             // minor triad + octave

/** Stems this generator can voice, in rough order of how early a build brings them in. */
export const STEM_NAMES = Object.freeze(['bass', 'pad', 'hats', 'kick', 'arp', 'lead']);

const R = (s) => Math.pow(2, s / 12);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * @param {object} [opts]
 * @param {number} [opts.root=55]     bass root, Hz (A1)
 * @param {number} [opts.bpmLow=100]  tempo at intensity 0 (free-running only)
 * @param {number} [opts.bpmHigh=140] tempo at intensity 1
 * @param {number} [opts.gain=1]      overall level multiplier
 */
export function createMusicLayers(opts) {
    const o = { root: 55, bpmLow: 100, bpmHigh: 140, gain: 1, ...(opts || {}) };
    let timer = 0;
    let intensity = 0;
    let gain = o.gain;
    let bpm = o.bpmLow;
    let locked = false;       // true once setBeat() drives the grid
    // The grid: beat position `anchorPos` was at audio time `anchorAt`.
    let anchorPos = 0, anchorAt = -1;
    let lastStep = -1;        // last 16th handed to dsp.js
    let layers = 0;           // how many layers are on, fixed for the current bar
    // Per-stem gains (tensionMixer.js). Null = the classic intensity-threshold arrangement;
    // once set, every stem — including the pad and lead that the thresholds never play — is
    // on whenever its gain is audible, at that gain. The mixer eases the gains, so a stem
    // fades in and out instead of entering on a bar line.
    let stems = null;

    function layerCount(x) {
        return x >= 0.8 ? 4 : x >= 0.55 ? 3 : x >= 0.3 ? 2 : 1;
    }

    function stepTime(step) {
        return anchorAt + (step / 4 - anchorPos) * 60 / bpm;
    }

    function reanchor(now) {
        if (anchorAt < 0) return;
        anchorPos += (now - anchorAt) * bpm / 60;
        anchorAt = now;
    }

    /** Voices for one 16th. `at` is absolute audio time. */
    function voicesFor(step, at, out) {
        const s = ((step % STEPS) + STEPS) % STEPS;
        if (s % 16 === 0) layers = layerCount(intensity);
        const bar = Math.floor(s / 16);
        const inBar = s % 16;
        const root = o.root * R(PROGRESSION[bar]);
        const g = gain;
        const open = 300 + intensity * 1500;
        const sg = (name, fallbackOn) => (stems ? (stems[name] > 0.02 ? stems[name] : 0) : (fallbackOn ? 1 : 0));
        const bassG = sg('bass', true), hatsG = sg('hats', layers >= 2), kickG = sg('kick', layers >= 3);
        const arpG = sg('arp', layers >= 4), padG = sg('pad', false), leadG = sg('lead', false);

        if (bassG && inBar % 2 === 0) {
            // The octave jump on the off-beat 8th is what makes a pulse read as a bassline.
            const up = inBar % 4 === 2 ? 2 : 1;
            out.push({ wave: 'saw', freq: root * up, dur: 0.11, attack: 0.004, decay: 0.1, gain: 0.05 * g * bassG, cutoff: open, q: 2, at });
        }
        if (hatsG && inBar % 2 === 0) {
            const off = inBar % 4 === 2;
            out.push({ wave: 'noise', freq: 0, dur: 0.03, attack: 0.001, decay: 0.028, gain: (off ? 0.03 : 0.016) * g * hatsG, cutoff: 9000, q: 0.7, pan: off ? 0.25 : -0.25, at });
        }
        if (kickG && inBar % 4 === 0) {
            out.push({ wave: 'sine', freq: 130, freqEnd: 44, sweep: 0.09, dur: 0.16, attack: 0.002, decay: 0.15, gain: 0.11 * g * kickG, at });
        }
        if (arpG) {
            const note = root * 4 * R(ARP[inBar % ARP.length]);
            out.push({ wave: 'square', freq: note, dur: 0.07, attack: 0.003, decay: 0.06, gain: 0.018 * g * arpG, cutoff: 3200, pan: inBar % 2 ? 0.35 : -0.35, at });
        }
        if (padG && inBar === 0) {
            // A held minor triad two octaves up for the whole bar: the bed under a tense moment.
            const barSec = (4 * 60) / bpm;
            for (const iv of [0, 3, 7]) {
                out.push({ wave: 'sine', freq: root * 4 * R(iv), dur: barSec * 0.98, attack: barSec * 0.25, decay: barSec * 0.7, gain: 0.012 * g * padG, at });
            }
        }
        if (leadG && (inBar === 0 || inBar === 6 || inBar === 10)) {
            // Three stabs per bar on the syncopated 3-3-2 grid, walking the triad.
            const note = root * 8 * R(ARP[(bar + (inBar >> 2)) % 3]);
            out.push({ wave: 'square', freq: note, dur: 0.14, attack: 0.004, decay: 0.12, gain: 0.014 * g * leadG, cutoff: 2600, at });
        }
    }

    function tick() {
        // Never create the context from a timer: that would fire before any user gesture.
        if (!AudioBus.hasContext() || !AudioBus.isAudible('music')) { anchorAt = -1; return; }
        const ctx = AudioBus.contextSync();
        if (!ctx || ctx.state !== 'running') { anchorAt = -1; return; }
        const now = ctx.currentTime;

        if (!locked) {
            const target = o.bpmLow + (o.bpmHigh - o.bpmLow) * intensity;
            if (Math.abs(target - bpm) > 0.05) {
                reanchor(now);
                bpm += (target - bpm) * 0.08;   // ease, ~0.5 s to settle
            }
        }
        if (anchorAt < 0) {
            // (Re)starting after silence: begin on the next bar line, a beat from now.
            anchorAt = now + 0.05;
            anchorPos = Math.ceil(Math.max(anchorPos, 0) / 4) * 4;
            lastStep = anchorPos * 4 - 1;
        }

        const voices = [];
        let step = lastStep + 1;
        while (stepTime(step) < now + LOOKAHEAD) {
            const at = stepTime(step);
            if (at >= now - 0.01) {
                const clampedAt = Math.max(at, now);
                voicesFor(step, clampedAt, voices);
                if (typeof window !== 'undefined' && window.PoRichAudio?.isRichAudio?.()) {
                    const s = ((step % STEPS) + STEPS) % STEPS;
                    const bar = Math.floor(s / 16);
                    const inBar = s % 16;
                    const rootHz = o.root * R(PROGRESSION[bar]);
                    const musicBus = AudioBus.busSync('music');
                    if (musicBus) {
                        window.PoRichAudio.playRichLayerStep({
                            ctx, bus: musicBus, bar, inBar, rootHz, intensity, gain, at: clampedAt,
                        });
                    }
                }
            }
            lastStep = step++;
        }
        if (voices.length) Dsp.playAll(voices, 'music');
    }

    return {
        /** Begin scheduling. Idempotent; silent until the music level is above 0. */
        start() {
            if (timer) return;
            timer = setInterval(tick, TICK_MS);
        },
        /** End for good: no further notes are queued. */
        stop() {
            if (timer) clearInterval(timer);
            timer = 0;
            anchorAt = -1;
        },
        /** 0..1. Layers follow on the next bar line; the free-running tempo eases toward it. */
        setIntensity(x) {
            intensity = clamp01(Number(x) || 0);
        },
        /**
         * Drive each stem directly (tensionMixer.js): `{ bass, pad, hats, kick, arp, lead }`,
         * each 0..1. Pass null to go back to the intensity thresholds.
         */
        setStemGains(g) {
            if (!g) { stems = null; return; }
            stems = stems || {};
            for (const k of STEM_NAMES) stems[k] = clamp01(Number(g[k]) || 0);
        },
        /** Overall level multiplier, for a quieter demo or spectator view. */
        setGain(x) {
            gain = Math.max(0, Number(x) || 0);
        },
        /**
         * Lock the grid to a game's own beat clock: `pos` in beats, at `beatsPerMinute`,
         * as of now. Call it every frame; a jump backwards (a new countdown) restarts the
         * pattern from the next bar of the new position.
         */
        setBeat(pos, beatsPerMinute) {
            locked = true;
            if (!(beatsPerMinute > 0) || anchorAt < 0) {
                if (beatsPerMinute > 0) bpm = beatsPerMinute;
                anchorPos = pos;
                return;
            }
            const ctx = AudioBus.contextSync();
            if (!ctx) return;
            const now = ctx.currentTime;
            bpm = beatsPerMinute;
            anchorPos = pos;
            anchorAt = now;
            const at = Math.floor(pos * 4);
            if (at < lastStep - 8) lastStep = at;
        },
        isRunning() { return !!timer; },
    };
}
