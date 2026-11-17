// audio.js — synthesized SFX for PoVoxelStrike.
// No audio files: everything is OscillatorNode + filtered noise, following the
// pobrawl/audio.js recipe. All output rides the platform's shared AudioContext and
// mix graph (js/platform/audioBus.js) through window.PoAudioBus on the 'sfx' bus, so global
// mute/volume/ducking apply for free.
//
// There is no music in here: background music is off app-wide.
//
// Every public method is throttle-guarded and mute-safe, so the engine can call them
// from hot paths (collapse spawns, debris collide events) without its own bookkeeping.
//
// Two layers of spatial sound:
//   * True 3D positional audio. Every cue takes a world position (or a stereo pan scalar
//     on the low tier) and routes through an HRTF PannerNode, so a brute behind you is
//     behind you and a tower collapsing overhead is overhead. setListener() feeds the
//     camera transform to the AudioContext listener once per frame.
//   * Convolution reverb zones. Two procedurally-generated impulse responses (open field,
//     stone interior) run in parallel on a send from the SFX bus; setSpace() crossfades
//     between them, so stepping through a castle gate audibly changes the room.
// Both are tier-gated by quality.js -- a low-end machine keeps the stereo path, which
// is why _pan() still accepts a plain number.
//
// The acoustics pass layered the world's geometry on top (an AcousticProbe, handed in
// with setWorld(), answers the ray questions; this file never touches voxels):
//   * Propagation. A positional cue reaches the panner through a delay of d / 343 m/s
//     (capped) and an air-absorption lowpass that darkens with distance, so a far
//     detonation flashes first and arrives as a dull boom.
//   * Occlusion. One listener→source ray per cue (budgeted per frame, cached by grid
//     cell) muffles and quiets whatever is behind a wall or over a hill.
//   * Early reflections. Six world-fixed probe rays every 250 ms set six delay taps,
//     each placed by a panner where its ray hit: a gatehouse slaps back, a meadow does not.
//   * Modal impacts. Rubble rings at its material's resonant modes (damped sinusoids),
//     pitched by mass and struck by impact speed; shrapnel landing ticks the same way.
//   * Ambience. A wind bed shaped by altitude, open sky and weather, and a tinnitus whine
//     that rides on top of the concussion muffle.

const NOISE_SECONDS = 2;
const SPEED_OF_SOUND = 343;
// The arena is 180 m across; a full half-second wait for a far blast reads as lag, not
// physics. 0.32 s keeps the flash-then-boom without feeling broken.
const MAX_SOUND_DELAY_S = 0.32;
const OCCLUSION_TTL_S = 0.3;
const RAYS_PER_FRAME = 3;
const PROBE_INTERVAL_S = 0.25;
const WEATHER_WIND = { clear: 1, fog: 0.6, rain: 1.5, storm: 2.3 };

// Resonant modes per material: frequency ratios over a base, each mode's decay (s) and
// relative amplitude. Stone is inharmonic and short; slate rings like a struck plate;
// terracotta is hollow and close-spaced; wood is a dull knock; soil barely rings at all.
const MODES = {
  stone: { base: 620, ratios: [1, 2.32, 4.25, 6.63], decay: [0.16, 0.1, 0.06, 0.04], amp: [1, 0.6, 0.35, 0.2], noise: 2600 },
  slate: { base: 980, ratios: [1, 2.76, 5.4, 8.93], decay: [0.32, 0.2, 0.12, 0.07], amp: [1, 0.7, 0.45, 0.25], noise: 4200 },
  terracotta: { base: 720, ratios: [1, 1.59, 2.13, 3.3], decay: [0.11, 0.08, 0.06, 0.04], amp: [1, 0.8, 0.5, 0.3], noise: 1800 },
  brick: { base: 520, ratios: [1, 2.1, 3.7], decay: [0.09, 0.06, 0.04], amp: [1, 0.5, 0.3], noise: 1500 },
  plaster: { base: 380, ratios: [1, 2.4, 4.1], decay: [0.05, 0.035, 0.025], amp: [1, 0.4, 0.2], noise: 1100 },
  wood: { base: 300, ratios: [1, 2.9, 5.2, 8.1], decay: [0.12, 0.07, 0.045, 0.03], amp: [1, 0.5, 0.3, 0.15], noise: 900 },
  dirt: { base: 140, ratios: [1, 1.7], decay: [0.05, 0.03], amp: [1, 0.4], noise: 500 },
};

/**
 * Which mode table a physics material record rings with. physics.js collapses every
 * masonry preset to kind 'stone' for contact friction, so density tells them apart.
 */
export function modalKind(material) {
  if (!material) return 'stone';
  if (material.kind === 'wood') return 'wood';
  if (material.kind === 'dirt') return 'dirt';
  const d = material.density ?? 2400;
  if (d >= 2600) return 'slate';
  if (d >= 1950 && d < 2150) return 'terracotta';
  if (d >= 1800 && d < 1950) return 'brick';
  if (d < 1500) return 'plaster';
  return 'stone';
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.18 * white) / 1.18; // low-passed: "rubble", not hiss
    data[i] = last;
  }
  return buf;
}

/**
 * Procedural impulse response: exponentially-decaying noise run through a one-pole
 * lowpass whose coefficient sets how dark the tail is. Cheap, deterministic in shape, and
 * no IR file to ship - which matters because this game deliberately loads no audio
 * assets at all. `decay` is seconds, `curve` how fast the tail falls, `dark` is 0..1 tone.
 */
function makeImpulse(ctx, decay, curve, dark) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const a = Math.max(0.001, 1 - dark); // one-pole coefficient: smaller = darker
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      last = last * (1 - a) + (Math.random() * 2 - 1) * a;
      d[i] = last * Math.pow(1 - t, curve);
    }
  }
  return buf;
}

// Release the node chain once the source ends — a long firefight otherwise piles up
// hundreds of live nodes on the audio thread (same leak pobrawl fixed).
function autoDisconnect(source, nodes) {
  source.onended = () => {
    for (const n of nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  };
}

export class VoxelAudio {
  constructor() {
    this.ctx = null;
    this._failed = false;
    this.master = null;
    this.sfx = null;
    this.filter = null;   // concussion lowpass, in-line on the whole SFX path
    this.noise = null;
    this._paused = false;
    this.spatial = true;      // cleared by setQuality() on the low tier
    this.reverbZones = true;
    this._space = 0;          // 0 = open field, 1 = stone interior
    // Where the SFX lowpass rests: wide open, or pulled in while the player is nearly dead.
    this._openCorner = 20000;
    this.rain = null;         // { src, gain, tone } once setRain() has built the bed
    // Acoustics pass (see header). Flags are set by setQuality(); the probe by setWorld().
    this.occlusion = false;
    this.earlyReflections = false;
    this.rubble = false;
    this.probe = null;
    this._lp = null;          // listener position {x,y,z}, copied each setListener()
    this._occCache = new Map();
    this._rayBudget = 0;
    this._nextProbe = 0;
    this.erTaps = null;
    this.wind = null;
    this._weather = 'clear';
    this._voices = { impact: 0, tick: 0 };
    this._voiceCap = { impact: 8, tick: 10 };
    // Per-category throttles (seconds of ctx.currentTime).
    this._next = { collapse: 0, impact: 0, cue: 0, crush: 0, turret: 0, whiz: 0, step: 0, tick: 0, creak: 0 };
  }

  _ensure() {
    if (this.ctx) return !this._failed;
    if (this._failed) return false;
    try {
      // The shared bus or silence: a private AudioContext would ignore the app's mute and volume.
      const bus = window.PoAudioBus;
      const ctx = bus?.contextSync?.();
      if (!ctx || !bus.busSync('sfx')) return false;  // not up yet (or no Web Audio): retry on the next call
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp).connect(bus.busSync('sfx'));

      // 20 kHz open corner (transparent), swept down by concussion().
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 20000;
      this.filter.Q.value = 0.0001;
      this.filter.connect(this.master);

      this.sfx = ctx.createGain();
      this.sfx.gain.value = 1.0;
      this.sfx.connect(this.filter);

      this.noise = makeNoiseBuffer(ctx);

      // Reverb zones. The platform bus reverb is turned OFF here rather than layered
      // under these: it is one global tail with no notion of where the player is
      // standing, and running both smears each other. This graph owns the space.
      //   sfx --+--------------------------------> filter (dry)
      //         +-- send --+-- convolver(open)  --> wetOpen  --+
      //                    +-- convolver(stone) --> wetStone --+--> filter
      bus?.setReverb?.(0.0);
      if (this.reverbZones && ctx.createConvolver) {
        this.revSend = ctx.createGain();
        this.revSend.gain.value = 1;
        this.sfx.connect(this.revSend);

        this.convOpen = ctx.createConvolver();
        this.convOpen.buffer = makeImpulse(ctx, 0.55, 5.2, 0.35);   // short, bright slap
        this.wetOpen = ctx.createGain();
        this.wetOpen.gain.value = 0.16;
        this.revSend.connect(this.convOpen).connect(this.wetOpen).connect(this.filter);

        this.convStone = ctx.createConvolver();
        this.convStone.buffer = makeImpulse(ctx, 2.3, 1.6, 0.75);   // long, dark stone tail
        this.wetStone = ctx.createGain();
        this.wetStone.gain.value = 0;
        this.revSend.connect(this.convStone).connect(this.wetStone).connect(this.filter);
      }
      if (this.earlyReflections && ctx.createPanner) this._buildReflections();
      return true;
    } catch (e) {
      this._failed = true;
      try { console.error('[povoxelstrike/audio] setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  _muted() {
    const bus = window.PoAudioBus;
    return !!(bus && bus.isMuted && bus.isMuted());
  }

  _ready() { return this._ensure() && !this._muted(); }

  _gate(kind, interval) {
    const now = this.ctx.currentTime;
    if (now < this._next[kind]) return false;
    this._next[kind] = now + interval;
    return true;
  }

  /**
   * Destination node for one cue, already wired into the SFX chain.
   * @param where a world position ({x,y,z}) for HRTF 3D placement, or a -1..1 stereo pan
   *   scalar for the fallback path. A number always gets stereo, so the low tier and any
   *   caller that only knows a pan keep working unchanged.
   */
  _pan(where) {
    if (this.spatial && where && typeof where === 'object' && this.ctx.createPanner) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      // refDistance is deliberately large: the arena is 180 units across, and a realistic
      // 1-unit reference makes everything past the courtyard inaudible.
      p.refDistance = 8;
      p.maxDistance = 220;
      p.rolloffFactor = 0.9;
      if (p.positionX) {
        p.positionX.value = where.x; p.positionY.value = where.y; p.positionZ.value = where.z;
      } else {
        p.setPosition(where.x, where.y, where.z); // Safari < 16
      }
      p.connect(this.sfx);
      return this._propagate(p, where);
    }
    const pan = typeof where === 'number' ? where : 0;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1) * 0.8; // never hard-panned into one ear
      p.connect(this.sfx);
      return p;
    }
    const g = this.ctx.createGain();
    g.connect(this.sfx);
    return g;
  }

  /** Apply the resolved GFX/SFX tier. Call before the first cue. */
  setQuality(quality) {
    this.spatial = !!quality.spatialAudio;
    this.reverbZones = !!quality.convolutionReverb;
    this.occlusion = !!quality.audioOcclusion;
    this.earlyReflections = !!quality.earlyReflections;
    this.rubble = !!quality.rubbleTicks;
    // The low tier still rings, just with fewer simultaneous voices.
    this._voiceCap.impact = quality.tier === 'low' ? 3 : 8;
  }

  /** The geometry the acoustics ask about (an AcousticProbe). Null disables the ray work. */
  setWorld(probe) {
    this.probe = probe ?? null;
    this._occCache.clear();
  }

  /** Weather kind ('clear' | 'rain' | 'fog' | 'storm'): scales the wind bed. */
  setWeather(kind) {
    this._weather = WEATHER_WIND[kind] !== undefined ? kind : 'clear';
  }

  /**
   * Route a panner through propagation: speed-of-sound delay, air absorption and
   * occlusion, in that order upstream of it. Returns the node callers connect into.
   * The extra nodes are released on a timer — every cue here is under 2.5 s.
   */
  _propagate(panner, where) {
    const lp = this._lp;
    if (!lp) return panner;
    const dx = where.x - lp.x, dy = where.y - lp.y, dz = where.z - lp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const occ = this._occlusionAt(where, d);
    // Air eats the top end first: ~8 kHz left at 60 m, under 2 kHz across the arena.
    const air = clamp(20000 * Math.exp(-d / 70), 1800, 20000);
    // Full occlusion closes the corner to ~700 Hz: through a wall you hear the thump only.
    const corner = occ > 0 ? Math.min(air, 20000 * Math.pow(0.035, occ)) : air;
    const chain = [panner];
    let head = panner;
    if (corner < 19000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = corner;
      f.Q.value = 0.5;
      f.connect(head); head = f; chain.push(f);
    }
    if (occ > 0) {
      const g = this.ctx.createGain();
      g.gain.value = 1 - 0.55 * occ;
      g.connect(head); head = g; chain.push(g);
    }
    const delay = Math.min(MAX_SOUND_DELAY_S, d / SPEED_OF_SOUND);
    if (delay > 0.012 && this.ctx.createDelay) {
      const dl = this.ctx.createDelay(0.5);
      dl.delayTime.value = delay;
      dl.connect(head); head = dl; chain.push(dl);
    }
    setTimeout(() => {
      for (const n of chain) { try { n.disconnect(); } catch { /* already gone */ } }
    }, 4000);
    return head;
  }

  /** Cached, budgeted listener→source occlusion (0..1). Over budget and uncached = clear. */
  _occlusionAt(where, d) {
    if (!this.occlusion || !this.probe || d < 2) return 0;
    const key = `${Math.round(where.x / 2)}|${Math.round(where.y / 2)}|${Math.round(where.z / 2)}`;
    const now = this.ctx.currentTime;
    const hit = this._occCache.get(key);
    if (hit && now - hit.t < OCCLUSION_TTL_S) return hit.v;
    if (this._rayBudget <= 0) return hit ? hit.v : 0;
    this._rayBudget--;
    let v = 0;
    try { v = clamp(this.probe.occlusion(this._lp, where), 0, 1); } catch { v = 0; }
    if (this._occCache.size > 96) this._occCache.clear();
    this._occCache.set(key, { v, t: now });
    return v;
  }

  // ── Early reflections (#14) ────────────────────────────────────────────

  /** Six taps off the dry SFX: delay → tone → gain → panner (placed at the wall). */
  _buildReflections() {
    const ctx = this.ctx;
    this.erIn = ctx.createGain();
    this.erIn.gain.value = 1;
    this.sfx.connect(this.erIn);
    this.erTaps = [];
    for (let i = 0; i < 6; i++) {
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.05;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 3500;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createPanner();
      // The tap gain does the distance law; the panner only places it.
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'linear';
      pan.rolloffFactor = 0;
      this.erIn.connect(delay).connect(tone).connect(gain).connect(pan).connect(this.filter);
      this.erTaps.push({ delay, tone, gain, pan });
    }
  }

  _updateReflections(now) {
    if (!this.erTaps || !this.probe || !this._lp) return;
    let refl;
    try { refl = this.probe.reflections(this._lp); } catch { return; }
    for (let i = 0; i < this.erTaps.length; i++) {
      const tap = this.erTaps[i], r = refl[i];
      if (!r || r.d < 0) { tap.gain.gain.setTargetAtTime(0, now, 0.1); continue; }
      // Round trip, and the echo comes back quieter and darker the further it travelled.
      tap.delay.delayTime.setTargetAtTime(Math.min(0.45, (2 * r.d) / SPEED_OF_SOUND), now, 0.12);
      tap.gain.gain.setTargetAtTime(0.2 / (1 + r.d / 5), now, 0.1);
      tap.tone.frequency.setTargetAtTime(5000 / (1 + r.d / 15), now, 0.1);
      const p = tap.pan;
      if (p.positionX) {
        p.positionX.setTargetAtTime(r.x, now, 0.1);
        p.positionY.setTargetAtTime(r.y, now, 0.1);
        p.positionZ.setTargetAtTime(r.z, now, 0.1);
      } else {
        p.setPosition(r.x, r.y, r.z);
      }
    }
  }

  // ── Wind bed (#18) ─────────────────────────────────────────────────────

  _buildWind() {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // Body: a broad band whose centre drifts with a slow LFO — the gusting.
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // Whistle: a narrow resonance high up, only heard on the walls and in the open.
    const whistleBand = ctx.createBiquadFilter();
    whistleBand.type = 'bandpass';
    whistleBand.frequency.value = 1300;
    whistleBand.Q.value = 9;
    const whistle = ctx.createGain();
    whistle.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 160;
    lfo.connect(lfoDepth).connect(band.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.07;
    const lfo2Depth = ctx.createGain();
    lfo2Depth.gain.value = 260;
    lfo2.connect(lfo2Depth).connect(whistleBand.frequency);
    src.connect(band).connect(gain).connect(this.filter);
    src.connect(whistleBand).connect(whistle).connect(this.filter);
    src.start(); lfo.start(); lfo2.start();
    this.wind = { src, band, gain, whistleBand, whistle, lfo, lfoDepth, lfo2, lfo2Depth };
  }

  _updateWind(now) {
    if (!this._lp) return;
    let alt = this._lp.y;
    if (this.probe) { try { alt = this.probe.altitude(this._lp); } catch { /* keep y */ } }
    const a = clamp(alt / 25, 0, 1);
    const open = 1 - this._space;
    const w = WEATHER_WIND[this._weather] ?? 1;
    const quiet = this._paused || this._muted();
    const level = quiet ? 0 : (0.008 + 0.03 * a) * (0.25 + 0.75 * open) * w;
    const whistle = quiet ? 0 : 0.012 * a * open * w;
    if (!this.wind) {
      if (level <= 0) return;
      this._buildWind();
    }
    this.wind.gain.gain.setTargetAtTime(level, now, 0.6);
    this.wind.whistle.gain.setTargetAtTime(whistle, now, 0.6);
    this.wind.band.frequency.setTargetAtTime(380 + 260 * a * w, now, 0.8);
  }

  /**
   * Move the AudioContext listener onto the camera. Call once per frame - a listener left
   * at the origin makes HRTF place every sound relative to the arena centre, which is
   * worse than no HRTF at all. Also the acoustics clock: it refills the occlusion ray
   * budget and, every 250 ms, re-probes the reflections and re-levels the wind.
   */
  setListener(camera) {
    if (!this._ready()) return;
    const p = camera.position;
    this._lp = { x: p.x, y: p.y, z: p.z };
    this._rayBudget = RAYS_PER_FRAME;
    const now = this.ctx.currentTime;
    if (now >= this._nextProbe) {
      this._nextProbe = now + PROBE_INTERVAL_S;
      this._updateReflections(now);
      this._updateWind(now);
    }
    if (!this.spatial) return;
    const l = this.ctx.listener;
    const m = camera.matrixWorld.elements;
    const fx = -m[8], fy = -m[9], fz = -m[10];   // -Z column: the camera forward axis
    const ux = m[4], uy = m[5], uz = m[6];
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Crossfade the reverb between open field (0) and stone interior (1). Smoothed over
   * 250 ms: an instant swap at a doorway clicks, and the player straddles the threshold
   * for several frames while walking through it.
   */
  setSpace(indoorness) {
    if (!this._ready() || !this.wetOpen) return;
    const t = clamp(indoorness, 0, 1);
    if (Math.abs(t - this._space) < 0.02) return;
    this._space = t;
    const now = this.ctx.currentTime, ramp = now + 0.25;
    for (const g of [this.wetOpen.gain, this.wetStone.gain]) {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
    }
    this.wetOpen.gain.linearRampToValueAtTime(0.16 * (1 - t), ramp);
    this.wetStone.gain.linearRampToValueAtTime(0.42 * t, ramp);
  }

  _noiseSrc(playSeconds) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src._offset = Math.random() * Math.max(0, this.noise.duration - playSeconds - 0.01);
    return src;
  }

  /** One enveloped oscillator into `dest`. Returns nothing; cleans itself up. */
  _tone(dest, { type = 'sine', from, to = null, dur, gain, attack = 0.005, delay = 0 }) {
    const ctx = this.ctx, now = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, now);
    if (to !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + dur * 0.85);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(g).connect(dest);
    o.start(now); o.stop(now + dur + 0.03);
    autoDisconnect(o, [o, g]);
  }

  /** Enveloped filtered-noise burst into `dest`. */
  _burst(dest, { filterType = 'bandpass', freq, sweepTo = null, q = 1, dur, gain, attack = 0.006, delay = 0 }) {
    const ctx = this.ctx, now = ctx.currentTime + delay;
    const src = this._noiseSrc(dur);
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, now);
    if (sweepTo !== null) f.frequency.linearRampToValueAtTime(sweepTo, now + dur * 0.8);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, f, g]);
  }

  // ── Weapon ─────────────────────────────────────────────────────────────

  /** Primary carve shot: short zap + dig click. Fires ~7/s, so it stays tiny. */
  shot() {
    if (!this._ready()) return;
    this._tone(this.sfx, { type: 'square', from: rand(1100, 1500), to: 320, dur: 0.07, gain: 0.035 });
    this._burst(this.sfx, { freq: rand(2600, 3600), q: 1.2, dur: 0.05, gain: 0.03 });
  }

  /** Alt-fire launch: rising whoosh as the blast ball leaves. */
  altLaunch() {
    if (!this._ready()) return;
    this._burst(this.sfx, { freq: 420, sweepTo: 1500, q: 1.4, dur: 0.3, gain: 0.09 });
  }

  /**
   * Alt-fire detonation. WebAudio has no true sidechain, so the bus duck IS the
   * sidechain; its depth now tracks proximity, and a blast across the arena no longer
   * flattens the score as hard as one at your feet.
   */
  explosion(where = 0, proximity = 1) {
    if (!this._ready()) return;
    const dest = this._pan(where);
    this._tone(dest, { from: rand(110, 135), to: 30, dur: 0.75, gain: 0.5, attack: 0.008 });
    this._burst(dest, { filterType: 'lowpass', freq: 950, dur: 0.6, gain: 0.4 });
    this._burst(dest, { filterType: 'highpass', freq: 3000, dur: 0.35, gain: 0.08 });
    const p = clamp(proximity, 0, 1);
    window.PoAudioBus?.duck?.(0.25 + 0.35 * p, 250 + 350 * p);
  }

  /** Weapon overheated: a steam vent while it cools. */
  lockout() {
    if (!this._ready()) return;
    this._burst(this.sfx, { filterType: 'highpass', freq: 1900, dur: 0.7, gain: 0.09, attack: 0.02 });
  }

  // ── The fortress ───────────────────────────────────────────────────────

  /**
   * A wall gun firing. It used to borrow shot() — the player's own zap, unpositioned — so
   * the fortress sounded like you. This is a heavier report, and it comes from the gun.
   */
  turretShot(where) {
    if (!this._ready() || !this._gate('turret', 0.05)) return;
    const dest = this._pan(where);
    this._tone(dest, { type: 'square', from: rand(200, 240), to: 62, dur: 0.14, gain: 0.2 });
    this._burst(dest, { filterType: 'highpass', freq: 1700, dur: 0.08, gain: 0.12 });
  }

  /**
   * A bolt passing close: the falling whistle of a near miss. With the bolt's velocity
   * the tonal shriek carries a true Doppler shift — c/(c−v) on approach dropping to
   * c/(c+v) as it leaves — instead of a fixed sweep.
   */
  whiz(where, velocity = null) {
    if (!this._ready() || !this._gate('whiz', 0.12)) return;
    const dest = this._pan(where);
    this._burst(dest, { freq: 2600, sweepTo: 650, q: 2.4, dur: 0.2, gain: 0.16 });
    if (velocity) {
      const v = Math.min(SPEED_OF_SOUND * 0.6,
        Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z));
      const toward = SPEED_OF_SOUND / (SPEED_OF_SOUND - v);
      const away = SPEED_OF_SOUND / (SPEED_OF_SOUND + v);
      const f = rand(1700, 2100);
      this._tone(dest, { type: 'triangle', from: f * toward, to: f * away, dur: 0.24, gain: 0.045, attack: 0.004 });
    }
  }

  /** The chalice is taken: a rising triad that lands on an open fifth. */
  fanfare() {
    if (!this._ready()) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this._tone(this.sfx, {
      type: 'triangle', from: f, dur: 0.5, gain: 0.2, attack: 0.012, delay: i * 0.14,
    }));
    for (const f of [523.25, 783.99, 1046.5, 1567.98]) {
      this._tone(this.sfx, { type: 'triangle', from: f, dur: 1.9, gain: 0.13, attack: 0.03, delay: 0.62 });
    }
    this._burst(this.sfx, { filterType: 'highpass', freq: 5200, dur: 1.4, gain: 0.035, attack: 0.2, delay: 0.62 });
  }

  // ── Destruction ────────────────────────────────────────────────────────

  /**
   * Masonry or timber under load just before it lets go: a low stress groan plus sharp
   * micro-crack ticks at the fracture point. Throttled so a long crack front does not stack.
   */
  creak(where = 0, intensity = 0.6) {
    if (!this._ready() || !this._gate('creak', 0.22)) return;
    const s = clamp(intensity, 0.15, 1);
    const dest = this._pan(where);
    this._tone(dest, {
      type: 'sawtooth', from: rand(95, 125), to: rand(52, 68),
      dur: 0.28 + 0.18 * s, gain: 0.08 * s, attack: 0.025,
    });
    this._burst(dest, { freq: rand(2200, 3200), q: 3.5, dur: 0.035, gain: 0.09 * s, attack: 0.002 });
    this._burst(dest, {
      freq: rand(1600, 2500), q: 2.8, dur: 0.04, gain: 0.07 * s,
      attack: 0.002, delay: 0.06 + rand(0, 0.05),
    });
  }

  /** The floor dropping out of the mix under a really big fall. */
  subDrop(where, strength = 1) {
    if (!this._ready()) return;
    const s = clamp(strength, 0.2, 1);
    this._tone(this._pan(where), { from: 88, to: 24, dur: 0.9 + 0.5 * s, gain: 0.5 * s, attack: 0.02 });
  }

  /**
   * A cluster detached from a structure. Gain and length scale with voxel count so a
   * cornice tick is a pebble and a tower fall is a landslide. Throttled: a cascade of
   * clusters in one carve merges into one rumble.
   */
  collapse(voxels, pan = 0) {
    if (!this._ready() || !this._gate('collapse', 0.14)) return;
    const s = clamp(voxels / 350, 0.12, 1);
    const dest = this._pan(pan);
    this._burst(dest, {
      filterType: 'lowpass', freq: 260 + 140 * s, dur: 0.4 + 1.0 * s,
      gain: 0.1 + 0.42 * s, attack: 0.02,
    });
    this._tone(dest, { from: 60, to: 32, dur: 0.35 + 0.6 * s, gain: 0.1 + 0.3 * s, attack: 0.015 });
    if (s > 0.35 && window.PoDsp?.playGranular) {
      window.PoDsp.playGranular(1400, Math.round(8 * s), 0.35 * s, 0.25 * s, 'sfx');
    }
    // A tower coming down deserves the room in the mix an explosion gets.
    if (s > 0.55) window.PoAudioBus?.duck?.(0.3 * s, 500 * s);
  }

  /**
   * Modal synthesis: a sum of exponentially damped sinusoids at the material's resonant
   * modes, plus a few milliseconds of band-limited noise for the strike itself. `pitch`
   * scales every mode (small pieces ring high); bigger pieces also ring longer.
   * Voice-capped per `pool` so a rockslide cannot stack hundreds of oscillators.
   */
  _modal(dest, kind, pitch, gain, pool, maxModes = 4) {
    if (this._voices[pool] >= this._voiceCap[pool]) return false;
    const m = MODES[kind] ?? MODES.stone;
    const ctx = this.ctx, now = ctx.currentTime;
    const ring = clamp(1 / pitch, 0.6, 2.2);
    let longest = 0;
    let first = null;
    const nodes = [];
    for (let i = 0; i < m.ratios.length && i < maxModes; i++) {
      const f = m.base * m.ratios[i] * pitch * (1 + rand(-0.012, 0.012));
      if (f > 16000 || f < 25) continue;
      const dur = m.decay[i] * ring;
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(gain * m.amp[i], now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, now + dur);
      o.connect(g).connect(dest);
      o.start(now); o.stop(now + dur + 0.02);
      nodes.push(o, g);
      if (dur > longest) { longest = dur; first = o; }
    }
    if (!first) return false;
    this._voices[pool]++;
    first.onended = () => {
      this._voices[pool] = Math.max(0, this._voices[pool] - 1);
      for (const n of nodes) { try { n.disconnect(); } catch { /* */ } }
    };
    this._burst(dest, { freq: m.noise * Math.sqrt(pitch), q: 1.4, dur: 0.025, gain: gain * 0.6, attack: 0.001 });
    return true;
  }

  /**
   * A debris chunk landed hard. Throttled — a rockslide is not 40 thuds.
   * @param where world position (or a pan scalar)
   * @param speed impact speed along the contact normal, m/s — how hard it is struck
   * @param material the piece's physics material record — what it rings like
   */
  debrisHit(mass, where = 0, speed = 8, material = null) {
    if (!this._ready() || !this._gate('impact', 0.06)) return;
    // Recalibrated for real masses (physics.js): a chunk that used to report 7 kg now
    // reports 750, so the old /300 saturated on every single impact.
    const s = clamp(mass / 2500, 0.12, 1);
    const v = clamp((speed - 3) / 12, 0.15, 1);
    const dest = this._pan(where);
    // Size → pitch on a fifth-root curve: a 10 kg shard pings ~2× higher than a 300 kg
    // block, and a tonne-scale wall section sits well under it.
    const pitch = clamp(Math.pow(300 / Math.max(0.05, mass), 0.2), 0.3, 3);
    this._modal(dest, modalKind(material), pitch, 0.05 + 0.13 * v, 'impact');
    // The heavy body under the ring: only for real masonry.
    if (s > 0.25) this._tone(dest, { from: rand(80, 105), to: 42, dur: 0.16 + 0.1 * s, gain: (0.06 + 0.18 * s) * v });
    if (s > 0.4 && window.PoDsp?.playGranular) {
      window.PoDsp.playGranular(2200, 4, 0.15, 0.18 * s, 'sfx');
    }
  }

  /**
   * One voxel of shrapnel landing: a tiny positioned modal tick. Called from every
   * shrapnel contact; gated, voice-capped and distance-culled here, so after a blast the
   * rubble audibly rains down all round you without flooding the audio thread.
   */
  rubbleTick(where, speed = 4, size = 0.25, material = null) {
    if (!this.rubble || speed < 1.5 || !this._ready()) return;
    if (this._lp && where && typeof where === 'object') {
      const dx = where.x - this._lp.x, dy = where.y - this._lp.y, dz = where.z - this._lp.z;
      if (dx * dx + dy * dy + dz * dz > 45 * 45) return;
    }
    if (this._voices.tick >= this._voiceCap.tick || !this._gate('tick', 0.03)) return;
    const v = clamp((speed - 1.5) / 8, 0.1, 1);
    const pitch = clamp(0.25 / Math.max(0.05, size), 0.8, 3) * 1.8;
    this._modal(this._pan(where), modalKind(material), pitch, 0.035 * v, 'tick', 2);
  }

  /** Something got crushed under debris. */
  crush(pan = 0) {
    if (!this._ready() || !this._gate('crush', 0.15)) return;
    const dest = this._pan(pan);
    this._tone(dest, { from: 70, to: 34, dur: 0.3, gain: 0.32 });
    this._burst(dest, { freq: rand(1400, 2000), q: 1.5, dur: 0.09, gain: 0.14 });
  }

  // ── Enemies ────────────────────────────────────────────────────────────

  /** Ambient presence cue, panned/attenuated by the caller. Throttled globally. */
  enemyCue(type, pan = 0, gain = 1) {
    if (!this._ready() || gain < 0.05 || !this._gate('cue', 0.28)) return;
    const dest = this._pan(pan);
    if (type === 'swarmer') {
      // Chitter: three fast detuned blips.
      const base = rand(850, 1250);
      const now = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base * (1 + i * 0.12) * rand(0.95, 1.05);
        const g = this.ctx.createGain();
        const t0 = now + i * 0.055;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.02 * gain, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
        o.connect(g).connect(dest);
        o.start(t0); o.stop(t0 + 0.07);
        autoDisconnect(o, i === 2 ? [o, g, dest] : [o, g]);
      }
      return;
    }
    if (type === 'brute') {
      this._tone(dest, { from: rand(58, 70), to: 40, dur: 0.28, gain: 0.16 * gain, attack: 0.01 });
      return;
    }
    // Spitter: wet hiss.
    this._burst(dest, { freq: rand(2200, 3000), q: 2.2, dur: 0.22, gain: 0.05 * gain });
  }

  /** Spitter projectile leaving. */
  spit(pan = 0, gain = 1) {
    if (!this._ready()) return;
    this._burst(this._pan(pan), { freq: 1600, sweepTo: 700, q: 3, dur: 0.16, gain: 0.05 * gain });
  }

  enemyDeath(type, pan = 0) {
    if (!this._ready()) return;
    const dest = this._pan(pan);
    if (type === 'brute') {
      this._tone(dest, { from: 90, to: 30, dur: 0.5, gain: 0.3 });
      this._burst(dest, { filterType: 'lowpass', freq: 700, dur: 0.4, gain: 0.2 });
    } else {
      this._tone(dest, { type: 'sawtooth', from: rand(500, 700), to: 90, dur: 0.22, gain: 0.07 });
      this._burst(dest, { freq: rand(1200, 1800), q: 1.3, dur: 0.12, gain: 0.08 });
    }
  }

  // ── Player ─────────────────────────────────────────────────────────────

  playerHit() {
    if (!this._ready()) return;
    this._tone(this.sfx, { from: 130, to: 55, dur: 0.22, gain: 0.28 });
    this._burst(this.sfx, { filterType: 'highpass', freq: 2600, dur: 0.1, gain: 0.05 });
  }

  /** Death: long down-sweep, then the world muffles out. */
  death() {
    if (!this._ready()) return;
    this._tone(this.sfx, { type: 'sawtooth', from: 380, to: 38, dur: 1.3, gain: 0.16, attack: 0.02 });
    this.concussion(1);
  }

  /**
   * "Ears ringing": sweep the SFX lowpass down, hold, recover — plus a music duck.
   * Frequency ramps are exponential; a linear ramp from 20 kHz is inaudible for most
   * of its travel (perception is logarithmic).
   */
  concussion(strength = 1) {
    if (!this._ready() || !this.filter) return;
    const s = clamp(strength, 0, 1);
    const now = this.ctx.currentTime;
    const hold = 0.2 + 0.5 * s;
    const corner = Math.max(300, 20000 - 19500 * s);
    const f = this.filter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(Math.max(300, f.value), now);
    f.exponentialRampToValueAtTime(corner, now + 0.06);
    f.setValueAtTime(corner, now + 0.06 + hold);
    // Back to wherever the corner rests, which is not 20 kHz while the player is nearly dead.
    f.exponentialRampToValueAtTime(this._openCorner, now + 0.06 + hold + 0.6 + 0.5 * s);
    window.PoAudioBus?.duck?.(0.2, (hold + 0.4) * 1000);
    // Tinnitus: a thin high whine with a slow beat, straight to the master so the muffle
    // above does not swallow it — it is in your ears, not in the room.
    if (s >= 0.3 && this.master && !this._paused) {
      const ring = rand(5800, 6600), dur = 1.6 + 2.4 * s;
      this._tone(this.master, { from: ring, dur, gain: 0.016 * s, attack: 0.08 });
      this._tone(this.master, { from: ring * 1.004, dur: dur * 0.85, gain: 0.01 * s, attack: 0.12 });
    }
  }

  /**
   * Nearly dead: the world goes dull. Pulls the SFX lowpass in and leaves it there until
   * the player heals or dies; heartbeat() supplies the pulse over the top.
   */
  setLowHp(on) {
    const corner = on ? 2400 : 20000;
    if (corner === this._openCorner) return;
    this._openCorner = corner;
    if (!this._ready() || !this.filter) return;
    const f = this.filter.frequency, now = this.ctx.currentTime;
    f.cancelScheduledValues(now);
    f.setValueAtTime(Math.max(300, f.value), now);
    f.exponentialRampToValueAtTime(corner, now + 0.5);
  }

  /** One lub-dub. Straight to the master: it is inside your head, not in the room. */
  heartbeat() {
    if (!this._ready() || !this.master) return;
    this._tone(this.master, { from: 64, to: 40, dur: 0.14, gain: 0.3 });
    this._tone(this.master, { from: 56, to: 36, dur: 0.16, gain: 0.2, delay: 0.17 });
  }

  /** A footfall. `surface` is 'grass' (turf and dug earth) or 'stone' (masonry and rubble). */
  footstep(surface) {
    if (!this._ready() || !this._gate('step', 0.16)) return;
    if (surface === 'stone') {
      this._burst(this.sfx, { freq: rand(1700, 2300), q: 2, dur: 0.05, gain: 0.05 });
      this._tone(this.sfx, { from: rand(140, 170), to: 90, dur: 0.05, gain: 0.035 });
    } else {
      this._burst(this.sfx, { filterType: 'lowpass', freq: rand(560, 760), dur: 0.08, gain: 0.06 });
    }
  }

  // ── Weather ────────────────────────────────────────────────────────────

  /**
   * The rain bed: one looping noise source, started on first use. `level` 0 stops it being
   * heard; `indoors` (0..1) is the same roof probe the reverb uses, and closes the tone
   * down so a vault sounds like rain on the roof rather than rain on your head.
   */
  setRain(level, indoors) {
    if (!this.rain && (level <= 0 || !this._ready())) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (!this.rain) {
      // White, not the low-passed rubble buffer the impacts use: rain is all hiss.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(tone).connect(gain).connect(this.filter);
      src.start();
      this.rain = { src, tone, gain };
    }
    const quiet = this._paused || this._muted() ? 0 : level;
    this.rain.gain.gain.setTargetAtTime(0.05 * quiet * (1 - 0.55 * indoors), now, 0.4);
    this.rain.tone.frequency.setTargetAtTime(5200 - 4500 * indoors, now, 0.4);
  }

  /** Thunder, `delay` seconds after the flash — light is faster than sound. */
  thunder(delay = 0.8) {
    if (!this._ready()) return;
    // 1.9 s, not longer: the shared noise buffer is 2 s and a one-shot cannot outlast it.
    this._burst(this.sfx, { filterType: 'lowpass', freq: 190, dur: 1.9, gain: 0.5, attack: 0.06, delay });
    this._tone(this.sfx, { from: 58, to: 27, dur: 2.0, gain: 0.26, attack: 0.05, delay });
    this._burst(this.sfx, { filterType: 'highpass', freq: 2400, dur: 0.25, gain: 0.06, delay });
  }

  setPaused(paused) {
    this._paused = paused;
    if (this.rain && this.ctx) this.rain.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.wind && paused) {
        this.wind.gain.gain.setTargetAtTime(0, now, 0.2);
        this.wind.whistle.gain.setTargetAtTime(0, now, 0.2);
      }
      // Re-level immediately on resume rather than waiting out the probe clock.
      if (!paused) this._nextProbe = 0;
    }
  }

  dispose() {
    if (this.rain) {
      try { this.rain.src.stop(); } catch { /* never started */ }
      for (const n of Object.values(this.rain)) { try { n.disconnect(); } catch { /* */ } }
      this.rain = null;
    }
    if (this.wind) {
      for (const k of ['src', 'lfo', 'lfo2']) { try { this.wind[k].stop(); } catch { /* */ } }
      for (const n of Object.values(this.wind)) { try { n.disconnect(); } catch { /* */ } }
      this.wind = null;
    }
    if (this.erTaps) {
      for (const tap of this.erTaps) {
        for (const n of Object.values(tap)) { try { n.disconnect(); } catch { /* */ } }
      }
      try { this.erIn.disconnect(); } catch { /* */ }
      this.erTaps = null;
      this.erIn = null;
    }
    this.probe = null;
    this._occCache.clear();
    // Let one-shot tails ring out through the shared graph, then detach our chain.
    const master = this.master;
    if (master) setTimeout(() => { try { master.disconnect(); } catch { /* */ } }, 1500);
    this.master = null;
    this.sfx = null;
    this.filter = null;
  }
}
