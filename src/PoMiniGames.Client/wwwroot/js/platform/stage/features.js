// features.js — "write a feature once, every game gets it".
//
// A feature is a plain definition:
//
//   defineFeature({
//     id: 'shake',
//     kind: 'any' | '2d' | '3d',   // which stages it attaches to
//     default: true,               // on for every matching stage unless the game excludes it
//     order: 0,                    // lower runs first
//     create(stage) {              // one instance per stage; return any of these hooks:
//       return {
//         update(dt) {},           // after the game's step
//         beforeRender(ctxOrNull) {},  // just before the game draws (2D: ctx is already scaled)
//         afterRender(ctxOrNull) {},   // just after (2D: overlay drawing)
//         resize(view) {}, pause() {}, resume() {}, tier(tier) {}, dispose() {},
//       };
//     },
//   });
//
// registerFeature() puts it in the global registry; createStage() installs every registered
// default feature whose kind matches, plus `use`, minus `exclude`. A new effect is therefore
// one file plus one import in features/index.js — no game is edited.

const KINDS = new Set(['any', '2d', '3d']);
const registry = new Map();

export function defineFeature(def) {
    if (!def || typeof def.id !== 'string' || !def.id) throw new Error('feature needs an id');
    if (typeof def.create !== 'function') throw new Error(`feature ${def.id} needs create(stage)`);
    const kind = def.kind ?? 'any';
    if (!KINDS.has(kind)) throw new Error(`feature ${def.id}: kind must be any, 2d or 3d`);
    return Object.freeze({ ...def, kind, default: def.default !== false, order: def.order ?? 0 });
}

export function registerFeature(def) {
    const d = defineFeature(def);
    registry.set(d.id, d);
    return d;
}

export function unregisterFeature(id) { registry.delete(id); }

export function listFeatures() { return [...registry.values()]; }

/**
 * The definitions a stage of `kind` gets.
 * @param {'2d'|'3d'} kind
 * @param {{use?: Array<string|object>, exclude?: string[]}} [opts]
 */
export function resolveFeatures(kind, opts = {}) {
    const exclude = new Set(opts.exclude ?? []);
    const out = new Map();
    for (const d of registry.values()) {
        if (d.default && (d.kind === 'any' || d.kind === kind)) out.set(d.id, d);
    }
    for (const u of opts.use ?? []) {
        const d = typeof u === 'string' ? registry.get(u) : defineFeature(u);
        if (!d) throw new Error(`unknown feature: ${u}`);
        if (d.kind !== 'any' && d.kind !== kind) throw new Error(`feature ${d.id} is ${d.kind}-only`);
        out.set(d.id, d);
    }
    for (const id of exclude) out.delete(id);
    return [...out.values()].sort((a, b) => a.order - b.order);
}
