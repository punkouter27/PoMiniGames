// backend.js — which GPU API draws the island, and what happens when it goes away.
//
// The scene is node materials (TSL) end to end, so ONE renderer draws it on either API:
// three's WebGPURenderer runs WebGPU where the browser has it and its own WebGL2 backend
// where it does not (no navigator.gpu, no adapter, a device that will not open). There is
// no second code path to choose between — only which backend that one renderer starts on.
//
// THE CHOICE (pure, so it is testable without a GPU)
//   ?ecoBackend=webgl2            → WebGL2 (forceWebGL), for comparing the two
//   a device lost this session    → WebGL2 for the rest of the session (sessionStorage)
//   no navigator.gpu              → WebGL2, said up front rather than via three's warning
//   otherwise (every tier)        → WebGPU, and three falls back to WebGL2 by itself if the
//                                   adapter or device will not open. The low tier is cheap
//                                   because of what it draws, not the API it draws with.
//
// DEVICE LOSS: createSceneRenderer's `onLost` fires once when the device (WebGPU) or the
// context (WebGL2) is lost. A lost WebGPU device is remembered for the session first, so
// the rebuild the engine does next — and every later one — starts on WebGL2 instead of
// failing the same way again.
//
// On a dev host (or with ?ecoDebug) one console line says which backend is drawing and
// why; the same report is mirrored on window.PoEcoBackend.
import { WebGPURenderer } from 'three-eco/webgpu';

const BROKEN_KEY = 'poeco.webgpuBroken';

/** The ?ecoBackend=webgl2|webgpu override, or null. `webgpu` also ignores a past device loss. */
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
 * The choice, pure: { forceWebGL, reason }. `hasGpu` is whether navigator.gpu exists at all
 * (without it WebGPURenderer would only warn and fall back, so it is cleaner to ask for
 * WebGL2 up front and say why).
 */
export function chooseBackend({ override = null, broken = false, hasGpu = true } = {}) {
  if (override === 'webgl2') return { forceWebGL: true, reason: 'override' };
  if (broken && override !== 'webgpu') return { forceWebGL: true, reason: 'device-lost-this-session' };
  if (!hasGpu) return { forceWebGL: true, reason: 'no-navigator-gpu' };
  return { forceWebGL: false, reason: override === 'webgpu' ? 'override' : 'auto' };
}

/**
 * Build the scene renderer and start `renderer.init()`. Returns { renderer, report, ready }
 * at once — the renderer can be sized and a scene built against it straight away; only
 * drawing has to wait for `ready`, which resolves to the report once init has settled.
 * `report.backend` is what actually came up ('webgpu' or 'webgl2'; a WebGPU request that
 * fell back says 'webgl2' with reason 'fallback'). `onLost(info)` is called at most once,
 * on device or context loss, and never after `report.disposed` is set.
 */
export function createSceneRenderer(canvas, { lowEnd = false, tier = 'high', onLost = () => {} } = {}) {
  const override = backendOverride();
  const choice = chooseBackend({ override, broken: wasMarkedBroken(), hasGpu: !!globalThis.navigator?.gpu });
  const renderer = new WebGPURenderer({
    canvas,
    antialias: !lowEnd,
    powerPreference: 'high-performance',
    forceWebGL: choice.forceWebGL,
  });
  const report = { backend: 'pending', reason: choice.reason, tier, adapter: null, disposed: false };
  try { globalThis.PoEcoBackend = report; } catch { /* frozen global: the report still rides the renderer */ }

  let lost = false;
  renderer.onDeviceLost = (info) => {
    // Our own dispose loses the WebGL context on purpose (WebGLBackend.dispose): not a failure.
    if (lost || report.disposed) return;
    lost = true;
    if (info?.api === 'WebGPU') markWebGPUBroken(info.message || info.reason || 'lost');
    report.lost = info?.message || 'lost';
    try { onLost(info); } catch { /* the caller's bug must not stop the fallback */ }
  };

  const ready = renderer.init().then(() => {
    shareInstancePrograms(renderer);
    const gpu = !!renderer.backend?.isWebGPUBackend;
    report.backend = gpu ? 'webgpu' : 'webgl2';
    if (!gpu && !choice.forceWebGL) report.reason = 'fallback';
    if (gpu) {
      const info = renderer.backend.device?.adapterInfo ?? null;
      report.adapter = info ? { vendor: info.vendor || '', architecture: info.architecture || '' } : null;
      report.compatibility = !!renderer.backend.compatibilityMode;
    }
    if (backendDebug()) console.info(`PoEcosystem: rendering with ${gpu ? 'WebGPU' : 'WebGL2'} (${report.reason})`, report);
    return report;
  }, (err) => {
    // Neither backend would open: nothing can draw. Reported, never thrown at the engine.
    report.backend = 'none';
    report.reason = 'init-failed: ' + (err?.message || String(err));
    console.error('PoEcosystem: no GPU backend could start', err);
    return report;
  });
  return { renderer, report, ready };
}

/**
 * One program per material, not one per instanced mesh. Under the uniform-buffer limit,
 * three's node InstancedMesh reads its matrices from a uniform array named after that
 * mesh's own buffer node, so every one of the island's ~120 instanced meshes compiles its
 * own vertex program: ~170 programs, and on the WebGL2 backend (ANGLE) many seconds of
 * main-thread compile on the first frame. With the limit at 0 every mesh takes the
 * instanced-attribute path WebGLRenderer always used: identical source, compiled once and
 * shared. Instance matrices change every frame either way, so nothing is lost.
 */
function shareInstancePrograms(renderer) {
  const caps = renderer.backend?.capabilities;
  if (caps && typeof caps.getUniformBufferLimit === 'function') caps.getUniformBufferLimit = () => 0;
}

export function markWebGPUBroken(reason = 'lost') {
  try { globalThis.sessionStorage?.setItem(BROKEN_KEY, String(reason)); } catch { /* private mode */ }
}

function wasMarkedBroken() {
  try { return !!globalThis.sessionStorage?.getItem(BROKEN_KEY); } catch { return false; }
}

function safeSearch() {
  try { return globalThis.location?.search ?? ''; } catch { return ''; }
}
