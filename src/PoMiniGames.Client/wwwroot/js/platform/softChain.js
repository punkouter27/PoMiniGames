// softChain.js — soft objects and simple cloth (deck idea #11).
//
// Banners, flags, netting, loose cables: things that should swing when something
// happens near them, then come back to how they hang. A plain sine sway never answers a
// hit; a full cloth solver is too much for a decoration. This is the middle: a tiny
// Verlet grid (a chain is a grid one column wide) with
//   • distance constraints along rows and columns (it keeps its length),
//   • SHAPE MEMORY — every free point is pulled a little toward its rest position, so a
//     kicked banner settles back to hanging straight instead of tangling,
//   • pinned points (a banner's top edge, a cable's two ends),
//   • external forces: a constant draft plus impulses (a KO gust, a passing car).
//
// Float32Arrays, no allocation per step. Positions are in the object's LOCAL space; the
// engine maps offset(i) onto its geometry. For devices that should not run even this,
// VERTEX_WAVE_GLSL is the shader-only fallback: the same droop-weighted sway, no state.

/**
 * @param {object} o
 * @param {number} [o.cols=1]  points across (1 = chain)
 * @param {number} [o.rows=8]  points down
 * @param {number} [o.width=1]
 * @param {number} [o.height=2]
 * @param {'top'|'ends'|'none'} [o.pin='top']
 * @param {number} [o.memory=0.06]   0..1 pull toward rest per step
 * @param {number} [o.damping=0.985] velocity kept per step
 * @param {number} [o.iterations=3]
 * @param {number} [o.gravity=-2]    local-y acceleration (light: memory carries the hang)
 */
export function createSoftGrid(o = {}) {
    const cols = Math.max(1, o.cols ?? 1), rows = Math.max(2, o.rows ?? 8);
    const width = o.width ?? 1, height = o.height ?? 2;
    const N = cols * rows;
    const pos = new Float32Array(N * 3), prev = new Float32Array(N * 3), rest = new Float32Array(N * 3);
    const inv = new Uint8Array(N); // 1 = free, 0 = pinned
    const memory = o.memory ?? 0.06, damping = o.damping ?? 0.985, iters = o.iterations ?? 3;
    const gravity = o.gravity ?? -2;
    const pin = o.pin ?? 'top';
    const dx = cols > 1 ? width / (cols - 1) : 0, dy = height / (rows - 1);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const x = cols > 1 ? -width / 2 + c * dx : 0, y = -r * dy;
            pos[i * 3] = prev[i * 3] = rest[i * 3] = x;
            pos[i * 3 + 1] = prev[i * 3 + 1] = rest[i * 3 + 1] = y;
            pos[i * 3 + 2] = prev[i * 3 + 2] = rest[i * 3 + 2] = 0;
            inv[i] = (pin === 'top' && r === 0) || (pin === 'ends' && (r === 0 || r === rows - 1)) ? 0 : 1;
        }
    }

    // Constraint list: [a, b, restLength]
    const links = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (c + 1 < cols) links.push(i, i + 1);
            if (r + 1 < rows) links.push(i, i + cols);
        }
    }
    const linkA = new Uint16Array(links.filter((_, k) => k % 2 === 0));
    const linkB = new Uint16Array(links.filter((_, k) => k % 2 === 1));
    const linkLen = new Float32Array(linkA.length);
    for (let k = 0; k < linkA.length; k++) {
        const a = linkA[k] * 3, b = linkB[k] * 3;
        linkLen[k] = Math.hypot(rest[a] - rest[b], rest[a + 1] - rest[b + 1], rest[a + 2] - rest[b + 2]);
    }

    let fx = 0, fy = 0, fz = 0;

    return {
        cols, rows, N, pos, rest,
        /** Constant force (draft/wind), local units/s². */
        setForce(x, y, z) { fx = x || 0; fy = y || 0; fz = z || 0; },
        /**
         * Instant velocity kick (local units/s), weighted by distance from the pins so
         * the free end moves most. `dt` converts velocity into a Verlet prev offset.
         */
        impulse(x, y, z, dt = 1 / 60) {
            for (let i = 0; i < N; i++) {
                if (!inv[i]) continue;
                const droop = Math.min(1, -rest[i * 3 + 1] / height + 0.15);
                prev[i * 3] -= x * dt * droop;
                prev[i * 3 + 1] -= y * dt * droop;
                prev[i * 3 + 2] -= z * dt * droop;
            }
        },
        step(dtIn) {
            const dt = Math.min(dtIn, 1 / 30);
            const dt2 = dt * dt;
            for (let i = 0; i < N; i++) {
                if (!inv[i]) continue;
                const k = i * 3;
                for (let a = 0; a < 3; a++) {
                    const p = pos[k + a];
                    const acc = a === 0 ? fx : a === 1 ? fy + gravity : fz;
                    let next = p + (p - prev[k + a]) * damping + acc * dt2;
                    next += (rest[k + a] - next) * memory;   // shape memory
                    prev[k + a] = p;
                    pos[k + a] = next;
                }
            }
            for (let it = 0; it < iters; it++) {
                for (let k = 0; k < linkA.length; k++) {
                    const ia = linkA[k], ib = linkB[k], a = ia * 3, b = ib * 3;
                    const ddx = pos[b] - pos[a], ddy = pos[b + 1] - pos[a + 1], ddz = pos[b + 2] - pos[a + 2];
                    const d = Math.hypot(ddx, ddy, ddz) || 1e-6;
                    const wa = inv[ia], wb = inv[ib], w = wa + wb;
                    if (!w) continue;
                    const diff = (d - linkLen[k]) / d / w;
                    pos[a] += ddx * diff * wa; pos[a + 1] += ddy * diff * wa; pos[a + 2] += ddz * diff * wa;
                    pos[b] -= ddx * diff * wb; pos[b + 1] -= ddy * diff * wb; pos[b + 2] -= ddz * diff * wb;
                }
            }
        },
        /** Displacement of point i from rest, written into out (no allocation). */
        offset(i, out) {
            const k = i * 3;
            out.x = pos[k] - rest[k]; out.y = pos[k + 1] - rest[k + 1]; out.z = pos[k + 2] - rest[k + 2];
            return out;
        },
        /** Max displacement magnitude — handy for "is it still moving?" checks. */
        energy() {
            let m = 0;
            for (let i = 0; i < N * 3; i += 3) {
                const d = Math.hypot(pos[i] - rest[i], pos[i + 1] - rest[i + 1], pos[i + 2] - rest[i + 2]);
                if (d > m) m = d;
            }
            return m;
        },
    };
}

/** A hanging chain (rope, cable, single-column banner strip). */
export function createChain(o = {}) {
    return createSoftGrid({ ...o, cols: 1, rows: o.count ?? o.rows ?? 8, height: o.length ?? o.height ?? 2 });
}

/**
 * Shader-only fallback. Include in a vertex shader and call
 *   transformed = poSoftWave(transformed, pinY, height, uTime, amp, phase);
 * The same droop-squared sway as the CPU sim's idle, with no state and no forces.
 */
export const VERTEX_WAVE_GLSL = /* glsl */ `
vec3 poSoftWave(vec3 p, float pinY, float height, float t, float amp, float phase) {
  float droop = clamp((pinY - p.y) / max(height, 1e-4), 0.0, 1.0);
  float a = amp * droop * droop;
  p.z += a * sin(t * 1.7 + p.x * 1.6 + p.y * 0.7 + phase);
  p.x += a * 0.4 * sin(t * 1.1 + p.y * 0.9 + phase);
  return p;
}
`;
