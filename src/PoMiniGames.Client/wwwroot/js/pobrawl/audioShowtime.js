// audioShowtime.js — the showtime half of the AudioBus (audio.js), driven by audioShow.js on
// the show bus: the conductor grid, the per-president leitmotifs and fanfare, the charge
// risers, the camera perspective and the crowd's stomp-clap and chant. A prototype mixin
// (mixin.js): `this` is the AudioBus.

import { ARENA_HALF_WIDTH, rand, clamp, autoDisconnect, noteToFreq, MOTIFS, DEFAULT_MOTIF } from './audioCore.js';

// Camera perspective (setPerspective). send = reverb-send multiplier, thump = low-mid peak
// (dB at 170 Hz), hc = high-cut corner (Hz), crowd = crowd-bed multiplier.
//   tight — close/ots/two/push-in/reaction: drier, closer, chest-thump, crowd back
//   mid   — the house angle and the over-the-top jib
//   wide  — establishing: the room opens up, the hall is louder, the air dulls the top
//   ko    — the KO cinematic: big room AND the thump
const PERSPECTIVES = {
  tight: { send: 0.45, thump: 4.5,  hc: 20000, crowd: 0.62 },
  mid:   { send: 1.0,  thump: 0,    hc: 20000, crowd: 1.0 },
  wide:  { send: 1.8,  thump: -1.5, hc: 7200,  crowd: 1.3 },
  ko:    { send: 1.5,  thump: 3,    hc: 20000, crowd: 1.1 },
};
// Perspective glide, seconds (setTargetAtTime time constant): no clicks on a hard cut.
const PERSP_TAU = 0.12;

// "U-S-A!" chant syllables: duration (s) and three formants as [from, to] Hz glides across
// the vowel; `sib` closes the syllable on an /s/ hiss (crowdChant).
const CHANT_VOWELS = {
  U: { dur: 0.24, f: [[300, 330], [2100, 900], [2700, 2300]] },              // "you"
  S: { dur: 0.3,  f: [[580, 560], [1800, 1750], [2550, 2550]], sib: true },  // "ess"
  A: { dur: 0.46, f: [[680, 420], [1700, 2250], [2550, 2900]] },             // "ay"
};

// Charge risers: at most this many live at once (two corners plus a straggler in its snap).
const MAX_RISERS = 3;
// Balloon pops: a drop pops dozens at once; past this many live voices, pops are dropped.
const MAX_POPS = 8;

class AudioShowtimeMethods {
  // ══ Showtime (audioShow.js) ══════════════════════════════════════════
  // Driven by the show bus. The conductor is audioShow's silent clock; the AudioBus only
  // asks it how far the next grid line is (setConductor) and schedules on the audio clock.

  /** `fn()` → seconds to the conductor's next 8th/16th; null detaches. */
  setConductor(fn) { this._grid = typeof fn === 'function' ? fn : null; }

  // Quantize delay for a melodic layer: the conductor's answer, trusted only inside ~120 ms.
  _gridDelay() {
    const d = this._grid ? this._grid() : 0;
    return d > 0 && d < 0.13 ? d : 0;
  }

  /**
   * The camera's perspective on the mix: 'tight' | 'mid' | 'wide' | 'ko' (PERSPECTIVES).
   * Every stage glides with setTargetAtTime, so a hard cut is heard as a move, not a click.
   * Mix state only (no sound of its own), so it is recorded while muted too.
   */
  setPerspective(name) {
    const p = PERSPECTIVES[name];
    // Before the context exists the graph is built at 'mid'; recorded only once applied.
    if (!p || name === this._persp || !this.perspEq || !this.ctx) return;
    this._persp = name;
    this._glide(this.perspSend.gain, p.send, PERSP_TAU);
    this._glide(this.perspEq.gain, p.thump, PERSP_TAU);
    this._glide(this.perspHc.frequency, p.hc, PERSP_TAU);
    // The hall swells and recedes a little slower than the close-up sound.
    this._glide(this.crowdPersp.gain, p.crowd, PERSP_TAU * 2);
  }

  // setTargetAtTime from where the param is NOW. The cancel + anchor is load-bearing: a
  // glide chained onto an earlier, still-converging one was measured never to leave it.
  _glide(param, v, tau) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(v, now, tau);
  }

  /**
   * null → the side-on StereoPanner mix; 'HRTF' | 'equalpower' → one-shots get a PannerNode
   * heard from the AudioListener that setListener keeps on the camera.
   */
  setListenerMode(mode) {
    this._listenerMode = mode === 'HRTF' || mode === 'equalpower' ? mode : null;
  }

  /** Put the AudioListener on the camera: position, forward and up (world space). */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = this.ctx?.listener;
    if (!L) return;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // A stinger phrase's output: a fixed pan into stingGain, torn down once `end` passes.
  _stingOut(pan, at, end) {
    const out = this._pan(pan);
    (out.output || out).connect(this.stingGain);
    const k = this.ctx.createConstantSource();
    k.start(at); k.stop(end + 0.05);
    autoDisconnect(k, [k, out, out.output].filter(Boolean));
    return out;
  }

  /**
   * One note in a named timbre into `dest`; returns when it is silent.
   *   sustained: brass (two saws, filter swell) · reed (square, warm) · sax (saw, scooped,
   *              mid band) · organ (three drawbar sines) · chip (staccato square)
   *   struck:    keys (sine + soft octave) · twang (saw, closing filter) · pluck (triangle)
   *              · bell (sine + the 2.76 bar partial)
   */
  _tone(timbre, hz, t0, dur, peak, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(dest);
    let head = g;
    const extra = [g];
    const oscs = [];
    const osc = (type, f, cents = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      if (cents) o.detune.value = cents;
      oscs.push(o);
      return o;
    };
    const filter = (type, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.connect(g);
      head = f;
      extra.push(f);
      return f;
    };
    const end = t0 + dur;
    let sustained = true, atk = 0.02, ring = 0;
    switch (timbre) {
      case 'brass': {
        const lp = filter('lowpass', 1.2);
        lp.frequency.setValueAtTime(hz * 1.2, t0);
        lp.frequency.exponentialRampToValueAtTime(Math.min(9000, hz * 7), t0 + 0.05);
        lp.frequency.exponentialRampToValueAtTime(Math.min(6000, hz * 3.5), end + 0.05);
        osc('sawtooth', hz, -6); osc('sawtooth', hz, 6);
        atk = 0.025;
        break;
      }
      case 'reed': {
        filter('lowpass', 0.7).frequency.value = Math.min(3500, hz * 4);
        osc('square', hz);
        atk = 0.015;
        break;
      }
      case 'sax': {
        filter('bandpass', 0.8).frequency.value = 1300;
        const o = osc('sawtooth', hz);
        o.frequency.setValueAtTime(hz * 0.96, t0);
        o.frequency.linearRampToValueAtTime(hz, t0 + 0.04);
        peak *= 1.8; // the band throws most of the saw away
        break;
      }
      case 'organ':
        osc('sine', hz); osc('sine', hz * 2); osc('triangle', hz * 3);
        peak *= 0.55; atk = 0.008;
        break;
      case 'chip':
        osc('square', hz);
        peak *= 0.6; atk = 0.003;
        break;
      case 'keys':
        osc('sine', hz); osc('triangle', hz * 2);
        sustained = false; ring = Math.max(0.6, dur * 1.4); peak *= 0.8;
        break;
      case 'twang': {
        const lp = filter('lowpass', 2);
        lp.frequency.setValueAtTime(Math.min(9000, hz * 8), t0);
        lp.frequency.exponentialRampToValueAtTime(hz * 1.5, t0 + 0.18);
        const o = osc('sawtooth', hz);
        o.frequency.setValueAtTime(hz * 0.98, t0);
        o.frequency.linearRampToValueAtTime(hz, t0 + 0.03);
        sustained = false; ring = Math.max(0.45, dur * 1.2);
        break;
      }
      case 'pluck':
        osc('triangle', hz); osc('sine', hz * 2);
        sustained = false; ring = Math.max(0.35, dur);
        break;
      default: // 'bell'
        osc('sine', hz); osc('sine', hz * 2.76);
        sustained = false; ring = Math.max(0.9, dur * 1.5); peak *= 0.8;
        break;
    }
    const gp = g.gain;
    gp.setValueAtTime(0.0001, t0);
    let stopAt;
    if (sustained) {
      gp.linearRampToValueAtTime(peak, t0 + atk);
      gp.linearRampToValueAtTime(peak * 0.8, Math.max(t0 + atk + 0.005, end));
      gp.exponentialRampToValueAtTime(0.0008, end + 0.07);
      stopAt = end + 0.09;
    } else {
      gp.linearRampToValueAtTime(peak, t0 + 0.004);
      gp.exponentialRampToValueAtTime(0.0008, t0 + ring);
      stopAt = t0 + ring + 0.02;
    }
    oscs.forEach((o, i) => {
      o.connect(head);
      o.start(t0); o.stop(stopAt);
      autoDisconnect(o, i === oscs.length - 1 ? [o, ...extra] : [o]);
    });
    return stopAt;
  }

  /**
   * A president's leitmotif (MOTIFS; unknown ids get DEFAULT_MOTIF). Returns its end time.
   * @param {object} o  at (audio time), sixteenth (s), fit (squeeze the phrase into this many
   *   seconds), timbre (override), peak, transpose (semitones), pan, hold (extra seconds on
   *   the last note), dest (a node to feed instead of a fresh panned stinger output)
   */
  playMotif(charId, { at = 0, sixteenth = 0.11, fit = 0, timbre = null, peak = 0.1,
    transpose = 0, pan = 0, hold = 0, dest = null } = {}) {
    if (!this._ensure() || this.muted) return 0;
    const m = MOTIFS[charId] || DEFAULT_MOTIF;
    const start = Math.max(at, this.ctx.currentTime);
    let total = 0;
    for (const d of m.durs) total += d;
    const six = fit > 0 ? Math.min(sixteenth, fit / total) : sixteenth;
    const root = noteToFreq(m.root) * Math.pow(2, transpose / 12);
    // Rough length up front for the output's teardown sentinel (a struck tail rings ~1 s).
    const out = dest || this._stingOut(pan, start, start + total * six + hold + 1.4);
    let t = start, end = start;
    m.notes.forEach((semi, i) => {
      const last = i === m.notes.length - 1;
      const d = m.durs[i] * six * (last ? 1 : 0.9) + (last ? hold : 0);
      // Accent the downbeat and the landing note.
      const pk = peak * (i === 0 || last ? 1 : 0.82);
      end = Math.max(end, this._tone(timbre || m.timbre, root * Math.pow(2, semi / 12), t, d, pk, out));
      t += m.durs[i] * six;
    });
    return end;
  }

  // The motif's root dropped into the brass's sweet octave (F3..E4) for chords.
  _chordRoot(charId) {
    let hz = noteToFreq((MOTIFS[charId] || DEFAULT_MOTIF).root);
    while (hz > 330) hz /= 2;
    while (hz < 165) hz *= 2;
    return hz;
  }

  // A snare roll from t0 to t1 swelling to `peak`: one noise source, one envelope with a
  // stroke every 32nd-triplet — three nodes for the whole roll, not one per stroke.
  _snareRoll(t0, t1, peak, dest) {
    const ctx = this.ctx;
    const src = this._noiseSource(Math.min(1.9, t1 - t0 + 0.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    const step = 0.034;
    for (let t = t0, i = 0; t < t1; t += step, i++) {
      const a = peak * (0.3 + 0.7 * (t - t0) / Math.max(0.01, t1 - t0)) * (i % 2 ? 0.8 : 1);
      g.gain.setValueAtTime(a, t);
      g.gain.exponentialRampToValueAtTime(a * 0.12, t + step * 0.9);
    }
    g.gain.exponentialRampToValueAtTime(0.0005, t1 + 0.08);
    src.connect(bp).connect(g).connect(dest || this.stingGain);
    src.start(t0, src._offset); src.stop(t1 + 0.1);
    autoDisconnect(src, [src, bp, g]);
  }

  /**
   * The countdown's call and response. The PA calls "3" at once, "2" at 1 s, "1" at 2 s and
   * "Fight!" at 3 s (game.js _tick), so each corner's motif sits in the gap after a number —
   * P1 from the left after "3", P2 answering from the right after "2" — and a snare roll
   * swells from "1" into "Fight!". Takes over the countdown from playIntroTheme.
   */
  countdownMotifs(c1, c2) {
    // Running-only: nodes queued on a suspended context would fire mid-fight on resume.
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this._introSuppressUntil = now + 0.5;
    this.playMotif(c1, { at: now + 0.4, fit: 0.6, sixteenth: 0.12, pan: -0.5, peak: 0.14 });
    this.playMotif(c2, { at: now + 1.4, fit: 0.6, sixteenth: 0.12, pan: 0.5, peak: 0.14 });
    this._snareRoll(now + 2.42, now + 2.97, 0.09);
  }

  /**
   * The winner's motif resolved as a fanfare: the phrase in its own voice over a brass
   * octave, then the tonic major chord held over a timpani stroke. `delay` lets the crowd's
   * result roar land first.
   */
  fanfare(charId, delay = 0.6) {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const at = ctx.currentTime + delay;
    const six = 0.1;
    const end = Math.max(
      this.playMotif(charId, { at, sixteenth: six, peak: 0.1 }),
      this.playMotif(charId, { at, sixteenth: six, timbre: 'brass', transpose: -12, peak: 0.07 }));
    const m = MOTIFS[charId] || DEFAULT_MOTIF;
    let total = 0;
    for (const d of m.durs) total += d;
    const chordAt = at + total * six + 0.02;
    const root = this._chordRoot(charId);
    const dur = 1.3;
    const out = this._stingOut(0, chordAt, Math.max(end, chordAt + dur + 0.2));
    [0, 7, 12, 16, 19].forEach((semi, i) =>
      this._tone('brass', root * Math.pow(2, semi / 12), chordAt, dur, i ? 0.045 : 0.06, out));
    this._timpani(chordAt, 0.3, root / 2);
  }

  // One timpani stroke: a pitched sine thud that sags a little, over a felt-mallet tick.
  _timpani(t0, peak, hz = 98) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(hz * 1.04, t0);
    o.frequency.exponentialRampToValueAtTime(hz * 0.97, t0 + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 1.1);
    o.connect(g).connect(this.stingGain);
    o.start(t0); o.stop(t0 + 1.15);
    autoDisconnect(o, [o, g]);
  }

  /**
   * Momentum swing: a short brass chord stab in the new leader's key when the HP lead flips
   * on a big hit. Snapped to the conductor's next 8th/16th. `power` 0..1.
   */
  brassStab(charId, power = 1, worldPos = null) {
    if (!this._ensure() || this.muted) return;
    const p = clamp(power, 0, 1);
    const at = this.ctx.currentTime + this._gridDelay();
    const pan = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.5 : 0;
    const out = this._stingOut(pan, at, at + 0.4);
    const root = this._chordRoot(charId);
    const voicing = p > 0.7 ? [0, 7, 12, 16] : [0, 7, 12];
    for (const semi of voicing) {
      this._tone('brass', root * Math.pow(2, semi / 12), at, 0.14, 0.04 + 0.04 * p, out);
    }
  }

  /**
   * The champion's honours — "Ruffles and Flourishes" (US military honours, public domain):
   * a drum ruffle under a bugle flourish up and down the Bb bugle notes, twice, landing
   * on a held chord. Plays when the belt ceremony's PA call is through.
   */
  flourish() {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const at = this.ctx.currentTime + 0.05;
    const BUGLE = ['F4', 'Bb4', 'D5', 'F5', 'D5', 'Bb4', 'F4', 'Bb4', 'D5', 'F5'];
    const step = 0.085;
    const phrase = BUGLE.length * step + 0.35;
    const out = this._stingOut(0, at, at + phrase * 2 + 1.8);
    for (let r = 0; r < 2; r++) {
      const t0 = at + r * phrase;
      this._snareRoll(t0, t0 + phrase - 0.15, 0.08);
      BUGLE.forEach((n, i) => {
        const last = i === BUGLE.length - 1;
        this._tone('brass', noteToFreq(n), t0 + i * step, last ? 0.3 : step * 0.85, last ? 0.09 : 0.075, out);
      });
    }
    const chordAt = at + phrase * 2;
    for (const [n, pk] of [['Bb3', 0.06], ['F4', 0.05], ['Bb4', 0.05], ['D5', 0.045], ['F5', 0.04]]) {
      this._tone('brass', noteToFreq(n), chordAt, 1.4, pk, out);
    }
    this._timpani(chordAt, 0.32, noteToFreq('Bb1'));
    this._pulse(0.6);
  }

  /**
   * A charge-up riser, panned to `worldPos` and followed via handle.set(amt, pos): three
   * Shepard partials an octave apart climbing two octaves as the coil fills (the bottom one
   * fades in as the top one fades out, so it keeps "rising"), over band-passed noise
   * sweeping 500 Hz → 4 kHz and narrowing. handle.ping() is the full-charge glint;
   * handle.stop(amt) snaps it shut with a whoosh scaled by the charge. A dead-man fade
   * re-armed on every set() silences it within 0.5 s if its owner stops updating (a hidden
   * tab, a crashed handler), so it can never drone. Returns null while muted.
   * @param {number} level loudness 0..1 (the CPU corners run quieter)
   */
  chargeRiser(worldPos = null, level = 1) {
    if (!this._ensure() || this.muted) return null;
    if (this._risers.size >= MAX_RISERS) this._risers.values().next().value.stop(0);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(spat);
    const partials = [0, 1, 2].map((k) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 70 * Math.pow(2, k); // where set(0) puts it: no opening chirp
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(out);
      o.start(now);
      return { o, g };
    });
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const ng = ctx.createGain();
    noise.connect(bp).connect(ng).connect(out);
    noise.start(now, Math.random() * (this.noiseBuf.duration - 0.05));
    const all = [noise, bp, ng, out, spat, spat.output, ...partials.flatMap((p) => [p.o, p.g])].filter(Boolean);

    const bus = this;
    const h = {
      amt: 0, level: clamp(level, 0, 1), pos: worldPos, alive: true,
      _partials: partials, // read by diagnostics only
      set(amt, pos = null) {
        if (!h.alive || !bus.ctx) return;
        const t = bus.ctx.currentTime;
        h.amt = clamp(amt, 0, 1);
        if (pos) { h.pos = pos; bus._moveSpat(spat, pos); }
        const lift = 2 * h.amt;                                // octaves climbed
        for (let k = 0; k < 3; k++) {
          const oct = k + lift;                                // 0..4 across the band
          const w = Math.sin(Math.PI * oct / 4);
          bus._glide(partials[k].o.frequency, 70 * Math.pow(2, oct), 0.04);
          bus._glide(partials[k].g.gain, 0.34 * w * w, 0.04);
        }
        bus._glide(bp.frequency, 500 * Math.pow(2, 3 * h.amt), 0.04);
        bus._glide(bp.Q, 1.5 + 5 * h.amt, 0.04);
        bus._glide(ng.gain, 0.4 + 1.4 * h.amt, 0.04);
        // The dead-man: up to the level, then a fade to silence that the next set() cancels.
        const lvl = (0.025 + 0.075 * h.amt) * h.level;
        const gp = out.gain;
        gp.cancelScheduledValues(t);
        gp.setValueAtTime(gp.value, t);
        gp.linearRampToValueAtTime(lvl, t + 0.05);
        gp.linearRampToValueAtTime(0, t + 0.5);
      },
      ping() {
        if (!h.alive || bus.muted || !bus.ctx) return;
        bus._glint(h.pos, h.level);
      },
      stop(amt = h.amt) {
        if (!h.alive) return;
        h.alive = false;
        bus._risers.delete(h);
        if (!bus.ctx) return;
        const t = bus.ctx.currentTime;
        const gp = out.gain;
        gp.cancelScheduledValues(t);
        gp.setValueAtTime(gp.value, t);
        gp.linearRampToValueAtTime(0, t + 0.035);
        for (const p of partials) { try { p.o.stop(t + 0.05); } catch { /* */ } }
        try { noise.stop(t + 0.05); } catch { /* */ }
        autoDisconnect(noise, all);
        if (amt > 0.12 && !bus.muted) bus._riserSnap(h.pos, clamp(amt, 0, 1) * h.level, 500 * Math.pow(2, 3 * amt));
      },
    };
    this._risers.add(h);
    h.set(0, worldPos);
    return h;
  }

  // The full-charge glint: a high inharmonic "ting" with a click on the front.
  _glint(pos, level) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(pos));
    const parts = [[2637, 0.05, 0.5], [3951, 0.03, 0.3], [5274, 0.016, 0.18]];
    parts.forEach(([hz, pk, dec], i) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz * rand(0.99, 1.01);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(pk * level, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, now + dec);
      o.connect(g).connect(spat);
      o.start(now); o.stop(now + dec + 0.02);
      autoDisconnect(o, i === 0 ? [o, g, spat, spat.output].filter(Boolean) : [o, g]);
    });
    this._pulse(0.2);
  }

  // The riser let go: a crack on the front and a whoosh falling from where the riser was.
  _riserSnap(pos, a, fromHz) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(pos));
    const dur = 0.12 + 0.2 * a;
    const sweep = this._noiseSource(dur + 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(fromHz, now);
    bp.frequency.exponentialRampToValueAtTime(220, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.16 * a, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0006, now + dur);
    sweep.connect(bp).connect(g).connect(spat);
    sweep.start(now, sweep._offset); sweep.stop(now + dur + 0.02);
    autoDisconnect(sweep, [sweep, bp, g, spat, spat.output].filter(Boolean));
    const crack = this._noiseSource(0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.14 * a, now + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0005, now + 0.035);
    crack.connect(hp).connect(cg).connect(spat);
    crack.start(now, crack._offset); crack.stop(now + 0.045);
    autoDisconnect(crack, [crack, hp, cg]);
  }

  /** Stop every live charge riser at once (mute, reset, teardown). */
  stopRisers() {
    for (const h of [...this._risers]) h.stop(0);
  }

  /**
   * The rhythm section's level 0..1 (stomp-clap and chant ride under it). Fades, never
   * steps: up over ~2 s, down over ~1.5 s.
   */
  setCrowdRhythm(level) {
    if (!this.rhythmGain || !this.ctx) return;
    const v = this.muted ? 0 : clamp(level, 0, 1);
    if (Math.abs(v - (this._rhythmLevel ?? -1)) < 0.01) return;
    const rising = v > (this._rhythmLevel ?? 0);
    this._rhythmLevel = v;
    const now = this.ctx.currentTime;
    const g = this.rhythmGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(v, now, rising ? 0.7 : 0.5);
  }

  /** The bleachers: a few hundred feet on wood, at audio time `at`, loosely together. */
  crowdStomp(at, amt = 1) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const ctx = this.ctx;
    for (let i = 0; i < 2; i++) {
      const t = at + rand(0, 0.03);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(rand(78, 96), t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.16 * amt, t + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0008, t + 0.2);
      o.connect(og).connect(this.rhythmGain);
      o.start(t); o.stop(t + 0.22);
      autoDisconnect(o, [o, og]);
      const n = this._noiseSource(0.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = rand(240, 320);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.linearRampToValueAtTime(0.32 * amt, t + 0.005);
      ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.15);
      n.connect(lp).connect(ng).connect(this.rhythmGain);
      n.start(t, n._offset); n.stop(t + 0.17);
      autoDisconnect(n, [n, lp, ng]);
    }
  }

  /** The hall's clap: thousands of hands, so a 30 ms smear of micro-bursts, not one click. */
  crowdClap(at, amt = 1) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const ctx = this.ctx;
    const src = this._noiseSource(0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1300, 1700);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    for (const [dt, k] of [[0, 1], [0.009, 0.85], [0.019, 0.75], [0.031, 0.55]]) {
      const t = at + dt + rand(0, 0.003);
      g.gain.setValueAtTime(1.9 * amt * k, t);
      g.gain.exponentialRampToValueAtTime(0.37 * amt * k, t + 0.008);
    }
    g.gain.exponentialRampToValueAtTime(0.0008, at + 0.2);
    src.connect(bp).connect(g).connect(this.rhythmGain);
    src.start(at, src._offset); src.stop(at + 0.22);
    autoDisconnect(src, [src, bp, g]);
  }

  /**
   * One syllable of the "U-S-A!" chant: `voices` detuned sawtooth throats (a mixed crowd,
   * 130-280 Hz, each a little late) through three vowel formants gliding through the
   * syllable — "you" /i/→/u/, "ess" /ɛ/ closing on an /s/ hiss, "ay" /e/→/i/. Synthesized,
   * not speechSynthesis, because speech can't be mixed, ducked or put in the room.
   */
  crowdChant(syl, at, amt = 1, voices = 6) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const v = CHANT_VOWELS[syl];
    if (!v) return;
    const ctx = this.ctx;
    const dur = v.dur;
    const vowelEnd = v.sib ? at + dur * 0.5 : at + dur;
    const sum = ctx.createGain();
    sum.gain.value = 1 / Math.sqrt(voices);
    const env = ctx.createGain();
    env.connect(this.rhythmGain);
    const nodes = [sum, env];
    v.f.forEach(([from, to], i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = [5, 8, 10][i];
      bp.frequency.setValueAtTime(from, at);
      bp.frequency.linearRampToValueAtTime(to, at + (vowelEnd - at) * 0.85);
      const fg = ctx.createGain();
      fg.gain.value = [1, 0.6, 0.3][i];
      sum.connect(bp).connect(fg).connect(env);
      nodes.push(bp, fg);
    });
    const peak = 0.6 * amt;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.05);
    env.gain.setValueAtTime(peak, Math.max(at + 0.05, vowelEnd - 0.06));
    env.gain.exponentialRampToValueAtTime(0.0008, vowelEnd + 0.08);
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(130, 280);
      const t0 = at + rand(0, 0.05);
      o.frequency.setValueAtTime(f0 * 0.92, t0);
      o.frequency.linearRampToValueAtTime(f0, t0 + 0.06);
      o.frequency.linearRampToValueAtTime(f0 * 0.88, vowelEnd + 0.08);
      o.detune.value = rand(-25, 25);
      o.connect(sum);
      o.start(t0); o.stop(vowelEnd + 0.1);
      autoDisconnect(o, [o]);
    }
    const end = vowelEnd + 0.12;
    if (v.sib) {
      // The /s/: the whole hall hissing through its teeth, slightly ragged at the front.
      const s = this._noiseSource(dur * 0.6 + 0.1);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3600;
      const sg = ctx.createGain();
      const s0 = at + dur * 0.42;
      sg.gain.setValueAtTime(0.0001, s0);
      sg.gain.linearRampToValueAtTime(0.9 * amt, s0 + 0.04);
      sg.gain.setValueAtTime(0.9 * amt, at + dur - 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0008, at + dur + 0.07);
      s.connect(hp).connect(sg).connect(this.rhythmGain);
      s.start(s0, s._offset); s.stop(at + dur + 0.09);
      autoDisconnect(s, [s, hp, sg]);
    }
    const k = ctx.createConstantSource();
    k.start(at); k.stop(end);
    autoDisconnect(k, [k, ...nodes]);
  }

  /**
   * A convention balloon popping at world-x `worldX`, size `size` (1 = a party balloon;
   * bigger is lower and louder): the skin's crack, the air's "thup", and a rubbery squeak
   * of the torn skin snapping back. A drop pops dozens at once, so past MAX_POPS live
   * voices a pop is dropped rather than stacking nodes.
   */
  balloonPop(worldX = 0, size = 1) {
    if (!this._ensure() || this.muted || this._popVoices >= MAX_POPS) return;
    this._popVoices++;
    const ctx = this.ctx;
    const s = clamp(size, 0.4, 2.5);
    const sq = Math.sqrt(s);
    const now = ctx.currentTime + rand(0, 0.008);
    const spat = this._connectSpat(this._spatializer({ x: worldX, y: 4, z: 0 }));
    // 1. The crack.
    const crack = this._noiseSource(0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400 / sq;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.32 * Math.min(1.4, s), now + 0.0015);
    cg.gain.exponentialRampToValueAtTime(0.0006, now + 0.03 + 0.02 * s);
    crack.connect(hp).connect(cg).connect(spat);
    crack.start(now, crack._offset); crack.stop(now + 0.07);
    autoDisconnect(crack, [crack, hp, cg]);
    // 2. The air going: a low thup.
    const thup = ctx.createOscillator();
    thup.frequency.setValueAtTime(300 / sq * rand(0.9, 1.1), now);
    thup.frequency.exponentialRampToValueAtTime(90, now + 0.05);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.16 * Math.min(1.6, s), now + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0006, now + 0.08);
    thup.connect(tg).connect(spat);
    thup.start(now); thup.stop(now + 0.09);
    autoDisconnect(thup, [thup, tg]);
    // 3. The squeak: the rubber snapping back, a quick up-down-up wobble.
    const f = rand(900, 1300) / sq;
    const t0 = now + 0.012;
    const sqk = ctx.createOscillator();
    sqk.type = 'triangle';
    sqk.frequency.setValueAtTime(f, t0);
    sqk.frequency.linearRampToValueAtTime(f * 1.25, t0 + 0.028);
    sqk.frequency.linearRampToValueAtTime(f * 0.8, t0 + 0.068);
    sqk.frequency.linearRampToValueAtTime(f * 1.1, t0 + 0.1);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.linearRampToValueAtTime(0.03, t0 + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.13);
    sqk.connect(sg).connect(spat);
    sqk.start(t0); sqk.stop(t0 + 0.14);
    // The last layer out tears the spatializer down and frees the voice.
    autoDisconnect(sqk, [sqk, sg, spat, spat.output].filter(Boolean), () => { this._popVoices--; });
  }

  close() {
    this.stopMusic();
    this.stopIntroTheme();
    this.stopCrowd();
    this.stopRisers();
    this._grid = null;
    // The listener belongs to the shared app context: hand it back at the origin.
    if (this._listenerMode) {
      this.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0);
      this._listenerMode = null;
    }
    // The slap-back's feedback loop would otherwise idle on the shared context forever.
    if (this._echoNodes) {
      for (const n of this._echoNodes.all) { try { n.disconnect(); } catch { /* */ } }
      this._echoNodes = null;
    }
    if (this.ctx) {
      // Never close the shared app context (js/audioBus.js); only a private fallback.
      if (this._ownsCtx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(() => { /* already closing */ });
      } else {
        // Detach our chain from the shared bus.
        try { this.master?.disconnect(); } catch { /* already disconnected */ }
      }
      this.ctx = null;
    }
    this.master = this.sfxGain = this.musicGain = this.reverbGain = this.introGain = null;
    this.sfxFilter = this.musicDuck = this.musicLP = this.crowdGain = this.crowdDuck = null;
    this.stingGain = this.rhythmGain = this.crowdPersp = null;
    this.perspEq = this.perspHc = this.perspSend = this._convolver = null;
    this.out = null;
    this.noiseBuf = null;
  }
}

export const AudioShowtime = AudioShowtimeMethods.prototype;
