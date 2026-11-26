// workerWorld.js — page-side handle on physicsWorker.js (optional worker mode of the platform
// physics wrapper). Same body-description objects as rapier.js addBody(); poses arrive as a
// transferable Float32Array that is handed back with the next step request (ping-pong), so the
// steady state allocates nothing. Falls back to null when workers/modules are unavailable — the
// caller then builds an in-thread world with createPhysicsWorld().
export function createWorkerWorld(options = {}) {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  let worker;
  const workerPath = options.backend === 'ammo' ? './ammoWorker.js' : './physicsWorker.js';
  try { worker = new Worker(new URL(workerPath, import.meta.url), { type: 'module' }); }
  catch { return Promise.resolve(null); }

  let nextId = 1;
  let poses = new Float32Array(0);
  let count = 0;
  let spare = null;
  let pending = false;
  const ids = [];
  const api = {
    worker,
    get poses() { return poses; },
    get count() { return count; },
    /** Add a body; returns its slot index in the pose buffer (creation order). */
    addBody(desc) { const id = nextId++; ids.push(id); worker.postMessage({ type: 'add', id, desc }); return ids.length - 1; },
    removeBody(slot) { const id = ids[slot]; ids.splice(slot, 1); worker.postMessage({ type: 'remove', id }); },
    set(slot, patch) { worker.postMessage({ type: 'set', id: ids[slot], ...patch }); },
    applyImpulses(items) {
      const mapped = items.map((it) => ({ id: ids[it.slot], impulse: it.impulse })).filter((it) => it.id != null);
      if (mapped.length) worker.postMessage({ type: 'batchImpulse', items: mapped });
    },
    /** Ask for a step; the previous pose buffer is recycled. Safe to call every frame (coalesces). */
    step(dt) {
      if (pending) return false;
      pending = true;
      const msg = { type: 'step', dt, buf: spare };
      worker.postMessage(msg, spare ? [spare.buffer] : []);
      spare = null;
      return true;
    },
    free() { worker.postMessage({ type: 'free' }); worker.terminate(); },
    onHit: null,
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { worker.terminate(); } catch { /* ok */ } resolve(null); }, 15000);
    worker.onerror = () => { clearTimeout(t); resolve(null); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(t); resolve(api); return; }
      if (m.type === 'poses') {
        if (poses.buffer.byteLength) spare = poses;
        poses = m.buf; count = m.count; pending = false;
        for (const h of m.hits) {
          if (api.onHit) api.onHit(h);
          else if (typeof window !== 'undefined' && window.PoImpactSynth) window.PoImpactSynth.play(h.tag, h.impulse, h.opts);
        }
      }
    };
    worker.postMessage({ type: 'init', options });
  });
}
