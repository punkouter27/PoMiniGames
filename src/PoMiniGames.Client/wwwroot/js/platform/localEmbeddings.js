// platform/localEmbeddings.js — opt-in in-browser semantic text embeddings via Transformers.js.
// Uses Xenova/all-MiniLM-L6-v2 (~23 MB quantized, cached in browser Cache API) so PoCoupleQuiz
// can match semantically equivalent answers ("couch" vs "sofa") completely offline with zero API cost.
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
let _extractorPromise = null;

async function getExtractor(onProgress) {
  _extractorPromise ??= (async () => {
    const { pipeline, env } = await import('transformers');
    env.allowLocalModels = false;
    const webgpu = Boolean(globalThis.navigator?.gpu && await globalThis.navigator.gpu.requestAdapter().catch(() => null));
    return pipeline('feature-extraction', MODEL_ID, {
      device: webgpu ? 'webgpu' : 'wasm',
      dtype: 'q8',
      progress_callback: onProgress,
    });
  })().catch((err) => { _extractorPromise = null; throw err; });
  return _extractorPromise;
}

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Compute semantic similarity (0..1) between two short answers locally in the browser.
 * Returns -1 if the model is unavailable so callers fall back to lexical AnswerMatcher.
 */
export async function semanticSimilarity(textA, textB, onProgress) {
  const a = String(textA ?? '').trim(), b = String(textB ?? '').trim();
  if (!a || !b) return 0;
  try {
    const extractor = await getExtractor(onProgress);
    const [ea, eb] = await Promise.all([
      extractor(a, { pooling: 'mean', normalize: true }),
      extractor(b, { pooling: 'mean', normalize: true }),
    ]);
    return cosineSimilarity(ea.data, eb.data);
  } catch {
    return -1;
  }
}

export async function isSemanticMatch(textA, textB, threshold = 0.72) {
  const score = await semanticSimilarity(textA, textB);
  return score >= threshold;
}

if (typeof window !== 'undefined') {
  window.PoEmbeddings = { semanticSimilarity, isSemanticMatch };
}
