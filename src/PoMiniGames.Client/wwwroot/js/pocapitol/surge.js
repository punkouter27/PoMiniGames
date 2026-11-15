// Pressure waves through a packed crowd.
//
// A dense crowd behaves like a compressible medium: a push at the back does not arrive at the
// front at once, it travels there, body to body, at a few metres a second, and everyone it
// passes is rocked forward and back as it goes. The simulation resolves each person's own
// movement; what it does not show is that ripple.
//
// This is a damped wave equation on a coarse grid over the route. A shove, a blow, a blast or a
// heave from the back of the crowd is an impulse; the grid carries it outward as a ring; and the
// slope of the wave under a person's feet is how hard they are carried, and which way. Only people
// who are actually packed in are moved. world.js steps the field and turns the slope into a push
// on each body, which the contact pass then resolves like any other shove; the renderer reads
// the same field for how far to lean them.
//
// Pure arithmetic with no DOM or three.js, so it can be tested with made-up pushes.

/** How fast a push crosses a packed crowd, m/s, and how many seconds it takes to die to 1/e. */
export const SURGE_SPEED = 4.2, SURGE_FADE = 1.6;
/** The furthest a wave rocks anyone, metres, and the furthest it leans them, radians. */
export const SURGE_SWAY = 0.2, SURGE_LEAN = 0.16;

export function createSurge({ x0 = -40, z0 = -56, w = 80, d = 152 } = {}, cell = 2) {
    const cols = Math.ceil(w / cell), rows = Math.ceil(d / cell), n = cols * rows;
    const height = new Float32Array(n), speed = new Float32Array(n);
    let energy = 0;
    const at = (i, j) => j * cols + i;

    /** A push at (x, z): `strength` 0..1 or so, over a patch `radius` metres across. */
    function push(x, z, strength = 1, radius = 3) {
        const ci = (x - x0) / cell, cj = (z - z0) / cell, r = Math.max(1, radius / cell);
        for (let j = Math.max(1, Math.floor(cj - r)); j <= Math.min(rows - 2, Math.ceil(cj + r)); j++) {
            for (let i = Math.max(1, Math.floor(ci - r)); i <= Math.min(cols - 2, Math.ceil(ci + r)); i++) {
                const q = ((i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2) / (r * r);
                if (q < 1) speed[at(i, j)] += strength * 6 * (1 - q) * (1 - q);
            }
        }
        energy += Math.abs(strength);
    }

    function step(dt) {
        if (energy < 1e-4) return false;
        // Two half-steps keep the explicit scheme stable at 30 fps with 2 m cells.
        const h = Math.min(0.05, dt) / 2, k = (SURGE_SPEED / cell) ** 2, fade = Math.exp(-h / SURGE_FADE);
        let total = 0;
        for (let pass = 0; pass < 2; pass++) {
            for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
                const c = at(i, j);
                speed[c] += k * (height[c - 1] + height[c + 1] + height[c - cols] + height[c + cols] - 4 * height[c]) * h;
            }
            total = 0;
            for (let c = 0; c < n; c++) {
                speed[c] *= fade;
                height[c] = (height[c] + speed[c] * h) * fade;
                total += Math.abs(height[c]) + Math.abs(speed[c]) * 0.2;
            }
        }
        energy = total > 0.02 ? total : 0;
        if (!energy) { height.fill(0); speed.fill(0); }
        return true;
    }

    /**
     * How a person standing at (x, z) is rocked right now.
     * @param packed  0..1: how hemmed in they are; someone with room to stand is not moved
     * @returns `out`: `{ x, z }` metres to draw them off their spot, `lean` radians
     */
    function sample(x, z, packed = 1, out = { x: 0, z: 0, lean: 0 }) {
        out.x = out.z = out.lean = 0;
        if (energy < 1e-4 || packed <= 0) return out;
        const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
        if (i < 1 || j < 1 || i >= cols - 1 || j >= rows - 1) return out;
        const c = at(i, j);
        // Downhill on the wave is the way the bodies are being carried.
        const gx = (height[c + 1] - height[c - 1]) / (2 * cell), gz = (height[c + cols] - height[c - cols]) / (2 * cell);
        const g = Math.hypot(gx, gz);
        if (g < 1e-5) return out;
        const amount = Math.min(1, g * 2.4) * Math.min(1, packed);
        out.x = -gx / g * amount * SURGE_SWAY; out.z = -gz / g * amount * SURGE_SWAY;
        out.lean = amount * SURGE_LEAN;
        return out;
    }

    function reset() { height.fill(0); speed.fill(0); energy = 0; }

    return { push, step, sample, reset, active: () => energy >= 1e-4, heightAt: (x, z) => {
        const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
        return i < 0 || j < 0 || i >= cols || j >= rows ? 0 : height[at(i, j)];
    } };
}
