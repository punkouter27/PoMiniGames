// ripples.js — the water answers what touches it (WebGPU compute).
//
// The sea in water.js is three sine trains: it moves, but nothing that happens on the island
// reaches it. A deer drinks from a lake that does not notice, a boulder rolls into the surf
// and the surf carries on. This is the missing response: a height field over the island's
// footprint that obeys the wave equation, so a disturbance spreads as rings, the rings bounce
// off the shore, cross each other, and die away.
//
// THE FIELD is GRID x GRID cells in two storage buffers (height, velocity, and whether the
// cell is water at all). A frame is two half steps, A -> B then B -> A, which is both the
// ping-pong a stencil needs (a cell must read its neighbours as they WERE) and two substeps
// for stability:
//
//     v += c^2 * laplacian(h) * dt        the surface is pulled toward its neighbours
//     v *= damping                        and loses energy, so a ring fades in a few metres
//     h += v * dt
//
// Land cells hold still, and a water cell sees a land neighbour as a copy of itself: a wall
// the wave reflects from, which is what a shoreline does to a ripple.
//
// SPLASHES are the only input: a point, a radius and a push, applied to the velocity in the
// first half step. renderer.js calls `splash` for animals drinking, for bodies and rocks the
// physics drops in the water (eventFx.js), and for the camera going through the surface.
//
// water.js reads the field in its fragment stage (`normalNode`): the slope bends the normal
// the reflection and the sun glint already use, so a ring shows as a moving band of sky and
// light rather than as geometry.
//
// Render only: no rule reads the field, and the sim never hears about a splash. On the WebGL2
// backend `createRipples` returns null and the water is exactly what it was.
import { Vector4 } from 'three-eco/webgpu';
import {
  Fn, Loop, clamp, dot, exp, float, floor, fract, instanceIndex, instancedArray, int, max, mix, smoothstep, storage, uint,
  uniform, uniformArray, vec2, vec4,
} from 'three-eco/tsl';
import { TILE } from '../sim/terrain/tiles.js';

const SPLASHES = 12;          // per frame; more than that in one frame are dropped
const WAVE_SPEED = 2.6;       // metres a second
const DAMPING = 0.75;         // per second: a ring is gone after about four
const REST = 0.5;             // per second: the level relaxes to flat, so pushes cannot add up

/**
 * @param renderer an initialised WebGPURenderer
 * @param terrain { size, type } (tile types, size squared)
 * @param {{ grid?: number }} opts cells along one side of the island
 * @returns {null | object}
 */
export function createRipples(renderer, terrain, { grid = 512 } = {}) {
  if (!renderer?.backend?.isWebGPUBackend) return null;
  const G = grid | 0; const CELLS = G * G;
  const size = terrain.size;
  const cell = size / G;

  // x height, y velocity, z 1 on water / 0 on land (carried through every step).
  const start = new Float32Array(CELLS * 4);
  for (let iz = 0; iz < G; iz++) {
    const tz = Math.min(size - 1, Math.floor((iz + 0.5) * cell));
    for (let ix = 0; ix < G; ix++) {
      const t = terrain.type[tz * size + Math.min(size - 1, Math.floor((ix + 0.5) * cell))];
      start[(iz * G + ix) * 4 + 2] = t === TILE.OCEAN || t === TILE.LAKE ? 1 : 0;
    }
  }
  const A = instancedArray(start, 'vec4');
  const B = instancedArray(new Float32Array(start), 'vec4');
  // What water.js reads: (dh/dx, height, dh/dz) per cell, written by the second half step.
  // The slope is taken here, across a cell's neighbours, and INTERPOLATED there. Taking it
  // in the material instead, from the four heights round a fragment, makes it constant
  // along one axis of every cell, and a ring drew as a patch of square facets.
  const N = instancedArray(CELLS, 'vec4');

  const uDt = uniform(1 / 120);
  const splashes = uniformArray(Array.from({ length: SPLASHES }, () => new Vector4(0, 0, 1, 0)));   // x, z, radius, push

  const half = (src, dst, withSplashes, slopes = null) => Fn(() => {
    const ix = int(instanceIndex.mod(uint(G))); const iz = int(instanceIndex.div(uint(G)));
    const here = src.element(instanceIndex);
    const h = here.x; const water = here.z;
    // A land neighbour reads as this cell's own height: no pull across the shoreline.
    const next = (dx, dz) => {
      const c = src.element(clamp(iz.add(dz), 0, G - 1).mul(G).add(clamp(ix.add(dx), 0, G - 1)));
      return mix(h, c.x, c.z);
    };
    const laplacian = next(1, 0).add(next(-1, 0)).add(next(0, 1)).add(next(0, -1)).sub(h.mul(4));
    const v = here.y.add(laplacian.mul((WAVE_SPEED * WAVE_SPEED) / (cell * cell)).mul(uDt)).toVar();
    if (withSplashes) {
      const at = vec2(float(ix).add(0.5), float(iz).add(0.5)).mul(cell);
      Loop(SPLASHES, ({ i }) => {
        const s = splashes.element(i);
        const d = at.sub(s.xy);
        v.addAssign(s.w.mul(exp(dot(d, d).negate().div(s.z.mul(s.z)))));
      });
    }
    v.mulAssign(exp(uDt.mul(-DAMPING)));
    const level = h.add(v.mul(uDt)).mul(exp(uDt.mul(-REST)));
    dst.element(instanceIndex).assign(vec4(level.mul(water), v.mul(water), water, 0));
    if (slopes) {
      // Half a step behind the height it sits beside, which nothing can see.
      const dx = next(1, 0).sub(next(-1, 0)).div(2 * cell);
      const dz = next(0, 1).sub(next(0, -1)).div(2 * cell);
      slopes.element(instanceIndex).assign(vec4(dx.mul(water), level.mul(water), dz.mul(water), 0));
    }
  })().compute(CELLS);
  const stepAB = half(A, B, true);
  const stepBA = half(B, A, false, N);

  const field = storage(N.value, 'vec4', CELLS).toReadOnly();
  /**
   * @param worldXZ node: the fragment's world XZ
   * @returns node vec3: (dh/dx, height, dh/dz) in metres, zero outside the island's footprint
   */
  const sample = (worldXZ) => {
    const g = worldXZ.div(cell);
    const q = clamp(g.sub(0.5), 0, G - 1.001);
    const f = fract(q); const i0 = floor(q);
    const at = (dx, dz) => field.element(int(i0.y.add(dz)).mul(G).add(int(i0.x.add(dx)))).xyz;
    const value = mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
    const uv = worldXZ.div(size);
    const inside = smoothstep(0, 0.01, uv.x).mul(smoothstep(0, 0.01, uv.y))
      .mul(smoothstep(0, 0.01, float(1).sub(uv.x))).mul(smoothstep(0, 0.01, float(1).sub(uv.y)));
    return value.mul(inside);
  };

  const queue = [];
  let sent = 0;

  return {
    grid: G,
    sample,
    get pending() { return queue.length; },
    get splashesSent() { return sent; },

    /**
     * Disturb the water at a world point. `radius` in metres (kept to at least a cell and a
     * half, or the push would fall between cells); `push` is a velocity, metres a second:
     * about 0.1 for a muzzle, 1.3 for a boulder.
     */
    splash(x, z, radius = 0.8, push = 0.6) {
      if (x < 0 || z < 0 || x > size || z > size) return;
      if (queue.length < SPLASHES) queue.push(x, z, Math.max(cell * 1.5, radius), push);
    },

    update(dt) {
      const n = queue.length / 4;
      for (let i = 0; i < SPLASHES; i++) {
        const v = splashes.array[i];
        if (i < n) v.set(queue[i * 4], queue[i * 4 + 1], queue[i * 4 + 2], queue[i * 4 + 3]); else v.w = 0;
      }
      sent += n;
      queue.length = 0;
      // Two half steps; a long frame is clamped rather than made up, as everywhere else.
      uDt.value = Math.min(dt, 1 / 20) / 2;
      renderer.compute(stepAB);
      renderer.compute(stepBA);
    },

    /**
     * Read the field back (a harness check). The largest |height| on the island, or within
     * `radius` metres of (x, z) when a point is given.
     */
    async peek(x = null, z = null, radius = 6) {
      const data = new Float32Array(await renderer.getArrayBufferAsync(A.value));
      let top = 0; let wet = 0;
      for (let iz = 0; iz < G; iz++) {
        for (let ix = 0; ix < G; ix++) {
          const i = iz * G + ix;
          wet += data[i * 4 + 2];
          if (x !== null && Math.hypot((ix + 0.5) * cell - x, (iz + 0.5) * cell - z) > radius) continue;
          top = Math.max(top, Math.abs(data[i * 4]));
        }
      }
      return { top, waterCells: wet };
    },

    dispose() {
      stepAB.dispose?.(); stepBA.dispose?.();
    },
  };
}
