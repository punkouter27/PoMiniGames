/**
 * Loads the OpenStreetMap footprint layer for the Capitol campus.
 *
 * The data is fetched once at build time by `scripts/pocapitol-campus.mjs` and committed as
 * `wwwroot/data/pocapitol/campus-osm.json`, so the game never calls Overpass at runtime and
 * the service worker precaches the file with the rest of the assets. A missing or malformed
 * file simply means the handcrafted campus ships alone, which is the old behaviour.
 */
const DEFAULT_URL = 'data/pocapitol/campus-osm.json';
const MAX_BUILDINGS = 700;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Keep only well-formed footprint records, so one bad row cannot break the scene build. */
export function sanitizeCampusData(raw) {
    if (!raw || !Array.isArray(raw.buildings)) return null;
    const buildings = [];
    for (const b of raw.buildings) {
        if (buildings.length >= MAX_BUILDINGS) break;
        if (!b || !finite(b.x) || !finite(b.z) || !finite(b.w) || !finite(b.d) || !finite(b.h)) continue;
        if (b.w < 1 || b.d < 1 || b.h <= 0) continue;
        buildings.push({
            x: b.x, z: b.z, w: Math.min(120, b.w), d: Math.min(120, b.d), h: Math.min(30, b.h),
            rot: finite(b.rot) ? b.rot : 0,
            name: typeof b.name === 'string' ? b.name.slice(0, 80) : '',
        });
    }
    if (buildings.length === 0) return null;
    return {
        attribution: typeof raw.attribution === 'string' ? raw.attribution : '© OpenStreetMap contributors (ODbL)',
        generated: typeof raw.generated === 'string' ? raw.generated : '',
        buildings,
    };
}

/**
 * Fetch and validate the footprint layer. Resolves to null rather than throwing: the campus
 * is decoration and must never be the reason a scenario fails to start.
 */
export async function loadCampusData(url = DEFAULT_URL, { timeout = 2500, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
        const response = await fetchImpl(url, { signal: controller?.signal, cache: 'force-cache' });
        if (!response?.ok) return null;
        return sanitizeCampusData(await response.json());
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
