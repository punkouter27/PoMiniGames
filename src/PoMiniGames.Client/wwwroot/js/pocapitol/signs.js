/**
 * Loads the short texts printed on the boards protesters carry.
 *
 * The list lives in `wwwroot/data/pocapitol/placards.json`, so signage is data, not code, and
 * the JSON is precached with the rest of the assets. The shipped phrases are short historical
 * signage photographed that day, one to six words each; the scenario around them is fiction and
 * the in-game notice says so. A missing or malformed file simply means the two flags carry on alone.
 */
const DEFAULT_URL = 'data/pocapitol/placards.json';
const MAX_TEXTS = 24;
const MAX_LENGTH = 40;
/** A board has room for a few words; anything longer would not read as a carried sign. */
export const MAX_WORDS = 6;

/** Keep only short, unique, printable phrases; a bad row must never break the scene build. */
export function sanitizeSigns(raw) {
    const list = Array.isArray(raw) ? raw : raw?.placards;
    if (!Array.isArray(list)) return [];
    const seen = new Set(), texts = [];
    for (const entry of list) {
        const text = typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : '';
        if (!text || text.length > MAX_LENGTH) continue;
        if (text.split(' ').length > MAX_WORDS) continue;
        const key = text.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key); texts.push(key);
        if (texts.length >= MAX_TEXTS) break;
    }
    return texts;
}

/** Resolves to [] rather than throwing: signage is decoration. */
export async function loadSigns(url = DEFAULT_URL, { timeout = 2000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') return [];
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
        const response = await fetchImpl(url, { signal: controller?.signal, cache: 'force-cache' });
        if (!response?.ok) return [];
        return sanitizeSigns(await response.json());
    } catch {
        return [];
    } finally {
        if (timer) clearTimeout(timer);
    }
}
