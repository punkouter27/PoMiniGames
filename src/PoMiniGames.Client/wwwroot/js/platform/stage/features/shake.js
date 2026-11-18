// shake.js — one camera shake for every game, 2D and 3D.
//
// The trauma model lives in impactBus.js (PoImpact.addTrauma / impact(kind)); it already
// decays trauma, squares it into a magnitude and scales it by the quality tier and reduced
// motion. This feature turns that magnitude into an offset each frame and applies it around
// the game's draw:
//   2D — stage.setTransform() folds stage.shake.x/y (CSS px) into every transform.
//   3D — the camera is nudged before render and put back after, so game camera code never
//        sees the offset and nothing accumulates.
// A game feeds shake with PoImpact.addTrauma(0..1) (or impact('hit')) and does nothing else.
// A game with its own tuned camera rig can pass `exclude: ['shake']`.

import { registerFeature } from '../features.js';

/** Smooth pseudo-noise in [-1, 1]: two incommensurate sines, so the shake never loops visibly. */
export function shakeNoise(t, seed) {
    return 0.6 * Math.sin(t * 13.7 + seed) + 0.4 * Math.sin(t * 29.3 + seed * 2.1);
}

/** Offsets for magnitude m (0..1) at time t. */
export function shakeOffset(m, t, maxPx = 14, maxUnits = 0.35, maxRoll = 0.02) {
    return {
        x: m * maxPx * shakeNoise(t, 1.3),
        y: m * maxPx * shakeNoise(t, 4.7),
        ux: m * maxUnits * shakeNoise(t, 1.3),
        uy: m * maxUnits * shakeNoise(t, 4.7),
        uz: m * maxUnits * 0.5 * shakeNoise(t, 7.9),
        roll: m * maxRoll * shakeNoise(t, 9.1),
    };
}

export default registerFeature({
    id: 'shake',
    kind: 'any',
    order: -10,   // before overlays, so they draw unshaken
    create(stage) {
        let t = 0;
        let saved = null;
        return {
            update(dt) {
                t += dt;
                // Read live so a game can tune it any time: createStage({ shake: {...} }) or stage.userData.shake.
                const opts = stage.userData.shake ?? {};   // { maxPx, maxUnits, maxRoll, scale }
                const m = (globalThis.PoImpact?.getShake?.() ?? 0) * (opts.scale ?? 1);
                const s = stage.shake;
                s.amount = m;
                if (m <= 0.0005) { s.x = s.y = s.z = s.roll = 0; return; }
                const off = shakeOffset(m, t, opts.maxPx, opts.maxUnits, opts.maxRoll);
                if (stage.kind === '2d') { s.x = off.x; s.y = off.y; s.z = 0; s.roll = 0; }
                else { s.x = off.ux; s.y = off.uy; s.z = off.uz; s.roll = off.roll; }
            },
            beforeRender() {
                const cam = stage.camera;
                const s = stage.shake;
                if (stage.kind !== '3d' || !cam || s.amount <= 0.0005) return;
                saved = { x: cam.position.x, y: cam.position.y, z: cam.position.z, roll: cam.rotation?.z ?? 0 };
                cam.position.x += s.x; cam.position.y += s.y; cam.position.z += s.z;
                if (cam.rotation) cam.rotation.z += s.roll;
                cam.updateMatrixWorld?.();
            },
            afterRender() {
                const cam = stage.camera;
                if (!saved || !cam) return;
                cam.position.set ? cam.position.set(saved.x, saved.y, saved.z) : Object.assign(cam.position, saved);
                if (cam.rotation) cam.rotation.z = saved.roll;
                cam.updateMatrixWorld?.();
                saved = null;
            },
        };
    },
});
