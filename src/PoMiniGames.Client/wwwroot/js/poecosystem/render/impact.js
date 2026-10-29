// impact.js — PoEcosystem's read of the app-wide impact envelope (impactBus.js).
//
// These are the three helpers ../../postFx.js exports, restated here on purpose: postFx.js
// imports three r165's BokehPass, so importing it from this game would pull the second
// three.js build (and its whole module graph) into a page that renders with r186 — two
// copies of three, one of them unused. The maths is the same, so the island reacts to a
// blast on the same curve as every other three.js game.
import * as Impact from '../../impactBus.js';

/** Chromatic aberration (UV units at the frame edge) for the current impact envelope. */
export function punchAberration(scale = 1) {
  return Impact.getPunch() * 0.006 * scale;
}

/** Radial (zoom) blur strength: squared, so a light hit barely smears and a big one shows. */
export function punchRadial(scale = 1) {
  const p = Impact.getPunch();
  return p * p * scale;
}

/**
 * Camera shake in the camera's own basis, from the same trauma reservoir as the DOM shake.
 * Call AFTER the camera is posed for the frame; nothing accumulates, so nothing to undo.
 */
export function applyCameraShake(camera, nowSec, amplitude = 0.9) {
  const s = Impact.getShake();
  if (s < 0.001) return;
  const a = amplitude * s;
  const x = (Math.sin(nowSec * 13.7) * 0.62 + Math.sin(nowSec * 32.5 + 1.7) * 0.38) * a;
  const y = (Math.sin(nowSec * 17.3) * 0.62 + Math.sin(nowSec * 41.0 + 1.7) * 0.38) * a;
  camera.translateX(x);
  camera.translateY(y);
}

// impactFx.js (a classic script) drives the punch through window.PoThreeFx. Another game's
// postFx.js publishes the full object; when only this game has loaded, publish the part it
// reads so a hit still reaches the island.
if (typeof window !== 'undefined' && !window.PoThreeFx) {
  window.PoThreeFx = { punchAberration, punchRadial, applyCameraShake };
}
