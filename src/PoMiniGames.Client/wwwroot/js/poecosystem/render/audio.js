// audio.js — procedural ambience, positional SFX and event stingers. No asset files, no
// dependencies: every layer is synthesised from a shared noise buffer and a handful of
// oscillators, so the bundle pays nothing for the "island is alive" feel. The AudioContext
// is created lazily on the first user gesture (browsers block autoplay), and every entry
// point is defensive — a blocked or broken audio device must never take the game down.
//
// Layers: constant wind and waves; birdsong by day; crickets by night (crossfaded by the
// sim's dayFraction, the same curve lighting.js uses). Stingers: lightning, rockslide,
// eruption. The HUD's sound pill toggles the master gain.
//
// GFX option 3 made all of that POSITIONAL. Before it, an eruption on the far shore was
// exactly as loud, as bright and as central as one at the player's feet:
//
//   LISTENER   the AudioContext listener is parked on the camera every frame, so panning
//              and distance are computed against where the god actually is.
//   PANNERS    every stinger and impact goes through a PannerNode with an inverse-distance
//              model, so the island has a near field and a far field.
//   SPEED OF   thunder is scheduled at `dist / 343` seconds after the flash, and its
//   SOUND      low-pass opens or closes with distance — air eats the high frequencies, and
//              that is the cue the ear actually uses to judge how far away a storm is.
//   REVERB     one synthesised impulse response (decaying noise — still no assets) on a
//              send, so a rockslide in the mountains rings and a footfall on the beach
//              does not.
//
// CREATURE VOICES (GFX pass 2, idea 6). Until this the only living things you could hear
// were birds and crickets — four species and a tribe, all silent. The renderer now scans
// the creatures near the listener and calls these, positioned like every other source:
//
//   HOWL    a wolf pack that is hunting after dark. Formant synthesis — a near-sine
//           fundamental gliding up and settling into vibrato, pushed through two
//           band-pass formants that open from "oo" to "ah" — so it needs no asset.
//   BARK    a deer's alarm when it bolts: a short nasal burst.
//   THUMP   a rabbit's alarm, which in the wild is not a voice at all but a double foot
//           drum on the ground.
//   DRUMS   the tribe's night drumming at the campfire once it has Fire, one bar at a
//           time on the score's own tempo so it sits inside the music rather than over it.
//
// STANDING SOUNDS. A stinger is one event; these are voices that stay, each built once and
// then moved and levelled from the renderer (all of it observation, none of it reaches the sim):
//
//   FIRE     a crackle and a roar from where the island is burning (setFires, parked on the
//            groups fireClusters.js makes), a hiss where lava meets the sea or rain meets
//            flame. Before this a firestorm was silent.
//   SHORE    the surf follows how near the coast is and the canopy rustles under trees in
//            proportion to the wind (setPlace): with eyes shut, forest and beach differ.
//   BIRDS    chirps come from where the flocks are (setBirds), with a rush of wings when
//            they gather at dusk.
//   FEET     footfalls for the animals nearest the listener, on the ground they are on
//            (footfalls), and one low rumble for a herd on the run (setHerd).
//   ROCK     a boulder rumbles while it rolls and loose stones rattle (setRolls); a felled
//            tree creaks on its way over (creak).
//
// WHY ITS OWN AudioContext AND NOT PoAudioBus
// The app-wide bus is a fine mixer but it is a different AudioContext with a listener
// parked at the origin, and PoMaterialAudio's positioning is a stereo pan in screen space.
// Neither can express "that tree fell 60 metres behind you and to the left" in world
// coordinates. What the shared stack IS consulted for is mute and volume: this context
// follows the player's app-wide setting for both (see syncGlobalMute).
import { assignSlots } from './fireClusters.js';
import { createAmbisonicBed } from '../../platform/ambisonics.js';
import { createAcousticProbe, heightfieldRaycaster } from '../../platform/acousticProbe.js';
import { createEarlyTaps } from '../../platform/acoustics.js';

// GFX/audio pass: the ambience is a first-order AMBISONIC bed (platform/ambisonics.js) and the
// room around the listener is MEASURED (platform/acousticProbe.js).
//
//   AMBIENCE  wind (four decorrelated sources round the horizon), surf (toward the nearest sea,
//             found by marching the heightfield), canopy and rain (overhead), crickets and
//             un-placed bird chirps (random directions) are encoded once at fixed WORLD
//             directions and the whole field is rotated by the camera's heading every frame —
//             turn to face the sea and the surf comes round to your front instead of staying
//             "left" the way a stereo loop would.
//   ROOM      ~28 terrain rays, three per frame, give early-reflection taps (a canyon wall 30 m
//             away returns a slapback ~175 ms later; an open beach returns almost nothing but
//             the ground) and a wet scale for the reverb send: the same island sounds closed
//             in a gorge and open on a summit. Taps crossfade between two banks, so nothing
//             zippers while the player flies.
//   OCCLUSION one-shot stingers (place()) ask the probe whether a hill is between them and the
//             listener and take a lowpass + level cut when it is — the rockslide behind the
//             ridge is muffled, the one in plain view is not.

const MASTER_LEVEL = 0.55;
const SPEED_OF_SOUND = 343;      // m/s — the delay that makes distance legible
const MAX_AUDIBLE = 260;         // metres; past this a stinger is not scheduled at all

// Impact voices. Deliberately parallel to the app's materialAudio.js recipes so the island
// sounds like the rest of the platform, but re-synthesised here because they have to be
// born inside this context to be positioned in world space.
// Footfalls by ground: a soft thud on turf, a hiss on sand, a click on rock, a crunch on
// snow, a slap in the shallows. `thump` 0 means no body to the step, only the noise.
const FOOT = {
  grass: { thump: 74, decay: 0.06, noiseHz: 700, noiseQ: 0.6, noiseSec: 0.05, noise: 0.35 },
  sand: { thump: 60, decay: 0.05, noiseHz: 1700, noiseQ: 0.5, noiseSec: 0.09, noise: 0.5 },
  rock: { thump: 130, decay: 0.03, noiseHz: 2600, noiseQ: 2.2, noiseSec: 0.03, noise: 0.7 },
  snow: { thump: 0, decay: 0.05, noiseHz: 3200, noiseQ: 0.9, noiseSec: 0.08, noise: 0.6 },
  water: { thump: 0, decay: 0.08, noiseHz: 1200, noiseQ: 0.8, noiseSec: 0.13, noise: 0.7 },
};
const FIRE_VOICES = 4;
const ROLL_VOICES = 3;

const MATERIALS = {
  wood: { thump: 95, decay: 0.16, noiseHz: 420, noiseQ: 1.2, noiseSec: 0.09 },
  stone: { thump: 55, decay: 0.13, noiseHz: 260, noiseQ: 0.8, noiseSec: 0.11 },
  flesh: { thump: 68, decay: 0.10, noiseHz: 180, noiseQ: 1.6, noiseSec: 0.07 },
  water: { thump: 0, decay: 0.20, noiseHz: 900, noiseQ: 0.9, noiseSec: 0.22 },
};

export function createAudio() {
  let ctx = null;
  let master = null;         // everything, dry
  let reverbSend = null;     // the wet path's input
  let birdGain = null;
  let cricketGain = null;
  let windGain = null;
  let ambi = null;           // ambisonic ambience bed (dry, into master)
  let probe = null; let early = null; let wetOut = null; let terrainRef = null;
  let seaDir = null; let seaAt = -10; let surfSrc = null;
  let rainGain = null;
  let surfGain = null; let surfDepth = null; let canopyGain = null;
  let rainNow = 0;           // 0..1, for the hiss of rain on fire
  let birdLevelNow = 0;      // the day's bird level, for chirps that bypass the bus
  let birdPoints = null;     // where the flocks are (setBirds)
  // Weather (setWeather): how much the rain bed is up, and how far it hushes the birds.
  let weatherHush = 0;
  let windBoost = 0;
  let noise = null;          // shared 2 s looped buffer
  let enabled = true;
  let lastChirpAt = 0;
  let lastImpactAt = 0;
  let underFilter = null;
  let under = false;
  const listener = { x: 0, y: 0, z: 0 };

  const smooth = (v) => v * v * (3 - 2 * v);   // smoothstep for gain crossfades

  function ensure() {
    if (typeof window === 'undefined' || ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try { ctx = new Ctor(); } catch { ctx = null; return; }
    try { build(); initProbe(); } catch { ctx = null; }     // a broken device disables audio, not the game
  }

  /**
   * A decaying-noise impulse response. Two decorrelated channels give the tail width; the
   * exponent sets how "stone" the space is. Still no asset files — this is ~2 s of
   * Math.random through an envelope, generated once.
   */
  function makeImpulse(seconds, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // An early-reflection gap keeps it from sounding like a plain noise swell.
        const gate = t < 0.012 ? t / 0.012 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * gate;
      }
    }
    return buf;
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = enabled ? MASTER_LEVEL : 0;
    // A gentle limiter: an eruption stinger over a full dawn chorus can otherwise clip,
    // and clipping is the one artefact that makes synthesised audio sound cheap.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 6;
    limiter.attack.value = 0.004; limiter.release.value = 0.18;
    // Underwater: one low-pass on the whole mix, wide open above the surface.
    // Sitting between the master and the limiter, it muffles the score as well — which is
    // what a head under water hears.
    underFilter = ctx.createBiquadFilter();
    underFilter.type = 'lowpass'; underFilter.frequency.value = under ? 520 : 20000; underFilter.Q.value = 0.5;
    master.connect(underFilter).connect(limiter).connect(ctx.destination);

    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(2.4, 2.6);
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    reverbSend.connect(convolver).connect(wet).connect(master);
    wetOut = wet;
    // The ambience bed and the live early reflections. Taps hear the master mix and return into
    // the filter downstream of it (not master itself: that would be a feedback loop).
    try {
      ambi = createAmbisonicBed(ctx, master);
      early = createEarlyTaps(ctx, master, underFilter, { level: 0.55 });
    } catch { ambi = null; early = null; }

    // One pink-ish noise buffer feeds wind, waves and the stingers.
    const len = Math.floor(ctx.sampleRate * 2);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
    }

    // Wind: looped noise through a slowly wandering low-pass. Kept non-positional on
    // purpose — wind has no source, and panning it would make the god's own head the
    // weather. Its LEVEL does move, with altitude (see setPlayer).
    // On the ambisonic bed it is four decorrelated copies round the horizon (each its own read
    // offset into the noise, so they are four winds, not one): the field has no centre to
    // pan, but it still turns with the camera and its sides differ from moment to moment.
    const windLfo = ctx.createOscillator(); windLfo.frequency.value = 0.07;
    const windDepth = ctx.createGain(); windDepth.gain.value = 140;
    const windDirs = [{ x: 1, y: 0.15, z: 1 }, { x: -1, y: 0.15, z: 1 }, { x: -1, y: 0.15, z: -1 }, { x: 1, y: 0.15, z: -1 }];
    const windGains = [];
    windDirs.forEach((dir, i) => {
      const wind = loopNoise();
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass'; windFilter.frequency.value = 320; windFilter.Q.value = 0.4;
      const g = ctx.createGain(); g.gain.value = 0.05;
      windLfo.connect(windDepth).connect(windFilter.frequency);
      wind.connect(windFilter).connect(g);
      if (ambi) ambi.addSource(g, { dir, spread: 0.35, gain: 1 }); else g.connect(master);
      wind.start(0, i * 0.47);
      windGains.push(g);
    });
    // One handle the rest of the file drives like the single gain it used to be.
    windGain = { gain: {
      setTargetAtTime(v, t, tc) { for (const g of windGains) g.gain.setTargetAtTime(v, t, tc); },
    } };
    windLfo.start();

    // Waves: the same noise through a band-pass, swelling and receding.
    const surf = loopNoise();
    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = 'bandpass'; surfFilter.frequency.value = 560; surfFilter.Q.value = 0.7;
    surfGain = ctx.createGain(); surfGain.gain.value = 0.04;
    const surfLfo = ctx.createOscillator(); surfLfo.frequency.value = 0.13;
    surfDepth = ctx.createGain(); surfDepth.gain.value = 0.02;
    surfLfo.connect(surfDepth).connect(surfGain.gain);
    surf.connect(surfFilter).connect(surfGain);
    if (ambi) surfSrc = ambi.addSource(surfGain, { dir: { x: 1, y: 0, z: 0 }, spread: 1, gain: 1 }); else surfGain.connect(master);
    surf.start(); surfLfo.start();

    // Rain: the same noise, high-passed into hiss, with a slow swell so a downpour breathes.
    // Silent until the weather says otherwise (setWeather).
    const rain = loopNoise();
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass'; rainFilter.frequency.value = 1400; rainFilter.Q.value = 0.3;
    const rainTone = ctx.createBiquadFilter();
    rainTone.type = 'peaking'; rainTone.frequency.value = 3200; rainTone.gain.value = 4; rainTone.Q.value = 0.8;
    rainGain = ctx.createGain(); rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(rainTone).connect(rainGain);
    if (ambi) ambi.addSource(rainGain, { dir: { x: 0, y: 1, z: 0 }, spread: 0.7, gain: 1 }); else rainGain.connect(master);
    rain.start();

    // Canopy: leaves in the wind. Silent until the listener is under trees (setPlace).
    const canopy = loopNoise();
    const canopyFilter = ctx.createBiquadFilter();
    canopyFilter.type = 'bandpass'; canopyFilter.frequency.value = 2600; canopyFilter.Q.value = 0.45;
    const canopyLfo = ctx.createOscillator(); canopyLfo.frequency.value = 0.21;
    const canopySwing = ctx.createGain(); canopySwing.gain.value = 600;
    canopyLfo.connect(canopySwing).connect(canopyFilter.frequency);
    canopyGain = ctx.createGain(); canopyGain.gain.value = 0;
    canopy.connect(canopyFilter).connect(canopyGain);
    if (ambi) ambi.addSource(canopyGain, { dir: { x: 0, y: 1, z: 0 }, spread: 0.55, gain: 1 }); else canopyGain.connect(master);
    canopy.start(); canopyLfo.start();

    // Birds: silent bus; chirps are scheduled on top of it while the sun is up.
    birdGain = ctx.createGain(); birdGain.gain.value = 0;
    birdGain.connect(master);
    birdGain.connect(reverbSend);

    // Crickets: a high triangle tone, amplitude-modulated ~26 Hz, faded in at night.
    const cricket = ctx.createOscillator();
    cricket.type = 'triangle'; cricket.frequency.value = 4300;
    const am = ctx.createGain(); am.gain.value = 0.5;
    const amLfo = ctx.createOscillator(); amLfo.frequency.value = 26;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.5;
    amLfo.connect(amDepth).connect(am.gain);
    cricketGain = ctx.createGain(); cricketGain.gain.value = 0;
    cricket.connect(am).connect(cricketGain);
    if (ambi) ambi.addSource(cricketGain, { dir: { x: -0.7, y: 0.1, z: 0.7 }, spread: 0.3, gain: 1 }); else cricketGain.connect(master);
    cricket.start(); amLfo.start();
  }

  function loopNoise() {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    return src;
  }

  /** 0..1 how much terrain is between the listener and a world point (0 with no probe yet). */
  function occlusionAt(x, y, z) {
    if (!probe) return 0;
    try {
      // The key is a coarse cell so a rockslide's forty chunks share one answer.
      return probe.occlusionFor({ x, y, z }, listener, { key: ((x / 3) | 0) + '|' + ((y / 3) | 0) + '|' + ((z / 3) | 0) });
    } catch { return 0; }
  }

  /**
   * A positioned output node. Everything world-placed goes through one of these, so the
   * decision "how loud, how panned, how wet" is made once rather than per voice.
   * Returns null when the source is too far to be worth scheduling at all.
   */
  function place(x, y, z, { hrtf = false, wet = 0.25, ref = 8, rolloff = 1.15 } = {}) {
    const dist = Math.hypot(x - listener.x, y - listener.y, z - listener.z);
    if (dist > MAX_AUDIBLE) return null;
    const panner = ctx.createPanner();
    // HRTF for the rare dramatic one-shot, equal-power for the frequent ones: HRTF is a
    // convolution per source and a rockslide can fire a dozen impacts in a second.
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = ref;
    panner.maxDistance = MAX_AUDIBLE;
    panner.rolloffFactor = rolloff;
    if (panner.positionX) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
    else panner.setPosition(x, y, z);
    panner.connect(master);
    if (wet > 0 && reverbSend) {
      const send = ctx.createGain();
      send.gain.value = wet;
      panner.connect(send).connect(reverbSend);
    }
    // Is a hill in the way? Then the sound arrives dull and quieter (a lowpass toward 900 Hz).
    const occ = occlusionAt(x, y, z);
    if (occ > 0.05) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 18000 * Math.pow(900 / 18000, occ);
      const cut = ctx.createGain(); cut.gain.value = 1 - 0.45 * occ;
      lp.connect(cut).connect(panner);
      return { node: lp, dist, occlusion: occ };
    }
    return { node: panner, dist, occlusion: 0 };
  }

  function chirp(at) {
    // From a flock, when the renderer has said where the flocks are: the chirp then skips
    // the bus (which has no place) and carries the day's bird level itself.
    let dest = birdGain; let level = 0.05;
    if (ambi) {
      // No flock to place it: a chirp from somewhere round the listener, in the sky half.
      const az = Math.random() * Math.PI * 2, el = 0.2 + Math.random() * 0.5;
      dest = ambi.oneShot({ x: Math.cos(az) * Math.cos(el), y: Math.sin(el), z: Math.sin(az) * Math.cos(el) }, 1.4, { spread: 0.1 });
      level = 0.05 * birdLevelNow;
      if (level < 0.002) return;
    }
    const from = birdPoints?.length ? birdPoints[(Math.random() * birdPoints.length) | 0] : null;
    if (from) {
      const placed = place(from.x, from.y, from.z, { wet: 0.4, ref: 34, rolloff: 0.6 });
      if (!placed) return;
      dest = placed.node; level = 0.11 * birdLevelNow;
      if (level < 0.004) return;
    }
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let k = 0; k < notes; k++) {
      const t = at + k * (0.14 + Math.random() * 0.06);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = 2200 + Math.random() * 1200;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.4, t + 0.05);
      osc.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.11);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(g).connect(dest);
      osc.start(t); osc.stop(t + 0.16);
    }
  }

  /** dayFraction 0..1 (0 = midnight); season: 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter */
  function setDay(dayFraction, season = 0) {
    if (!ctx) return;
    syncGlobalMute();
    const day = Math.max(0, Math.sin((dayFraction - 0.25) * Math.PI * 2));
    const t = ctx.currentTime;
    const isWinter = season === 3;
    const birdLevel = isWinter ? 0 : smooth(day) * 0.9 * (1 - weatherHush);
    birdLevelNow = birdLevel;
    birdGain?.gain.setTargetAtTime(birdLevel, t, 0.5);
    cricketGain?.gain.setTargetAtTime(isWinter ? 0 : smooth(1 - day) * 0.035, t, 0.5);
    if (!isWinter && weatherHush < 0.6 && day > 0.3 && t - lastChirpAt > 2.5 + Math.random() * 5) { lastChirpAt = t; chirp(t + 0.05); }
  }

  /** kind: 0 clear · 1 rain · 2 storm · 3 drought · 4 snow (sim/events/weather.js); intensity 0..1. */
  function setWeather(kind, intensity = 0) {
    if (!ctx) return;
    const i = Math.max(0, Math.min(1, intensity));
    const rainLevel = kind === 1 ? 0.07 * i : kind === 2 ? 0.12 * i : 0;
    rainNow = kind === 1 || kind === 2 ? i : 0;
    rainGain?.gain.setTargetAtTime(rainLevel, ctx.currentTime, 1.2);
    weatherHush = kind === 1 ? 0.6 * i : kind === 2 ? 0.95 * i : kind === 4 ? 0.5 * i : 0;
    windBoost = kind === 2 ? 0.1 * i : kind === 4 ? 0.05 * i : 0;
  }

  /** Where a positioned voice starts: now plus the sound's travel time. */
  const arrival = (placed) => ctx.currentTime + placed.dist / SPEED_OF_SOUND;

  /** A wolf howl. `pitch` ~0.85..1.2 so a pack chorus does not sing in unison. */
  function howl(at, pitch = 1) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { hrtf: true, wet: 0.6, ref: 22, rolloff: 0.8 });
      if (!placed) return;
      const when = arrival(placed);
      const len = 2.2 + Math.random() * 0.9;
      const f0 = 330 * pitch;
      const glide = (param) => {
        param.setValueAtTime(f0 * 0.82, when);
        param.exponentialRampToValueAtTime(f0 * 1.28, when + 0.55);
        param.setValueAtTime(f0 * 1.28, when + len * 0.7);
        param.exponentialRampToValueAtTime(f0 * 0.86, when + len);
      };
      // The fundamental carries the howl; a quiet sawtooth through the formants gives it
      // a throat. Vibrato comes in after the rise, as a real one does.
      const pure = ctx.createOscillator(); pure.type = 'sine'; glide(pure.frequency);
      const reed = ctx.createOscillator(); reed.type = 'sawtooth'; glide(reed.frequency);
      const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
      const vibDepth = ctx.createGain();
      vibDepth.gain.setValueAtTime(0, when);
      vibDepth.gain.linearRampToValueAtTime(f0 * 0.018, when + 0.9);
      vib.connect(vibDepth); vibDepth.connect(pure.frequency); vibDepth.connect(reed.frequency);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 5;
      f1.frequency.setValueAtTime(420, when); f1.frequency.linearRampToValueAtTime(820, when + 0.7);
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 7;
      f2.frequency.setValueAtTime(900, when); f2.frequency.linearRampToValueAtTime(1250, when + 0.7);
      const reedGain = ctx.createGain(); reedGain.gain.value = 0.18;
      reed.connect(f1).connect(reedGain); reed.connect(f2).connect(reedGain);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(0.26, when + 0.35);
      env.gain.setValueAtTime(0.26, when + len * 0.75);
      env.gain.exponentialRampToValueAtTime(0.0001, when + len);
      pure.connect(env); reedGain.connect(env);
      env.connect(placed.node);
      for (const o of [pure, reed, vib]) { o.start(when); o.stop(when + len + 0.1); }
    } catch { /* best effort */ }
  }

  /** A deer's alarm bark: a nasal burst with a falling pitch. */
  function bark(at) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.35, ref: 10, rolloff: 1.2 });
      if (!placed) return;
      const when = arrival(placed);
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(260, when); o.frequency.exponentialRampToValueAtTime(150, when + 0.16);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(0.32, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
      o.connect(f).connect(g).connect(placed.node);
      o.start(when); o.stop(when + 0.25);
      burst(placed.node, when, { type: 'bandpass', frequency: 1800, Q: 1.2, level: 0.12, attack: 0.005, seconds: 0.12 });
    } catch { /* best effort */ }
  }

  /** A rabbit's alarm: two quick foot drums on the ground. */
  function footThump(at) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.15, ref: 5, rolloff: 1.5 });
      if (!placed) return;
      const when = arrival(placed);
      thump(placed.node, when, 110, 48, 0.07, 0.45);
      thump(placed.node, when + 0.11, 105, 46, 0.07, 0.38);
    } catch { /* best effort */ }
  }

  /**
   * One bar of campfire drumming starting at `when` (context time), `beat` seconds per
   * beat. Low drum on 1 and 3, a hand drum on the offbeats, the last one ghosted.
   */
  function drumBar(at, when, beat) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.4, ref: 14, rolloff: 1.1 });
      if (!placed) return;
      const t0 = when + placed.dist / SPEED_OF_SOUND;
      thump(placed.node, t0, 90, 42, 0.32, 0.5);
      thump(placed.node, t0 + beat * 2, 88, 42, 0.3, 0.42);
      for (const [off, lvl] of [[1.5, 0.22], [2.5, 0.2], [3, 0.26], [3.5, 0.12]]) {
        thump(placed.node, t0 + beat * off, 210, 140, 0.09, lvl);
        burst(placed.node, t0 + beat * off, { type: 'bandpass', frequency: 700, Q: 1.4, level: lvl * 0.5, attack: 0.002, seconds: 0.06 });
      }
    } catch { /* best effort */ }
  }

  /** Tribal war / peace drum pulse */
  function tribalDrum(at, isWar = false) {
    ensure();
    if (!ctx || !enabled) return;
    try {
      const placed = at ? place(at.x, at.y, at.z, { ref: 18, rolloff: 1.1 }) : null;
      if (at && !placed) return;
      const dest = placed ? placed.node : master;
      const when = ctx.currentTime + (placed ? placed.dist / SPEED_OF_SOUND : 0);
      thump(dest, when, isWar ? 95 : 75, 38, isWar ? 0.22 : 0.35, isWar ? 0.6 : 0.4);
      burst(dest, when, { type: 'bandpass', frequency: 180, Q: 1.5, level: 0.3, seconds: 0.08 });
    } catch { /* best effort */ }
  }

  /** Dual detuned war horn fanfare */
  function warHorn(at) {
    ensure();
    if (!ctx || !enabled) return;
    try {
      const placed = at ? place(at.x, at.y, at.z, { hrtf: true, wet: 0.45, ref: 25, rolloff: 0.85 }) : null;
      if (at && !placed) return;
      const dest = placed ? placed.node : master;
      const when = ctx.currentTime + (placed ? placed.dist / SPEED_OF_SOUND : 0);
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      osc1.frequency.setValueAtTime(110, when);
      osc2.frequency.setValueAtTime(113, when);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(220, when);
      filter.frequency.linearRampToValueAtTime(850, when + 0.4);
      filter.frequency.exponentialRampToValueAtTime(320, when + 1.8);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.45, when + 0.25);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.0);
      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(dest);
      osc1.start(when); osc1.stop(when + 2.1);
      osc2.start(when); osc2.stop(when + 2.1);
    } catch { /* best effort */ }
  }

  /** Rhythmic mallet knock on construction sites */
  function constructionMallet(at) {
    ensure();
    if (!ctx || !enabled) return;
    try {
      const placed = at ? place(at.x, at.y, at.z, { ref: 10, rolloff: 1.3 }) : null;
      if (at && !placed) return;
      const dest = placed ? placed.node : master;
      const when = ctx.currentTime + (placed ? placed.dist / SPEED_OF_SOUND : 0);
      thump(dest, when, 280, 110, 0.08, 0.5);
      burst(dest, when, { type: 'bandpass', frequency: 520, Q: 1.8, level: 0.4, seconds: 0.05 });
    } catch { /* best effort */ }
  }

  // The app-wide mixer owns the player's mute preference; this context is not on it, so it
  // has to ask. Polled at the 2 Hz stats cadence rather than subscribed: PoAudioBus exposes
  // no change event, and a boolean read twice a second costs nothing.
  let lastGlobalMute = false;
  let lastGlobalVolume = 1;
  function syncGlobalMute() {
    const muted = window.PoAudioBus?.isMuted?.() === true;
    const volume = window.PoAudioBus?.getVolume?.() ?? 1;
    if (muted === lastGlobalMute && volume === lastGlobalVolume) return;
    lastGlobalMute = muted;
    lastGlobalVolume = volume;
    applyMasterGain();
  }

  function applyMasterGain() {
    if (!ctx || !master) return;
    const on = enabled && !lastGlobalMute;
    master.gain.setTargetAtTime(on ? MASTER_LEVEL * lastGlobalVolume : 0, ctx.currentTime, 0.05);
  }

  /** Noise burst shaped by `filter`; the shared skeleton of every stinger. */
  function burst(dest, when, { type = 'lowpass', frequency = 200, Q = 0.7, level = 0.4, attack = 0.01, seconds = 1 }) {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
    src.connect(f).connect(g).connect(dest);
    src.start(when); src.stop(when + seconds + 0.1);
  }

  function thump(dest, when, from, to, seconds, level) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, when);
    osc.frequency.exponentialRampToValueAtTime(to, when + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
    osc.connect(g).connect(dest);
    osc.start(when); osc.stop(when + seconds + 0.1);
  }

  /**
   * @param {string} kind 'lightning' | 'rockslide' | 'eruption'
   * @param {{x:number,y:number,z:number}} [at] world position; omitted, it plays centred
   *   and undelayed (the old behaviour, kept for callers that have no position).
   */
  function stinger(kind, at) {
    ensure();
    if (!ctx || !enabled) return;
    try {
      const placed = at ? place(at.x, at.y, at.z, { hrtf: true, wet: kind === 'rockslide' ? 0.5 : 0.35, ref: 14, rolloff: 0.9 }) : null;
      if (at && !placed) return;              // out of earshot entirely
      const dest = placed ? placed.node : master;
      const dist = placed ? placed.dist : 0;
      // The whole event is pushed back by its travel time. This is the single change that
      // makes a far-off storm read as far off rather than as a quieter near one.
      const when = ctx.currentTime + dist / SPEED_OF_SOUND;
      // Air absorbs treble with distance: a 200 m strike is a rumble, a 20 m strike cracks.
      const air = Math.max(0.12, 1 - dist / MAX_AUDIBLE);

      if (kind === 'lightning') {
        burst(dest, when, { type: 'highpass', frequency: 400 + 1000 * air, level: 0.5 * (0.4 + air * 0.6), seconds: 0.25 + (1 - air) * 0.6 });
        thump(dest, when + 0.02, 170, 55, 0.5 + (1 - air) * 1.6, 0.35);
      } else if (kind === 'rockslide') {
        burst(dest, when, { type: 'bandpass', frequency: 120 + 200 * air, Q: 0.7, level: 0.35, seconds: 1.3 });
      } else if (kind === 'eruption') {
        burst(dest, when, { type: 'lowpass', frequency: 70 + 60 * air, level: 0.5, attack: 0.08, seconds: 2.8 });
        thump(dest, when, 60, 40, 2.2, 0.25);
      }
    } catch { /* audio is best-effort */ }
  }

  /**
   * A positioned material impact — a log landing, a boulder settling, a body falling.
   * Driven by the renderer's prop-velocity watcher, which is why it is rate-limited here:
   * a rockslide can produce a dozen landings inside one frame and the ear wants a clatter,
   * not a wall.
   */
  function impact(material, x, y, z, intensity = 0.6) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    if (now - lastImpactAt < 0.035) return;
    lastImpactAt = now;
    try {
      const placed = place(x, y, z, { wet: 0.3, ref: 6, rolloff: 1.4 });
      if (!placed) return;
      const v = MATERIALS[material] ?? MATERIALS.wood;
      const i = Math.max(0.08, Math.min(1, intensity));
      const when = now + placed.dist / SPEED_OF_SOUND;
      const bus = ctx.createGain();
      bus.gain.value = 0.5 * i;
      bus.connect(placed.node);
      if (v.thump > 0) thump(bus, when, v.thump * (0.9 + i * 0.2), Math.max(28, v.thump * 0.55), v.decay, 1);
      burst(bus, when, { type: 'bandpass', frequency: v.noiseHz, Q: v.noiseQ, level: 0.9, attack: 0.002, seconds: v.noiseSec });
    } catch { /* audio is best-effort */ }
  }

  /**
   * Park the listener on the camera. Called every frame by the renderer — the WebAudio
   * listener has no interpolation of its own, so anything less than per-frame makes fast
   * flight sound like it is stepping.
   */
  function setPlayer(pose, dir) {
    if (!ctx) return;
    listener.x = pose.x; listener.y = pose.y; listener.z = pose.z;
    const l = ctx.listener;
    try {
      if (l.positionX) {
        const t = ctx.currentTime;
        // A short ramp rather than a jump: an instantaneous listener move produces an
        // audible click on every panner feeding it.
        l.positionX.setTargetAtTime(pose.x, t, 0.02);
        l.positionY.setTargetAtTime(pose.y, t, 0.02);
        l.positionZ.setTargetAtTime(pose.z, t, 0.02);
        l.forwardX.setTargetAtTime(dir.x, t, 0.02);
        l.forwardY.setTargetAtTime(dir.y, t, 0.02);
        l.forwardZ.setTargetAtTime(dir.z, t, 0.02);
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      } else {
        l.setPosition(pose.x, pose.y, pose.z);
        l.setOrientation(dir.x, dir.y, dir.z, 0, 1, 0);
      }
    } catch { /* older engines expose one path or the other, never neither */ }

    // The ambience field turns with the camera; the probe re-measures the room a few rays a frame.
    try {
      ambi?.setOrientation(dir.x, dir.y, dir.z);
      probe?.update(pose, { rightX: -dir.z, rightZ: dir.x });
      if (terrainRef && surfSrc && ctx.currentTime - seaAt > 0.5) { seaAt = ctx.currentTime; aimSurf(pose); }
    } catch { /* ambience is decoration */ }

    // Altitude is the one thing the wind should answer to: a god at 80 m is in it.
    if (windGain) {
      const high = Math.min(1, Math.max(0, (pose.y - 6) / 70));
      windGain.gain.setTargetAtTime(0.05 + high * 0.13 + windBoost, ctx.currentTime, 0.6);
    }
  }

  /**
   * Point the surf at the nearest sea: 16 headings marched across the heightfield for the first
   * sample below the waterline, nearer shores weighing more. Inland (nothing found) it is diffuse.
   */
  function aimSurf(pose) {
    let sx = 0, sz = 0, w = 0, nearest = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      for (let d = 6; d <= 140; d += 6) {
        if (terrainRef.heightAt(pose.x + cx * d, pose.z + cz * d) < -0.05) {
          const wk = 1 / (d + 10);
          sx += cx * wk; sz += cz * wk; w += wk;
          if (d < nearest) nearest = d;
          break;
        }
      }
    }
    if (w > 0 && Math.hypot(sx, sz) > 1e-4) {
      surfSrc.setDirection({ x: sx, y: 0, z: sz });
      surfSrc.setSpread(Math.max(0.25, Math.min(1, 0.35 + nearest / 200)));
    } else surfSrc.setSpread(1);
  }

  /** The renderer's terrain read API (heightAt) — the probe's rays and the surf's bearing march it. */
  function setTerrain(api) {
    terrainRef = api || null;
    probe = null;
    if (!ctx || !api) return;
    initProbe();
  }

  function initProbe() {
    if (!terrainRef || !ctx || !early) return;
    probe = createAcousticProbe({
      raycast: heightfieldRaycaster((x, z) => terrainRef.heightAt(x, z), { minHeight: 0, step: 1.5 }),
      rays: 28, perFrame: 3, maxDist: 70,
      apply(est) {
        // Taps are quiet next to the dry sound; scale with how enclosed the spot is.
        const k = 0.35 + 0.65 * (1 - est.openness);
        early.setTaps(est.taps.map((t) => ({ delay: t.delay, gain: t.gain * k, pan: t.pan })), { fadeMs: 350 });
        // Closed-in spots are wetter; summits and beaches drier than the island's baseline.
        wetOut?.gain.setTargetAtTime(0.34 * Math.max(0.5, Math.min(1.5, 0.45 + est.wetScale * 0.6)), ctx.currentTime, 0.6);
      },
    });
  }

  /** The camera went under the waterline (true) or came back up. */
  function setUnderwater(on) {
    if (!!on === under) return;
    under = !!on;
    if (!ctx || !underFilter) return;
    underFilter.frequency.setTargetAtTime(under ? 520 : 20000, ctx.currentTime, under ? 0.08 : 0.2);
  }

  /** One plain enveloped note into `dest` — the building block of the two voices below. */
  function note(dest, when, freq, seconds, level, type = 'sine') {
    const osc = ctx.createOscillator();
    osc.type = type; osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
    osc.connect(g).connect(dest);
    osc.start(when); osc.stop(when + seconds + 0.05);
  }

  /**
   * A watched creature has died: a soft bell from where it fell — two inharmonic partials,
   * the way a small bell rings — late by the sound's travel time like everything else.
   */
  function knell(at) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.7, ref: 16, rolloff: 0.9 });
      if (!placed) return;
      const when = arrival(placed);
      note(placed.node, when, 392, 3.2, 0.2);
      note(placed.node, when, 392 * 2.76, 1.6, 0.07);
    } catch { /* best effort */ }
  }

  /** A birth in a watched family: three quick rising notes. */
  function chime(at) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.5, ref: 12, rolloff: 1 });
      if (!placed) return;
      const when = arrival(placed);
      [523.25, 659.25, 783.99].forEach((f, i) => note(placed.node, when + i * 0.09, f, 0.7, 0.11, 'triangle'));
    } catch { /* best effort */ }
  }

  // Sonification: a population row as a chord, a run of rows as a melody.
  // One voice per species, each in its own octave and timbre (the same four the leitmotif
  // uses), and the pitch is how many of them there were — on a pentatonic scale, so any
  // year of any island is consonant with the one before it.
  const PENTA = [0, 2, 4, 7, 9];
  const SONIFY = [
    { base: 523.25, type: 'triangle' },   // rabbits: high pluck
    { base: 261.63, type: 'sine' },       // deer: flute
    { base: 130.81, type: 'sawtooth' },   // wolves: low reed
    { base: 196.0, type: 'square' },      // humans: mallet
  ];
  /**
   * @param {number[][]} rows each [rabbits, deer, wolves, humans]
   * @param {number} peak the count that maps to the top of the range
   * @returns {number} seconds the phrase lasts (0 when audio is off)
   */
  function sonify(rows, peak = 100) {
    ensure();
    if (!ctx || !enabled || !Array.isArray(rows) || rows.length === 0) return 0;
    try {
      const step = rows.length === 1 ? 0 : Math.max(0.07, Math.min(0.22, 6 / rows.length));
      const hold = rows.length === 1 ? 0.5 : step * 1.6;
      const top = Math.max(1, peak);
      const t0 = ctx.currentTime + 0.03;
      rows.slice(0, 240).forEach((row, i) => {
        for (let s = 0; s < 4; s++) {
          const n = row[s] | 0;
          if (n <= 0) continue;                       // an extinct species is a silence
          const k = Math.min(9, Math.floor((n / top) * 10));
          const semis = PENTA[k % 5] + 12 * Math.floor(k / 5);
          const v = SONIFY[s];
          note(master, t0 + i * step, v.base * Math.pow(2, semis / 12), hold, v.type === 'sine' || v.type === 'triangle' ? 0.07 : 0.03, v.type);
        }
      });
      return rows.length === 1 ? hold : rows.length * step + hold;
    } catch { return 0; }
  }

  // ── standing sounds: voices that stay, built once, moved and levelled afterwards ──────

  /** A positioned output that lasts: `out` is its level (0 until told), `at()` moves it. */
  function standing({ ref = 10, rolloff = 1, wet = 0.2 } = {}) {
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
    panner.refDistance = ref; panner.maxDistance = MAX_AUDIBLE; panner.rolloffFactor = rolloff;
    const out = ctx.createGain(); out.gain.value = 0;
    out.connect(panner); panner.connect(master);
    if (wet > 0 && reverbSend) { const send = ctx.createGain(); send.gain.value = wet; panner.connect(send).connect(reverbSend); }
    return {
      out, panner, x: 0, y: 0, z: 0, level: 0,
      /** `glide` seconds of travel; 0 is a jump (only ever done while silent). */
      at(x, y, z, glide = 0) {
        this.x = x; this.y = y; this.z = z;
        const t = ctx.currentTime;
        if (panner.positionX) {
          if (glide > 0) { panner.positionX.setTargetAtTime(x, t, glide); panner.positionY.setTargetAtTime(y, t, glide); panner.positionZ.setTargetAtTime(z, t, glide); }
          else { for (const [prm, v] of [[panner.positionX, x], [panner.positionY, y], [panner.positionZ, z]]) { prm.cancelScheduledValues(t); prm.setValueAtTime(v, t); } }
        } else panner.setPosition(x, y, z);
      },
      to(level, seconds = 0.12) { this.level = level; out.gain.setTargetAtTime(level, ctx.currentTime, seconds); },
    };
  }

  /** Noise through one filter into a gain: the body of every standing voice. */
  function bed(dest, type, frequency, Q = 0.7) {
    const src = loopNoise();
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = Q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    // Not all from the top of the buffer, or four fires are one fire four times as loud.
    src.start(0, Math.random() * 1.9);
    return { filter, gain };
  }

  /** A few seconds of pops at random times and sizes, looped: a fire's crackle, made once. */
  let crackleBuf = null;
  function crackleBuffer() {
    if (crackleBuf) return crackleBuf;
    const len = Math.floor(ctx.sampleRate * 3.7);
    crackleBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = crackleBuf.getChannelData(0);
    for (let at = 0; at < len;) {
      at += Math.floor(ctx.sampleRate * (0.012 + Math.random() * Math.random() * 0.2));
      const size = Math.random() * Math.random();
      const n = Math.floor(ctx.sampleRate * (0.002 + size * 0.012));
      for (let i = 0; i < n && at + i < len; i++) d[at + i] += (Math.random() * 2 - 1) * (0.25 + size * 0.75) * Math.pow(1 - i / n, 2.5);
    }
    return crackleBuf;
  }

  let fires = null;
  function fireVoices() {
    if (fires) return fires;
    fires = [];
    for (let i = 0; i < FIRE_VOICES; i++) {
      const v = standing({ ref: 9, rolloff: 1.05, wet: 0.22 });
      const roar = bed(v.out, 'lowpass', 190, 0.5);
      const hiss = bed(v.out, 'highpass', 3800, 0.4);
      const src = ctx.createBufferSource();
      src.buffer = crackleBuffer(); src.loop = true; src.playbackRate.value = 0.86 + i * 0.09;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 650;
      const crack = ctx.createGain(); crack.gain.value = 0;
      src.connect(hp).connect(crack).connect(v.out);
      src.start(0, Math.random() * 3);
      fires.push({ v, roar, hiss, crack, x: 0, y: 0, z: 0, group: null });
    }
    return fires;
  }

  /**
   * Where the island is burning: up to four groups from fireClusters.js
   * (`{ x, y, z, size, lava, camp, steam }`). A voice keeps its fire between calls; one that
   * has to move goes quiet where it is first, then starts up at the new place.
   */
  function setFires(groups) {
    if (!ctx || !enabled) return;
    if (!fires && !(groups?.length)) return;
    try {
      const slots = fireVoices();
      assignSlots(slots, (groups ?? []).slice(0, FIRE_VOICES));
      const t = ctx.currentTime;
      for (const s of slots) {
        const g = s.group;
        if (!g) { if (s.v.level > 0) s.v.to(0, 0.25); continue; }
        const far = Math.hypot(g.x - s.v.x, g.y + 1 - s.v.y, g.z - s.v.z) > 5;
        // Sounding somewhere else: go quiet there; the next call starts it here.
        if (far && s.v.level > 0) { s.v.to(0, 0.08); continue; }
        s.v.at(g.x, g.y + 1, g.z, far ? 0 : 0.2);
        s.x = g.x; s.z = g.z;
        const k = g.camp ? 0.18 : Math.min(1, 0.28 + g.size / 10);
        s.roar.filter.frequency.setTargetAtTime(g.lava ? 95 : 190, t, 0.3);
        s.roar.gain.gain.setTargetAtTime((g.lava ? 0.5 : 0.3) * k * (g.camp ? 0.4 : 1), t, 0.3);
        s.crack.gain.setTargetAtTime((g.lava ? 0.12 : 0.55) * (g.camp ? 0.55 : 0.4 + k * 0.6), t, 0.3);
        // Water on something hot: the sea on lava, rain on flame.
        s.hiss.gain.gain.setTargetAtTime(g.lava ? (g.steam ? 0.16 : 0) : rainNow * 0.14 * k, t, 0.4);
        s.v.to(1, 0.2);
      }
    } catch { /* best effort */ }
  }

  /**
   * Where the listener stands: `shore` 1 at the waterline falling to 0 well inland, `canopy`
   * 0..1 trees overhead, `wind` 0..1, `height` 0..1 how far above the ground it has flown.
   */
  function setPlace({ shore = 0.5, canopy = 0, wind = 0.1, height = 0 } = {}) {
    if (!ctx || !surfGain) return;
    const t = ctx.currentTime;
    const down = 1 - Math.min(1, Math.max(0, height)) * 0.85;
    const surf = (0.006 + 0.085 * smooth(Math.min(1, Math.max(0, shore)))) * down;
    surfGain.gain.setTargetAtTime(surf, t, 0.8);
    surfDepth.gain.setTargetAtTime(surf * 0.45, t, 0.8);
    canopyGain.gain.setTargetAtTime(Math.min(1, Math.max(0, canopy)) * (0.006 + Math.min(1, wind) * 0.05) * down, t, 0.7);
  }

  let wings = null;
  /**
   * Where the flocks are (`[{ x, y, z }]`, or null for "nowhere": chirps go back to the
   * un-placed bus). `gather` 0..1 is the dusk murmuration: its wings are a sound of their own.
   */
  function setBirds(points, gather = 0) {
    birdPoints = points?.length ? points : null;
    if (!ctx || !enabled) return;
    try {
      if (!wings) {
        if (gather < 0.05 || !birdPoints) return;
        const v = standing({ ref: 26, rolloff: 0.8, wet: 0.3 });
        const b = bed(v.out, 'bandpass', 760, 0.5);
        // A flutter, not a hiss: the level beats at about wingbeat rate.
        const lfo = ctx.createOscillator(); lfo.frequency.value = 12.5;
        const depth = ctx.createGain(); depth.gain.value = 0.05;
        lfo.connect(depth).connect(b.gain.gain); lfo.start();
        b.gain.gain.value = 0.11;
        wings = v;
      }
      const at = birdPoints?.[0];
      if (at) wings.at(at.x, at.y, at.z, wings.level > 0.01 ? 0.4 : 0);
      // The murmuration flies at last light, when the day's bird level is already low, so
      // its wings answer to the weather's hush only.
      wings.to(at ? Math.min(1, gather) * (1 - weatherHush) : 0, 0.8);
    } catch { /* best effort */ }
  }

  /**
   * Footfalls for one animal: `count` steps `interval` seconds apart from `at`, on `surface`
   * (a FOOT key). One panner for the run of steps, which is what lets six animals be heard
   * apart without a panner per step.
   */
  function footfalls(at, surface, count, interval, level = 0.5) {
    if (!ctx || !enabled || !at || count <= 0) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.12, ref: 4.5, rolloff: 1.6 });
      if (!placed || placed.dist > 60) return;
      const v = FOOT[surface] ?? FOOT.grass;
      const t0 = arrival(placed) + Math.random() * interval;
      const bus = ctx.createGain(); bus.gain.value = Math.max(0.05, Math.min(1, level)) * 0.5;
      bus.connect(placed.node);
      for (let k = 0; k < count; k++) {
        const when = t0 + k * interval + (Math.random() - 0.5) * interval * 0.2;
        const soft = 0.75 + Math.random() * 0.25;
        if (v.thump > 0) thump(bus, when, v.thump * (0.92 + Math.random() * 0.16), v.thump * 0.55, v.decay, soft);
        burst(bus, when, { type: 'bandpass', frequency: v.noiseHz * (0.9 + Math.random() * 0.2), Q: v.noiseQ, level: v.noise * soft, attack: 0.002, seconds: v.noiseSec });
      }
    } catch { /* best effort */ }
  }

  let herd = null;
  /** A herd on the run: one low rumble from its middle. `level` 0..1; null `at` lets it die away. */
  function setHerd(at, level = 0) {
    if (!ctx || !enabled) return;
    try {
      if (!herd) {
        if (!at || level < 0.03) return;
        const v = standing({ ref: 12, rolloff: 1.1, wet: 0.25 });
        const b = bed(v.out, 'lowpass', 120, 0.6);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 8.5;
        const depth = ctx.createGain(); depth.gain.value = 0.3;
        lfo.connect(depth).connect(b.gain.gain); lfo.start();
        b.gain.gain.value = 0.6;
        herd = v;
      }
      if (at) herd.at(at.x, at.y, at.z, herd.level > 0.01 ? 0.35 : 0);
      herd.to(at ? Math.min(1, level) : 0, 0.45);
    } catch { /* best effort */ }
  }

  let rolls = null;
  /**
   * Rock on the move across the ground: `[{ x, y, z, speed, small }]`, at most three, sent on
   * every sim frame (an empty list lets them die away). A boulder is a rumble whose pitch
   * rides its speed; loose stones are a rattle.
   */
  function setRolls(list) {
    if (!ctx || !enabled) return;
    if (!rolls && !(list?.length)) return;
    try {
      if (!rolls) {
        rolls = [];
        for (let i = 0; i < ROLL_VOICES; i++) {
          const v = standing({ ref: 7, rolloff: 1.2, wet: 0.35 });
          const b = bed(v.out, 'bandpass', 120, 0.8);
          const lfo = ctx.createOscillator(); lfo.frequency.value = 9;
          const depth = ctx.createGain(); depth.gain.value = 0.25;
          lfo.connect(depth).connect(b.gain.gain); lfo.start();
          b.gain.gain.value = 0.55;
          rolls.push({ v, b, lfo, x: 0, y: 0, z: 0, group: null });
        }
      }
      assignSlots(rolls, (list ?? []).slice(0, ROLL_VOICES));
      const t = ctx.currentTime;
      for (const s of rolls) {
        const g = s.group;
        if (!g) { if (s.v.level > 0) s.v.to(0, 0.1); continue; }
        s.v.at(g.x, g.y, g.z, s.v.level > 0.01 ? 0.06 : 0);
        s.x = g.x; s.z = g.z;
        const sp = Math.min(1, g.speed / 10);
        s.b.filter.frequency.setTargetAtTime(g.small ? 1500 + sp * 1400 : 85 + sp * 110, t, 0.06);
        s.b.filter.Q.setTargetAtTime(g.small ? 1.6 : 0.8, t, 0.06);
        s.lfo.frequency.setTargetAtTime(g.small ? 19 + sp * 14 : 5 + sp * 9, t, 0.06);
        s.v.to((g.small ? 0.22 : 0.75) * (0.25 + sp * 0.75), 0.07);
      }
    } catch { /* best effort */ }
  }

  /** A tree going over: wood fibres letting go in jerks, slower as it leans. */
  function creak(at) {
    if (!ctx || !enabled || !at) return;
    try {
      const placed = place(at.x, at.y, at.z, { wet: 0.3, ref: 9, rolloff: 1.2 });
      if (!placed) return;
      const when = arrival(placed);
      const len = 0.95;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(74, when); osc.frequency.exponentialRampToValueAtTime(46, when + len);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 7;
      f.frequency.setValueAtTime(520, when); f.frequency.linearRampToValueAtTime(980, when + len);
      // Stick and slip: a square gate that slows as the trunk comes down.
      const gate = ctx.createOscillator(); gate.type = 'square';
      gate.frequency.setValueAtTime(19, when); gate.frequency.exponentialRampToValueAtTime(6.5, when + len);
      const gateDepth = ctx.createGain(); gateDepth.gain.value = 0.5;
      const chop = ctx.createGain(); chop.gain.value = 0.5;
      gate.connect(gateDepth).connect(chop.gain);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(0.5, when + 0.08);
      env.gain.setValueAtTime(0.5, when + len * 0.7); env.gain.exponentialRampToValueAtTime(0.0001, when + len);
      osc.connect(f).connect(chop).connect(env).connect(placed.node);
      for (const o of [osc, gate]) { o.start(when); o.stop(when + len + 0.05); }
      burst(placed.node, when + len * 0.82, { type: 'bandpass', frequency: 1900, Q: 1.4, level: 0.3, attack: 0.002, seconds: 0.09 });
    } catch { /* best effort */ }
  }

  return {
    ensure, setTerrain,
    setFires, setPlace, setBirds, footfalls, setHerd, setRolls, creak,
    /** What is sounding now, for a harness: fire voices up, and the bed levels. */
    get standing() {
      return {
        fires: fires ? fires.filter(s => s.v.level > 0).length : 0,
        rolls: rolls ? rolls.filter(s => s.v.level > 0).length : 0,
        herd: herd?.level ?? 0, wings: wings?.level ?? 0,
        surf: surfGain?.gain.value ?? 0, canopy: canopyGain?.gain.value ?? 0, placedBirds: !!birdPoints,
      };
    },
    setDay,
    setWeather,
    setUnderwater, knell, chime, sonify,
    stinger,
    impact,
    tribalDrum,
    warHorn,
    constructionMallet,
    howl, bark, footThump, drumBar,
    setPlayer,
    /**
     * Play a recorded clip (voices.js): from a world point `at` ({ x, y, z }) through the
     * positional path, or straight to the master when `at` is null. Returns the seconds it
     * will take, or 0 if nothing was started (no context, muted, out of earshot).
     */
    playClip(buffer, at = null, { when = 0, level = 0.9, wet = 0.3 } = {}) {
      if (!ctx || !enabled || !master || !buffer) return 0;
      try {
        let out = master;
        if (at) {
          // A voice carries: a wider reference distance than an impact, and the HRTF model,
          // because there is only ever one of these at a time.
          const placed = place(at.x, at.y, at.z, { hrtf: true, wet, ref: 12, rolloff: 0.9 });
          if (!placed) return 0;
          out = placed.node;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = level;
        src.connect(gain).connect(out);
        src.start(Math.max(ctx.currentTime, when));
        return buffer.duration;
      } catch { return 0; }
    },
    /** A positioned output node for voices built elsewhere (leitmotif.js); null out of earshot. */
    placeNode(x, y, z, opts) { if (!ctx || !enabled) return null; try { return place(x, y, z, opts); } catch { return null; } },
    get speedOfSound() { return SPEED_OF_SOUND; },
    /** music.js builds its own graph on this context and mixes into the same master. */
    get context() { return ctx; },
    get musicDestination() { return master; },
    setEnabled(on) {
      enabled = !!on;
      applyMasterGain();
    },
    get enabled() { return enabled; },
    dispose() {
      try { ctx?.close(); } catch { /* already gone */ }
      try { ambi?.dispose(); early?.dispose(); } catch { /* gone */ }
      ambi = null; early = null; probe = null; surfSrc = null; wetOut = null;
      ctx = null; master = null; reverbSend = null;
      fires = null; rolls = null; herd = null; wings = null; crackleBuf = null; surfGain = null; surfDepth = null; canopyGain = null;
    },
  };
}
