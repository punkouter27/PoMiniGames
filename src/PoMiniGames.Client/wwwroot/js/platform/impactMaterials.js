// impactMaterials.js — the one material table every impact reads.
//
// A collision used to answer three questions in three places: what does it LOOK
// like (debris colour, decal), how does it MOVE (bounce, how far chunks fly) and
// what does it SOUND like (pitch, ring, noise). Each engine kept its own guesses,
// so a steel crate in Voxel Strike rang like wood in PoCabinet. This table is the
// single answer, keyed by a material tag, read by:
//
//   • damage signatures (graphics #3) — decal kind, particle palette, heat/dust/wet
//   • directed debris  (physics  #10) — density, restitution, chunk spread
//   • impact synthesis (audio    #13) — modal frequencies, decay, noise colour
//
// Pure data + pure functions: no DOM, no WebAudio, no three.js, so node tests and
// every engine import it without dragging anything else along.

/**
 * @typedef {Object} ImpactMaterial
 * @property {number} density       kg/m³-ish, relative — debris mass per volume
 * @property {number} hardness      0..1 — how sharp the transient is
 * @property {number} restitution   0..1 — bounce
 * @property {string} decal         decal kind: dent|scorch|crack|chip|splash|scuff|none
 * @property {number[]} palette     0xRRGGBB particle colours, dominant first
 * @property {{dust:number, sparks:number, wet:number, heat:number}} fx  0..1 weights
 * @property {{modes:number[], decay:number, noise:'white'|'pink'|'brown', ring:number, size:number}} audio
 *           modes are frequency ratios × base pitch; decay seconds at full impulse;
 *           ring 0..1 how long the resonators sustain vs. the noise burst;
 *           size = the bounding radius in metres of the "typical" object of this material
 *           (impactSynth scales mode pitch by typical/actual, so a thrown pebble pings and a
 *           boulder booms on the same table row)
 */

/** @type {Readonly<Record<string, Readonly<ImpactMaterial>>>} */
export const MATERIALS = Object.freeze({
    metal: Object.freeze({
        density: 7.8, hardness: 0.95, restitution: 0.35, decal: 'dent',
        palette: [0xffd27a, 0xfff2c4, 0x9aa4ad],
        fx: Object.freeze({ dust: 0.1, sparks: 1, wet: 0, heat: 0.6 }),
        audio: Object.freeze({ size: 0.4, modes: [1, 2.76, 5.4, 8.93], decay: 0.9, noise: 'white', ring: 0.85 }),
    }),
    wood: Object.freeze({
        density: 0.7, hardness: 0.55, restitution: 0.3, decal: 'chip',
        palette: [0x8a5a2b, 0xc89b63, 0x5b3a1a],
        fx: Object.freeze({ dust: 0.5, sparks: 0, wet: 0, heat: 0 }),
        audio: Object.freeze({ size: 0.5, modes: [1, 2.3, 3.9], decay: 0.22, noise: 'pink', ring: 0.35 }),
    }),
    stone: Object.freeze({
        density: 2.6, hardness: 0.85, restitution: 0.15, decal: 'crack',
        palette: [0x8d8a84, 0xb9b4aa, 0x5d5a55],
        fx: Object.freeze({ dust: 0.9, sparks: 0.15, wet: 0, heat: 0 }),
        audio: Object.freeze({ size: 0.6, modes: [1, 1.9, 3.1], decay: 0.15, noise: 'brown', ring: 0.15 }),
    }),
    glass: Object.freeze({
        density: 2.5, hardness: 1, restitution: 0.2, decal: 'crack',
        palette: [0xd8f4ff, 0xffffff, 0x9ad7f0],
        fx: Object.freeze({ dust: 0, sparks: 0.3, wet: 0, heat: 0 }),
        audio: Object.freeze({ size: 0.15, modes: [1, 2.32, 4.25, 6.63, 9.38], decay: 0.6, noise: 'white', ring: 0.7 }),
    }),
    rubber: Object.freeze({
        density: 1.1, hardness: 0.2, restitution: 0.8, decal: 'scuff',
        palette: [0x2b2b2b, 0x555555],
        fx: Object.freeze({ dust: 0.2, sparks: 0, wet: 0, heat: 0.2 }),
        audio: Object.freeze({ size: 0.3, modes: [1, 1.5], decay: 0.12, noise: 'brown', ring: 0.1 }),
    }),
    paint: Object.freeze({   // painted car body panels
        density: 7.8, hardness: 0.8, restitution: 0.3, decal: 'dent',
        palette: [0xff5a4e, 0xffffff, 0x9aa4ad],
        fx: Object.freeze({ dust: 0.05, sparks: 0.7, wet: 0, heat: 0.4 }),
        audio: Object.freeze({ size: 1.5, modes: [1, 2.1, 3.6], decay: 0.45, noise: 'white', ring: 0.5 }),
    }),
    flesh: Object.freeze({   // cartoon fighters — a thud, never gore
        density: 1, hardness: 0.3, restitution: 0.1, decal: 'none',
        palette: [0xffffff, 0xffe9a8],
        fx: Object.freeze({ dust: 0.15, sparks: 0, wet: 0, heat: 0 }),
        audio: Object.freeze({ size: 0.5, modes: [1, 1.7], decay: 0.1, noise: 'brown', ring: 0.05 }),
    }),
    dirt: Object.freeze({
        density: 1.5, hardness: 0.1, restitution: 0.05, decal: 'scuff',
        palette: [0x7a5c3a, 0xa3825a, 0x4d3a24],
        fx: Object.freeze({ dust: 1, sparks: 0, wet: 0, heat: 0 }),
        audio: Object.freeze({ size: 0.5, modes: [1], decay: 0.08, noise: 'brown', ring: 0 }),
    }),
    water: Object.freeze({
        density: 1, hardness: 0, restitution: 0, decal: 'splash',
        palette: [0xbfe6ff, 0xffffff, 0x5aa9e6],
        fx: Object.freeze({ dust: 0, sparks: 0, wet: 1, heat: 0 }),
        audio: Object.freeze({ size: 0.5, modes: [1, 1.33], decay: 0.25, noise: 'pink', ring: 0.05 }),
    }),
});

export const DEFAULT_MATERIAL = 'stone';

/** @param {string} [tag] @returns {Readonly<ImpactMaterial>} */
export function material(tag) {
    return MATERIALS[tag] || MATERIALS[DEFAULT_MATERIAL];
}

/**
 * Normalise an impulse (N·s, or any engine's equivalent) to 0..1 energy on a soft
 * knee so a graze and a head-on both read, and nothing clips past 1.
 * @param {number} impulse
 * @param {number} [full=20] impulse that counts as a "full" hit for this engine
 */
export function impulseEnergy(impulse, full = 20) {
    const x = Math.max(0, Number(impulse) || 0) / Math.max(1e-6, full);
    return 1 - Math.exp(-x * 1.6);
}

/**
 * Everything one hit should produce, in engine-neutral units. Engines map the
 * fields onto their own particles/decals/voices; nothing here allocates per frame
 * except the returned object (call once per impact, not per particle).
 *
 * @param {string} tag material tag
 * @param {number} impulse raw impulse
 * @param {{full?:number}} [opts]
 */
export function signature(tag, impulse, opts = {}) {
    const m = material(tag);
    const e = impulseEnergy(impulse, opts.full);
    return {
        material: MATERIALS[tag] ? tag : DEFAULT_MATERIAL,
        energy: e,
        decal: e < 0.12 ? 'none' : m.decal,
        decalSize: 0.25 + e * 0.9,
        particles: {
            count: Math.round(4 + e * 28 * (0.4 + m.fx.dust * 0.6 + m.fx.sparks * 0.4)),
            palette: m.palette,
            dust: m.fx.dust * e,
            sparks: m.fx.sparks * e,
            wet: m.fx.wet * e,
            heat: m.fx.heat * e,
        },
        audio: {
            gain: 0.15 + e * 0.85,
            decay: m.audio.decay * (0.5 + e * 0.5),
            // Harder hits ring a touch higher — a quick stand-in for stiffness.
            pitchScale: 1 + (e - 0.5) * 0.12,
            modes: m.audio.modes,
            noise: m.audio.noise,
            ring: m.audio.ring,
            hardness: m.hardness,
            size: m.audio.size,
        },
    };
}

if (typeof window !== 'undefined') {
    window.PoImpactMaterials = { MATERIALS, material, impulseEnergy, signature };
}
