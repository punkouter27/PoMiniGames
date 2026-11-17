// ragdollBlend.js — ragdolls that settle, not flop (deck idea #9).
//
// A physics ragdoll reads badly at its two ends: the HANDOFF (an authored pose snaps
// into a limp body) and the REST (a body that is nearly still keeps micro-jittering as
// the solver fights its contacts, so the pile shivers on the canvas). This module is the
// pure math for both, plus the way back up:
//
//   crossfadeWeight(t)   animation → physics, a short smoothstep in
//   recoveryWeight(t)    physics → animation, an eased hand-back for a get-up
//   clampSwingTwist(q)   joint limits on the visual quaternion (swing cone + twist)
//   settleAlpha(speed)   how much of this frame's physics pose to take: 1 while moving,
//                        down to a floor as the body goes still — a speed-gated low-pass
//   createSettler()      that low-pass, per joint, over {x,y,z,w} quaternions
//   biasToward(q, rest)  pull a nearly-still pose a little toward a stable rest pose
//
// PRESENTATION ONLY. Nothing here touches a physics body: it filters what the rig SHOWS.
// The filter is a function of the body's speed alone (never of frame dt), so a replay
// that drives the same bodies shows the same pose.
//
// Quaternions are any {x,y,z,w} objects (THREE.Quaternion, cannon Quaternion, plain).

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => t * t * (3 - 2 * t);

/** Animation→ragdoll handoff weight: 0 = all animation, 1 = all physics. */
export function crossfadeWeight(t, duration = 0.12) {
    if (duration <= 0) return 1;
    return smooth(clamp01(t / duration));
}

/** Ragdoll→animation recovery weight: 1 = all physics at t=0, 0 = animation back in control. */
export function recoveryWeight(t, duration = 0.4) {
    if (duration <= 0) return 0;
    const k = clamp01(t / duration);
    // Ease-out: the animation takes over quickly, then lands softly.
    return 1 - (1 - (1 - k) * (1 - k));
}

/**
 * Fraction of the new physics pose to take this frame, from the body's speed (m/s).
 * Moving: 1 (follow physics exactly). Still: `minAlpha` (heavy low-pass kills solver jitter).
 */
export function settleAlpha(speed, opts = {}) {
    const still = opts.still ?? 0.25;
    const moving = opts.moving ?? 1.5;
    const minAlpha = opts.minAlpha ?? 0.18;
    const s = Math.max(0, Number(speed) || 0);
    if (s >= moving) return 1;
    if (s <= still) return minAlpha;
    return minAlpha + (1 - minAlpha) * smooth((s - still) / (moving - still));
}

function normalize(q) {
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    q.x /= l; q.y /= l; q.z /= l; q.w /= l;
    return q;
}

/** Shortest-path nlerp of a toward b by t, written into out. Cheap, and fine for small steps. */
export function nlerp(a, b, t, out = { x: 0, y: 0, z: 0, w: 1 }) {
    const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    const s = dot < 0 ? -1 : 1;
    out.x = a.x + (b.x * s - a.x) * t;
    out.y = a.y + (b.y * s - a.y) * t;
    out.z = a.z + (b.z * s - a.z) * t;
    out.w = a.w + (b.w * s - a.w) * t;
    return normalize(out);
}

/** Angle (radians) between two unit quaternions. */
export function angleBetween(a, b) {
    const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    return 2 * Math.acos(Math.min(1, d));
}

/**
 * Clamp a local joint rotation to a swing cone and a twist range about `axis` (unit
 * {x,y,z}, the bone direction). Swing–twist decomposition: twist is the rotation about
 * the axis, swing the rest. Returns `out` (may alias q).
 */
export function clampSwingTwist(q, axis, coneMax, twistMax, out = { x: 0, y: 0, z: 0, w: 1 }) {
    // Twist = projection of q's vector part onto the axis.
    const p = q.x * axis.x + q.y * axis.y + q.z * axis.z;
    let tx = axis.x * p, ty = axis.y * p, tz = axis.z * p, tw = q.w;
    let tl = Math.hypot(tx, ty, tz, tw);
    if (tl < 1e-9) { tx = 0; ty = 0; tz = 0; tw = 1; tl = 1; }
    tx /= tl; ty /= tl; tz /= tl; tw /= tl;
    // swing = q * conj(twist)
    const cx = -tx, cy = -ty, cz = -tz, cw = tw;
    let sx = q.w * cx + q.x * cw + q.y * cz - q.z * cy;
    let sy = q.w * cy - q.x * cz + q.y * cw + q.z * cx;
    let sz = q.w * cz + q.x * cy - q.y * cx + q.z * cw;
    let sw = q.w * cw - q.x * cx - q.y * cy - q.z * cz;

    // Clamp each to its limit by scaling its half-angle.
    const clampHalf = (vx, vy, vz, w, max) => {
        if (w < 0) { vx = -vx; vy = -vy; vz = -vz; w = -w; }
        const ang = 2 * Math.acos(Math.min(1, w));
        if (ang <= max) return [vx, vy, vz, w];
        const vl = Math.hypot(vx, vy, vz) || 1;
        const h = max / 2, sn = Math.sin(h);
        return [(vx / vl) * sn, (vy / vl) * sn, (vz / vl) * sn, Math.cos(h)];
    };
    [sx, sy, sz, sw] = clampHalf(sx, sy, sz, sw, coneMax);
    [tx, ty, tz, tw] = clampHalf(tx, ty, tz, tw, twistMax);

    // q' = swing * twist
    out.x = sw * tx + sx * tw + sy * tz - sz * ty;
    out.y = sw * ty - sx * tz + sy * tw + sz * tx;
    out.z = sw * tz + sx * ty - sy * tx + sz * tw;
    out.w = sw * tw - sx * tx - sy * ty - sz * tz;
    return normalize(out);
}

/**
 * Stable-pose bias: once a body is nearly still, nudge its pose toward a known stable
 * rest pose (curled, flat) by at most `maxBias` per call. Moving bodies are untouched.
 */
export function biasToward(q, rest, speed, opts = {}) {
    const maxBias = opts.maxBias ?? 0.06;
    const still = opts.still ?? 0.25;
    if (!rest || speed > still) return q;
    const k = maxBias * (1 - clamp01(speed / still));
    return nlerp(q, rest, k, q);
}

/**
 * Per-joint low-pass over physics poses. `apply(key, q, speed)` writes the filtered
 * rotation back into q and remembers it; `reset()` forgets (call when a ragdoll is
 * rebuilt so the first frame is the physics pose, not a stale one).
 */
export function createSettler(opts = {}) {
    const prev = new Map();
    return {
        apply(key, q, speed) {
            const last = prev.get(key);
            if (last) {
                const a = settleAlpha(speed, opts);
                if (a < 1) nlerp(last, q, a, q);
                last.x = q.x; last.y = q.y; last.z = q.z; last.w = q.w;
            } else {
                prev.set(key, { x: q.x, y: q.y, z: q.z, w: q.w });
            }
            return q;
        },
        reset() { prev.clear(); },
        get size() { return prev.size; },
    };
}
