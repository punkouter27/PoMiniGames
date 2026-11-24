// poecosystem/sim/semanticDiplomacy.js — Seasonal Async Tribe Diplomacy Director (#17).
// Summarizes tribal history via Chrome Built-in AI (`LanguageModel`) every in-game season with a
// 3-second hard timeout, emitting a structured doctrine JSON + 1-sentence Almanac chronicle.
// Falls back cleanly to deterministic `scoreTribeDoctrine` (#5) so simulation never pauses.

import { scoreTribeDoctrine } from './curveUtility.js';

const TIMEOUT_MS = 3000;
const VALID_POSTURES = new Set(['fortify', 'raid', 'trade', 'migrate']);

/**
 * Compute next season's strategic doctrine asynchronously.
 * @param {object} tribeSummary { name, foodRunway, borderPressure, betrayalMemory, techAdvantage, rivalName }
 * @param {string|null} currentDoctrine
 * @returns {Promise<{ posture: string, targetTribe: string|null, chronicle: string, source: 'llm'|'heuristic' }>}
 */
export async function computeSeasonalDoctrine(tribeSummary, currentDoctrine = null) {
  const heuristic = scoreTribeDoctrine(tribeSummary, currentDoctrine);
  const fallback = {
    posture: heuristic.actionId ?? 'fortify',
    targetTribe: tribeSummary.rivalName ?? null,
    chronicle: `${tribeSummary.name ?? 'The tribe'} chose to ${heuristic.actionId ?? 'fortify'} for the coming season.`,
    source: 'heuristic',
  };

  if (typeof globalThis.LanguageModel === 'undefined') return fallback;

  let timer = null;
  try {
    const avail = await globalThis.LanguageModel.availability?.();
    if (avail === 'unavailable') return fallback;
    const session = await globalThis.LanguageModel.create({
      systemPrompt:
        'Return compact JSON only: {"posture":"fortify|raid|trade|migrate","chronicle":"one 12-word chronicle sentence"}.',
    });
    const prompt =
      `Tribe=${tribeSummary.name}, foodRunway=${(tribeSummary.foodRunway ?? 0.5).toFixed(2)}, ` +
      `borderPressure=${(tribeSummary.borderPressure ?? 0.3).toFixed(2)}, ` +
      `betrayal=${(tribeSummary.betrayalMemory ?? 0).toFixed(2)}, rival=${tribeSummary.rivalName ?? 'none'}.`;

    const raw = await Promise.race([
      session.prompt(prompt),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
      }),
    ]);
    session.destroy?.();

    const match = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]);
    const posture = VALID_POSTURES.has(parsed.posture) ? parsed.posture : fallback.posture;
    const chronicle = typeof parsed.chronicle === 'string' && parsed.chronicle.length > 6
      ? parsed.chronicle.slice(0, 140)
      : fallback.chronicle;
    return { posture, targetTribe: tribeSummary.rivalName ?? null, chronicle, source: 'llm' };
  } catch {
    return fallback;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
