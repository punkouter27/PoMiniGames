// audio.js — procedural Web Audio for PoMarbleRace. No asset files: everything is synthesized
// from oscillators and noise buffers.
//
// The race used to be almost silent — three one-shot sounds, and impact clinks gated so hard
// that most of a run had no audio at all. The soundscape is now continuous: a rolling bed that
// tracks the leader's speed, a crowd that swells toward the finish, and one-shots layered on
// top (countdown, gun, boost, overtake, finish, result).
//
// ── Graph (SOUND #7) ──
// Everything used to sum straight into one `master` gain, which meant the gun, both beds and a
// burst of clinks could all land in the same window with nothing to catch them — the output
// clipped. There are now two buses feeding a compressed master, plus a reverb send:
//
//     beds (roll, crowd, drone) → bedBus ─┐
//     one-shots (clink, whoosh…) → sfxBus ─┼→ master → compressor → destination
//                                  │       │
//                                  └→ reverbSend → convolver ─┘
//
// bedBus is DUCKED by `duck()` when something important fires (gun, sting, finish), so the beds
// step out of the way of the moment instead of fighting it. Mute is still one gain on `master`,
// so it stays a single write rather than a flag checked in eight places.
//
// ── Spatialization (SOUND #9) ──
// One-shots accept an optional `cue` — `{ pan, gain }` from scene.audioCue(), which projects a
// world position against the live camera. A StereoPannerNode is used rather than a full HRTF
// PannerNode: it is dramatically cheaper per node, and the HRTF detail is inaudible on the
// laptop speakers most players use.
//
// ── Rival marbles (spatial) ──
// The continuous half of the field is positional too: the RIVAL_VOICES marbles nearest the
// camera (not the one it follows, which owns the rolling bed) each roll through their own
// PannerNode against an AudioListener riding the camera, so a marble coming up behind is heard
// before it is seen. HRTF on the high quality tier, equal-power below. The voices sit on the bed
// bus, so they duck and mute with the beds. See updateRivals.
//
// ── Impacts (SOUND #8, physics-driven) ──
// Impacts are PRE-RENDERED through an OfflineAudioContext at startup into a bank of AudioBuffers
// per MATERIAL (see IMPACT_MATERIALS): a glass marble striking another marble rings high and
// inharmonic, striking a spinner rings metallic, a rumble band is mostly noise. At play time the
// collision's energy sets level, pitch, brightness and how much of the ring is heard, so a graze
// and a smash off the same peg are different sounds. A small voice pool (MAX_IMPACT_VOICES)
// keeps a pile-up from stacking dozens of sources: when it is full, a hit only gets in by being
// harder than the softest one playing.
//
// ── Slip (friction hiss) ──
// A marble that rolls cleanly has |v| = |ω|·r. When it skids — off a kicker, on ice, braking on a
// strip — the two disagree, and that mismatch drives a filtered-noise hiss layered over the
// rolling bed. Read off the camera marble's own body every frame in updateRivals, so no caller
// has to compute it.
//
// ── Reverb per map (setReverb) ──
// Each map's registry entry may carry `reverb: { decay, wet, tone, echo, zones }`. The impulse
// response is rebuilt for the map's decay; the wet level and the tone (a lowpass on the return)
// glide between the map's open value and any `zones` — spans of the course, as fractions of its
// length, that are enclosed (Playground Run's crawl-throughs and drop well). A canyon `echo` adds
// a feedback slapback on the return.
//
// ── Stings + announcer ──
// Lead changes, a photo finish and you entering the top 10 / top 3 each get a short synthesized
// sting. An optional spoken announcer (speechSynthesis, OFF by default, store.js pref
// 'announcer') says the same moments in words. It never queues: a newer line replaces one still
// waiting, because a call about a lead that has already changed again is worse than silence.

import { readPref } from './store.js';

const NOISE_SECONDS = 2;

// #8 — how many impact variants to pre-render per material, and how long each is.
const IMPACT_VARIANTS = 3;
const IMPACT_SECONDS = 0.4;
// Simultaneous impact voices. A pile-up past this keeps only the hardest hits.
const MAX_IMPACT_VOICES = 8;
// Impact speed (u/s) that counts as a full-strength hit.
const IMPACT_FULL = 22;

// The material matrix: what a glass marble sounds like against each cannon material
// (physics.js). `modes` are partial frequency ratios over f0 — inharmonic ratios are what make
// glass and metal ring rather than buzz; `decay` the ring time; `click` the level of the noise
// transient and `hp` its highpass; `level` a per-material trim.
const IMPACT_MATERIALS = {
  marble: { f0: 2100, modes: [1, 2.76, 5.4], decay: 0.11, click: 0.5, hp: 3200, level: 0.8 },
  surface: { f0: 360, modes: [1, 1.58], decay: 0.07, click: 0.35, hp: 1400, level: 1.0 },
  obstacle: { f0: 880, modes: [1, 2.41, 3.93], decay: 0.16, click: 0.4, hp: 2200, level: 0.9 },
  rumble: { f0: 210, modes: [1, 1.9], decay: 0.05, click: 0.8, hp: 600, level: 0.9 },
  bump: { f0: 260, modes: [1, 1.7], decay: 0.08, click: 0.55, hp: 900, level: 1.0 },
  spinner: { f0: 540, modes: [1, 1.98, 3.07, 4.2], decay: 0.26, click: 0.3, hp: 2600, level: 0.85 },
  ice: { f0: 1500, modes: [1, 2.2, 3.6], decay: 0.15, click: 0.25, hp: 4000, level: 0.75 },
};

// Slip hiss: mismatch (u/s) at which it is fully on, and its ceiling level.
const SLIP_FULL = 18;
const SLIP_GAIN = 0.11;

// Reverb defaults when a map says nothing.
const REVERB_DEFAULT = { decay: 1.5, wet: 0.22, tone: 6000 };

// Stings: a lead change is called at most this often (s).
const LEAD_CHANGE_GAP = 3;

// #10 — impulse response length for the convolution reverb.
const IR_SECONDS = 1.5;

// Rival rolling voices: how many, and the distance model they share (world units).
const RIVAL_VOICES = 3;
const RIVAL_REF = 6, RIVAL_MAX = 140;

// ── Surface-aware rolling ──
// The rolling bed follows the camera's marble and the material it is actually touching
// (game.js reads the contact list after each step): filter shape, level and a tremolo
// rate/depth per surface. The
// tremolo is what makes a rumble band or a washboard read as ridges rather than as louder noise.
// `air` is silence — a marble in flight makes no rolling sound, which sells the jumps.
const SURFACES = {
  surface: { type: 'bandpass', lo: 140, span: 620, q: 1.1, gain: 1.0, trem: 0, rate: 0 },
  obstacle: { type: 'bandpass', lo: 180, span: 700, q: 1.4, gain: 1.0, trem: 0, rate: 0 },
  rumble: { type: 'lowpass', lo: 90, span: 300, q: 2.4, gain: 1.7, trem: 0.55, rate: 22 },
  bump: { type: 'bandpass', lo: 120, span: 380, q: 2.0, gain: 1.5, trem: 0.85, rate: 9 },
  ice: { type: 'highpass', lo: 2200, span: 2400, q: 0.7, gain: 0.8, trem: 0, rate: 0 },
  boost: { type: 'bandpass', lo: 320, span: 1100, q: 0.9, gain: 1.35, trem: 0.2, rate: 34 },
  air: { type: 'bandpass', lo: 140, span: 620, q: 1.1, gain: 0, trem: 0, rate: 0 },
};

export function createAudio() {
  let ctx = null;
  let muted = false;
  let lastClink = 0;
  let lastOvertake = 0;

  // Graph nodes, built lazily on first ensure(). Null until then.
  let master = null, comp = null, bedBus = null, sfxBus = null;
  let reverbSend = null, convolver = null;
  let rollSrc = null, rollFilter = null, rollGain = null;
  let rollTrem = null, tremOsc = null, tremDepth = null, rollKind = 'surface';
  let crowdSrc = null, crowdFilter = null, crowdGain = null;
  let droneOscs = null, droneFilter = null, droneGain = null, droneBase = null;
  let noiseBuf = null;
  let impactBank = null;      // #8 — { [material]: AudioBuffer[] }, filled asynchronously
  let impactVoices = [];      // [{ src, gain, energy }] currently sounding
  let slipSrc = null, slipFilter = null, slipGain = null;
  let wetTone = null, echoDelay = null, echoFb = null, echoSend = null;
  let reverb = { ...REVERB_DEFAULT, zones: null, echo: null };
  let trackLength = 0;
  let zoneMix = -1;           // last applied zone blend, so a held value costs nothing
  let announcerOn = (() => { try { return !!readPref('announcer'); } catch { return false; } })();
  let lastLeadCall = -1e9;
  let rivals = null;          // [{ src, filter, gain, panner }] — built with the beds
  const listenAt = new Float32Array(6).fill(NaN);

  function makeNoise(c) {
    const buf = c.createBuffer(1, c.sampleRate * NOISE_SECONDS, c.sampleRate);
    const d = buf.getChannelData(0);
    // Brownian-ish noise: cheaper than true pink, and the low-frequency weighting is what
    // makes it read as "rumble" and "crowd" rather than as a hiss.
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  // ── #10 Convolution reverb ────────────────────────────────────────────
  // A synthetic impulse response: stereo decaying noise with a slight inter-channel difference
  // so the tail has width. Written straight into an AudioBuffer — synchronous, a few ms, and
  // zero asset files. One ConvolverNode serves the whole game.
  function makeImpulseResponse(c, seconds = IR_SECONDS) {
    const len = Math.floor(c.sampleRate * Math.max(0.3, seconds));
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Exponential decay with a short pre-delay ramp, so the tail sounds like a space rather
        // than a noise burst pasted on the end of every sound.
        const env = Math.pow(1 - t, 2.6) * Math.min(1, t * 60);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // ── #8 Pre-rendered impact bank, per material ─────────────────────────
  // IMPACT_VARIANTS renders per IMPACT_MATERIALS entry, once, through an OfflineAudioContext:
  // modal partials (one decaying sine per mode, higher modes quieter and shorter, each variant
  // detuned a little) over a short filtered-noise transient. Playing one is a single
  // AudioBufferSourceNode — no oscillator graph built and torn down per hit. Until the render
  // resolves, playImpact falls back to a synthesized clink so a race never starts silent.
  async function makeImpactBank(sampleRate) {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) return null;
    const len = Math.ceil(sampleRate * IMPACT_SECONDS);
    const names = Object.keys(IMPACT_MATERIALS);
    const jobs = [];
    for (const name of names) {
      const mat = IMPACT_MATERIALS[name];
      for (let v = 0; v < IMPACT_VARIANTS; v++) {
        const oc = new OfflineCtx(1, len, sampleRate);
        const out = oc.createGain();
        out.connect(oc.destination);
        const detune = 1 + (v - (IMPACT_VARIANTS - 1) / 2) * 0.045;
        mat.modes.forEach((ratio, k) => {
          const f = mat.f0 * ratio * detune;
          if (f > sampleRate / 2.2) return;
          const dec = mat.decay / (1 + k * 0.6);
          const osc = oc.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, 0);
          // A slight downward glide: a struck body sags in pitch as it stops ringing.
          osc.frequency.exponentialRampToValueAtTime(f * 0.97, dec);
          const g = oc.createGain();
          g.gain.setValueAtTime(0.0001, 0);
          g.gain.exponentialRampToValueAtTime(0.8 / (1 + k * 0.9), 0.002);
          g.gain.exponentialRampToValueAtTime(0.0001, dec);
          osc.connect(g).connect(out);
          osc.start(0);
          osc.stop(dec + 0.01);
        });
        // Transient: the strike itself. Without it the hit reads as a bell, not a contact.
        const nb = oc.createBuffer(1, Math.ceil(sampleRate * 0.025), sampleRate);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
        const nsrc = oc.createBufferSource();
        nsrc.buffer = nb;
        const hp = oc.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = mat.hp * detune;
        const ng = oc.createGain();
        ng.gain.setValueAtTime(mat.click, 0);
        ng.gain.exponentialRampToValueAtTime(0.0001, 0.03);
        nsrc.connect(hp).connect(ng).connect(out);
        nsrc.start(0);
        jobs.push(oc.startRendering().then((buf) => [name, buf]));
      }
    }
    try {
      const bank = {};
      for (const [name, buf] of await Promise.all(jobs)) (bank[name] ||= []).push(buf);
      return bank;
    } catch { return null; }
  }

  function buildBeds(c) {
    noiseBuf = makeNoise(c);

    // Rolling bed: noise through a bandpass whose frequency rides marble speed.
    rollSrc = c.createBufferSource();
    rollSrc.buffer = noiseBuf;
    rollSrc.loop = true;
    rollFilter = c.createBiquadFilter();
    rollFilter.type = 'bandpass';
    rollFilter.frequency.value = 220;
    rollFilter.Q.value = 1.1;
    rollGain = c.createGain();
    rollGain.gain.value = 0;
    // Tremolo: an LFO added onto a unity gain. Depth 0 leaves the bed untouched.
    rollTrem = c.createGain();
    rollTrem.gain.value = 1;
    tremOsc = c.createOscillator();
    tremOsc.type = 'triangle';
    tremOsc.frequency.value = 12;
    tremDepth = c.createGain();
    tremDepth.gain.value = 0;
    tremOsc.connect(tremDepth).connect(rollTrem.gain);
    tremOsc.start();
    rollSrc.connect(rollFilter).connect(rollGain).connect(rollTrem).connect(bedBus);
    rollSrc.start();

    // Slip hiss: the same noise read from another offset, highpassed into a skid. Gain 0 until a
    // marble actually slides (updateSlip).
    slipSrc = c.createBufferSource();
    slipSrc.buffer = noiseBuf;
    slipSrc.loop = true;
    slipFilter = c.createBiquadFilter();
    slipFilter.type = 'bandpass';
    slipFilter.frequency.value = 2600;
    slipFilter.Q.value = 0.8;
    slipGain = c.createGain();
    slipGain.gain.value = 0;
    slipSrc.connect(slipFilter).connect(slipGain).connect(bedBus);
    slipSrc.start(0, NOISE_SECONDS * 0.37);

    // Crowd bed: the same noise, lowpassed hard and swelled as the race resolves.
    crowdSrc = c.createBufferSource();
    crowdSrc.buffer = noiseBuf;
    crowdSrc.loop = true;
    crowdFilter = c.createBiquadFilter();
    crowdFilter.type = 'lowpass';
    crowdFilter.frequency.value = 900;
    crowdFilter.Q.value = 0.7;
    crowdGain = c.createGain();
    crowdGain.gain.value = 0;
    crowdSrc.connect(crowdFilter).connect(crowdGain).connect(bedBus);
    crowdSrc.start();

    // #10 TENSION DRONE — the "background audio node". Three detuned saws through a lowpass.
    // Gain and cutoff are driven by how close the race is to resolving (see updateBeds), so it
    // rises under the crowd through the whole race and RESOLVES at the line (see resolveDrone),
    // giving the ending a musical release rather than only a chime.
    //
    // A2 (110 Hz) root with a fifth above it. Detuning the unisons by a few cents is what stops
    // three oscillators from summing into one sterile tone.
    droneFilter = c.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    droneFilter.Q.value = 3.2;
    droneGain = c.createGain();
    droneGain.gain.value = 0;
    droneFilter.connect(droneGain).connect(bedBus);
    buildRivals(c);

    droneOscs = [];
    droneBase = [];
    for (const [freq, detune] of [[110, -7], [110, 9], [164.81, 4]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(droneFilter);
      o.start();
      droneOscs.push(o);
      droneBase.push(freq);
    }
  }

  // Rival rolling voices: the bed's noise, each read from its own offset so two marbles never
  // phase into one, through a bandpass and a PannerNode. Gains start at 0; updateRivals drives them.
  function buildRivals(c) {
    rivals = [];
    if (!c.createPanner) return;
    const hrtf = window.PoQuality?.tier?.() === 'high';
    for (let i = 0; i < RIVAL_VOICES; i++) {
      const src = c.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 240;
      filter.Q.value = 1.3;
      const gain = c.createGain();
      gain.gain.value = 0;
      const panner = c.createPanner();
      panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = RIVAL_REF;
      panner.maxDistance = RIVAL_MAX;
      panner.rolloffFactor = 1.2;
      src.connect(filter).connect(gain).connect(panner).connect(bedBus);
      src.start(0, (i + 1) * NOISE_SECONDS / (RIVAL_VOICES + 1));
      rivals.push({ src, filter, gain, panner });
    }
  }

  function setPos(param, x, y, z, now) {
    param.x.setTargetAtTime(x, now, 0.04);
    param.y.setTargetAtTime(y, now, 0.04);
    param.z.setTargetAtTime(z, now, 0.04);
  }

  // The listener rides the camera: forward = -Z and up = +Y of its world matrix. Written only
  // when it moved, so a held shot costs nothing. The listener belongs to the shared context, so
  // dispose() puts it back at the origin.
  function placeListener(camera, now) {
    const L = ctx.listener;
    const e = camera.matrixWorld.elements;
    const p = camera.position;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    if (Math.abs(listenAt[0] - p.x) + Math.abs(listenAt[1] - p.y) + Math.abs(listenAt[2] - p.z)
      + Math.abs(listenAt[3] - fx) + Math.abs(listenAt[4] - fy) + Math.abs(listenAt[5] - fz) < 1e-3) return;
    listenAt[0] = p.x; listenAt[1] = p.y; listenAt[2] = p.z;
    listenAt[3] = fx; listenAt[4] = fy; listenAt[5] = fz;
    if (L.positionX) {
      setPos({ x: L.positionX, y: L.positionY, z: L.positionZ }, p.x, p.y, p.z, now);
      setPos({ x: L.forwardX, y: L.forwardY, z: L.forwardZ }, fx, fy, fz, now);
      setPos({ x: L.upX, y: L.upY, z: L.upZ }, e[4], e[5], e[6], now);
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(fx, fy, fz, e[4], e[5], e[6]);
    }
  }

  function resetListener() {
    const L = ctx && ctx.listener;
    if (!L) return;
    try {
      if (L.positionX) {
        L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0;
        L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
        L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
      } else {
        L.setPosition(0, 0, 0);
        L.setOrientation(0, 0, -1, 0, 1, 0);
      }
    } catch { /* closed context */ }
  }

  // Per frame, after updateBeds. `marbles` is the field, `focus` the marble on camera.
  // Picks the RIVAL_VOICES nearest still-racing marbles and parks one voice on each.
  const nearest = [];
  function updateRivals(camera, marbles, focus, racing) {
    if (!ctx) return;
    updateSlip(focus, racing);
    updateZones(focus);
    if (!rivals || !rivals.length || !camera) return;
    const now = ctx.currentTime;
    placeListener(camera, now);
    nearest.length = 0;
    if (racing && marbles) {
      const c = camera.position;
      for (const m of marbles) {
        if (m === focus || m.finished || m.eliminated || !(m.speed > 1)) continue;
        const p = m.mesh.position;
        const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2;
        if (d > RIVAL_MAX * RIVAL_MAX) continue;
        let i = nearest.length;
        while (i > 0 && nearest[i - 1].d > d) i--;
        if (i >= RIVAL_VOICES) continue;
        nearest.splice(i, 0, { m, d });
        if (nearest.length > RIVAL_VOICES) nearest.pop();
      }
    }
    for (let i = 0; i < rivals.length; i++) {
      const r = rivals[i], n = nearest[i];
      if (!n) { r.gain.gain.setTargetAtTime(0, now, 0.1); continue; }
      const p = n.m.mesh.position;
      const v = Math.min(1, n.m.speed / 45);
      if (r.panner.positionX) setPos({ x: r.panner.positionX, y: r.panner.positionY, z: r.panner.positionZ }, p.x, p.y, p.z, now);
      else r.panner.setPosition(p.x, p.y, p.z);
      r.gain.gain.setTargetAtTime(0.02 + v * 0.09, now, 0.08);
      r.filter.frequency.setTargetAtTime(160 + v * 560, now, 0.08);
    }
  }

  // ── Slip ──
  // |v| − |ω|·r for the camera marble. A body with no spin at all is an online guest's marble
  // (no physics there; the roll is faked from distance), and an airborne one makes no contact
  // noise at all — both stay silent rather than hissing at full speed.
  function updateSlip(m, racing) {
    if (!slipGain) return;
    const now = ctx.currentTime;
    let slip = 0;
    if (racing && m && !m.finished && !m.eliminated && m.body && rollKind !== 'air') {
      const w = m.body.angularVelocity, v = m.body.velocity;
      const spin = Math.hypot(w.x, w.y, w.z);
      if (spin > 0) slip = Math.abs(Math.hypot(v.x, v.y, v.z) - spin * (m.radius || 1));
    }
    const k = Math.min(1, Math.max(0, (slip - 2) / SLIP_FULL));
    // Ice skids are the point of ice: let them through louder.
    const trim = rollKind === 'ice' ? 1.4 : 1;
    slipGain.gain.setTargetAtTime(k * k * SLIP_GAIN * trim, now, 0.05);
    slipFilter.frequency.setTargetAtTime(1800 + k * 3200, now, 0.06);
  }

  // ── Reverb ──
  // Wire the return path once: convolver → tone lowpass → (optional slapback) → master.
  function buildReverb(c) {
    convolver = c.createConvolver();
    convolver.buffer = makeImpulseResponse(c, reverb.decay);
    reverbSend = c.createGain();
    reverbSend.gain.value = reverb.wet;
    wetTone = c.createBiquadFilter();
    wetTone.type = 'lowpass';
    wetTone.frequency.value = reverb.tone;
    echoDelay = c.createDelay(1.0);
    echoFb = c.createGain();
    echoSend = c.createGain();
    sfxBus.connect(reverbSend).connect(convolver).connect(wetTone).connect(master);
    wetTone.connect(echoSend).connect(echoDelay).connect(master);
    echoDelay.connect(echoFb).connect(echoDelay);
    applyEcho();
  }

  function applyEcho() {
    if (!echoDelay) return;
    const e = reverb.echo;
    echoDelay.delayTime.value = e ? e.time : 0.2;
    echoFb.gain.value = e ? Math.min(0.6, e.feedback) : 0;
    echoSend.gain.value = e ? (e.level ?? 0.5) : 0;
  }

  // The map's reverb character. `cfg` is the registry's `reverb` (may be undefined → defaults);
  // `length` the course length, which `zones` fractions are measured against.
  function setReverb(cfg, length) {
    const next = { ...REVERB_DEFAULT, zones: null, echo: null, ...(cfg || {}) };
    const decayChanged = next.decay !== reverb.decay;
    reverb = next;
    trackLength = length || 0;
    zoneMix = -1;
    if (!ctx || !convolver) return;
    // A new IR is only built when the decay actually changes: re-assigning a convolver buffer
    // mid-tail clicks, so a same-map rebuild (every race) leaves it alone.
    if (decayChanged) convolver.buffer = makeImpulseResponse(ctx, reverb.decay);
    const now = ctx.currentTime;
    reverbSend.gain.setTargetAtTime(reverb.wet, now, 0.2);
    wetTone.frequency.setTargetAtTime(reverb.tone, now, 0.2);
    applyEcho();
  }

  // Glide wet/tone toward an enclosed zone's values while the camera marble is inside it.
  function updateZones(m) {
    const zones = reverb.zones;
    if (!zones || !zones.length || !reverbSend || !trackLength || !m) return;
    const f = m.s / trackLength;
    const z = zones.find((q) => f >= q.from && f <= q.to);
    const mix = z ? zones.indexOf(z) : -2;
    if (mix === zoneMix) return;
    zoneMix = mix;
    const now = ctx.currentTime;
    reverbSend.gain.setTargetAtTime(z ? z.wet : reverb.wet, now, 0.15);
    wetTone.frequency.setTargetAtTime(z ? z.tone : reverb.tone, now, 0.15);
  }

  // #10 — put the drone back to its root pitch for a new race. The audio context is built ONCE
  // and survives every track regeneration (game.js _nextTrack rebuilds the world, not the
  // sound), so without this the fifth that resolveDrone() steps up by would compound race after
  // race until the drone was a whistle.
  function resetDrone() {
    if (!ctx || !droneOscs) return;
    const now = ctx.currentTime;
    droneOscs.forEach((o, i) => {
      o.frequency.cancelScheduledValues(now);
      o.frequency.setValueAtTime(droneBase[i], now);
    });
    droneGain.gain.cancelScheduledValues(now);
    droneGain.gain.setValueAtTime(0, now);
  }

  function ensure() {
    if (!ctx) {
      // Shared context only (js/audioBus.js) — one AudioContext for the whole app, so dispose()
      // never closes it. No shared bus, no sound: a private context would ignore the app's mute
      // and volume. ensure() then returns null, which every caller treats as silence, and the
      // next call tries the bus again.
      const bus = window.PoAudioBus;
      const shared = bus && typeof bus.contextSync === 'function' ? bus.contextSync() : null;
      const sfxOut = shared && typeof bus.busSync === 'function' ? bus.busSync('sfx') : null;
      if (!shared || !sfxOut) return null;
      ctx = shared;

      // #7 — master → compressor → the app's sfx bus. The compressor is the safety net that the
      // old single-gain graph never had: it catches the gun, a sting and a burst of impacts
      // landing together instead of letting them sum past full scale.
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(comp).connect(sfxOut);

      // Two buses so the beds can be ducked independently of the one-shots.
      bedBus = ctx.createGain();
      bedBus.gain.value = 1;
      bedBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);

      // #10 — reverb on a SEND, not inline, so the dry signal stays present and only a
      // controlled amount of the one-shot bus is wetted. One convolver for the whole game.
      buildReverb(ctx);

      buildBeds(ctx);

      // #8 — kick off the offline render. Nothing waits on it; playClink uses the synthesized
      // fallback until the bank lands.
      makeImpactBank(ctx.sampleRate).then((bank) => { impactBank = bank; }).catch(() => { });
    }
    // resume() rejects if dispose() closes the context first (a fast engine restart); that is fine.
    if (ctx.state === 'suspended') ctx.resume().catch(() => { });
    return ctx;
  }

  // #7 — pull the beds down briefly so a one-shot owns the moment, then let them back up.
  function duck(amount = 0.35, hold = 0.25) {
    if (!ctx || !bedBus) return;
    const now = ctx.currentTime;
    bedBus.gain.cancelScheduledValues(now);
    bedBus.gain.setTargetAtTime(amount, now, 0.02);
    bedBus.gain.setTargetAtTime(1, now + hold, 0.22);
  }

  // #9 — wire a one-shot's output through an optional stereo pan + distance gain. Returns the
  // node a source should connect INTO. With no cue this is just the bus, so nothing is spent on
  // sounds that have no position (countdown pips, result stings).
  function cueNode(cue) {
    if (!cue || !ctx.createStereoPanner) return sfxBus;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, cue.pan || 0));
    const g = ctx.createGain();
    g.gain.value = cue.gain == null ? 1 : cue.gain;
    p.connect(g).connect(sfxBus);
    return p;
  }

  // ── Continuous beds ───────────────────────────────────────────────────
  // Called every frame from the game loop. `speed` is the focused marble's speed and `surface` a
  // SURFACES key for what it is touching; `nearFinish` (0..1) drives the crowd and the drone.
  function updateBeds(speed, nearFinish, racing, surface) {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    const v = Math.min(1, Math.max(0, speed / 45));
    const sf = SURFACES[surface] || SURFACES.surface;
    // A filter TYPE can't be ramped, so it only changes on a surface change (a click there is
    // masked by the change itself); everything continuous is ramped.
    if (surface !== rollKind && SURFACES[surface]) {
      rollKind = surface;
      rollFilter.type = sf.type;
      rollFilter.Q.setTargetAtTime(sf.q, now, 0.03);
      tremOsc.frequency.setTargetAtTime(sf.rate || 12, now, 0.03);
    }
    // Ramp rather than set: a per-frame setValueAtTime on a gain is a zipper-noise generator.
    const rollTarget = racing ? (0.02 + v * 0.16) * sf.gain : 0;
    rollGain.gain.setTargetAtTime(rollTarget, now, surface === 'air' ? 0.03 : 0.08);
    rollFilter.frequency.setTargetAtTime(sf.lo + v * sf.span, now, 0.08);
    tremDepth.gain.setTargetAtTime(sf.trem * (0.4 + 0.6 * v), now, 0.05);

    const near = Math.max(0, Math.min(1, nearFinish));
    const crowdTarget = racing ? 0.015 + near * 0.13 : 0.01;
    crowdGain.gain.setTargetAtTime(crowdTarget, now, 0.25);
    crowdFilter.frequency.setTargetAtTime(600 + near * 1400, now, 0.25);

    // #10 drone: barely there at the start of a race, unmistakable by the last stretch. The
    // filter opening is what makes it feel like it's building rather than just getting louder.
    if (droneGain) {
      droneGain.gain.setTargetAtTime(racing ? 0.012 + near * near * 0.075 : 0, now, 0.5);
      droneFilter.frequency.setTargetAtTime(180 + near * 620, now, 0.5);
    }
  }

  // #10 — the release. Called when the race resolves: the drone steps up a fifth and fades,
  // which is what turns a rising tension into an ending instead of a cut-off.
  function resolveDrone() {
    if (!ctx || !droneGain) return;
    const now = ctx.currentTime;
    for (const o of droneOscs) {
      o.frequency.setTargetAtTime(o.frequency.value * 1.5, now, 0.12);
    }
    droneFilter.frequency.setTargetAtTime(1400, now, 0.15);
    droneGain.gain.setTargetAtTime(0.06, now, 0.05);
    droneGain.gain.setTargetAtTime(0, now + 0.7, 0.4);
  }

  function silenceBeds() {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    rollGain.gain.setTargetAtTime(0, now, 0.1);
    crowdGain.gain.setTargetAtTime(0, now, 0.1);
    if (rivals) for (const r of rivals) r.gain.gain.setTargetAtTime(0, now, 0.1);
    // The drone is deliberately NOT silenced here — resolveDrone() lands its release first, and
    // cutting the gain at the same moment would swallow it.
  }

  // ── One-shots ─────────────────────────────────────────────────────────
  // `dest` defaults to the one-shot bus; pass a cueNode() to place the sound in the stereo
  // field (#9).
  function tone(freq, start, dur, peak, type, endFreq, dest) {
    const c = ctx;
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(dest || sfxBus);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // A marble impact. `speed` is the closing speed along the contact normal (u/s), `material` the
  // other body's cannon material name (physics.js; unknown → 'surface'), `cue` the stereo place.
  // Energy (∝ speed²) sets level; speed sets pitch, brightness and how much ring is heard.
  function playImpact(speed, material, cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastClink < 0.006) return;
    const v = Math.min(1, speed / IMPACT_FULL);
    const energy = v * v;
    const mat = IMPACT_MATERIALS[material] || IMPACT_MATERIALS.surface;

    // Voice pool: drop finished voices, then make room only for a harder hit than the softest.
    impactVoices = impactVoices.filter((x) => x.end > now);
    if (impactVoices.length >= MAX_IMPACT_VOICES) {
      let soft = 0;
      for (let i = 1; i < impactVoices.length; i++) if (impactVoices[i].energy < impactVoices[soft].energy) soft = i;
      if (impactVoices[soft].energy >= energy) return;
      const old = impactVoices.splice(soft, 1)[0];
      try { old.gain.gain.setTargetAtTime(0, now, 0.005); old.src.stop(now + 0.03); } catch { }
    }
    lastClink = now;

    const dest = cueNode(cue);
    const level = (0.03 + Math.sqrt(energy) * 0.24) * mat.level;
    // A soft contact is heard as a short dull tick; a hard one rings out in full.
    const ring = Math.min(IMPACT_SECONDS, mat.decay * (0.45 + 0.9 * v) + 0.03);
    const bright = c.createBiquadFilter();
    bright.type = 'lowpass';
    bright.frequency.value = 1400 + v * 12000;
    const g = c.createGain();
    g.gain.setValueAtTime(level, now);
    g.gain.setTargetAtTime(0.0001, now + ring * 0.6, ring * 0.25);
    bright.connect(g).connect(dest);

    const bank = impactBank && impactBank[material in IMPACT_MATERIALS ? material : 'surface'];
    let src;
    if (bank && bank.length) {
      src = c.createBufferSource();
      src.buffer = bank[(Math.random() * bank.length) | 0];
      // Harder hits are pitched up a touch — pitch is much of what the ear reads as force.
      src.playbackRate.value = 0.9 + v * 0.22 + (Math.random() - 0.5) * 0.08;
      src.connect(bright);
      src.start(now);
      src.stop(now + ring + 0.05);
    } else {
      // Fallback while the bank renders: one partial at the material's pitch.
      src = c.createOscillator();
      src.type = 'triangle';
      src.frequency.setValueAtTime(mat.f0 * (0.9 + v * 0.3), now);
      src.frequency.exponentialRampToValueAtTime(mat.f0 * 0.6, now + ring);
      src.connect(bright);
      src.start(now);
      src.stop(now + ring + 0.05);
    }
    impactVoices.push({ src, gain: g, energy, end: now + ring + 0.05 });
  }

  // The old entry point: an impact against the track itself.
  function playClink(speed, cue) { playImpact(speed, 'surface', cue); }

  // Countdown pip. `final` is the go tone — higher and longer. Deliberately unspatialized: it's
  // a UI sound, not a thing happening on the track.
  function playBeep(final) {
    const c = ensure();
    if (!c) return;
    tone(final ? 1046.5 : 660, c.currentTime + 0.01, final ? 0.22 : 0.09, 0.14, 'square');
  }

  // Starting gun: a noise crack through a fast-decaying highpass.
  function playGun() {
    const c = ensure();
    if (!c || !noiseBuf) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(hp).connect(g).connect(sfxBus);
    src.start(now);
    src.stop(now + 0.25);
    tone(90, now, 0.18, 0.3, 'sine', 40); // body thump under the crack
    duck(0.3, 0.3);                        // #7 — the gun owns the moment
    resetDrone();                          // #10 — new race, tension starts from zero again
  }

  // Boost pad: a rising whoosh.
  function playWhoosh(cue) {
    const c = ensure();
    if (!c) return;
    tone(240, c.currentTime + 0.01, 0.26, 0.09, 'sawtooth', 900, cueNode(cue));
  }

  // Overtake: a two-note rise when you gain a place, a fall when you lose one. Throttled — the
  // pack trades places constantly in traffic. `cue` places it where the OTHER marble is (the one
  // you passed, or the one that passed you), so you hear which side the move happened on.
  function playOvertake(gained, cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastOvertake < 0.5) return;
    lastOvertake = now;
    const a = gained ? 587.33 : 466.16;
    const b = gained ? 880.0 : 349.23;
    const dest = cueNode(cue ? { pan: cue.pan, gain: 1 } : null);
    tone(a, now + 0.01, 0.09, 0.1, 'square', null, dest);
    tone(b, now + 0.09, 0.11, 0.1, 'square', null, dest);
  }

  // Your own top-10 finish: a crowd roar that swells in and rolls off over ~2 s, on top of the
  // finish chime. The same noise buffer as the beds, lowpassed into a mass of voices.
  function playRoar() {
    const c = ensure();
    if (!c || !noiseBuf) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, now);
    lp.frequency.linearRampToValueAtTime(1600, now + 0.35);
    lp.frequency.linearRampToValueAtTime(700, now + 2.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.45, now + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.3);
    src.connect(lp).connect(g).connect(sfxBus);
    src.start(now);
    src.stop(now + 2.4);
    duck(0.4, 0.6);
  }

  // Finish chime for a marble crossing the line. Spatialized, so a pack finishing ahead of you
  // spreads across the stereo field instead of stacking dead centre.
  function playFinish(cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    const dest = cueNode(cue);
    tone(880, now + 0.01, 0.13, 0.11, 'triangle', null, dest);
    tone(1318.5, now + 0.07, 0.16, 0.09, 'triangle', null, dest);
  }

  // Win = rising triad, lose = falling minor.
  function playSting(win) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + 0.02;
    const notes = win ? [523.25, 659.25, 783.99] : [392.0, 311.13, 261.63];
    notes.forEach((f, i) => tone(f, t + i * 0.12, 0.28, 0.16, 'square'));
    duck(0.25, 0.5);   // #7 — clear the beds out from under the result
    resolveDrone();    // #10 — land the tension the drone has been building
  }

  // ── Stings ───────────────────────────────────────────────────────────
  // A new race leader. `you` = the leader is your marble (a brighter call). Debounced: in a
  // tight pack the lead can swap several times a second and only the first is news.
  function playLeadChange(you, cue) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastLeadCall < LEAD_CHANGE_GAP) return;
    lastLeadCall = now;
    const dest = cueNode(cue ? { pan: cue.pan, gain: 1 } : null);
    const notes = you ? [659.25, 987.77] : [523.25, 698.46];
    notes.forEach((f, i) => tone(f, now + 0.01 + i * 0.08, 0.16, 0.09, 'triangle', null, dest));
    crowdSwell(0.18, 0.9);
    say(you ? 'You take the lead!' : 'New leader!');
  }

  // The top two crossed the line within a hair: a held, rising shimmer and a crowd gasp.
  function playPhotoFinish() {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    tone(1046.5, now + 0.01, 0.6, 0.07, 'sine', 1318.5);
    tone(1568, now + 0.05, 0.5, 0.04, 'sine', 2093);
    crowdSwell(0.32, 1.4);
    duck(0.4, 0.5);
    say('Photo finish!');
  }

  // You moved into the top `rank` (10 or 3): a short fanfare, bigger for the podium.
  function playMilestone(rank) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    const notes = rank <= 3 ? [523.25, 659.25, 783.99, 1046.5] : [587.33, 783.99];
    notes.forEach((f, i) => tone(f, now + 0.01 + i * 0.07, 0.14, 0.08, 'square'));
    if (rank <= 3) crowdSwell(0.22, 1.1);
    say(rank <= 3 ? "You're on the podium!" : "You're into the top ten!");
  }

  // A short crowd surge on top of the crowd bed: the same noise, opened up and faded out.
  function crowdSwell(peak, seconds) {
    if (!ctx || !noiseBuf) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, now);
    lp.frequency.linearRampToValueAtTime(1800, now + seconds * 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + seconds * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    src.connect(lp).connect(g).connect(sfxBus);
    src.start(now, Math.random() * NOISE_SECONDS * 0.5);
    src.stop(now + seconds + 0.05);
  }

  // ── Announcer ──
  // The browser's own speech voice. Never queued (cancel, then speak) and silent when muted.
  function say(text) {
    if (!announcerOn || muted || !text) return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      synth.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      u.rate = 1.15;
      u.pitch = 1.05;
      u.volume = 0.9;
      synth.speak(u);
    } catch { /* speech is decoration */ }
  }

  function stopSpeech() {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { }
  }

  function applyMute() {
    if (!master || !ctx) return;
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
    if (muted) stopSpeech();
  }

  return {
    resume() { ensure(); },
    playClink,
    playImpact,
    playLeadChange,
    playPhotoFinish,
    playMilestone,
    say,
    setReverb,
    setAnnouncer(on) { announcerOn = !!on; if (!announcerOn) stopSpeech(); },
    isAnnouncerOn() { return announcerOn; },
    playSting,
    playBeep,
    playGun,
    playWhoosh,
    playOvertake,
    playRoar,
    playFinish,
    updateBeds,
    updateRivals,
    silenceBeds,
    setMuted(m) { muted = !!m; applyMute(); },
    toggleMuted() { muted = !muted; applyMute(); return muted; },
    isMuted() { return muted; },
    dispose() {
      if (ctx) {
        try { rollSrc && rollSrc.stop(); } catch { }
        try { crowdSrc && crowdSrc.stop(); } catch { }
        // The drone oscillators are long-running sources like the beds — leaving them started
        // keeps the context alive after close() in some browsers.
        if (droneOscs) for (const o of droneOscs) { try { o.stop(); } catch { } }
        try { tremOsc && tremOsc.stop(); } catch { }
        try { slipSrc && slipSrc.stop(); } catch { }
        for (const x of impactVoices) { try { x.src.stop(); } catch { } }
        if (rivals) for (const r of rivals) { try { r.src.stop(); r.panner.disconnect(); } catch { } }
        resetListener();
        // The shared context outlives this game: detach our graph from it instead of closing it.
        try { master && master.disconnect(); } catch { }
        ctx = null; master = null; comp = null; bedBus = null; sfxBus = null;
        rollTrem = null; tremOsc = null; tremDepth = null;
        reverbSend = null; convolver = null;
        rollSrc = null; crowdSrc = null; rollGain = null; crowdGain = null;
        droneOscs = null; droneGain = null; droneFilter = null; droneBase = null;
        impactBank = null; rivals = null; listenAt.fill(NaN);
        impactVoices = []; slipSrc = null; slipFilter = null; slipGain = null;
        wetTone = null; echoDelay = null; echoFb = null; echoSend = null;
      }
      stopSpeech();
    },
  };
}
