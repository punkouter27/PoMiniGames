// renderBudget.js — adaptive cinematic render budget (deck idea #1).
//
// qualityTiers.js (window.PoQuality) decides the CEILING: the device guess, the battery cap,
// the player's own choice in Settings. visualRuntime.js walks the DOM chrome under it. What
// neither does is spend a 3D engine's frame well: one engine-level tier switch is a big,
// visible jump (grass vanishes, bloom loses a mip) when the frame is only 2 ms over budget.
//
// This is the fine-grained layer under the ceiling. It keeps a ring of the last 90 frame
// times, reads the 95th percentile every 30 frames (p95, not the mean: the hitch is what the
// player feels), and moves ONE rung on a ladder of cheaper-to-dearer settings:
//
//     resolution scale · max DPR · particle share · shadow distance · static shadows · AO · post
//
// Asymmetric hysteresis: two slow reads drop a rung (the player is already suffering), five
// fast reads in a row raise one (so a borderline machine does not flap). The ladder top is
// capped by the PoQuality tier, re-read on every evaluation, so a choice in Settings or a
// preview applies on the next read without any wiring.
//
// The bottom rung is the low-profile fallback the deck asks for: 1× device pixels and
// static (throttled) shadows.
//
// The core — percentile(), stepBudget() — is pure, for node tests. RenderBudget wraps it with
// the live tier; applyToRenderer() is the only function that touches three.js.

/**
 * Cheapest first. `maxDpr` caps devicePixelRatio, `resScale` multiplies what is left;
 * `particles` is a share of the engine's full particle budget; `shadowDistance` a share of
 * its shadow reach; `staticShadows` means the shadow map updates every few frames, not
 * every frame; `tier` is the engine-level name the rung belongs to.
 */
export const LADDER = Object.freeze([
    Object.freeze({ tier: 'low',    maxDpr: 1,   resScale: 0.8,  particles: 0.25, shadowDistance: 0.5, staticShadows: true,  ao: false, post: false }),
    Object.freeze({ tier: 'low',    maxDpr: 1,   resScale: 1,    particles: 0.35, shadowDistance: 0.6, staticShadows: true,  ao: false, post: true }),
    Object.freeze({ tier: 'medium', maxDpr: 1.5, resScale: 0.85, particles: 0.6,  shadowDistance: 0.8, staticShadows: false, ao: false, post: true }),
    Object.freeze({ tier: 'medium', maxDpr: 1.5, resScale: 1,    particles: 0.75, shadowDistance: 0.9, staticShadows: false, ao: true,  post: true }),
    Object.freeze({ tier: 'high',   maxDpr: 2,   resScale: 0.9,  particles: 1,    shadowDistance: 1,   staticShadows: false, ao: true,  post: true }),
    Object.freeze({ tier: 'high',   maxDpr: 2,   resScale: 1,    particles: 1,    shadowDistance: 1,   staticShadows: false, ao: true,  post: true }),
]);

/** The highest rung each PoQuality tier may reach. */
export const TIER_TOP = Object.freeze({ low: 1, medium: 3, high: 5 });

/** Particle share a tier's engine already assumes, so engines can scale relative to it. */
export const TIER_NOMINAL_PARTICLES = Object.freeze({ low: 0.35, medium: 0.75, high: 1 });

const RING = 90;
const EVAL_EVERY = 30;
const DROP_READS = 2;
const RAISE_READS = 5;

/**
 * p-th percentile (0..1) of the first `n` entries of `values`, without sorting the source.
 * `scratch` is reused when given, so the live path allocates nothing.
 */
export function percentile(values, n, p, scratch) {
    const count = Math.max(0, Math.min(n | 0, values.length));
    if (count === 0) return 0;
    const buf = scratch && scratch.length >= count ? scratch : new Float64Array(count);
    for (let i = 0; i < count; i++) buf[i] = values[i];
    const view = buf.subarray ? buf.subarray(0, count) : buf.slice(0, count);
    view.sort();
    const idx = Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1));
    return view[idx];
}

/**
 * A fresh budget state.
 * @param {{targetMs?:number, tier?:string, rung?:number}} [opts]
 */
export function createBudgetState(opts = {}) {
    const tier = TIER_TOP[opts.tier] !== undefined ? opts.tier : 'high';
    const top = TIER_TOP[tier];
    return {
        targetMs: Number(opts.targetMs) > 0 ? Number(opts.targetMs) : 1000 / 60,
        tier,
        rung: Math.min(top, Math.max(0, opts.rung ?? top)),
        ring: new Float64Array(RING),
        scratch: new Float64Array(RING),
        filled: 0,
        cursor: 0,
        sinceEval: 0,
        slowReads: 0,
        fastReads: 0,
        lastP95: 0,
    };
}

/**
 * Feed one frame. Returns the new rung index when it changed, else -1.
 * Frames over 250 ms (tab switch, shader compile, GC pause) are not evidence and are skipped.
 * @param {ReturnType<typeof createBudgetState>} s
 * @param {number} frameMs
 * @param {string} [tier] the live PoQuality tier (the ceiling)
 */
export function stepBudget(s, frameMs, tier) {
    let changed = -1;
    // The ceiling moves first: a lower tier applies at once, never waiting for a read.
    if (tier && TIER_TOP[tier] !== undefined && tier !== s.tier) {
        s.tier = tier;
        const top = TIER_TOP[tier];
        if (s.rung > top) { s.rung = top; changed = top; }
        s.slowReads = 0; s.fastReads = 0;
    }
    if (!(frameMs > 0) || frameMs > 250) return changed;
    s.ring[s.cursor] = frameMs;
    s.cursor = (s.cursor + 1) % RING;
    if (s.filled < RING) s.filled++;
    if (++s.sinceEval < EVAL_EVERY || s.filled < EVAL_EVERY) return changed;
    s.sinceEval = 0;

    const p95 = percentile(s.ring, s.filled, 0.95, s.scratch);
    s.lastP95 = p95;
    const top = TIER_TOP[s.tier];
    if (p95 > s.targetMs * 1.25) {
        s.fastReads = 0;
        if (++s.slowReads >= DROP_READS && s.rung > 0) {
            s.rung--; s.slowReads = 0; changed = s.rung;
            // A drop invalidates the history: the next read should judge the new rung.
            s.filled = 0; s.cursor = 0;
        }
    } else if (p95 < s.targetMs * 0.85) {
        s.slowReads = 0;
        if (++s.fastReads >= RAISE_READS && s.rung < top) {
            s.rung++; s.fastReads = 0; changed = s.rung;
            s.filled = 0; s.cursor = 0;
        }
    } else {
        s.slowReads = 0; s.fastReads = 0;
    }
    return changed;
}

function liveTier() {
    try {
        const t = typeof window !== 'undefined' ? window.PoQuality?.tier?.() : null;
        return TIER_TOP[t] !== undefined ? t : 'high';
    } catch { return 'high'; }
}

/**
 * The live wrapper an engine holds. Call frame(ms) once per rendered frame; onChange fires
 * with the new rung (LADDER entry, plus `index`) whenever it moves.
 */
export class RenderBudget {
    /** @param {{targetMs?:number, onChange?:(rung:object)=>void, tier?:()=>string}} [opts] */
    constructor(opts = {}) {
        this._tier = typeof opts.tier === 'function' ? opts.tier : liveTier;
        this.state = createBudgetState({ targetMs: opts.targetMs, tier: this._tier() });
        this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    }

    get rung() { return { ...LADDER[this.state.rung], index: this.state.rung }; }
    get p95() { return this.state.lastP95; }

    /** Particle share relative to what the rung's own tier already assumes (≤ 1). */
    get particleScale() {
        const r = LADDER[this.state.rung];
        return Math.min(1, r.particles / TIER_NOMINAL_PARTICLES[r.tier]);
    }

    frame(frameMs) {
        const idx = stepBudget(this.state, frameMs, this._tier());
        if (idx >= 0 && this.onChange) {
            try { this.onChange(this.rung); } catch { /* an engine bug must not stop the budget */ }
        }
        return idx >= 0;
    }

    /** The app tier changed by hand: jump to that tier's top rung and judge afresh. */
    snapTo(tier) {
        if (TIER_TOP[tier] === undefined) return;
        this.state.tier = tier;
        this.state.rung = TIER_TOP[tier];
        this.reset();
    }

    /** Start judging afresh (after a load, a pause, a camera cut). */
    reset() {
        const s = this.state;
        s.filled = 0; s.cursor = 0; s.sinceEval = 0; s.slowReads = 0; s.fastReads = 0;
    }
}

/**
 * Apply a rung's pixel ratio and shadow policy to a three.js WebGLRenderer.
 * Static shadows: the map is re-rendered on every 4th call of tickShadows() instead of every frame.
 * @returns {number} the pixel ratio set
 */
export function applyToRenderer(renderer, rung, baseDpr) {
    if (!renderer || !rung) return 1;
    const dpr = Math.min(Number(baseDpr) || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, rung.maxDpr) * rung.resScale;
    try { renderer.setPixelRatio(dpr); } catch { /* lost context */ }
    if (renderer.shadowMap) {
        renderer.shadowMap.autoUpdate = !rung.staticShadows;
        if (rung.staticShadows) renderer.shadowMap.needsUpdate = true;
    }
    return dpr;
}

/** With static shadows, refresh the map every `every` frames. Call once per frame. */
export function tickShadows(renderer, frameNo, every = 4) {
    const sm = renderer?.shadowMap;
    if (sm && sm.enabled && !sm.autoUpdate && frameNo % every === 0) sm.needsUpdate = true;
}

if (typeof window !== 'undefined') {
    window.PoRenderBudget = { LADDER, TIER_TOP, RenderBudget, applyToRenderer, tickShadows };
}
