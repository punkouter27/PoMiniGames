// anticipation.js — the one-second pre-impact light bloom (deck idea #2).
//
// A crash, a knockout, a photo finish: the sound lands on the frame of contact, and so does
// every effect the engines already had (shake, flash, sparks). Nothing told the eye it was
// COMING. Film does this with light: the exposure sags a touch, the highlights swell and
// the rims of the subjects brighten in the second before the hit, and then the hit itself
// pops over the top. Players read the event before the sound arrives.
//
// An engine arms an event with the moment it predicts contact (`at`, ms) and samples the
// envelope every frame:
//
//     { bloom: +0..1 extra bloom, rim: 0..1 rim/key-light pulse, exposure: ×0.85..×1.15 }
//
// and multiplies those onto its own post uniforms. 2D/DOM games call applyDom() instead,
// which writes --fx-anticip (0..1) and --fx-anticip-exposure on <html> for CSS to read.
//
// GATES: reduce-flashing (PoQuality.reduceFlashing(), on for prefers-reduced-motion too) and
// <html data-motion="reduce"> keep a soft bloom swell and drop the exposure dip and pop —
// the dip-then-pop is the flashing part. The envelope is presentation only: it must never
// feed back into a simulation.

/** Shape per event kind: lead (ms before contact), hold (ms after), and peak strengths. */
export const KINDS = Object.freeze({
    impact:   Object.freeze({ lead: 900,  hold: 380, bloom: 0.55, rim: 1,   dip: 0.14, pop: 0.12 }),
    knockout: Object.freeze({ lead: 1000, hold: 600, bloom: 0.8,  rim: 1,   dip: 0.18, pop: 0.16 }),
    win:      Object.freeze({ lead: 1000, hold: 900, bloom: 0.7,  rim: 0.8, dip: 0.1,  pop: 0.1 }),
    overtake: Object.freeze({ lead: 500,  hold: 300, bloom: 0.3,  rim: 0.6, dip: 0.05, pop: 0.05 }),
});

const REST = Object.freeze({ bloom: 0, rim: 0, exposure: 1, active: false });

const smooth = (x) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

/**
 * The envelope at time `t` ms relative to contact (negative = before).
 * Pure: (kind preset, t, strength, calm) → { bloom, rim, exposure, active }.
 */
export function envelope(kind, t, strength = 1, calm = false) {
    const k = KINDS[kind] || KINDS.impact;
    const s = Math.max(0, Math.min(1.5, strength));
    if (t < -k.lead || t > k.hold) return REST;
    let pre, post;
    if (t <= 0) {
        // Ease in over the lead: slow at first, steep in the last third.
        pre = smooth((t + k.lead) / k.lead);
        pre *= pre;
        post = 0;
    } else {
        pre = 0;
        // Contact: a quick pop that decays over the hold.
        post = Math.exp(-t / (k.hold * 0.3));
    }
    const swell = Math.max(pre, post);
    if (calm) {
        return { bloom: k.bloom * 0.35 * swell * s, rim: k.rim * 0.35 * swell * s, exposure: 1, active: true };
    }
    return {
        bloom: k.bloom * swell * s,
        rim: k.rim * swell * s,
        exposure: 1 - k.dip * pre * s + k.pop * post * s,
        active: true,
    };
}

function calmNow() {
    try {
        if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
        if (typeof window !== 'undefined' && window.PoQuality?.reduceFlashing?.() === true) return true;
    } catch { /* not in a browser */ }
    return false;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One per engine. Arming while armed keeps whichever event is bigger. */
export class Anticipation {
    constructor() {
        this.kind = null;
        this.at = 0;
        this.strength = 0;
        this._out = { bloom: 0, rim: 0, exposure: 1, active: false };
        this._domWritten = -1;
    }

    /**
     * @param {keyof KINDS} kind
     * @param {{at?:number, leadMs?:number, strength?:number}} [opts]
     *        `at` — predicted contact time (performance.now() ms); or `leadMs` from now.
     */
    arm(kind, opts = {}) {
        const k = KINDS[kind] ? kind : 'impact';
        const now = nowMs();
        const at = Number.isFinite(opts.at) ? opts.at : now + (Number.isFinite(opts.leadMs) ? opts.leadMs : KINDS[k].lead);
        const strength = Number.isFinite(opts.strength) ? opts.strength : 1;
        // Keep the current event if it is still running and at least as strong.
        if (this.kind && now - this.at < KINDS[this.kind].hold && this.strength >= strength && this.at <= at) return false;
        this.kind = k; this.at = at; this.strength = strength;
        return true;
    }

    /** Called off: the predicted contact did not happen (cars separated). */
    cancel() {
        if (this.kind && nowMs() < this.at) this.kind = null;
    }

    /** The envelope now. Reuses one object — read it, do not keep it. */
    sample(now = nowMs()) {
        const o = this._out;
        if (!this.kind) { o.bloom = 0; o.rim = 0; o.exposure = 1; o.active = false; return o; }
        const e = envelope(this.kind, now - this.at, this.strength, calmNow());
        if (!e.active) this.kind = null;
        o.bloom = e.bloom; o.rim = e.rim; o.exposure = e.exposure; o.active = e.active;
        return o;
    }

    /** 2D fallback: publish the envelope as CSS custom properties on <html>. */
    applyDom(root = typeof document !== 'undefined' ? document.documentElement : null, now) {
        if (!root) return;
        const e = this.sample(now);
        const q = Math.round(Math.min(1, e.bloom) * 100);
        if (q === this._domWritten) return;
        this._domWritten = q;
        root.style.setProperty('--fx-anticip', String(q / 100));
        root.style.setProperty('--fx-anticip-exposure', e.exposure.toFixed(3));
    }
}

/**
 * Time to closest approach between two moving points (XZ plane), for engines that predict
 * contact. Returns { t (seconds, may be negative), miss (distance at closest approach) }.
 */
export function closestApproach(ax, az, avx, avz, bx, bz, bvx, bvz) {
    const rx = bx - ax, rz = bz - az;
    const vx = bvx - avx, vz = bvz - avz;
    const vv = vx * vx + vz * vz;
    if (vv < 1e-6) return { t: Infinity, miss: Math.hypot(rx, rz), closing: 0 };
    const t = -(rx * vx + rz * vz) / vv;
    const mx = rx + vx * t, mz = rz + vz * t;
    return { t, miss: Math.hypot(mx, mz), closing: Math.sqrt(vv) };
}

if (typeof window !== 'undefined') {
    window.PoAnticipation = { KINDS, envelope, Anticipation, closestApproach };
}
