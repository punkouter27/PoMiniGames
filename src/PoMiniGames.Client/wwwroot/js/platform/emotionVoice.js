// platform/emotionVoice.js — a character's voice: 5 emotions × 5 intensities, a real recording
// when one exists and a procedural stand-in when it does not. One module for every game that
// gives its characters a voice set (PoFighter: pofighter/voice.js; PoBrawl: pobrawl/fighterVoice.js).
//
//   wwwroot/audio/<game>/<characterId>/<emotion>-<1..5>.wav     e.g. pofighter/kim/hurt-3.wav
//   wwwroot/audio/<game>/manifest.json                          which of those files exist
//
// The manifest keeps a game from requesting hundreds of files that are not there (and works
// offline, since the service worker precaches it). Drop WAVs into a character's folder and run
// `pwsh scripts/pofighter/voices.ps1 -Game <game>` to rewrite the manifest; every clip it lists
// replaces the stand-in for that character, emotion and intensity, and the rest stay procedural.
//
// The stand-in is this module's procedural voice unless the caller passes its own `fallback` to
// say(): a game that already has sounds for an emotion (PoBrawl's pain grunt) maps the emotion
// onto them instead of replacing them.
//
// Sound goes through the platform's sfx bus (audioBus.js), so mute and the Effects slider apply,
// and nothing plays before the first user gesture has unlocked audio.

import { busSync, contextSync, isAudible } from './audioBus.js';

export const MOODS = ['angry', 'happy', 'hurt', 'insult', 'celebrate'];
export const LEVELS = [1, 2, 3, 4, 5];

/** Neutral procedural voice: base pitch (Hz), oscillator, formant (Hz) and a level trim. */
export const NEUTRAL_VOICE = { pitch: 190, wave: 'square', formant: 1100, trim: 0.45 };

const clamp = n => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));

/**
 * One game's voice set.
 *   game     the folder under wwwroot/audio/ ('pofighter', 'pobrawl')
 *   voices   { [characterId]: { pitch, wave, formant, trim } } for the procedural voice
 *   voiceOf  optional (characterId) => voice, consulted when `voices` has no entry
 *   neutral  the voice for everyone else (BYE slots, unknown ids)
 *   gap      seconds a character waits before speaking again at the same or a lower level
 */
export function createEmotionVoice({ game, voices = {}, voiceOf = null, neutral = NEUTRAL_VOICE, gap = 0.45 }) {
    const base = () => new URL(`audio/${game}/`, document.baseURI).href;
    let manifest = null;              // { [characterId]: ["hurt-3", ...] }
    let manifestLoad = null;
    const buffers = new Map();        // "kim/hurt-3" → AudioBuffer | Promise
    const lastAt = new Map();         // characterId → { t, level } of the last line

    function loadManifest() {
        manifestLoad ??= fetch(base() + 'manifest.json')
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}))
            .then(m => (manifest = m && typeof m === 'object' ? m : {}));
        return manifestLoad;
    }

    const hasRecording = (id, mood, level) => !!manifest?.[id]?.includes(`${mood}-${clamp(level)}`);

    function recording(ctx, id, mood, level) {
        const key = `${id}/${mood}-${level}`;
        let b = buffers.get(key);
        if (!b) {
            b = fetch(`${base()}${key}.wav`).then(r => r.arrayBuffer()).then(a => ctx.decodeAudioData(a)).catch(() => null);
            buffers.set(key, b);
            b.then(v => buffers.set(key, v));
        }
        return Promise.resolve(b);
    }

    const voiceFor = id => voices[id] ?? voiceOf?.(id) ?? neutral;

    /**
     * Speak a line. mood: one of MOODS; level 1 (mild) … 5 (all out). `fallback(mood, level)`,
     * when given, plays instead of the procedural voice for a missing (or failed) recording.
     * Returns false when it was skipped (muted, audio locked, or the same character spoke a
     * moment ago and this is not louder).
     */
    function say(id, mood, level = 3, { fallback = null } = {}) {
        if (!MOODS.includes(mood) || !isAudible('sfx')) return false;
        const ctx = contextSync();
        const out = busSync('sfx');
        if (!ctx || !out || ctx.state !== 'running') return false;
        level = clamp(level);
        const now = ctx.currentTime;
        const last = lastAt.get(id);
        if (last && now - last.t < gap && level <= last.level) return false;
        lastAt.set(id, { t: now, level });

        const standIn = () => (fallback ? fallback(mood, level) : synth(ctx, out, id, mood, level));
        if (hasRecording(id, mood, level)) {
            recording(ctx, id, mood, level).then(buf => {
                if (!buf) { standIn(); return; }
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(out);
                src.start();
            });
        } else {
            standIn();
        }
        return true;
    }

    /** Schedules the procedural line for `id` (exported for sound tests). */
    function synth(ctx, out, id, mood, level) {
        synthVoice(ctx, out, voiceFor(id), mood, clamp(level));
    }

    return { MOODS, LEVELS, loadManifest, hasRecording, say, synth };
}

// ---- the procedural voices ----
//
// Each mood is a short "syllable" pattern: pitch contour, length, grit. Intensity scales
// loudness, length, the number of syllables, pitch range and distortion, so level 1 is a
// mutter and level 5 a shout. Recipes per mood (what a listener should read into them):
//   angry      low, falling growl with grit           ("grrr!")
//   happy      bright rising chirps                   ("heh-heh!")
//   hurt       sharp noise hit + falling grunt        ("oof!")
//   insult     sing-song up-down taunt                ("nyah-nyah!")
//   celebrate  rising arpeggio with vibrato           ("yeah-ah-AH!")
const RECIPES = {
    angry: { syllables: [1, 1, 2, 2, 3], dur: 0.2, from: 1.0, to: 0.7, grit: 0.6, noise: 0.05 },
    happy: { syllables: [1, 2, 2, 3, 4], dur: 0.11, from: 1.1, to: 1.45, grit: 0.05, noise: 0 },
    hurt: { syllables: [1, 1, 1, 2, 2], dur: 0.16, from: 1.3, to: 0.6, grit: 0.3, noise: 0.5 },
    insult: { syllables: [2, 2, 3, 4, 4], dur: 0.13, from: 1.2, to: 0.95, grit: 0.15, noise: 0, alternate: true },
    celebrate: { syllables: [1, 2, 3, 3, 4], dur: 0.15, from: 1.0, to: 1.6, grit: 0.1, noise: 0, arpeggio: true, vibrato: true },
};

let noiseBuffer = null;
function noise(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    return noiseBuffer;
}

function shaper(ctx, amount) {
    const ws = ctx.createWaveShaper();
    const k = amount * 60, n = 512, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    ws.curve = curve;
    return ws;
}

/** Schedules one procedural line with voice `v` ({ pitch, wave, formant, trim }) into `out`. */
export function synthVoice(ctx, out, v, mood, level) {
    const r = RECIPES[mood];
    if (!r) return;
    const t0 = ctx.currentTime + 0.01;
    const gainPeak = 0.12 + level * 0.05;
    const count = r.syllables[level - 1];
    const dur = r.dur * (0.85 + level * 0.1);
    const range = 1 + (level - 1) * 0.12;      // pitch excursion grows with intensity

    const master = ctx.createGain();
    master.gain.value = v.trim ?? 1;
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = v.formant * (1 + level * 0.05);
    formant.Q.value = 1.4;
    const dry = ctx.createGain();
    dry.gain.value = 0.55;
    const grit = shaper(ctx, r.grit * (0.4 + level * 0.15));
    grit.connect(formant);
    grit.connect(dry);
    formant.connect(master);
    dry.connect(master);
    master.connect(out);

    for (let s = 0; s < count; s++) {
        const start = t0 + s * dur * 1.05;
        let f0 = v.pitch * r.from, f1 = v.pitch * Math.pow(r.to, range);
        if (r.alternate) { const up = s % 2 === 0; f0 = v.pitch * (up ? 1.25 : 1.0) * range; f1 = f0 * (up ? 0.98 : 0.92); }
        if (r.arpeggio) { const step = Math.pow(1.26, s); f0 *= step; f1 *= step; }
        const osc = ctx.createOscillator();
        osc.type = v.wave;
        osc.frequency.setValueAtTime(f0, start);
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), start + dur);
        if (r.vibrato) {
            const lfo = ctx.createOscillator(), depth = ctx.createGain();
            lfo.frequency.value = 6 + level;
            depth.gain.value = f0 * 0.03 * level;
            lfo.connect(depth).connect(osc.frequency);
            lfo.start(start); lfo.stop(start + dur + 0.05);
        }
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(gainPeak, start + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(env).connect(grit);
        osc.start(start);
        osc.stop(start + dur + 0.02);

        if (r.noise > 0 && s === 0) {
            const n = ctx.createBufferSource(), ng = ctx.createGain(), hp = ctx.createBiquadFilter();
            n.buffer = noise(ctx);
            hp.type = 'highpass';
            hp.frequency.value = 900;
            ng.gain.setValueAtTime(r.noise * gainPeak * (0.6 + level * 0.15), start);
            ng.gain.exponentialRampToValueAtTime(0.0001, start + 0.07 + level * 0.015);
            n.connect(hp).connect(ng).connect(master);
            n.start(start); n.stop(start + 0.2);
        }
    }
}
