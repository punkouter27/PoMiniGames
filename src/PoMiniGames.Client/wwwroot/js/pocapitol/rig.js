// PoCapitol's body: one low-poly rigged figure, built from plain arrays so it runs anywhere
// (browser, node). scripts/pocapitol-figure.mjs writes it to wwwroot/models/pocapitol/figure.glb,
// which the game loads; if that file cannot be fetched the game builds the same figure here.
//
// A replacement model made in Blender works too: export a glTF with one skinned mesh, bones
// named as below (missing bones simply do not move), materials named after the regions, the
// figure standing on the origin facing -Z at about 2 units tall, arms down.
// It is a generic person in winter clothes, not anyone in particular. The face is the same plain
// set of features on everybody (brow, nose, jaw, ears): enough to read as a person, no likeness.
//
// The file also carries a few morph targets (SHAPES): a waist-length jacket instead of the long
// coat, a bulky puffer, a heavy build and a slight one. The game blends them per person, so one
// mesh gives a crowd of different bodies. A replacement model without them just has one build.

/** Rest joints (model units: feet at 0, head top near 2.07, facing -Z, +X is the figure's right). */
export const BONES = [
    { name: 'hips', parent: null, head: [0, 0.74, 0] },
    { name: 'spine', parent: 'hips', head: [0, 0.95, 0] },
    { name: 'chest', parent: 'spine', head: [0, 1.2, 0] },
    { name: 'neck', parent: 'chest', head: [0, 1.6, 0] },
    { name: 'head', parent: 'neck', head: [0, 1.7, 0] },
    ...[['L', -1], ['R', 1]].flatMap(([s, x]) => [
        { name: `upperArm_${s}`, parent: 'chest', head: [x * 0.44, 1.49, -0.12] },
        { name: `foreArm_${s}`, parent: `upperArm_${s}`, head: [x * 0.47, 1.12, -0.12] },
        { name: `hand_${s}`, parent: `foreArm_${s}`, head: [x * 0.48, 0.83, -0.12] },
        { name: `thigh_${s}`, parent: 'hips', head: [x * 0.17, 0.76, 0] },
        { name: `shin_${s}`, parent: `thigh_${s}`, head: [x * 0.168, 0.42, 0] },
        { name: `foot_${s}`, parent: `shin_${s}`, head: [x * 0.16, 0.11, 0] },
    ]),
];
/** Each region is a material in the glTF and a separately tinted part of every person. */
export const REGIONS = ['coat', 'sleeve', 'pants', 'skin', 'boots', 'gloves', 'eyes', 'brow', 'mouth', 'jaw'];
/** Morph targets, as position offsets from the base figure. Same topology, so they blend freely. */
export const SHAPES = ['jacket', 'bulk', 'heavy', 'slim'];
const PREVIEW = { coat: [0.25, 0.3, 0.38, 1], sleeve: [0.22, 0.27, 0.34, 1], pants: [0.2, 0.22, 0.26, 1],
    skin: [0.62, 0.45, 0.33, 1], boots: [0.08, 0.08, 0.09, 1], gloves: [0.1, 0.11, 0.12, 1],
    eyes: [0.06, 0.05, 0.05, 1], brow: [0.2, 0.15, 0.11, 1], mouth: [0.5, 0.31, 0.26, 1], jaw: [0.62, 0.45, 0.33, 1] };

const boneIndex = Object.fromEntries(BONES.map((b, i) => [b.name, i]));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function region() { return { positions: [], joints: [], weights: [], indices: [] }; }
function vertex(m, p, w) {
    const entries = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = entries.reduce((sum, e) => sum + e[1], 0);
    m.positions.push(p[0], p[1], p[2]);
    for (let k = 0; k < 4; k++) {
        m.joints.push(entries[k] ? boneIndex[entries[k][0]] : 0);
        m.weights.push(entries[k] ? entries[k][1] / total : 0);
    }
    return m.positions.length / 3 - 1;
}
/**
 * A tube of elliptical rings along direction `d`. Ring: { c: centre, r: [across, deep], w: weights }.
 * `rf`, when given, is the depth of the half on the negative side of v (the front of an upright
 * tube), so a head or a belly need not be an ellipse.
 * With u × v = d the quads below face outward. `start`/`end` close a tube with a rounded point.
 */
function tube(m, d, rings, { segments = 8, start = 0, end = 0 } = {}) {
    d = unit(d);
    const u = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : unit(cross([0, 1, 0], d));
    const v = cross(d, u);
    const first = m.positions.length / 3;
    for (const ring of rings) for (let i = 0; i < segments; i++) {
        const a = i / segments * Math.PI * 2, sin = Math.sin(a);
        const cu = Math.cos(a) * ring.r[0], cv = sin * (sin < 0 && ring.rf !== undefined ? ring.rf : ring.r[1]);
        vertex(m, [0, 1, 2].map(k => ring.c[k] + u[k] * cu + v[k] * cv), ring.w);
    }
    for (let r = 0; r + 1 < rings.length; r++) for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments, a = first + r * segments, b = a + segments;
        m.indices.push(a + i, a + j, b + i, a + j, b + j, b + i);
    }
    if (start) {
        const ring = rings[0], c = vertex(m, ring.c.map((x, k) => x - d[k] * start), ring.w);
        for (let i = 0; i < segments; i++) m.indices.push(c, first + (i + 1) % segments, first + i);
    }
    if (end) {
        const ring = rings[rings.length - 1], last = first + (rings.length - 1) * segments;
        const c = vertex(m, ring.c.map((x, k) => x + d[k] * end), ring.w);
        for (let i = 0; i < segments; i++) m.indices.push(c, last + i, last + (i + 1) % segments);
    }
}
/** An open band of an upright tube, from angle a0 to a1 (radians; 3π/2 is the front), rings top to bottom. */
function shell(m, rings, a0, a1, steps) {
    const first = m.positions.length / 3;
    for (const ring of rings) for (let i = 0; i <= steps; i++) {
        const a = a0 + (a1 - a0) * i / steps, sin = Math.sin(a);
        vertex(m, [ring.c[0] + Math.cos(a) * ring.r[0], ring.c[1], ring.c[2] + sin * (sin < 0 ? ring.rf : ring.r[1])], ring.w);
    }
    for (let r = 0; r + 1 < rings.length; r++) for (let i = 0; i < steps; i++) {
        const a = first + r * (steps + 1), b = a + steps + 1;
        m.indices.push(a + i, a + i + 1, b + i, a + i + 1, b + i + 1, b + i);
    }
}
function smoothNormals(m) {
    const n = new Float32Array(m.positions.length), p = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const pa = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]];
        const f = cross(sub([p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], pa), sub([p[c * 3], p[c * 3 + 1], p[c * 3 + 2]], pa));
        for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i * 3 + k] += f[k];
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

// The head, top to bottom: [height, half-width, depth to the front, depth to the back]. Wider at
// the temples than the jaw, flat across the eyes, and the chin a little forward of the throat.
const HEAD = [
    [2.045, 0.078, 0.082, 0.088], [2.008, 0.138, 0.146, 0.158], [1.95, 0.18, 0.186, 0.206],
    [1.885, 0.194, 0.202, 0.216], [1.835, 0.196, 0.19, 0.212], [1.782, 0.19, 0.2, 0.2],
    [1.732, 0.17, 0.196, 0.168], [1.684, 0.128, 0.178, 0.12], [1.648, 0.08, 0.128, 0.078],
];
const HEAD_Z = 0.006;
/** Half-width and front depth of the head at a height, between its rings. */
function headAt(y) {
    for (let i = 0; i + 1 < HEAD.length; i++) {
        const [y0, w0, f0] = HEAD[i], [y1, w1, f1] = HEAD[i + 1];
        if (y <= y0 && y >= y1) { const t = (y0 - y) / (y0 - y1); return [w0 + (w1 - w0) * t, f0 + (f1 - f0) * t]; }
    }
    const [, w, f] = HEAD[y > HEAD[0][0] ? 0 : HEAD.length - 1];
    return [w, f];
}

/** One build of the figure. Every build has the same vertices in the same order. */
function build({ jacket = 0, bulk = 0, heavy = 0, slim = 0 } = {}) {
    const r = Object.fromEntries(REGIONS.map(name => [name, region()]));
    const down = [0, -1, 0];
    const girth = (1 + 0.12 * bulk) * (1 - 0.09 * slim);
    const limb = (1 + 0.16 * bulk) * (1 + 0.06 * heavy) * (1 - 0.1 * slim);
    const belly = y => heavy * Math.exp(-(((y - 0.98) / 0.28) ** 2));
    // Coat body: a long winter coat, fuller at the chest, a little flared at the hem. As a jacket
    // the skirt is drawn up to a waistband, which leaves the hips and the top of the legs showing.
    const coatRings = [
        [1.62, 0.16, 0.13, { chest: 0.5, neck: 0.5 }], [1.56, 0.3, 0.2, { chest: 1 }], [1.47, 0.365, 0.255, { chest: 1 }],
        [1.34, 0.365, 0.26, { chest: 1 }], [1.26, 0.352, 0.254, { chest: 0.8, spine: 0.2 }],
        [1.18, 0.335, 0.245, { chest: 0.5, spine: 0.5 }], [1.02, 0.315, 0.232, { spine: 1 }],
        [0.94, 0.316, 0.233, { spine: 0.7, hips: 0.3 }], [0.86, 0.32, 0.236, { spine: 0.4, hips: 0.6 }],
        [0.7, 0.338, 0.248, { hips: 1 }], [0.58, 0.355, 0.258, { hips: 1 }],
    ];
    tube(r.coat, down, coatRings.map(([y, rx, rz, w]) => {
        const b = belly(y), g = y > 1.58 ? 1 : girth, tuck = y < 0.9 ? 1 - 0.05 * jacket : 1;
        const hem = y < 0.9 ? 0.9 - (0.9 - y) * (1 - 0.78 * jacket) : y;
        return { c: [0, hem, -0.035 * b], r: [rx * g * (1 + 0.14 * b) * tuck, rz * g * (1 + 0.2 * b) * tuck],
            rf: rz * g * (1 + 0.42 * b) * tuck * (y > 1.2 && y < 1.5 ? 1.04 : 1), w };
    }), { segments: 12, start: 0.04, end: -0.02 });
    // A stand-up collar round the neck.
    tube(r.coat, down, [{ c: [0, 1.69, 0.012], r: [0.112, 0.118], w: { neck: 1 } },
        { c: [0, 1.6, 0.005], r: [0.15 * girth, 0.135 * girth], w: { neck: 0.5, chest: 0.5 } }], { segments: 10 });
    tube(r.skin, down, [{ c: [0, 1.75, 0], r: [0.085, 0.085], w: { head: 0.5, neck: 0.5 } },
        { c: [0, 1.58, 0], r: [0.09 + 0.012 * heavy, 0.09 + 0.012 * heavy], w: { neck: 0.6, chest: 0.4 } }]);
    // Head and face. The features are the same on everybody.
    const head = { head: 1 }, jowl = y => y < 1.76 ? 1 + 0.09 * heavy - 0.04 * slim : 1;
    tube(r.skin, down, HEAD.map(([y, w, f, b]) => ({ c: [0, y, HEAD_Z], r: [w * jowl(y), b], rf: f, w: head })),
        { segments: 12, start: 0.022, end: 0.018 });
    tube(r.skin, down, [{ c: [0, 1.85, -0.196], r: [0.014, 0.01], w: head }, { c: [0, 1.805, -0.214], r: [0.024, 0.026], w: head },
        { c: [0, 1.776, -0.218], r: [0.034, 0.034], w: head }], { segments: 5, start: 0.005, end: 0.012 });
    tube(r.mouth, [1, 0, 0], [[-0.045, -0.176], [0, -0.19], [0.045, -0.176]].map(([x, z]) =>
        ({ c: [x, 1.722, z], r: [0.008, 0.007], w: head })), { segments: 4, start: 0.003, end: 0.003 });
    // The jaw, as a thin shell over the lower face: skin on most people, a beard or a mask on some.
    shell(r.jaw, [1.79, 1.74, 1.69, 1.652, 1.632].map(y => {
        const [w, f] = headAt(y);
        return { c: [0, y, HEAD_Z], r: [(w + 0.008) * jowl(y), 0], rf: f + 0.008, w: head };
    }), Math.PI * 195 / 180, Math.PI * 345 / 180, 8);
    for (const [s, x] of [['L', -1], ['R', 1]]) {
        const up = `upperArm_${s}`, fore = `foreArm_${s}`, hand = `hand_${s}`;
        const thigh = `thigh_${s}`, shin = `shin_${s}`, foot = `foot_${s}`;
        tube(r.skin, [x, 0, 0], [{ c: [x * 0.19, 1.82, 0.03], r: [0.028, 0.046], w: head }], { segments: 6, end: 0.034 });
        tube(r.eyes, unit([x * 0.35, 0, -1]), [{ c: [x * 0.08, 1.838, -0.172], r: [0.03, 0.014], w: head }], { segments: 6, end: 0.005 });
        tube(r.brow, [x, 0, 0], [{ c: [x * 0.03, 1.874, -0.196], r: [0.011, 0.009], w: head },
            { c: [x * 0.118, 1.868, -0.158], r: [0.011, 0.009], w: head }], { segments: 4, start: 0.004, end: 0.004 });
        tube(r.sleeve, down, [
            [0.405, 1.585, 0.072, { chest: 0.6, [up]: 0.4 }], [0.432, 1.53, 0.105, { chest: 0.3, [up]: 0.7 }],
            [0.448, 1.42, 0.112, { [up]: 1 }], [0.46, 1.27, 0.102, { [up]: 1 }], [0.47, 1.12, 0.094, { [up]: 0.5, [fore]: 0.5 }],
            [0.475, 0.98, 0.088, { [fore]: 1 }], [0.48, 0.86, 0.082, { [fore]: 1 }],
        ].map(([cx, y, rad, w], i) => ({ c: [x * cx, y, -0.12], r: [rad * (i ? limb : 1), rad * (i ? limb : 1)], w })), { start: 0.04 });
        // A mitten of a hand: flat palm, and a thumb forward of it.
        tube(r.gloves, down, [
            [0.88, 0.064, { [fore]: 0.6, [hand]: 0.4 }], [0.8, 0.07, { [hand]: 1 }], [0.73, 0.064, { [hand]: 1 }],
        ].map(([y, rad, w]) => ({ c: [x * 0.483, y, -0.12], r: [rad * 0.62, rad], w })), { end: 0.05 });
        tube(r.gloves, unit([0, -0.7, -0.7]), [{ c: [x * 0.483, 0.815, -0.165], r: [0.022, 0.022], w: { [hand]: 1 } },
            { c: [x * 0.483, 0.775, -0.205], r: [0.018, 0.018], w: { [hand]: 1 } }], { segments: 5, start: 0.01, end: 0.02 });
        tube(r.pants, down, [
            [0.165, 0.84, 0.135, { hips: 0.6, [thigh]: 0.4 }], [0.17, 0.68, 0.13, { [thigh]: 1 }], [0.17, 0.55, 0.116, { [thigh]: 1 }],
            [0.168, 0.42, 0.1, { [thigh]: 0.5, [shin]: 0.5 }], [0.165, 0.3, 0.093, { [shin]: 1 }], [0.162, 0.19, 0.087, { [shin]: 1 }],
        ].map(([cx, y, rad, w]) => {
            const leg = rad * (1 + (y > 0.4 ? 0.1 : 0.04) * heavy) * (1 - 0.08 * slim);
            return { c: [x * cx, y, 0], r: [leg, leg], w };
        }));
        tube(r.boots, down, [{ c: [x * 0.16, 0.25, 0], r: [0.095, 0.095], w: { [shin]: 0.6, [foot]: 0.4 } },
            { c: [x * 0.16, 0.13, 0.005], r: [0.097, 0.1], w: { [foot]: 1 } }], { start: 0.01 });
        tube(r.boots, [0, 0, -1], [
            [0.085, 0.1, 0.065, 0.06], [0.09, 0.05, 0.08, 0.085], [0.075, -0.06, 0.08, 0.075],
            [0.065, -0.17, 0.072, 0.062], [0.05, -0.23, 0.055, 0.045],
        ].map(([y, z, rw, rh]) => ({ c: [x * 0.16, y, z], r: [rw, rh], w: { [foot]: 1 } })), { start: 0.03, end: 0.025 });
    }
    return r;
}

/** The figure as typed arrays per region, plus the bones. Deterministic: same bytes every time. */
export function buildFigure() {
    const base = build(), morphed = SHAPES.map(name => build({ [name]: 1 }));
    return {
        bones: BONES,
        shapes: SHAPES,
        regions: REGIONS.map(name => ({
            name,
            positions: new Float32Array(base[name].positions),
            normals: smoothNormals(base[name]),
            joints: new Uint16Array(base[name].joints),
            weights: new Float32Array(base[name].weights),
            indices: new Uint16Array(base[name].indices),
            // Offsets, rounded so the file is byte-identical wherever it is built.
            shapes: morphed.map(m => Float32Array.from(m[name].positions, (v, i) => Math.round((v - base[name].positions[i]) * 1e5) / 1e5)),
        })),
    };
}

/** The figure as a binary glTF 2.0 (.glb): one skinned mesh, one primitive per region. */
export function toGlb(figure) {
    const chunks = [], bufferViews = [], accessors = [];
    let length = 0;
    function add(array, target, accessor) {
        const pad = (4 - length % 4) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        chunks.push(bytes); length += bytes.byteLength;
        accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
        return accessors.length - 1;
    }
    const bones = figure.bones, index = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    const round = v => Math.round(v * 1e6) / 1e6;
    const nodes = bones.map(bone => {
        const parent = bone.parent ? bones[index[bone.parent]] : null;
        const children = bones.map((b, i) => b.parent === bone.name ? i : -1).filter(i => i >= 0);
        return { name: bone.name, translation: bone.head.map((v, k) => round(v - (parent ? parent.head[k] : 0))),
            ...(children.length ? { children } : {}) };
    });
    const inverse = new Float32Array(bones.length * 16);
    bones.forEach((bone, i) => {
        for (let k = 0; k < 4; k++) inverse[i * 16 + k * 5] = 1;
        for (let k = 0; k < 3; k++) inverse[i * 16 + 12 + k] = -bone.head[k];
    });
    const inverseBind = add(inverse, 0, { componentType: 5126, count: bones.length, type: 'MAT4' });
    const primitives = figure.regions.map((r, material) => {
        const count = r.positions.length / 3, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < r.positions.length; i++) {
            min[i % 3] = Math.min(min[i % 3], r.positions[i]); max[i % 3] = Math.max(max[i % 3], r.positions[i]);
        }
        return {
            attributes: {
                POSITION: add(r.positions, 34962, { componentType: 5126, count, type: 'VEC3', min, max }),
                NORMAL: add(r.normals, 34962, { componentType: 5126, count, type: 'VEC3' }),
                JOINTS_0: add(r.joints, 34962, { componentType: 5123, count, type: 'VEC4' }),
                WEIGHTS_0: add(r.weights, 34962, { componentType: 5126, count, type: 'VEC4' }),
            },
            indices: add(r.indices, 34963, { componentType: 5123, count: r.indices.length, type: 'SCALAR' }),
            material,
            ...(r.shapes?.length ? { targets: r.shapes.map(delta => {
                const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
                for (let i = 0; i < delta.length; i++) { lo[i % 3] = Math.min(lo[i % 3], delta[i]); hi[i % 3] = Math.max(hi[i % 3], delta[i]); }
                return { POSITION: add(delta, 34962, { componentType: 5126, count, type: 'VEC3', min: lo, max: hi }) };
            }) } : {}),
        };
    });
    const tail = (4 - length % 4) % 4;
    if (tail) { chunks.push(new Uint8Array(tail)); length += tail; }
    nodes.push({ name: 'figure', mesh: 0, skin: 0 });
    const json = {
        asset: { version: '2.0', generator: 'PoCapitol rig.js' },
        scene: 0,
        scenes: [{ name: 'figure', nodes: [index[bones.find(b => !b.parent).name], nodes.length - 1] }],
        nodes,
        meshes: [{ name: 'figure', primitives,
            ...(figure.shapes?.length ? { weights: figure.shapes.map(() => 0), extras: { targetNames: figure.shapes } } : {}) }],
        skins: [{ name: 'figure', joints: bones.map((_, i) => i), inverseBindMatrices: inverseBind, skeleton: 0 }],
        materials: figure.regions.map(r => ({ name: r.name,
            pbrMetallicRoughness: { baseColorFactor: PREVIEW[r.name] ?? [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } })),
        accessors, bufferViews,
        buffers: [{ byteLength: length }],
    };
    let text = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - text.length % 4) % 4;
    if (jsonPad) { const padded = new Uint8Array(text.length + jsonPad).fill(0x20); padded.set(text); text = padded; }
    const glb = new Uint8Array(12 + 8 + text.length + 8 + length), view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
    view.setUint32(12, text.length, true); view.setUint32(16, 0x4e4f534a, true); glb.set(text, 20);
    let at = 20 + text.length;
    view.setUint32(at, length, true); view.setUint32(at + 4, 0x004e4942, true); at += 8;
    for (const chunk of chunks) { glb.set(chunk, at); at += chunk.length; }
    return glb;
}
