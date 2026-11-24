// pobrawl/onnxPredictor.js — lightweight ONNX Runtime Web neural intent predictor for PoBrawl.
// Evaluates a compact (8 -> 16 -> 6) action-intent policy over fight state features on Hard / top
// ladder rungs, falling back seamlessly to predictor.js's n-gram table when no ONNX weights or
// runtime session are loaded.
const ACTIONS = ['jab', 'cross', 'kick', 'grab', 'guard', 'taunt'];
const DEFAULT_MODEL_URL = '/models/pobrawl/intent-v1.onnx';

let _sessionPromise = null;

async function loadSession(url = DEFAULT_MODEL_URL) {
  _sessionPromise ??= (async () => {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return null;
    const tf = await import('transformers');
    const ort = tf.onnxruntime || globalThis.ort;
    if (!ort?.InferenceSession) return null;
    return ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
  })().catch(() => null);
  return _sessionPromise;
}

/**
 * Extract 8 normalized fight features for intent classification.
 * @param {object} ctx
 */
export function extractIntentFeatures(ctx) {
  return new Float32Array([
    Math.min(1, (ctx.distance ?? 2) / 5),
    ctx.selfHp ?? 1,
    ctx.opponentHp ?? 1,
    ctx.opponentEnergy ?? 1,
    ctx.opponentState === 'block' ? 1 : 0,
    ctx.opponentRecover ? 1 : 0,
    Math.min(1, (ctx.backRoom ?? 3) / 5),
    Math.min(1, (ctx.clock ?? 0) / Math.max(1, ctx.timeLimit ?? 60)),
  ]);
}

/**
 * Predict the opponent's next action distribution. Returns null when ONNX weights are not present
 * so tactics.js uses its deterministic n-gram predictor.
 */
export async function predictIntentOnnx(ctx, modelUrl = DEFAULT_MODEL_URL) {
  const session = await loadSession(modelUrl);
  if (!session) return null;
  try {
    const ort = globalThis.ort;
    const input = new ort.Tensor('float32', extractIntentFeatures(ctx), [1, 8]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const logits = out[session.outputNames[0]].data;
    // Softmax
    let maxL = -Infinity;
    for (let i = 0; i < ACTIONS.length; i++) if (logits[i] > maxL) maxL = logits[i];
    const probs = {};
    let sum = 0;
    for (let i = 0; i < ACTIONS.length; i++) sum += Math.exp(logits[i] - maxL);
    for (let i = 0; i < ACTIONS.length; i++) probs[ACTIONS[i]] = Math.exp(logits[i] - maxL) / (sum || 1);
    return probs;
  } catch {
    return null;
  }
}
