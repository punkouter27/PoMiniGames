/**
 * Auto-director for the spectator demo.
 *
 * The demo used to always follow whoever was closest to the chamber doors (selectLeader).
 * That is the right answer for "who is winning" and the wrong answer for "what is worth
 * watching": most of the afternoon is spent queuing at the terrace steps while two lines
 * shove each other a few metres away.
 *
 * This module keeps a coarse, decaying heat grid fed by the impact events the simulation
 * already emits, scores every living raider against it, and cuts between subjects on a
 * 4-8 second dwell with hysteresis so the camera does not flap. It reads state and never
 * writes it.
 */
const CELL = 10;
const HEAT_LIFE = 4.5;
const MAX_CELLS = 600;

export function cellKey(x, z) {
    return `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
}

/** Raise the heat under one event, in joules, bucketed to something a score can use. */
export function addHeat(heat, event) {
    if (!event || !Number.isFinite(event.x) || !Number.isFinite(event.z)) return;
    const weight = Number.isFinite(event.energy) ? Math.min(3, event.energy / 120) : 0.6;
    const key = cellKey(event.x, event.z);
    heat.set(key, Math.min(12, (heat.get(key) ?? 0) + weight));
}

export function decayHeat(heat, dt) {
    if (heat.size === 0) return;
    const keep = Math.exp(-dt / HEAT_LIFE);
    for (const [key, value] of heat) {
        const next = value * keep;
        if (next < 0.05) heat.delete(key);
        else heat.set(key, next);
    }
    if (heat.size > MAX_CELLS) heat.clear();
}

/** Heat within one cell of a point, so a shove in the next cell still counts. */
export function heatAt(heat, x, z) {
    let total = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            total += heat.get(cellKey(x + dx * CELL, z + dz * CELL)) ?? 0;
        }
    }
    return total;
}

/**
 * How good a subject one raider is right now. Higher is better; the terms are deliberately
 * small integers and fractions so no single one can dominate a quiet stretch of simulation.
 */
export function scoreCandidate(state, actor, heat) {
    if (!actor || actor.health <= 0) return -Infinity;
    let score = heatAt(heat, actor.x, actor.z) * 0.8;
    score += Math.min(4, (actor.milestone ?? 0) * 0.7);
    score += Math.min(1.5, (actor.crowding ?? 0) / 5);
    const front = state.lines?.find(line => line.state === 'holding');
    if (front) {
        // The line's own officers carry its z, so nothing here duplicates a scenario constant.
        const officers = state.enemies?.filter(e => e.line === front.id) ?? [];
        const officer = officers.find(e => e.health > 0) ?? officers[0];
        if (officer) score += Math.max(0, 1.6 - Math.abs(actor.z - officer.z) / 12);
    }
    if (actor.filming) score -= 0.35;
    return score;
}

export function createDirector({ dwellMin = 4, dwellMax = 8 } = {}) {
    const heat = new Map();
    let subjectId = -1;
    let held = 0;
    let target = dwellMin;
    let last = 0;

    return {
        /** Feed the frame's impacts in. Cheap: the events array is already on the state. */
        observe(state, now) {
            const dt = last ? Math.min(0.25, Math.max(0, (now - last) / 1000)) : 0;
            last = now;
            decayHeat(heat, dt);
            for (const event of state.events ?? []) addHeat(heat, event);
            held += dt;
        },

        /** The raider the camera should be on, or null to fall back to the leader. */
        pick(state) {
            const living = state.companions.filter(c => c.health > 0);
            if (living.length === 0) { subjectId = -1; return null; }
            const current = living.find(c => c.id === subjectId);
            let best = null, bestScore = -Infinity;
            for (const actor of living) {
                const score = scoreCandidate(state, actor, heat);
                if (score > bestScore) { best = actor; bestScore = score; }
            }
            if (current && held < target) {
                const kept = scoreCandidate(state, current, heat);
                if (kept >= bestScore * 0.72) return current;
            }
            if (best && best.id !== subjectId) {
                subjectId = best.id;
                held = 0;
                target = dwellMin + Math.random() * Math.max(0, dwellMax - dwellMin);
            }
            return best;
        },

        reset() {
            heat.clear();
            subjectId = -1;
            held = 0;
            last = 0;
        },

        get id() { return subjectId; },
    };
}
