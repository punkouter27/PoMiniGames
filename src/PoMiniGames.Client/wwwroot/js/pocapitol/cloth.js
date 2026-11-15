// Cloth that hangs: the banners and the flag the crowd drapes over the stands.
//
// The flags on poles ripple by a formula in their vertex shader, which is right for a hundred
// flags a long way off. A nine-metre banner hanging off a scaffold is looked at for minutes, and
// a formula has no weight: it cannot sag, swing out in a gust and fall back, or jump when a
// flash-bang goes off under it. These are simulated instead, as a grid of points held together
// by fixed-length links (Verlet integration, the links re-tightened a few times a step), pinned
// along the top edge, under gravity and a wind that gusts unevenly across the cloth.
//
// Pure arithmetic with no DOM or three.js. Positions are in the cloth's own frame: x across,
// y up (the top edge is y = 0, the cloth hangs down to -height), z out of its face.

const GRAVITY = 9.81;

export function createCloth({ width = 4, height = 2, cols = 20, rows = 8, weight = 1 } = {}) {
    const n = cols * rows, dx = width / (cols - 1), dy = height / (rows - 1);
    const now = new Float32Array(n * 3), before = new Float32Array(n * 3);
    const at = (i, j) => (j * cols + i) * 3;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const k = at(i, j);
        now[k] = before[k] = -width / 2 + i * dx; now[k + 1] = before[k + 1] = -j * dy; now[k + 2] = before[k + 2] = 0;
    }
    // Links: along the weave both ways, and across each square so it cannot shear flat.
    const links = [];
    const link = (a, b, rest) => links.push(a, b, rest);
    const diagonal = Math.hypot(dx, dy);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (i + 1 < cols) link(at(i, j), at(i + 1, j), dx);
        if (j + 1 < rows) link(at(i, j), at(i, j + 1), dy);
        if (i + 1 < cols && j + 1 < rows) { link(at(i, j), at(i + 1, j + 1), diagonal); link(at(i + 1, j), at(i, j + 1), diagonal); }
    }
    let kick = 0, kickSide = 1;

    /**
     * One step.
     * @param push  wind through the cloth's face, m/s (positive blows it toward +z)
     * @param time  seconds, for the gusts
     */
    function step(dt, push = 0, time = 0) {
        const h = Math.min(0.033, Math.max(0.001, dt)), drag = 0.985;
        for (let j = 1; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = at(i, j);
            const x = now[k], y = now[k + 1], z = now[k + 2];
            // A gust is not the same all over: it crosses the cloth as a moving pattern.
            const gust = 0.55 + 0.45 * Math.sin(time * 1.7 + x * 0.9 + y * 0.6) * Math.sin(time * 0.61 + x * 0.31);
            const az = (push * gust * 1.4 + kick * kickSide * (0.4 + j / rows)) / weight;
            now[k] = x + (x - before[k]) * drag;
            now[k + 1] = y + (y - before[k + 1]) * drag - GRAVITY * h * h;
            now[k + 2] = z + (z - before[k + 2]) * drag + az * h * h * 6;
            before[k] = x; before[k + 1] = y; before[k + 2] = z;
        }
        kick *= Math.exp(-h * 9);
        for (let pass = 0; pass < 3; pass++) {
            for (let l = 0; l < links.length; l += 3) {
                const a = links[l], b = links[l + 1], rest = links[l + 2];
                const ex = now[b] - now[a], ey = now[b + 1] - now[a + 1], ez = now[b + 2] - now[a + 2];
                const length = Math.hypot(ex, ey, ez) || 1e-6, give = (length - rest) / length * 0.5;
                // The top row is pinned: a link to it moves only its free end, and all the way.
                const pinA = a < cols * 3, pinB = b < cols * 3;
                if (pinA && pinB) continue;
                const ka = pinA ? 0 : pinB ? 2 : 1, kb = pinB ? 0 : pinA ? 2 : 1;
                now[a] += ex * give * ka; now[a + 1] += ey * give * ka; now[a + 2] += ez * give * ka;
                now[b] -= ex * give * kb; now[b + 1] -= ey * give * kb; now[b + 2] -= ez * give * kb;
            }
        }
    }

    return {
        cols, rows, width, height, positions: now, step,
        /** A blast or a body against the cloth: it jumps away from `side` (+1 or -1) and swings back. */
        impulse(strength, side = 1) { kick = Math.max(kick, strength); kickSide = side >= 0 ? 1 : -1; },
        /** How far the free edge has swung out of the hanging plane, metres. */
        swing() {
            let sum = 0;
            for (let i = 0; i < cols; i++) sum += now[at(i, rows - 1) + 2];
            return sum / cols;
        },
    };
}
