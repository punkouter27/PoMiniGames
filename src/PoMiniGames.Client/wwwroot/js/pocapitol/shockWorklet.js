// PoCapitol's shell shock. Runs on the audio thread (AudioWorkletGlobalScope).
//
// The scene mix passes through here (two channels in, two out). Usually it is copied straight
// across. After a flash-bang or concussion close by, three things happen at once:
//   1. a very steep low-pass (eight poles, 48 dB/octave) clamps the scene to about 300 Hz and
//      opens back to full band over roughly six seconds, longer and tighter the nearer and
//      harder the blast was;
//   2. a sine rings in each ear (a few hertz apart, so the two beat), its pitch sliding down as
//      it fades, replacing the plain 3.7 kHz tone audio.js used to play;
//   3. a heartbeat (lub-dub, a low thump) comes up under it, its rate following the player's
//      health and exertion and surging with the blast.
// The ring and the heartbeat are generated here and fade out whenever `active` is false (a
// pause, a menu, the end of the attempt), so they never sound over a menu.
//
// Messages in: { shock: { strength 0..1, delay seconds, gentle bool } } and
//              { state: { active, health 0..100, moving, gentle } }.

const TAU = Math.PI * 2;
/** Q of each section of an 8th-order Butterworth low-pass. */
const Q8 = [0.5098, 0.6013, 0.9, 2.5629];
const FLOOR = 300, CEIL = 20000;
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

class ShockProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.shock = null;      // { t, strength, delay, length, gentle }
        this.state = { active: false, health: 100, moving: false, gentle: false };
        this.act = 0;           // smoothed `active`
        // Per channel, per section: [x1, x2, y1, y2].
        this.z = [0, 1].map(() => Q8.map(() => new Float64Array(4)));
        this.coef = Q8.map(() => new Float64Array(5));
        this.ringPhase = [0, 0]; this.ringPhase2 = [0, 0];
        this.bpm = 64; this.beat = 0; this.beatStep = 0;   // step 0 = lub, 1 = dub
        this.thumps = [];       // { age, freq, level }
        this.wet = 0;
        this.port.onmessage = ({ data }) => {
            if (data.shock) {
                const s = data.shock, strength = Math.min(1, Math.max(0, s.strength ?? 0));
                // A stronger shock begins heavier and takes longer to clear; a shallow one starts
                // part way open. Never overwrite a worse one still in progress with a lesser one.
                const live = this.shock ? this.level(this.shock) : 0;
                if (strength * 1 < live) return;
                this.shock = { t: -(s.delay ?? 0), strength, length: 3 + 4.5 * strength, gentle: s.gentle === true };
                this.z.forEach(ch => ch.forEach(z => z.fill(0)));
            }
            if (data.state) Object.assign(this.state, data.state);
        };
    }

    /** The shock's remaining strength, 0..1, a smooth decay over its length. */
    level(s) {
        if (s.t < 0) return s.strength;
        return s.strength * Math.exp(-3 * s.t / s.length);
    }

    setLowpass(fc, rate) {
        const w0 = TAU * Math.min(fc, rate * 0.45) / rate, cos = Math.cos(w0), sin = Math.sin(w0);
        for (let k = 0; k < Q8.length; k++) {
            const alpha = sin / (2 * Q8[k]), a0 = 1 + alpha, c = this.coef[k];
            c[0] = (1 - cos) / 2 / a0; c[1] = (1 - cos) / a0; c[2] = c[0];
            c[3] = -2 * cos / a0; c[4] = (1 - alpha) / a0;
        }
    }

    process(inputs, outputs) {
        const input = inputs[0], output = outputs[0];
        if (!output || output.length === 0) return true;
        const n = output[0].length;
        const channels = output.length;
        const st = this.state, shock = this.shock;
        const dt = n / sampleRate;
        this.act += ((st.active ? 1 : 0) - this.act) * Math.min(1, dt / 0.15);

        // Nothing happening: copy the scene across and stop.
        const lowHealth = Math.max(0, (35 - st.health) / 35);
        const idleHeart = this.act > 0.01 && lowHealth > 0.02;
        if (!shock && !idleHeart && this.thumps.length === 0) {
            for (let c = 0; c < channels; c++) {
                const src = input[c] ?? input[0];
                if (src) output[c].set(src); else output[c].fill(0);
            }
            return true;
        }

        let sig = 0, p = 1, wetTarget = 0;
        if (shock) {
            shock.t += dt;
            sig = this.level(shock);
            const T = shock.length;
            p = shock.t / T;
            if (p >= 1 || sig < 0.004) { if (shock.t >= 0) { this.shock = null; } }
        }
        const cur = this.shock;
        let sweep = 1;
        if (cur && cur.t >= 0) {
            // Cutoff opens exponentially from a floor (higher for a lighter shock) to full band.
            const start = FLOOR * (1 + (1 - cur.strength) * 10);
            sweep = smooth(cur.t / cur.length);
            const fc = start * Math.pow(CEIL / start, sweep);
            this.setLowpass(fc, sampleRate);
            // Engage over 90 ms so the bang itself is not chopped off mid-wave.
            wetTarget = Math.min(1, cur.t / 0.09) * (1 - smooth((sweep - 0.94) / 0.06));
        }
        const wetStart = this.wet, wetEnd = wetTarget;

        // Heartbeat and ring levels.
        const t = cur ? Math.max(0, cur.t) : 0;
        const gentle = st.gentle || (cur?.gentle ?? false);
        const strength = cur ? cur.strength : 0;
        const ringEnv = cur && cur.t >= 0 ? strength * Math.min(1, cur.t / 0.02) * Math.exp(-cur.t / (cur.length * (gentle ? 0.28 : 0.5))) : 0;
        const heartEnv = cur && cur.t >= 0 ? strength * Math.min(1, cur.t / 1.2) * Math.exp(-cur.t / (cur.length * 1.1)) : 0;
        const heartLevel = Math.max(heartEnv, lowHealth * 0.5) * (gentle ? 0.6 : 1) * this.act;
        const bpmTarget = Math.min(170, Math.max(50, 58 + 48 * (1 - st.health / 100) + (st.moving ? 12 : 0) + 55 * heartEnv));
        this.bpm += (bpmTarget - this.bpm) * Math.min(1, dt / 1.5);
        // Ring pitch: slides down about a quarter over the first seconds.
        const fall = 1 - 0.27 * (1 - Math.exp(-t / 3.2));
        const f0 = 3900 * fall;
        const ringAmp = 0.055 * ringEnv * this.act * (gentle ? 0.55 : 1);

        // Beats are scheduled per block; each becomes a decaying low sine.
        let beatLeft = n;
        let offset = 0;
        const beatsThisBlock = [];
        if (heartLevel > 0.002) {
            let remaining = dt;
            while (this.beat <= remaining) {
                remaining -= this.beat;
                beatsThisBlock.push({ at: Math.round((dt - remaining) / dt * n) - 0, step: this.beatStep });
                const period = 60 / this.bpm;
                // lub to dub about 0.3 of a beat, dub to the next lub the rest.
                this.beat = this.beatStep === 0 ? period * 0.3 : period * 0.7;
                this.beatStep ^= 1;
            }
            this.beat -= remaining;
        } else if (this.beat > 0) this.beat = Math.max(0, this.beat - dt);
        for (const b of beatsThisBlock) {
            this.thumps.push({ age: -b.at / sampleRate, freq: b.step === 0 ? 62 : 74, level: (b.step === 0 ? 1 : 0.62) * heartLevel, phase: 0, dub: b.step });
        }

        const ringStep = [TAU * f0 / sampleRate, TAU * (f0 + 3.4) / sampleRate];
        const ringStep2 = [TAU * f0 * 1.51 / sampleRate, TAU * (f0 * 1.51 - 4.1) / sampleRate];

        for (let c = 0; c < channels; c++) {
            const src = input[c] ?? input[0];
            const out = output[c];
            const zc = this.z[c % 2];
            const side = c % 2;
            for (let i = 0; i < n; i++) {
                const dry = src ? src[i] : 0;
                let x = dry;
                if (wetStart > 0.0005 || wetEnd > 0.0005) {
                    for (let k = 0; k < Q8.length; k++) {
                        const co = this.coef[k], z = zc[k];
                        const y = co[0] * x + co[1] * z[0] + co[2] * z[1] - co[3] * z[2] - co[4] * z[3];
                        z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y;
                        x = y;
                    }
                    const w = wetStart + (wetEnd - wetStart) * (i / n);
                    x = dry + (x - dry) * w;
                }
                let gen = 0;
                if (ringAmp > 0.0001) {
                    this.ringPhase[side] += ringStep[side]; this.ringPhase2[side] += ringStep2[side];
                    if (this.ringPhase[side] > TAU) this.ringPhase[side] -= TAU;
                    if (this.ringPhase2[side] > TAU) this.ringPhase2[side] -= TAU;
                    gen += ringAmp * (Math.sin(this.ringPhase[side]) + 0.22 * Math.sin(this.ringPhase2[side]));
                }
                out[i] = x + gen;
            }
        }
        this.wet = wetEnd;

        // Heartbeat thumps: mono, added to every channel.
        if (this.thumps.length) {
            for (let i = 0; i < n; i++) {
                let v = 0;
                for (const th of this.thumps) {
                    th.age += 1 / sampleRate;
                    if (th.age < 0) continue;
                    // Pitch drops as the thump decays, like a drum head relaxing.
                    const f = th.freq * (0.62 + 0.38 * Math.exp(-th.age / 0.045));
                    th.phase += TAU * f / sampleRate;
                    v += Math.sin(th.phase) * Math.exp(-th.age / (th.dub ? 0.05 : 0.065)) * Math.min(1, th.age / 0.004 + 0.0) * th.level;
                }
                v *= 0.5;
                for (let c = 0; c < channels; c++) output[c][i] += v;
            }
            this.thumps = this.thumps.filter(th => th.age < 0.45);
        }
        // Keep it finite whatever happens.
        for (let c = 0; c < channels; c++) {
            const out = output[c];
            for (let i = 0; i < n; i++) { const v = out[i]; if (!(v > -4 && v < 4)) out[i] = v !== v ? 0 : (v > 0 ? 4 : -4); }
        }
        return true;
    }
}

registerProcessor('pocapitol-shock', ShockProcessor);
