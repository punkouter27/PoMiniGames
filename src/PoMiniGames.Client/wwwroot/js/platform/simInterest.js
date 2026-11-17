// simInterest.js — interest management for simulation (deck idea #12).
//
// Not every body deserves a full step every frame. Balloons resting on the far apron, a
// spectator in the back row, a scenic car on the other side of the track: run them at
// a lower rate, or not at all, and spend the frame on what the player is looking at.
//
//   FULL     every frame, full dt          near, or visible and moving, or important
//   REDUCED  every other frame, 2 × dt     visible but still, or moving off-screen
//   DORMANT  not stepped                   off-screen and still, or far and still
//
// THE DETERMINISM RULE. Anything that is part of multiplayer or replay state is flagged
// `deterministic` and is ALWAYS full: thinning a body two peers both simulate would make
// them disagree. Interest management is for presentation-only bodies (and for local
// sims that are never compared with anyone).
//
// Reduced bodies are staggered by id, so half step on even frames and half on odd ones:
// the cost halves smoothly instead of spiking every other frame.

export const LEVEL = Object.freeze({ FULL: 0, REDUCED: 1, DORMANT: 2 });

/**
 * @param {object} b
 * @param {number}  b.distance        to the camera or the player, world units
 * @param {boolean} [b.visible=true]
 * @param {number}  [b.speed=0]
 * @param {boolean} [b.deterministic] part of netplay/replay state: always FULL
 * @param {boolean} [b.important]     the player, the ball, the leader: always FULL
 * @param {object}  [opts]
 * @param {number}  [opts.near=6]     inside this, always FULL
 * @param {number}  [opts.far=30]     beyond this, visibility no longer buys FULL
 * @param {number}  [opts.moving=0.05] speed that counts as moving
 * @returns {0|1|2}
 */
export function classify(b, opts = {}) {
    if (b.deterministic || b.important) return LEVEL.FULL;
    const near = opts.near ?? 6, far = opts.far ?? 30, movingAt = opts.moving ?? 0.05;
    const d = Math.max(0, Number(b.distance) || 0);
    if (d <= near) return LEVEL.FULL;
    const visible = b.visible !== false;
    const moving = (b.speed ?? 0) > movingAt;
    if (moving) return visible && d <= far ? LEVEL.FULL : LEVEL.REDUCED;
    return visible && d <= far ? LEVEL.REDUCED : LEVEL.DORMANT;
}

/** Should a body at `level` step on `frame`? `id` staggers REDUCED bodies. */
export function shouldStep(level, frame, id = 0) {
    if (level === LEVEL.FULL) return true;
    if (level === LEVEL.REDUCED) return ((frame + id) & 1) === 0;
    return false;
}

/** The dt a body should integrate with when it does step (REDUCED catches up). */
export function stepDt(level, dt) {
    return level === LEVEL.REDUCED ? dt * 2 : dt;
}

/**
 * A frame counter plus per-level tallies, for engines that want one object to ask.
 * `begin()` once per frame; `step(id, body)` returns the dt to use, or 0 to skip.
 */
export function createInterest(opts = {}) {
    let frame = 0;
    const counts = [0, 0, 0];
    return {
        begin() { frame++; counts[0] = counts[1] = counts[2] = 0; },
        step(id, body, dt) {
            const lvl = classify(body, opts);
            counts[lvl]++;
            return shouldStep(lvl, frame, id) ? stepDt(lvl, dt) : 0;
        },
        get frame() { return frame; },
        stats() { return { full: counts[0], reduced: counts[1], dormant: counts[2] }; },
    };
}
