// flume.js — Game mixin: the water in the flume set-piece (#14), as a fluid on a grid.
//
// The flume is a stream bed under a sheet of water (track-procedural.js builds both). The water
// is a 2D fluid over the flume in the track's own frame — x across the road in the interface's
// lateral sign, z along it in course units — run by the shared grid (platform/3d/fluidGrid.js):
//   · the current is the grid's wind, blowing down the flume;
//   · every marble in the water drags the water with it (a "mover") and leaves foam (a "source");
//   · white water pours in at the head.
// So the pack churns a wake that spreads, curls round and drifts downstream, and a marble running
// in another's wake is pushed by it (course.js _applyFlume reads grid.flow()). The surface draws
// the foam density as a texture whose UVs are the grid's cells.
//
// On a WebGPU machine on the heavy tier the same model runs as compute shaders at twice the
// resolution each way (platform/3d/fluidGridGpu.js); the CPU grid is the fallback everywhere
// else, and what the headless harness runs. A guest steps it too (from the streamed marbles), so
// both players see wakes; only the host's grid moves marbles.
import * as THREE from 'three-eco/webgpu';
import { createFluidGrid } from '../platform/3d/fluidGrid.js';
import { createGpuFluidGrid } from '../platform/3d/fluidGridGpu.js';
import { FLUME_CURRENT, FOAM_LIFE } from './tuning.js';

const CELL = 1.6;           // CPU cell size along the flume, course units (across is set by COLS)
const COLS = 40;
const MAX_WAKES = 24;       // GPU grid: 32 sources, 8 of them the inflow at the head
const INFLOW = 8;
const NEAR = 500;           // step only while the camera's marble is within this of the flume

const textureFor = (grid) => {
  const t = new THREE.DataTexture(grid.bytes, grid.cols, grid.rows, THREE.RedFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
};

export class FlumeMixin {
  // After a course is built: a grid over this course's flume, or nothing when it has none.
  _armFlume() {
    this._dropFlume();
    const fl = this.track.flume;
    if (!fl) return;
    const rect = { x0: -fl.maxHW, z0: fl.from, w: fl.maxHW * 2, d: fl.to - fl.from };
    const rows = Math.max(60, Math.min(220, Math.round(rect.d / CELL)));
    const physics = { lifeOut: FOAM_LIFE, lifeIn: FOAM_LIFE, windShare: 1 };
    const cpu = createFluidGrid(rect, COLS, rows, () => false, () => false, physics);
    const state = {
      fl, rect, cpu, grid: cpu, tex: textureFor(cpu), mat: null, sources: [], movers: [],
      wind: { x: 0, z: FLUME_CURRENT }, gpu: null,
    };
    // The inflow: white water across the head of the flume.
    for (let i = 0; i < INFLOW; i++) {
      state.sources.push({ x: rect.x0 + rect.w * ((i + 0.5) / INFLOW), z: rect.z0 + 2, rate: 0.9, r: 2.4 });
    }
    // The foam-reading water surface, where the scene can make one (scene.js waterMaterial).
    const mat = this.scene.waterMaterial ? this.scene.waterMaterial(state.tex) : null;
    if (mat && mat.isMaterial) {
      state.mat = mat;
      state.stand = fl.mesh.material;
      fl.mesh.material = mat;
    }
    this._flume = state;

    // The heavy tier swaps in the WebGPU grid when it is ready. Async and best-effort: it resolves
    // null wherever it cannot run, and a course rebuilt in the meantime discards it.
    if (this.scene.heavy && typeof navigator !== 'undefined' && navigator.gpu) {
      createGpuFluidGrid(rect, COLS * 2, rows * 2, () => false, () => false, physics).then((g) => {
        if (!g) return;
        if (this._flume !== state || this.disposed) { g.dispose(); return; }
        state.gpu = g;
        state.grid = g;
        const old = state.tex;
        state.tex = textureFor(g);
        state.mat?.userData?.setFoam?.(state.tex);
        old.dispose();
      }).catch(() => { /* resolves null on failure; the CPU grid carries on */ });
    }
  }

  _dropFlume() {
    const st = this._flume;
    if (!st) return;
    this._flume = null;
    if (st.mat) {
      if (st.stand) st.fl.mesh.material = st.stand;
      st.mat.dispose();
    }
    st.tex.dispose();
    st.gpu?.dispose();
  }

  // Per frame, host and guest alike (director.js _presentRace).
  _stepFlume(dt) {
    const st = this._flume;
    if (!st || this.phase !== 'racing') return;
    const { fl } = st;
    const focus = this._lastFocus;
    const near = focus && focus.s > fl.from - NEAR && focus.s < fl.to + 60;
    // Wakes: the marbles in the water, nearest the camera's first when there are too many.
    const movers = st.movers;
    movers.length = 0;
    const wakes = [];
    for (const m of this.marbleSet.marbles) {
      if (m.finished || m.eliminated || !m.proj || m.s < fl.from || m.s > fl.to) continue;
      if (m.proj.height > fl.waterH + m.radius + 1.5) continue;
      const v = m.body.velocity;
      const d = this.track.dirAt(m.s, _dir), r = this.track.rightAt(m.s, _right);
      const vz = v.x * d.x + v.y * d.y + v.z * d.z, vx = v.x * r.x + v.y * r.y + v.z * r.z;
      movers.push({ x: m.proj.lateral, z: m.s, vx, vz });
      // Foam scales with speed; a fresh splashdown throws a burst of it.
      const splash = m._wetAt !== undefined && this.raceClock - m._wetAt < 0.25 ? 6 : 0;
      wakes.push({ x: m.proj.lateral, z: m.s, rate: Math.min(3, Math.hypot(vx, vz) * 0.03) + splash, r: 1.5, k: focus ? Math.abs(m.s - focus.s) : 0 });
    }
    if (!near && !movers.length) return;
    wakes.sort((a, b) => a.k - b.k);
    if (wakes.length > MAX_WAKES) wakes.length = MAX_WAKES;
    const sources = st.sources.slice(0, INFLOW).concat(wakes);
    if (st.grid.step(Math.min(dt, 1 / 30), sources, st.wind, movers)) st.tex.needsUpdate = true;
  }
}

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
