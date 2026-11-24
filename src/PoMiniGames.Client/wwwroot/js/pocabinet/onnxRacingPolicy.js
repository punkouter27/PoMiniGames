// pocabinet/onnxRacingPolicy.js — Batched 10 Hz ONNX Racing-Line & Pace Policy (#16).
// Evaluates [N_cars, 12] -> [N_cars, 2] (steerResidual, throttleResidual) asynchronously in
// ONNX Runtime Web (WebGPU/WASM), linearly interpolating over 100 ms with instant spline fallback.

const DEFAULT_MODEL_URL = '/models/pocabinet/racing-policy-v1.onnx';
const FEATURE_DIM = 12;

export class OnnxRacingPolicy {
  constructor(modelUrl = DEFAULT_MODEL_URL) {
    this.modelUrl = modelUrl;
    this._sessionPromise = null;
    this._inFlight = false;
    this._lastUpdateMs = 0;
    this._prevResiduals = new Map();
    this._nextResiduals = new Map();
  }

  async _session() {
    this._sessionPromise ??= (async () => {
      const res = await fetch(this.modelUrl, { method: 'HEAD' });
      if (!res.ok) return null;
      const ort = globalThis.ort;
      if (!ort?.InferenceSession) return null;
      const providers = (typeof navigator !== 'undefined' && navigator.gpu) ? ['webgpu', 'wasm'] : ['wasm'];
      return ort.InferenceSession.create(this.modelUrl, { executionProviders: providers });
    })().catch(() => null);
    return this._sessionPromise;
  }

  /**
   * 10 Hz async batched inference across all AI cars. Non-blocking: drops overlapping calls.
   * @param {Array<{ id: number|string, features: number[]|Float32Array }>} cars
   */
  scheduleBatch(cars) {
    const now = performance.now();
    if (this._inFlight || cars.length === 0 || now - this._lastUpdateMs < 95) return;
    this._inFlight = true;
    this._runBatch(cars)
      .then(() => {
        this._lastUpdateMs = performance.now();
      })
      .finally(() => {
        this._inFlight = false;
      });
  }

  async _runBatch(cars) {
    const session = await this._session();
    if (!session) return;
    const n = cars.length;
    const flat = new Float32Array(n * FEATURE_DIM);
    for (let i = 0; i < n; i++) {
      const f = cars[i].features;
      for (let j = 0; j < FEATURE_DIM; j++) flat[i * FEATURE_DIM + j] = f[j] ?? 0;
    }
    try {
      const ort = globalThis.ort;
      const tensor = new ort.Tensor('float32', flat, [n, FEATURE_DIM]);
      const out = await session.run({ [session.inputNames[0]]: tensor });
      const data = out[session.outputNames[0]].data;
      for (let i = 0; i < n; i++) {
        const id = cars[i].id;
        const prev = this._nextResiduals.get(id) ?? { steer: 0, throttle: 0 };
        this._prevResiduals.set(id, prev);
        this._nextResiduals.set(id, {
          steer: Math.max(-0.35, Math.min(0.35, data[i * 2] ?? 0)),
          throttle: Math.max(-0.25, Math.min(0.25, data[i * 2 + 1] ?? 0)),
        });
      }
    } catch {
      // Fallback to pure spline controller
    }
  }

  /** 60 Hz interpolated residual lookup (returns { steer: 0, throttle: 0 } when no model loaded). */
  sampleResidual(carId) {
    const next = this._nextResiduals.get(carId);
    if (!next) return { steer: 0, throttle: 0 };
    const prev = this._prevResiduals.get(carId) ?? next;
    const t = Math.max(0, Math.min(1, (performance.now() - this._lastUpdateMs) / 100));
    return {
      steer: prev.steer + (next.steer - prev.steer) * t,
      throttle: prev.throttle + (next.throttle - prev.throttle) * t,
    };
  }
}
