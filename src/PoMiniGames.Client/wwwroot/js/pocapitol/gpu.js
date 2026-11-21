// A shared WebGPU device for PoCapitol's optional GPU effects.
//
// The main scene is drawn by three's WebGLRenderer, so no GPU device is shared with it; the
// effects that use compute (the density terrain, the menu fluid, the end-of-attempt dissolve)
// each run on their own canvas. They can all use one device, requested once here. Every caller
// treats a null result as "no WebGPU": the effect then keeps its CPU or WebGL path or skips.

let pending = null;

/** The shared device, or null when the browser has no WebGPU or the request fails. */
export function gpuDevice() {
    if (!navigator.gpu) return Promise.resolve(null);
    pending ??= (async () => {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            device.lost.then(() => { pending = null; });
            return device;
        } catch (error) {
            console.warn('[PoCapitol] WebGPU unavailable:', error?.message ?? error);
            return null;
        }
    })();
    return pending;
}

/** Reduced motion, however the page or the player asked for it. */
export const reducedMotion = () =>
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The app's quality tier ('low' | 'medium' | 'high'), 'high' when nothing reports one. */
export const qualityTier = () => window.PoQuality?.tier?.() ?? 'high';
