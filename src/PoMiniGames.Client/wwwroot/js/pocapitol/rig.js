// PoCapitol's body: one low-poly rigged figure, built from plain arrays so it runs anywhere
// (browser, node). scripts/pocapitol-figure.mjs writes it to wwwroot/models/pocapitol/figure.glb,
// which the game loads; if that file cannot be fetched the game builds the same figure here.
//
// A replacement model made in Blender works too: export a glTF with one skinned mesh, bones
// named as below (missing bones simply do not move), materials named after the regions, the
// figure standing on the origin facing -Z at about 2 units tall, arms down.
// It is a generic person in winter clothes, not anyone in particular, and it has no face.

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
export const REGIONS = ['coat', 'sleeve', 'pants', 'skin', 'boots', 'gloves'];
const PREVIEW = { coat: [0.25, 0.3, 0.38, 1], sleeve: [0.22, 0.27, 0.34, 1], pants: [0.2, 0.22, 0.26, 1],
    skin: [0.62, 0.45, 0.33, 1], boots: [0.08, 0.08, 0.09, 1], gloves: [0.1, 0.11, 0.12, 1] };

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
 * With u × v = d the quads below face outward. `start`/`end` close a tube with a rounded point.
 */
function tube(m, d, rings, { segments = 8, start = 0, end = 0 } = {}) {
    d = unit(d);
    const u = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : unit(cross([0, 1, 0], d));
    const v = cross(d, u);
    const first = m.positions.length / 3;
    for (const ring of rings) for (let i = 0; i < segments; i++) {
        const a = i / segments * Math.PI * 2, cu = Math.cos(a) * ring.r[0], cv = Math.sin(a) * ring.r[1];
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

/** The figure as typed arrays per region, plus the bones. Deterministic: same bytes every time. */
export function buildFigure() {
    const r = Object.fromEntries(REGIONS.map(name => [name, region()]));
    const down = [0, -1, 0];
    // Coat body: a long winter coat, fuller at the chest, a little flared at the hem.
    const coatRings = [
        [1.62, 0.16, 0.13, { chest: 0.5, neck: 0.5 }], [1.56, 0.3, 0.2, { chest: 1 }], [1.47, 0.365, 0.255, { chest: 1 }],
        [1.34, 0.365, 0.26, { chest: 1 }], [1.18, 0.335, 0.245, { chest: 0.5, spine: 0.5 }], [1.02, 0.315, 0.232, { spine: 1 }],
        [0.86, 0.32, 0.236, { spine: 0.4, hips: 0.6 }], [0.7, 0.338, 0.248, { hips: 1 }], [0.58, 0.355, 0.258, { hips: 1 }],
    ];
    tube(r.coat, down, coatRings.map(([y, rx, rz, w]) => ({ c: [0, y, 0], r: [rx, rz], w })),
        { segments: 10, start: 0.04, end: -0.02 });
    tube(r.skin, down, [{ c: [0, 1.75, 0], r: [0.085, 0.085], w: { head: 0.5, neck: 0.5 } },
        { c: [0, 1.58, 0], r: [0.09, 0.09], w: { neck: 0.6, chest: 0.4 } }]);
    // Head: a plain ovoid, a touch fuller at the back. Deliberately featureless.
    const headRings = [22, 42, 62, 82, 102, 122, 146].map(deg => {
        const a = deg * Math.PI / 180, s = Math.sin(a);
        return { c: [0, 1.83 + Math.cos(a) * 0.24, 0.006], r: [0.2 * s, 0.215 * s], w: { head: 1 } };
    });
    tube(r.skin, down, headRings, { segments: 10, start: 0.24 - 0.24 * Math.cos(22 * Math.PI / 180) + 0.005,
        end: 0.24 + 0.24 * Math.cos(146 * Math.PI / 180) + 0.005 });
    for (const [s, x] of [['L', -1], ['R', 1]]) {
        const up = `upperArm_${s}`, fore = `foreArm_${s}`, hand = `hand_${s}`;
        const thigh = `thigh_${s}`, shin = `shin_${s}`, foot = `foot_${s}`;
        tube(r.sleeve, down, [
            [0.405, 1.585, 0.072, { chest: 0.6, [up]: 0.4 }], [0.432, 1.53, 0.105, { chest: 0.3, [up]: 0.7 }],
            [0.448, 1.42, 0.112, { [up]: 1 }], [0.46, 1.27, 0.102, { [up]: 1 }], [0.47, 1.12, 0.094, { [up]: 0.5, [fore]: 0.5 }],
            [0.475, 0.98, 0.088, { [fore]: 1 }], [0.48, 0.86, 0.082, { [fore]: 1 }],
        ].map(([cx, y, rad, w]) => ({ c: [x * cx, y, -0.12], r: [rad, rad], w })), { start: 0.04 });
        tube(r.gloves, down, [
            [0.88, 0.064, { [fore]: 0.6, [hand]: 0.4 }], [0.8, 0.068, { [hand]: 1 }], [0.72, 0.06, { [hand]: 1 }],
        ].map(([y, rad, w]) => ({ c: [x * 0.483, y, -0.12], r: [rad * 0.85, rad], w })), { end: 0.06 });
        tube(r.pants, down, [
            [0.165, 0.84, 0.135, { hips: 0.6, [thigh]: 0.4 }], [0.17, 0.68, 0.13, { [thigh]: 1 }], [0.17, 0.55, 0.116, { [thigh]: 1 }],
            [0.168, 0.42, 0.1, { [thigh]: 0.5, [shin]: 0.5 }], [0.165, 0.3, 0.093, { [shin]: 1 }], [0.162, 0.19, 0.087, { [shin]: 1 }],
        ].map(([cx, y, rad, w]) => ({ c: [x * cx, y, 0], r: [rad, rad], w })));
        tube(r.boots, down, [{ c: [x * 0.16, 0.25, 0], r: [0.095, 0.095], w: { [shin]: 0.6, [foot]: 0.4 } },
            { c: [x * 0.16, 0.13, 0.005], r: [0.097, 0.1], w: { [foot]: 1 } }], { start: 0.01 });
        tube(r.boots, [0, 0, -1], [
            [0.085, 0.1, 0.065, 0.06], [0.09, 0.05, 0.08, 0.085], [0.075, -0.06, 0.08, 0.075],
            [0.065, -0.17, 0.072, 0.062], [0.05, -0.23, 0.055, 0.045],
        ].map(([y, z, rw, rh]) => ({ c: [x * 0.16, y, z], r: [rw, rh], w: { [foot]: 1 } })), { start: 0.03, end: 0.025 });
    }
    return {
        bones: BONES,
        regions: REGIONS.map(name => ({
            name,
            positions: new Float32Array(r[name].positions),
            normals: smoothNormals(r[name]),
            joints: new Uint16Array(r[name].joints),
            weights: new Float32Array(r[name].weights),
            indices: new Uint16Array(r[name].indices),
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
        meshes: [{ name: 'figure', primitives }],
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
