// PoCapitol's crowd, as individual voices. Runs on the audio thread (AudioWorkletGlobalScope).
//
// The crowd bed in audio.js is filtered noise: it has a level and a tone, and it comes from
// everywhere at once. This is the other half. Each of a few dozen voices is a person: a glottal
// pulse at their own pitch through two formant resonators (so it is a vowel, not a tone), shouted
// in syllables of their own length with gaps of their own, from their own place in the crowd.
// Their places follow the real crowd: the main thread sends how many people stand in each of
// eight compass sectors round the listener and how far off, and every new syllable is thrown
// from a sector chosen in proportion.
//
// Space: each voice is encoded into a first-order horizontal sound field (W, X, Y) by its
// bearing, and the field is decoded to four fixed directions, north, east, south and west. The
// main thread feeds those four channels to four HRTF panners standing round the listener, so
// the crowd has a front, a back and sides that hold still in the world as the listener turns.

const VOICES = 32;
/** First two formants of shouted vowels, Hz. */
const VOWELS = [[730, 1090], [570, 840], [530, 1840], [640, 1190], [300, 870], [440, 1020]];
const TAU = Math.PI * 2;

/** Gains to the four decode directions for a source at `bearing` (0 is north, clockwise). */
function decode(bearing, out) {
    // Encode: W = 1/sqrt(2), X = cos, Y = sin. Decode to a square of cardioids.
    for (let k = 0; k < 4; k++) out[k] = 0.5 + 0.5 * Math.cos(bearing - k * Math.PI / 2);
    const sum = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    for (let k = 0; k < 4; k++) out[k] /= sum;
}

class CrowdProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.weights = new Float32Array(8).fill(1 / 8);
        this.depth = new Float32Array(8).fill(14);
        this.level = 0; this.wanted = 0; this.agitation = 0.3; this.roar = 0; this.indoors = 0;
        this.voices = Array.from({ length: VOICES }, (_, i) => ({
            phase: Math.random(), pitch: 95 + Math.random() * 150, drift: Math.random() * TAU, driftRate: 2 + Math.random() * 3,
            // Resonator state: two samples of history for each of the two formants.
            a1: 0, a2: 0, b1: 0, b2: 0, k1: 0, q1: 0, g1: 0, k2: 0, q2: 0, g2: 0,
            env: 0, target: 0, rise: 0, fall: 0, left: Math.floor(Math.random() * sampleRate * 2), speaking: false,
            gains: new Float32Array(4), loud: 0, dull: 0.5, low: 0, breath: 0.2, seed: (i * 7919 + 13) | 0,
        }));
        const set = m => {
            if (m.weights) this.weights.set(m.weights);
            if (m.depth) this.depth.set(m.depth);
            if (typeof m.level === 'number') this.wanted = m.level;
            if (typeof m.agitation === 'number') this.agitation = m.agitation;
            if (typeof m.roar === 'number') this.roar = Math.max(this.roar, m.roar);
            if (typeof m.indoors === 'number') this.indoors = m.indoors;
        };
        // The same record can be given up front (an offline render never gets a message in time).
        set(options?.processorOptions ?? {});
        this.port.onmessage = event => set(event.data ?? {});
    }

    /** A new syllable for one voice: who, where, which vowel, how long. */
    begin(v) {
        let pick = Math.random(), sector = 0;
        for (; sector < 7; sector++) { pick -= this.weights[sector]; if (pick <= 0) break; }
        const bearing = (sector + Math.random()) * Math.PI / 4;
        const distance = Math.max(2, this.depth[sector] * (0.45 + Math.random() * 1.1));
        decode(bearing, v.gains);
        // Further off is quieter and duller: air and the bodies in between take the top away.
        v.loud = 1 / (1 + distance / 7);
        v.dull = Math.max(0.05, Math.min(0.9, 0.9 - distance / 60 - this.indoors * 0.15));
        const heat = Math.min(1, this.agitation + this.roar);
        const vowel = VOWELS[(Math.random() * VOWELS.length) | 0];
        v.pitch = (95 + Math.random() * 150) * (1 + heat * 0.35);
        this.tune(v, vowel[0] * (1 + heat * 0.12), vowel[1]);
        v.breath = 0.12 + 0.5 * heat * Math.random();
        const length = (0.12 + Math.random() * 0.45) * (1 + this.roar * 2.2);
        v.target = (0.35 + 0.65 * Math.random()) * (0.45 + 0.55 * heat);
        v.rise = 1 / (sampleRate * 0.03); v.fall = 1 / (sampleRate * (0.06 + Math.random() * 0.2));
        v.left = Math.floor(sampleRate * length);
        v.speaking = true;
    }

    /** Coefficients for the two formant resonators. */
    tune(v, f1, f2) {
        const w1 = TAU * f1 / sampleRate, w2 = TAU * f2 / sampleRate, r1 = 0.975, r2 = 0.982;
        v.k1 = 2 * r1 * Math.cos(w1); v.q1 = r1 * r1; v.g1 = 1 - r1;
        v.k2 = 2 * r2 * Math.cos(w2); v.q2 = r2 * r2; v.g2 = (1 - r2) * 0.7;
    }

    process(inputs, outputs) {
        const out = outputs[0], frames = out[0].length;
        this.level += (this.wanted - this.level) * 0.02;
        this.roar *= 0.9985;
        if (this.level < 0.0005 && this.wanted <= 0) return true;
        // How much of the time anyone is shouting: a quiet crowd mutters now and then.
        const busy = Math.min(0.95, 0.12 + 0.6 * this.agitation + 0.7 * this.roar);
        for (const v of this.voices) {
            if (!v.speaking && v.env < 0.0005) {
                v.left -= frames;
                if (v.left > 0) continue;
                if (Math.random() < busy) this.begin(v);
                else { v.left = Math.floor(sampleRate * (0.2 + Math.random() * 1.2)); continue; }
            }
            const step = v.pitch / sampleRate, g0 = v.gains[0], g1 = v.gains[1], g2 = v.gains[2], g3 = v.gains[3];
            for (let i = 0; i < frames; i++) {
                if (v.speaking) {
                    v.env += (v.target - v.env) * v.rise * 3;
                    if (--v.left <= 0) v.speaking = false;
                } else v.env -= v.env * v.fall * 4;
                // The pitch wanders a little, as a voice does.
                v.drift += v.driftRate / sampleRate;
                v.phase += step * (1 + 0.012 * Math.sin(v.drift));
                if (v.phase >= 1) v.phase -= 1;
                // A glottal pulse: a short sharp closure once a cycle, plus breath.
                v.seed = (v.seed * 1103515245 + 12345) | 0;
                const noise = (v.seed >>> 9) / 4194304 - 1;
                const pulse = (v.phase < 0.12 ? 1 - v.phase / 0.12 : -0.14) + noise * v.breath;
                const f1 = v.g1 * pulse + v.k1 * v.a1 - v.q1 * v.a2; v.a2 = v.a1; v.a1 = f1;
                const f2 = v.g2 * pulse + v.k2 * v.b1 - v.q2 * v.b2; v.b2 = v.b1; v.b1 = f2;
                v.low += ((f1 + f2) - v.low) * v.dull;
                const sample = v.low * v.env * v.loud;
                out[0][i] += sample * g0; out[1][i] += sample * g1; out[2][i] += sample * g2; out[3][i] += sample * g3;
            }
        }
        const gain = this.level * 0.06;
        for (let ch = 0; ch < 4; ch++) for (let i = 0; i < frames; i++) out[ch][i] *= gain;
        return true;
    }
}

registerProcessor('pocapitol-crowd', CrowdProcessor);
