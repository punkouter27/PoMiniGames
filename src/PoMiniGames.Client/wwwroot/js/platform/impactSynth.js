// impactSynth.js — procedural material impact synthesis (deck idea #13).
//
// One hit, one voice, built from what collided rather than picked from a sample:
//
//   • TRANSIENT — a few ms of coloured noise (white/pink/brown per material) through a
//     highpass whose corner rises with hardness. This is the "contact": a steel hit is a
//     bright click, a dirt hit a dull thump.
//   • MODES     — a small bank of decaying sines at the material's modal ratios over a base
//     pitch (impactMaterials.js `audio.modes`). Inharmonic ratios are what make glass and
//     metal RING instead of buzz. Higher modes die faster, as they do in a real plate.
//   • PLACE     — a real HRTF panner (spatialAudio.js) when the caller gives a 3D position,
//     else a stereo pan; Doppler from acoustics.dopplerRatio when it gives a velocity; and an
//     occlusion lowpass (0 = in plain view, 1 = behind a wall).
//
// Everything about a hit is decided by the pure `buildImpactVoice()` (node-tested); `play()`
// only realises that description on the shared AudioContext and sfx bus, so mute, the
// Effects slider and the master compressor all apply.
//
// BUDGET: a voice pool capped by the quality tier (data-gfx). A pile-up past the cap steals
// the softest sounding voice — and only for a harder hit, so a stream of grazes can never
// cut off the crash that mattered. Hits on the same material closer than MIN_GAP_S apart
// are merged (the louder wins), which is the rate limit engines would otherwise each write.
//
// Never creates the AudioContext: before the player's first gesture play() is a no-op.

import * as AudioBus from './audioBus.js';
import { signature, material, MATERIALS } from './impactMaterials.js';
import { dopplerRatio } from './acoustics.js';

/** Base pitch (Hz) of the first mode for a "typical" object of each material. */
export const BASE_HZ = Object.freeze({
    metal: 420, wood: 260, stone: 180, glass: 1250, rubber: 120,
    paint: 310, flesh: 90, dirt: 70, water: 340,
});

const MAX_VOICES = Object.freeze({ high: 12, medium: 8, low: 4 });
const MIN_GAP_S = 0.008;
const MAX_MODES = 5;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Describe one impact voice. Pure: no AudioContext, no DOM.
 *
 * @param {string} tag material tag (impactMaterials.js)
 * @param {number} impulse raw collision impulse (engine units)
 * @param {object} [opts]
 * @param {number} [opts.full=20]      impulse that counts as a full-strength hit
 * @param {number} [opts.size=1]       object size; bigger rings lower (f ∝ 1/√size)
 * @param {number} [opts.mass]         heavier = longer ring (capped)
 * @param {number} [opts.pan]          -1..1 stereo place, used when no position is given
 * @param {number} [opts.occlusion=0]  0..1 — lowpass toward 900 Hz
 * @param {{x:number,y:number,z:number}} [opts.position]  source, listener-relative
 * @param {{x:number,y:number,z:number}} [opts.velocity]  source velocity (units/s)
 * @param {{x:number,y:number,z:number}} [opts.listener]  listener position
 * @param {number} [opts.variation]    0..1 seed for per-hit detune (default random)
 */
export function buildImpactVoice(tag, impulse, opts = {}) {
    const sig = signature(tag, impulse, { full: opts.full });
    const m = material(sig.material);
    const a = sig.audio;
    const size = Math.max(0.05, Number(opts.size) || 1);
    const massRing = opts.mass > 0 ? clamp(Math.log2(1 + opts.mass) / 4, 0.6, 1.6) : 1;
    const variation = opts.variation == null ? Math.random() : clamp(opts.variation, 0, 1);

    let doppler = 1;
    if (opts.position && opts.velocity) {
        doppler = dopplerRatio(opts.position, opts.velocity, opts.listener);
    }

    const base = (BASE_HZ[sig.material] || 220) / Math.sqrt(size)
        * a.pitchScale * doppler * (1 + (variation - 0.5) * 0.06);
    const decay = clamp(a.decay * massRing, 0.03, 2.5);

    const modes = [];
    for (let i = 0; i < Math.min(MAX_MODES, a.modes.length); i++) {
        const freq = base * a.modes[i];
        if (freq > 16000) break;   // above hearing on most speakers; skip the oscillator
        modes.push({
            freq,
            // Upper modes are quieter, less so on hard materials (which is why they sound bright).
            gain: a.ring * Math.pow(1 / (i + 1), 1.2 - a.hardness * 0.6),
            decay: decay / (1 + i * 0.6),
        });
    }

    const occlusion = clamp(Number(opts.occlusion) || 0, 0, 1);
    return {
        material: sig.material,
        energy: sig.energy,
        gain: a.gain * 0.5,
        transient: {
            noise: a.noise,
            // Hard = short and bright; soft = longer, darker thump.
            dur: 0.004 + (1 - a.hardness) * 0.035,
            highpass: 200 + a.hardness * 3800,
            gain: 0.35 + (1 - a.ring) * 0.65,
        },
        modes,
        decay,
        lowpass: 18000 * Math.pow(900 / 18000, occlusion),
        pan: opts.position ? null : clamp(Number(opts.pan) || 0, -1, 1),
        position: opts.position || null,
        doppler,
        // A soft material gets a short body thud under the click so it is never just a tick.
        body: m.hardness < 0.4 ? { freq: base * 0.5, decay: 0.06 + (1 - m.hardness) * 0.05 } : null,
    };
}

// ── Runtime ───────────────────────────────────────────────────────────────

/** @type {{end:number, energy:number, out:GainNode, nodes:AudioNode[]}[]} */
let _voices = [];
const _lastAt = new Map();
const _noise = new Map();
let _noiseRate = 0;

function tier() {
    try { return document.documentElement.getAttribute('data-gfx') || 'high'; } catch { return 'high'; }
}

function noiseBuffer(ctx, color) {
    if (_noiseRate !== ctx.sampleRate) { _noise.clear(); _noiseRate = ctx.sampleRate; }
    let buf = _noise.get(color);
    if (buf) return buf;
    const len = Math.floor(ctx.sampleRate * 0.25);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (color === 'pink') {
            // Paul Kellet's economy pink filter.
            b0 = 0.99765 * b0 + w * 0.0990460;
            b1 = 0.96300 * b1 + w * 0.2965164;
            b2 = 0.57000 * b2 + w * 1.0526913;
            d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        } else if (color === 'brown') {
            last = (last + 0.02 * w) / 1.02;
            d[i] = last * 3.5;
        } else {
            d[i] = w;
        }
    }
    _noise.set(color, buf);
    return buf;
}

function release(v) {
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
}

/** Make room for a voice of `energy`; false = the pool is full of harder hits. */
function claimSlot(now, energy) {
    _voices = _voices.filter((v) => {
        if (v.end > now) return true;
        release(v);
        return false;
    });
    const cap = MAX_VOICES[tier()] || MAX_VOICES.high;
    if (_voices.length < cap) return true;
    let soft = 0;
    for (let i = 1; i < _voices.length; i++) if (_voices[i].energy < _voices[soft].energy) soft = i;
    if (_voices[soft].energy >= energy) return false;
    const old = _voices.splice(soft, 1)[0];
    try { old.out.gain.cancelScheduledValues(now); old.out.gain.setTargetAtTime(0, now, 0.004); } catch { /* gone */ }
    setTimeout(() => release(old), 60);
    return true;
}

/**
 * Play an impact. Returns false when nothing sounded (muted, no context yet, rate-limited
 * or out of voices).
 *
 * @param {string} tag
 * @param {number} impulse
 * @param {object} [opts] buildImpactVoice options, plus:
 * @param {AudioNode} [opts.destination] route here instead of the shared sfx bus
 *        (an engine with its own submix — the voice still inherits that engine's mute path)
 * @param {AudioContext} [opts.context] the context `destination` belongs to
 */
export function play(tag, impulse, opts = {}) {
    try {
        const ctx = opts.context || (AudioBus.hasContext() ? AudioBus.contextSync() : null);
        if (!ctx || ctx.state === 'closed') return false;
        if (!opts.destination && !AudioBus.isAudible('sfx')) return false;
        const dest = opts.destination || AudioBus.busSync('sfx');
        if (!dest) return false;

        const voice = buildImpactVoice(tag, impulse, opts);
        if (voice.energy < 0.02) return false;
        const now = ctx.currentTime;

        const key = voice.material;
        if (now - (_lastAt.get(key) ?? -1) < MIN_GAP_S) return false;
        if (!claimSlot(now, voice.energy)) return false;
        _lastAt.set(key, now);

        const nodes = [];
        const out = ctx.createGain();
        out.gain.value = voice.gain;
        nodes.push(out);

        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = voice.lowpass;
        nodes.push(lp);
        out.connect(lp);

        // Place it.
        let placeNode = null;
        if (voice.position && typeof window !== 'undefined' && window.PoSpatial?.panner3d) {
            try { placeNode = window.PoSpatial.panner3d(ctx, voice.position); } catch { placeNode = null; }
        }
        if (!placeNode && voice.pan && ctx.createStereoPanner) {
            placeNode = ctx.createStereoPanner();
            placeNode.pan.value = voice.pan;
        }
        if (placeNode) { nodes.push(placeNode); lp.connect(placeNode); placeNode.connect(dest); }
        else lp.connect(dest);

        // Transient.
        const t = voice.transient;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx, t.noise);
        src.playbackRate.value = voice.doppler;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = t.highpass;
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(t.gain, now);
        tg.gain.exponentialRampToValueAtTime(0.0001, now + t.dur + 0.004);
        src.connect(hp).connect(tg).connect(out);
        src.start(now, Math.random() * 0.2);
        src.stop(now + t.dur + 0.02);
        nodes.push(src, hp, tg);

        let end = now + t.dur + 0.03;
        const sines = voice.body ? [...voice.modes, { freq: voice.body.freq, gain: 0.6, decay: voice.body.decay }] : voice.modes;
        for (const md of sines) {
            const o = ctx.createOscillator();
            o.type = 'sine';
            o.frequency.value = md.freq;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, now);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, md.gain * 0.5), now + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, now + md.decay * 4);
            o.connect(g).connect(out);
            o.start(now);
            o.stop(now + md.decay * 4 + 0.02);
            nodes.push(o, g);
            end = Math.max(end, now + md.decay * 4 + 0.03);
        }

        _voices.push({ end, energy: voice.energy, out, nodes });
        return true;
    } catch {
        return false;   // sound is decoration: never throw into a physics callback
    }
}

/** Voices currently sounding (for debug overlays and tests). */
export function activeVoices() { return _voices.length; }

export const MATERIAL_TAGS = Object.freeze(Object.keys(MATERIALS));

if (typeof window !== 'undefined') {
    window.PoImpactSynth = { play, buildImpactVoice, activeVoices, MATERIAL_TAGS };
}
