// Pure timing and geometry for a body going down, so the staging can be tested without three.js.
//
// A collapse is not one rotation. The weight goes first, the knees buckle, the body tips the way
// the round pushed it, and then it settles. Higher-detail figures read this the same way whether
// they are the player, a raider or an officer.

/**
 * Progress through a collapse at `age` seconds. `zone` is where the round landed: a head hit folds
 * a person immediately, anywhere else there is a beat of bracing first.
 * Returns fractions in 0..1; `tipAngle` is how far the body has tipped from upright.
 */
export function collapseStage(age, zone = 'torso', seed = 0.5) {
    const a = Number.isFinite(age) ? Math.max(0, age) : 0;
    const head = zone === 'head';
    const p = Math.min(1, a / (head ? 0.55 : 0.9));
    const ease = 1 - (1 - p) ** 3;
    const brace = head ? 0 : Math.max(0, 1 - p / 0.32);
    const tip = head ? ease : Math.max(0, Math.min(1, (p - 0.16) / 0.6));
    const settle = Math.max(0, Math.min(1, (p - 0.7) / 0.3));
    const flail = Math.sin(a * 15 + seed * 6.3) * (1 - tip) * (1 - settle);
    return { p, ease, brace, tip, settle, flail, tipAngle: Math.PI / 2 * tip };
}

/**
 * Pitch and roll that lay the body down in the direction the impact came from. `rel` is the impact
 * angle in the body's own frame: 0 is straight ahead, +PI/2 is to its right, PI is from behind.
 */
export function tipAxes(rel, tipAngle) {
    return { fall: -Math.cos(rel) * tipAngle, lean: -Math.sin(rel) * tipAngle };
}

/**
 * Splits a world-space impact direction into the body's frame. `heading` turns the figure; its
 * forward is -Z and its right is +X.
 */
export function impactFrame(dx, dz, heading = 0) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return { fw: 0, rt: 0, rel: Math.PI };
    const x = dx / len, z = dz / len;
    const fw = -(x * Math.sin(heading) + z * Math.cos(heading));
    const rt = x * Math.cos(heading) - z * Math.sin(heading);
    return { fw, rt, rel: Math.atan2(rt, fw) };
}

/** How far apart two bodies count as the same heap, how thick a body lies, and how deep a heap forms. */
export const PILE_REACH = 1.25;
const PILE_LIFT = 0.17, PILE_DEPTH = 3;

/**
 * Where a body comes to rest when people fall on top of one another. `downs` are the bodies
 * already on the ground near it, each `{ x, z, layer }` from an earlier call. Returns the offset
 * from where this person fell, the height the body lies at, and a roll, so a heap stacks and
 * splays outward instead of every body lying in the same place. Pure: no three.js, no state.
 */
export function restPlace(x, z, downs = [], reach = PILE_REACH) {
    let layer = 0, sumX = 0, sumZ = 0, found = 0;
    for (const down of downs) {
        if (Math.hypot(down.x - x, down.z - z) > reach) continue;
        // A heap is a heap, not a tower: past three bodies a new one splays out rather than climbs.
        layer = Math.min(PILE_DEPTH, Math.max(layer, (down.layer ?? 0) + 1));
        sumX += down.x; sumZ += down.z; found++;
    }
    let dx = 0, dz = 0;
    if (found) {
        const len = Math.hypot(x - sumX / found, z - sumZ / found);
        const push = Math.min(0.45, 0.2 + found * 0.08);
        if (len > 1e-3) { dx = (x - sumX / found) / len * push; dz = (z - sumZ / found) / len * push; }
        else { dx = push; dz = 0; }
    }
    return { dx, dz, layer, height: layer * PILE_LIFT + (layer ? 0.02 : 0), roll: layer ? Math.min(0.5, 0.16 + layer * 0.12) : 0 };
}
