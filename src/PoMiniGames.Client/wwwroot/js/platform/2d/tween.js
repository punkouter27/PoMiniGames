// tween.js — easing curves and frame-rate-independent smoothing shared by the 2D games.

export const ease = Object.freeze({
    linear: (t) => t,
    inQuad: (t) => t * t,
    outQuad: (t) => t * (2 - t),
    inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    outCubic: (t) => 1 - (1 - t) ** 3,
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
    outBack: (t) => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
    outElastic: (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1),
});

/** Exponential approach of `a` to `b` that looks the same at any frame rate. */
export function damp(a, b, lambda, dt) {
    return b + (a - b) * Math.exp(-lambda * dt);
}

/**
 * Critically-damped-ish spring step on a {x, v} state toward target. Mutates and returns state.
 * k = stiffness, d = damping. Sub-steps a long frame so a hitch cannot make it explode.
 */
export function springStep(state, target, k, d, dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
        const a = k * (target - state.x) - d * state.v;
        state.v += a * h;
        state.x += state.v * h;
    }
    return state;
}

/** clamp(x, lo, hi) and lerp, because every engine had its own copy. */
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
