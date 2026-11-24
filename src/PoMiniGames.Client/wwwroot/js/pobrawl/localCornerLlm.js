// pobrawl/localCornerLlm.js — Free Local Small-LLM Corner Coach & Match Recap (#13).
// Uses Chrome Built-in AI (`LanguageModel` / Gemini Nano) when present, with a strict
// 1,200 ms hard timeout and instant fallback to deterministic `corner.js` advice.

const HARD_TIMEOUT_MS = 1200;
let _sessionPromise = null;

async function getLocalLanguageModel() {
  if (typeof globalThis.LanguageModel === 'undefined') return null;
  _sessionPromise ??= (async () => {
    const avail = await globalThis.LanguageModel.availability?.();
    if (avail === 'unavailable') return null;
    return globalThis.LanguageModel.create({
      systemPrompt:
        'You are a terse boxing corner coach. Give ONE punchy 12-word tactical tip based on the round stats. No preamble.',
    });
  })().catch(() => null);
  return _sessionPromise;
}

/**
 * Request a persona-voiced corner tip from the local browser LLM.
 * Resolves to `fallbackLine` immediately if unavailable or slower than 1,200 ms.
 */
export async function generateCornerAdvice(roundStats, fallbackLine) {
  const session = await getLocalLanguageModel();
  if (!session) return fallbackLine;

  const prompt =
    `Round stats: headDmg=${roundStats.headDmg ?? 0}, torsoDmg=${roundStats.torsoDmg ?? 0}, ` +
    `perfectGuards=${roundStats.perfectGuards ?? 0}, grabs=${roundStats.grabs ?? 0}, ` +
    `gassed=${roundStats.gassed ?? 0}. Give one short tip.`;

  let timer = null;
  try {
    const text = await Promise.race([
      session.prompt(prompt),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), HARD_TIMEOUT_MS);
      }),
    ]);
    const cleaned = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 140);
    return cleaned.length > 8 ? cleaned : fallbackLine;
  } catch {
    return fallbackLine;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
