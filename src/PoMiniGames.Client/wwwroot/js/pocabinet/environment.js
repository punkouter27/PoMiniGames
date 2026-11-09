// pocabinet/environment.js
//
// Weather for PoCabinet's scene, on top of the static per-track atmosphere. Always daytime:
// night and dusk would make the track hard to read.
//
// The page picks 'clear' or 'rain' (its settings store); anything else is clear. This module
// only resolves that word and calls the hooks that own each effect:
//   • scene.setWeather — fog, sky, light, wet asphalt and run-off, falling rain, lens drops
//   • audio.setRain    — rain on the roof
// and publishes the result through currentEnvironment(), which race.js (solo rain grip),
// acoustics.js and the wet reflections read live, so a remount mid-race (the weather setting
// changed) reaches them on the next frame. Online stays dry: prediction must run the server
// numbers (race.js decides that).

import * as audio from './audio.js';

const DRY = Object.freeze({ raining: false });
let current = DRY;

/** Weather of the mounted environment ({ raining }); dry when none is mounted. */
export function currentEnvironment() {
    return current;
}

class EnvironmentHandle {
    constructor(sceneHandle, raining) {
        this.sceneHandle = sceneHandle;
        this.env = { raining };
        this.disposed = false;
        this.frameCb = null;
        current = this.env;
        if (!sceneHandle || sceneHandle.disposed) return;
        sceneHandle.setWeather?.(raining);
        audio.setRain(raining ? 1 : 0);
        if (!raining) return;
        // Re-assert now and then: the AudioContext may only have been unlocked after mount.
        let last = 0;
        this.frameCb = (now) => {
            if (now - last < 1000) return;
            last = now;
            audio.setRain(1);
        };
        sceneHandle.onFrame(this.frameCb);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const handle = this.sceneHandle;
        if (this.frameCb) handle?.offFrame(this.frameCb);
        // A newer mount already owns the weather (the page remounted before tearing this down).
        if (current !== this.env) return;
        current = DRY;
        if (this.env.raining) {
            try { audio.setRain(0); } catch { /* teardown is best-effort */ }
            if (handle && !handle.disposed) handle.setWeather?.(false);
        }
    }
}

/**
 * Apply the weather to a mounted scene handle. `weather` is 'clear' | 'rain' (anything else
 * is clear). Returns a handle with dispose(); call it on race teardown or before a remount.
 */
export async function mountEnvironment(sceneHandle, weather) {
    const raining = weather === 'rain' && !sceneHandle?.room;
    return new EnvironmentHandle(sceneHandle, raining);
}

export function unmountEnvironment(handle) {
    handle?.dispose();
}
