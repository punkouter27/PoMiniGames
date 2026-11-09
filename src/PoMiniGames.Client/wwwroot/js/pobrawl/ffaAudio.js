import { clamp, makeNoiseBuffer } from './audioCore.js';

export const FFA_AUDIO_LIMITS = Object.freeze({ impacts: 12, friction: 4, arenaRadius: 4.85 });
const MATERIALS = {
  flesh: { hz: 115, cutoff: 1700, duration: 0.19, noise: 0.48, tone: 0.65 },
  cloth: { hz: 190, cutoff: 2900, duration: 0.12, noise: 0.85, tone: 0.12 },
  shoe: { hz: 85, cutoff: 900, duration: 0.10, noise: 0.38, tone: 0.75 },
  rope: { hz: 245, cutoff: 3800, duration: 0.28, noise: 0.3, tone: 0.52 },
};
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const vector = (p) => ({ x: finite(p?.x), y: finite(p?.y), z: finite(p?.z) });
const length = (p) => Math.hypot(p.x, p.y, p.z);
const unit = (p, fallback) => {
  const n = length(p);
  return n > 0.00001 ? { x: p.x / n, y: p.y / n, z: p.z / n } : fallback;
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Energy is nonnegative joules (or a consistent gameplay proxy), not damage or dB. */
export function impactParameters(energy, material = 'flesh', blocked = false) {
  const m = MATERIALS[material] || MATERIALS.flesh;
  const e = clamp(finite(energy), 0, 250);
  const strength = Math.sqrt(e / 250);
  return {
    energy: e, material: MATERIALS[material] ? material : 'flesh',
    peak: strength * (blocked ? 0.19 : 0.3),
    frequency: m.hz * (1 + strength * 0.45),
    cutoff: m.cutoff * (0.7 + strength * 0.65) * (blocked ? 0.65 : 1),
    duration: m.duration * (0.75 + strength * 0.5),
    noise: m.noise, tone: m.tone,
  };
}

/** Circular rope-boundary approximation, NOT ray-traced geometry or solid-wall occlusion. */
export function arenaAcoustics(position, listener) {
  const p = vector(position), l = vector(listener);
  const radius = FFA_AUDIO_LIMITS.arenaRadius;
  const edge = clamp(1 - Math.abs(radius - Math.hypot(p.x, p.z)) / 1.6, 0, 1);
  const outside = Math.hypot(l.x, l.z) > radius && l.y < 2.5;
  const obstruction = outside ? edge * clamp((2.5 - l.y) / 2.5, 0, 1) : 0;
  return {
    cutoff: 18000 - obstruction * 13000,
    gain: 1 - obstruction * 0.25,
    wet: 0.035 + edge * 0.13,
    delay: clamp((2 * Math.abs(radius - Math.hypot(p.x, p.z)) + distance(p, l)) / 343, 0.012, 0.12),
  };
}

/**
 * FFA-only synthesis on the supplied PoBrawl AudioBus's SFX/master graph.
 * Call update after moving the camera. Fighters use rig.root.position + velocity;
 * optional contactNormal / grounded / shearVelocity override floor-contact defaults.
 * No context ownership, assets, music, particles, or replacement KO/grunt/crowd cues.
 */
export class FfaAudio {
  constructor(bus, { onError = () => {} } = {}) {
    this.bus = bus;
    this.onError = onError;
    this.ctx = null;
    this.output = null;
    this.noise = null;
    this.voices = new Set();
    this.friction = new Map();
    this.steps = new Map();
    this.listener = { x: 0, y: 10, z: 13 };
    this.disposed = false;
    this._resumePending = false;
    this._failed = false;
    this._counts = { impacts: 0, footsteps: 0, clicks: 0, dropped: 0, errors: 0, peakVoices: 0 };
    this._lastImpact = null;
  }

  get stats() {
    return { ...this._counts, voices: this.voices.size, frictionVoices: this.friction.size,
      ownedNodes: (this.output ? 1 : 0) + [...this.voices, ...this.friction.values()]
        .reduce((total, voice) => total + voice.nodes.length, 0),
      selectedFighters: [...this.friction.keys()], lastImpact: this._lastImpact,
      limits: FFA_AUDIO_LIMITS, disposed: this.disposed };
  }

  _muted() {
    return !!this.bus?.muted || !!globalThis.window?.PoAudioBus?.isMuted?.();
  }

  setMuted(muted) {
    this.bus?.setMuted?.(!!muted);
    if (this._muted()) this.resetRound();
  }

  _error(error) {
    this._counts.errors++;
    try { this.onError(`FFA audio: ${error?.message || error}`); } catch { /* reporting must not break the game */ }
  }

  _ready() {
    if (this.disposed || this._failed) return false;
    if (this._muted()) { this.resetRound(); return false; }
    if (this.bus?._paused) return false;
    try {
      // resume owns lazy initialization and autoplay policy; never construct another context.
      if ((!this.bus.ctx || this.bus.ctx.state === 'suspended') && !this._resumePending) {
        this._resumePending = true;
        Promise.resolve(this.bus.resume()).catch((e) => this._error(e))
          .finally(() => { this._resumePending = false; });
      }
      const ctx = this.bus?.ctx;
      if (!ctx || !this.bus.sfxGain || ctx.state !== 'running') return false;
      this.ctx = ctx;
      if (!this.output) {
        this.output = ctx.createGain();
        this.output.gain.value = 0.8;
        this.output.connect(this.bus.sfxGain);
        this.noise = this.bus.noiseBuf || makeNoiseBuffer(ctx);
      }
      return true;
    } catch (e) {
      this._error(e);
      this.resetRound();
      this._failed = true;
      return false;
    }
  }

  _param(param, value) {
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(value, this.ctx.currentTime, 0.035);
  }

  _position(panner, position) {
    const p = vector(position);
    if (panner.positionX) {
      for (const axis of ['x', 'y', 'z']) this._param(panner[`position${axis.toUpperCase()}`], p[axis]);
    } else panner.setPosition(p.x, p.y, p.z);
  }

  _spatial(voice, position, normal) {
    const filter = this._node(voice, 'createBiquadFilter');
    const panner = this._node(voice, 'createPanner');
    const send = this._node(voice, 'createGain');
    const delay = this._node(voice, 'createDelay', 0.15);
    filter.type = 'lowpass';
    filter.Q.value = 0.3;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 8;
    panner.maxDistance = 60;
    panner.rolloffFactor = 0.7;
    panner.coneInnerAngle = 360;
    this._position(panner, position);
    const n = unit(vector(normal), { x: 0, y: 1, z: 0 });
    if (panner.orientationX) {
      panner.orientationX.value = n.x;
      panner.orientationY.value = n.y;
      panner.orientationZ.value = n.z;
    } else panner.setOrientation?.(n.x, n.y, n.z);
    filter.connect(panner).connect(this.output);
    // One non-feedback early reflection feeds the existing shared synthesized room reverb.
    panner.connect(send).connect(delay).connect(this.output);
    voice.spatial = { filter, panner, send, delay };
    this._acoustics(voice, position);
    return filter;
  }

  _acoustics(voice, position) {
    const a = arenaAcoustics(position, this.listener);
    const s = voice.spatial;
    this._position(s.panner, position);
    this._param(s.filter.frequency, a.cutoff);
    this._param(s.send.gain, a.wet);
    this._param(s.delay.delayTime, a.delay);
    voice.acoustics = a;
  }

  _voice(position, persistent = false) {
    const d = distance(vector(position), this.listener);
    if (!persistent && this.voices.size >= FFA_AUDIO_LIMITS.impacts) {
      const farthest = [...this.voices].sort((a, b) => b.distance - a.distance)[0];
      if (d >= farthest.distance) { this._counts.dropped++; return null; }
      this._release(farthest);
      this._counts.dropped++;
    }
    const voice = { nodes: [], sources: [], position: vector(position), distance: d, released: false };
    if (!persistent) {
      this.voices.add(voice);
      this._counts.peakVoices = Math.max(this._counts.peakVoices, this.voices.size);
    }
    return voice;
  }

  _node(voice, method, ...args) {
    const node = this.ctx[method](...args);
    voice.nodes.push(node);
    if (method === 'createBufferSource' || method === 'createOscillator') voice.sources.push(node);
    return node;
  }

  _release(voice) {
    if (!voice || voice.released) return;
    voice.released = true;
    for (const source of voice.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* source already ended */ }
    }
    for (const node of voice.nodes) {
      try { node.disconnect(); } catch { /* node already disconnected */ }
    }
    this.voices.delete(voice);
  }

  impact({ position, energy, material = 'flesh', normal, blocked = false } = {}) {
    if (!this._ready()) return false;
    const settings = impactParameters(energy, material, blocked);
    if (settings.energy <= 0) return false;
    const voice = this._voice(position);
    if (!voice) return false;
    try {
      const ctx = this.ctx, now = ctx.currentTime, end = now + settings.duration;
      const head = this._spatial(voice, position, normal);
      const tint = this._node(voice, 'createBiquadFilter'), gain = this._node(voice, 'createGain');
      const noise = this._node(voice, 'createBufferSource'), tone = this._node(voice, 'createOscillator');
      const ng = this._node(voice, 'createGain'), tg = this._node(voice, 'createGain');
      tint.type = 'lowpass';
      tint.frequency.setValueAtTime(settings.cutoff, now);
      tint.frequency.exponentialRampToValueAtTime(Math.max(80, settings.cutoff * 0.2), end);
      tint.connect(gain).connect(head);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(settings.peak * voice.acoustics.gain, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      noise.buffer = this.noise;
      ng.gain.value = settings.noise;
      noise.connect(ng).connect(tint);
      tone.type = settings.material === 'rope' ? 'triangle' : 'sine';
      tone.frequency.setValueAtTime(settings.frequency, now);
      tone.frequency.exponentialRampToValueAtTime(settings.frequency * 0.42, end);
      tg.gain.value = settings.tone;
      tone.connect(tg).connect(tint);
      // The final source releases the entire graph, including reflection delay nodes.
      tone.onended = () => this._release(voice);
      noise.start(now); noise.stop(end);
      tone.start(now); tone.stop(end + 0.14);
      this._lastImpact = { ...settings, position: vector(position) };
      this._counts.impacts++;
      return true;
    } catch (e) { this._release(voice); this._error(e); return false; }
  }

  _listener(camera) {
    if (!camera) return;
    camera.updateMatrixWorld?.();
    const p = vector(camera.position);
    // A Three.js camera's world matrix columns encode up and negative forward.
    const m = camera.matrixWorld?.elements;
    const forward = unit(m ? { x: -m[8], y: -m[9], z: -m[10] }
      : vector(camera.forward || { z: -1 }), { x: 0, y: 0, z: -1 });
    const up = unit(m ? { x: m[4], y: m[5], z: m[6] }
      : vector(camera.up || { y: 1 }), { x: 0, y: 1, z: 0 });
    this.listener = m ? { x: m[12], y: m[13], z: m[14] } : p;
    const l = this.ctx.listener;
    if (l.positionX) {
      for (const [prefix, v] of [['position', this.listener], ['forward', forward], ['up', up]]) {
        for (const axis of ['x', 'y', 'z']) {
          l[`${prefix}${axis.toUpperCase()}`].setValueAtTime(v[axis], this.ctx.currentTime);
        }
      }
    } else {
      l.setPosition(this.listener.x, this.listener.y, this.listener.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  update(camera, fighters = [], dt = 0) {
    if (!this._ready()) return;
    try {
      this._listener(camera);
      for (const voice of this.voices) voice.distance = distance(voice.position, this.listener);
      const candidates = fighters.filter((f) => f.alive !== false && f.grounded !== false)
        .map((f) => {
          const p = vector(f.rig?.root?.position || f.position);
          const v = vector(f.shearVelocity || f.velocity);
          const n = unit(vector(f.contactNormal || { y: 1 }), { x: 0, y: 1, z: 0 });
          const dot = v.x * n.x + v.y * n.y + v.z * n.z;
          const speed = Math.hypot(v.x - dot * n.x, v.y - dot * n.y, v.z - dot * n.z);
          return { f, p, speed, key: f.index ?? f.id ?? f, d: distance(p, this.listener) };
        }).filter((f) => f.speed > 0.12)
        .sort((a, b) => a.d - b.d).slice(0, FFA_AUDIO_LIMITS.friction);
      const keys = new Set(candidates.map((f) => f.key));
      for (const [key, voice] of this.friction) {
        if (!keys.has(key)) { this._release(voice); this.friction.delete(key); this.steps.delete(key); }
      }
      for (const { f, p, speed, key } of candidates) {
        let voice = this.friction.get(key);
        if (!voice) {
          voice = this._voice(p, true);
          this.friction.set(key, voice);
          const head = this._spatial(voice, p, f.contactNormal);
          const source = this._node(voice, 'createBufferSource');
          const filter = this._node(voice, 'createBiquadFilter');
          const gain = this._node(voice, 'createGain');
          source.buffer = this.noise;
          source.loop = true;
          filter.type = 'bandpass'; filter.Q.value = 0.65;
          gain.gain.value = 0;
          source.connect(filter).connect(gain).connect(head);
          voice.shear = { gain, filter };
          source.start();
        }
        this._acoustics(voice, p);
        this._param(voice.shear.gain.gain, clamp(speed / 4, 0, 1) * 0.025 * voice.acoustics.gain);
        this._param(voice.shear.filter.frequency, 350 + clamp(speed, 0, 5) * 420);
        const step = (this.steps.get(key) || 0) + speed * clamp(finite(dt), 0, 0.1);
        this.steps.set(key, step % 0.95);
        if (step >= 0.95 && this.impact({ position: p, energy: speed * speed * 1.8, material: 'shoe' })) {
          this._counts.footsteps++;
        }
      }
      for (const voice of this.voices) {
        if (voice.spatial) {
          this._acoustics(voice, voice.position);
        }
      }
    } catch (e) { this._error(e); this.resetRound(); }
  }

  /** Short non-diegetic UI cues. Parent calls this from its actual action handler. */
  click(action = 'select') {
    if (!this._ready()) return false;
    const voice = this._voice(this.listener);
    if (!voice) return false;
    try {
      const presets = { select: [660, 880], confirm: [740, 1100], toggle: [520, 740],
        back: [620, 420], cancel: [420, 280], error: [180, 120] };
      const [from, to] = presets[action] || presets.select;
      const now = this.ctx.currentTime;
      const source = this._node(voice, 'createOscillator'), gain = this._node(voice, 'createGain');
      source.type = 'triangle';
      source.frequency.setValueAtTime(from, now);
      source.frequency.exponentialRampToValueAtTime(to, now + 0.055);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.075, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);
      source.connect(gain).connect(this.output);
      source.onended = () => this._release(voice);
      source.start(now); source.stop(now + 0.075);
      this._counts.clicks++;
      return true;
    } catch (e) { this._release(voice); this._error(e); return false; }
  }

  resetRound() {
    for (const voice of [...this.voices, ...this.friction.values()]) this._release(voice);
    this.friction.clear();
    this.steps.clear();
    if (this.output) {
      try { this.output.disconnect(); } catch { /* graph already disconnected */ }
    }
    this.output = null;
    this.noise = null;
  }

  dispose() {
    this.resetRound();
    this.disposed = true;
    this.ctx = null;
  }
}
