// Where the crowd has walked. A coarse grid over the west lawn that fills in under people's
// feet: the grass shader (look.js) reads it and turns lawn into churned mud along the routes the
// crowd actually took, and leaves a wet film of tracked dirt on the paving.
//
// Pure arithmetic with no DOM or three.js, so it can be tested with made-up footsteps. The scene
// wraps `bytes` in a texture and re-uploads it when `dirty` is set.

/**
 * Wear a standing person adds to their patch per second, and a walking one. Walking is the larger
 * number because a walker is only on any one patch for a fraction of a second: a few dozen people
 * crossing leave a scuffed path, and a crowd standing at a line churns it to mud in about a minute.
 */
export const WEAR_STANDING = 0.012, WEAR_WALKING = 0.25;

/**
 * @param rect  { x0, z0, w, d }: the ground the grid covers, in world metres
 * @param size  cells along each side
 */
export function createWear({ x0 = -40, z0 = 14, w = 80, d = 100 } = {}, size = 128) {
    const field = new Float32Array(size * size), bytes = new Uint8Array(size * size);
    const api = {
        size, bytes, dirty: false,
        rect: { x0, z0, w, d },
        /** Adds wear around (x, z), spread over the four nearest cells so a path has no steps in it. */
        stamp(x, z, amount) {
            const fx = (x - x0) / w * size - 0.5, fz = (z - z0) / d * size - 0.5;
            const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
            for (const [cx, cz, share] of [[ix, iz, (1 - tx) * (1 - tz)], [ix + 1, iz, tx * (1 - tz)], [ix, iz + 1, (1 - tx) * tz], [ix + 1, iz + 1, tx * tz]]) {
                if (cx < 0 || cz < 0 || cx >= size || cz >= size || share <= 0) continue;
                const i = cz * size + cx, value = Math.min(1, field[i] + amount * share);
                if (value === field[i]) continue;
                field[i] = value;
                const byte = Math.round(value * 255);
                if (byte !== bytes[i]) { bytes[i] = byte; api.dirty = true; }
            }
        },
        /** One step of everybody's weight: `people` are { x, z, moving }, `seconds` since the last call. */
        tread(people, seconds) {
            for (const p of people) api.stamp(p.x, p.z, (p.moving ? WEAR_WALKING : WEAR_STANDING) * seconds);
        },
        /** Wear at a point, 0..1 (nearest cell). */
        at(x, z) {
            const cx = Math.floor((x - x0) / w * size), cz = Math.floor((z - z0) / d * size);
            return cx < 0 || cz < 0 || cx >= size || cz >= size ? 0 : field[cz * size + cx];
        },
        /** A new attempt starts on an untouched lawn. */
        reset() { field.fill(0); bytes.fill(0); api.dirty = true; },
    };
    return api;
}
