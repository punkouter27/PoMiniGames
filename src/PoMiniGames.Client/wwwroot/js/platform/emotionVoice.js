// platform/emotionVoice.js — a character's voice: 5 emotions × 5 intensities, a real recording
// when one exists and an advanced procedural imitation when it does not. One module for every
// game that gives its characters a voice set (PoFighter: pofighter/voice.js; PoBrawl:
// pobrawl/fighterVoice.js).
//
//   wwwroot/audio/<game>/voices.json                            THE voice manifest (po-voice-manifest/1)
//   wwwroot/audio/<game>/<characterId>/<emotion>-<1..5>.wav     e.g. pofighter/kim/hurt-3.wav
//
// voices.json lists every character × 5 emotions × 5 levels with its WAV path and an `exists`
// flag, plus each character's procedural voice profile (`voice`). It is written by
// `pwsh scripts/pofighter/voices.ps1 -Game <game>` (drop a WAV in, run it, `exists` turns true),
// never by hand except for the profiles. At run time a cell with `exists: true` plays its WAV;
// every other cell is synthesised here, and a file the manifest says is missing is never
// requested. A missing or invalid manifest means procedural for everyone (one warning).
//
// The imitation (renderVocalisation, pure: no Web Audio, so it runs anywhere and is tested in
// Node): a Rosenberg glottal pulse train with jitter, shimmer, a rasp subharmonic and pulsed
// aspiration noise, through four formant resonators gliding between vowel targets (a e i o u
// schwa, scaled by the profile's formantScale), syllables with consonant onsets (h, s, sh, f
// noise; k, t, p bursts; n, w, y glides) and a prosody per emotion. Deterministic: the noise and
// jitter are seeded from (character, emotion, level, take); each render is cached as an
// AudioBuffer, and the output is peak-normalised so it sits near the recordings' loudness.
//
// Sound goes through the platform's sfx bus (audioBus.js), so mute and the Effects slider apply,
// and nothing plays before the first user gesture has unlocked audio.

import { busSync, contextSync, isAudible } from './audioBus.js';

export const MOODS = ['angry', 'happy', 'hurt', 'insult', 'celebrate'];
export const LEVELS = [1, 2, 3, 4, 5];
export const SAMPLE_RATE = 24000;
export const TAKES = 3;

const clampLevel = n => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
const clamp01 = n => Math.min(1, Math.max(0, n));

// ---- deterministic randomness ----

export function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

function mulberry32(a) {
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- voice profiles ----

/** The profile fields voices.json carries per character (`voice`). */
export const DEFAULT_PROFILE = {
    pitchHz: 150, formantScale: 1, breath: 0.2, rasp: 0.2,
    vibratoHz: 5, vibratoDepth: 0.02, tempo: 1, timbre: 'neutral',
};

/**
 * A complete profile: the manifest's `voice` over the defaults. With no manifest entry the
 * profile is derived from the id, so two characters never share a voice even then.
 */
export function profileFor(id, voice = null) {
    if (voice && typeof voice === 'object') return { ...DEFAULT_PROFILE, ...voice };
    const r = mulberry32(hashString(`profile|${id}`));
    return {
        ...DEFAULT_PROFILE,
        pitchHz: 100 + r() * 130,
        formantScale: 0.92 + r() * 0.22,
        breath: 0.1 + r() * 0.25,
        rasp: 0.05 + r() * 0.35,
        vibratoHz: 4.5 + r() * 2,
        vibratoDepth: 0.012 + r() * 0.02,
        tempo: 0.9 + r() * 0.2,
    };
}

// ---- the plan: syllables and prosody per emotion ----

// Vowel targets (adult male, Hz) for F1-F4; scaled by the profile's formantScale.
const VOWELS = {
    a: [730, 1090, 2440, 3400], e: [530, 1840, 2480, 3500], i: [270, 2290, 3010, 3700],
    o: [570, 840, 2410, 3300], u: [300, 870, 2240, 3300], '@': [500, 1500, 2500, 3500],
    ae: [660, 1720, 2410, 3400],
};
const BANDWIDTHS = [90, 110, 170, 250];
const FORMANT_GAINS = [1, 0.7, 0.4, 0.22];
// Consonant onsets: noise bands (fricatives, bursts) and glides (a vowel the syllable starts from).
const NOISES = {
    h: { dur: 0.05, center: 1500, q: 0.7, gain: 0.22 },
    s: { dur: 0.08, center: 6000, q: 2, gain: 0.3 },
    sh: { dur: 0.08, center: 2800, q: 2.5, gain: 0.3 },
    f: { dur: 0.09, center: 5000, q: 0.8, gain: 0.16 },
    k: { dur: 0.014, center: 1800, q: 1.5, gain: 0.8, burst: true },
    t: { dur: 0.012, center: 4200, q: 1.5, gain: 0.8, burst: true },
    p: { dur: 0.01, center: 900, q: 1, gain: 0.8, burst: true },
};
const GLIDES = { w: 'u', y: 'i', n: '@' };

/**
 * The vocalisation as a list of segments (pure; exported for tests). Each segment is
 * { kind: 'voiced' | 'noise' | 'gap', dur, ... }; durations are seconds.
 */
export function planVocalisation(profile, emotion, level, take = 0) {
    const p = profileFor('', profile);
    const L = clampLevel(level);
    const ls = (L - 1) / 4;                                  // 0 at level 1, 1 at level 5
    const rng = mulberry32(hashString(`plan|${emotion}|${L}|${take}`));
    const vary = (x, amt = 0.06) => x * (1 + (rng() - 0.5) * 2 * amt);
    const time = 1 / Math.max(0.5, p.tempo || 1);
    const durScale = (0.8 + 0.1 * L) * time;
    const range = 1 + 0.6 * ls;                              // pitch excursion grows with level
    const dev = x => 1 + (x - 1) * range;
    const segs = [];
    const base = {
        rasp: clamp01(p.rasp), breath: clamp01(p.breath), oq: 0.6, attack: 0.018, release: 0.05,
        vibHz: p.vibratoHz, vibDepth: p.vibratoDepth, gain: 0.7 + 0.3 * ls, nasal: false, peakAt: 0.5,
    };
    const gap = d => segs.push({ kind: 'gap', dur: d * time });
    const noise = (name, extra = {}) => { const n = NOISES[name]; segs.push({ kind: 'noise', ...n, dur: n.dur * time, ...extra }); };
    function syl(onset, vowel, o) {
        let from = o.vowelFrom ?? vowel;
        if (NOISES[onset]) noise(onset, { gain: NOISES[onset].gain * (0.7 + 0.3 * ls) });
        if (GLIDES[onset]) from = GLIDES[onset];
        const f0 = p.pitchHz;
        segs.push({
            ...base, kind: 'voiced', vowelFrom: from, vowelTo: vowel, glide: GLIDES[onset] ? 0.35 : 1,
            ...o, dur: vary(o.dur) * durScale,
            f0From: f0 * o.f0[0], f0Peak: f0 * (o.f0[1] ?? (o.f0[0] + o.f0[2]) / 2), f0To: f0 * o.f0[2],
            nasal: o.nasal ?? onset === 'n',
        });
        if (o.coda) noise(o.coda, { gain: NOISES[o.coda].gain * 0.45 });
    }
    const laugh = (n, start) => {
        for (let i = 0; i < n; i++) {
            syl('h', 'a', { dur: 0.085, f0: [dev(start - 0.06 * i), dev(start - 0.06 * i + 0.03), dev(start - 0.06 * i - 0.08)], attack: 0.008, release: 0.03 });
            gap(0.035);
        }
    };

    switch (emotion) {
        case 'angry': {
            const rasp = clamp01(base.rasp + 0.3 + 0.12 * L);
            if (L <= 2) {
                syl('h', '@', { dur: 0.15, f0: [dev(1.1), dev(1.12), dev(0.88)], oq: 0.5, attack: 0.006, rasp, coda: 'p', peakAt: 0.2 });
                if (L === 2) { gap(0.06); syl('h', 'a', { dur: 0.13, f0: [dev(1.05), dev(1.08), dev(0.85)], oq: 0.5, attack: 0.006, rasp }); }
            } else {
                syl(null, 'a', { vowelFrom: '@', dur: 0.22 + 0.07 * L, f0: [dev(1.2), dev(1.25), dev(0.75)], oq: 0.45, attack: 0.005, rasp, peakAt: 0.2, release: 0.08 });
                for (let i = 0; i < L - 3; i++) { gap(0.05); syl('h', 'a', { dur: 0.12, f0: [dev(1.1), dev(1.12), dev(0.85)], oq: 0.45, attack: 0.005, rasp }); }
            }
            break;
        }
        case 'happy': {
            if (L <= 2) {
                syl('h', 'e', { dur: 0.13, f0: [dev(1.05), dev(1.2), dev(1.0)], oq: 0.65, vibDepth: base.vibDepth * 1.5 });
                if (L === 2) { gap(0.05); syl('h', 'e', { dur: 0.11, f0: [dev(1.0), dev(1.12), dev(0.95)], oq: 0.65 }); }
            } else {
                syl('h', 'e', { dur: 0.14, f0: [dev(1.1), dev(1.3), dev(1.05)], oq: 0.65, vibDepth: base.vibDepth * 1.5 });
                gap(0.05);
                laugh(L - 1, 1.3);
            }
            break;
        }
        case 'hurt': {
            const breath = clamp01(base.breath + 0.25 + 0.1 * L);
            if (L >= 2) { noise('h', { dur: (0.06 + 0.03 * L) * time, center: 1800, inhale: true, gain: 0.25 + 0.05 * L }); gap(0.03); }
            if (L === 5) {
                syl(null, 'o', { vowelFrom: 'a', dur: 0.85, f0: [dev(1.5), dev(1.55), dev(0.8)], breath, oq: 0.55, peakAt: 0.25, vibHz: 6, vibDepth: base.vibDepth * 4, release: 0.15 });
            } else {
                const vowel = L <= 2 ? 'u' : '@';
                syl(null, vowel, { dur: 0.2 + 0.06 * L, f0: [dev(1.35), dev(1.3), dev(0.7)], breath, oq: 0.6, peakAt: 0.1, coda: L <= 2 ? 'f' : 'k' });
            }
            break;
        }
        case 'insult': {
            if (L >= 4) { noise('p'); noise('f'); gap(0.05); }
            const count = L <= 2 ? 2 : L <= 4 ? 3 : 4;
            for (let i = 0; i < count; i++) {
                const high = i % 2 === 0;
                syl('n', 'ae', { dur: 0.14, f0: high ? [dev(1.3), dev(1.32), dev(1.25)] : [dev(1.05), dev(1.0), dev(0.95)], nasal: true, oq: 0.55 });
                gap(0.025);
            }
            if (L >= 4) syl('h', 'e', { dur: 0.11, f0: [dev(1.15), dev(1.2), dev(1.0)], oq: 0.6 });
            break;
        }
        case 'celebrate': {
            const vib = base.vibDepth * (2.5 + 0.5 * L);
            if (L <= 2) {
                syl('y', 'a', { vowelFrom: 'e', dur: 0.25 + 0.05 * L, f0: [dev(1.0), dev(1.25), dev(1.35)], peakAt: 0.7, vibDepth: vib, release: 0.1 });
            } else {
                syl('w', 'u', { dur: 0.16, f0: [dev(1.0), dev(1.1), dev(1.2)] });
                gap(0.03);
                syl('h', 'u', { dur: 0.35 + 0.1 * L, f0: [dev(1.15), dev(1.6), dev(1.5)], peakAt: 0.4, vibDepth: vib, release: 0.14 });
                if (L >= 4) { gap(0.06); laugh(2, 1.35); }
            }
            break;
        }
        default:
            break;
    }
    return segs;
}

/** Peak the rendered line is normalised to: louder with the level (0.42 … 0.82). */
export const peakFor = level => 0.32 + 0.1 * clampLevel(level);

// ---- the renderer ----

function bandpass(f, q, sr) {
    const w0 = 2 * Math.PI * Math.min(f, sr * 0.45) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

function makeFilter() { return { x1: 0, x2: 0, y1: 0, y2: 0, c: null }; }
function runFilter(st, x) {
    const c = st.c;
    const y = c.b0 * x + c.b2 * st.x2 - c.a1 * st.y1 - c.a2 * st.y2;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
    return y;
}

// Rosenberg glottal flow over one period: phase 0..1, open quotient oq (rise 2/3, fall 1/3).
function glottalFlow(phase, oq) {
    const tp = oq * 0.66, tn = oq * 0.34;
    if (phase < tp) return 0.5 * (1 - Math.cos(Math.PI * phase / tp));
    if (phase < tp + tn) return Math.cos(Math.PI * (phase - tp) / (2 * tn));
    return 0;
}

const smooth = x => x * x * (3 - 2 * x);

/**
 * Render one vocalisation to mono samples (pure and deterministic; exported for tests).
 * Returns a Float32Array at `sampleRate`, peak-normalised to peakFor(level).
 */
export function renderVocalisation(id, emotion, level, { profile = null, take = 0, sampleRate = SAMPLE_RATE } = {}) {
    const p = profileFor(id, profile);
    const L = clampLevel(level);
    const segs = planVocalisation(p, emotion, L, take);
    const sr = sampleRate;
    const total = Math.min(2.5, segs.reduce((s, g) => s + g.dur, 0) + 0.05);
    const out = new Float32Array(Math.ceil(total * sr));
    const rng = mulberry32(hashString(`${id}|${emotion}|${L}|${take}`));
    const white = () => rng() * 2 - 1;
    const scale = p.formantScale || 1;
    const formants = BANDWIDTHS.map(() => makeFilter());
    let pos = 0;

    for (const seg of segs) {
        const n = Math.min(out.length - pos, Math.round(seg.dur * sr));
        if (n <= 0) break;
        if (seg.kind === 'gap') { pos += n; continue; }
        if (seg.kind === 'noise') {
            const st = makeFilter();
            st.c = bandpass(seg.center * (seg.inhale ? 1 : scale), seg.q, sr);
            for (let i = 0; i < n; i++) {
                const t = i / n;
                // A burst snaps on and dies; a fricative swells and fades; an inhaled gasp rises and cuts.
                const env = seg.burst ? Math.exp(-t * 6) : seg.inhale ? Math.pow(t, 1.5) * (t < 0.92 ? 1 : (1 - t) / 0.08) : Math.sin(Math.PI * t);
                if (seg.inhale && i % 64 === 0) st.c = bandpass(seg.center * (0.7 + 0.6 * t), seg.q, sr);
                out[pos + i] += runFilter(st, white()) * env * seg.gain * 1.2;
            }
            pos += n;
            continue;
        }
        // Voiced: the glottal pulse train with jitter, shimmer and rasp, plus pulsed aspiration.
        let phase = 0, period = 0, amp = 1, prevFlow = 0, f0Now = seg.f0From, odd = false;
        const jitter = 0.005 + 0.01 * seg.rasp, shimmer = 0.03 + 0.03 * seg.rasp;
        const attack = Math.max(1, Math.round(seg.attack * sr)), release = Math.max(1, Math.round(Math.min(seg.release, seg.dur * 0.5) * sr));
        for (let i = 0; i < n; i++) {
            const t = i / n;
            if (i % 32 === 0) {
                // Formants glide from the onset's vowel to the syllable's over its first part.
                const g = smooth(clamp01(t / (seg.glide || 1)));
                const a = VOWELS[seg.vowelFrom] ?? VOWELS['@'], b = VOWELS[seg.vowelTo] ?? VOWELS['@'];
                for (let k = 0; k < 4; k++) {
                    let f = (a[k] + (b[k] - a[k]) * g) * scale;
                    if (seg.nasal && k === 1) f *= 1.15;   // the sneer: F2 up
                    if (seg.nasal && k === 0) f *= 0.9;
                    formants[k].c = bandpass(f, f / BANDWIDTHS[k], sr);
                }
            }
            // Pitch contour: from → peak (at peakAt) → to, with vibrato.
            const pk = seg.peakAt;
            const base = t < pk ? seg.f0From + (seg.f0Peak - seg.f0From) * smooth(t / pk)
                : seg.f0Peak + (seg.f0To - seg.f0Peak) * smooth((t - pk) / (1 - pk));
            const vib = 1 + seg.vibDepth * Math.sin(2 * Math.PI * seg.vibHz * (i / sr));
            phase += f0Now / sr;
            if (phase >= 1 || period === 0) {
                // A new period: jitter the pitch, shimmer the amplitude; rasp halves every other pulse.
                phase -= Math.floor(phase);
                period++;
                odd = !odd;
                f0Now = base * vib * (1 + white() * jitter) * (odd ? 1 + seg.rasp * 0.03 : 1);
                amp = (1 + white() * shimmer) * (odd ? 1 - seg.rasp * 0.55 : 1);
            }
            const flow = glottalFlow(phase, seg.oq);
            const dFlow = (flow - prevFlow) * (sr / Math.max(60, f0Now)) * 0.08;   // radiated: the derivative
            prevFlow = flow;
            const aspiration = white() * seg.breath * (0.25 + 0.75 * flow) * 0.5;
            const src = dFlow * amp + aspiration;
            let y = 0;
            for (let k = 0; k < 4; k++) y += runFilter(formants[k], src) * FORMANT_GAINS[k];
            const env = Math.min(1, i / attack, (n - i) / release);
            out[pos + i] += y * env * seg.gain * (seg.nasal && t < 0.2 ? 0.6 + 2 * t : 1);
        }
        pos += n;
    }

    // DC blocker, then normalise the peak.
    let x1 = 0, y1 = 0, peak = 0;
    for (let i = 0; i < out.length; i++) {
        const y = out[i] - x1 + 0.995 * y1;
        x1 = out[i]; y1 = y; out[i] = y;
        peak = Math.max(peak, Math.abs(y));
    }
    if (peak > 0) {
        const g = peakFor(L) / peak;
        for (let i = 0; i < out.length; i++) out[i] *= g;
    }
    return out;
}

// ---- the manifest and playback ----

/**
 * One game's voice set.
 *   game     the folder under wwwroot/audio/ ('pofighter', 'pobrawl')
 *   gap      seconds a character waits before speaking again at the same or a lower level
 */
export function createEmotionVoice({ game, gap = 0.45 }) {
    const base = () => new URL(`audio/${game}/`, document.baseURI).href;
    const files = new Map();          // "kim/hurt-3" → "kim/hurt-3.wav" (exists: true only)
    const profiles = new Map();       // characterId → voice profile from voices.json
    let manifestLoad = null;
    const recordings = new Map();     // file → AudioBuffer | Promise
    const rendered = new Map();       // "kim|hurt|3|0" → AudioBuffer
    const lastAt = new Map();         // characterId → { t, level } of the last line
    const takes = new Map();          // "kim|hurt" → lines spoken, for the take rotation

    function readManifest(m) {
        if (!m || typeof m !== 'object' || !Array.isArray(m.characters)) throw new Error('not a po-voice-manifest');
        for (const c of m.characters) {
            if (!c?.id) continue;
            if (c.voice) profiles.set(c.id, c.voice);
            for (const [emotion, clips] of Object.entries(c.clips ?? {})) {
                for (const clip of clips ?? []) {
                    if (clip?.exists && clip.file) files.set(`${c.id}/${emotion}-${clip.level}`, clip.file);
                }
            }
        }
    }

    function loadManifest() {
        manifestLoad ??= fetch(base() + 'voices.json')
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then(readManifest)
            .catch(e => console.warn(`[emotionVoice] ${game}/voices.json unusable (${e?.message ?? e}); every line is procedural.`));
        return manifestLoad;
    }

    const hasRecording = (id, mood, level) => files.has(`${id}/${mood}-${clampLevel(level)}`);
    const profileOf = id => profileFor(id, profiles.get(id));

    function recording(ctx, file) {
        let b = recordings.get(file);
        if (!b) {
            b = fetch(base() + file).then(r => r.arrayBuffer()).then(a => ctx.decodeAudioData(a)).catch(() => null);
            recordings.set(file, b);
            b.then(v => recordings.set(file, v));
        }
        return Promise.resolve(b);
    }

    /** The procedural line as a cached AudioBuffer. */
    function procedural(ctx, id, mood, level, take) {
        const key = `${id}|${mood}|${level}|${take}`;
        let buf = rendered.get(key);
        if (!buf) {
            const samples = renderVocalisation(id, mood, level, { profile: profiles.get(id), take });
            buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
            buf.getChannelData(0).set(samples);
            rendered.set(key, buf);
        }
        return buf;
    }

    function play(ctx, out, buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        src.start();
    }

    /**
     * Speak a line. mood: one of MOODS; level 1 (mild) … 5 (all out). Returns false when it was
     * skipped (muted, audio locked, or the same character spoke a moment ago and this is not louder).
     */
    function say(id, mood, level = 3) {
        if (!MOODS.includes(mood) || !isAudible('sfx')) return false;
        const ctx = contextSync();
        const out = busSync('sfx');
        if (!ctx || !out || ctx.state !== 'running') return false;
        level = clampLevel(level);
        const now = ctx.currentTime;
        const last = lastAt.get(id);
        if (last && now - last.t < gap && level <= last.level) return false;
        lastAt.set(id, { t: now, level });
        const turn = takes.get(`${id}|${mood}`) ?? 0;
        takes.set(`${id}|${mood}`, turn + 1);
        const take = turn % TAKES;

        const file = files.get(`${id}/${mood}-${level}`);
        if (file) {
            recording(ctx, file).then(buf => play(ctx, out, buf ?? procedural(ctx, id, mood, level, take)));
        } else {
            play(ctx, out, procedural(ctx, id, mood, level, take));
        }
        return true;
    }

    /** Schedules the procedural line for `id` straight into `out` (sound tests). */
    function synth(ctx, out, id, mood, level, take = 0) {
        play(ctx, out, procedural(ctx, id, mood, clampLevel(level), take));
    }

    /**
     * Render a character's 25 procedural cells ahead of use, a few per idle slice, so the first
     * line of a fight is not synthesised on the frame it is needed.
     */
    function prewarm(ids) {
        const ctx = contextSync();
        if (!ctx) return;
        const jobs = [];
        for (const id of ids) for (const m of MOODS) for (const l of LEVELS) if (!hasRecording(id, m, l)) jobs.push([id, m, l]);
        const idle = globalThis.requestIdleCallback ?? (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 30));
        const step = deadline => {
            while (jobs.length && deadline.timeRemaining() > 2) { const [id, m, l] = jobs.shift(); procedural(ctx, id, m, l, 0); }
            if (jobs.length) idle(step);
        };
        idle(step);
    }

    return { MOODS, LEVELS, loadManifest, hasRecording, profileOf, say, synth, prewarm };
}
