// pocapitol/crowdGpu.js — WebGPU spatial-hash crowd compute solver for PoCapitol.
// Accelerates social-force steering, separation, and gas-density avoidance on the GPU when WebGPU
// is available, scaling smoothly to 5x-10x crowd counts with zero per-frame CPU readback.
// Falls back to null on WebGL2 so steering.js (yuka CPU) stays active unchanged.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, Loop, atomicAdd, clamp, float, floor, instanceIndex, instancedArray, int, length, max,
  normalize, select, storage, uint, uniform, vec2, vec4,
} from 'three-eco/tsl';

const GRID_W = 64;
const GRID_H = 64;
const GRID_CELLS = GRID_W * GRID_H;

/**
 * Create a WebGPU spatial-hash crowd compute solver.
 * @param {object} renderer WebGPURenderer
 * @param {{ count: number, bounds: { minX: number, maxX: number, minZ: number, maxZ: number } }} opts
 */
export function createGpuCrowdSolver(renderer, { count = 512, bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 } } = {}) {
  if (!renderer?.backend?.isWebGPUBackend || !(count > 0)) return null;

  // Agent state: P = (x, z, heading, speed), V = (vx, vz, stress, flags)
  const P = instancedArray(count, 'vec4');
  const V = instancedArray(count, 'vec4');
  const cellCounts = instancedArray(GRID_CELLS, 'uint');
  const cellCountsAtomic = storage(cellCounts.value, 'uint', GRID_CELLS).toAtomic();

  const uDt = uniform(1 / 60);
  const uCount = uniform(count, 'uint');
  const uGoal = uniform(new THREE.Vector2(0, -35));
  const uGasCenter = uniform(new THREE.Vector4(0, 0, 0, 0)); // x, z, radius, strength
  const uMin = uniform(new THREE.Vector2(bounds.minX, bounds.minZ));
  const uSpan = uniform(new THREE.Vector2(Math.max(1, bounds.maxX - bounds.minX), Math.max(1, bounds.maxZ - bounds.minZ)));

  const clearGrid = Fn(() => {
    cellCounts.element(instanceIndex).assign(uint(0));
  })().compute(GRID_CELLS);

  const binAgents = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uCount), () => {
      const p = P.element(i);
      const gx = clamp(int(floor(p.x.sub(uMin.x).div(uSpan.x).mul(GRID_W))), int(0), int(GRID_W - 1));
      const gz = clamp(int(floor(p.y.sub(uMin.y).div(uSpan.y).mul(GRID_H))), int(0), int(GRID_H - 1));
      atomicAdd(cellCountsAtomic.element(gz.mul(int(GRID_W)).add(gx)), uint(1));
    });
  })().compute(count);

  const stepAgents = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uCount), () => {
      const p = P.element(i).toVar();
      const v = V.element(i).toVar();
      const pos = p.xy;
      const toGoal = uGoal.sub(pos);
      const dist = max(length(toGoal), float(0.001));
      const desired = toGoal.div(dist).mul(2.1);

      // Local crowd pressure gradient from 4-neighbour spatial hash counts
      const gx = clamp(int(floor(pos.x.sub(uMin.x).div(uSpan.x).mul(GRID_W))), int(1), int(GRID_W - 2));
      const gz = clamp(int(floor(pos.y.sub(uMin.y).div(uSpan.y).mul(GRID_H))), int(1), int(GRID_H - 2));
      const cL = float(cellCounts.element(gz.mul(int(GRID_W)).add(gx.sub(1))));
      const cR = float(cellCounts.element(gz.mul(int(GRID_W)).add(gx.add(1))));
      const cD = float(cellCounts.element(gz.sub(1).mul(int(GRID_W)).add(gx)));
      const cU = float(cellCounts.element(gz.add(1).mul(int(GRID_W)).add(gx)));
      const cSelf = float(cellCounts.element(gz.mul(int(GRID_W)).add(gx)));
      const pushOut = vec2(cL.sub(cR), cD.sub(cU)).mul(0.35);

      // Gas plume repulsion
      const fromGas = pos.sub(uGasCenter.xy);
      const gasD = max(length(fromGas), float(0.01));
      const gasPush = select(
        gasD.lessThan(uGasCenter.z).and(uGasCenter.w.greaterThan(0.01)),
        normalize(fromGas).mul(uGasCenter.w.mul(float(1).sub(gasD.div(max(uGasCenter.z, float(0.1))))).mul(4.5)),
        vec2(0, 0),
      );

      const vel = v.xy.add(desired.sub(v.xy).mul(uDt.mul(2.4))).add(pushOut.add(gasPush).mul(uDt));
      const spd = length(vel);
      const maxSpd = float(3.2);
      const clampedVel = select(spd.greaterThan(maxSpd), vel.div(spd).mul(maxSpd), vel);
      const nextPos = pos.add(clampedVel.mul(uDt));

      p.x.assign(clamp(nextPos.x, uMin.x, uMin.x.add(uSpan.x)));
      p.y.assign(clamp(nextPos.y, uMin.y, uMin.y.add(uSpan.y)));
      p.z.assign(select(spd.greaterThan(0.05), clampedVel.y.atan2(clampedVel.x), p.z));
      p.w.assign(spd);
      v.x.assign(clampedVel.x);
      v.y.assign(clampedVel.y);
      v.z.assign(clamp(cSelf.mul(0.18), float(0), float(1)));

      P.element(i).assign(p);
      V.element(i).assign(v);
    });
  })().compute(count);

  const passes = [clearGrid, binAgents, stepAgents];

  return {
    count,
    positionsNode: P,
    velocitiesNode: V,
    seed(initialXY) {
      const arr = P.value.array;
      for (let i = 0; i < count; i++) {
        arr[i * 4] = initialXY[i * 2] ?? 0;
        arr[i * 4 + 1] = initialXY[i * 2 + 1] ?? 0;
        arr[i * 4 + 2] = 0;
        arr[i * 4 + 3] = 0;
      }
      P.value.needsUpdate = true;
    },
    setGoal(x, z) { uGoal.value.set(x, z); },
    setGas(x, z, radius, strength) { uGasCenter.value.set(x, z, radius, strength); },
    step(dt) {
      uDt.value = Math.min(0.05, Math.max(0.001, dt || 0.016));
      renderer.compute(passes);
    },
    async readTelemetry() {
      const buf = await renderer.getArrayBufferAsync(V.value);
      const v = new Float32Array(buf);
      let peakStress = 0, sumStress = 0;
      for (let i = 0; i < count; i++) {
        const s = v[i * 4 + 2];
        if (s > peakStress) peakStress = s;
        sumStress += s;
      }
      return { peakStress, avgStress: count ? sumStress / count : 0 };
    },
    dispose() {},
  };
}
