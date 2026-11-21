// contactVoice.js — continuous contact synthesis on the audio thread (platform/contactLoop.js).
//
// WHY A WORKLET, WHY ONE NODE
// impactSynth.js is for events: one hit, one short voice. A rolling marble or a sliding
// tyre is not an event, it is a sound that EXISTS for as long as two surfaces touch and
// whose pitch and level are continuous functions of speed. Building that from main-thread
// AudioParams (a bandpass + three gains per body, ramped every frame) is zipper-noise-prone
// and one node graph per body. Here a fixed pool of voices lives in ONE processor; the main
// thread posts the latest numbers (rollSpeed, slipSpeed, load, pan, gain, occlusion) a few
// tens of times a second and every parameter is smoothed per sample with a one-pole, so a
// stepped message can never click.
//
// WHAT ONE VOICE IS
//   ROLL    low rumble: noise through a state-variable lowpass whose corner rises with speed,
//           plus three inharmonic sines (ratios 1, 1.5, 2.26) whose pitch follows rollSpeed;
//           the whole thing is amplitude-ridged at the wheel's rotation rate (v / 2πr), which
//           is what makes a fast marble read as "going round" rather than "louder noise".
//   SCRAPE  friction: noise through a state-variable bandpass coloured by the material
//           (steel screeches high and narrow, stone grinds mid, dirt hushes low), its level
//           following slip speed with a soft knee, with a stick-slip sawtooth on the
//           amplitude whose rate rises with slip.
//   SKID    tyres (and, a little, glass and metal): a tonal squeal — a sine near the
//           material's pitch with a slow noise vibrato plus a second harmonic — that fades
//           in as slip passes a threshold, over the scrape noise. Pure noise never reads as
//           rubber on tarmac; the squeal does.
//   PLACE   equal-power pan, a distance gain and an occlusion one-pole lowpass, all computed
//           on the main thread and smoothed here.
//
// No allocation in process(): voices are preallocated structs of numbers. Parameter
// smoothing is per sample, filter coefficients per 128-sample block.

const MAX_VOICES = 8;
const TWO_PI = Math.PI * 2;

// Per material: scrape centre (Hz), Q, scrape level, tonal squeal level, rumble level, grit
// (how hard the stick-slip modulation bites). Index order = contactLoop.js MATERIAL_INDEX.
const MAT = [
    /* 0 stone  */ { hz: 1100, q: 1.2, scrape: 0.9, tonal: 0.00, rumble: 1.0, grit: 0.70 },
    /* 1 metal  */ { hz: 2600, q: 4.5, scrape: 0.8, tonal: 0.25, rumble: 0.8, grit: 0.35 },
    /* 2 wood   */ { hz: 720, q: 1.6, scrape: 0.8, tonal: 0.00, rumble: 1.1, grit: 0.60 },
    /* 3 glass  */ { hz: 3300, q: 3.2, scrape: 0.7, tonal: 0.15, rumble: 0.7, grit: 0.30 },
    /* 4 rubber */ { hz: 460, q: 0.9, scrape: 0.9, tonal: 0.10, rumble: 0.9, grit: 0.45 },
    /* 5 dirt   */ { hz: 320, q: 0.6, scrape: 0.9, tonal: 0.00, rumble: 1.2, grit: 0.80 },
    /* 6 tyre   */ { hz: 1500, q: 5.0, scrape: 0.9, tonal: 0.75, rumble: 0.8, grit: 0.25 },
    /* 7 ice    */ { hz: 4200, q: 1.8, scrape: 0.55, tonal: 0.00, rumble: 0.5, grit: 0.20 },
];

function makeVoice() {
    return {
        active: false, closing: false,
        mat: 0, radius: 0.3,
        // targets (from the main thread)
        tRoll: 0, tSlip: 0, tLoad: 0, tGain: 0, tPan: 0, tOcc: 0,
        // smoothed
        roll: 0, slip: 0, load: 0, gain: 0, pan: 0, occ: 0,
        // state
        svfL1: 0, svfB1: 0, svfL2: 0, svfB2: 0,
        ph1: 0, ph2: 0, ph3: 0, phSq: 0, phRidge: 0, phSaw: 0, vib: 0,
        lpState: 0,
        // per-block coefficients
        f1: 0.01, q1: 1, f2: 0.1, q2: 1,
        seed: 1,
    };
}

class ContactProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.voices = [];
        for (let i = 0; i < MAX_VOICES; i++) this.voices.push(makeVoice());
        this.k = 1 - Math.exp(-1 / (sampleRate * 0.035));   // ~35 ms smoothing
        this.kFast = 1 - Math.exp(-1 / (sampleRate * 0.012));
        this.port.onmessage = (e) => {
            const m = e.data;
            if (!m) return;
            const v = this.voices[m.slot | 0];
            if (!v) return;
            if (m.type === 'open') {
                const seed = v.seed;
                Object.assign(v, makeVoice());
                v.seed = seed * 7 + 13;
                v.active = true;
                v.mat = Math.max(0, Math.min(MAT.length - 1, m.mat | 0));
                v.radius = m.radius > 0 ? m.radius : 0.3;
            } else if (m.type === 'set') {
                v.tRoll = m.roll || 0; v.tSlip = m.slip || 0; v.tLoad = m.load == null ? 1 : m.load;
                v.tGain = m.gain == null ? 1 : m.gain; v.tPan = m.pan || 0; v.tOcc = m.occ || 0;
                v.closing = false;
            } else if (m.type === 'free') {
                v.tGain = 0; v.closing = true;
            }
        };
    }

    process(_in, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const L = out[0], R = out[1] || out[0];
        const n = L.length;
        for (let i = 0; i < n; i++) { L[i] = 0; if (R !== L) R[i] = 0; }
        const sr = sampleRate;
        const k = this.k;

        for (let vi = 0; vi < MAX_VOICES; vi++) {
            const v = this.voices[vi];
            if (!v.active) continue;
            const mt = MAT[v.mat];

            // Block-rate coefficients from the (already smoothed) values.
            const rollN = Math.min(1, v.roll / 14);
            const fc1 = 70 + 520 * Math.pow(rollN, 0.8);
            v.f1 = Math.min(1.2, 2 * Math.sin(Math.PI * Math.min(0.45, fc1 / sr)));
            v.q1 = 1 / 0.9;
            const slipN = Math.min(1, v.slip / 14);
            const fc2 = mt.hz * (0.65 + 0.7 * Math.pow(slipN, 0.6));
            v.f2 = Math.min(1.2, 2 * Math.sin(Math.PI * Math.min(0.45, fc2 / sr)));
            v.q2 = 1 / mt.q;
            const f0 = Math.min(260, 45 + 14 * v.roll);
            const w1 = TWO_PI * f0 / sr, w2 = w1 * 1.5, w3 = w1 * 2.26;
            const ridge = (v.roll / (TWO_PI * v.radius)) * TWO_PI / sr;   // rotation rate, rad/sample
            const sawRate = (35 + 9 * v.slip) / sr;
            const sqHz = mt.hz * 0.55 * (0.92 + 0.012 * Math.min(v.slip, 20));
            const wsq = TWO_PI * Math.min(sqHz, 5200) / sr;
            const occK = 1 - Math.exp(-TWO_PI * (18000 * Math.pow(900 / 18000, v.occ)) / sr);
            const squealGate = mt.tonal * Math.min(1, Math.max(0, (v.slip - 2.5) / 7));

            let busy = 0;
            for (let i = 0; i < n; i++) {
                // Per-sample smoothing: stepped messages can't click.
                v.roll += (v.tRoll - v.roll) * k;
                v.slip += (v.tSlip - v.slip) * k;
                v.load += (v.tLoad - v.load) * k;
                v.gain += (v.tGain - v.gain) * k;
                v.pan += (v.tPan - v.pan) * k;
                v.occ += (v.tOcc - v.occ) * k;

                // xorshift white noise
                let s = v.seed | 0;
                s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
                v.seed = s;
                const white = (s >>> 0) / 2147483648 - 1;

                // ROLL — SVF lowpass rumble + modal sines, ridged at rotation rate.
                v.svfL1 += v.f1 * v.svfB1;
                const hp1 = white - v.svfL1 - v.q1 * v.svfB1;
                v.svfB1 += v.f1 * hp1;
                v.ph1 += w1; if (v.ph1 > TWO_PI) v.ph1 -= TWO_PI;
                v.ph2 += w2; if (v.ph2 > TWO_PI) v.ph2 -= TWO_PI;
                v.ph3 += w3; if (v.ph3 > TWO_PI) v.ph3 -= TWO_PI;
                v.phRidge += ridge; if (v.phRidge > TWO_PI) v.phRidge -= TWO_PI;
                const rollAmt = Math.pow(Math.min(1, v.roll / 12), 1.2) * Math.min(1, 0.25 + v.load) * mt.rumble;
                const modal = Math.sin(v.ph1) * 0.5 + Math.sin(v.ph2) * 0.3 + Math.sin(v.ph3) * 0.2;
                const ridgeMod = 1 + 0.28 * Math.sin(v.phRidge);
                const rollOut = (v.svfL1 * 1.6 + modal * 0.35) * rollAmt * ridgeMod * 0.55;

                // SCRAPE — SVF bandpass friction noise, stick-slip modulated.
                v.svfL2 += v.f2 * v.svfB2;
                const hp2 = white - v.svfL2 - v.q2 * v.svfB2;
                v.svfB2 += v.f2 * hp2;
                v.phSaw += sawRate; if (v.phSaw >= 1) v.phSaw -= 1;
                const stick = 1 - mt.grit * 0.5 + mt.grit * 0.5 * (v.phSaw * 2 - 1) * (0.6 + 0.4 * white);
                const slipAmt = (1 - Math.exp(-v.slip / 2.5)) * Math.pow(Math.min(1, v.load + 0.1), 0.7) * mt.scrape;
                let slipOut = v.svfB2 * Math.sqrt(v.q2) * slipAmt * stick * 0.9;   // sqrt(1/Q): a narrow band has gain Q, keep the loudness comparable

                // SKID — tonal squeal over the scrape.
                if (squealGate > 0) {
                    v.vib += (white * 0.06 - v.vib) * 0.0008;      // slow wander
                    v.phSq += wsq * (1 + v.vib * 6);
                    if (v.phSq > TWO_PI) v.phSq -= TWO_PI;
                    const sq = Math.sin(v.phSq) + 0.3 * Math.sin(v.phSq * 2);
                    slipOut += sq * squealGate * slipAmt * 0.45;
                }

                let sample = (rollOut + slipOut) * v.gain;
                // Occlusion lowpass
                v.lpState += (sample - v.lpState) * occK;
                sample = v.lpState;

                // equal-power pan
                const a = (v.pan + 1) * 0.25 * Math.PI;
                L[i] += sample * Math.cos(a);
                if (R !== L) R[i] += sample * Math.sin(a);
                busy += Math.abs(sample);
            }
            if (v.closing && busy / n < 1e-5 && v.gain < 1e-4) { v.active = false; v.closing = false; }
        }
        // Soft saturation as a safety net (a smooth function: it cannot click).
        for (let i = 0; i < n; i++) {
            L[i] = Math.tanh(L[i]);
            if (R !== L) R[i] = Math.tanh(R[i]);
        }
        return true;
    }
}

registerProcessor('po-contact', ContactProcessor);
