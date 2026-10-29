// backend.js — which GPU API draws the island: the WebGPU probe, the choice, and the
// fallback contract. No three.js import (the caller hands THREE in) and no DOM beyond
// `navigator`/`location`/`sessionStorage`, each guarded, so the choice is unit-tested.
//
// WHERE THIS STANDS
// The scene is WebGL2 through and through: materials.js patches MeshLambertMaterial with
// onBeforeCompile, sky/water/grass/particles/terrain ship GLSL ShaderMaterials, and
// postProcess.js is an EffectComposer chain (bloom, SMAA, the grade). three's
// WebGPURenderer ignores onBeforeCompile, cannot run GLSL ShaderMaterials, and has no
// EffectComposer — every one of those would have to be rewritten as node materials (TSL)
// and a PostProcessing node graph before a WebGPU frame could look like a WebGL2 one.
// Until that port lands, SCENE_WEBGPU_READY is false and the choice is always webgl2;
// the probe still runs so the dev console (and window.PoEcoBackend) says whether this
// machine could take the WebGPU path, and why it did not.
//
// FALLBACK CONTRACT: no navigator.gpu, no adapter, a device that will not open, a device
// lost (this session), low tier, an explicit ?ecoBackend=webgl2, or any thrown error →
// webgl2, silently. Nothing here throws to its caller.

/** Flip once every GLSL/onBeforeCompile/EffectComposer piece has a node-material twin. */
export const SCENE_WEBGPU_READY = false;

/** What still pins the scene to WebGL2 (reported alongside the choice). */
export const WEBGPU_BLOCKERS = Object.freeze([
  'materials.js: onBeforeCompile patches on MeshLambertMaterial',
  'sky.js, water.js, grass.js, particles.js, terrainMesh.js: GLSL ShaderMaterial',
  'postProcess.js: EffectComposer (bloom, SMAA, grade, output)',
]);

const BROKEN_KEY = 'poeco.webgpuBroken';
const PROBE_TIMEOUT_MS = 2500;

let probePromise = null;

/** The ?ecoBackend=webgl2|webgpu override, or null. */
export function backendOverride(search = safeSearch()) {
  try {
    const v = new URLSearchParams(search).get('ecoBackend');
    return v === 'webgl2' || v === 'webgpu' ? v : null;
  } catch { return null; }
}

/** True on a dev host or with ?ecoDebug — where the backend line goes to the console. */
export function backendDebug() {
  try {
    const host = globalThis.location?.hostname ?? '';
    return host === 'localhost' || host === '127.0.0.1' || new URLSearchParams(safeSearch()).has('ecoDebug');
  } catch { return false; }
}

/**
 * Ask for a WebGPU adapter and device once per page; resolves to
 * { ok, reason, adapter: { vendor, architecture } | null }. The device is destroyed right
 * after: this answers "could it", the renderer that takes the path opens its own.
 */
export function probeWebGPU(nav = globalThis.navigator) {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    try {
      if (wasMarkedBroken()) return { ok: false, reason: 'device-lost-this-session', adapter: null };
      const gpu = nav?.gpu;
      if (!gpu || typeof gpu.requestAdapter !== 'function') return { ok: false, reason: 'no-navigator-gpu', adapter: null };
      const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: 'high-performance' }));
      if (!adapter) return { ok: false, reason: 'no-adapter', adapter: null };
      const info = adapter.info ?? (typeof adapter.requestAdapterInfo === 'function' ? await withTimeout(adapter.requestAdapterInfo()).catch(() => null) : null);
      const summary = info ? { vendor: info.vendor || '', architecture: info.architecture || '' } : null;
      if (adapter.isFallbackAdapter || info?.isFallbackAdapter) return { ok: false, reason: 'software-adapter', adapter: summary };
      const device = await withTimeout(adapter.requestDevice());
      if (!device) return { ok: false, reason: 'no-device', adapter: summary };
      try { device.destroy(); } catch { /* already gone */ }
      return { ok: true, reason: 'available', adapter: summary };
    } catch (e) {
      return { ok: false, reason: 'probe-failed: ' + (e?.message || String(e)), adapter: null };
    }
  })();
  return probePromise;
}

/**
 * The choice, pure: { backend: 'webgpu' | 'webgl2', reason }.
 * `probe` is probeWebGPU()'s result (or null while it is pending).
 */
export function chooseBackend({ tier = 'high', probe = null, override = null, sceneReady = SCENE_WEBGPU_READY, broken = false } = {}) {
  if (override === 'webgl2') return { backend: 'webgl2', reason: 'override' };
  if (broken) return { backend: 'webgl2', reason: 'device-lost-this-session' };
  if (!sceneReady) return { backend: 'webgl2', reason: 'scene-not-ported' };
  if (tier === 'low' && override !== 'webgpu') return { backend: 'webgl2', reason: 'low-tier' };
  if (!probe) return { backend: 'webgl2', reason: 'probe-pending' };
  if (!probe.ok) return { backend: 'webgl2', reason: probe.reason };
  return { backend: 'webgpu', reason: override === 'webgpu' ? 'override' : 'available' };
}

/**
 * Build the WebGL2 renderer (today's only path) and start the probe. `report` is a live
 * object: `backend`/`reason` describe what is drawing, `webgpu` fills in once the probe
 * answers. The same object is mirrored on window.PoEcoBackend for the dev console.
 */
export function createSceneRenderer(THREE, canvas, { lowEnd = false, tier = 'high' } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
  const override = backendOverride();
  const choice = chooseBackend({ tier, override, broken: wasMarkedBroken() });
  const report = { backend: 'webgl2', reason: choice.reason, tier, webgpu: null, blockers: SCENE_WEBGPU_READY ? [] : WEBGPU_BLOCKERS };
  try { globalThis.PoEcoBackend = report; } catch { /* frozen global: the report still rides the renderer */ }
  // While the scene is not ported the probe only informs, so it opens a GPU device only
  // where someone is looking (dev host, ?ecoDebug, ?ecoBackend=webgpu) — not for every player.
  if (!SCENE_WEBGPU_READY && !backendDebug() && override !== 'webgpu') return { renderer, report };
  probeWebGPU().then((probe) => {
    report.webgpu = probe;
    // Would the choice change with the probe in? Only in what it reports: the WebGL2
    // renderer is already drawing, and a backend swap is a renderer rebuild the engine owns.
    const next = chooseBackend({ tier, probe, override, broken: wasMarkedBroken() });
    if (next.backend === 'webgl2') report.reason = next.reason;
    else report.reason = 'webgpu-available-not-wired';
    if (backendDebug()) {
      console.info(`PoEcosystem: rendering with WebGL2 (${report.reason}); WebGPU ${probe.ok ? 'available' : 'unavailable: ' + probe.reason}`, report);
    }
  }, () => { /* probeWebGPU never rejects */ });
  return { renderer, report };
}

/**
 * For the WebGPU renderer once it exists: a lost device (driver reset, GPU process
 * crash) is remembered for the session so the rebuild — and every later one — takes
 * WebGL2 instead of failing the same way again.
 */
export function watchDeviceLost(device, onLost = () => {}) {
  try {
    device?.lost?.then((info) => {
      if (info?.reason === 'destroyed') return;        // our own dispose, not a failure
      markWebGPUBroken(info?.message || info?.reason || 'lost');
      try { onLost(info); } catch { /* the caller's bug must not stop the fallback */ }
    }, () => {});
  } catch { /* no lost promise: nothing to watch */ }
}

export function markWebGPUBroken(reason = 'lost') {
  try { globalThis.sessionStorage?.setItem(BROKEN_KEY, String(reason)); } catch { /* private mode */ }
  probePromise = Promise.resolve({ ok: false, reason: 'device-lost-this-session', adapter: null });
}

function wasMarkedBroken() {
  try { return !!globalThis.sessionStorage?.getItem(BROKEN_KEY); } catch { return false; }
}

function safeSearch() {
  try { return globalThis.location?.search ?? ''; } catch { return ''; }
}

function withTimeout(p) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Tests only: forget the cached probe. */
export function _resetProbe() { probePromise = null; }
