// postPunch.js — the renderer-free half of postFx.js: the quality-tier read and the impact
// envelope mapped onto aberration, radial blur and camera shake.
//
// Split out so an engine on the WebGPU build of three (PoBrawl, PoEcosystem) can use these
// without postFx.js pulling in the r165 BokehPass and, with it, a second copy of three.
// postFx.js re-exports everything here, so the WebGL games import it as they always did.

import * as Impact from './impactBus.js';

/** Current adaptive-quality tier, as published by visualRuntime.js. */
export function tier() {
    if (typeof document === 'undefined') return 'high';
    return document.documentElement.getAttribute('data-gfx') || 'high';
}

/** Convenience: is this machine allowed the expensive effects? */
export function allowHeavy() {
    return tier() === 'high';
}

/**
 * Chromatic aberration strength for the current impact envelope.
 *
 * Games add this to their own baseline rather than replacing it, so a scene
 * that already has a permanent slight fringe keeps it.
 * @param {number} [scale=1]
 */
export function punchAberration(scale) {
    return Impact.getPunch() * 0.006 * (scale == null ? 1 : scale);
}

/** Radial (zoom) blur strength for the current impact envelope. */
export function punchRadial(scale) {
    // Squared: a light hit should barely smear while a KO should be unmissable,
    // and a linear map makes every hit look like the same medium-sized event.
    const p = Impact.getPunch();
    return p * p * (scale == null ? 1 : scale);
}

/**
 * Camera shake in 3D, driven by the same trauma reservoir as the DOM shake.
 * Applies an offset in the camera's own basis so the shake is always
 * screen-relative regardless of where the camera is looking.
 *
 * MUST be called AFTER the game has positioned its camera for the frame, and
 * the offset is not accumulated — it is recomputed from scratch each call, so
 * there is nothing to undo.
 *
 * @param {THREE.Camera} camera
 * @param {number} nowSec
 * @param {number} [amplitude=0.9] world units at full trauma
 */
export function applyCameraShake(camera, nowSec, amplitude) {
    const s = Impact.getShake();
    if (s < 0.001) return;
    const a = (amplitude == null ? 0.9 : amplitude) * s;
    // Same incommensurable-frequency noise as impactBus, so the 3D camera and
    // the DOM chrome visibly shake together rather than on two rhythms.
    const x = (Math.sin(nowSec * 13.7) * 0.62 + Math.sin(nowSec * 32.5 + 1.7) * 0.38) * a;
    const y = (Math.sin(nowSec * 17.3) * 0.62 + Math.sin(nowSec * 41.0 + 1.7) * 0.38) * a;
    camera.translateX(x);
    camera.translateY(y);
}
