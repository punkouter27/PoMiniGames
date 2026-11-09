// audioCore.js — the constants, tables and node helpers that audio.js (the AudioBus core),
// audioAnnouncer.js and audioShowtime.js all use. No state, no AudioContext: plain values and
// pure helpers, so the three halves of the bus share them without importing one another.

// Seconds of shared noise; longer than any sound reading it, so each playback
// starts at a random offset (`_noiseSource`).
const NOISE_SECONDS = 2;

// Half-width of the arena in world units, for mapping world-x -> stereo pan.
export const ARENA_HALF_WIDTH = 6;

// Music scheduler: wake every LOOKAHEAD_MS, queue notes due within SCHEDULE_AHEAD
// seconds. SCHEDULE_AHEAD is the main-thread stall budget — a round opening can
// block a few hundred ms, and anything longer drains the queue audibly.
export const LOOKAHEAD_MS = 25;
export const SCHEDULE_AHEAD = 0.45;

// SFX-bus lowpass: open (20 kHz, not Infinity — the corner's phase response stays
// out of band) normally, swept down to MUFFLED (Hz) for the concussion.
export const SFX_FILTER_OPEN = 20000;
export const SFX_FILTER_MUFFLED = 420;
// Music sidechain attack/release, seconds.
export const DUCK_ATTACK = 0.012;
export const DUCK_RELEASE = 0.32;

// Crowd bed: three filtered-noise layers; intensity raises level and brightens the mid band.
export const CROWD_BASE_GAIN = 0.05;
export const CROWD_PEAK_GAIN = 0.16;

export const rand = (min, max) => min + Math.random() * (max - min);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Simple low-passed white noise — closer to "thud" than harsh hiss.
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.15 * white) / 1.15;
    data[i] = last;
  }
  return buf;
}

// Synthesized IR: exponentially decaying, decorrelated stereo noise.
export function makeImpulseResponse(ctx, duration = 1.2, decay = 2.6) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

// Release `nodes` once `source` ends, or a flurry piles up live nodes on the audio thread.
// `after` runs once the nodes are gone (voice counters).
export function autoDisconnect(source, nodes, after = null) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
    if (after) after();
  };
}

// Per-fighter grunt voice: pitch f0 (Hz), vowel formants f1/f2 (Hz), rasp = breath
// noise through the upper formant (0..1). Unknown ids use DEFAULT_VOICE.
export const VOICES = {
  trump:      { f0: 105, f1: 650, f2: 1100, rasp: 0.35 },
  biden:      { f0: 118, f1: 600, f2: 1300, rasp: 0.45 },
  obama:      { f0: 98,  f1: 560, f2: 1050, rasp: 0.15 },
  bush:       { f0: 112, f1: 700, f2: 1250, rasp: 0.25 },
  clinton:    { f0: 120, f1: 620, f2: 1350, rasp: 0.6 },
  bushsr:     { f0: 130, f1: 580, f2: 1450, rasp: 0.2 },
  reagan:     { f0: 108, f1: 540, f2: 1150, rasp: 0.5 },
  carter:     { f0: 125, f1: 660, f2: 1500, rasp: 0.15 },
  ford:       { f0: 110, f1: 600, f2: 1200, rasp: 0.2 },
  nixon:      { f0: 100, f1: 520, f2: 1000, rasp: 0.3 },
  lbj:        { f0: 95,  f1: 640, f2: 1080, rasp: 0.4 },
  jfk:        { f0: 122, f1: 700, f2: 1400, rasp: 0.2 },
  eisenhower: { f0: 115, f1: 560, f2: 1250, rasp: 0.25 },
  truman:     { f0: 128, f1: 620, f2: 1550, rasp: 0.15 },
  fdr:        { f0: 104, f1: 580, f2: 1150, rasp: 0.2 },
  hoover:     { f0: 102, f1: 560, f2: 1180, rasp: 0.25 },
};
export const DEFAULT_VOICE = { f0: 112, f1: 600, f2: 1250, rasp: 0.25 };

// Note name → semitone (C4 = MIDI 60); sharps (#) and flats (b).
export const NOTE_NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
                     F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8,
                     A: 9, 'A#': 10, Bb: 10, B: 11 };
export function noteToFreq(name) {
  const m = /^([A-G][#b]?)(-?\d+)$/.exec(name);
  if (!m) return 440;
  const semi = NOTE_NAMES[m[1]];
  const oct = parseInt(m[2], 10);
  const midi = (oct + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ══ Showtime tables (audioShow.js) ═════════════════════════════════════

// Per-president leitmotif: 4-7 notes as semitones over `root`, durations in 16ths, and a
// timbre (TIMBRES in _tone). Original figures, written to the character, not quotations:
// the countdown trades them corner to corner, a super plays the owner's as a brass stinger,
// and the winner's resolves into a fanfare. Keys MUST match the charId in fighters.js.
export const MOTIFS = {
  trump:      { root: 'F3',  timbre: 'brass', notes: [0, 0, 7, 12, 11, 12],    durs: [1, 1, 2, 2, 1, 3] },
  biden:      { root: 'D4',  timbre: 'reed',  notes: [0, 4, 7, 9, 7],          durs: [2, 1, 1, 2, 4] },
  obama:      { root: 'Eb4', timbre: 'keys',  notes: [0, 7, 5, 10, 12],        durs: [1, 1, 2, 2, 4] },
  bush:       { root: 'G3',  timbre: 'twang', notes: [0, 2, 4, 7, 4, 7],       durs: [1, 1, 1, 2, 1, 3] },
  clinton:    { root: 'C4',  timbre: 'sax',   notes: [0, 3, 5, 6, 7, 10],      durs: [1, 1, 1, 1, 2, 4] },
  bushsr:     { root: 'Bb3', timbre: 'brass', notes: [0, 5, 7, 12],            durs: [2, 2, 2, 6] },
  reagan:     { root: 'C4',  timbre: 'brass', notes: [0, 7, 9, 7, 12],         durs: [1, 1, 1, 1, 4] },
  carter:     { root: 'F4',  timbre: 'pluck', notes: [0, 2, 4, 0, 7],          durs: [1, 1, 1, 1, 4] },
  ford:       { root: 'A3',  timbre: 'organ', notes: [0, 4, 2, 5, 4],          durs: [2, 1, 1, 2, 4] },
  nixon:      { root: 'E3',  timbre: 'organ', notes: [0, 3, 6, 5, 3, 0],       durs: [1, 1, 2, 1, 1, 4] },
  lbj:        { root: 'D3',  timbre: 'twang', notes: [0, 0, 5, 7, 9, 7],       durs: [1, 1, 2, 1, 1, 3] },
  jfk:        { root: 'G4',  timbre: 'bell',  notes: [0, 4, 7, 11, 12],        durs: [1, 1, 1, 1, 4] },
  eisenhower: { root: 'F3',  timbre: 'brass', notes: [0, 5, 9, 12, 9, 12],     durs: [1, 1, 1, 2, 1, 4] },
  truman:     { root: 'C4',  timbre: 'keys',  notes: [0, 4, 7, 9, 7, 4, 12],   durs: [1, 1, 1, 1, 1, 1, 4] },
  fdr:        { root: 'Eb4', timbre: 'reed',  notes: [7, 9, 7, 4, 0],          durs: [1, 1, 1, 1, 4] },
  hoover:     { root: 'G3',  timbre: 'brass', notes: [0, 2, 7, 5, 2, 0],       durs: [2, 1, 2, 1, 1, 4] },
  bob:        { root: 'C4',  timbre: 'chip',  notes: [0, 12, 7, 0],            durs: [1, 1, 1, 3] },
};
export const DEFAULT_MOTIF = { root: 'C4', timbre: 'brass', notes: [0, 4, 7, 12], durs: [1, 1, 1, 3] };
