// PoCapitol's sonified HUD. Runs on the audio thread (AudioWorkletGlobalScope).
//
// Two quiet cues that say what the numbers on screen say, for anyone not looking at them:
//   creak  the police line you are standing at, straining. A granular wood-and-steel groan: each
//          grain is a stick-slip pulse train (the friction of a joint that grips and lets go)
//          rung through a resonance. As the line's integrity falls the grains come more often,
//          the pulse train gets rougher and the steel takes over from the wood;
//   tick   the crowd around you, packed. A dry tick that starts when the local density is heavy
//          and speeds up toward Fruin's level of service F (5.38 people/m2, the crush).
// No inputs, one output. Silent (and nearly free) unless a message says it is enabled and active.
//
// Messages in: { integrity 0..100 (100 = sound, null = no line near), density people/m2,
//                enabled bool, active bool }.

const TAU = Math.PI * 2;
const MAX_GRAINS = 6;
const LOS_F = 5.38;
const smooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

class HudProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.s = { integrity: null, density: 0, enabled: false, active: false };
        this.gate = 0;
        this.grains = [];
        this.grainWait = 0.3;
        this.tickWait = 0; this.tick = null;
        this.seed = 0x9e3779b9;
        this.creakLevel = 0; this.tickLevel = 0;
        this.port.onmessage = ({ data }) => Object.assign(this.s, data);
    }

    rand() {
        // xorshift32: cheap and allocation-free.
        let x = this.seed;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.seed = x >>> 0;
        return this.seed / 4294967296;
    }

    spawnGrain(loss) {
        if (this.grains.length >= MAX_GRAINS) return;
        const steel = this.rand() < loss * 0.85;
        // Stick-slip rate of the joint, and the resonance it excites.
        const slip = steel ? 55 + this.rand() * 110 : 28 + this.rand() * 70;
        const fr = steel ? 700 + this.rand() * 1700 : 150 + this.rand() * 520;
        const Q = steel ? 14 + this.rand() * 18 : 5 + this.rand() * 7;
        const length = (steel ? 0.05 : 0.07) + this.rand() * (steel ? 0.09 : 0.16);
        const w0 = TAU * fr / sampleRate, alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
        this.grains.push({
            age: 0, length, slip, phase: this.rand(), rough: 0.1 + 0.6 * loss, slipDrift: (this.rand() - 0.5) * 0.4,
            b0: alpha / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - alpha) / a0, y1: 0, y2: 0, x1: 0, x2: 0,
            level: (steel ? 0.7 : 1) * (0.6 + 0.4 * this.rand()), pan: this.rand() * 2 - 1,
        });
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const n = output[0].length, dt = n / sampleRate, s = this.s;
        const on = s.enabled && s.active;
        this.gate += ((on ? 1 : 0) - this.gate) * Math.min(1, dt / 0.25);
        if (this.gate < 0.002 && this.grains.length === 0 && !this.tick) {
            for (const ch of output) ch.fill(0);
            return true;
        }
        const loss = s.integrity === null || s.integrity === undefined ? 0 : 1 - Math.min(100, Math.max(0, s.integrity)) / 100;
        const strain = smooth((loss - 0.2) / 0.5);                    // nothing until the line is hurt
        const crush = smooth((s.density - 2.4) / (LOS_F - 2.4));       // nothing until it is packed
        this.creakLevel += (strain * 0.5 - this.creakLevel) * Math.min(1, dt / 0.4);
        this.tickLevel += (crush - this.tickLevel) * Math.min(1, dt / 0.3);

        // Grain scheduling: density from a grain every ~3 s to ~14 a second.
        if (on && strain > 0.01) {
            this.grainWait -= dt;
            if (this.grainWait <= 0) {
                this.spawnGrain(loss);
                const rate = 0.35 + 14 * Math.pow(strain, 1.4);
                this.grainWait = (0.6 + 0.8 * this.rand()) / rate;
            }
        }
        // Tick scheduling: 1.2 Hz, accelerating to ~14 Hz at LOS F.
        if (on && crush > 0.01) {
            this.tickWait -= dt;
            if (this.tickWait <= 0) {
                this.tick = { age: 0, level: 0.5 + 0.5 * crush, phase: 0 };
                this.tickWait = 1 / (1.2 + 12.8 * crush * crush);
            }
        }

        const L = output[0], R = output[1] ?? null;
        L.fill(0); if (R) R.fill(0);
        const gain = this.gate * 0.12;
        for (let i = 0; i < n; i++) {
            let l = 0, r = 0;
            for (let g = 0; g < this.grains.length; g++) {
                const gr = this.grains[g];
                const p = gr.age / gr.length;
                if (p >= 1) continue;
                // The joint's friction: a pulse that grips (sawtooth rise) then lets go (a snap),
                // its pace wandering, with noise for roughness.
                gr.phase += gr.slip * (1 + gr.slipDrift * (p - 0.5)) / sampleRate;
                if (gr.phase >= 1) gr.phase -= 1;
                const pulse = (gr.phase < 0.12 ? 1 - gr.phase / 0.12 * 2 : -0.4 + 0.4 * (gr.phase - 0.12)) * 1.0;
                const x = pulse + (this.rand() * 2 - 1) * gr.rough;
                const y = gr.b0 * (x - gr.x2) - gr.a1 * gr.y1 - gr.a2 * gr.y2;
                gr.x2 = gr.x1; gr.x1 = x; gr.y2 = gr.y1; gr.y1 = y;
                const env = Math.sin(Math.PI * p);
                const v = y * env * env * gr.level * 3.2;
                l += v * (0.5 - 0.5 * gr.pan); r += v * (0.5 + 0.5 * gr.pan);
                gr.age += 1 / sampleRate;
            }
            const k = this.tick;
            let t = 0;
            if (k) {
                // A dry click: a short 2.2 kHz burst, ten milliseconds long.
                k.phase += TAU * 2200 / sampleRate;
                t = Math.sin(k.phase) * Math.exp(-k.age / 0.0035) * k.level * 0.9;
                k.age += 1 / sampleRate;
                if (k.age > 0.03) this.tick = null;
            }
            L[i] = (l * this.creakLevel + t * 0.55 * this.tickLevel) * gain * 2;
            if (R) R[i] = (r * this.creakLevel + t * 0.55 * this.tickLevel) * gain * 2;
        }
        for (let g = this.grains.length - 1; g >= 0; g--) if (this.grains[g].age >= this.grains[g].length) this.grains.splice(g, 1);
        return true;
    }
}

registerProcessor('pocapitol-hud', HudProcessor);
