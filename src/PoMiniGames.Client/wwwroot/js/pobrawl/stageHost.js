// stageHost.js — how the two arena engines (game.js 1v1/Cup, ffa.js battle royale) boot on the
// shared stage: one rAF loop, one deferred ResizeObserver, one pixel-ratio policy, one dispose
// that also hands the GPU context back. What stays here is PoBrawl-specific glue only.
//
// The renderer is three's WebGPURenderer: WebGPU where the browser has it, its own WebGL2
// backend where it does not. `?brawlBackend=webgl2` forces the fallback, for comparing the two.
import * as THREE from 'three-eco/webgpu';
import { createStage } from '../platform/stage/stage.js';
import { createRenderer, attachRenderer } from '../platform/3d/renderer.js';
import { holdQuality, reportGpuMs } from '../platform/visualRuntime.js';

/**
 * Stage + renderer in the container, already sized. `look` is createRenderer's tone/exposure/
 * shadows; `o` is createStage's options (maxDpr, onFrame, ...). The pixel-ratio cap lives on
 * `stage.userData.opts` so a quality-tier change can move it (setMaxDpr).
 */
export async function createArenaStage(container, look, o = {}) {
  // The next seconds are shader builds, not this machine's frame rate: keep the adaptive
  // tier from reading them as a slow GPU. The 1v1 engine releases the hold itself when its
  // warm-up ends; the battle royale lets it run out.
  try { holdQuality(12000); } catch { /* chrome, never the game's problem */ }
  const stage = createStage({ kind: '3d', container, pauseOn: [], exclude: ['shake'], ...o });
  const renderer = await createRenderer(THREE, {
    api: 'webgpu', antialias: false, forceWebGL: forceWebGL(), trackTimestamp: true, ...look,
  });
  container.appendChild(renderer.domElement);   // before the engine's own overlays
  // CSS box in px, as the old setSize(w, h) kept it.
  stage.userData.size = attachRenderer(stage, renderer, { updateStyle: true });
  return { stage, renderer };
}

function forceWebGL() {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('brawlBackend') === 'webgl2'; } catch { return false; }
}

/**
 * Read the GPU's own frame time (WebGPU timestamp queries) about twice a second and hand it
 * to the adaptive-quality loop, which then knows a slow GPU from a busy main thread. Call
 * once per frame; it does nothing where the device has no timestamp queries.
 * @returns {number} the latest GPU frame time in ms, or -1 when it is not known
 */
export function sampleGpuTime(stage, renderer) {
  const u = stage.userData;
  if (!renderer?.backend?.trackTimestamp) return -1;
  u.gpuTick = (u.gpuTick || 0) + 1;
  if (u.gpuTick % 30 === 0 && !u.gpuBusy) {
    u.gpuBusy = true;
    renderer.resolveTimestampsAsync('render').then((resolved) => {
      // The resolved duration where the renderer returns one, else the figure it keeps in info.
      const ms = typeof resolved === 'number' && resolved > 0 ? resolved : renderer.info.render.timestamp;
      if (ms > 0) { u.gpuMs = ms; try { reportGpuMs(ms); } catch { /* chrome */ } }
    }).catch(() => {}).finally(() => { u.gpuBusy = false; });
  }
  return u.gpuMs ?? -1;
}

/** Camera / composer to size with the renderer, and an engine hook run after each resize. */
export function bindView(stage, { camera, composer, onResize }) {
  stage.userData.size.set({ camera, composer });
  if (onResize && !stage.userData.hooked) { stage.userData.hooked = true; stage.on('resize', onResize); }
}

/** Move the DPR ceiling (quality tier) and re-measure. */
export function setMaxDpr(stage, maxDpr) {
  stage?.setLimits({ maxDpr });
}
