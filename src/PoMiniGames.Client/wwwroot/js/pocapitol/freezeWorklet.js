// PoCapitol's menu freeze. Runs on the audio thread (AudioWorkletGlobalScope).
//
// While the scene plays, this node listens to the scene mix (stereo in) and keeps a smoothed
// magnitude spectrum of it, one 2048-point FFT about every 21 ms. When a menu opens it holds that
// spectrum and plays it back as a pad: every 512 samples a new frame is built from the held
// magnitudes (blurred a few bins wide and shivered a little) with fresh random phases, inverse
// transformed, windowed and overlap-added at 75 %. Random phase is what smears it: the crowd, the
// helicopter and the chant stop being events and become one held, breathing chord of the same
// colour, different in each ear. The pad fades in over 250 ms. When the menu closes it swells back
// up over 400 ms, rising as if played backwards, and cuts out on the beat the live mix returns.
//
// The node's output is the pad alone (it never passes the scene through); audio.js crossfades the
// live mix against it. Idle, it does no work at all unless `track` is on, and then one transform
// per channel every 1024 samples.
//
// Messages in: { freeze: bool, track: bool }.

const N = 2048, H = 512, TRACK_EVERY = 1024;
const IN_SECONDS = 0.25, OUT_SECONDS = 0.4;
const TAU = Math.PI * 2;

const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(TAU * i / N);

// Radix-2 FFT tables.
const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2), rev = new Uint16Array(N);
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(TAU * i / N); sinT[i] = Math.sin(TAU * i / N); }
for (let i = 0, bits = Math.log2(N); i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
}
/** In-place complex FFT; `inverse` flips the sign of the exponent (caller scales by 1/N). */
function fft(re, im, inverse) {
    for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let start = 0; start < N; start += size) {
            for (let k = 0, w = 0; k < half; k++, w += step) {
                const wr = cosT[w], wi = sign * sinT[w];
                const a = start + k, b = a + half;
                const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

class FreezeProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.mode = 'idle';            // idle | in | hold | out
        this.t = 0; this.gain = 0;
        this.track = false;
        this.hist = [0, 1].map(() => new Float32Array(N));   // last N input samples, circular
        this.hp = 0; this.sinceTrack = 0;
        this.avg = [0, 1].map(() => new Float32Array(N / 2 + 1));
        this.rms = [0, 0];
        this.have = false;
        this.re = new Float32Array(N); this.im = new Float32Array(N);
        this.ola = [0, 1].map(() => new Float32Array(N)); this.head = 0; this.pos = H;
        this.held = [0, 1].map(() => new Float32Array(N / 2 + 1));
        this.heldRms = [0, 0];
        this.seed = 0x1234abcd;
        this.port.onmessage = ({ data }) => {
            if (typeof data.track === 'boolean') this.track = data.track;
            if (typeof data.freeze === 'boolean') this.setFrozen(data.freeze);
        };
    }

    rand() {
        let x = this.seed;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.seed = x >>> 0;
        return this.seed / 4294967296;
    }

    setFrozen(on) {
        if (on) {
            if (this.mode === 'in' || this.mode === 'hold') return;
            this.hold();
            this.mode = 'in'; this.t = Math.min(IN_SECONDS, this.gain * IN_SECONDS);
        } else if (this.mode === 'in' || this.mode === 'hold') {
            this.mode = 'out'; this.t = 0; this.outFrom = Math.min(1, this.gain);
        }
    }

    /** Takes the tracked spectrum as the held one and primes the overlap-add so sound starts at once. */
    hold() {
        for (let c = 0; c < 2; c++) {
            this.held[c].set(this.avg[c]);
            this.heldRms[c] = this.rms[c];
            this.ola[c].fill(0);
        }
        // Frames that began 3, 2 and 1 hops ago: only their parts still to come.
        for (let k = 3; k >= 1; k--) for (let c = 0; c < 2; c++) this.addFrame(c, (this.head - k * H + N * 2) % N, k * H);
        this.pos = H;   // the first sample starts the current frame
    }

    /** Builds one frame for channel `c` from the held spectrum and adds it into the ring at `start`. */
    addFrame(c, start, skip = 0) {
        const re = this.re, im = this.im, mag = this.held[c];
        const bins = N / 2;
        re[0] = 0; im[0] = 0;
        for (let k = 1; k < bins; k++) {
            // Blur across five bins, shiver by +-25 %, give it a fresh random phase.
            const m = (mag[k - 1] + 2 * mag[k] + mag[Math.min(bins, k + 1)]) * 0.25 * (0.75 + 0.5 * this.rand());
            const ph = TAU * this.rand();
            const cr = Math.cos(ph), ci = Math.sin(ph);
            re[k] = m * cr; im[k] = m * ci;
            re[N - k] = m * cr; im[N - k] = -m * ci;
        }
        re[bins] = 0; im[bins] = 0;
        fft(re, im, true);
        // Match the frame's level to the loudness the scene had (Parseval-free: measure it).
        let sum = 0;
        for (let i = 0; i < N; i++) sum += re[i] * re[i];
        const frameRms = Math.sqrt(sum / N) || 1;
        // Hann at 75 % overlap sums its squares to 1.5, so each frame carries 1/sqrt(1.5).
        const scale = this.heldRms[c] / frameRms * 0.8165;
        const ola = this.ola[c];
        for (let i = skip; i < N; i++) ola[(start + i) % N] += re[i] * hann[i] * scale;
    }

    analyse() {
        const re = this.re, im = this.im;
        for (let c = 0; c < 2; c++) {
            const hist = this.hist[c];
            for (let i = 0; i < N; i++) { re[i] = hist[(this.hp + i) % N] * hann[i]; im[i] = 0; }
            fft(re, im, false);
            const avg = this.avg[c], first = !this.have;
            for (let k = 0; k <= N / 2; k++) {
                const m = Math.hypot(re[k], im[k]);
                avg[k] = first ? m : avg[k] + (m - avg[k]) * 0.2;
            }
        }
        this.have = true;
    }

    process(inputs, outputs) {
        const input = inputs[0], output = outputs[0];
        if (!output || output.length === 0) return true;
        const n = output[0].length, channels = output.length;
        const idle = this.mode === 'idle';

        // Listen: history of the scene mix, a smoothed spectrum, and its loudness.
        if (!(this.mode === 'in' || this.mode === 'hold') && this.track && input && input.length) {
            for (let c = 0; c < 2; c++) {
                const src = input[c] ?? input[0], hist = this.hist[c];
                if (!src) continue;
                let e = 0;
                for (let i = 0; i < n; i++) { hist[(this.hp + i) % N] = src[i]; e += src[i] * src[i]; }
                const blockRms = Math.sqrt(e / n);
                this.rms[c] += (blockRms - this.rms[c]) * Math.min(1, n / sampleRate / 0.35);
            }
            this.hp = (this.hp + n) % N;
            this.sinceTrack += n;
            if (this.sinceTrack >= TRACK_EVERY) { this.sinceTrack = 0; this.analyse(); }
        }
        if (idle) { for (const ch of output) ch.fill(0); return true; }

        // The pad.
        const dt = 1 / sampleRate;
        for (let i = 0; i < n; i++) {
            if (this.pos >= H) {
                this.pos = 0;
                for (let c = 0; c < 2; c++) this.addFrame(c, this.head);
            }
            let g;
            if (this.mode === 'in') {
                this.t += dt;
                const p = Math.min(1, this.t / IN_SECONDS);
                g = Math.sin(p * Math.PI / 2);
                if (p >= 1) this.mode = 'hold';
            } else if (this.mode === 'hold') g = 1;
            else if (this.mode === 'out') {
                this.t += dt;
                const p = Math.min(1, this.t / OUT_SECONDS);
                // Backwards-swell: grows toward the live mix, then is gone as it returns.
                g = (0.3 + 0.7 * p * p) * (p < 0.8 ? 1 : 1 - (p - 0.8) / 0.2) * this.outFrom;
                if (p >= 1) { this.mode = 'idle'; g = 0; }
            } else g = 0;
            this.gain = g;
            for (let c = 0; c < channels; c++) {
                const ola = this.ola[c % 2];
                output[c][i] = ola[(this.head + this.pos) % N] * g * 0.9;
            }
            for (let c = 0; c < 2; c++) this.ola[c][(this.head + this.pos) % N] = 0;
            this.pos++;
            if (this.pos >= H) this.head = (this.head + H) % N;
        }
        // Finite and bounded, whatever the held spectrum was.
        for (let c = 0; c < channels; c++) {
            const out = output[c];
            for (let i = 0; i < n; i++) { const v = out[i]; if (!(v > -2 && v < 2)) out[i] = v !== v ? 0 : (v > 0 ? 2 : -2); }
        }
        return true;
    }
}

registerProcessor('pocapitol-freeze', FreezeProcessor);
