// platform/toneMusic.js — lazy Tone.js procedural adaptive music stem engine.
// Shares audioBus.js's single AudioContext and routes into audioBus.music so master mute,
// volume, ducking, and the mastering compressor apply uniformly. Loads Tone.js from CDN
// ONLY when music volume > 0 (since music is opt-in, default 0).
import * as audioBus from './audioBus.js';

const PRESETS = {
  arcade: { bpm: 124, root: 'C2', scale: ['C4', 'Eb4', 'F4', 'G4', 'Bb4', 'C5'] },
  racer: { bpm: 136, root: 'A1', scale: ['A3', 'C4', 'E4', 'G4', 'A4', 'B4'] },
  brawl: { bpm: 112, root: 'D2', scale: ['D3', 'F3', 'G3', 'A3', 'C4', 'D4'] },
  colony: { bpm: 92, root: 'F2', scale: ['F3', 'A3', 'C4', 'E4', 'G4', 'A4'] },
};

let _tonePromise = null;
async function loadTone() {
  _tonePromise ??= import('tone').catch((err) => { _tonePromise = null; throw err; });
  return _tonePromise;
}

/**
 * Create a Tone.js stem engine compatible with tensionMixer.js (`setStem(name, gain)`).
 * @param {'arcade'|'racer'|'brawl'|'colony'} [presetName='arcade']
 */
export function createToneMusic(presetName = 'arcade') {
  const preset = PRESETS[presetName] || PRESETS.arcade;
  let Tone = null;
  let running = false;
  let disposed = false;
  const stemGains = { bass: 0, pad: 0, hats: 0, kick: 0, arp: 0, lead: 0 };
  const nodes = {};

  async function ensureStarted() {
    if (running || disposed) return;
    if (audioBus.isMuted() || audioBus.getBusVolume('music') <= 0) return;
    const ctx = await audioBus.context();
    const bus = audioBus.bus('music');
    if (!ctx || !bus || disposed) return;

    Tone = await loadTone();
    Tone.setContext(ctx);
    const out = new Tone.Gain(0.55);
    out.connect(bus);

    const makeGain = (name) => {
      const g = new Tone.Gain(stemGains[name] || 0).connect(out);
      nodes[name + 'Gain'] = g;
      return g;
    };

    const bassSynth = new Tone.MonoSynth({ oscillator: { type: 'sawtooth' }, filter: { Q: 2, frequency: 320 } }).connect(makeGain('bass'));
    const padSynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.8, release: 1.5 } }).connect(makeGain('pad'));
    const kickSynth = new Tone.MembraneSynth().connect(makeGain('kick'));
    const hatSynth = new Tone.MetalSynth({ envelope: { decay: 0.06 }, harmonicity: 5.1 }).connect(makeGain('hats'));
    const arpSynth = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.01, decay: 0.14, sustain: 0.1 } }).connect(makeGain('arp'));
    const leadSynth = new Tone.FMSynth({ modulationIndex: 4 }).connect(makeGain('lead'));

    Tone.getTransport().bpm.value = preset.bpm;
    let step = 0;
    const loop = new Tone.Loop((time) => {
      if (disposed || audioBus.isMuted() || audioBus.getBusVolume('music') <= 0) return;
      const i = step++;
      if (i % 4 === 0 && stemGains.kick > 0.02) kickSynth.triggerAttackRelease('C1', '8n', time);
      if (i % 2 === 1 && stemGains.hats > 0.02) hatSynth.triggerAttackRelease('16n', time, 0.25);
      if (i % 4 === 0 && stemGains.bass > 0.02) bassSynth.triggerAttackRelease(preset.root, '8n', time);
      if (i % 16 === 0 && stemGains.pad > 0.02) padSynth.triggerAttackRelease([preset.scale[0], preset.scale[2]], '1m', time, 0.25);
      if (stemGains.arp > 0.02) arpSynth.triggerAttackRelease(preset.scale[i % preset.scale.length], '16n', time, 0.35);
      if (i % 8 === 4 && stemGains.lead > 0.02) leadSynth.triggerAttackRelease(preset.scale[(i >> 2) % preset.scale.length], '8n', time, 0.4);
    }, '8n').start(0);

    nodes.disposables = [loop, bassSynth, padSynth, kickSynth, hatSynth, arpSynth, leadSynth, out];
    if (Tone.getTransport().state !== 'started') Tone.getTransport().start();
    running = true;
  }

  return {
    start() { ensureStarted().catch(() => {}); },
    setStem(name, value) {
      stemGains[name] = Math.max(0, Math.min(1, value || 0));
      if (!running && stemGains[name] > 0.01) ensureStarted().catch(() => {});
      const g = nodes[name + 'Gain'];
      if (g && Tone) g.gain.rampTo(stemGains[name], 0.12);
    },
    dispose() {
      disposed = true;
      running = false;
      for (const d of nodes.disposables || []) { try { d.stop?.(); d.dispose?.(); } catch { /* ok */ } }
      nodes.disposables = [];
    },
  };
}
