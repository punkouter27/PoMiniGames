// Sand Playground — seeded RNG, gzip/base64 and shader-section helpers
// Split out of sand-playground-engine.js; pure data/helpers, no engine state.

export const dailySeed = () => { const d = new Date(); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };

// Mulberry32 — a small seeded PRNG.
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export async function gzip(bytes, pack) {
    const stream = new Blob([bytes]).stream()
        .pipeThrough(pack ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
export function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
export function fromB64(str) {
    const bin = atob(str), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function parseSections(src) {
    const sections = {};
    const parts = src.split(/\/\/======\s*([A-Z]+)\s*======/g);
    for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1].trim() + '\n';
    return sections;
}
