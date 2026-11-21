// platform/3d/depthGrid.js — last frame's scene depth, boiled down to a small grid the GPU can read anywhere.
//
// Two effects want to know "what is on screen at this pixel, and how far away": the compute
// particles (gpuParticles.js) bounce off whatever the camera sees, and the instance culler
// (gpuCulling.js) throws away what is hidden behind it. Neither can read the scene pass's depth
// texture directly:
//   - the particles are DRAWN in that same pass, so sampling its depth while the pass writes it
//     is a read/write hazard WebGPU rejects;
//   - the texture is a depth format (and may be multisampled), a poor thing to point a hundred
//     thousand threads at, whereas a 240x135 grid is a few hundred KB of plain floats.
// So once per frame, BEFORE the scene renders, one small compute pass reads the depth the PREVIOUS
// frame left behind and writes, per grid cell, the nearest and the farthest eye-space distance
// (vec2: min, max) into a storage buffer. The particle kernel and the cull kernel both read that
// buffer, and the particle fragment shader reads it for its soft depth fade.
//
// WHY MIN AND MAX: a particle that has to bounce wants the surface it can hit (nearest in the cell);
// the occlusion cull wants the farthest occluder (max: an instance is hidden only if it is nearer
// than nothing in the cell, i.e. entirely behind even the far end of the cell's geometry) which is
// the conservative direction. The classic hierarchical-Z keeps a pyramid; one level of 8x8-pixel
// cells with 16 stratified taps each is plenty for the small instances and sparks this serves, and
// costs 32k threads.
//
// WHY LAST FRAME'S MATRICES: the depth was rendered by the camera as it stood when the last frame
// was drawn, so reprojecting a world point into it must use THAT camera. `commit(camera)` stores the
// camera at the end of an update; the next frame's kernels see it as `uPrevVP` / `uPrevView`.
//
// Resolves to null off the WebGPU backend (the WebGL2 backend has no compute), so callers keep the
// path they had.
import { Matrix4 } from 'three-eco/webgpu';
import {
  Fn, Loop, float, instanceIndex, instancedArray, int, ivec2, perspectiveDepthToViewZ, select, textureLoad,
  textureSize, uniform, vec2, vec4,
} from 'three-eco/tsl';

/**
 * @param renderer an initialised WebGPURenderer
 * @param {{ depth: any, near: number, far: number, cols?: number, rows?: number, taps?: number }} opts
 *        depth: the scene pass's depth TextureNode (or a DepthTexture) - non-multisampled
 * @returns {null | {
 *   cols:number, rows:number, buffer:any, uPrevVP:any, uPrevView:any, valid:boolean,
 *   update():void, commit(camera):void, project(worldPos:any):any, cell(ix:any, iy:any):any, dispose():void }}
 */
export function createDepthGrid(renderer, { depth, near, far, cols = 240, rows = 135, taps = 4 } = {}) {
  if (!renderer?.backend?.isWebGPUBackend || !depth) return null;
  const tex = depth.isNode ? depth.value : depth;
  if (!tex) return null;

  const buffer = instancedArray(cols * rows, 'vec2');
  const uPrevVP = uniform(new Matrix4());
  const uPrevView = uniform(new Matrix4());
  const uPrevProjY = uniform(1);          // proj[1][1]: pixels-per-metre scale for sphere footprints
  const uPrevProjX = uniform(1);          // proj[0][0]
  const uPrevWorld = uniform(new Matrix4()); // camera.matrixWorld: view space -> world (for surface normals)

  const reduce = Fn(() => {
    const cx = int(instanceIndex.mod(cols));
    const cy = int(instanceIndex.div(cols));
    const size = textureSize(textureLoad(tex), 0);
    const mn = float(1e9).toVar();
    const mx = float(0).toVar();
    Loop(taps, taps, ({ i, j }) => {
      const uv = vec2(cx, cy).add(vec2(i, j).add(0.5).div(taps)).div(vec2(cols, rows));
      const d = textureLoad(tex, ivec2(uv.mul(vec2(size)))).r;
      const eye = perspectiveDepthToViewZ(d, near, far).negate();
      mn.assign(eye.min(mn));
      mx.assign(eye.max(mx));
    });
    buffer.element(instanceIndex).assign(vec2(mn, mx));
  })().compute(cols * rows);

  const state = { valid: false, frames: 0 };
  let failed = false;
  const prevVP = new Matrix4();

  return {
    cols, rows, buffer, uPrevVP, uPrevView, uPrevProjX, uPrevProjY, uPrevWorld, near, far,
    /** True once a camera has been committed and the first reduce ran without error. */
    get valid() { return state.valid && !failed; },

    /** Per frame, BEFORE the scene render: reduce the depth the last frame left. */
    update() {
      if (failed || state.frames < 1) return;   // nothing rendered yet
      try { renderer.compute(reduce); state.valid = true; } catch (e) { failed = true; console.warn('[depthGrid] reduce failed:', e?.message || e); }
    },

    /** After the frame's camera is final: remember it as the camera the NEXT depth will have been drawn with. */
    commit(camera) {
      camera.updateMatrixWorld();
      prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      uPrevVP.value.copy(prevVP);
      uPrevView.value.copy(camera.matrixWorldInverse);
      uPrevProjY.value = camera.projectionMatrix.elements[5];
      uPrevProjX.value = camera.projectionMatrix.elements[0];
      uPrevWorld.value.copy(camera.matrixWorld);
      state.frames++;
    },

    /**
     * World point -> last frame's screen: vec4(u, v, eyeDistance, inFront) with u,v in 0..1 (v down).
     * inFront is 0 behind that camera.
     */
    project: Fn(([p]) => {
      const clip = uPrevVP.mul(vec4(p, 1));
      const w = clip.w.max(1e-4);
      const ndc = clip.xy.div(w);
      const view = uPrevView.mul(vec4(p, 1));
      return vec4(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5), view.z.negate(), select(clip.w.greaterThan(1e-3), float(1), float(0)));
    }),

    /** The (nearest, farthest) eye distance of one grid cell; indices are clamped to the grid. */
    cell: Fn(([ix, iy]) => {
      const x = int(ix).clamp(0, cols - 1);
      const y = int(iy).clamp(0, rows - 1);
      return buffer.element(y.mul(cols).add(x));
    }),

    dispose() { try { reduce.dispose?.(); } catch { /* gone */ } },
  };
}
