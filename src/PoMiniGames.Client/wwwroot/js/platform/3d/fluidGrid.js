// platform/3d/fluidGrid.js — gas, smoke or any light airborne density as a fluid on a 2D grid
// over the ground, for any 3D game (written for PoCapitol's gas, which still uses the defaults).
// fluidGridGpu.js is the same model as WebGPU compute shaders, with this as its fallback.
//
//
// The world reports a cloud as a point, a radius and a lifetime, and the sprites in particles.js
// draw exactly that: a ball that grows and fades where the canister landed. This layer is what
// the ball leaves out. Density is carried on a coarse grid over the whole route by a velocity
// field made of the day's wind, the push of people moving through it, and the cloud's own
// spreading, and that field is made to flow round walls and columns instead of through them.
// So gas let off in a doorway pools in the room behind it, a cloud on the lawn streams downwind
// and splits round the stands, and a crowd running through a bank drags a hole in it.
//
// In PoCapitol nothing in the simulation reads this (who coughs is still decided by its
// world.js); its ray-marched haze (pocapitol/volumetric.js) samples `bytes` as a texture.
//
// Pure arithmetic with no DOM or three.js, so it can be tested with made-up clouds.

/** Seconds for outdoor gas to thin to 1/e of itself, and for gas held in by a room. */
export const GAS_LIFE_OUT = 38, GAS_LIFE_IN = 75;
/** Share of the wind that the air at ground level, among a crowd, actually moves at. */
export const WIND_SHARE = 0.16;

/**
 * @param rect     { x0, z0, w, d }: the ground the grid covers, in world metres
 * @param cols     cells across x
 * @param rows     cells along z
 * @param blocked  (x, z) => true where gas cannot be (walls, columns, the stands)
 * @param indoors  (x, z) => true where there is no wind
 */
/**
 * @param physics  { lifeOut, lifeIn, windShare }: seconds to thin to 1/e outdoors and indoors, and
 *                 the share of the wind the air at ground level moves at (defaults: PoCapitol's gas)
 */
export function createFluidGrid({ x0 = -40, z0 = -56, w = 80, d = 152 } = {}, cols = 64, rows = 120, blocked = () => false, indoors = (x, z) => z < 14.5,
    { lifeOut = GAS_LIFE_OUT, lifeIn = GAS_LIFE_IN, windShare = WIND_SHARE } = {}) {
    const n = cols * rows, cw = w / cols, cd = d / rows;
    const density = new Float32Array(n), next = new Float32Array(n);
    const vx = new Float32Array(n), vz = new Float32Array(n), pressure = new Float32Array(n), div = new Float32Array(n);
    const solid = new Uint8Array(n), inside = new Uint8Array(n);
    const bytes = new Uint8Array(n);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = x0 + (i + 0.5) * cw, z = z0 + (j + 0.5) * cd;
        solid[j * cols + i] = blocked(x, z) ? 1 : 0;
        inside[j * cols + i] = indoors(x, z) ? 1 : 0;
    }
    const at = (i, j) => j * cols + i;
    const within = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;
    const open = (i, j) => within(i, j) && !solid[at(i, j)];
    // The edge of the grid is open air, not a wall: wind blows in one side and out the other,
    // and gas that reaches the edge leaves. Only what `blocked` marks is solid.
    /** A neighbour's value for a flow quantity: nothing moves into a wall; past the edge it is `beyond`. */
    const beside = (field, i, j, wall, beyond) => (within(i, j) ? (solid[at(i, j)] ? wall : field[at(i, j)]) : beyond);
    let mass = 0;

    /** Density at a world point, 0 where the grid does not reach or a wall stands. */
    function sample(x, z) {
        const fx = (x - x0) / cw - 0.5, fz = (z - z0) / cd - 0.5;
        const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
        const get = (a, b) => (a >= 0 && b >= 0 && a < cols && b < rows ? density[at(a, b)] : 0);
        return (get(i, j) * (1 - tx) + get(i + 1, j) * tx) * (1 - tz) + (get(i, j + 1) * (1 - tx) + get(i + 1, j + 1) * tx) * tz;
    }

    /** Adds `amount` of density spread over a disc of radius `r` (metres) around a point. */
    function inject(x, z, amount, r = 2) {
        const ci = (x - x0) / cw, cj = (z - z0) / cd, ri = Math.max(1, r / cw), rj = Math.max(1, r / cd);
        for (let j = Math.max(0, Math.floor(cj - rj)); j <= Math.min(rows - 1, Math.ceil(cj + rj)); j++) {
            for (let i = Math.max(0, Math.floor(ci - ri)); i <= Math.min(cols - 1, Math.ceil(ci + ri)); i++) {
                const k = at(i, j);
                if (solid[k]) continue;
                const q = ((i + 0.5 - ci) / ri) ** 2 + ((j + 0.5 - cj) / rj) ** 2;
                if (q < 1) density[k] = Math.min(1.5, density[k] + amount * (1 - q));
            }
        }
        mass += amount;
    }

    /**
     * One step of `dt` seconds.
     * @param sources  [{ x, z, rate, r }]: density per second being released, and over what radius
     * @param wind     { x, z } in m/s
     * @param movers   [{ x, z, vx, vz }]: people on the move, who drag the air with them
     * @returns false when there is nothing in the air and the step was skipped
     */
    function step(dt, sources = [], wind = { x: 0, z: 0 }, movers = []) {
        for (const s of sources) inject(s.x, s.z, (s.rate ?? 1) * dt, s.r ?? 2);
        if (mass < 1e-4) return false;
        const settle = 1 - Math.exp(-dt * 1.5);
        // The air: outdoors it eases toward a share of the wind, indoors toward rest.
        for (let k = 0; k < n; k++) {
            if (solid[k]) { vx[k] = vz[k] = 0; continue; }
            const tx = inside[k] ? 0 : wind.x * windShare, tz = inside[k] ? 0 : wind.z * windShare;
            vx[k] += (tx - vx[k]) * settle; vz[k] += (tz - vz[k]) * settle;
        }
        for (const m of movers) {
            const i = Math.floor((m.x - x0) / cw), j = Math.floor((m.z - z0) / cd);
            if (!open(i, j)) continue;
            const k = at(i, j), pull = Math.min(1, dt * 4);
            vx[k] += ((m.vx ?? 0) - vx[k]) * pull; vz[k] += ((m.vz ?? 0) - vz[k]) * pull;
        }
        // Nothing flows into a wall, and what is left is made divergence-free, which is what
        // turns "the wind blows east" into "the wind goes round the stands".
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = at(i, j);
            if (solid[k]) { div[k] = 0; continue; }
            const l = beside(vx, i - 1, j, 0, vx[k]), r = beside(vx, i + 1, j, 0, vx[k]);
            const u = beside(vz, i, j - 1, 0, vz[k]), b = beside(vz, i, j + 1, 0, vz[k]);
            div[k] = (r - l) / (2 * cw) + (b - u) / (2 * cd);
        }
        const scale = cw * cd;
        for (let pass = 0; pass < 8; pass++) {
            for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
                const k = at(i, j);
                if (solid[k]) continue;
                const here = pressure[k];
                const sum = beside(pressure, i - 1, j, here, 0) + beside(pressure, i + 1, j, here, 0)
                    + beside(pressure, i, j - 1, here, 0) + beside(pressure, i, j + 1, here, 0);
                pressure[k] = (sum - div[k] * scale) / 4;
            }
        }
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = at(i, j);
            if (solid[k]) continue;
            const here = pressure[k];
            vx[k] -= (beside(pressure, i + 1, j, here, 0) - beside(pressure, i - 1, j, here, 0)) / (2 * cw);
            vz[k] -= (beside(pressure, i, j + 1, here, 0) - beside(pressure, i, j - 1, here, 0)) / (2 * cd);
        }
        // Carry the density back along the flow, let it spread into its open neighbours, and thin.
        const spread = Math.min(0.2, dt * 0.55);
        mass = 0;
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = at(i, j);
            if (solid[k]) { next[k] = 0; continue; }
            const sx = x0 + (i + 0.5) * cw - vx[k] * dt, sz = z0 + (j + 0.5) * cd - vz[k] * dt;
            let value = sample(sx, sz);
            const here = density[k];
            const around = beside(density, i - 1, j, here, 0) + beside(density, i + 1, j, here, 0)
                + beside(density, i, j - 1, here, 0) + beside(density, i, j + 1, here, 0);
            value += (around / 4 - here) * spread;
            value *= Math.exp(-dt / (inside[k] ? lifeIn : lifeOut));
            next[k] = value < 0.002 ? 0 : value;
            mass += next[k];
        }
        density.set(next);
        for (let k = 0; k < n; k++) bytes[k] = Math.min(255, density[k] * 255);
        mass *= 0.001;
        return true;
    }

    function reset() {
        density.fill(0); vx.fill(0); vz.fill(0); pressure.fill(0); bytes.fill(0); mass = 0;
    }

    return {
        rect: { x0, z0, w, d }, cols, rows, bytes, step, inject, sample, reset,
        /** Whether anything is in the air at all. */
        active: () => mass >= 1e-4,
        /** The air's velocity at a world point, m/s. */
        flow(x, z) {
            const i = Math.floor((x - x0) / cw), j = Math.floor((z - z0) / cd);
            return open(i, j) ? { x: vx[at(i, j)], z: vz[at(i, j)] } : { x: 0, z: 0 };
        },
    };
}
