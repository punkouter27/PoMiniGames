// pocabinet/util.js
//
// Small helpers the render and audio modules share: the sim → world scale, clamps, the
// integer and string hashes and the LCG every procedural generator seeds from, tileable
// value-noise textures, canvas textures, shader-hook chaining, the road's plane height and
// the share-or-download fallback.
//
// Render and audio only. physics.js and track.js keep their own arithmetic: they must stay
// bit-identical with the C# replay that verifies lap proofs.

import * as THREE from './three.js';
import * as TSL from 'three-eco/tsl';

/** Sim units per world (three.js) unit: sim (x, y) → world (x / 10, h, y / 10). */
export const WORLD_SCALE = 10;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ── Hashes and seeded generators ────────────────────────────────────────────

/** Integer lattice hash → [0, 1). */
export function hash(x, y, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** FNV-1a over a string's UTF-16 code units, as an unsigned 32-bit integer. */
export function fnv1a(text) {
    const s = String(text);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

/** Numerical Recipes LCG from `seed`: a function returning [0, 1). */
export function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ── Procedural textures ─────────────────────────────────────────────────────

/** size × size value-noise fbm in [0, 1], periodic so it tiles; `base` = cells across the lowest octave. */
export function fbm(size, base, octaves, seed) {
    const out = new Float32Array(size * size);
    let amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) {
        const cells = base << o;
        for (let y = 0; y < size; y++) {
            const fy = y / size * cells, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < size; x++) {
                const fx = x / size * cells, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
                const a = hash(x0 % cells, y0 % cells, seed + o), b = hash((x0 + 1) % cells, y0 % cells, seed + o);
                const c = hash(x0 % cells, (y0 + 1) % cells, seed + o), d = hash((x0 + 1) % cells, (y0 + 1) % cells, seed + o);
                out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
            }
        }
        total += amp;
        amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

/** A repeating, mipmapped RGBA DataTexture from `data` (size × size). */
export function dataTexture(data, size, srgb) {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
}

/** Tangent-space normal map (RGBA bytes) from a periodic size × size height field. */
export function normalMap(h, size, strength) {
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const l = h[y * size + (x - 1 + size) % size], r = h[y * size + (x + 1) % size];
            const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
            const nx = (l - r) * strength, ny = (u - d) * strength;
            const len = Math.hypot(nx, ny, 1);
            const i = (y * size + x) * 4;
            out[i] = (nx / len * 0.5 + 0.5) * 255;
            out[i + 1] = (ny / len * 0.5 + 0.5) * 255;
            out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
            out[i + 3] = 255;
        }
    }
    return out;
}

/**
 * A CanvasTexture drawn by `draw(ctx2d, w, h)`. `repeat`: true wraps both ways, 's' only
 * along u. Colour textures are sRGB; pass srgb: false for masks and alpha.
 */
export function canvasTexture(w, h, draw, { srgb = true, repeat = false, anisotropy = 1 } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = THREE.RepeatWrapping;
    if (repeat === true) t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    return t;
}

// ── Shader hooks (TSL) ───────────────────────────────────────────────────────

/**
 * Chain a TSL node hook onto a node material. The r165 version patched GLSL chunks in
 * onBeforeCompile; the r186 WebGPURenderer has no chunks, a material carries nodes instead
 * (colorNode, roughnessNode, positionNode, normalNode, emissiveNode, outputNode).
 *
 * `build()` is called ONCE per `key` (the key must name every parameter that changes the graph)
 * and returns { color, rough, position, normal, emissive, output }: each an optional function
 * (previousNode) => nextNode. A hook's per-instance values are not closed over: they are
 * uniform nodes created inside build() and shared (clock, weather) or userData nodes. The
 * chain of keys on a material is folded into one set of nodes, cached by the joined key, so
 * every material with the same hooks shares ONE node graph and ONE compiled program (a
 * graph per instance made every instance compile its own, the PoBrawl lesson).
 */
const HOOK_SPEC = new Map();      // key -> spec
const CHAIN = new WeakMap();      // material -> [key]
const FOLDED = new Map();         // joined keys -> { colorNode, ... }
const CHANNELS = [
    ['color', 'colorNode', () => TSL.materialColor],
    ['rough', 'roughnessNode', () => TSL.materialRoughness],
    ['position', 'positionNode', () => TSL.positionLocal],
    ['normal', 'normalNode', () => TSL.materialNormal],
    ['emissive', 'emissiveNode', () => TSL.materialEmissive],
    ['metal', 'metalnessNode', () => TSL.materialMetalness],
    ['clearcoat', 'clearcoatNode', () => TSL.materialClearcoat],
    ['clearcoatRough', 'clearcoatRoughnessNode', () => TSL.materialClearcoatRoughness],
    ['output', 'outputNode', () => TSL.output],
];
export function addHook(material, key, build) {
    if (!HOOK_SPEC.has(key)) HOOK_SPEC.set(key, build());
    let chain = CHAIN.get(material);
    if (!chain) CHAIN.set(material, chain = []);
    chain.push(key);
    const joined = chain.join('|');
    let nodes = FOLDED.get(joined);
    if (!nodes) {
        nodes = {};
        for (const [ch, prop, base] of CHANNELS) {
            const fns = chain.map(k => HOOK_SPEC.get(k)[ch]).filter(Boolean);
            if (fns.length) nodes[prop] = fns.reduce((n, fn) => fn(n), base());
        }
        FOLDED.set(joined, nodes);
    }
    for (const [prop, node] of Object.entries(nodes)) material[prop] = node;
    material.needsUpdate = true;
    return material;
}

// ── Track ───────────────────────────────────────────────────────────────────

/** Road plane height (sim units) at sample `i`, `lat` sim units right of the centerline (track.z tilted by track.bank). */
export function roadPlane(track, i, lat) {
    return (track.z ? track.z[i] : 0) + (track.bank ? track.bank[i] * lat : 0);
}
