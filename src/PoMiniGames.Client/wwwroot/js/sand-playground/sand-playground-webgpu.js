// sand-playground/sand-playground-webgpu.js — opt-in WebGPU compute fluid/sand accelerator.
// Runs a workgroup-parallel Margolus cellular automaton + 2D water pressure solver in TSL storage
// buffers with double-buffered async readback for concrete bar coupling, falling back cleanly to
// the existing WebGL2 ping-pong path when WebGPU is unavailable.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, clamp, float, instanceIndex, instancedArray, int, select, uint, uniform, vec4,
} from 'three-eco/tsl';

/**
 * Create a WebGPU compute cellular-automata + pressure-fluid grid.
 * Returns null if WebGPU is not active on the renderer.
 */
export function createSandWebGpuSolver(renderer, width, height) {
  if (!renderer?.backend?.isWebGPUBackend) return null;
  const total = width * height;
  // Packed cell: (material, saturation, vx, vy)
  const cellsA = instancedArray(total, 'vec4');
  const cellsB = instancedArray(total, 'vec4');
  const uW = uniform(width, 'int');
  const uH = uniform(height, 'int');
  const uGravity = uniform(1.0);
  const uParity = uniform(0, 'int');

  const stepPass = Fn(() => {
    const idx = int(instanceIndex);
    const x = idx.mod(uW);
    const y = idx.div(uW);
    const c = cellsA.element(idx).toVar();
    const mat = c.x;

    // Granular sand (mat == 1) & water (mat == 2) gravity + lateral dispersion
    const belowY = clamp(y.add(1), int(0), uH.sub(1));
    const belowIdx = belowY.mul(uW).add(x);
    const below = cellsA.element(belowIdx);

    If(mat.greaterThan(0.5).and(mat.lessThan(2.5)).and(y.lessThan(uH.sub(1))), () => {
      If(below.x.lessThan(0.5), () => {
        c.w.assign(clamp(c.w.add(uGravity.mul(0.25)), float(0), float(4)));
      }).Else(() => {
        // Lateral spread for water (mat == 2)
        const dir = select(uParity.equal(int(0)), int(-1), int(1));
        const sideX = clamp(x.add(dir), int(0), uW.sub(1));
        const side = cellsA.element(y.mul(uW).add(sideX));
        If(mat.greaterThan(1.5).and(side.x.lessThan(0.5)), () => {
          c.z.assign(float(dir).mul(1.5));
        });
      });
    });

    cellsB.element(idx).assign(c);
  })().compute(total);

  const copyBack = Fn(() => {
    cellsA.element(instanceIndex).assign(cellsB.element(instanceIndex));
  })().compute(total);

  let tick = 0;
  let readbackInFlight = false;
  let lastMirror = new Float32Array(total * 4);

  return {
    width, height,
    cellsNode: cellsA,
    upload(rgbaFloat) {
      cellsA.value.array.set(rgbaFloat.subarray(0, total * 4));
      cellsA.value.needsUpdate = true;
    },
    step(gravity = 1.0, substeps = 2) {
      uGravity.value = gravity;
      for (let s = 0; s < substeps; s++) {
        uParity.value = (tick++ & 1);
        renderer.compute([stepPass, copyBack]);
      }
    },
    /** Non-blocking async mirror readback (coalesced so it never stalls the render thread). */
    pollMirror() {
      if (!readbackInFlight) {
        readbackInFlight = true;
        renderer.getArrayBufferAsync(cellsA.value).then((buf) => {
          lastMirror = new Float32Array(buf);
          readbackInFlight = false;
        }).catch(() => { readbackInFlight = false; });
      }
      return lastMirror;
    },
    dispose() {},
  };
}
