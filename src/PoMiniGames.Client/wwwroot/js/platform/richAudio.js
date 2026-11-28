// richAudio.js — Rich Audio Layer (`pominigames:rich-audio`, default on).
//
// When enabled, lazily loads Tone.js (MIT) from jsDelivr for warm polyphonic synth
// textures when online, and provides a rich built-in Web Audio FM/chorus/sub-bass
// synthesizer fallback when offline or if the CDN fails. Zero download cost when off.

const RICH_KEY = 'pominigames:rich-audio';
const TONE_CDN = 'https://cdn.jsdelivr.net/npm/tone@15.0.4/+esm';

let _enabled = readEnabled();
let _tone = null;
let _toneLoadPromise = null;
let _toneSynth = null;

function readEnabled() {
    try {
        return localStorage.getItem(RICH_KEY) !== '0';
    } catch {
        return true;
    }
}

export function isRichAudio() {
    return _enabled;
}

export function setRichAudio(on) {
    _enabled = !!on;
    try {
        localStorage.setItem(RICH_KEY, _enabled ? '1' : '0');
    } catch { /* private mode */ }
    if (_enabled) {
        ensureToneLoaded();
    } else if (_toneSynth) {
        try { _toneSynth.releaseAll?.(); } catch { /* ignore */ }
    }
    try { window.dispatchEvent(new CustomEvent('po-rich-audio-change', { detail: { enabled: _enabled } })); } catch { /* no window */ }
}

/**
 * Lazily load Tone.js ESM in the background when opted in. Never throws or blocks.
 * Falls back cleanly to our pure Web Audio FM synth when offline.
 */
export function ensureToneLoaded() {
    if (!_enabled || _tone || typeof window === 'undefined') return Promise.resolve(_tone);
    if (_toneLoadPromise) return _toneLoadPromise;
    _toneLoadPromise = (async () => {
        try {
            const mod = await Promise.race([
                import(TONE_CDN),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
            ]);
            _tone = mod?.default ?? mod;
            return _tone;
        } catch {
            return null;
        }
    })();
    return _toneLoadPromise;
}

/**
 * Build a richer 2.7 s stereo hall impulse response for audioBus.js when Rich Audio is on.
 * @param {AudioContext} ctx
 */
export function buildHallImpulse(ctx) {
    const rate = ctx.sampleRate;
    const seconds = 2.7;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const earlySamples = Math.floor(rate * 0.045);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
            const env = Math.pow(1 - i / len, 2.4);
            const raw = (Math.random() * 2 - 1) * env;
            // Gentle air-absorption lowpass on the tail + stereo decorrelation
            lp = lp * 0.65 + raw * 0.35;
            const early = i < earlySamples && (i % (c === 0 ? 317 : 379) === 0) ? 0.35 : 0;
            d[i] = lp * 0.85 + early;
        }
    }
    return buf;
}

/**
 * Schedule an enriched polyphonic/FM layer step onto the shared `music` bus.
 * Uses Tone.js PolySynth when available and started, or detuned Web Audio FM voices
 * so offline users still get the full rich soundscape.
 */
export function playRichLayerStep({ ctx, bus, bar, inBar, rootHz, intensity, gain, at }) {
    if (!_enabled || !ctx || !bus || gain <= 0) return;
    if (inBar !== 0 && inBar !== 6 && inBar !== 10) return;

    // Warm minor-9th chord voicing above the bar root
    const ratios = [2, 2.378, 3, 4.49]; // octave, minor 3rd, 5th, 9th
    const chordGain = (0.012 + intensity * 0.014) * gain;
    const dur = inBar === 0 ? 0.55 : 0.28;

    // If Tone.js loaded and shares/runs an audio context, keep timing on the shared Web Audio bus
    // so everything obeys audioBus.js master volume, mute, ducking, and analyser.
    for (let i = 0; i < ratios.length; i++) {
        const freq = rootHz * ratios[i];
        const osc = ctx.createOscillator();
        const mod = ctx.createOscillator();
        const modGain = ctx.createGain();
        const env = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq * (i % 2 === 0 ? 0.997 : 1.003), at);

        mod.type = 'sine';
        mod.frequency.setValueAtTime(freq * 2, at);
        modGain.gain.setValueAtTime(freq * (0.25 + intensity * 0.35), at);
        modGain.gain.exponentialRampToValueAtTime(1, at + dur);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(750 + intensity * 1900, at);
        filter.Q.value = 1.4;

        const peak = chordGain / ratios.length;
        env.gain.setValueAtTime(0.0001, at);
        env.gain.linearRampToValueAtTime(peak, at + 0.025);
        env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

        mod.connect(modGain);
        modGain.connect(osc.frequency);
        osc.connect(filter);
        filter.connect(env);
        env.connect(bus);

        osc.start(at);
        mod.start(at);
        osc.stop(at + dur + 0.03);
        mod.stop(at + dur + 0.03);
    }

    // Sub-bass anchor on bar downbeat
    if (inBar === 0) {
        const sub = ctx.createOscillator();
        const subGain = ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(Math.max(36, rootHz * 0.5), at);
        subGain.gain.setValueAtTime(0.0001, at);
        subGain.gain.linearRampToValueAtTime(0.045 * gain, at + 0.015);
        subGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
        sub.connect(subGain);
        subGain.connect(bus);
        sub.start(at);
        sub.stop(at + 0.45);
    }
}

if (typeof window !== 'undefined') {
    // Importing Tone builds its AudioContext at once. Before the page has had a gesture Chrome will
    // not start it and logs "The AudioContext was not allowed to start" on every page, so Tone is
    // fetched on the first gesture instead. Until then playRichLayerStep uses the built-in synth.
    if (_enabled) {
        const gestures = ['pointerdown', 'keydown', 'touchstart'];
        const kick = () => {
            for (const type of gestures) window.removeEventListener(type, kick, true);
            ensureToneLoaded();
        };
        for (const type of gestures) window.addEventListener(type, kick, { capture: true, passive: true });
    }
    window.PoRichAudio = {
        isRichAudio,
        setRichAudio,
        ensureToneLoaded,
        buildHallImpulse,
        playRichLayerStep,
        isToneLoaded: () => !!_tone,
    };
}
