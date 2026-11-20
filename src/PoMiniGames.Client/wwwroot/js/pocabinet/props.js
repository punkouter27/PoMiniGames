// pocabinet/props.js
//
// Where the knock-over props stand: a stack of three tyres hard against the barrier at the apex
// of every bend (on the inside, or on the outside where the inside is too tight a fold of road to
// stand anything on), and a row of cones along the outside of its exit, just past the kerb.
// Render only, like the debris they become (debris.js standProps): a car that runs wide scatters
// them and never feels it, and physics.js knows nothing of them. They stand on the run-off only,
// never on the tarmac or a kerb, well inside the barrier; cones keep off the gravel too.
//
// Placement is a pure function of the track, so every player sees the same props in the same
// places (what happens to them afterwards is each player's own). No imports from three: the
// rule is checked in node by scripts/pocabinet/debris-check.mjs.

import { GRIP_ACCEL, KERB_OUTER, runOffAt, surfaceAt, SURF_GRAVEL, SURF_ROAD, SURF_KERB, SURF_SAUSAGE } from './physics.js';

/** A bend worth marking, as a curvature: the speed the grip would hold there (sim units/s). */
const CORNER_SPEED = 165;
const APEX_GAP = 9;           // samples between two apexes (a chicane's are ten apart)
const STACK = 3;              // tyres to a stack
const CONES = 4;              // cones along an exit
const CONE_STEP = 34;         // sim units between them
const FOLD = 0.4;             // how near the centre of a bend a prop may stand (1 = where the road folds)

export const TYRE = { radius: 0.33, half: 0.11 };       // world units (debris.js draws and collides them at this size)
export const CONE = { radius: 0.17, half: 0.26 };

/**
 * The props of `track`: [{ kind: 'tyre' | 'cone', x, y, lat, index, up, stand }] with x, y in
 * sim units, `lat` its lateral (+ right), `index` the centerline sample it stands by, `up` how
 * far its centre is over the road's plane there in world units (the second tyre of a stack sits
 * on the first) and `stand` a number shared by what stands together (a stack's three tyres).
 */
export function placeProps(track) {
    const n = track.count;
    const out = [];
    if (!(n > 0) || !track.curv) return out;
    const drawn = (i) => (typeof track.drawn === 'function' ? track.drawn(i) : true);
    const limit = GRIP_ACCEL * 0.9 / (CORNER_SPEED * CORNER_SPEED);
    // Apexes: the tightest sample of each stretch a car cannot take flat.
    const apexes = [];
    for (let i = 0; i < n; i++) {
        const k = track.curv[i];
        if (k < limit || !drawn(i)) continue;
        let top = true;
        for (let d = 1; d <= 8 && top; d++) {
            if (track.curv[(i + d) % n] > k || track.curv[(i - d + n) % n] >= k) top = false;
        }
        if (!top) continue;
        const last = apexes[apexes.length - 1];
        if (last !== undefined && i - last < APEX_GAP) continue;
        apexes.push(i);
    }
    if (apexes.length > 1 && apexes[0] + n - apexes[apexes.length - 1] < APEX_GAP) apexes.pop();

    let stands = 0;
    /** `stand` numbers what stands together: the three tyres of a stack share one. */
    const stand = (kind, i, lat, up, id) => {
        out.push({ kind, x: track.x[i] - track.ty[i] * lat, y: track.y[i] + track.tx[i] * lat, lat, index: i, up, stand: id });
    };
    /**
     * Is `lat` at sample `i` run-off a prop can stand on, clear of the kerb, the barrier and the
     * other props by `reach`? Not on the inside of a bend tighter than the prop is far out: there
     * the road's cross-sections run into each other and the ground is a fold (FOLD of the way to
     * where they meet is the limit). Gravel only if `gravel`.
     */
    const free = (i, lat, reach, gravel = false) => {
        if (!drawn(i)) return false;
        const p3 = (i - 3 + n) % n, q3 = (i + 3) % n;
        const bend = track.tx[p3] * track.ty[q3] - track.ty[p3] * track.tx[q3];     // + = turning right
        if (bend * lat > 0 && track.curv[i] * (Math.abs(lat) + reach) > FOLD) return false;
        const x = track.x[i] - track.ty[i] * lat, y = track.y[i] + track.tx[i] * lat;
        for (const o of out) if (Math.hypot(o.x - x, o.y - y) < reach * 2 + 6) return false;
        // Asked of the road as the sim would ask it (the nearest piece of centerline): in a
        // tight corner that is not always the sample the prop was measured from.
        const pr = track.project(x, y, i);
        const side = pr.lateral > 0 ? 1 : -1, l = Math.abs(pr.lateral);
        const face = track.hwAt(pr.index) + runOffAt(track, pr.index, side);
        if (side !== (lat > 0 ? 1 : -1) || l + reach > face - 1 || l - reach < track.hwAt(pr.index) + 2) return false;
        for (const probe of [l - reach, l, l + reach]) {
            const s = surfaceAt(track, pr.index, side * probe);
            if (s === SURF_ROAD || s === SURF_KERB || s === SURF_SAUSAGE || (s === SURF_GRAVEL && !gravel)) return false;
        }
        return true;
    };

    for (const a of apexes) {
        // Which way it turns: the heading's change across the apex (+ = a right-hander).
        const p = (a - 3 + n) % n, q = (a + 3) % n;
        const turn = track.tx[p] * track.ty[q] - track.ty[p] * track.tx[q];
        if (Math.abs(turn) < 0.05) continue;
        const dir = turn > 0 ? 1 : -1;

        // The tyres: against the barrier, inside if they can stand there, else outside (a
        // gravel trap will do: they are at the far side of it).
        const tyreReach = TYRE.radius * 10;
        for (const side of [dir, -dir]) {
            const lat = side * (track.hwAt(a) + runOffAt(track, a, side) - tyreReach - 2);
            if (!free(a, lat, tyreReach, true)) continue;
            const id = stands++;
            for (let k = 0; k < STACK; k++) stand('tyre', a, lat, TYRE.half + k * TYRE.half * 2 + 0.002 * (k + 1), id);
            break;
        }

        // The cones: outside, along the exit, a step past where a kerb would end.
        const coneReach = CONE.radius * 10;
        for (let c = 0; c < CONES; c++) {
            const at = track.cum[a] + 70 + c * CONE_STEP;
            const i = track.indexAt(at);
            const lat = -dir * (track.hwAt(i) + KERB_OUTER + coneReach + 1.5);
            if (free(i, lat, coneReach)) stand('cone', i, lat, CONE.half + 0.002, stands++);
        }
    }
    return out;
}
