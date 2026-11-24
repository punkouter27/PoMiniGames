// gpuBackend.js — which graphics API the page is actually drawing with.
//
// Wraps HTMLCanvasElement.prototype.getContext to remember each canvas that got a
// 'webgpu', 'webgl2' or 'webgl' context. This reads the context that was really created,
// so a WebGPURenderer that fell back to WebGL reports WebGL 2, not WebGPU. A canvas counts only while it
// is in the document, so a throwaway feature-detection canvas or a game left behind does not.
//
// Must load before any game script: a classic, non-deferred <script> in index.html.

(function () {
  const proto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (!proto || proto.__poGpuBackendWrapped) return;

  const RANK = { webgpu: 3, webgl2: 2, webgl: 1, 'experimental-webgl': 1 };
  const LABEL = { 3: 'WebGPU', 2: 'WebGL 2', 1: 'WebGL' };
  // Weak references: a canvas that got its context before the game attached it to the page (three.js
  // creates the renderer's canvas first) must still count once attached, so a detached canvas is
  // skipped, not forgotten; one that was garbage-collected drops out by itself.
  /** @type {Set<WeakRef<HTMLCanvasElement>>} */
  const tracked = new Set();
  const kindOf = new WeakMap();

  const original = proto.getContext;
  proto.getContext = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    const rank = ctx ? RANK[type] : 0;
    if (rank) {
      if (!kindOf.has(this)) tracked.add(new WeakRef(this));
      kindOf.set(this, Math.max(rank, kindOf.get(this) || 0));
    }
    return ctx;
  };
  proto.__poGpuBackendWrapped = true;

  window.PoGpuBackend = {
    /** 'WebGPU' | 'WebGL 2' | 'WebGL' | '' (no GPU canvas on screen). */
    current() {
      let best = 0;
      for (const ref of tracked) {
        const c = ref.deref();
        if (!c) { tracked.delete(ref); continue; }
        if (!c.isConnected) continue;
        const k = kindOf.get(c) || 0;
        if (k > best) best = k;
      }
      return LABEL[best] || '';
    },
  };
})();
