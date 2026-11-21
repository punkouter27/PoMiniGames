// platform/3d/gpuCulling.js — GPU frustum + occlusion culling that drives an indirect draw.
//
// platform/instancedPool.js is the CPU answer to "a lot of little instances": it keeps a flat
// array, writes matrices, and sets `count` to the live high-water mark. That is right while the
// instances are CPU data. It is no help for a population whose positions are made in the vertex
// shader (grass blades wrapping round the camera, a GPU flock): the CPU cannot cull what it never
// sees, so all 56,000 blades were vertex-shaded every frame (7 vertices each) whether the camera
// faced them, or they stood on sea and snow where they have no height, or a hill hid them.
//
// WHAT THIS DOES, per frame, in two tiny compute dispatches before the scene renders:
//   1. reset: zero the instance count in an indirect-draw argument buffer.
//   2. cull:  one thread per instance asks the caller's `bounds(i)` for a bounding sphere
//             (vec4: centre xyz, radius; radius <= 0 means "draws nothing at all", e.g. a blade
//             with no height), tests it against the six frustum planes, then against the depth
//             grid of LAST frame (depthGrid.js: per-cell nearest/farthest eye distance) and, if it
//             survives, atomically appends its index to a compacted `visible` buffer and bumps the
//             argument buffer's instanceCount.
// The draw then needs no CPU round trip: the geometry is given the argument buffer with
// `geometry.setIndirect(args)` (drawIndexedIndirect), and its material maps `instanceIndex` through
// `culler.slot` (visible[instanceIndex]) to find which logical instance it is drawing.
//
// OCCLUSION IS CONSERVATIVE ON PURPOSE. The depth is a frame old and the grid is coarse, so an
// instance is hidden only when its NEAREST point is farther than the FARTHEST thing in every cell
// its sphere covers, plus a margin that grows with distance (a turning camera uncovers things the
// old depth still hides). A sphere that spills off the old screen, or covers more than `maxCells`
// cells, is simply kept. A wrong "keep" costs a few vertices; a wrong "cull" pops, so every doubt
// resolves to drawing the instance.
//
// ORDER IS NOT PRESERVED: atomics append in whatever order threads finish. That is fine for the
// opaque, depth-tested things this is for; do not use it for blended instances that need sorting.
//
// Off the WebGPU backend, or when the device has no storage buffers in the vertex stage (the
// WebGPU "compatibility" profile), `createGpuCulling` returns null and the caller keeps drawing
// every instance the way it always did.
import { Frustum, IndirectStorageBufferAttribute, Matrix4, Vector4 } from 'three-eco/webgpu';
import {
  Fn, If, Loop, atomicAdd, float, floor, instanceIndex, instancedArray, int, storage, uniform, uniformArray, vec3, vec4,
} from 'three-eco/tsl';

const _vp = new Matrix4();
const _frustum = new Frustum();

/**
 * @param renderer an initialised WebGPURenderer
 * @param {{
 *   count: number,                 instances in the population
 *   indexCount: number,            index count of the instanced geometry (drawIndexedIndirect)
 *   bounds: (i:any)=>any,          TSL: instance index (uint node) -> vec4(centre xyz, radius); radius <= 0 culls it
 *   grid?: object|null,            a depthGrid.js grid, for the occlusion test
 *   maxCells?: number,             widest footprint (in grid cells) still tested for occlusion (default 3)
 *   margin?: number,               metres of slack on the occlusion test (default 1.5)
 * }} opts
 * @returns {null | { slot:any, args:any, apply(geometry):void, update(camera):void,
 *                    setEnabled(on:boolean):void, setOcclusion(on:boolean):void,
 *                    stats():Promise<{visible:number,total:number}>, dispose():void }}
 */
export function createGpuCulling(renderer, { count, indexCount, bounds, grid = null, maxCells = 3, margin = 1.5 } = {}) {
  if (!renderer?.backend?.isWebGPUBackend || !(count > 0) || typeof bounds !== 'function') return null;
  // Compatibility-mode devices expose zero storage buffers to the vertex stage: the draw could not
  // read `visible`. Better not to build the pass at all.
  const vertexStorage = renderer.backend.device?.limits?.maxStorageBuffersInVertexStage;
  if (vertexStorage !== undefined && vertexStorage < 1) return null;

  const visible = instancedArray(count, 'uint');
  // toReadOnly() flips the node it is called on, so the vertex-stage view is its own node over the same buffer.
  const visibleRO = storage(visible.value, 'uint', count).toReadOnly();
  // drawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance.
  const argsAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
  const argsRO = storage(argsAttr, 'uint', 5);
  const argsAtomic = storage(argsAttr, 'uint', 5).toAtomic();

  const planes = uniformArray(Array.from({ length: 6 }, () => new Vector4(0, 0, 0, 1e9)));
  const uOn = uniform(1);          // 0: every instance is kept (A/B and debugging)
  const uOcc = uniform(0);
  const uMargin = uniform(margin);
  const uCount = uniform(count, 'uint');

  const reset = Fn(() => { argsRO.element(1).assign(0); })().compute(1);

  const cull = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uCount), () => {
      const b = bounds(i).toVar();
      const centre = b.xyz;
      const r = b.w;
      const keep = r.greaterThan(0).toVar();
      If(keep.and(uOn.greaterThan(0.5)), () => {
        // Frustum: outside any plane by more than the radius.
        Loop(6, ({ i: p }) => {
          const pl = planes.element(p);
          If(pl.xyz.dot(centre).add(pl.w).lessThan(r.negate()), () => { keep.assign(false); });
        });
        if (grid) {
          If(keep.and(uOcc.greaterThan(0.5)), () => {
            const pr = grid.project(centre);
            const eye = pr.z;
            If(pr.w.greaterThan(0.5).and(eye.greaterThan(r.add(0.5))), () => {
              // Footprint in grid cells (cells are square pixels at the screen's aspect).
              const rCells = r.mul(grid.uPrevProjY).div(eye).mul(0.5).mul(grid.rows);
              If(rCells.lessThan(maxCells * 0.5), () => {
                const cx = pr.x.mul(grid.cols);
                const cy = pr.y.mul(grid.rows);
                const x0 = int(floor(cx.sub(rCells)));
                const y0 = int(floor(cy.sub(rCells)));
                const x1 = int(floor(cx.add(rCells)));
                const y1 = int(floor(cy.add(rCells)));
                // A sphere that reaches the old screen's edge is kept: nothing there to judge by.
                If(x0.greaterThanEqual(0).and(y0.greaterThanEqual(0)).and(x1.lessThan(grid.cols)).and(y1.lessThan(grid.rows)), () => {
                  const farthest = float(0).toVar();
                  Loop(maxCells, maxCells, ({ i: dx, j: dy }) => {
                    If(x0.add(dx).lessThanEqual(x1).and(y0.add(dy).lessThanEqual(y1)), () => {
                      farthest.assign(farthest.max(grid.cell(x0.add(dx), y0.add(dy)).y));
                    });
                  });
                  const nearest = eye.sub(r);
                  If(nearest.greaterThan(farthest.add(uMargin).add(eye.mul(0.01))), () => { keep.assign(false); });
                });
              });
            });
          });
        }
      });
      If(keep, () => {
        const slot = atomicAdd(argsAtomic.element(1), 1);
        visible.element(slot).assign(i);
      });
    });
  })().compute(count);

  let enabled = true;
  let occWanted = true;
  let ran = false;

  return {
    /** TSL node: the logical instance the draw's `instanceIndex` stands for. Read-only, vertex-safe. */
    get slot() { return visibleRO.element(instanceIndex); },
    args: argsAttr,
    /** Point a geometry's draw at the culled set. Its own instanceCount is ignored from here on. */
    apply(geometry) { geometry.setIndirect(argsAttr); },
    /** Per frame, before the scene renders, with the camera as it will render. */
    update(camera) {
      camera.updateMatrixWorld();
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_vp);
      for (let k = 0; k < 6; k++) {
        const pl = _frustum.planes[k];
        planes.array[k].set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant);
      }
      // The grid has nothing to say until it has reduced one real depth.
      uOcc.value = grid && occWanted && grid.valid ? 1 : 0;
      renderer.compute([reset, cull]);
      ran = true;
    },
    setEnabled(on) { enabled = !!on; uOn.value = enabled ? 1 : 0; },
    setMargin(m) { uMargin.value = m; },
    setOcclusion(on) { occWanted = !!on; },
    get enabled() { return enabled; },
    get ran() { return ran; },
    /** Debug: how many instances survived the last pass (async: reads the argument buffer back). */
    async stats() {
      const buf = await renderer.getArrayBufferAsync(argsAttr);
      return { visible: new Uint32Array(buf)[1], total: count };
    },
    dispose() { try { reset.dispose?.(); cull.dispose?.(); } catch { /* gone */ } },
  };
}
