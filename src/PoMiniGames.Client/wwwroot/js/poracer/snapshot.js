/** Numbers per car in a pushed snapshot: x, y, heading, speed, boost, skid, damage, sand, position, lap, finished, tow, drift, boost seconds left, slip, tyre heat, draft. PoRacerPage.razor.cs Stride packs the same seventeen. */
export const STRIDE = 17;

/** Keep numeric decoding in native JS; WASM only needs the four visible HUD rows. */
export function prepareSnapshot(snapshot, roster, localIdx) {
    const cars = snapshot.cars;
    if (!Array.isArray(cars) || cars.length !== roster.length || !cars.length) {
        throw new Error('PoRacer snapshot does not match the roster.');
    }
    const flat = new Float64Array(cars.length * STRIDE);
    for (let i = 0; i < cars.length; i++) {
        const c = cars[i], o = i * STRIDE;
        if (c.id !== roster[i].id) throw new Error('PoRacer snapshot car order changed.');
        flat[o] = c.x; flat[o + 1] = c.y; flat[o + 2] = c.heading; flat[o + 3] = c.speed;
        flat[o + 4] = c.boostGlow; flat[o + 5] = c.skidIntensity; flat[o + 6] = c.damage;
        flat[o + 7] = c.surface === 'sand' ? 1 : 0;
        flat[o + 8] = c.position; flat[o + 9] = c.lap; flat[o + 10] = c.finished ? 1 : 0;
        flat[o + 11] = c.drafting ? 1 : 0; flat[o + 12] = c.drift; flat[o + 13] = c.boostTimer;
        flat[o + 14] = c.slip; flat[o + 15] = c.tireHeat; flat[o + 16] = c.draft;
    }
    const me = localIdx >= 0 ? cars[localIdx] : null;
    const mine = me?.position ?? 2;
    const want = new Set([1, mine - 1, mine, mine + 1]);
    const target = Math.min(4, cars.length);
    const validCount = () => [...want].filter(p => p >= 1 && p <= cars.length).length;
    for (let reach = 2; validCount() < target; reach++) {
        want.add(mine + reach);
        want.add(mine - reach);
    }
    const rows = cars.filter(c => want.has(c.position)).sort((a, b) => a.position - b.position).slice(0, 4);
    return {
        flat,
        lapNow: me?.currentLapSeconds ?? 0,
        running: snapshot.started && !snapshot.paused && !snapshot.finished,
        hud: { ...snapshot, cars: rows },
    };
}
