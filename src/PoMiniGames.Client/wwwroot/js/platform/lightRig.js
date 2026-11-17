// lightRig.js — dynamic world lighting and weather (deck idea #6).
//
// Engines own their lights; what they lacked was a shared vocabulary for "the light changed
// because the game did": a storm rolling in, the floodlights coming up, a wreck putting
// amber beacons on the track. This module drives an engine's EXISTING key light (sun) and
// fill (hemisphere/ambient) from named presets and blends between them over time:
//
//   sun · moon · stadium · dash · emergency · storm
//
// Each preset is a multiplier on what the engine set (captured by captureBase()), so the
// rig never fights an engine's own weather code: re-capture after the engine re-lights.
// On top of the base state there is one OVERLAY (e.g. emergency at 0..1 weight, pulsing),
// a lightning flash (double flicker + exposure spike, gated by reduce-flashing), and a
// `wet` level engines can apply to surface roughness with wetRoughness().
//
// update() returns { exposure, wet } for the engine to multiply into its tone mapping.
// blendPresets(), lightningEnvelope() and wetRoughness() are pure, for tests.

/**
 * sun/hemi: intensity multipliers. sunTint/hemiTint: colour multipliers (r,g,b).
 * exposure: tone-mapping multiplier. wet: 0..1. pulse: Hz of an overlay's beacon pulse (0 = steady).
 */
export const PRESETS = Object.freeze({
    sun:       Object.freeze({ sun: 1,    hemi: 1,    sunTint: [1, 1, 1],          hemiTint: [1, 1, 1],          exposure: 1,    wet: 0,   pulse: 0 }),
    moon:      Object.freeze({ sun: 0.18, hemi: 0.45, sunTint: [0.62, 0.72, 1],    hemiTint: [0.55, 0.65, 0.95], exposure: 1.25, wet: 0,   pulse: 0 }),
    stadium:   Object.freeze({ sun: 0.55, hemi: 0.85, sunTint: [1, 0.97, 0.9],     hemiTint: [0.9, 0.95, 1.05],  exposure: 1.1,  wet: 0,   pulse: 0 }),
    dash:      Object.freeze({ sun: 0.3,  hemi: 0.6,  sunTint: [1, 0.8, 0.6],      hemiTint: [0.7, 0.75, 1],     exposure: 1.15, wet: 0,   pulse: 0 }),
    storm:     Object.freeze({ sun: 0.45, hemi: 0.7,  sunTint: [0.82, 0.88, 1],    hemiTint: [0.8, 0.85, 0.92],  exposure: 1.05, wet: 1,   pulse: 0 }),
    emergency: Object.freeze({ sun: 0.85, hemi: 1.1,  sunTint: [1, 0.72, 0.45],    hemiTint: [1.25, 0.55, 0.35], exposure: 1,    wet: 0,   pulse: 1.6 }),
});

const lerp = (a, b, t) => a + (b - a) * t;

/** Blend two presets (objects shaped like PRESETS entries) by t (0..1). Writes into `out` if given. */
export function blendPresets(a, b, t, out = {}) {
    const k = Math.max(0, Math.min(1, t));
    out.sun = lerp(a.sun, b.sun, k);
    out.hemi = lerp(a.hemi, b.hemi, k);
    out.sunTint = out.sunTint || [1, 1, 1];
    out.hemiTint = out.hemiTint || [1, 1, 1];
    for (let i = 0; i < 3; i++) {
        out.sunTint[i] = lerp(a.sunTint[i], b.sunTint[i], k);
        out.hemiTint[i] = lerp(a.hemiTint[i], b.hemiTint[i], k);
    }
    out.exposure = lerp(a.exposure, b.exposure, k);
    out.wet = lerp(a.wet, b.wet, k);
    out.pulse = k < 0.5 ? a.pulse : b.pulse;
    return out;
}

/**
 * A lightning strike's brightness at `t` seconds after it began: a bright first stroke,
 * a dimmer return stroke, then darkness. 0..1, 0 after ~0.6 s.
 */
export function lightningEnvelope(t) {
    if (t < 0 || t > 0.6) return 0;
    const stroke = (c, w, h) => h * Math.exp(-((t - c) * (t - c)) / (2 * w * w));
    return Math.min(1, stroke(0.03, 0.025, 1) + stroke(0.17, 0.03, 0.65) + stroke(0.32, 0.05, 0.35));
}

/** Roughness of a surface at wetness `wet` (0..1): wet asphalt and stone go glossy, not mirror. */
export function wetRoughness(dry, wet) {
    const w = Math.max(0, Math.min(1, wet));
    return Math.max(0.05, dry * (1 - 0.65 * w));
}

function flashingReduced() {
    try {
        if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
        return typeof window !== 'undefined' && window.PoQuality?.reduceFlashing?.() === true;
    } catch { return false; }
}

export class LightRig {
    /**
     * @param {{ sun?: any, hemi?: any, state?: keyof PRESETS }} lights three.js lights (any with .intensity/.color)
     */
    constructor({ sun = null, hemi = null, state = 'sun' } = {}) {
        this.sun = sun;
        this.hemi = hemi;
        this.base = null;
        this.from = PRESETS[state] || PRESETS.sun;
        this.to = this.from;
        this.t = 1;
        this.dur = 0;
        this.state = PRESETS[state] ? state : 'sun';
        this.overlayName = null;
        this.overlayWeight = 0;
        this._overlayShown = 0;
        this.flashAt = -1;
        this.flashStrength = 0;
        this.time = 0;
        this.rim = 0;
        this._cur = blendPresets(this.from, this.to, 1);
        this._mix = blendPresets(this.from, this.to, 1);
        this._out = { exposure: 1, wet: 0, lightning: 0 };
        this.captureBase();
    }

    /** Remember the engine's own light values. Call again after the engine re-lights (weather). */
    captureBase() {
        const grab = (l) => l ? { i: l.intensity, c: l.color ? [l.color.r, l.color.g, l.color.b] : null } : null;
        this.base = { sun: grab(this.sun), hemi: grab(this.hemi) };
    }

    /** Blend the base state to `name` over `seconds` (0 = cut). */
    setState(name, seconds = 2) {
        const p = PRESETS[name];
        if (!p || name === this.state && this.t >= 1) return;
        this.from = blendPresets(this._cur, this._cur, 0, {});
        this.to = p;
        this.state = name;
        this.dur = Math.max(0, seconds);
        this.t = this.dur > 0 ? 0 : 1;
    }

    /** One overlay on top of the base (emergency beacons near a wreck): weight 0..1, eased. */
    setOverlay(name, weight) {
        this.overlayName = PRESETS[name] ? name : null;
        this.overlayWeight = this.overlayName ? Math.max(0, Math.min(1, weight)) : 0;
    }

    /** A lightning strike (no-op under reduce-flashing). Returns whether it fired. */
    lightning(strength = 1) {
        if (flashingReduced()) return false;
        this.flashAt = this.time;
        this.flashStrength = Math.max(0, Math.min(1.5, strength));
        try {
            window.dispatchEvent(new CustomEvent('po-lightning', { detail: { strength: this.flashStrength } }));
        } catch { /* not in a browser */ }
        return true;
    }

    /** Pre-impact rim pulse from anticipation.js (0..1): lifts the key light briefly. */
    setRim(rim) { this.rim = Math.max(0, Math.min(1, rim || 0)); }

    /** Step and apply. Returns { exposure, wet, lightning } (one reused object). */
    update(dt) {
        const step = Math.max(0, Math.min(0.1, dt || 0));
        this.time += step;
        if (this.t < 1) this.t = this.dur > 0 ? Math.min(1, this.t + step / this.dur) : 1;
        const ease = this.t * this.t * (3 - 2 * this.t);
        blendPresets(this.from, this.to, ease, this._cur);

        // Overlay eases toward its weight so a wreck fades the beacons in.
        this._overlayShown += (this.overlayWeight - this._overlayShown) * (1 - Math.exp(-step * 3));
        let mix = this._cur;
        if (this.overlayName && this._overlayShown > 0.002) {
            const ov = PRESETS[this.overlayName];
            // A beacon pulses; under reduce-flashing it holds steady at its mean.
            const beat = ov.pulse > 0 && !flashingReduced() ? 0.55 + 0.45 * Math.sin(this.time * ov.pulse * Math.PI * 2) : 0.55;
            mix = blendPresets(this._cur, ov, this._overlayShown * beat, this._mix);
        }

        const flash = this.flashAt >= 0 ? lightningEnvelope(this.time - this.flashAt) * this.flashStrength : 0;
        if (this.flashAt >= 0 && this.time - this.flashAt > 0.6) this.flashAt = -1;

        const b = this.base;
        if (this.sun && b?.sun) {
            this.sun.intensity = b.sun.i * mix.sun * (1 + 0.35 * this.rim) + flash * b.sun.i * 1.5;
            if (b.sun.c && this.sun.color) this.sun.color.setRGB(b.sun.c[0] * mix.sunTint[0], b.sun.c[1] * mix.sunTint[1], b.sun.c[2] * mix.sunTint[2]);
        }
        if (this.hemi && b?.hemi) {
            this.hemi.intensity = b.hemi.i * mix.hemi + flash * b.hemi.i * 2.5;
            if (b.hemi.c && this.hemi.color) this.hemi.color.setRGB(b.hemi.c[0] * mix.hemiTint[0], b.hemi.c[1] * mix.hemiTint[1], b.hemi.c[2] * mix.hemiTint[2]);
        }
        const o = this._out;
        o.exposure = mix.exposure * (1 + flash * 0.6);
        o.wet = mix.wet;
        o.lightning = flash;
        return o;
    }

    /** Put the engine's own values back (on unmount or before the engine re-lights). */
    restore() {
        const b = this.base;
        if (this.sun && b?.sun) { this.sun.intensity = b.sun.i; if (b.sun.c) this.sun.color?.setRGB(...b.sun.c); }
        if (this.hemi && b?.hemi) { this.hemi.intensity = b.hemi.i; if (b.hemi.c) this.hemi.color?.setRGB(...b.hemi.c); }
    }
}

if (typeof window !== 'undefined') {
    window.PoLightRig = { PRESETS, blendPresets, lightningEnvelope, wetRoughness, LightRig };
}
