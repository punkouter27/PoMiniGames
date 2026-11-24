// platform/ai/semanticGrader.js — Free Local Semantic Answer Grader for Quizzes (#19).
// Uses Transformers.js v3 feature-extraction (`Xenova/bge-micro-v2` / `all-MiniLM-L6-v2`, cached
// in Cache Storage) to score cosine similarity of free-text quiz answers locally (<25 ms), with
// instant normalized token + Levenshtein fallback while the embedding pipeline warms up.

const DEFAULT_MODEL = 'Xenova/bge-micro-v2';

let _pipePromise = null;
const _embedCache = new Map();

function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function lexicalSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.88;
  const dist = levenshtein(na, nb);
  return Math.max(0, 1 - dist / Math.max(na.length, nb.length));
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

async function getEmbedder(model = DEFAULT_MODEL) {
  _pipePromise ??= (async () => {
    const tf = await import('transformers');
    if (!tf?.pipeline) return null;
    const device = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
    return tf.pipeline('feature-extraction', model, { device, dtype: 'q8' });
  })().catch(() => null);
  return _pipePromise;
}

async function embedText(text) {
  const key = normalize(text);
  if (_embedCache.has(key)) return _embedCache.get(key);
  const pipe = await getEmbedder();
  if (!pipe) return null;
  try {
    const out = await pipe(key, { pooling: 'mean', normalize: true });
    const vec = Float32Array.from(out.data);
    _embedCache.set(key, vec);
    return vec;
  } catch {
    return null;
  }
}

/** Pre-embed reference answers asynchronously while the user reads the question. */
export function prewarmReferences(references = []) {
  for (let i = 0; i < references.length; i++) {
    embedText(references[i]).catch(() => {});
  }
}

/**
 * Grade a free-text answer against one or more reference answers.
 * @returns {Promise<{ match: boolean, score: number, method: 'embedding'|'lexical' }>}
 */
export async function gradeSemanticAnswer(userAnswer, referenceAnswers, threshold = 0.78) {
  const refs = Array.isArray(referenceAnswers) ? referenceAnswers : [referenceAnswers];
  let bestLex = 0;
  for (let i = 0; i < refs.length; i++) {
    bestLex = Math.max(bestLex, lexicalSimilarity(userAnswer, refs[i]));
  }
  if (bestLex >= 0.9) return { match: true, score: bestLex, method: 'lexical' };

  const userVec = await embedText(userAnswer);
  if (!userVec) {
    return { match: bestLex >= threshold, score: bestLex, method: 'lexical' };
  }

  let bestSem = bestLex;
  for (let i = 0; i < refs.length; i++) {
    const refVec = await embedText(refs[i]);
    if (refVec) bestSem = Math.max(bestSem, cosine(userVec, refVec));
  }
  return { match: bestSem >= threshold, score: bestSem, method: 'embedding' };
}
