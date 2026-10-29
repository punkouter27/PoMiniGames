// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> glue compressor -> limiter -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts, the charge risers)
//     │     ├── panner (per source; StereoPanner keyed off world-x, or a PannerNode
//     │     │           against the camera's AudioListener in the player modes)
//     │     ├── perspEq -> perspHc (the camera perspective: low-mid thump, high-cut)
//     │     └── sfxFilter ─┬─> master
//     │                    └─> perspSend -> convolver -> reverbGain -> master
//     ├── crowdGain -> crowdDuck -> crowdPersp   (bed; rhythmGain joins at crowdDuck)
//     ├── stingGain     (leitmotifs, fanfares, brass stabs: non-diegetic, no perspective)
//     ├── musicGain     (round-start loop stem + low-HP tension)
//     └── introGain     (round-start chiptune riff)
//
// The showtime half (audioShow.js) drives the methods in audioShowtime.js, mixed into this
// class: the conductor grid, the per-president leitmotifs, the charge risers, the camera
// perspective and the crowd's stomp-clap / chant. There is no music bed (app-wide rule):
// the conductor is a silent clock that the stingers and the crowd lock onto.
//
// Every public method is a no-op while muted so the game can call them freely.

// Files: audioCore.js (shared constants and helpers), this file (the bus, SFX, mix, crowd and
// the Cup storyline), audioAnnouncer.js (the PA) and audioShowtime.js (the show bus half),
// the last two mixed into AudioBus.prototype below.

import { mixin } from './mixin.js';
import { AudioAnnouncer } from './audioAnnouncer.js';
import { AudioShowtime } from './audioShowtime.js';
import {
  ARENA_HALF_WIDTH, SFX_FILTER_OPEN, SFX_FILTER_MUFFLED, DUCK_ATTACK, DUCK_RELEASE,
  CROWD_BASE_GAIN, CROWD_PEAK_GAIN, rand, clamp, makeNoiseBuffer, makeImpulseResponse,
  autoDisconnect, VOICES, DEFAULT_VOICE,
} from './audioCore.js';

// Lazy AudioContext + master bus, built on first call.
class AudioBus {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.reverbGain = null; // wet level for the convolver send
    this.noiseBuf = null;
    this.musicNodes = null;
    this.introGain = null;  // dedicated bus for round-start chiptune intros
    this.introNodes = null; // active intro oscillators/gains, for cleanup
    this._introRestoreVol = 0.35; // remembered musicGain value to restore after ducking
    this.lowMusicCrossfade = 0; // 0 = normal stem, 1 = low-HP stem
    this._ensureFailed = false; // latched so a broken graph can't report success
    // Audio-reactive envelope for the bloom pulse (getEnvelope); SFX nudge it, tick(dt)
    // decays it. Both must start at 0 or tick chases a ceiling and pins the bloom on.
    this._env = 0;
    this._envPeak = 0; // ceiling for the latest hit; decays in tick()
    this.sfxFilter = null;   // concussion lowpass, in-line on the SFX bus
    this.musicDuck = null;   // sidechain VCA between musicGain and master
    this.crowdGain = null;   // crowd bed level (owned by setCrowdIntensity)
    this.crowdDuck = null;   // crowd duck VCA (owned by the announcer)
    this._crowdBase = 0;     // level setCrowdIntensity last asked for
    this._crowdNodes = null; // live crowd oscillators/sources, for teardown
    this._crowdIntensity = 0;
    this._hitstopDepth = 0;  // 0 = normal, 1 = fully "in the vacuum"
    // Showtime (audioShow.js).
    this.stingGain = null;   // leitmotif / fanfare bus
    this.rhythmGain = null;  // crowd stomp-clap + chant level (owned by setCrowdRhythm)
    this.perspEq = this.perspHc = this.perspSend = this.crowdPersp = null;
    this._persp = 'mid';
    this._listenerMode = null; // null = StereoPanner by world-x; 'HRTF' | 'equalpower' = PannerNode
    this._grid = null;         // () => seconds to the next conductor 8th/16th (≤ ~120 ms)
    this._risers = new Set();  // live charge-riser handles
    this._popVoices = 0;
    this._superAt = -1;
  }

  _ensure() {
    if (this.ctx && !this._ensureFailed) return true;
    if (this._ensureFailed) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { this._ensureFailed = true; return false; }
      // Shared context (js/audioBus.js) — one AudioContext for the whole app.
      const shared = window.PoAudioBus && window.PoAudioBus.contextSync();
      const ctx = shared || new Ctor();
      this.ctx = ctx;
      // Only a context we made is ours to close — see close().
      this._ownsCtx = !shared;

      this.master = ctx.createGain();
      this.master.gain.value = 0.85;

      // Glue compressor, then a brickwall limiter to stay under 0 dBFS.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      this.master.connect(comp).connect(limiter).connect(
        (window.PoAudioBus && window.PoAudioBus.busSync('sfx')) || ctx.destination);
      // Post-limiter mix.
      this.out = limiter;

      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 1.0;

      // Concussion filter: dry AND wet pass through it, so the reverb muffles too.
      this.sfxFilter = ctx.createBiquadFilter();
      this.sfxFilter.type = 'lowpass';
      this.sfxFilter.frequency.value = SFX_FILTER_OPEN;
      // Non-resonant, so the sweep doesn't whistle.
      this.sfxFilter.Q.value = 0.0001;
      // Camera perspective (setPerspective owns all three): a low-mid peak for the close
      // shots' chest-thump and a high-cut for the wide shots' air, ahead of the concussion
      // filter, plus the reverb-send level below.
      this.perspEq = ctx.createBiquadFilter();
      this.perspEq.type = 'peaking';
      this.perspEq.frequency.value = 170;
      this.perspEq.Q.value = 0.9;
      this.perspEq.gain.value = 0;
      this.perspHc = ctx.createBiquadFilter();
      this.perspHc.type = 'lowpass';
      this.perspHc.frequency.value = SFX_FILTER_OPEN;
      this.perspHc.Q.value = 0.0001;
      this.sfxGain.connect(this.perspEq).connect(this.perspHc).connect(this.sfxFilter);
      this.sfxFilter.connect(this.master);

      // Parallel reverb send, so the wet level is tunable on its own. Two stages, two
      // owners: perspSend (setPerspective) and reverbGain (setHitstop).
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      this._convolver = convolver;
      this.perspSend = ctx.createGain();
      this.perspSend.gain.value = 1;
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.sfxFilter.connect(this.perspSend).connect(convolver).connect(this.reverbGain).connect(this.master);

      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.35;
      // Sidechain VCA: a separate gain because setMusicTension/playIntroTheme own (and
      // cancelScheduledValues on) musicGain. One owner per automation stage.
      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = 1.0;
      // Danger lowpass, owned by setDanger(); wide open unless a fighter nears KO.
      this.musicLP = ctx.createBiquadFilter();
      this.musicLP.type = 'lowpass';
      this.musicLP.frequency.value = SFX_FILTER_OPEN;
      this.musicLP.Q.value = 0.0001;
      this.musicGain.connect(this.musicLP).connect(this.musicDuck).connect(this.master);

      // Crowd bed bus, outside sfx/music. Two stages, two owners: crowdGain
      // (setCrowdIntensity) and crowdDuck (the announcer).
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      this.crowdDuck = ctx.createGain();
      this.crowdDuck.gain.value = 1.0;
      // Third stage, third owner: the camera perspective (setPerspective).
      this.crowdPersp = ctx.createGain();
      this.crowdPersp.gain.value = 1.0;
      this.crowdGain.connect(this.crowdDuck).connect(this.crowdPersp).connect(this.master);
      // The crowd's rhythm section (stomp-clap, chant): joins after crowdGain so the bed's
      // intensity level doesn't scale it twice, but before the PA duck and the perspective.
      // A little of it goes to the room, or a hall of stomping reads as one drum.
      this.rhythmGain = ctx.createGain();
      this.rhythmGain.gain.value = 0;
      this.rhythmGain.connect(this.crowdDuck);
      const rhythmSend = ctx.createGain();
      rhythmSend.gain.value = 0.7;
      this.rhythmGain.connect(rhythmSend).connect(convolver);

      // Stinger bus: the leitmotifs and fanfares are the broadcast's, not the room's, so
      // they skip the perspective and the concussion and take only a touch of reverb.
      this.stingGain = ctx.createGain();
      this.stingGain.gain.value = 0.6;
      this.stingGain.connect(this.master);
      const stingSend = ctx.createGain();
      stingSend.gain.value = 0.35;
      this.stingGain.connect(stingSend).connect(convolver);

      // Round-start chiptune bus, separate so ducking the loop leaves the intro alone.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.15;
      this.introGain.connect(this.master);

      this.noiseBuf = makeNoiseBuffer(ctx);
      return true;
    } catch (e) {
      // Latch the failure so a half-built graph never reports success.
      this._ensureFailed = true;
      try { console.error('[pobrawl/audio] AudioContext setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  // One-shot noise source at a random offset into the shared buffer.
  _noiseSource(playSeconds) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const maxOffset = Math.max(0, this.noiseBuf.duration - playSeconds - 0.01);
    src._offset = Math.random() * maxOffset;
    return src;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.85;
    // The crowd bed loops, so tear it down on mute rather than leave it running.
    if (this.muted) this.stopCrowd();
    else if (this.ctx) this.startCrowd();
    // A held charge riser would otherwise drone on under the mute until its release.
    if (this.muted) this.stopRisers();
  }

  // Big hits ~1.0, blocks ~0.4, whooshes ~0.2.
  _pulse(power) {
    this._envPeak = Math.max(this._envPeak, Math.min(1, power));
  }

  // Per-frame decay (~90 ms halflife; silence → 0 in ~0.5 s). The ceiling decays
  // too, since _pulse only raises it.
  tick(dt) {
    this._envPeak *= Math.exp(-dt * 4.0);
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    if (this._env < 0.005 && this._envPeak < 0.005) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Engine pause (game.js setPaused). The whole context is suspended rather than a gain ramp:
  // the crowd loop, a held riser and any stinger already scheduled on the audio clock all
  // freeze where they are and carry on from there on resume.
  setPaused(p) {
    this._paused = !!p;
    if (!this.ctx) return;
    try {
      (this._paused ? this.ctx.suspend() : this.ctx.resume()).catch(() => { /* closed */ });
    } catch { /* closed context */ }
  }

  // Resume the context after a user gesture (never while the engine is paused).
  async resume() {
    if (this._paused) return;
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // One-shot spatializer: StereoPanner keyed off world-x (cheap; fits the side-on camera).
  // In the player modes (setListenerMode) a PannerNode instead, placed at the world position
  // and heard from the camera's AudioListener — the one camera the player is looking through.
  // The director modes keep world-x: a TV mix doesn't flip sides on every reverse angle.
  _spatializer(worldPos) {
    const ctx = this.ctx;
    if (this._listenerMode && worldPos && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = this._listenerMode;
      // Inverse law, flat inside 9 m (the boom's working distance), so the camera mix
      // keeps the stereo path's level: position, not loudness, is what changes.
      p.distanceModel = 'inverse';
      p.refDistance = 9;
      p.rolloffFactor = 0.3;
      p.maxDistance = 60;
      this._placePanner(p, worldPos);
      return p;
    }
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      // Max 0.8: hard-panned mono reads as broken on headphones.
      p.pan.value = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
      return p;
    }
    // Fallback (no StereoPannerNode): equal-power pan across a 2-channel merger.
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const x = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
    const angle = (x + 1) * Math.PI / 4; // 0..PI/2
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    // Callers connect to the returned node and read `.output` for the tail.
    input.output = merger;
    return input;
  }

  // The fallback spatializer's output (merger) is not the node callers feed.
  _connectSpat(spat) {
    (spat.output || spat).connect(this.sfxGain);
    return spat;
  }

  _placePanner(p, pos) {
    const y = pos.y ?? 1.2, z = pos.z ?? 0;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = y; p.positionZ.value = z;
    } else {
      p.setPosition(pos.x, y, z);
    }
  }

  // Re-aim a live spatializer (the charge riser follows its fighter). Glides, never steps.
  _moveSpat(spat, pos) {
    if (!pos) return;
    if (spat.panningModel !== undefined) { this._placePanner(spat, pos); return; }
    if (spat.pan) {
      this._glide(spat.pan, clamp(pos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8, 0.05);
    }
  }

  // Layered impact: thud + crack + hiss. A kick lands lower and longer. Every layer
  // is randomized per call — identical repeats are the biggest synth tell.
  impact({ power = 1, blocked = false, worldPos = null, kind = 'punch' } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(blocked ? 0.45 : Math.min(1, 0.55 + power * 0.25));
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const heavy = kind === 'kick';

    // 1. Body thud (sine, fast decay). Kicks sit ~30 Hz lower and ring longer.
    const thudBase = blocked ? 180 : (heavy ? 65 : 95) + power * 35;
    const thudDecay = heavy ? 0.26 : 0.18;
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(thudBase * rand(0.88, 1.12), now);
    thud.frequency.exponentialRampToValueAtTime(heavy ? 38 : 45, now + (heavy ? 0.11 : 0.08));
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(
      blocked ? 0.18 : (heavy ? 0.40 : 0.34), now + rand(0.003, 0.007));
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + thudDecay);
    thud.connect(thudGain).connect(spat);
    thud.start(now); thud.stop(now + thudDecay + 0.04);
    autoDisconnect(thud, [thud, thudGain]);

    // 1b. Low-mid body — kicks only. Gives the weight a punch doesn't have.
    if (heavy && !blocked) {
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(rand(150, 190), now);
      body.frequency.exponentialRampToValueAtTime(80, now + 0.14);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.14, now + 0.006);
      bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      body.connect(bodyGain).connect(spat);
      body.start(now); body.stop(now + 0.24);
      autoDisconnect(body, [body, bodyGain]);
    }

    // 2. Crack (bandpass noise burst).
    if (!blocked) {
      const crackDur = 0.08;
      const src = this._noiseSource(crackDur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = ((heavy ? 1300 : 1800) + power * 600) * rand(0.8, 1.2);
      bp.Q.value = rand(1.1, 1.8);
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, now);
      crackGain.gain.linearRampToValueAtTime(0.22 + power * 0.05, now + rand(0.003, 0.006));
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      src.connect(bp).connect(crackGain).connect(spat);
      src.start(now, src._offset); src.stop(now + crackDur);
      autoDisconnect(src, [src, bp, crackGain]);
    }

    // 3. Hiss tail (highpass noise).
    const tailDur = 0.28;
    const tail = this._noiseSource(tailDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = rand(3400, 4600);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, now);
    tailGain.gain.linearRampToValueAtTime(blocked ? 0.04 : 0.10, now + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    tail.connect(hp).connect(tailGain).connect(spat);
    tail.start(now, tail._offset); tail.stop(now + tailDur);
    // Last layer to finish, so it owns tearing down the shared spatializer.
    autoDisconnect(tail, [tail, hp, tailGain, spat, spat.output].filter(Boolean));
  }

  block(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));

    // Wooden "tap" — two short triangle hits, detuned and re-spaced per block.
    const spacing = rand(0.04, 0.06);
    const detune = rand(0.9, 1.1);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = (240 - i * 40) * detune;
      const g = ctx.createGain();
      const t0 = now + i * spacing;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.15, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + 0.09);
      // Second (last) tap tears down the shared spatializer.
      autoDisconnect(o, i === 1 ? [o, g, spat, spat.output].filter(Boolean) : [o, g]);
    }
  }

  ko() {
    if (!this._ensure() || this.muted) return;
    this._pulse(1.0);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Sub-bass thud + slow down sweep + crash noise.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, now);
    subG.gain.linearRampToValueAtTime(0.6, now + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    sub.connect(subG).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.25);
    autoDisconnect(sub, [sub, subG]);

    const crashDur = 1.05;
    const crash = this._noiseSource(crashDur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.0001, now);
    cG.gain.linearRampToValueAtTime(0.35, now + 0.04);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    crash.connect(lp).connect(cG).connect(this.sfxGain);
    crash.start(now, crash._offset); crash.stop(now + crashDur);
    autoDisconnect(crash, [crash, lp, cG]);
  }

  // Pain grunt when a hit lands. `charId` picks the president's voice (VOICES).
  grunt({ power = 1, blocked = false, charId = null } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.15 + power * 0.1);
    const v = VOICES[charId] || DEFAULT_VOICE;
    // Wide per-call spread: grunts repeat most, so they go robotic fastest.
    const f0 = v.f0 * (blocked ? 1.35 : 0.95 + power * 0.25) * rand(0.9, 1.12);
    this._voice(v, f0, f0 * rand(0.5, 0.62), rand(0.18, 0.24), 0.08, 1);
  }

  // Effort "hup" on a kick or a charged swing: shorter, higher, a more open vowel.
  effort(charId, power = 1) {
    if (!this._ensure() || this.muted) return;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const f0 = v.f0 * (1.15 + 0.2 * power) * rand(0.94, 1.06);
    this._voice(v, f0, f0 * 0.8, 0.13, 0.05 + 0.02 * power, 1.25);
  }

  // One exhausted exhale — game.js breathes the fighter in the red between heartbeats.
  breath(charId, strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const src = this._noiseSource(0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = v.f2 * rand(0.95, 1.1);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.035 * clamp(strength, 0, 1), now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.6);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + 0.65);
    autoDisconnect(src, [src, bp, g]);
  }

  // Shared vocal tract: a sawtooth glottis sliding fromHz → toHz, through two
  // formant bandpasses in parallel, plus breath noise through the upper formant.
  // `open` scales F1 (a wider mouth raises it — "ha" versus "uh").
  _voice(v, fromHz, toHz, dur, peak, open) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(fromHz, now);
    o.frequency.exponentialRampToValueAtTime(toHz, now + dur * 0.85);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(peak, now + 0.012);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = v.f1 * open * rand(0.94, 1.06);
    f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = v.f2 * rand(0.94, 1.06);
    f2.Q.value = 7;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.6;
    o.connect(f1).connect(out);
    o.connect(f2).connect(f2g).connect(out);
    const nodes = [o, f1, f2, f2g, out];
    if (v.rasp > 0.05) {
      const n = this._noiseSource(dur + 0.05);
      const ng = ctx.createGain();
      ng.gain.value = v.rasp * 0.9;
      n.connect(ng).connect(f2);
      n.start(now, n._offset); n.stop(now + dur + 0.02);
      autoDisconnect(n, [n, ng]);
    }
    out.connect(this.sfxGain);
    o.start(now); o.stop(now + dur + 0.03);
    autoDisconnect(o, nodes);
  }

  // Prop materials:
  //   wood  — a knock plus a three-mode crack (a plank's resonances ring for
  //           ~0.1 s, not a note), then a patter of splinters landing
  //   rope  — a low twang with a vibrato wobble: a cable under tension, not a string
  //   steel — inharmonic bar partials (1 : 2.76 : 5.4 : 8.93), a turnbuckle clang
  prop({ material = 'wood', power = 1, worldPos = null } = {}) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = clamp(power, 0.2, 2.6);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const nodes = [];
    let end = now;

    const tone = (type, hz, t0, peak, decay, toHz = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(hz, t0);
      if (toHz) o.frequency.exponentialRampToValueAtTime(toHz, t0 + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + decay + 0.02);
      autoDisconnect(o, [o, g]);
      nodes.push(o);
      end = Math.max(end, t0 + decay + 0.02);
      return o;
    };
    const noise = (hz, q, t0, peak, decay) => {
      const src = this._noiseSource(decay + 0.02);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      src.connect(bp).connect(g).connect(spat);
      src.start(t0, src._offset); src.stop(t0 + decay + 0.02);
      autoDisconnect(src, [src, bp, g]);
      end = Math.max(end, t0 + decay + 0.02);
    };

    if (material === 'rope') {
      this._pulse(0.2 + p * 0.1);
      const hz = rand(62, 80) + p * 8;
      const o = tone('triangle', hz, now, 0.1 + p * 0.05, 0.55 + p * 0.1, hz * 0.86);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(6, 8);
      const depth = ctx.createGain();
      depth.gain.value = hz * 0.05;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(now); lfo.stop(now + 0.7);
      autoDisconnect(lfo, [lfo, depth]);
      tone('sine', hz * 2.01, now, 0.04, 0.35);
      noise(900, 0.8, now, 0.03 + p * 0.02, 0.12);             // fibre creak
    } else if (material === 'steel') {
      this._pulse(0.5);
      const base = rand(200, 240);
      [1, 2.76, 5.4, 8.93].forEach((m, i) =>
        tone('sine', base * m, now, (0.09 - i * 0.018) * p, 1.1 - i * 0.22));
      noise(4200, 1.2, now, 0.08, 0.04);                        // strike click
    } else {
      this._pulse(0.35 + p * 0.2);
      tone('sine', rand(150, 190), now, 0.26 * Math.min(1.4, p), 0.12, 70);   // knock
      for (const hz of [420, 950, 2100]) noise(hz * rand(0.9, 1.1), 9, now, 0.12 * p, rand(0.08, 0.16));
      // Splinters: clicks thinning out as the pieces settle.
      const n = 4 + Math.round(p * 3);
      for (let i = 0; i < n; i++) {
        const t = now + 0.12 + Math.pow(i / n, 1.4) * 0.6 + rand(0, 0.04);
        noise(rand(1800, 4200), 3, t, 0.05 * (1 - i / n) + 0.01, 0.03);
      }
    }
    // Tear the shared spatializer down once every layer is done.
    const k = ctx.createConstantSource();
    k.start(now); k.stop(end + 0.05);
    autoDisconnect(k, [k, spat, spat.output].filter(Boolean));
  }

  // Press-row shutters: a mechanical click pair (curtain open, curtain close) per camera.
  shutter(count = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const t0 = now + i * rand(0.03, 0.09) + rand(0, 0.02);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) pan.pan.value = rand(-0.8, 0.8);
      pan.connect(this.sfxGain);
      for (const [dt, hz] of [[0, rand(3000, 3800)], [rand(0.02, 0.035), rand(2200, 2800)]]) {
        const src = this._noiseSource(0.03);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = hz;
        bp.Q.value = 2.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.linearRampToValueAtTime(0.035, t0 + dt + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + dt + 0.02);
        src.connect(bp).connect(g).connect(pan);
        src.start(t0 + dt, src._offset); src.stop(t0 + dt + 0.03);
        autoDisconnect(src, dt ? [src, bp, g, pan] : [src, bp, g]);
      }
    }
  }

  // Victory pyro: a CO2 jet's hiss sweeping down, over a low whump.
  pyro(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.5);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const src = this._noiseSource(1.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(700, now + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 1.2);
    src.connect(bp).connect(g).connect(spat);
    src.start(now, src._offset); src.stop(now + 1.25);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(40, now + 0.25);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.22, now + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0008, now + 0.3);
    o.connect(og).connect(spat);
    o.start(now); o.stop(now + 0.32);
    autoDisconnect(o, [o, og]);
    autoDisconnect(src, [src, bp, g, spat, spat.output].filter(Boolean));
  }

  // Tape rewind into the next match: warbling chatter climbing in pitch, then the
  // transport's stop-clunk.
  rewind(dur = 0.75) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this._noiseSource(dur + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(4200, now + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17;
    const depth = ctx.createGain();
    depth.gain.value = 500;
    lfo.connect(depth).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.06);
    g.gain.setValueAtTime(0.09, now + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur + 0.02);
    lfo.start(now); lfo.stop(now + dur + 0.02);
    autoDisconnect(lfo, [lfo, depth]);
    autoDisconnect(src, [src, bp, g]);
    const clunk = ctx.createOscillator();
    clunk.type = 'triangle';
    clunk.frequency.setValueAtTime(160, now + dur);
    clunk.frequency.exponentialRampToValueAtTime(60, now + dur + 0.08);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now + dur);
    cg.gain.linearRampToValueAtTime(0.16, now + dur + 0.004);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + dur + 0.12);
    clunk.connect(cg).connect(this.sfxGain);
    clunk.start(now + dur); clunk.stop(now + dur + 0.14);
    autoDisconnect(clunk, [clunk, cg]);
  }

  // Glass giving way: a crack, then high inharmonic tinkles scattering as the
  // shards fall (the result-screen shatter).
  shatter() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const crack = this._noiseSource(0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.22, now + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + 0.18);
    crack.connect(hp).connect(cg).connect(this.sfxGain);
    crack.start(now, crack._offset); crack.stop(now + 0.2);
    autoDisconnect(crack, [crack, hp, cg]);
    for (let i = 0; i < 14; i++) {
      const t0 = now + 0.05 + Math.pow(Math.random(), 1.6) * 0.9;
      const o = ctx.createOscillator();
      o.frequency.value = rand(2800, 7200);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(rand(0.012, 0.03), t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + rand(0.08, 0.2));
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    }
  }

  whoosh() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.22);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.25;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const sweepFrom = rand(650, 950);
    bp.frequency.setValueAtTime(sweepFrom, now);
    bp.frequency.linearRampToValueAtTime(sweepFrom * rand(2.4, 3.0), now + rand(0.14, 0.22));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(rand(0.05, 0.075), now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  // ══ Dynamic mix ══════════════════════════════════════════════════════

  /**
   * Ramp an AudioParam down and back to `base`. The setValueAtTime(param.value)
   * after cancelScheduledValues is load-bearing: without it a mid-ramp cancel
   * jumps to the last scheduled value and rapid hits zipper.
   */
  _duckParam(param, base, amount, hold = 0, release = DUCK_RELEASE) {
    const now = this.ctx.currentTime;
    const floor = Math.max(0, base * (1 - clamp(amount, 0, 1)));
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(floor, now + DUCK_ATTACK);
    if (hold > 0) param.setValueAtTime(floor, now + DUCK_ATTACK + hold);
    param.linearRampToValueAtTime(base, now + DUCK_ATTACK + hold + release);
  }

  /**
   * Sidechain the music under a landed hit (power 0..1). Depth 0.18 + 0.42·power:
   * a jab barely moves it, so normal exchanges don't stutter.
   */
  duckMusic(power = 1) {
    if (!this._ensure() || this.muted || !this.musicDuck) return;
    this._duckParam(this.musicDuck.gain, 1.0, 0.18 + 0.42 * clamp(power, 0, 1));
  }

  /**
   * "Ears ringing" after a heavy head hit or KO: muffle the SFX bus, hold, reopen,
   * with a tinnitus sine on top and the music ducked.
   * @param {number} strength 0..1 — how far the corner drops and how long it holds
   */
  concussion(strength = 1) {
    if (!this._ensure() || this.muted || !this.sfxFilter) return;
    const s = clamp(strength, 0, 1);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hold = 0.18 + 0.5 * s;
    const corner = SFX_FILTER_OPEN - (SFX_FILTER_OPEN - SFX_FILTER_MUFFLED) * s;

    const f = this.sfxFilter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    // Exponential: pitch is perceived logarithmically.
    f.exponentialRampToValueAtTime(Math.max(120, corner), now + 0.05);
    f.setValueAtTime(Math.max(120, corner), now + 0.05 + hold);
    f.exponentialRampToValueAtTime(SFX_FILTER_OPEN, now + 0.05 + hold + 0.55 + 0.5 * s);

    if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.7 * s, hold, 0.6);

    // Tinnitus sine, randomized per call.
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = rand(3100, 4200);
    const tg = ctx.createGain();
    const dur = 0.05 + hold + 0.9;
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.016 * s, now + 0.08);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    // Straight to master, bypassing the muffle it rings over.
    tone.connect(tg).connect(this.master);
    tone.start(now); tone.stop(now + dur + 0.02);
    autoDisconnect(tone, [tone, tg]);
  }

  /**
   * The "vacuum" during hit-pause (true on freeze, false on resume): pulls the
   * reverb so the room vanishes and slams back. Cheaper than M/S narrowing.
   */
  setHitstop(active) {
    if (!this._ensure() || !this.reverbGain) return;
    const want = active ? 1 : 0;
    if (want === this._hitstopDepth) return;
    this._hitstopDepth = want;
    const now = this.ctx.currentTime;
    const rv = this.reverbGain.gain;
    rv.cancelScheduledValues(now);
    rv.setValueAtTime(rv.value, now);
    rv.linearRampToValueAtTime(active ? 0.03 : 0.18, now + (active ? 0.015 : 0.12));
  }

  // ══ Crowd bed ════════════════════════════════════════════════════════
  // Three noise bands whose level and brightness track tension, and one-shot reactions.
  // The chanting is the rhythm section's (crowdStomp/crowdClap/crowdChant, below).

  startCrowd() {
    if (!this._ensure() || this.muted || this._crowdNodes) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // One looping source per band at its own offset, so the layers stay decorrelated.
    const loopSource = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(now, Math.random() * Math.max(0.01, this.noiseBuf.duration - 0.05));
      return s;
    };

    // Swell VCA: one-shot reactions ride on top of the intensity level.
    const swell = ctx.createGain();
    swell.gain.value = 1.0;
    swell.connect(this.crowdGain);

    // Layer 1: room rumble, mono.
    const rumbleSrc = loopSource();
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 190;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0.9;
    rumbleSrc.connect(rumbleLp).connect(rumbleG).connect(swell);

    // Layer 2: chatter — the band intensity moves (level and centre frequency).
    const chatterSrc = loopSource();
    const chatterBp = ctx.createBiquadFilter();
    chatterBp.type = 'bandpass';
    chatterBp.frequency.value = 540;
    chatterBp.Q.value = 0.7;
    const chatterG = ctx.createGain();
    chatterG.gain.value = 1.0;
    const chatterPan = this._pan(-0.3);
    chatterSrc.connect(chatterBp).connect(chatterG).connect(chatterPan);
    (chatterPan.output || chatterPan).connect(swell);

    // Layer 3: hiss.
    const hissSrc = loopSource();
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissG = ctx.createGain();
    hissG.gain.value = 0.22;
    const hissPan = this._pan(0.34);
    hissSrc.connect(hissHp).connect(hissG).connect(hissPan);
    (hissPan.output || hissPan).connect(swell);

    // (The old chant — a 1.15 Hz LFO on the chatter — is retired: the crowd's rhythm
    // section below, locked to the conductor, does the chanting now.)

    // Layer 4: the murmur — an uneasy low-mid babble that only the tournament's upset
    // storyline opens (setCrowdMood). Two unrelated slow LFOs on its level make it
    // surge and settle like a hall talking to itself, not a tremolo.
    const murmurSrc = loopSource();
    const murmurBp = ctx.createBiquadFilter();
    murmurBp.type = 'bandpass';
    murmurBp.frequency.value = 360;
    murmurBp.Q.value = 1.3;
    const murmurAm = ctx.createGain();
    murmurAm.gain.value = 0.6;
    const murmurG = ctx.createGain();
    murmurG.gain.value = 0;
    murmurSrc.connect(murmurBp).connect(murmurAm).connect(murmurG).connect(swell);
    const murmurLfos = [0.37, 0.91].map((hz, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const d = ctx.createGain();
      d.gain.value = i ? 0.18 : 0.3;
      o.connect(d).connect(murmurAm.gain);
      o.start(now);
      return [o, d];
    });

    this._crowdNodes = {
      sources: [rumbleSrc, chatterSrc, hissSrc, murmurSrc, ...murmurLfos.map(([o]) => o)],
      chatterBp, swell, murmurG,
      all: [rumbleSrc, rumbleLp, rumbleG, chatterSrc, chatterBp, chatterG,
            chatterPan, chatterPan.output, hissSrc, hissHp, hissG, hissPan,
            hissPan.output, swell,
            murmurSrc, murmurBp, murmurAm, murmurG, ...murmurLfos.flat()].filter(Boolean),
    };
    this.setCrowdIntensity(this._crowdIntensity);
    this.setCrowdMood(this._crowdMood || 0);
  }

  // _spatializer, but taking a pan position directly.
  _pan(x) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(x, -1, 1);
      return p;
    }
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const angle = (clamp(x, -1, 1) + 1) * Math.PI / 4;
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    input.output = merger;
    return input;
  }

  /**
   * Crowd excitement — the same value that drives arena.js's animated crowd.
   * @param {number} t 0..1
   */
  setCrowdIntensity(t) {
    this._crowdIntensity = clamp(t, 0, 1);
    if (!this._crowdNodes || !this._ensure()) return;
    const now = this.ctx.currentTime;
    const i = this._crowdIntensity;
    this._crowdBase = CROWD_BASE_GAIN + (CROWD_PEAK_GAIN - CROWD_BASE_GAIN) * i;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.muted ? 0 : this._crowdBase, now + 0.6);
    // Brighten as it gets louder: 540 Hz murmur → 1150 Hz roar.
    const bp = this._crowdNodes.chatterBp.frequency;
    bp.cancelScheduledValues(now);
    bp.setValueAtTime(bp.value, now);
    bp.linearRampToValueAtTime(540 + 610 * i, now + 0.6);
  }

  /** Roar on a big landed hit. `power` 0..1. */
  crowdSwell(power = 1) {
    if (!this._crowdNodes || !this._ensure() || this.muted) return;
    const now = this.ctx.currentTime;
    const p = clamp(power, 0, 1);
    const s = this._crowdNodes.swell.gain;
    s.cancelScheduledValues(now);
    s.setValueAtTime(s.value, now);
    // Fast up, slow down.
    s.linearRampToValueAtTime(1 + 2.4 * p, now + 0.11);
    s.linearRampToValueAtTime(1, now + 0.11 + 0.7 + 0.5 * p);
  }

  /** Sharp intake of breath — a near-KO, a sever, a whiffed super. */
  crowdGasp() {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.55;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    // The rise-fall contour is what makes it a gasp.
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.linearRampToValueAtTime(1750, now + 0.16);
    bp.frequency.linearRampToValueAtTime(900, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.5, now + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  // ══ Tournament storyline (cup.js) ════════════════════════════════════
  // The crowd reading the Elo story: murmurs while the underdog leads, boos while a
  // heavy favourite cruises, a long roar for an upset, and a stadium slap-back on the
  // heavy hits of a high-upset moment. All synthesized, all on the crowd/sfx buses.

  /**
   * The hall's mood, -1..1: above 0 the underdog leads (the murmur layer opens with it),
   * below 0 the favourite is cruising (nothing continuous: crowdBoo carries that).
   */
  setCrowdMood(level) {
    this._crowdMood = clamp(level, -1, 1);
    if (!this._crowdNodes?.murmurG || !this._ensure()) return;
    const now = this.ctx.currentTime;
    const g = this._crowdNodes.murmurG.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.muted ? 0 : 0.85 * Math.max(0, this._crowdMood), now + 0.9);
  }

  /**
   * A wave of boos: a chorus of detuned sawtooth "oo" voices through two vowel formants,
   * swelling in and sagging in pitch as it dies. `strength` 0..1.
   */
  crowdBoo(strength = 1) {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const dur = 1.4 + 0.8 * s;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.linearRampToValueAtTime(0.5 + 0.5 * s, now + 0.35);
    bus.gain.setValueAtTime(0.5 + 0.5 * s, now + dur - 0.6);
    bus.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 320; f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 820; f2.Q.value = 4;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.35;
    bus.connect(f1).connect(this.crowdGain);
    bus.connect(f2).connect(f2g).connect(this.crowdGain);
    const voices = 9;
    const nodes = [bus, f1, f2, f2g];
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(105, 175);
      const t0 = now + rand(0, 0.25);
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.linearRampToValueAtTime(f0 * rand(0.86, 0.93), now + dur);
      o.detune.value = rand(-25, 25);
      const vg = ctx.createGain();
      vg.gain.value = 0.11 / Math.sqrt(voices);
      o.connect(vg).connect(bus);
      o.start(t0); o.stop(now + dur + 0.05);
      autoDisconnect(o, i === voices - 1 ? [o, vg, ...nodes] : [o, vg]);
    }
  }

  /**
   * A long, sustained roar (an upset decided, the champion crowned): the swell VCA held
   * high for `holdSec`, with a bright "hey!" cheer band riding over it.
   */
  crowdRoar(power = 1, holdSec = 2.5) {
    if (!this._crowdNodes || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = clamp(power, 0, 1);
    const s = this._crowdNodes.swell.gain;
    s.cancelScheduledValues(now);
    s.setValueAtTime(s.value, now);
    s.linearRampToValueAtTime(1 + 3.2 * p, now + 0.3);
    s.setValueAtTime(1 + 3.2 * p, now + 0.3 + holdSec);
    s.linearRampToValueAtTime(1, now + 0.3 + holdSec + 2.2);
    const end = now + 0.3 + holdSec + 1.6;
    const src = this._noiseSource(Math.min(1.9, end - now));
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(1300, now);
    bp.frequency.linearRampToValueAtTime(2100, now + 0.4);
    bp.frequency.linearRampToValueAtTime(1500, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.45 * p, now + 0.25);
    g.gain.setValueAtTime(0.45 * p, end - 1.2);
    g.gain.exponentialRampToValueAtTime(0.0008, end);
    src.connect(bp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(end + 0.05);
    autoDisconnect(src, [src, bp, g]);
  }

  // The slap-back: the sfx bus feeds a 140 ms delay with a little feedback, through a
  // band-limit (the far stands), and a gate that is shut unless slapback() opens it.
  // Built on first use; the feedback loop idles silently behind the shut gate.
  _echo() {
    if (this._echoNodes || !this.sfxFilter) return this._echoNodes;
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.14;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 160;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    this.sfxFilter.connect(delay);
    delay.connect(lp).connect(hp);
    hp.connect(fb).connect(delay);
    hp.connect(gate).connect(this.master);
    this._echoNodes = { gate, all: [delay, lp, hp, fb, gate] };
    return this._echoNodes;
  }

  /** Open the stadium slap-back for the hit that just landed. `amount` 0..1. */
  slapback(amount = 1) {
    if (!this._ensure() || this.muted) return;
    const e = this._echo();
    if (!e) return;
    const now = this.ctx.currentTime;
    const g = e.gate.gain;
    const peak = 0.75 * clamp(amount, 0, 1);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(peak, now + 0.01);
    g.setValueAtTime(peak, now + 0.5);
    g.linearRampToValueAtTime(0, now + 1.3);
  }

  /** A confetti cannon in the rafters: the sub thump, the blast and the paper hiss after it. */
  cannonBoom(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(rand(62, 76), now);
    o.frequency.exponentialRampToValueAtTime(26, now + 0.45);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.5, now + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0008, now + 0.6);
    o.connect(og).connect(spat);
    o.start(now); o.stop(now + 0.62);
    autoDisconnect(o, [o, og]);
    const blast = this._noiseSource(0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(260, now + 0.4);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, now);
    bg.gain.linearRampToValueAtTime(0.32, now + 0.004);
    bg.gain.exponentialRampToValueAtTime(0.0008, now + 0.45);
    blast.connect(lp).connect(bg).connect(spat);
    blast.start(now, blast._offset); blast.stop(now + 0.5);
    autoDisconnect(blast, [blast, lp, bg]);
    // The paper: a soft high hiss drifting down for a second.
    const paper = this._noiseSource(1.3);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4200;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.0001, now + 0.08);
    pg.gain.linearRampToValueAtTime(0.03, now + 0.25);
    pg.gain.exponentialRampToValueAtTime(0.0006, now + 1.25);
    paper.connect(hp).connect(pg).connect(spat);
    paper.start(now + 0.08, paper._offset); paper.stop(now + 1.3);
    autoDisconnect(paper, [paper, hp, pg, spat, spat.output].filter(Boolean));
  }

  stopCrowd() {
    if (!this._crowdNodes) return;
    for (const s of this._crowdNodes.sources) { try { s.stop(); } catch { /* */ } }
    // Loops never fire onended, so autoDisconnect can't clean this graph.
    for (const n of this._crowdNodes.all) { try { n.disconnect(); } catch { /* */ } }
    this._crowdNodes = null;
  }
}

mixin(AudioBus.prototype, AudioAnnouncer, AudioShowtime);

export { AudioBus };
