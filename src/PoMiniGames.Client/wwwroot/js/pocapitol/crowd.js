import * as THREE from 'three';
import { addWave, billboardChunk, createPolycarbonateMaterial, addSubsurfaceScattering, addFabric, CLOTH } from './look.js';
import { BONES as RIG_BONES, REGIONS, buildFigure } from './rig.js';
import { collapseStage, tipAxes, impactFrame, restPlace } from './collapse.js';

// Original procedural artwork; references inform clothing and equipment, not real identities.
/** Fit a short phrase onto a board in at most three lines, shrinking until it fits. */
function drawBoardText(ctx, text) {
    const words = String(text ?? '').toUpperCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length === 0) return;
    const wrap = size => {
        ctx.font = `bold ${size}px sans-serif`;
        const lines = [];
        let line = '';
        for (const word of words) {
            const next = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(next).width > 336) { lines.push(line); line = word; }
            else line = next;
        }
        if (line) lines.push(line);
        return lines;
    };
    let size = 72, lines = wrap(size);
    while (size > 22 && (lines.length > 3 || lines.some(l => ctx.measureText(l).width > 336))) {
        size -= 2; lines = wrap(size);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#233d78';
    const step = size * 1.16, total = lines.length * step;
    let y = 130 - total / 2 + size * 0.86;
    for (const line of lines) { ctx.fillText(line, 195, y); y += step; }
}

function drawStar(ctx, x, y, size) {
    ctx.beginPath();
    for (let point = 0; point < 10; point++) {
        const angle = point / 10 * Math.PI * 2 - Math.PI / 2, radius = point % 2 ? size * 0.4 : size;
        ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    ctx.closePath(); ctx.fill();
}

/**
 * The flags and boards seen in the photographs of the day, drawn here rather than downloaded:
 * the national flag, the blue and red campaign flags that outnumbered everything else, the
 * Gadsden, the thirteen-star and pine-tree flags, and a black-and-white one with a blue stripe.
 * `text` kinds are the hand-held placards.
 */
export function flagTexture(kind = 'us', text = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 390; canvas.height = 260;
    const ctx = canvas.getContext('2d');
    if (kind === 'us' || kind === 'betsy' || kind === 'line') {
        const mono = kind === 'line';
        ctx.fillStyle = mono ? '#d9d9d6' : '#edece5'; ctx.fillRect(0, 0, 390, 260);
        ctx.fillStyle = mono ? '#16171a' : '#a9353e';
        for (let i = 0; i < 13; i += 2) ctx.fillRect(0, i * 20, 390, 20);
        if (mono) { ctx.fillStyle = '#2f5fa8'; ctx.fillRect(0, 140, 390, 20); }
        ctx.fillStyle = mono ? '#16171a' : '#293f6b'; ctx.fillRect(0, 0, 156, 140);
        ctx.fillStyle = mono ? '#d9d9d6' : '#fff';
        if (kind === 'betsy') {
            for (let i = 0; i < 13; i++) drawStar(ctx, 78 + Math.sin(i / 13 * Math.PI * 2) * 46, 70 - Math.cos(i / 13 * Math.PI * 2) * 46, 8);
        } else {
            for (let row = 0; row < 9; row++) for (let col = 0; col < (row % 2 ? 5 : 6); col++) {
                drawStar(ctx, 13 + col * 26 + (row % 2 ? 13 : 0), 10 + row * 15, 5);
            }
        }
    } else if (kind === 'trump-red') {
        ctx.fillStyle = '#b3282f'; ctx.fillRect(0, 0, 390, 260);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 92px sans-serif';
        ctx.fillText('TRUMP', 195, 122);
        ctx.fillRect(44, 146, 302, 8);
        ctx.font = 'bold 29px sans-serif'; ctx.fillText('KEEP AMERICA GREAT', 195, 200);
    } else if (kind === 'pine') {
        // White field, green pine, the motto above it.
        ctx.fillStyle = '#f1efe6'; ctx.fillRect(0, 0, 390, 260);
        ctx.fillStyle = '#2f5d3a'; ctx.textAlign = 'center'; ctx.font = 'bold 30px serif';
        ctx.fillText('AN APPEAL TO HEAVEN', 195, 44);
        for (const [top, half, base] of [[66, 34, 122], [100, 50, 166], [138, 64, 210]]) {
            ctx.beginPath(); ctx.moveTo(195, top); ctx.lineTo(195 + half, base); ctx.lineTo(195 - half, base); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = '#5a4630'; ctx.fillRect(187, 210, 16, 30);
    } else if (kind === 'gadsden') {
        // The yellow field and motto only: the artwork is not reproduced.
        ctx.fillStyle = '#e8c53a'; ctx.fillRect(0, 0, 390, 260);
        ctx.fillStyle = '#2c2a22'; ctx.textAlign = 'center'; ctx.font = 'bold 40px serif';
        ctx.fillText("DON'T TREAD", 195, 205); ctx.fillText('ON ME', 195, 245);
        ctx.beginPath(); ctx.ellipse(195, 100, 70, 38, 0, 0, Math.PI * 2); ctx.lineWidth = 12; ctx.strokeStyle = '#5b5a34'; ctx.stroke();
    } else if (kind === 'sign') {
        ctx.fillStyle = '#f3f1ea'; ctx.fillRect(0, 0, 390, 260);
        ctx.strokeStyle = '#a9353e'; ctx.lineWidth = 10; ctx.strokeRect(10, 10, 370, 240);
        ctx.fillStyle = '#a9353e'; ctx.textAlign = 'center'; ctx.font = 'bold 74px sans-serif';
        ctx.fillText('STOP', 195, 100);
        ctx.fillStyle = '#233d78'; ctx.font = 'bold 58px sans-serif';
        ctx.fillText('THE STEAL', 195, 185);
    } else if (kind === 'text') {
        // A board from data/pocapitol/placards.json: plain card, fitted phrase, red rule.
        ctx.fillStyle = '#f3f1ea'; ctx.fillRect(0, 0, 390, 260);
        ctx.strokeStyle = '#a9353e'; ctx.lineWidth = 10; ctx.strokeRect(10, 10, 370, 240);
        drawBoardText(ctx, text);
    } else {
        ctx.fillStyle = '#233d78'; ctx.fillRect(0, 0, 390, 260);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.strokeRect(12, 12, 366, 236);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = 'bold 58px sans-serif';
        ctx.fillText('TRUMP', 195, 115);
        ctx.font = 'bold 66px sans-serif'; ctx.fillText('2020', 195, 188);
        ctx.fillStyle = '#bd3f45'; ctx.fillRect(26, 210, 338, 12);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// Winter clothes: the day was cold, about 40 °F, and the photographs are full of dark coats,
// puffers, knit hats and hoods.
export const coats = ['#715945', '#303c4b', '#645f4d', '#793d34', '#8b775b', '#373c38', '#405576', '#434047',
    '#2d3a2a', '#8a8f96', '#1a1c20', '#5a1f24'];
const suits = ['#27303f', '#3a3f48', '#1f2a3a', '#4a4650', '#2f3b33'];
const pants = ['#3b4a63', '#2a2f38', '#6b6250', '#1d1f22', '#4d5560', '#34405a'];
const hairs = ['#2b2118', '#4a3524', '#6e5a43', '#9a8f84', '#b89a64', '#1c1a18'];
const knits = ['#a93737', '#2b3f66', '#3a3a3a', '#7d7f45', '#c9c3b5', '#5a2d3c'];
const skins = ['#d4b28e', '#b98f6c', '#90694e', '#debfa3', '#73533e'];
const lips = ['#b07f6b', '#96685a', '#74503f', '#bd8c7c', '#5c3f31'];

/**
 * A random slice of the placard list for this scene. Every distinct board costs one instanced
 * draw call, so the slice is bounded; across launches the whole list still gets used.
 */
function shuffledSigns(signs, limit = 14) {
    const list = [...new Set((signs ?? []).filter(text => typeof text === 'string' && text.length > 0))];
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, limit);
}

/** A stable 0..1 trait per actor, so a person keeps their height and build all day. */
function trait(id, salt) {
    const v = Math.sin((id + 11) * 12.9898 + salt * 78.233) * 43758.5453;
    return v - Math.floor(v);
}

/**
 * How this person walks. Stride length, cadence and a bad knee are drawn once from the same
 * stable trait, so a crowd of a hundred breaks out of lockstep without any per-frame cost.
 */
const GAITS = new Map(), GAIT_DEFAULT = { stride: 0.5, cadence: 1, limp: 0 };
function gaitOf(id) {
    let gait = GAITS.get(id);
    if (!gait) {
        gait = {
            stride: 0.36 + trait(id, 7) * 0.26,
            cadence: 0.84 + trait(id, 8) * 0.3,
            // About one in nine favours a knee; a few take short, careful steps.
            limp: trait(id, 9) < 0.11 ? 0.16 + trait(id, 10) * 0.14 : 0,
        };
        GAITS.set(id, gait);
    }
    return gait;
}

// ---------------------------------------------------------------- the rigged figure

const FIGURE_URL = 'models/pocapitol/figure.glb';
let figurePromise = null;
/**
 * The rigged figure (wwwroot/models/pocapitol/figure.glb, written by rig.js). If it cannot be
 * fetched the same figure is built in code, so the game never waits on it or breaks without it.
 */
export function loadFigure() {
    figurePromise ??= (async () => {
        try {
            const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
            return fromGltf(await new GLTFLoader().loadAsync(FIGURE_URL));
        } catch (error) {
            console.warn('PoCapitol: figure.glb unavailable, building the figure in code.', error);
            return fromRig(buildFigure());
        }
    })();
    return figurePromise;
}
function fromGltf(gltf) {
    gltf.scene.updateMatrixWorld(true);
    const meshes = [];
    gltf.scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
    if (!meshes.length) throw new Error('figure.glb has no skinned mesh.');
    const { bones, boneInverses } = meshes[0].skeleton;
    const rest = new THREE.Matrix4(), point = new THREE.Vector3();
    const heads = bones.map((_, i) => point.setFromMatrixPosition(rest.copy(boneInverses[i]).invert()).toArray());
    const shapeNames = new Set();
    const regions = meshes.map(m => {
        if (m.skeleton.bones.some((b, i) => b !== bones[i])) throw new Error('figure.glb meshes must share one skeleton.');
        const geometry = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) {
            const source = m.geometry.getAttribute(name);
            if (!source) throw new Error(`figure.glb is missing ${name}.`);
            geometry.setAttribute(name, source.clone());
        }
        geometry.setIndex(m.geometry.index.clone());
        geometry.applyMatrix4(m.bindMatrix);
        // Morph targets (the builds), by name. glTF stores them as offsets, which is what we want.
        const shapes = {}, morphs = m.geometry.morphAttributes?.position ?? [];
        for (const [name, at] of Object.entries(m.morphTargetDictionary ?? {})) {
            if (morphs[at]) { shapes[name] = morphs[at]; shapeNames.add(name); }
        }
        return { name: m.material.name, geometry, shapes };
    });
    return template(bones.map(b => b.name), bones.map(b => bones.indexOf(b.parent)), heads, regions, [...shapeNames]);
}
function fromRig(figure) {
    const names = figure.bones.map(b => b.name), shapeNames = figure.shapes ?? [];
    const regions = figure.regions.map(r => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
        geometry.setAttribute('skinIndex', new THREE.BufferAttribute(r.joints, 4));
        geometry.setAttribute('skinWeight', new THREE.BufferAttribute(r.weights, 4));
        geometry.setIndex(new THREE.BufferAttribute(r.indices, 1));
        const shapes = Object.fromEntries(shapeNames.map((name, k) => [name, new THREE.BufferAttribute(r.shapes[k], 3)]));
        return { name: r.name, geometry, shapes };
    });
    return template(names, figure.bones.map(b => names.indexOf(b.parent)), figure.bones.map(b => b.head), regions, shapeNames);
}
/** One figure flattened: vertex streams, its region per vertex, its builds, bones in parents-first order. */
function template(names, parents, heads, regions, shapeNames = []) {
    const order = [], seen = new Set();
    const visit = i => { if (seen.has(i)) return; if (parents[i] >= 0) visit(parents[i]); seen.add(i); order.push(i); };
    names.forEach((_, i) => visit(i));
    let vertices = 0, indices = 0;
    for (const r of regions) { vertices += r.geometry.attributes.position.count; indices += r.geometry.index.count; }
    const t = {
        bones: names.length, names, parents, order, heads: heads.map(h => new THREE.Vector3(...h)),
        canon: names.map(n => RIG_BONES.findIndex(b => b.name === n)),
        position: new Float32Array(vertices * 3), normal: new Float32Array(vertices * 3),
        skinIndex: new Uint16Array(vertices * 4), skinWeight: new Float32Array(vertices * 4),
        region: new Uint8Array(vertices), index: new Uint32Array(indices), vertices, indices,
        shapes: shapeNames.map(name => ({ name, delta: new Float32Array(vertices * 3) })),
    };
    let v = 0, k = 0;
    for (const r of regions) {
        const g = r.geometry, at = REGIONS.indexOf(r.name), base = v;
        const { position, normal, skinIndex, skinWeight } = g.attributes;
        for (const shape of t.shapes) {
            const delta = r.shapes?.[shape.name];
            if (!delta) continue;
            for (let i = 0; i < position.count; i++) shape.delta.set([delta.getX(i), delta.getY(i), delta.getZ(i)], (base + i) * 3);
        }
        for (let i = 0; i < position.count; i++, v++) {
            t.position.set([position.getX(i), position.getY(i), position.getZ(i)], v * 3);
            t.normal.set([normal.getX(i), normal.getY(i), normal.getZ(i)], v * 3);
            t.skinIndex.set([skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i)], v * 4);
            t.skinWeight.set([skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i)], v * 4);
            t.region[v] = at < 0 ? 0 : at;
        }
        for (let i = 0; i < g.index.count; i++) t.index[k++] = base + g.index.getX(i);
        g.dispose();
    }
    return t;
}

/**
 * Every near figure in one skinned mesh: the template copied once per slot, each copy bound to
 * its own run of bones in a single bone texture. One draw call per pass, and because it is a
 * real SkinnedMesh the shadow, ambient-occlusion and depth-of-field passes all see the pose.
 */
function createBodies(scene, t, capacity, { detail, flat = false } = {}) {
    const V = t.vertices, B = t.bones;
    const position = new Float32Array(V * capacity * 3), normal = new Float32Array(V * capacity * 3);
    const skinIndex = new Uint16Array(V * capacity * 4), skinWeight = new Float32Array(V * capacity * 4);
    const index = new Uint32Array(t.indices * capacity), colors = new Float32Array(V * capacity * 3);
    const cloth = new Float32Array(V * capacity), scratch = new Float32Array(V * 3);
    for (let s = 0; s < capacity; s++) {
        position.set(t.position, s * V * 3); normal.set(t.normal, s * V * 3); skinWeight.set(t.skinWeight, s * V * 4);
        for (let i = 0; i < V * 4; i++) skinIndex[s * V * 4 + i] = t.skinIndex[i] + s * B;
        for (let i = 0; i < t.indices; i++) index[s * t.indices + i] = t.index[i] + s * V;
    }
    const geometry = new THREE.BufferGeometry();
    // Positions and normals are written once per person, when their build is known.
    const positions = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
    const normals = new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('normal', normals);
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    const color = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', color);
    const cloths = new THREE.BufferAttribute(cloth, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aCloth', cloths);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    // `flat` is the unlit body the far-crowd bake uses to cut out its coat mask.
    const material = flat ? new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
        : addFabric(addSubsurfaceScattering(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 })), detail);
    // The skeleton's bones are never posed through the scene graph: matrices are written straight
    // into its bone texture, so a single placeholder bone stands in for all of them.
    const placeholder = new THREE.Bone(), identity = new THREE.Matrix4();
    const skeleton = new THREE.Skeleton(new Array(B * capacity).fill(placeholder), new Array(B * capacity).fill(identity));
    skeleton.computeBoneTexture();
    skeleton.update = () => {};
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    const S = Array.from({ length: B }, () => new THREE.Matrix4());
    const local = new THREE.Matrix4(), euler = new THREE.Euler(), turned = new THREE.Vector3(), out = new THREE.Matrix4();
    const keys = new Array(capacity).fill(null), looks = new Array(capacity).fill(null), slots = new Map();
    let used = new Set();
    return {
        mesh,
        boneOf(name) { return t.names.indexOf(name); },
        /** A stable slot per person, so their colours are written once, not every frame. */
        claim(key) {
            let slot = slots.get(key);
            if (slot === undefined) { slot = keys.indexOf(null); keys[slot] = key; slots.set(key, slot); }
            used.add(slot);
            return slot;
        },
        /** True when the slot has not been dressed as `look` yet. */
        stale(slot, look) { return looks[slot] !== look; },
        /**
         * Dresses a slot once: a colour and a cloth kind per body region, and the person's build
         * as a blend of the figure's morph targets (`weights`, by shape name).
         */
        dress(slot, look, tint, kind, weights) {
            looks[slot] = look;
            for (let v = 0; v < V; v++) {
                tint(t.region[v]).toArray(colors, (slot * V + v) * 3);
                cloth[slot * V + v] = kind(t.region[v]);
            }
            color.addUpdateRange(slot * V * 3, V * 3); color.needsUpdate = true;
            cloths.addUpdateRange(slot * V, V); cloths.needsUpdate = true;
            if (!t.shapes.length) return;
            const at = slot * V * 3;
            position.set(t.position, at);
            for (const shape of t.shapes) {
                const w = weights?.[shape.name] ?? 0;
                if (w) for (let i = 0; i < V * 3; i++) position[at + i] += shape.delta[i] * w;
            }
            // A different build has different surfaces: its normals are worked out again.
            scratch.fill(0);
            for (let k = 0; k < t.indices; k += 3) {
                const a = t.index[k] * 3, b = t.index[k + 1] * 3, c = t.index[k + 2] * 3;
                const ax = position[at + a], ay = position[at + a + 1], az = position[at + a + 2];
                const ux = position[at + b] - ax, uy = position[at + b + 1] - ay, uz = position[at + b + 2] - az;
                const vx = position[at + c] - ax, vy = position[at + c + 1] - ay, vz = position[at + c + 2] - az;
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                scratch[a] += nx; scratch[a + 1] += ny; scratch[a + 2] += nz;
                scratch[b] += nx; scratch[b + 1] += ny; scratch[b + 2] += nz;
                scratch[c] += nx; scratch[c + 1] += ny; scratch[c + 2] += nz;
            }
            for (let i = 0; i < V * 3; i += 3) {
                const l = Math.hypot(scratch[i], scratch[i + 1], scratch[i + 2]);
                if (l < 1e-9) continue;
                normal[at + i] = scratch[i] / l; normal[at + i + 1] = scratch[i + 1] / l; normal[at + i + 2] = scratch[i + 2] / l;
            }
            positions.addUpdateRange(at, V * 3); positions.needsUpdate = true;
            normals.addUpdateRange(at, V * 3); normals.needsUpdate = true;
        },
        /** World matrices of the slot's bones: figure × rest-to-posed for each joint. */
        pose(slot, figure, pose) {
            const bones = skeleton.boneMatrices;
            for (const i of t.order) {
                const c = t.canon[i], h = t.heads[i];
                if (c >= 0) euler.set(pose[c * 3], pose[c * 3 + 1], pose[c * 3 + 2]); else euler.set(0, 0, 0);
                local.makeRotationFromEuler(euler);
                turned.copy(h).applyMatrix4(local);
                local.setPosition(h.x - turned.x, h.y - turned.y, h.z - turned.z);
                if (t.parents[i] >= 0) S[i].multiplyMatrices(S[t.parents[i]], local); else S[i].copy(local);
                out.multiplyMatrices(figure, S[i]).toArray(bones, (slot * B + i) * 16);
            }
        },
        boneMatrix(slot, bone, target) { return target.fromArray(skeleton.boneMatrices, (slot * B + bone) * 16); },
        /** Frees the slots nobody used this frame and trims the draw to the highest one in use. */
        finish() {
            let top = -1;
            for (let s = 0; s < capacity; s++) {
                if (used.has(s)) { top = s; continue; }
                if (keys[s] !== null) { slots.delete(keys[s]); keys[s] = null; looks[s] = null; }
                skeleton.boneMatrices.fill(0, s * B * 16, (s + 1) * B * 16);
            }
            used = new Set();
            geometry.setDrawRange(0, (top + 1) * t.indices);
            skeleton.boneTexture.needsUpdate = true;
        },
        dispose() { scene.remove(mesh); geometry.dispose(); material.dispose(); skeleton.dispose(); },
    };
}

// ---------------------------------------------------------------- poses

const K = Object.fromEntries(RIG_BONES.map((b, i) => [b.name, i]));
function rot(pose, name, x, y = 0, z = 0) { const i = K[name] * 3; pose[i] += x; pose[i + 1] += y; pose[i + 2] += z; }
/**
 * Joint angles (radians, rest-relative, about the figure's own axes) for one person this frame.
 * Positive X swings a hanging limb forward and tips an upright part back. Returns how the whole
 * figure sits: `drop` lowers it (sitting), `fall` lays it down.
 */
function poseFor(b, a, t, pose) {
    pose.fill(0);
    const id = a.id;
    if (a.health <= 0) {
        if (b.lying) {
            // A collapse in stages: the weight goes, the knees buckle, the body tips the way the
            // round pushed it, then it settles and stops being recomputed.
            const f = b.fall ?? { t0: t, rel: Math.PI, seed: 0.5, zone: 'torso' };
            const age = Math.max(0, t - f.t0);
            const { ease, brace, tip, settle, flail, tipAngle } = collapseStage(age, f.zone, f.seed);
            // A last step under the falling weight, whichever way the body is going. As the
            // collapse settles the limbs stop bracing and go slack: knees and elbows give, arms
            // splay on the ground, one leg falls open and the head lolls to the side.
            const limp = settle;
            const sway = (f.seed - 0.5) * 2;
            for (const [s, side] of [['L', -1], ['R', 1]]) {
                rot(pose, `thigh_${s}`, (0.3 + 0.55 * brace) - flail * side * 0.2, 0, side * (0.12 * tip + 0.3 * limp));
                rot(pose, `shin_${s}`, -0.5 - 0.95 * brace + limp * (0.4 + 0.12 * side * sway));
                rot(pose, `foot_${s}`, 0.22 * brace - limp * 0.15);
            }
            rot(pose, 'spine', -0.14 * (1 - settle) + 0.1 * flail);
            rot(pose, 'upperArm_L', 0.2 * settle - flail * 0.7, 0, -0.55 * settle - 0.4 * tip - 0.6 * limp);
            rot(pose, 'upperArm_R', 0.3 * settle + flail * 0.7, 0, 0.5 * settle + 0.35 * tip + 0.6 * limp);
            rot(pose, 'foreArm_L', 0.4 * settle + 0.3 * tip - 0.3 * limp);
            rot(pose, 'foreArm_R', 0.25 * settle + 0.24 * tip - 0.25 * limp);
            rot(pose, 'head', 0.15 * settle + 0.2 * flail - 0.1 * limp, 0.4 * (f.seed - 0.5) * settle + 0.35 * limp * sway);
            // Tipping is about the body's own axes, so the same lean reads correctly at any heading.
            return { drop: 0, ...tipAxes(f.rel, tipAngle), lift: 0.06 * ease };
        }
        if (b.stooped) {
            // Being helped away: bent over, knees soft.
            rot(pose, 'spine', -0.35); rot(pose, 'chest', -0.15); rot(pose, 'head', -0.2);
            for (const s of ['L', 'R']) { rot(pose, `thigh_${s}`, 0.45); rot(pose, `shin_${s}`, -0.8); rot(pose, `foot_${s}`, 0.35); }
            rot(pose, 'upperArm_L', 0.35); rot(pose, 'foreArm_L', 0.5); rot(pose, 'upperArm_R', 0.1, 0, 0.6);
            return { drop: 0.1, fall: 0, lift: 0 };
        }
        // Sitting on the ground, knees up, forearms on the knees.
        rot(pose, 'spine', -0.2); rot(pose, 'chest', -0.12); rot(pose, 'head', -0.3);
        for (const s of ['L', 'R']) {
            rot(pose, `thigh_${s}`, 2); rot(pose, `shin_${s}`, -1.5); rot(pose, `foot_${s}`, -0.5);
            rot(pose, `upperArm_${s}`, 0.75); rot(pose, `foreArm_${s}`, 0.9);
        }
        return { drop: 0.6, fall: 0, lift: 0 };
    }
    // Legs and arms: a walking gait, or standing with the weight shifting.
    if (b.moving) {
        const stride = b.stride ?? 0.5, limp = b.limp ?? 0;
        const p = b.phase, a0 = Math.sin(p) * stride;
        rot(pose, 'thigh_L', a0 + limp * 0.55); rot(pose, 'thigh_R', -a0);
        const kneeL = 0.08 + 0.7 * Math.max(0, Math.cos(p)) + limp * 1.6;
        const kneeR = 0.08 + 0.7 * Math.max(0, -Math.cos(p));
        rot(pose, 'shin_L', -kneeL); rot(pose, 'shin_R', -kneeR);
        rot(pose, 'foot_L', -(a0 - kneeL) * 0.5); rot(pose, 'foot_R', -(-a0 - kneeR) * 0.5);
        rot(pose, 'upperArm_L', -0.7 * a0); rot(pose, 'upperArm_R', 0.7 * a0);
        rot(pose, 'foreArm_L', 0.15 + 0.35 * Math.max(0, -a0)); rot(pose, 'foreArm_R', 0.15 + 0.35 * Math.max(0, a0));
        rot(pose, 'hips', 0, -0.08 * a0); rot(pose, 'chest', -0.04, 0.12 * a0);
        // A person favouring one knee leans away from it and drops that shoulder.
        if (limp > 0) {
            rot(pose, 'hips', 0, 0, -0.5 * limp);
            rot(pose, 'spine', 0.4 * limp, 0, 0.35 * limp);
            rot(pose, 'head', 0, 0, 0.3 * limp);
        }
    } else {
        const sway = Math.sin(t * 0.5 + id * 1.9);
        const shiver = Math.sin(t * 14.0 + id * 3.7) * 0.012;
        rot(pose, 'hips', 0, 0, 0.03 * sway); rot(pose, 'chest', 0.012 * Math.sin(t * 1.5 + id), 0, -0.025 * sway + shiver);
        rot(pose, 'thigh_L', 0, 0, -0.03 * sway); rot(pose, 'thigh_R', 0, 0, -0.03 * sway);
        rot(pose, 'head', 0.04 * Math.sin(t * 0.37 + id) + shiver * 0.5, 0.35 * Math.sin(t * 0.21 + id * 1.3) + 0.1 * Math.sin(t * 0.9 + id), 0);
        rot(pose, 'foreArm_L', 0.15); rot(pose, 'foreArm_R', 0.15);
        rot(pose, 'upperArm_L', 0.03 * Math.sin(t * 0.8 + id), 0, -0.04); rot(pose, 'upperArm_R', 0.03 * Math.sin(t * 0.8 + id + 1), 0, 0.04);
    }
    // What the hands are doing overrides the swing.
    const arm = (s, up, fore, z = 0) => {
        const i = K[`upperArm_${s}`] * 3, j = K[`foreArm_${s}`] * 3;
        pose[i] = up; pose[i + 1] = 0; pose[i + 2] = z; pose[j] = fore;
    };
    if (b.pushing) {
        rot(pose, 'spine', -0.28); rot(pose, 'chest', -0.12); rot(pose, 'head', 0.25);
        arm('L', 1.35, 0.3, 0.12); arm('R', 1.25, 0.35, -0.12);
        if (!b.moving) { rot(pose, 'thigh_L', 0.4); rot(pose, 'shin_L', -0.25); rot(pose, 'thigh_R', -0.35); rot(pose, 'foot_R', 0.3); }
    }
    const strain = b.strain ?? 0;
    if (b.gun) { arm('R', 1.42, 0.08); arm('L', 1.2, 0.5, 0.4); rot(pose, 'head', -0.05, -0.1); }
    else if (a.police || b.shield) {
        if (b.shield) arm('L', 0.55 + 0.2 * strain, 1.0, 0.18); // shield up on the forearm
        else if (strain > 0.2) arm('L', 1.2, 0.4, 0.14);        // no shield: a hand out against the crowd
        else arm('L', 0.3, 0.55, 0.1);
        if (a.attacking > 0 && a.tool === 'baton') arm('R', 1.75, 0.15);
        else if (a.attacking > 0) arm('R', 1.45, 0.05, -0.15); // spray, arm out
        else arm('R', 0.35, 0.45);
        // Holding a line that is being leaned on: weight forward over the front foot, the back
        // leg straight behind, shoulder into the shield. The harder the push, the deeper it goes.
        if (strain > 0.1 && !b.moving) {
            rot(pose, 'spine', -0.2 * strain); rot(pose, 'chest', -0.08 * strain); rot(pose, 'head', 0.14 * strain);
            rot(pose, 'thigh_L', 0.38 * strain); rot(pose, 'shin_L', -0.3 * strain);
            rot(pose, 'thigh_R', -0.3 * strain); rot(pose, 'foot_R', 0.26 * strain);
        }
    } else if (b.gas) {
        // In the gas, or just sprayed: doubled over and coughing, a sleeve across the face. Both
        // hands go to the eyes after spray.
        const cough = Math.max(0, Math.sin(t * 7 + id * 1.3)) ** 4;
        rot(pose, 'spine', -0.3 - 0.12 * cough); rot(pose, 'chest', -0.12 - 0.08 * cough); rot(pose, 'head', -0.22 - 0.06 * cough);
        arm('L', 1.0, 2.2, 0.55);
        if (b.sprayed) arm('R', 1.0, 2.2, -0.55);
    } else if (b.filming) { arm('R', 1.45, 0.75, -0.2); rot(pose, 'head', 0.06); }
    else if (b.rinse) {
        // Out of the cloud: head back, a water bottle tipped over the eyes.
        rot(pose, 'head', 0.45); rot(pose, 'spine', 0.06);
        arm('R', 2.0, 1.7, -0.25);
    } else if (b.bearer) arm('R', 0.45 + Math.abs(b.wave ?? 0) * 1.2, 1.1, b.wave ?? 0);
    else if (b.chant >= 0 && !b.pushing) {
        // Chanting: a fist driven up on each beat and cocked back by the ear between them.
        arm('R', 2.2 + 0.55 * b.chant, 1.3 - 1.15 * b.chant, 0.08);
        rot(pose, 'head', 0.1 + 0.1 * b.chant); rot(pose, 'chest', 0.04 * b.chant);
    } else if (!b.moving && !b.pushing && b.idle === 1) {
        // Standing in the cold: arms folded across the chest.
        arm('L', 0.55, 1.75, 0.55); arm('R', 0.5, 1.85, -0.55); rot(pose, 'chest', -0.04);
    } else if (!b.moving && !b.pushing && b.idle === 2) {
        // Or hands in the coat pockets, shoulders up.
        arm('L', -0.08, 0.45, 0.14); arm('R', -0.08, 0.45, -0.14); rot(pose, 'chest', -0.05); rot(pose, 'neck', -0.06);
    }
    // Taking a round: the body answers the impact before it answers the player.
    if (a.stagger > 0 && b.hitK > 0) {
        const s = Math.min(1, a.stagger * 2.2) * b.hitK;
        const zone = a.hitZone ?? 'torso';
        const weight = zone === 'head' ? 1.4 : zone === 'limbs' ? 0.7 : 1;
        if (zone !== 'limbs') {
            rot(pose, 'spine', -0.32 * b.hitF * s * weight, 0, 0.22 * b.hitR * s * weight);
            rot(pose, 'chest', -0.18 * b.hitF * s * weight);
            rot(pose, 'neck', -0.2 * b.hitF * s * weight);
        }
        rot(pose, 'head', -0.45 * b.hitF * s * weight, 0, 0.26 * b.hitR * s * weight);
        rot(pose, 'upperArm_L', -0.55 * s, 0, -0.45 * s);
        rot(pose, 'upperArm_R', -0.45 * s, 0, 0.4 * s);
        rot(pose, 'foreArm_L', -0.2 * s); rot(pose, 'foreArm_R', -0.16 * s);
        // A catch step on the back foot, so the hit reads as weight rather than a nudge.
        if (s > 0.4) {
            rot(pose, 'thigh_L', -0.32 * s); rot(pose, 'shin_L', 0.4 * s);
            rot(pose, 'thigh_R', 0.24 * s); rot(pose, 'foot_R', -0.22 * s);
        }
    } else if (b.startleK > 0) {
        // A neighbour has just gone down: lean away and half-raise an arm.
        const s = b.startleK * 0.75;
        rot(pose, 'spine', -0.16 * b.startleF * s, 0, 0.3 * b.startleR * s);
        rot(pose, 'head', -0.22 * b.startleF * s, 0, 0.4 * b.startleR * s);
        rot(pose, 'upperArm_L', -0.22 * s, 0, -0.5 * s);
        rot(pose, 'upperArm_R', -0.18 * s, 0, 0.45 * s);
    }
    return { drop: 0, fall: 0, lift: 0 };
}

// Rest points of the hands' palms, where held things are anchored.
const PALM_R = [0.483, 0.76, -0.12], PALM_L = [-0.483, 0.76, -0.12];

/** The coat colour the far-crowd bake paints, so each sprite can be tinted to its own coat afterwards. */
const NEUTRAL_COAT = '#b0b0b0';

/**
 * @param palette  only for the far-crowd bake: 'neutral' paints every coat one grey, 'mask' draws
 *                 coats white and everything else black. Either one leaves the banners out.
 * @param detail   shared `{ value }` 0..1 for the cloth detail, so the quality governor can turn it down
 */
export function createCrowd(scene, capacity, { time, groundHeight, shadowTexture, figure, wind = null, signs = [], detail = { value: 1 }, palette = null }) {
    const parts = [], resources = new Set(), textures = new Set();
    const transform = new THREE.Object3D(), color = new THREE.Color();
    transform.rotation.order = 'YXZ';
    const held = new THREE.Object3D(), worn = new THREE.Matrix4(), boneWorld = new THREE.Matrix4();
    const anchor = new THREE.Vector3(), shift = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), fore = new THREE.Vector3(0, 0, 1);
    let extras = true;
    const mask = palette === 'mask';
    const rig = figure ?? fromRig(buildFigure());
    const bodies = createBodies(scene, rig, capacity, { detail, flat: mask });
    const maskBlack = new THREE.MeshBasicMaterial({ color: '#000000', fog: false }), maskWhite = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
    resources.add(maskBlack); resources.add(maskWhite);
    /**
     * Clothing and kit on top of the rigged body. A worn part follows its bone completely
     * (`offset` is its rest position on the figure). A held part (`anchor`) follows only the
     * point where it is held and stays upright, facing the way the person faces.
     * `extra` parts are the small ones nobody misses on a struggling device. `fit` ('front' or
     * 'back') moves a worn part out with the person's girth, so it sits on a heavy coat too.
     */
    function part(name, geometry, material, offset, scale = [1, 1, 1], filter = () => true, extra = false, more = {}) {
        resources.add(geometry); resources.add(material);
        const mesh = new THREE.InstancedMesh(geometry, mask ? (name === 'hood' ? maskWhite : maskBlack) : material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.castShadow = ['helmet', 'bike-helmet', 'hood', 'hard-hat', 'backpack', 'shield', 'flag-pole', 'beanie', 'cap'].includes(name);
        mesh.receiveShadow = name !== 'contact';
        scene.add(mesh);
        const item = { name, mesh, offset, scale, filter, extra, bone: -1, ...more };
        item.bone = bodies.boneOf(more.bone ?? 'chest');
        parts.push(item); return item;
    }
    const raider = a => !a.police && !a.civilian;

    // Police kit was uneven, and the record is clear that it was: Capitol Police mostly in their
    // ordinary dark uniform, some in soft caps with no shield at all; Metropolitan Police in
    // hi-vis jackets, the bicycle officers among them in cycle helmets; riot platoons in full
    // helmets behind shields; and the mutual aid that arrived through the afternoon in its own
    // colours, the last of it in camouflage. Which officer gets what is fixed by their number.
    const kits = new Map();
    const kit = a => {
        if (!a.police) return '';
        let value = kits.get(a.id);
        if (value === undefined) {
            value = a.id < 0 ? 'riot' : a.id >= 56 ? 'guard' : a.id >= 44 ? 'aid'
                : ['bike', 'riot', 'soft', 'riot', (a.line ?? 0) >= 2 ? 'soft' : 'helmet'][a.id % 5];
            kits.set(a.id, value);
        }
        return value;
    };
    const hiVis = a => a.police && a.id >= 0 && a.id < 44 && a.id % 5 < 2;
    const riotHelmet = a => a.police && kit(a) !== 'bike' && kit(a) !== 'soft';
    const shielded = a => !!a.hasShield || (a.police && (kit(a) === 'riot' || kit(a) === 'aid' || kit(a) === 'guard'));

    const hardHat = a => raider(a) && a.id % 12 === 5;
    const tricorn = a => raider(a) && a.id % 17 === 4;
    const ballCap = a => (raider(a) && a.id % 3 === 0 && !hardHat(a) && !tricorn(a)) || kit(a) === 'soft';
    const hood = a => raider(a) && a.id % 7 === 2 && !ballCap(a) && !hardHat(a) && !tricorn(a);
    const bareish = a => raider(a) && !ballCap(a) && !hardHat(a) && !tricorn(a) && !hood(a);
    const beanie = a => bareish(a) && a.id % 3 !== 2;
    const hair = a => (bareish(a) && a.id % 3 === 2) || a.civilian;
    const bearer = a => raider(a) && a.id >= 0 && a.id % 12 === 0 && a.health > 0;
    // Carried signage. The national flag and the blue campaign flag were everywhere, so they are
    // weighted to match; the rest are the other flags photographed that day and a random slice of
    // the placard list. One instanced mesh per distinct board keeps the draw-call count bounded,
    // and each bearer's board is fixed for the attempt by the same stable trait that sets their height.
    const bannerKinds = palette ? [] : [
        { kind: 'us', weight: 5 }, { kind: 'trump', weight: 5 }, { kind: 'trump-red', weight: 2 }, { kind: 'gadsden', weight: 2 },
        { kind: 'betsy', weight: 1 }, { kind: 'pine', weight: 1 }, { kind: 'line', weight: 1 },
        ...shuffledSigns(signs, 12).map(text => ({ kind: 'text', text, weight: 0.6 })),
    ];
    const bannerTotal = bannerKinds.reduce((sum, b) => sum + b.weight, 0);
    const bannerOf = new Map();
    const bannerIndex = a => {
        let index = bannerOf.get(a.id);
        if (index === undefined) {
            let pick = trait(a.id, 7) * bannerTotal;
            index = bannerKinds.findIndex(b => (pick -= b.weight) < 0);
            if (index < 0) index = bannerKinds.length - 1;
            bannerOf.set(a.id, index);
        }
        return index;
    };
    // A flag on a long pole, a short one, or a placard on a stick: nobody's is the same height.
    const poleScale = a => bannerKinds[bannerIndex(a)]?.kind === 'text' ? 0.7 : 0.8 + trait(a.id, 17) * 0.75;
    const filming = a => raider(a) && a.filming && a.health > 0 && !a.retreating;
    const gun = a => a.armed && a.health > 0 && (a.police || a.temperament === 'pusher' || (a.temperament === 'follower' && a.morale > 0.7));

    // What the crowd wore: puffers, fleece hoodies, camouflage, flannel, tan work jackets, and
    // plain winter coats for the rest. Fixed per person, and it decides the coat's colour too.
    const quilted = a => raider(a) && a.id >= 0 && a.id % 4 === 0;
    const fabrics = new Map();
    const fabric = a => {
        let value = fabrics.get(a.id);
        if (value === undefined) {
            const f = trait(a.id, 12);
            value = quilted(a) ? CLOTH.quilt : hood(a) ? CLOTH.fleece
                : f < 0.1 ? CLOTH.camo : f < 0.22 ? CLOTH.plaid : f < 0.42 ? CLOTH.canvas : CLOTH.plain;
            fabrics.set(a.id, value);
        }
        return value;
    };
    const flannel = ['#8a2f2c', '#2f4a6b', '#3d5a3a', '#7a5a2a'], duck = ['#8b6f47', '#6d5a3f', '#9a7b4f'];
    const raiderCoat = a => {
        const f = fabric(a);
        return f === CLOTH.camo ? '#5f6148' : f === CLOTH.plaid ? flannel[a.id % flannel.length]
            : f === CLOTH.canvas ? duck[a.id % duck.length] : coats[a.id % coats.length];
    };
    const coatColor = a => a.police ? (hiVis(a) ? '#c8d43a' : kit(a) === 'aid' ? '#4f5d75' : kit(a) === 'guard' ? '#666a4c' : '#24394d')
        : a.civilian ? suits[a.id % suits.length] : a.observer ? '#3f6f8f' : a.id < 0 ? '#bd713f' : raiderCoat(a);
    const skinColor = a => skins[Math.abs(a.id) % skins.length];
    const lipColor = a => lips[Math.abs(a.id) % lips.length];
    const hairColor = a => hairs[Math.abs(a.id * 3) % hairs.length];
    // About a third of the men in the photographs have beards. A few of the crowd, some officers
    // and half the staff have a mask or a gaiter pulled up: it was January 2021.
    const bearded = a => raider(a) && a.id >= 0 && trait(a.id, 14) < 0.34;
    const covered = a => a.civilian ? a.id % 2 === 0 : a.police ? a.id >= 0 && a.id % 4 === 1 : a.id >= 0 && trait(a.id, 14) > 0.9;
    const coverColor = a => a.civilian ? '#9fc3d8' : a.police ? '#1c2530' : ['#1c1d20', '#3b4a63', '#8a2f2c'][a.id % 3];
    const camoPants = a => raider(a) && a.id >= 0 && trait(a.id, 13) < 0.08;
    const pantsIndex = a => Math.abs(a.id) % pants.length;
    const vested = a => raider(a) && a.id >= 0 && a.id % 10 === 4;
    // Body regions, in rig.js REGIONS order. Hi-vis vests and medics' tabards are the coat's colour.
    const regionColors = [
        a => a.temperament === 'medic' ? '#f1efe8' : vested(a) ? '#c9e23c' : coatColor(a),
        coatColor,
        a => a.police ? (kit(a) === 'guard' ? '#666a4c' : '#1f2833') : a.civilian ? suits[a.id % suits.length] : camoPants(a) ? '#5a5c45' : pants[pantsIndex(a)],
        skinColor,
        a => a.police ? '#15181c' : a.civilian ? '#121315' : ['#2a2620', '#3d2c1f', '#1c1d1f'][Math.abs(a.id) % 3],
        a => a.police || (raider(a) && a.id % 3 === 0) ? '#202830' : skinColor(a),
        () => '#17120f',
        hairColor,
        a => covered(a) ? coverColor(a) : lipColor(a),
        a => covered(a) ? coverColor(a) : bearded(a) ? hairColor(a) : skinColor(a),
    ];
    const uniform = a => hiVis(a) ? CLOTH.hiVis : kit(a) === 'guard' ? CLOTH.camo : CLOTH.duty;
    const regionCloth = [
        a => a.police ? uniform(a) : vested(a) ? CLOTH.hiVis : raider(a) && a.id >= 0 && a.temperament !== 'medic' ? fabric(a) : CLOTH.plain,
        a => a.police ? uniform(a) : raider(a) && a.id >= 0 ? fabric(a) : CLOTH.plain,
        a => a.police ? (kit(a) === 'guard' ? CLOTH.camo : CLOTH.plain) : a.civilian ? CLOTH.plain
            : camoPants(a) ? CLOTH.camo : [0, 4, 5].includes(pantsIndex(a)) ? CLOTH.denim : CLOTH.plain,
        () => CLOTH.skin,
        () => CLOTH.hide,
        a => a.police || (raider(a) && a.id % 3 === 0) ? CLOTH.hide : CLOTH.skin,
        () => CLOTH.hide,
        () => CLOTH.hair,
        a => covered(a) ? CLOTH.fleece : CLOTH.skin,
        a => covered(a) ? CLOTH.fleece : bearded(a) ? CLOTH.hair : CLOTH.skin,
    ];
    const paint = (region, a) => mask ? (region < 2 ? '#ffffff' : '#000000')
        : palette === 'neutral' && region < 2 ? NEUTRAL_COAT : regionColors[region](a);
    /** A person's build, as weights for the figure's morph targets. Fixed for the day. */
    const buildOf = a => {
        const frame = trait(a.id, 3);
        const heavy = frame > 0.62 ? (frame - 0.62) / 0.38 : 0, slim = frame < 0.3 ? (0.3 - frame) / 0.3 : 0;
        if (a.police) return { jacket: 1, bulk: riotHelmet(a) ? 0.55 : 0.2, heavy: heavy * 0.6, slim: 0 };
        if (a.civilian) return { jacket: 0.62, bulk: 0, heavy: heavy * 0.7, slim: 0.2 + slim * 0.6 };
        const cut = trait(a.id, 16);
        return { jacket: cut < 0.5 ? 1 : cut < 0.8 ? 0.6 : 0, bulk: quilted(a) ? 1 : hood(a) ? 0.35 : 0.1, heavy, slim };
    };
    const fits = new Array(capacity).fill(null);
    const tints = {
        hood: a => color.set(palette === 'neutral' ? NEUTRAL_COAT : coatColor(a)).multiplyScalar(0.9),
        cap: a => color.set(a.police ? '#18233a' : a.id % 5 === 0 ? '#24324f' : '#a93737'),
        'cap-brim': a => color.set(a.police ? '#18233a' : a.id % 5 === 0 ? '#24324f' : '#a93737'),
        beanie: a => color.set(knits[(a.id * 7) % knits.length]),
        pom: a => color.set(knits[(a.id * 7 + 3) % knits.length]),
        scarf: a => color.set(knits[(a.id * 5 + 1) % knits.length]),
        hair: a => color.set(hairColor(a)),
        helmet: a => color.set(kit(a) === 'guard' ? '#4b5137' : '#1d242c'),
    };

    const cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: '#202830', roughness: 0.8 });
    const knit = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const dome = new THREE.SphereGeometry(0.26, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);

    // A soft dark patch under every figure: what keeps a crowd standing on the ground.
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const contact = part('contact', new THREE.PlaneGeometry(1, 1), shadowMaterial, [0, 0, 0], [0.95, 0.8, 1]);
    contact.mesh.layers.set(1);

    const head = { bone: 'head' };
    part('hair', dome, cloth, [0, 1.87, 0.02], [0.84, 0.75, 0.92], hair, false, head);
    part('beanie', dome, knit, [0, 1.9, 0.01], [0.86, 0.9, 0.9], beanie, false, head);
    part('pom', new THREE.SphereGeometry(0.07, 6, 4), knit, [0, 2.12, 0.01], [1, 1, 1], a => beanie(a) && a.id % 6 === 1, true, head);
    part('hood', dome, cloth, [0, 1.84, 0.05], [1.04, 1.12, 1.12], hood, false, head);
    part('scarf', new THREE.TorusGeometry(0.2, 0.065, 5, 12), knit, [0, 1.62, 0], [1, 1, 0.9],
        a => raider(a) && a.id % 4 === 1, true, { rot: Math.PI / 2, bone: 'neck' });
    part('cap', dome, cloth, [0, 1.93, 0.015], [0.84, 0.62, 0.88], ballCap, false, head);
    part('cap-brim', cube, cloth, [0, 1.94, -0.27], [0.34, 0.03, 0.2], ballCap, true, head);
    // The lettering on the front of the red caps: four words in white, too small to read from
    // any distance and unmistakable anyway.
    const capCanvas = document.createElement('canvas');
    capCanvas.width = 128; capCanvas.height = 56;
    const capCtx = capCanvas.getContext('2d');
    capCtx.fillStyle = '#ffffff'; capCtx.textAlign = 'center'; capCtx.font = 'bold 19px sans-serif';
    capCtx.fillText('MAKE AMERICA', 64, 24); capCtx.fillText('GREAT AGAIN', 64, 47);
    const capTexture = new THREE.CanvasTexture(capCanvas); capTexture.colorSpace = THREE.SRGBColorSpace; textures.add(capTexture);
    part('cap-print', new THREE.PlaneGeometry(0.17, 0.075), new THREE.MeshStandardMaterial({ map: capTexture, alphaTest: 0.4, roughness: 0.9 }),
        [0, 1.985, -0.218], [1, 1, 1], a => ballCap(a) && raider(a) && a.id % 5 !== 0, true, { ...head, rot: 0.35, yaw: Math.PI });
    part('hard-hat', dome, new THREE.MeshStandardMaterial({ color: '#e7c531', roughness: 0.5 }), [0, 1.92, 0.01], [0.98, 0.95, 1.02], hardHat, false, head);
    part('tricorn', new THREE.CylinderGeometry(0.36, 0.4, 0.13, 3), dark, [0, 2.02, 0], [1, 1, 1], tricorn, false, head);
    // Glasses, as a dark band across the eyes.
    part('glasses', cube, new THREE.MeshStandardMaterial({ color: '#0e1012', roughness: 0.2, metalness: 0.3 }), [0, 1.84, -0.2], [0.33, 0.05, 0.04],
        a => (raider(a) && a.id >= 0 && trait(a.id, 15) < 0.16) || (a.civilian && a.id % 5 === 1), true, head);
    part('backpack', cube, dark, [0, 1.28, 0.36], [0.5, 0.6, 0.24], a => raider(a) && a.id >= 0 && a.id % 5 === 2, true, { fit: 'back' });
    // Street medics: a red patch on the white tabard. A role in the crowd, not a uniform.
    part('medic-patch', cube, new THREE.MeshStandardMaterial({ color: '#c1373c', roughness: 0.9 }),
        [0, 1.3, -0.268], [0.24, 0.24, 0.02], a => a.temperament === 'medic', true, { fit: 'front' });
    // Phones held up to film, in the raised right hand: the single most common thing in every
    // photograph of the day. The screen glows enough to bloom.
    const right = { bone: 'hand_R', anchor: PALM_R }, left = { bone: 'hand_L', anchor: PALM_L };
    part('phone', cube, new THREE.MeshStandardMaterial({ color: '#10161d', emissive: '#9cc8f0', emissiveIntensity: 1.6 }),
        [-0.03, 0.09, -0.04], [0.1, 0.19, 0.02], filming, true, right);
    // A water bottle, tipped over the eyes by someone who has just come out of the gas.
    part('bottle', new THREE.CylinderGeometry(0.033, 0.033, 0.21, 7),
        new THREE.MeshStandardMaterial({ color: '#cfe3ee', roughness: 0.25, transparent: true, opacity: 0.75 }),
        [0, 0.08, -0.03], [1, 1, 1], (a, b) => b.rinse, true, { ...right, rot: 2.2 });
    part('helmet', new THREE.SphereGeometry(0.29, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.65),
        new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.2 }), [0, 1.91, 0], [0.9, 1, 0.95], riotHelmet, false, head);
    // A cycle helmet: lower and longer than a riot helmet, no visor.
    part('bike-helmet', dome, new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.45 }), [0, 1.93, 0.02], [0.9, 0.7, 1.12],
        a => kit(a) === 'bike', false, head);
    const clear = createPolycarbonateMaterial({ color: '#c4e0ea', opacity: 0.42, roughness: 0.08, dispersion: 0.04 });
    part('visor', cube, clear, [0, 1.86, -0.25], [0.46, 0.32, 0.05], riotHelmet, false, head);
    part('vest', cube, dark, [0, 1.2, -0.25], [0.67, 0.64, 0.12], a => (a.police && !hiVis(a)) || (raider(a) && a.id >= 0 && a.id % 8 === 3),
        false, { fit: 'front' });
    // Gas masks: about one officer in three in riot kit had one on once the gas was out, and so
    // did a few in the crowd who had come expecting it. A dark facepiece with a filter on the left cheek.
    const masked = a => a.health > 0 && ((riotHelmet(a) && a.id % 3 === 0) || (raider(a) && a.id >= 0 && a.id % 23 === 9));
    part('gas-mask', cube, dark, [0, 1.76, -0.245], [0.24, 0.19, 0.1], masked, false, head);
    part('gas-mask-filter', new THREE.CylinderGeometry(0.055, 0.055, 0.1, 8), new THREE.MeshStandardMaterial({ color: '#4a4f45', roughness: 0.6 }),
        [0.1, 1.71, -0.29], [1, 1, 1], masked, true, head);
    // Flags worn as capes, knotted at the neck: as common in the photographs as flags on poles.
    const cape = a => raider(a) && a.id >= 0 && a.id % 11 === 6 && a.id % 5 !== 2;
    for (const [kind, pick] of [['us', a => cape(a) && a.id % 3 === 1], ['trump', a => cape(a) && a.id % 3 === 2], ['gadsden', a => cape(a) && a.id % 3 === 0]]) {
        const texture = flagTexture(kind); textures.add(texture);
        part('cape', cube, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 }), [0, 1.14, 0.245], [0.62, 0.86, 0.025], pick, true, { fit: 'back' });
    }
    part('shield', cube, clear, [0.1, -0.1, -0.08], [0.9, 1.45, 0.09], (a, b) => b.shield, false, left);
    part('shield-edge', cube, dark, [0.1, -0.81, -0.08], [0.92, 0.07, 0.11], (a, b) => b.shield, true, left);
    const shieldCanvas = document.createElement('canvas');
    shieldCanvas.width = 256; shieldCanvas.height = 64;
    const ctx = shieldCanvas.getContext('2d');
    ctx.fillStyle = '#203046'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('POLICE', 128, 49);
    const shieldTexture = new THREE.CanvasTexture(shieldCanvas); textures.add(shieldTexture);
    part('police-label', new THREE.PlaneGeometry(0.75, 0.2), new THREE.MeshBasicMaterial({ map: shieldTexture, side: THREE.DoubleSide }),
        [0.1, 0.05, -0.135], [1, 1, 1], (a, b) => a.police && b.shield, true, { ...left, yaw: Math.PI });
    part('baton', new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), dark, [0, 0, -0.04], [1, 1, 1], a => a.police && !a.armed,
        false, { ...right, rot: -0.5 });
    // Armed demo only: a plain dark block held forward. No real model is depicted.
    part('gun', cube, dark, [-0.02, 0.05, -0.2], [0.07, 0.13, 0.5], gun, false, right);
    if (bannerKinds.length) {
        part('flag-pole', new THREE.CylinderGeometry(0.025, 0.025, 3.2, 5),
            new THREE.MeshStandardMaterial({ color: '#b7a587' }), [0, 0.95, 0], [1, 1, 1], bearer, false, right);
    }
    for (let i = 0; i < bannerKinds.length; i++) {
        const { kind, text } = bannerKinds[i];
        const texture = flagTexture(kind, text); textures.add(texture);
        const board = addWave(new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.9 }), time, { wind });
        // One double-sided plane means the face seen from behind shows the texture mirrored, so
        // every slogan read backwards from behind the crowd. Flip the sample on back faces only.
        const wave = board.onBeforeCompile;
        board.onBeforeCompile = (shader, renderer) => {
            wave?.call(board, shader, renderer);
            shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
                if (!gl_FrontFacing) diffuseColor.rgb = texture2D(map, vec2(1.0 - vMapUv.x, vMapUv.y)).rgb;`);
        };
        board.customProgramCacheKey = () => 'pocapitol-wave-board';
        const flag = part('flag', new THREE.PlaneGeometry(1.7, 1.1, 16, 6), board,
            [0.86, 1.98, 0], [1, 1, 1], a => bearer(a) && bannerIndex(a) === i, false, right);
        flag.mesh.layers.set(1);
    }
    // Snow settling on shoulders and hats: not falling snow, the thin rime that builds up on a
    // person who has been out in it for an hour. A pale cap that grows with time outdoors.
    const rime = new THREE.MeshStandardMaterial({ color: '#e9eef2', transparent: true, opacity: 0.34, roughness: 0.92 });
    part('rime', dome, rime, [0, 1.96, 0.01], [1.03, 1.02, 1.02], a => !a.police && a.health > 0 && (a.z ?? 0) > 15, true, head);
    part('rime-shoulders', new THREE.TorusGeometry(0.24, 0.035, 4, 12), rime, [0, 1.46, 0], [1, 1, 0.85],
        a => a.health > 0 && (a.z ?? 0) > 15, true, { rot: Math.PI / 2 });
    // Breath in the cold: a small puff in front of each face outdoors, there and gone.
    const breath = part('breath', new THREE.SphereGeometry(0.11, 6, 5),
        new THREE.MeshBasicMaterial({ color: '#f3f6f8', transparent: true, opacity: 0.2, depthWrite: false }),
        [0, 0, -0.22], [1, 1, 1], a => a.health > 0 && a.z > 15.5, true, { bone: 'head', anchor: [0, 1.78, -0.2] });
    breath.mesh.layers.set(1);

    const pose = new Float32Array(RIG_BONES.length * 3);
    const slotFigure = Array.from({ length: capacity }, () => new THREE.Matrix4());
    // Death dynamics per body, the pose it settled into, the spot it came to rest on, and the
    // heading the eye sees, so a field of bodies costs nothing and a heap does not lie in one place.
    const falls = new Map(), settledPose = new Map(), restSpots = new Map(), yawOf = new Map();
    // When each person was last in gas or spray, for the minute of coughing and rinsing after it.
    const lastGas = new Map();
    let lastNow = 0;
    /** How hard the line an officer stands in is being leaned on, 0..1. */
    function officerStrain(state, a) {
        const line = state.lines?.[a.line];
        return line ? Math.min(1, (line.pressure ?? 0) / Math.max(1, line.hold ?? 1)) : 0;
    }
    function update(state, humanHeading, humanMoving, cameraPosition) {
        const actors = [
            ...(state.role !== 'none' ? [{ ...state.player, id: -1, health: state.health, heading: humanHeading,
                moving: humanMoving, police: state.role === 'police', observer: state.role === 'observer', key: 'h' }] : []),
            ...(state.armed ? state.companions.map(c => ({ ...c, armed: true })) : state.companions),
            ...state.enemies.map(e => ({ ...e, police: true, armed: state.armed, key: `p${e.id}` })),
            // Staff and members in the chamber: plain suits, no equipment, health never changes.
            ...state.civilians.filter(p => !p.evacuated).map(p => ({ ...p, id: p.id + 1000, health: 1, civilian: true })),
        ];
        if (actors.length > capacity) throw new RangeError('Crowd renderer capacity exceeded.');
        const active = state.status === 'active';
        const now = state.elapsed ?? 0;
        const dt = Math.min(0.1, Math.max(0.008, now - lastNow));
        // The clock running backwards is a new attempt: nobody is still coughing from the last one.
        if (now < lastNow) lastGas.clear();
        lastNow = now;
        const gasClouds = (state.effects ?? []).filter(e => e.type === 'gas');
        // The chant's three beats and a rest, the same 1.75 s bar the sound plays.
        const bar = now % 1.75;
        let chantBeat = 0;
        for (let k = 0; k < 3; k++) chantBeat = Math.max(chantBeat, Math.exp(-(((bar - 0.1 - k * 0.42) / 0.1) ** 2)));
        // Per-actor body: build, ground, gait and pose. Worked out once, used by the body and every part.
        const people = [];
        for (const a of actors) {
            if (Math.hypot(a.x - cameraPosition.x, a.z - cameraPosition.z) < 1.1) continue;
            const tall = a.police ? 0.98 + trait(a.id, 1) * 0.09 : 0.93 + trait(a.id, 1) * 0.14;
            const wide = a.police ? 1.02 + trait(a.id, 2) * 0.1 : 0.9 + trait(a.id, 2) * 0.2;
            const moving = active && a.moving && a.health > 0;
            const gait = a.id >= 0 ? gaitOf(a.id) : GAIT_DEFAULT;
            const phase = state.elapsed * 9 * gait.cadence + a.id * 0.7;
            const floor = groundHeight(a.x, a.z);
            const b = { a, tall, wide, floor, moving, phase, stride: gait.stride, limp: gait.limp, ground: floor + (moving ? Math.abs(Math.cos(phase)) * 0.045 : 0),
                pushing: raider(a) && a.attacking > 0 && a.health > 0, filming: filming(a), bearer: bearer(a), gun: gun(a),
                lying: a.health <= 0 && state.armed, stooped: a.health <= 0 && !state.armed && a.helped && !a.resting };
            const key = a.key ?? (a.civilian ? `s${a.id}` : `r${a.id}`);
            b.slot = bodies.claim(key);
            const alive = a.health > 0;
            b.shield = alive && shielded(a);
            b.strain = a.police && alive && !moving ? officerStrain(state, a) : 0;
            // Gas and spray: coughing while in it, and for some a bottle over the eyes afterwards.
            const inGas = alive && !a.police && gasClouds.some(e => Math.hypot(a.x - e.x, a.z - e.z) < e.r);
            b.sprayed = alive && (a.sprayed ?? 0) > 0;
            b.gas = inGas || b.sprayed;
            if (b.gas) lastGas.set(key, now);
            const sinceGas = now - (lastGas.get(key) ?? -99);
            b.rinse = alive && !b.gas && !moving && sinceGas > 1.5 && sinceGas < 14 && raider(a) && trait(a.id, 18) < 0.6;
            b.wave = b.bearer ? Math.sin(now * 2.1 + a.id) * (0.1 + 0.16 * (a.morale ?? 0.6)) : 0;
            // People chant in patches, not all at once: a bout comes and goes across the crowd.
            const chanting = a.chanting ?? (alive && raider(a) && a.id >= 0 && !b.pushing && !b.filming && !b.bearer && !b.gas && !b.rinse
                && (a.morale ?? 0) > 0.55 && trait(a.id, 11) < 0.3
                && Math.sin(now * 0.21 + Math.floor(a.x / 14) * 1.3 + Math.floor(a.z / 18)) > -0.2);
            b.chant = chanting ? chantBeat : -1;
            const habit = trait(a.id, 19);
            b.idle = raider(a) && a.id >= 0 && !b.filming ? (habit < 0.24 ? 1 : habit < 0.5 ? 2 : 0) : 0;
            // People turn rather than snap: the simulated heading is eased for the eye only.
            const wantYaw = a.heading || 0, wasYaw = yawOf.get(key);
            b.yaw = wasYaw === undefined ? wantYaw
                : wasYaw + Math.atan2(Math.sin(wantYaw - wasYaw), Math.cos(wantYaw - wasYaw)) * (1 - Math.exp(-dt * 8));
            yawOf.set(key, b.yaw);
            const regionKey = `${key}${a.police ? 'p' : ''}${a.observer ? 'o' : ''}${a.temperament ?? ''}`;
            if (bodies.stale(b.slot, regionKey)) {
                const build = buildOf(a), girth = (1 + 0.12 * build.bulk) * (1 - 0.09 * build.slim);
                fits[b.slot] = { front: girth * (1 + 0.16 * build.heavy), back: girth * (1 + 0.08 * build.heavy) };
                bodies.dress(b.slot, regionKey, region => color.set(paint(region, a)), region => regionCloth[region](a), build);
            }
            b.fit = fits[b.slot];
            // Where the round came from, in the body's own frame, so a flinch or a fall leans the
            // way the impact did however the person happens to be facing.
            const knock = Math.hypot(a.kx ?? 0, a.kz ?? 0);
            const hx = a.ix ?? 0, hz = a.iz ?? 0;
            const hlen = Math.hypot(hx, hz);
            if (hlen > 0.01 || knock > 0.02) {
                const dx = hlen > 0.01 ? hx / hlen : (a.kx ?? 0) / knock;
                const dz = hlen > 0.01 ? hz / hlen : (a.kz ?? 0) / knock;
                const push = impactFrame(dx, dz, a.heading || 0);
                b.hitF = push.fw; b.hitR = push.rt;
                b.hitK = a.hitPower ?? Math.min(1, knock * 2);
            } else b.hitK = 0;
            // Someone dropped next to you: a short lean away, with no effect on the simulation.
            if (a.startle !== undefined && now - a.startle >= 0 && now - a.startle < 0.55) {
                const h = a.heading || 0;
                const dx = a.startleDx ?? 0, dz = a.startleDz ?? 0;
                b.startleK = 1 - (now - a.startle) / 0.55;
                b.startleF = -(dx * Math.sin(h) + dz * Math.cos(h));
                b.startleR = dx * Math.cos(h) - dz * Math.sin(h);
            }
            if (b.lying) {
                let fall = falls.get(key);
                if (!fall) {
                    const h = a.heading || 0;
                    const frame = impactFrame(hx, hz, h);
                    // Bodies already on the ground nearby decide the heap this one joins.
                    const rest = restPlace(a.x, a.z, [...restSpots.values()]);
                    fall = {
                        t0: now, rel: frame.rel, rest,
                        seed: trait(a.id, 5), zone: a.hitZone ?? 'torso', how: null,
                    };
                    restSpots.set(key, { x: a.x, z: a.z, layer: rest.layer });
                    falls.set(key, fall);
                }
                b.fall = fall;
            } else { falls.delete(key); settledPose.delete(key); restSpots.delete(key); }
            // A body that has settled no longer needs its pose worked out again every frame.
            const settled = b.fall && now - b.fall.t0 > 1.3 ? settledPose.get(key) : null;
            const how = settled ? (pose.set(settled), b.fall.how) : poseFor(b, a, now, pose);
            if (b.fall && !settled && now - b.fall.t0 > 1.3) {
                settledPose.set(key, pose.slice()); b.fall.how = how;
            }
            // A body that has fallen rests where the heap allows: pushed out of its neighbours,
            // lifted onto the layer beneath it, and rolled. A standing officer rocks on his feet
            // under the weight of the line, harder the more he is being leaned on.
            const rest = b.fall?.rest;
            const strain = b.strain;
            const brace = strain ? Math.sin(now * (1.4 + strain * 2.5) + (a.id || 0) * 1.7) * (0.012 + strain * 0.045) : 0;
            // Blast lift and the rise over a body on the ground: feet clear what is underfoot.
            // A body that has fallen lies on the deck: its height is the floor plus the thickness
            // of one body, whatever the heap maths or a blast arc wanted to add.
            const lift = Math.max(0, a.y ?? 0) + Math.max(0, a.step ?? 0);
            const y = b.lying
                ? b.ground + 0.06 + Math.min(0.12, rest?.height ?? 0)
                : b.ground + lift - how.drop * tall + how.lift * wide + (rest?.height ?? 0);
            transform.position.set(a.x + (rest?.dx ?? 0), y, a.z + (rest?.dz ?? 0));
            transform.rotation.set(how.fall + brace + ((a.y ?? 0) > 0.05 && !b.lying ? (a.spin ?? 0) * 0.5 : 0), b.yaw, (how.lean || 0) + (rest?.roll ?? 0));
            transform.scale.set(wide, tall, wide);
            const figureMatrix = slotFigure[b.slot].compose(transform.position, transform.quaternion, transform.scale);
            bodies.pose(b.slot, figureMatrix, pose);
            people.push(b);
        }
        bodies.finish();
        for (const p of parts) {
            let count = 0;
            if (p.extra && !extras) { p.mesh.count = 0; continue; }
            for (const b of people) {
                const a = b.a;
                if (!p.filter(a, b)) continue;
                const h = b.yaw ?? (a.heading || 0);
                if (p.name === 'contact') {
                    // Out of the scenario figures sit or lie, so their shadow spreads.
                    const spread = a.health > 0 ? 1 : b.lying ? 1.6 : 1.3;
                    transform.position.set(a.x, b.floor + 0.015, a.z);
                    if (b.lying) transform.position.add(shift.set(0, 0, 0.75 * b.tall).applyAxisAngle(up, h));
                    transform.rotation.set(-Math.PI / 2, h, 0);
                    transform.scale.set(p.scale[0] * b.wide * (b.lying ? 1 : spread), p.scale[1] * b.wide * spread * (b.lying ? 1.5 : 1), 1);
                    transform.updateMatrix();
                    worn.copy(transform.matrix);
                } else if (p.anchor) {
                    if (a.health <= 0) continue;
                    if (p.bone >= 0) bodies.boneMatrix(b.slot, p.bone, boneWorld); else boneWorld.copy(slotFigure[b.slot]);
                    anchor.fromArray(p.anchor).applyMatrix4(boneWorld);
                    transform.scale.set(p.scale[0] * b.wide, p.scale[1] * b.tall, p.scale[2] * b.wide);
                    if (p.name === 'flag' || p.name === 'flag-pole') {
                        // A pole of this bearer's own length, swung from the hand as it is waved.
                        // The cloth hangs off the top of the pole and streams downwind, whichever
                        // way the person carrying it faces, so it turns about the pole, not its middle.
                        const reach = poleScale(a), top = -0.65 + 3.2 * reach;
                        const along = p.name === 'flag' ? top - 0.57 : (top - 0.65) / 2;
                        shift.set(0, along * b.tall, 0).applyAxisAngle(fore, b.wave).applyAxisAngle(up, h);
                        transform.position.copy(anchor).add(shift);
                        transform.rotation.set(0, h, b.wave);
                        if (p.name === 'flag-pole') transform.scale.y *= reach;
                        else {
                            const wx = wind?.x ?? 0, wz = wind?.z ?? 0;
                            const windYaw = Math.atan2(-wx, -wz);
                            const blend = Math.min(0.85, Math.hypot(wx, wz) / 9);
                            const dy = Math.atan2(Math.sin(windYaw - h), Math.cos(windYaw - h));
                            const yaw = h + dy * blend + 0.05 * Math.sin(state.elapsed * 1.7 + a.id);
                            transform.rotation.set(0, yaw, b.wave * 0.5);
                            transform.position.x += Math.cos(yaw) * 0.86 * b.wide;
                            transform.position.z -= Math.sin(yaw) * 0.86 * b.wide;
                            // Nearby banners must not fill the entire third-person camera.
                            if (transform.position.distanceTo(cameraPosition) < 4) continue;
                        }
                        transform.updateMatrix();
                        p.mesh.setMatrixAt(count++, transform.matrix);
                        continue;
                    }
                    shift.set(p.offset[0] * b.wide, p.offset[1] * b.tall, p.offset[2] * b.wide).applyAxisAngle(up, h);
                    transform.position.copy(anchor).add(shift);
                    transform.rotation.set(p.rot || 0, h + (p.yaw || 0), 0);
                    if (p.name === 'baton' && a.attacking > 0 && a.tool === 'baton') transform.rotation.x = -1.3;
                    if (p.name === 'breath') {
                        const phase = (state.elapsed * 0.45 + a.id * 0.37) % 1;
                        if (phase > 0.4) continue;
                        transform.scale.setScalar(0.5 + phase * 3);
                        transform.position.y += phase * 0.5;
                        // Breath is warm air: the wind takes it before it has gone anywhere.
                        transform.position.x += (wind?.x ?? 0) * phase * 0.35;
                        transform.position.z += (wind?.z ?? 0) * phase * 0.35;
                    }
                    transform.updateMatrix();
                    worn.copy(transform.matrix);
                } else {
                    if (p.bone >= 0) bodies.boneMatrix(b.slot, p.bone, boneWorld); else boneWorld.copy(slotFigure[b.slot]);
                    held.position.fromArray(p.offset);
                    if (p.fit) held.position.z *= b.fit?.[p.fit] ?? 1;
                    held.rotation.set(p.rot || 0, p.yaw || 0, 0);
                    held.scale.fromArray(p.scale);
                    if (p.name === 'rime' || p.name === 'rime-shoulders') {
                        // Rime builds on a person who has been out in it, then holds.
                        const build = Math.min(1, Math.max(0, (state.elapsed - 20) / 400));
                        if (build <= 0.01) continue;
                        held.scale.multiplyScalar(0.55 + 0.45 * build);
                    }
                    held.updateMatrix();
                    worn.multiplyMatrices(boneWorld, held.matrix);
                }
                p.mesh.setMatrixAt(count, worn);
                const tint = mask ? null : tints[p.name];
                if (tint) { tint(a); p.mesh.setColorAt(count, color); }
                count++;
            }
            p.mesh.count = count;
            p.mesh.instanceMatrix.needsUpdate = true;
            if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
        }
        return actors.length;
    }
    function dispose() {
        bodies.dispose();
        parts.forEach(p => { scene.remove(p.mesh); p.mesh.dispose(); });
        resources.forEach(r => r.dispose()); textures.forEach(t => t.dispose());
    }
    return { update, dispose, setExtras(value) { extras = value; }, batchCount: parts.length + 1 };
}

// ---------------------------------------------------------------- the crowd that stayed outside

const CELLS = 8, COAT = 'coat';
/**
 * Eight painted figures for the unsimulated far crowd, as two atlases: the paint (skin, jeans,
 * hats, phones, flags) and a coat mask, so each instance can wear its own coat colour without
 * a colour key that bleeds at the sprite's edge.
 */
function peopleAtlas() {
    const looks = [
        { hat: 'beanie', skin: 0, legs: 0, knit: 0 }, { hat: 'cap', skin: 1, legs: 1, phone: true },
        { hat: 'hood', skin: 2, legs: 3 }, { hat: 'none', skin: 3, legs: 2, hair: 1, flag: '#2b477a' },
        { hat: 'beanie', skin: 4, legs: 4, knit: 1, phone: true }, { hat: 'cap', skin: 0, legs: 5, flag: '#b23a40' },
        { hat: 'none', skin: 1, legs: 0, hair: 3 }, { hat: 'beanie', skin: 3, legs: 1, knit: 3, flag: '#e8c53a' },
    ];
    const draw = mask => {
        const canvas = document.createElement('canvas');
        canvas.width = 64 * CELLS; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        const paint = fill => mask ? (fill === COAT ? '#ffffff' : '#000000') : (fill === COAT ? '#8f8f8f' : fill);
        const round = (x, y, w, h, r, fill) => { ctx.fillStyle = paint(fill); ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); };
        const circle = (x, y, r, fill) => { ctx.fillStyle = paint(fill); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
        const rect = (x, y, w, h, fill) => { ctx.fillStyle = paint(fill); ctx.fillRect(x, y, w, h); };
        looks.forEach((look, i) => {
            const cx = i * 64 + 32, skinTone = skins[look.skin];
            for (const side of [-1, 1]) {
                round(cx + side * 5 - 4, 82, 8, 42, 3, pants[look.legs]);
                round(cx + side * 5 - 5, 119, 10, 6, 2, '#1c1d1f');
            }
            round(cx - 15, 34, 30, 54, 9, COAT);
            round(cx - 21, 38, 8, 40, 4, COAT);
            circle(cx - 17, 80, 3.5, skinTone);
            if (look.phone || look.flag) {
                round(cx + 13, 8, 8, 34, 4, COAT);
                circle(cx + 17, 8, 3.5, skinTone);
                if (look.phone) round(cx + 13, -1, 8, 10, 1, '#10161d');
            } else {
                round(cx + 13, 38, 8, 40, 4, COAT);
                circle(cx + 17, 80, 3.5, skinTone);
            }
            if (look.flag) { rect(cx + 16, 0, 2, 14, '#8d7d62'); rect(cx + 18, 0, 24, 14, look.flag); }
            round(cx - 4, 30, 8, 8, 2, skinTone);
            circle(cx, 23, 9.5, skinTone);
            if (look.hat === 'beanie') round(cx - 10, 11, 20, 11, 5, knits[look.knit]);
            else if (look.hat === 'cap') { round(cx - 10, 12, 20, 9, 4, '#a93737'); rect(cx - 14, 18, 8, 3, '#a93737'); }
            else if (look.hat === 'hood') { round(cx - 13, 10, 26, 26, 11, COAT); circle(cx, 25, 7.5, skinTone); }
            else round(cx - 10, 12, 20, 9, 5, hairs[look.hair]);
        });
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = mask ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        return texture;
    };
    return { map: draw(false), mask: draw(true) };
}

/**
 * Thousands of figures as upright sprites: one draw call for the people and one for their
 * contact shadows. Each sprite is turned to the camera in the vertex shader and sways a little.
 *
 * With a baked `atlas` (bakeImpostors) the sprites are pictures of the game's own rigged figure:
 * each one shows whichever of four sides faces the camera, wears its own coat colour, and punches
 * the air on the chant's beats. Without one they fall back to eight painted figures.
 *
 * A spot is { x, y, z, scale, coat, cell, face }: `face` is the heading the person stands at.
 */
export function createDistantCrowd(scene, spots, { time, shadowTexture, atlas = null }) {
    const count = spots.length, painted = atlas ? null : peopleAtlas();
    const { map, mask } = atlas ?? painted;
    const cols = atlas?.cols ?? CELLS, views = atlas?.views ?? 1, frames = atlas?.frames ?? 1;
    const [wide, tall] = atlas?.size ?? [0.95, 1.9];
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0, 0.5, 0);
    const cells = new Float32Array(count), faces = new Float32Array(count);
    const light = { value: 1 };
    const material = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, fog: true });
    material.onBeforeCompile = shader => {
        shader.uniforms.uTime = time;
        shader.uniforms.uLight = light;
        shader.uniforms.uCoat = { value: mask };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aCell;\nattribute float aFace;\nuniform float uTime;')
            .replace('#include <uv_vertex>', `#include <uv_vertex>
                vec3 dcAt = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                vec3 dcTo = cameraPosition - dcAt;
                // Which side of the person the camera is on, in quarter turns from their back.
                float dcView = mod(floor((atan(dcTo.x, dcTo.z) + aFace) / 1.5707963 + 0.5), ${views}.0);
                // The second frame is the fist in the air: up on each of the bar's three beats,
                // in whichever patches of the crowd are chanting just now.
                float dcBar = mod(uTime, 1.75);
                float dcBeat = step(dcBar, 1.26) * step(fract(dcBar / 0.42), 0.55)
                    * step(-0.2, sin(uTime * 0.21 + floor(dcAt.x / 14.0) * 1.3 + floor(dcAt.z / 18.0)));
                float dcRow = dcView + ${frames > 1 ? 'dcBeat' : '0.0'} * ${views}.0;
                vMapUv = vec2((vMapUv.x + aCell) / ${cols}.0, (vMapUv.y + dcRow) / ${views * frames}.0);`)
            .replace('#include <project_vertex>', `
                float swayPhase = aCell * 2.1 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
                transformed.x += sin(uTime * 1.3 + swayPhase) * ${atlas ? '0.012' : '0.025'} * transformed.y;
                transformed.y += max(0.0, sin(uTime * 2.2 + swayPhase * 3.0)) * ${atlas ? '0.008' : '0.02'};
                ${billboardChunk(true)}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uLight;\nuniform sampler2D uCoat;')
            .replace('#include <color_fragment>', atlas ? `
                #ifdef USE_COLOR
                    // The bake lit a neutral grey coat; scaling it by this person's colour keeps the folds and shading.
                    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vColor * ${(1 / atlas.neutral).toFixed(3)}, texture2D(uCoat, vMapUv).r);
                #endif
                diffuseColor.rgb *= uLight * 1.09;` : `
                #ifdef USE_COLOR
                    diffuseColor.rgb = mix(diffuseColor.rgb, vColor * 0.9, texture2D(uCoat, vMapUv).r);
                #endif
                diffuseColor.rgb *= uLight;`);
    };
    material.customProgramCacheKey = () => `pocapitol-far-crowd-${atlas ? `${cols}x${views}x${frames}` : 'painted'}`;
    const people = new THREE.InstancedMesh(geometry, material, count);
    const shadowGeometry = new THREE.PlaneGeometry(1, 1);
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, count);
    const pose = new THREE.Object3D(), tint = new THREE.Color();
    spots.forEach((spot, i) => {
        // A baked cell has a little ground under the feet; a painted one stands on its edge.
        pose.position.set(spot.x, spot.y - (atlas ? atlas.foot * spot.scale : 0), spot.z); pose.rotation.set(0, 0, 0);
        pose.scale.set(wide * spot.scale, tall * spot.scale, 1); pose.updateMatrix();
        people.setMatrixAt(i, pose.matrix);
        people.setColorAt(i, tint.set(coats[spot.coat % coats.length]));
        cells[i] = spot.cell % cols;
        faces[i] = spot.face ?? 0;
        pose.position.y = spot.y + 0.015; pose.rotation.set(-Math.PI / 2, 0, 0);
        pose.scale.set(0.9 * spot.scale, 0.75 * spot.scale, 1); pose.updateMatrix();
        shadows.setMatrixAt(i, pose.matrix);
    });
    geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 1));
    geometry.setAttribute('aFace', new THREE.InstancedBufferAttribute(faces, 1));
    for (const mesh of [people, shadows]) {
        mesh.frustumCulled = false;
        mesh.layers.set(1);
        scene.add(mesh);
    }
    return {
        setCount(n) { people.count = shadows.count = Math.max(0, Math.min(count, n)); },
        setLight(level) { light.value = level; },
        dispose() {
            for (const mesh of [people, shadows]) { scene.remove(mesh); mesh.dispose(); }
            geometry.dispose(); shadowGeometry.dispose(); material.dispose(); shadowMaterial.dispose();
            // A baked atlas belongs to whoever baked it, and may be shared between crowds.
            painted?.map.dispose(); painted?.mask.dispose();
        },
    };
}

// The people the far crowd is made of: twelve of the crowd's own, chosen for a spread of hats,
// hoods, coats and builds. Nobody here carries a banner (those are drawn separately).
const IMPOSTOR_IDS = [1, 2, 3, 5, 7, 9, 13, 15, 16, 22, 26, 33];
const IMPOSTOR_CELL = [1.3, 2.6], IMPOSTOR_PIXELS = [128, 256], IMPOSTOR_VIEWS = 4, IMPOSTOR_FRAMES = 2, IMPOSTOR_FOOT = 0.06;

/**
 * Photographs the rigged figure for the far crowd: twelve people, each from four sides, standing
 * and with a fist in the air, into one atlas, plus a second atlas marking which pixels are coat.
 *
 * It is taken inside the real scene, high above the dome, so the sprites are lit by the same sky
 * and compiled with the same shaders as the people they stand behind. Returns null if anything
 * goes wrong; the far crowd then uses its painted figures, as it did before.
 */
export function bakeImpostors(renderer, scene, figure, { detail } = {}) {
    const [cellW, cellH] = IMPOSTOR_CELL, [pxW, pxH] = IMPOSTOR_PIXELS;
    const cols = IMPOSTOR_IDS.length, views = IMPOSTOR_VIEWS, frames = IMPOSTOR_FRAMES;
    const base = 400, rowGap = 3;
    const made = [], targets = [];
    const saved = {
        target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
        shadows: renderer.shadowMap.autoUpdate, autoClear: renderer.autoClear,
    };
    try {
        const camera = new THREE.OrthographicCamera(0, cols * cellW, views * cellH, 0, 0.1, 80);
        camera.position.set(0, base, 40);
        camera.updateMatrixWorld(true);
        // Each view stands on its own shelf, one above the next, so one picture takes them all.
        const ground = (x, z) => base + IMPOSTOR_FOOT + Math.round(z / rowGap) * cellH;
        const state = {
            role: 'none', status: 'paused', armed: false, elapsed: 0, enemies: [], civilians: [], effects: [], lines: [],
            companions: IMPOSTOR_IDS.flatMap((id, i) => Array.from({ length: views }, (_, v) => ({
                id, key: `far${v}-${id}`, x: (i + 0.5) * cellW, z: v * rowGap, heading: -v * Math.PI / 2,
                health: 30, moving: false, attacking: 0, filming: id % 4 === 1, morale: 0.8, temperament: 'follower',
                chanting: id % 4 !== 1 && i % 2 === 0,
            }))),
        };
        const far = { x: 1e6, y: 0, z: 1e6 };
        // The pictures are multisampled, so a sprite seen from close by has clean edges. The coat
        // mask only says where to tint, so it is taken at half the size.
        const shoot = (palette, shrink = 1) => {
            const crowd = createCrowd(scene, cols * views, { time: { value: 0 }, groundHeight: ground, shadowTexture: null, figure, detail, palette });
            made.push(crowd);
            crowd.setExtras(true);
            const cw = pxW / shrink, ch = pxH / shrink;
            const target = new THREE.WebGLRenderTarget(cols * cw, views * frames * ch, {
                generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, samples: 4,
            });
            target.texture.colorSpace = THREE.LinearSRGBColorSpace;
            target.texture.anisotropy = 4;
            target.scissorTest = true;
            targets.push(target);
            // Off the beat, then on it: 1.5 s is the bar's rest, 1.85 s its first beat.
            [1.5, 1.85].slice(0, frames).forEach((elapsed, frame) => {
                state.elapsed = elapsed;
                crowd.update(state, 0, false, far);
                target.viewport.set(0, frame * views * ch, cols * cw, views * ch);
                target.scissor.copy(target.viewport);
                renderer.setRenderTarget(target);
                renderer.setClearColor(0x000000, 0);
                renderer.clear();
                renderer.render(scene, camera);
                // The sun's shadow map is drawn by the first picture; the rest reuse it.
                renderer.shadowMap.autoUpdate = false;
            });
            return target.texture;
        };
        const map = shoot('neutral'), mask = shoot('mask', 2);
        return {
            map, mask, cols, views, frames, size: IMPOSTOR_CELL, foot: IMPOSTOR_FOOT,
            // Linear value of the neutral coat, which the sprite shader divides back out.
            neutral: new THREE.Color(NEUTRAL_COAT).r,
            dispose() { for (const target of targets) target.dispose(); },
        };
    } catch (error) {
        console.warn('PoCapitol: far-crowd bake failed, using painted figures.', error);
        for (const target of targets) target.dispose();
        return null;
    } finally {
        for (const crowd of made) crowd.dispose();
        renderer.setRenderTarget(saved.target);
        renderer.setClearColor(saved.color, saved.alpha);
        renderer.shadowMap.autoUpdate = saved.shadows;
        renderer.autoClear = saved.autoClear;
    }
}
