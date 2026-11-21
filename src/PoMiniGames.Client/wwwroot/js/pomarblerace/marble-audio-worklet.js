// marble-audio-worklet.js — Real-time AudioWorkletProcessor for PoMarbleRace.
// Runs on the dedicated Web Audio render thread for zero-glitch modal glass-resonance impacts
// and continuous sample-accurate rolling-grain synthesis driven by Rapier WASM telemetry.

const MODAL_RATIOS = {
  marble: [1.0, 2.76, 5.40, 8.93],   // soda-lime glass sphere partials (inharmonic ring)
  spinner: [1.0, 2.12, 3.85, 6.14],  // metallic rotor clang
  obstacle: [1.0, 1.88, 3.31, 5.20], // pin / island ping
  bump: [1.0, 1.45, 2.30, 3.10],     // low washboard thud
  surface: [1.0, 1.62, 2.81, 4.10],  // tarmac knock
};

class MarbleSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.speed = 0;
    this.slip = 0;
    this.surface = 0; // 0=tarmac, 1=tunnel, 2=slide, 3=boost
    this.b0 = 0; this.b1 = 0; this.b2 = 0; // pink noise filter state
    this.lp = 0;
    this.grainPhase = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'impact') {
        this._triggerImpact(m.energy || 0.5, m.material || 'marble');
      } else if (m.type === 'roll') {
        this.speed = m.speed || 0;
        this.slip = m.slip || 0;
        this.surface = m.surface || 0;
      }
    };
  }

  _triggerImpact(energy, material) {
    if (this.voices.length >= 8) this.voices.shift();
    const ratios = MODAL_RATIOS[material] || MODAL_RATIOS.marble;
    const baseFreq = material === 'marble'
      ? 1450 + Math.random() * 520 + energy * 380
      : material === 'spinner'
        ? 580 + Math.random() * 220
        : material === 'bump'
          ? 240 + Math.random() * 90
          : 780 + Math.random() * 300;
    const decay = material === 'marble' ? 0.99945 : material === 'spinner' ? 0.9996 : 0.9988;
    const modes = ratios.map((r, idx) => ({
      freq: baseFreq * r,
      phase: 0,
      amp: (energy * 0.16) / (1 + idx * 0.85),
      decay: Math.pow(decay, 1 + idx * 0.55),
    }));
    this.voices.push({ modes, life: 1 });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const chL = out[0];
    const chR = out[1] || chL;
    const sr = sampleRate;
    const twoPi = 6.28318530718;

    // Surface-adaptive rolling grain parameters
    const spdNorm = Math.min(1, this.speed / 85);
    const cutoff = this.surface === 2 ? 0.28 : this.surface === 1 ? 0.12 : this.surface === 3 ? 0.36 : 0.18;
    const rollGain = spdNorm * (this.surface === 2 ? 0.032 : 0.045) + Math.min(1, this.slip) * 0.035;

    for (let i = 0; i < chL.length; i++) {
      // Pink-ish noise for continuous tarmac / slide / tunnel rolling texture
      const white = Math.random() * 2 - 1;
      this.b0 = 0.997 * this.b0 + white * 0.029;
      this.b1 = 0.985 * this.b1 + white * 0.032;
      this.b2 = 0.950 * this.b2 + white * 0.048;
      const pink = (this.b0 + this.b1 + this.b2 + white * 0.02) * 0.5;
      this.lp += (pink - this.lp) * (cutoff + spdNorm * 0.25);

      // Subtle micro-grain modulation proportional to marble wheeling speed
      this.grainPhase += (18 + spdNorm * 58) / sr;
      if (this.grainPhase >= 1) this.grainPhase -= 1;
      const grain = 0.72 + 0.28 * Math.sin(this.grainPhase * twoPi);
      let sample = this.lp * rollGain * grain;

      // Sum active polyphonic modal glass-resonance voices
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        let maxAmp = 0;
        for (let k = 0; k < voice.modes.length; k++) {
          const mode = voice.modes[k];
          mode.phase += (twoPi * mode.freq) / sr;
          if (mode.phase > twoPi) mode.phase -= twoPi;
          sample += Math.sin(mode.phase) * mode.amp;
          mode.amp *= mode.decay;
          if (mode.amp > maxAmp) maxAmp = mode.amp;
        }
        if (maxAmp < 0.0003) this.voices.splice(v, 1);
      }

      // Soft-clip safety
      const s = Math.tanh(sample);
      chL[i] = s;
      if (chR !== chL) chR[i] = s;
    }
    return true;
  }
}

registerProcessor('marble-synth-processor', MarbleSynthProcessor);
