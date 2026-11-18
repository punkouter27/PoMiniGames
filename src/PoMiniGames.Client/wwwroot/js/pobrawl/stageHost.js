// stageHost.js — how the two arena engines (game.js 1v1/Cup, ffa.js battle royale) boot on the
// shared stage: one rAF loop, one deferred ResizeObserver, one pixel-ratio policy, one dispose
// that also hands the WebGL context back. What stays here is PoBrawl-specific glue only.
import * as THREE from 'three';
import { createStage } from '../platform/stage/stage.js';
import { createRenderer, attachRenderer } from '../platform/3d/renderer.js';

/**
 * Stage + renderer in the container, already sized. `look` is createRenderer's tone/exposure/
 * shadows; `o` is createStage's options (maxDpr, onFrame, ...). The pixel-ratio cap lives on
 * `stage.userData.opts` so a quality-tier change can move it (setMaxDpr).
 */
export async function createArenaStage(container, look, o = {}) {
  const stage = createStage({ kind: '3d', container, pauseOn: [], exclude: ['shake'], ...o });
  const renderer = await createRenderer(THREE, { antialias: false, ...look });
  container.appendChild(renderer.domElement);   // before the engine's own overlays
  // CSS box in px, as the old setSize(w, h) kept it.
  stage.userData.size = attachRenderer(stage, renderer, { updateStyle: true });
  return { stage, renderer };
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
