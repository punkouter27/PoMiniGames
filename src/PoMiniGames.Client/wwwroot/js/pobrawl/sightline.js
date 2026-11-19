// sightline.js — keep a ring post out of the shot.
//
// The fight camera sits outside the ropes and looks in at the pair, so a corner post (and
// the turnbuckle pads on it) can end up on the line between the lens and the fighters, most
// often when they brawl in a far corner. This nudges the camera's TARGET sideways just far
// enough for the sightline to clear, before the boom's spring eases the camera there, so the
// post slides out of frame instead of the view cutting.
//
// Pure maths on plain {x, y, z} values: no three.js, so it is testable anywhere.

/**
 * @typedef {{x: number, z: number, r: number, top: number}} Obstacle
 *   A vertical cylinder: centre, radius to keep clear, and height of its top.
 */

/** The four corner posts, padded out to their turnbuckles. */
export function ringPosts(half = 5.8, r = 0.5, top = 1.6) {
  const out = [];
  for (const x of [-half, half]) for (const z of [-half, half]) out.push({ x, z, r, top });
  return out;
}

/**
 * Move `cam` (mutated) so the segment cam → aim passes at least each obstacle's radius away
 * from it, wherever the sightline is low enough to hit it.
 *
 * `prefer` breaks the tie when the line passes dead through a post's centre: +1 or -1 picks
 * the side (the caller passes the side it went last time, so the view never flip-flops).
 *
 * @param {{x: number, y: number, z: number}} cam
 * @param {{x: number, y: number, z: number}} aim
 * @param {Obstacle[]} obstacles
 * @param {{prefer?: number, maxShift?: number, headroom?: number}} [o]
 * @returns {number} the side it moved to (+1 / -1), or 0 when the line was already clear
 */
export function clearSightline(cam, aim, obstacles, { prefer = 1, maxShift = 1.6, headroom = 0.35 } = {}) {
  let side = 0;
  for (const ob of obstacles) {
    const dx = aim.x - cam.x, dz = aim.z - cam.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    // Closest approach along the segment, as a 0..1 fraction from the camera.
    const t = ((ob.x - cam.x) * dx + (ob.z - cam.z) * dz) / len2;
    // Behind the lens, or at the fighters themselves: not in the way.
    if (t <= 0.03 || t >= 0.92) continue;
    // The line of sight passes over the top of it.
    if (cam.y + (aim.y - cam.y) * t > ob.top + headroom) continue;
    const ox = cam.x + dx * t - ob.x, oz = cam.z + dz * t - ob.z;
    const dist = Math.hypot(ox, oz);
    const need = ob.r - dist;
    if (need <= 0) continue;
    // Which way to step: away from the post, or the preferred side when dead centre.
    const len = Math.sqrt(len2);
    let nx = -dz / len, nz = dx / len;
    let s = prefer >= 0 ? 1 : -1;
    if (dist > 0.02) s = ox * nx + oz * nz >= 0 ? 1 : -1;
    // Sliding the camera by `shift` moves the closest point by shift * (1 - t).
    const shift = Math.min(maxShift, need / (1 - t)) * s;
    cam.x += nx * shift;
    cam.z += nz * shift;
    side = s;
  }
  return side;
}
