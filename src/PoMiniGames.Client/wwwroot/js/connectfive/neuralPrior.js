// connectfive/neuralPrior.js — Free Local ONNX Policy/Value Prior Bridge for ConnectFive MCTS (#15).
// Runs a tiny quantized CNN in ONNX Runtime Web (WebGPU/WASM) asynchronously, caching results by
// board key. Synchronous lookups return null on cache miss so GridMcts never stalls.

const DEFAULT_MODEL_URL = '/models/connectfive/prior-v1.onnx';
const MAX_CACHE = 512;

let _sessionPromise = null;
const _cache = new Map();
let _inFlight = false;

async function getSession(url = DEFAULT_MODEL_URL) {
  _sessionPromise ??= (async () => {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const ort = globalThis.ort;
    if (!ort?.InferenceSession) return null;
    const providers = (typeof navigator !== 'undefined' && navigator.gpu) ? ['webgpu', 'wasm'] : ['wasm'];
    return ort.InferenceSession.create(url, { executionProviders: providers });
  })().catch(() => null);
  return _sessionPromise;
}

/**
 * Non-blocking cached lookup for Blazor JS interop. Schedules background inference on miss.
 * @param {string} boardKey unique board hash
 * @param {Float32Array|number[]} planes flat [2 * rows * cols] tensor
 * @param {number} rows
 * @param {number} cols
 * @returns {{ priors: number[], value: number } | null}
 */
export function pollBoardPrior(boardKey, planes, rows, cols, modelUrl = DEFAULT_MODEL_URL) {
  const hit = _cache.get(boardKey);
  if (hit) return hit;
  if (!_inFlight) {
    _inFlight = true;
    evaluateBoardPriorAsync(boardKey, planes, rows, cols, modelUrl).finally(() => {
      _inFlight = false;
    });
  }
  return null;
}

export async function evaluateBoardPriorAsync(boardKey, planes, rows, cols, modelUrl = DEFAULT_MODEL_URL) {
  const session = await getSession(modelUrl);
  if (!session) return null;
  try {
    const ort = globalThis.ort;
    const input = new ort.Tensor('float32', Float32Array.from(planes), [1, 2, rows, cols]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const policyLogits = out[session.outputNames[0]].data;
    const valueOut = out[session.outputNames[1]]?.data?.[0] ?? 0.5;
    // Softmax over legal board cells
    let maxL = -Infinity;
    for (let i = 0; i < policyLogits.length; i++) if (policyLogits[i] > maxL) maxL = policyLogits[i];
    const priors = new Array(policyLogits.length);
    let sum = 0;
    for (let i = 0; i < policyLogits.length; i++) {
      priors[i] = Math.exp(policyLogits[i] - maxL);
      sum += priors[i];
    }
    for (let i = 0; i < priors.length; i++) priors[i] /= sum || 1;
    const result = { priors, value: Math.max(0, Math.min(1, 0.5 * (valueOut + 1))) };
    if (_cache.size >= MAX_CACHE) {
      const oldest = _cache.keys().next().value;
      _cache.delete(oldest);
    }
    _cache.set(boardKey, result);
    return result;
  } catch {
    return null;
  }
}
