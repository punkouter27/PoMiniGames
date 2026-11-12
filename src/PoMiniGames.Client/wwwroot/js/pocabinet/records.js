// pocabinet/records.js
//
// Per-track records (personal bests) for PoCabinet, in localStorage under
// pominigames:pocabinet-records-v1: { [trackId]: { bestLap: number, sectors: [s1,s2,s3] } }.
// The page's start card reads the same store (PoCabinetPitWall.ParseBestLaps).
// Player settings are not here: Blazor owns that store (PoCabinetUiSettings) and
// hands the engine plain values.

const RECORDS_KEY = 'pominigames:pocabinet-records-v1';

function readRecords() {
    try {
        const raw = window.localStorage.getItem(RECORDS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch { /* fall through to empty */ }
    return {};
}

function writeRecords(records) {
    try {
        window.localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    } catch { /* best-effort */ }
}

/** Read one track's records. Returns { bestLap: -1, sectors: [-1,-1,-1] } when unset. */
export function getRecords(trackId) {
    const all = readRecords();
    const rec = all[trackId];
    if (!rec || typeof rec !== 'object') return { bestLap: -1, sectors: [-1, -1, -1] };
    const sectors = Array.isArray(rec.sectors)
        ? [0, 1, 2].map(i => (Number.isFinite(Number(rec.sectors[i])) ? Number(rec.sectors[i]) : -1))
        : [-1, -1, -1];
    const bestLap = Number.isFinite(Number(rec.bestLap)) ? Number(rec.bestLap) : -1;
    return { bestLap, sectors };
}

/**
 * Record a finished race for a track. Returns
 * { isPb, previousBest } where previousBest is -1 when there was no prior lap.
 * A missing/non-positive lap still persists sector splits but never counts as a PB.
 */
export function recordTrackResult(trackId, bestLapSeconds, sectors) {
    const all = readRecords();
    const rec = (all[trackId] && typeof all[trackId] === 'object') ? all[trackId] : {};
    const previousBest = Number.isFinite(Number(rec.bestLap)) ? Number(rec.bestLap) : -1;

    const lap = Number(bestLapSeconds);
    let isPb = false;
    if (Number.isFinite(lap) && lap > 0 && (previousBest < 0 || lap < previousBest)) {
        rec.bestLap = lap;
        isPb = true;
    }

    if (Array.isArray(sectors)) {
        const stored = Array.isArray(rec.sectors) ? rec.sectors.slice(0, 3) : [];
        for (let i = 0; i < 3; i++) {
            const t = Number(sectors[i]);
            if (Number.isFinite(t) && t > 0) {
                const cur = Number(stored[i]);
                if (!Number.isFinite(cur) || cur <= 0 || t < cur) stored[i] = t;
            }
        }
        rec.sectors = stored;
    }

    all[trackId] = rec;
    writeRecords(all);
    return { isPb, previousBest };
}
