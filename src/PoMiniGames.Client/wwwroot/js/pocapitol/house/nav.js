// pocapitol/house/nav.js — the scanned house as something a person can walk through and a round can hit.
//
// The picture of the House map is a Gaussian splat (models/house.ksplat): it has no walls, only
// colour. What stands where comes from models/pocapitol/house-nav.json, baked from the same scan
// by scripts/pocapitol/house-nav.py: a 10 cm plan grid with, per cell, how high the solid stuff
// in it reaches (a wall ~1.9 m, a table 0.75 m, bare floor 0) and whether a person can stand
// there. Both are in the house frame the splat is in (metres, floor at 0), so nothing is fitted.
//
// The world here is three's: x along the house, y up, z = -(the house frame's y). Everything in
// this file is plain arithmetic on that grid, so the simulation (world.js) runs in Node too.

/** Eye height of the player, and the ceiling: a round that climbs past it has hit plaster. */
export const EYE = 1.6, CEILING = 2.45;
/** A column at least this high is a wall: it goes all the way up (the bake only reads to 1.9 m). */
const WALL = 1.75;
const NAV_URL = 'models/pocapitol/house-nav.json';

function bytes(base64) {
    if (typeof atob === 'function') {
        const raw = atob(base64), out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    // Node (the headless check of the rules): no atob before 16, always a Buffer.
    return new Uint8Array(globalThis.Buffer.from(base64, 'base64'));
}

/** Fetch the baked grid. Throws if it is missing: without it there is no floor to stand on. */
export async function loadNav(url = NAV_URL) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PoCapitol house map: ${url} -> ${response.status}`);
    return createNav(await response.json());
}

/** @param data  the JSON house-nav.py writes */
export function createNav(data) {
    const { cell, x0, y0, cols, rows } = data;
    const unit = data.unit ?? 0.02;
    const height = bytes(data.height), bits = bytes(data.walk);
    if (height.length !== cols * rows) throw new Error('PoCapitol house map: grid size does not match.');
    const walk = new Uint8Array(cols * rows);
    for (let i = 0; i < walk.length; i++) walk[i] = (bits[i >> 3] >> (i & 7)) & 1;

    const col = x => Math.floor((x - x0) / cell), row = z => Math.floor((-z - y0) / cell);
    const at = (x, z) => {
        const c = col(x), r = row(z);
        return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
    };
    const centre = i => ({ x: x0 + (i % cols + 0.5) * cell, z: -(y0 + (Math.floor(i / cols) + 0.5) * cell) });

    /** Can a person stand at (x, z)? */
    const walkable = (x, z) => { const i = at(x, z); return i >= 0 && walk[i] === 1; };
    /** How high the solid stuff at (x, z) reaches, metres: 0 on bare floor, the ceiling in a wall or outside. */
    function heightAt(x, z) {
        const i = at(x, z);
        if (i < 0 || height[i] === 255) return CEILING;
        const h = height[i] * unit;
        return h >= WALL ? CEILING : h;
    }

    /**
     * A round from (ox, oy, oz) along the unit direction (dx, dy, dz): how far it gets (`t`, at
     * most `max`), where it stops and on what ('wall', 'floor', 'ceiling' or '' if it never did).
     * `nx`, `nz` point back out of whatever it hit, for the spall.
     */
    function ray(ox, oy, oz, dx, dy, dz, max = 30) {
        const step = 0.05;
        for (let t = step; t <= max; t += step) {
            const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
            if (y <= 0.01) return { t, x, y: 0.01, z, hit: 'floor', nx: 0, nz: 0 };
            if (y >= CEILING) return { t, x, y: CEILING, z, hit: 'ceiling', nx: 0, nz: 0 };
            if (y < heightAt(x, z)) {
                const back = Math.hypot(dx, dz) || 1;
                return { t: t - step, x: ox + dx * (t - step), y: oy + dy * (t - step), z: oz + dz * (t - step), hit: 'wall', nx: -dx / back, nz: -dz / back };
            }
        }
        return { t: max, x: ox + dx * max, y: oy + dy * max, z: oz + dz * max, hit: '', nx: 0, nz: 0 };
    }

    /** Nothing as high as `y` stands between two points on the plan (a table does not hide a face). */
    function clearLine(ax, az, bx, bz, y = 1.35) {
        const length = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(length / 0.07));
        for (let i = 1; i < steps; i++) {
            const k = i / steps;
            if (heightAt(ax + (bx - ax) * k, az + (bz - az) * k) > y) return false;
        }
        return true;
    }

    /**
     * Walk `actor` by (mx, mz), sliding along whatever is in the way. The walk grid is already
     * the floor pulled back by a body's radius, so a point test is a body test. Returns whether
     * it was stopped on either axis.
     */
    function move(actor, mx, mz) {
        const length = Math.hypot(mx, mz);
        if (length < 1e-6) return false;
        const steps = Math.max(1, Math.ceil(length / (cell * 0.6)));
        const sx = mx / steps, sz = mz / steps;
        let stopped = false;
        for (let i = 0; i < steps; i++) {
            if (walkable(actor.x + sx, actor.z + sz)) { actor.x += sx; actor.z += sz; continue; }
            stopped = true;
            if (walkable(actor.x + sx, actor.z)) actor.x += sx;
            else if (walkable(actor.x, actor.z + sz)) actor.z += sz;
        }
        return stopped;
    }

    /** The walkable cell nearest (x, z), as a point: for putting something down that landed in a wall. */
    function nearestWalkable(x, z, reach = 12) {
        if (walkable(x, z)) return { x, z };
        const c0 = col(x), r0 = row(z);
        let best = null, bestD = Infinity;
        for (let r = Math.max(0, r0 - reach); r <= Math.min(rows - 1, r0 + reach); r++) {
            for (let c = Math.max(0, c0 - reach); c <= Math.min(cols - 1, c0 + reach); c++) {
                if (!walk[r * cols + c]) continue;
                const d = (c - c0) ** 2 + (r - r0) ** 2;
                if (d < bestD) { bestD = d; best = r * cols + c; }
            }
        }
        return best === null ? null : centre(best);
    }

    // ---- finding the way: steps to a goal over the walk grid, flooded once per goal cell.
    const queue = new Int32Array(cols * rows);
    const NEIGHBOURS = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];
    /** Cost (tenths of a cell) from every walkable cell to (x, z); 65535 where there is no way. */
    function field(x, z, out = new Uint16Array(cols * rows)) {
        out.fill(65535);
        const goal = nearestWalkable(x, z);
        if (!goal) return out;
        let head = 0, tail = 0;
        const start = at(goal.x, goal.z);
        out[start] = 0; queue[tail++] = start;
        // A plain queue over 8 neighbours with re-relaxation: the grid is small (a few thousand
        // walkable cells) and costs differ by at most 14, so this settles in a couple of passes.
        while (head !== tail) {
            const i = queue[head++]; if (head === queue.length) head = 0;
            const c = i % cols, r = (i - c) / cols, base = out[i];
            for (const [dc, dr, cost] of NEIGHBOURS) {
                const nc = c + dc, nr = r + dr;
                if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                const n = nr * cols + nc;
                if (!walk[n] || out[n] <= base + cost) continue;
                // No cutting a corner between two blocked cells.
                if (dc && dr && (!walk[r * cols + nc] || !walk[nr * cols + c])) continue;
                out[n] = base + cost; queue[tail++] = n; if (tail === queue.length) tail = 0;
            }
        }
        return out;
    }
    /** The unit direction to walk from (x, z) to get nearer a field's goal, or null when there. */
    function downhill(flow, x, z) {
        const i = at(x, z);
        if (i < 0) return null;
        const c = i % cols, r = (i - c) / cols;
        let best = flow[i], pick = null;
        for (const [dc, dr] of NEIGHBOURS) {
            const nc = c + dc, nr = r + dr;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            const n = nr * cols + nc;
            if (!walk[n] || flow[n] >= best) continue;
            if (dc && dr && (!walk[r * cols + nc] || !walk[nr * cols + c])) continue;
            best = flow[n]; pick = n;
        }
        if (pick === null) return null;
        const to = centre(pick), d = Math.hypot(to.x - x, to.z - z) || 1;
        return { x: (to.x - x) / d, z: (to.z - z) / d };
    }
    /** Metres of walking between a point and a field's goal (Infinity if there is no way). */
    function walkDistance(flow, x, z) {
        const i = at(x, z);
        return i < 0 || flow[i] === 65535 ? Infinity : flow[i] / 10 * cell;
    }

    // ---- the rooms, in the order the house is cleared (house frame y is -z here).
    const rooms = data.rooms.map((room, index) => ({
        index, id: room.id, name: room.name,
        rects: room.rects.map(([ax, bx, ay, by]) => ({ x0: ax, x1: bx, z0: -by, z1: -ay })),
        centre: { x: room.centre[0], z: -room.centre[1] },
        spots: room.spots.map(([x, y]) => ({ x, z: -y })),
    }));
    /** Index of the room (x, z) is in, or -1. The first room listed that holds it wins, as in the bake. */
    function roomAt(x, z) {
        for (const room of rooms) {
            if (room.rects.some(r => x >= r.x0 && x < r.x1 && z > r.z0 && z <= r.z1)) return room.index;
        }
        return -1;
    }
    const sx = data.start.x, sz = -data.start.y;
    const lookX = data.start.lookX - sx, lookZ = -data.start.lookY - sz;
    const start = { x: sx, z: sz, yaw: Math.atan2(-lookX, -lookZ) };
    // Where the second wave comes into the house: the end of the entry passage.
    const entry = data.entry ? { x: data.entry.x, z: -data.entry.y } : { x: sx, z: sz };

    return {
        cell, cols, rows, x0, z0: -(y0 + rows * cell), x1: x0 + cols * cell, z1: -y0,
        walk, walkable, heightAt, ray, clearLine, move, nearestWalkable, field, downhill, walkDistance,
        rooms, roomAt, start, entry,
        /** Grid cell of a point as [column, row from the top of a plan drawn with +x right and -z up]. */
        plan(x, z) { return [(x - x0) / cell, rows - (-z - y0) / cell]; },
        /** Is plan cell (column, row-from-top) walkable? For drawing the map. */
        planWalk(c, rowFromTop) { return walk[(rows - 1 - rowFromTop) * cols + c] === 1; },
        /** Height in metres of plan cell (column, row-from-top), -1 where there is no floor. */
        planHeight(c, rowFromTop) { const h = height[(rows - 1 - rowFromTop) * cols + c]; return h === 255 ? -1 : h * unit; },
    };
}
