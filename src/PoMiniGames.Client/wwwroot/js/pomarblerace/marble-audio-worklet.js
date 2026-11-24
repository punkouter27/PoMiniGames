// marble-audio-worklet.js — Real-time AudioWorkletProcessors for PoMarbleRace, on the dedicated Web
// Audio render thread (no main-thread jank can glitch them):
//
//   marble-synth-processor  modal glass-resonance impacts, continuous rolling grain driven by the
//                           physics telemetry, and (#18) the Doppler whoosh of a rival passing you:
//                           band-passed air whose centre sweeps from high to low as it goes by,
//                           with the rival's rolling hum under it, panned where it passed;
//   marble-music-processor  (#19) the race score, sample-accurate: a pad under the grid, then bass,
//                           drums once you are in the top ten, a lead line on the podium or in the
//                           final stretch, all on one tempo grid. Chord changes, tempo changes and
//                           the act-change crash land on a bar line, never mid-bar.

const MODAL_RATIOS = {
  marble: [1.0, 2.76, 5.40, 8.93],   // soda-lime glass sphere partials (inharmonic ring)
  spinner: [1.0, 2.12, 3.85, 6.14],  // metallic rotor clang
  obstacle: [1.0, 1.88, 3.31, 5.20], // pin / island ping
  bump: [1.0, 1.45, 2.30, 3.10],     // low washboard thud
  surface: [1.0, 1.62, 2.81, 4.10],  // tarmac knock
};

const TWO_PI = 6.28318530718;

class MarbleSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.passes = [];
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
      } else if (m.type === 'pass') {
        this._triggerPass(m);
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

  // #18 one pass: `rel` the closing speed (u/s), `pan` -1..1, `gain` 0..1.
  _triggerPass(m) {
    if (this.passes.length >= 3) this.passes.shift();
    const rel = Math.max(3, Math.min(80, m.rel || 10));
    // the faster the pass, the shorter it is and the further the pitch falls
    const dur = Math.max(0.32, Math.min(0.95, 1.0 - rel * 0.009));
    const ratio = 1 + rel / 70;                       // approach / recede ≈ (c + v) / (c - v)
    const centre = 520 + Math.random() * 160;
    const pan = Math.max(-1, Math.min(1, m.pan || 0));
    this.passes.push({
      t: 0, dur, f0: centre * ratio, f1: centre / ratio,
      hum0: 150 * ratio, hum1: 150 / ratio, hp: 0,
      pan0: pan * 0.5, pan1: pan, gain: Math.max(0.05, Math.min(1, m.gain == null ? 1 : m.gain)) * 0.42,
      low: 0, band: 0,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const chL = out[0];
    const chR = out[1] || chL;
    const sr = sampleRate;

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
      const grain = 0.72 + 0.28 * Math.sin(this.grainPhase * TWO_PI);
      let sample = this.lp * rollGain * grain;

      // Sum active polyphonic modal glass-resonance voices
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        let maxAmp = 0;
        for (let k = 0; k < voice.modes.length; k++) {
          const mode = voice.modes[k];
          mode.phase += (TWO_PI * mode.freq) / sr;
          if (mode.phase > TWO_PI) mode.phase -= TWO_PI;
          sample += Math.sin(mode.phase) * mode.amp;
          mode.amp *= mode.decay;
          if (mode.amp > maxAmp) maxAmp = mode.amp;
        }
        if (maxAmp < 0.0003) this.voices.splice(v, 1);
      }

      // Doppler passes: a state-variable band-pass over white noise, its centre swept down
      // exponentially; a hum under it falling by the same ratio; a sin² swell over the pass.
      let pl = 0, pr = 0;
      for (let v = this.passes.length - 1; v >= 0; v--) {
        const p = this.passes[v];
        const u = p.t / p.dur;
        if (u >= 1) { this.passes.splice(v, 1); continue; }
        const env = Math.pow(Math.sin(Math.PI * u), 2);
        const fc = p.f0 * Math.pow(p.f1 / p.f0, u);
        const f = 2 * Math.sin(Math.PI * Math.min(0.45, fc / sr));
        p.low += f * p.band;
        const high = white - p.low - 0.32 * p.band;
        p.band += f * high;
        p.hp += (TWO_PI * (p.hum0 * Math.pow(p.hum1 / p.hum0, u))) / sr;
        if (p.hp > TWO_PI) p.hp -= TWO_PI;
        const s = (p.band * 0.9 + Math.sin(p.hp) * 0.22) * env * p.gain;
        const pan = p.pan0 + (p.pan1 - p.pan0) * u;
        const a = (pan + 1) * 0.25 * Math.PI;
        pl += s * Math.cos(a);
        pr += s * Math.sin(a);
        p.t += 1 / sr;
      }

      // Soft-clip safety
      chL[i] = Math.tanh(sample + pl);
      if (chR !== chL) chR[i] = Math.tanh(sample + pr);
    }
    return true;
  }
}

registerProcessor('marble-synth-processor', MarbleSynthProcessor);

// ── #19 the score ─────────────────────────────────────────────────────────────────────────────
// D minor. One chord a bar, 16 sixteenths a bar. A progression per act; the finale's ends on the
// major V (A) for lift. Semitones above D3.
const D3 = 146.83;
const PROGRESSIONS = [
  [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']],     // Dm  Bb  F  C
  [[0, 'm'], [3, 'M'], [10, 'M'], [8, 'M']],     // Dm  F   C  Bb
  [[8, 'M'], [3, 'M'], [10, 'M'], [0, 'm']],     // Bb  F   C  Dm
  [[0, 'm'], [10, 'M'], [8, 'M'], [10, 'M']],    // Dm  C   Bb C
  [[0, 'm'], [8, 'M'], [10, 'M'], [7, 'M']],     // Dm  Bb  C  A   (the finale)
];
const BASS_STEPS = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
const hz = (semi) => D3 * Math.pow(2, semi / 12);
const triad = (root, q) => [root, root + (q === 'm' ? 3 : 4), root + 7];

class MarbleMusicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // targets from the game, applied on bar lines where it matters
    this.mode = 'off';          // 'off' | 'grid' (pad only) | 'race'
    this.prog = 0; this.place = -1; this.boost = false; this.act = 0;
    this.barAct = 0; this.crash = 0;
    this.bpm = 112; this.nextBpm = 112;
    this.step = -1; this.inStep = 0; this.bar = 0;
    this.chord = triad(0, 'm'); this.root = 0;
    // layer levels (current eases toward target, ~1.5 s)
    this.lv = { pad: 0, bass: 0, kick: 0, hat: 0, snare: 0, lead: 0 };
    this.to = { pad: 0, bass: 0, kick: 0, hat: 0, snare: 0, lead: 0 };
    // voices
    this.padPh = new Float64Array(6); this.padF = new Float64Array(6); this.padLpL = 0; this.padLpR = 0;
    this.bassPh = 0; this.bassF = 73.4; this.bassEnv = 0;
    this.kickPh = 0; this.kickT = 1;
    this.hatEnv = 0; this.hatLp = 0;
    this.snEnv = 0; this.snLp = 0;
    this.leadPh = 0; this.leadF = 440; this.leadEnv = 0; this.leadLp = 0; this.leadIdx = 0;
    this.crashEnv = 0; this.crashLp = 0;
    this.master = 0;
    this._setChord(0);
    for (let k = 0; k < 6; k++) this.padF[k] = this.padTarget[k];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== 'music') return;
      if (m.mode) this.mode = m.mode;
      if (m.prog != null) this.prog = m.prog;
      if (m.place != null) this.place = m.place;
      if (m.boost != null) this.boost = !!m.boost;
      if (m.act != null && m.act >= 0) this.act = m.act;
    };
  }

  _setChord(barIdx) {
    const prog = PROGRESSIONS[Math.min(PROGRESSIONS.length - 1, this.prog >= 0.86 ? 4 : this.barAct % 4)];
    const [root, q] = prog[barIdx % prog.length];
    this.root = root;
    this.chord = triad(root, q);
    // the pad voices the triad in the D3-D4 octave, two detuned oscillators a note
    this.padTarget = new Float64Array(6);
    for (let k = 0; k < 3; k++) {
      let semi = this.chord[k];
      while (semi > 12) semi -= 12;
      this.padTarget[k * 2] = hz(semi) * 1.0023;
      this.padTarget[k * 2 + 1] = hz(semi) * 0.9977;
    }
  }

  _onStep(st) {
    if (st === 0) {
      // bar line: take the new act, the tempo, the chord
      if (this.act !== this.barAct) { this.barAct = this.act; if (this.mode === 'race') this.crash = 1; }
      this.bpm = this.nextBpm;
      this.bar++;
      this._setChord(this.bar);
    }
    const race = this.mode === 'race';
    const top10 = this.place > 0 && this.place <= 10;
    const finale = this.prog >= 0.86;
    // layer targets
    this.to.pad = this.mode === 'off' ? 0 : race ? 0.8 : 0.6;
    this.to.bass = race ? 1 : 0;
    this.to.kick = race ? (top10 || finale ? 1 : 0.45) : 0;
    this.to.hat = race && (top10 || finale || this.boost) ? 1 : 0;
    this.to.snare = race && finale ? 1 : 0;
    this.to.lead = race && (finale || (this.place > 0 && this.place <= 3)) ? 1 : 0;
    this.nextBpm = race ? 116 + this.prog * 16 + (this.boost ? 4 : 0) : 104;

    if (race && BASS_STEPS[st]) {
      const fifth = st === 8 && this.bar % 2 === 1;
      let semi = this.root + (fifth ? 7 : 0);
      while (semi >= 6) semi -= 12;
      this.bassF = hz(semi) * 0.5;
      this.bassEnv = 1;
    }
    if (st % 4 === 0) this.kickT = 0;
    if (st % 4 === 2 || (finale && st % 2 === 1)) this.hatEnv = st % 4 === 2 ? 1 : 0.55;
    if (st === 4 || st === 12) this.snEnv = 1;
    // the lead climbs the chord over two octaves in sixteenths
    const tone = this.chord[this.leadIdx % 3] + 12 * (1 + Math.floor((this.leadIdx % 6) / 3));
    this.leadF = hz(tone);
    this.leadEnv = 1;
    this.leadIdx++;
    if (this.crash > 0 && st === 0) { this.crashEnv = 1; this.crash = 0; }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const L = out[0];
    const R = out[1] || L;
    const sr = sampleRate;
    // layer levels ease once a block (a ~1.2 s glide), so a layer enters over about a bar
    const lvA = 1 - Math.exp(-L.length / (sr * 1.2));
    for (const k in this.lv) this.lv[k] += (this.to[k] - this.lv[k]) * lvA;
    const masterTo = this.mode === 'off' ? 0 : 1;
    const padCut = 0.035 + this.prog * 0.06 + (this.boost ? 0.03 : 0);

    for (let i = 0; i < L.length; i++) {
      // sequencer
      const stepLen = (60 / this.bpm / 4) * sr;
      if (++this.inStep >= stepLen || this.step < 0) {
        this.inStep = 0;
        this.step = (this.step + 1) % 16;
        this._onStep(this.step);
      }
      this.master += (masterTo - this.master) * 0.00004;
      if (this.master < 1e-4 && masterTo === 0) { L[i] = 0; if (R !== L) R[i] = 0; continue; }

      const white = Math.random() * 2 - 1;

      // pad: six naive saws glide to the chord, low-passed, split across the stereo field
      let pl = 0, pr = 0;
      for (let k = 0; k < 6; k++) {
        this.padF[k] += (this.padTarget[k] - this.padF[k]) * 0.0006;
        this.padPh[k] += this.padF[k] / sr;
        if (this.padPh[k] >= 1) this.padPh[k] -= 1;
        const s = this.padPh[k] * 2 - 1;
        if (k & 1) pr += s; else pl += s;
      }
      this.padLpL += (pl - this.padLpL) * padCut;
      this.padLpR += (pr - this.padLpR) * padCut;
      const pad = this.lv.pad * 0.05;

      // bass: sine and a touch of its octave, plucked
      this.bassPh += this.bassF / sr;
      if (this.bassPh >= 1) this.bassPh -= 1;
      this.bassEnv *= 0.99985;
      const bass = (Math.sin(this.bassPh * TWO_PI) + 0.25 * Math.sin(this.bassPh * 2 * TWO_PI)) * this.bassEnv * this.lv.bass * 0.16;

      // kick: a sine that falls from 110 to 42 Hz
      let kick = 0;
      if (this.kickT < 0.35) {
        const f = 42 + 68 * Math.exp(-this.kickT * 32);
        this.kickPh += f / sr;
        kick = Math.sin(this.kickPh * TWO_PI) * Math.exp(-this.kickT * 9) * this.lv.kick * 0.32;
        this.kickT += 1 / sr;
      }

      // hat: high-passed noise, very short
      this.hatLp += (white - this.hatLp) * 0.35;
      this.hatEnv *= 0.9975;
      const hat = (white - this.hatLp) * this.hatEnv * this.lv.hat * 0.05;

      // snare: mid noise with a body
      this.snLp += (white - this.snLp) * 0.18;
      this.snEnv *= 0.9992;
      const sn = (this.snLp * 0.8 + white * 0.2) * this.snEnv * this.lv.snare * 0.11;

      // lead: a soft square (three odd partials), low-passed
      this.leadPh += this.leadF / sr;
      if (this.leadPh >= 1) this.leadPh -= 1;
      const ph = this.leadPh * TWO_PI;
      this.leadEnv *= 0.99955;
      const sq = Math.sin(ph) + Math.sin(3 * ph) / 3 + Math.sin(5 * ph) / 5;
      this.leadLp += (sq - this.leadLp) * 0.22;
      const lead = this.leadLp * this.leadEnv * this.lv.lead * 0.05;

      // crash on the act's first downbeat
      this.crashLp += (white - this.crashLp) * 0.6;
      this.crashEnv *= 0.99993;
      const crash = (white - this.crashLp) * this.crashEnv * 0.07;

      const mono = bass + kick + hat + sn + crash;
      const g = this.master;
      L[i] = Math.tanh((mono + this.padLpL * pad + lead * 0.8) * g);
      if (R !== L) R[i] = Math.tanh((mono + this.padLpR * pad + lead * 1.2) * g);
    }
    return true;
  }
}

registerProcessor('marble-music-processor', MarbleMusicProcessor);
