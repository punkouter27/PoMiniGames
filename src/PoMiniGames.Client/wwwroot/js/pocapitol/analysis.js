// Crowd analysis for PoCapitol: how packed the crowd is (Fruin's levels of service) and how a
// push spreads through it (threshold contagion, world.js). Pure arithmetic over the attempt's
// state, so it runs in the page, in a Node harness, or in a test with made-up people.
//
// Density is people per square metre, splatted onto a 1.25 m grid over the route and read back
// per cell. The grades are John J. Fruin's queuing levels of service (Pedestrian Planning and
// Design, 1971): A is free movement, D is touching, E is packed and F is the range where people
// can no longer move of their own will. The simulation's bodies are 0.68 m discs with a little
// give, so it rarely packs past the D/E boundary on its own; the crush-risk measure below is
// therefore density AND force together: a packed cell that a surge is passing through, or that is
// leaning on a line that holds.
import { lineDefs } from './world.js';

/** Fruin's queuing levels of service, by the largest density (people/m²) each grade covers. */
export const FRUIN = [
    { grade: 'A', max: 0.83, label: 'Free movement' },
    { grade: 'B', max: 1.08, label: 'Restricted' },
    { grade: 'C', max: 1.54, label: 'Personal space only' },
    { grade: 'D', max: 3.59, label: 'Touching' },
    { grade: 'E', max: 5.38, label: 'Packed' },
    { grade: 'F', max: Infinity, label: 'Crush' },
];

/** The grid the density is kept on: the same route rectangle as the report's heat map. */
export const DENSITY = { x0: -40, z0: -56, w: 80, d: 152, cell: 1.25 };
DENSITY.cols = Math.round(DENSITY.w / DENSITY.cell);
DENSITY.rows = Math.round(DENSITY.d / DENSITY.cell);

/** A cell this dense, with force behind it, counts toward crush risk. */
export const RISK_DENSITY = 1.9;

/** The grade index (0 = A .. 5 = F) for a density. */
export function gradeIndex(density) {
    for (let i = 0; i < FRUIN.length; i++) if (density <= FRUIN[i].max) return i;
    return FRUIN.length - 1;
}

/** What one person is doing, for the contagion view: pushing, tipped, calm, retreating or down. */
export function contagionState(c) {
    if (c.health <= 0) return 'down';
    if (c.retreating) return 'retreating';
    if (c.pushing) return 'pushing';
    if (c.tipped) return 'tipped';
    return 'calm';
}

export function createAnalysis({ maxSamples = 900 } = {}) {
    const { cols, rows, x0, z0, cell } = DENSITY;
    const area = cell * cell;
    const count = new Float32Array(cols * rows);
    const force = new Float32Array(cols * rows);
    const density = new Float32Array(cols * rows);
    const risk = new Uint8Array(cols * rows);
    const series = [];
    const gradeSeconds = new Float64Array(FRUIN.length);
    let peak = 0, peakAt = 0, riskSeconds = 0, riskEpisodes = 0, inRisk = false;
    let peakPushing = 0, peakPushingAt = 0, tippedPeak = 0, last = -1;

    function splat(target, x, z, amount) {
        const fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
        const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
        if (ix >= 0 && iz >= 0 && ix < cols && iz < rows) target[iz * cols + ix] += amount * (1 - tx) * (1 - tz);
        if (ix + 1 >= 0 && iz >= 0 && ix + 1 < cols && iz < rows) target[iz * cols + ix + 1] += amount * tx * (1 - tz);
        if (ix >= 0 && iz + 1 >= 0 && ix < cols && iz + 1 < rows) target[(iz + 1) * cols + ix] += amount * (1 - tx) * tz;
        if (ix + 1 >= 0 && iz + 1 >= 0 && ix + 1 < cols && iz + 1 < rows) target[(iz + 1) * cols + ix + 1] += amount * tx * tz;
    }

    const api = {
        cols, rows, density, risk,
        /** Density at a point, people/m² (nearest cell). */
        at(x, z) {
            const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
            return i < 0 || j < 0 || i >= cols || j >= rows ? 0 : density[j * cols + i];
        },
        /** Rebuild the grid from the attempt's people. Call a few times a second; `seconds` since the last call. */
        update(state, seconds) {
            count.fill(0); force.fill(0); risk.fill(0);
            let live = 0, pushing = 0, tipped = 0;
            const holding = state.lines?.findIndex(l => l.state === 'holding') ?? -1;
            const frontZ = holding >= 0 ? lineDefs[holding].z : null;
            for (const c of state.companions ?? []) {
                if (c.health <= 0) continue;
                live++;
                if (c.pushing) pushing++; else if (c.tipped) tipped++;
                splat(count, c.x, c.z, 1);
                // Force through the body: riding a surge, or pushing within reach of a holding line.
                const leaning = c.pushing && frontZ !== null && c.z >= frontZ && c.z - frontZ < 3;
                if ((c.surge ?? 0) > 0 || leaning) splat(force, c.x, c.z, 1);
            }
            let any = false, peakNow = 0;
            for (let i = 0; i < density.length; i++) {
                const d = count[i] / area;
                density[i] = d;
                if (d > peakNow) peakNow = d;
                if (d >= RISK_DENSITY && force[i] >= 0.5) { risk[i] = 1; any = true; }
            }
            if (peakNow > peak) { peak = peakNow; peakAt = state.elapsed ?? 0; }
            const dt = Math.max(0, seconds ?? 0);
            if (any) riskSeconds += dt;
            if (any && !inRisk) riskEpisodes++;
            inRisk = any;
            // Person-seconds by grade: what share of the crowd's time was spent how packed.
            if (dt > 0) {
                for (const c of state.companions ?? []) {
                    if (c.health > 0) gradeSeconds[gradeIndex(api.at(c.x, c.z))] += dt;
                }
            }
            const share = live ? pushing / live : 0;
            if (share > peakPushing) { peakPushing = share; peakPushingAt = state.elapsed ?? 0; }
            tippedPeak = Math.max(tippedPeak, live ? tipped / live : 0);
            const second = Math.floor(state.elapsed ?? 0);
            if (second !== last) {
                last = second;
                series.push({ at: second, peak: Math.round(peakNow * 100) / 100, pushing: Math.round(share * 1000) / 10,
                    tipped: live ? Math.round(tipped / live * 1000) / 10 : 0, risk: any ? 1 : 0 });
                if (series.length > maxSamples) series.shift();
            }
            return any;
        },
        /** The numbers the report and the debrief carry. */
        summary() {
            const total = gradeSeconds.reduce((a, b) => a + b, 0);
            const packed = total > 0 ? (gradeSeconds[3] + gradeSeconds[4] + gradeSeconds[5]) / total : 0;
            return {
                peakDensity: Math.round(peak * 100) / 100,
                peakDensityAt: Math.round(peakAt),
                peakGrade: FRUIN[gradeIndex(peak)].grade,
                riskSeconds: Math.round(riskSeconds),
                riskEpisodes,
                packedShare: Math.round(packed * 1000) / 10,
                peakPushing: Math.round(peakPushing * 1000) / 10,
                peakPushingAt: Math.round(peakPushingAt),
                peakTipped: Math.round(tippedPeak * 1000) / 10,
                series: series.slice(),
            };
        },
        reset() {
            count.fill(0); force.fill(0); density.fill(0); risk.fill(0); gradeSeconds.fill(0); series.length = 0;
            peak = 0; peakAt = 0; riskSeconds = 0; riskEpisodes = 0; inRisk = false;
            peakPushing = 0; peakPushingAt = 0; tippedPeak = 0; last = -1;
        },
    };
    return api;
}
