// pocabinet/audio-worklet.js
//
// Sample-accurate AudioWorklet procedural modal synthesis (#6, #12):
//   - 32-slot damped 2-pole resonant eigenmode bank (car_0..4, wall, divider, glass, plastic, debris)
//   - Zone-shaped strikes (front engine bay = warm/steam hiss, side = hollow door, glass crack cascade)
//   - Sample-rate stick-slip chatter impulses for continuous wall scrape & tire scrub texture

const MAX_MODES = 32;
const MAX_GRAINS = 24;

const PROFILES = {
    wall: { f: [118, 295, 620, 1140, 1980, 3150], q: [14, 24, 32, 38, 28, 22], a: [0.36, 0.28, 0.22, 0.16, 0.10, 0.06] },
    divider: { f: [96, 210, 480, 960, 1620], q: [18, 26, 30, 26, 20], a: [0.42, 0.30, 0.20, 0.12, 0.07] },
    car_0: { f: [158, 390, 780, 1460, 2420, 3680], q: [16, 28, 36, 42, 34, 24], a: [0.32, 0.28, 0.24, 0.18, 0.11, 0.06] },
    car_1: { f: [195, 480, 980, 1820, 2960, 4420], q: [18, 30, 40, 44, 34, 24], a: [0.28, 0.26, 0.24, 0.18, 0.12, 0.07] },
    car_2: { f: [140, 340, 690, 1280, 2180, 3360], q: [16, 26, 34, 38, 30, 22], a: [0.35, 0.28, 0.22, 0.16, 0.10, 0.06] },
    car_3: { f: [122, 290, 580, 1120, 1880, 2920], q: [15, 25, 32, 36, 28, 20], a: [0.38, 0.30, 0.22, 0.15, 0.09, 0.05] },
    car_4: { f: [168, 420, 840, 1560, 2580, 3920], q: [17, 29, 38, 42, 32, 24], a: [0.31, 0.27, 0.23, 0.17, 0.11, 0.06] },
    bedroom_plastic: { f: [340, 720, 1480, 2420, 3850], q: [10, 16, 20, 18, 14], a: [0.26, 0.32, 0.24, 0.14, 0.08] },
    glass_shard: { f: [1940, 2860, 4120, 5640, 7280], q: [48, 62, 70, 58, 42], a: [0.22, 0.28, 0.24, 0.16, 0.10] },
    debris_metal: { f: [540, 1280, 2340, 3760, 5120], q: [28, 42, 48, 38, 28], a: [0.26, 0.30, 0.22, 0.14, 0.08] },
};

class ModalBankProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.mA1 = new Float32Array(MAX_MODES);
        this.mA2 = new Float32Array(MAX_MODES);
        this.mY1 = new Float32Array(MAX_MODES);
        this.mY2 = new Float32Array(MAX_MODES);
        this.mCursor = 0;

        this.gDelay = new Int32Array(MAX_GRAINS);
        this.gLen = new Int32Array(MAX_GRAINS);
        this.gAmp = new Float32Array(MAX_GRAINS);
        this.gFreq = new Float32Array(MAX_GRAINS);
        this.gPhase = new Float32Array(MAX_GRAINS);
        this.gCursor = 0;

        this.steamEnv = 0;
        this.steamLp = 0;
        this.scrapeLevel = 0;
        this.scrapeRoom = 0;
        this.slipLevel = 0;
        this.stickPhase = 0;
        this.seed = 0x13579bdf;

        this.port.onmessage = (ev) => this.onMsg(ev.data);
    }

    rnd() {
        this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }

    triggerMode(freq, q, amp) {
        const sr = sampleRate;
        const w = (2 * Math.PI * Math.min(sr * 0.44, Math.max(30, freq))) / sr;
        const bw = Math.max(8, freq / Math.max(3, q));
        const r = Math.exp(-Math.PI * bw / sr);
        const i = this.mCursor;
        this.mCursor = (i + 1) % MAX_MODES;
        this.mA1[i] = 2 * r * Math.cos(w);
        this.mA2[i] = -r * r;
        // Inject impulse directly into y1 as unit momentum kick
        this.mY1[i] = amp * Math.sin(w) * 0.85;
        this.mY2[i] = -amp * Math.sin(w) * 0.25;
    }

    triggerGrain(delaySamples, lenSamples, freq, amp) {
        const i = this.gCursor;
        this.gCursor = (i + 1) % MAX_GRAINS;
        this.gDelay[i] = delaySamples | 0;
        this.gLen[i] = Math.max(12, lenSamples | 0);
        this.gFreq[i] = freq;
        this.gAmp[i] = amp;
        this.gPhase[i] = 0;
    }

    onMsg(d) {
        if (!d) return;
        if (d.type === 'strike') {
            const prof = PROFILES[d.mat] || PROFILES.wall;
            const s = Math.min(1.2, Math.max(0.05, d.strength || 0.3));
            const zone = d.zone || 'side';
            const zonePitch = zone === 'front' ? 0.92 : zone === 'rear' ? 1.07 : 1.0;
            const pMul = (d.pitch || 1) * zonePitch;
            const n = prof.f.length;
            for (let k = 0; k < n; k++) {
                const jitter = 0.96 + this.rnd() * 0.08;
                const bright = k >= 3 ? (0.45 + 0.7 * s) : 1.0;
                this.triggerMode(prof.f[k] * pMul * jitter, prof.q[k] * (0.85 + 0.3 * s), prof.a[k] * s * bright);
            }
            // Radiator steam burst on heavy frontal impacts (#6)
            if (zone === 'front' && s > 0.55) {
                this.steamEnv = Math.min(0.65, this.steamEnv + (s - 0.5) * 0.75);
            }
            // Crystalline granular glass shatter cascade (#6)
            const crack = d.glassCrack || 0;
            if (crack > 0.25 && d.mat !== 'bedroom_plastic') {
                const count = Math.min(10, 3 + Math.floor(crack * 7));
                for (let k = 0; k < count; k++) {
                    const delayMs = 4 + this.rnd() * 140;
                    const freq = 2200 + this.rnd() * 5200;
                    this.triggerGrain((delayMs * 0.001 * sampleRate) | 0, (0.018 * sampleRate) | 0, freq, 0.09 * crack * (1 - k * 0.07));
                }
            }
            // Heavy hit secondary interior trim rattle (#6)
            if (s > 0.5) {
                const rattles = Math.min(5, Math.floor((s - 0.45) * 9));
                for (let k = 0; k < rattles; k++) {
                    const delayMs = 22 + k * (16 + this.rnd() * 20);
                    this.triggerGrain((delayMs * 0.001 * sampleRate) | 0, (0.012 * sampleRate) | 0, 820 + this.rnd() * 1600, 0.055 * s * (1 - k / (rattles + 1)));
                }
            }
        } else if (d.type === 'scrape') {
            this.scrapeLevel = Math.min(1, Math.max(0, d.level || 0));
            this.scrapeRoom = d.room ? 1 : 0;
        } else if (d.type === 'slip') {
            this.slipLevel = Math.min(1, Math.max(0, d.slip || 0));
        }
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        if (!out || !out.length) return true;
        const ch0 = out[0];
        const ch1 = out[1] || out[0];
        const len = ch0.length;
        const sr = sampleRate;

        for (let n = 0; n < len; n++) {
            let sum = 0;
            for (let m = 0; m < MAX_MODES; m++) {
                const y0 = this.mA1[m] * this.mY1[m] + this.mA2[m] * this.mY2[m];
                this.mY2[m] = this.mY1[m];
                this.mY1[m] = y0;
                sum += y0;
            }

            // Granular glass shards & loose trim rattles
            for (let g = 0; g < MAX_GRAINS; g++) {
                if (this.gLen[g] <= 0) continue;
                if (this.gDelay[g] > 0) {
                    this.gDelay[g]--;
                    continue;
                }
                const env = this.gAmp[g];
                this.gPhase[g] += (2 * Math.PI * this.gFreq[g]) / sr;
                sum += (Math.sin(this.gPhase[g]) * 0.7 + (this.rnd() * 2 - 1) * 0.3) * env;
                this.gAmp[g] *= 0.985;
                this.gLen[g]--;
            }

            // Radiator steam hiss tail
            if (this.steamEnv > 0.001) {
                const w = this.rnd() * 2 - 1;
                this.steamLp += (w - this.steamLp) * 0.38;
                sum += (w - this.steamLp) * this.steamEnv * 0.24;
                this.steamEnv *= 0.99993;
            }

            // Stick-slip metallic wall chatter + high-slip tyre scrub impulses (#12)
            if (this.scrapeLevel > 0.02) {
                this.stickPhase += (110 + this.scrapeLevel * 240) / sr;
                if (this.stickPhase >= 1) {
                    this.stickPhase -= 1;
                    const freq = (this.scrapeRoom ? 1450 : 2750) + this.rnd() * 1400;
                    this.triggerMode(freq, 26, 0.032 * this.scrapeLevel * (0.6 + this.rnd() * 0.6));
                }
            }
            if (this.slipLevel > 0.12) {
                const scrub = (this.rnd() * 2 - 1) * Math.sin(this.stickPhase * 6.28318 + n * 0.12);
                sum += scrub * this.slipLevel * 0.028;
            }

            const clamped = Math.max(-0.95, Math.min(0.95, sum));
            ch0[n] = clamped;
            if (ch1 !== ch0) ch1[n] = clamped;
        }
        return true;
    }
}

registerProcessor('pocabinet-modal-bank', ModalBankProcessor);
