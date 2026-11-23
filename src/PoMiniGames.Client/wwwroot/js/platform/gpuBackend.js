// gpuBackend.js — which graphics API the page is actually drawing with.
//
// Wraps HTMLCanvasElement.prototype.getContext to remember each canvas that got a
// 'webgpu', 'webgl2' or 'webgl' context. current() then looks only at canvases still
// in the document, so a game left behind on navigation (or a throwaway canvas used for
// feature detection) does not count. This reads the context that was really created,
// so a WebGPURenderer that fell back to WebGL reports WebGL 2, not WebGPU.
//
// Must load before any game script: a classic, non-deferred <script> in index.html.

(function () {
  const proto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (!proto || proto.__poGpuBackendWrapped) return;

  const RANK = { webgpu: 3, webgl2: 2, webgl: 1, 'experimental-webgl': 1 };
  const LABEL = { 3: 'WebGPU', 2: 'WebGL 2', 1: 'WebGL' };
  /** @type {Set<HTMLCanvasElement>} */
  const tracked = new Set();
  const kindOf = new WeakMap();

  const original = proto.getContext;
  proto.getContext = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    const rank = ctx ? RANK[type] : 0;
    if (rank) {
      kindOf.set(this, Math.max(rank, kindOf.get(this) || 0));
      tracked.add(this);
    }
    return ctx;
  };
  proto.__poGpuBackendWrapped = true;

  window.PoGpuBackend = {
    /** 'WebGPU' | 'WebGL 2' | 'WebGL' | '' (no GPU canvas on screen). */
    current() {
      let best = 0;
      for (const c of tracked) {
        if (!c.isConnected) { tracked.delete(c); continue; }
        const k = kindOf.get(c) || 0;
        if (k > best) best = k;
      }
      return LABEL[best] || '';
    },
  };
})();
