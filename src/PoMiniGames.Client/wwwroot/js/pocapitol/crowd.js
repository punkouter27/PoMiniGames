import * as THREE from 'three';
import { addWave, billboardChunk, createPolycarbonateMaterial, addSubsurfaceScattering } from './look.js';
import { BONES as RIG_BONES, REGIONS, buildFigure } from './rig.js';
import { collapseStage, tipAxes, impactFrame, restPlace } from './collapse.js';

// Original procedural artwork; references inform clothing and equipment, not real identities.
export function flagTexture(kind = 'us') {
    const canvas = document.createElement('canvas');
    canvas.width = 390; canvas.height = 260;
    const ctx = canvas.getContext('2d');
    if (kind === 'us') {
        ctx.fillStyle = '#edece5'; ctx.fillRect(0, 0, 390, 260);
        ctx.fillStyle = '#a9353e';
        for (let i = 0; i < 13; i += 2) ctx.fillRect(0, i * 20, 390, 20);
        ctx.fillStyle = '#293f6b'; ctx.fillRect(0, 0, 156, 140);
        ctx.fillStyle = '#fff';
        for (let row = 0; row < 9; row++) for (let col = 0; col < (row % 2 ? 5 : 6); col++) {
            const x = 13 + col * 26 + (row % 2 ? 13 : 0), y = 10 + row * 15;
            ctx.beginPath();
            for (let point = 0; point < 10; point++) {
                const angle = point / 10 * Math.PI * 2 - Math.PI / 2, radius = point % 2 ? 2 : 5;
                ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
            }
            ctx.closePath(); ctx.fill();
        }
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
const banners = ['us', 'campaign', 'us', 'gadsden', 'sign', 'us'];
const suits = ['#27303f', '#3a3f48', '#1f2a3a', '#4a4650', '#2f3b33'];
const pants = ['#3b4a63', '#2a2f38', '#6b6250', '#1d1f22', '#4d5560', '#34405a'];
const hairs = ['#2b2118', '#4a3524', '#6e5a43', '#9a8f84', '#b89a64', '#1c1a18'];
const knits = ['#a93737', '#2b3f66', '#3a3a3a', '#7d7f45', '#c9c3b5', '#5a2d3c'];
const skins = ['#d4b28e', '#b98f6c', '#90694e', '#debfa3', '#73533e'];

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
        return { name: m.material.name, geometry };
    });
    return template(bones.map(b => b.name), bones.map(b => bones.indexOf(b.parent)), heads, regions);
}
function fromRig(figure) {
    const names = figure.bones.map(b => b.name);
    const regions = figure.regions.map(r => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
        geometry.setAttribute('skinIndex', new THREE.BufferAttribute(r.joints, 4));
        geometry.setAttribute('skinWeight', new THREE.BufferAttribute(r.weights, 4));
        geometry.setIndex(new THREE.BufferAttribute(r.indices, 1));
        return { name: r.name, geometry };
    });
    return template(names, figure.bones.map(b => names.indexOf(b.parent)), figure.bones.map(b => b.head), regions);
}
/** One figure flattened: vertex streams, its region per vertex, bones in parents-first order. */
function template(names, parents, heads, regions) {
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
    };
    let v = 0, k = 0;
    for (const r of regions) {
        const g = r.geometry, at = REGIONS.indexOf(r.name), base = v;
        const { position, normal, skinIndex, skinWeight } = g.attributes;
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
function createBodies(scene, t, capacity) {
    const V = t.vertices, B = t.bones;
    const position = new Float32Array(V * capacity * 3), normal = new Float32Array(V * capacity * 3);
    const skinIndex = new Uint16Array(V * capacity * 4), skinWeight = new Float32Array(V * capacity * 4);
    const index = new Uint32Array(t.indices * capacity), colors = new Float32Array(V * capacity * 3);
    for (let s = 0; s < capacity; s++) {
        position.set(t.position, s * V * 3); normal.set(t.normal, s * V * 3); skinWeight.set(t.skinWeight, s * V * 4);
        for (let i = 0; i < V * 4; i++) skinIndex[s * V * 4 + i] = t.skinIndex[i] + s * B;
        for (let i = 0; i < t.indices; i++) index[s * t.indices + i] = t.index[i] + s * V;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    const color = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', color);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    const material = addSubsurfaceScattering(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }));
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
        paint(slot, look, tint) {
            if (looks[slot] === look) return;
            looks[slot] = look;
            for (let v = 0; v < V; v++) tint(t.region[v]).toArray(colors, (slot * V + v) * 3);
            color.addUpdateRange(slot * V * 3, V * 3); color.needsUpdate = true;
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
            // A last step under the falling weight, whichever way the body is going.
            for (const [s, side] of [['L', -1], ['R', 1]]) {
                rot(pose, `thigh_${s}`, (0.3 + 0.55 * brace) - flail * side * 0.2, 0, side * 0.12 * tip);
                rot(pose, `shin_${s}`, -0.5 - 0.95 * brace);
                rot(pose, `foot_${s}`, 0.22 * brace);
            }
            rot(pose, 'spine', -0.14 * (1 - settle) + 0.1 * flail);
            rot(pose, 'upperArm_L', 0.2 * settle - flail * 0.7, 0, -0.55 * settle - 0.4 * tip);
            rot(pose, 'upperArm_R', 0.3 * settle + flail * 0.7, 0, 0.5 * settle + 0.35 * tip);
            rot(pose, 'foreArm_L', 0.4 * settle + 0.3 * tip);
            rot(pose, 'foreArm_R', 0.25 * settle + 0.24 * tip);
            rot(pose, 'head', 0.15 * settle + 0.2 * flail, 0.4 * (f.seed - 0.5) * settle);
            // Tipping is about the body's own axes, so the same lean reads correctly at any heading.
            return { drop: 0, ...tipAxes(f.rel, tipAngle), lift: 0.2 * ease };
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
    if (b.gun) { arm('R', 1.42, 0.08); arm('L', 1.2, 0.5, 0.4); rot(pose, 'head', -0.05, -0.1); }
    else if (a.police || a.hasShield) {
        arm('L', 0.55, 1.0, 0.18); // shield up on the forearm
        if (a.attacking > 0 && a.tool === 'baton') arm('R', 1.75, 0.15);
        else if (a.attacking > 0) arm('R', 1.45, 0.05, -0.15); // spray, arm out
        else arm('R', 0.35, 0.45);
    } else if (b.filming) { arm('R', 1.45, 0.75, -0.2); rot(pose, 'head', 0.06); }
    else if (b.bearer) arm('R', 0.35, 1.1);
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

export function createCrowd(scene, capacity, { time, groundHeight, shadowTexture, figure, wind = null }) {
    const parts = [], resources = new Set(), textures = new Set();
    const transform = new THREE.Object3D(), color = new THREE.Color();
    transform.rotation.order = 'YXZ';
    const held = new THREE.Object3D(), worn = new THREE.Matrix4(), boneWorld = new THREE.Matrix4();
    const anchor = new THREE.Vector3(), shift = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let extras = true;
    const rig = figure ?? fromRig(buildFigure());
    const bodies = createBodies(scene, rig, capacity);
    /**
     * Clothing and kit on top of the rigged body. A worn part follows its bone completely
     * (`offset` is its rest position on the figure). A held part (`anchor`) follows only the
     * point where it is held and stays upright, facing the way the person faces.
     * `extra` parts are the small ones nobody misses on a struggling device.
     */
    function part(name, geometry, material, offset, scale = [1, 1, 1], filter = () => true, extra = false, more = {}) {
        resources.add(geometry); resources.add(material);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = ['helmet', 'hood', 'hard-hat', 'backpack', 'shield', 'flag-pole', 'beanie', 'cap'].includes(name);
        mesh.receiveShadow = name !== 'contact';
        scene.add(mesh);
        const item = { name, mesh, offset, scale, filter, extra, bone: -1, ...more };
        item.bone = bodies.boneOf(more.bone ?? 'chest');
        parts.push(item); return item;
    }
    const raider = a => !a.police && !a.civilian;
    const hardHat = a => raider(a) && a.id % 12 === 5;
    const tricorn = a => raider(a) && a.id % 17 === 4;
    const ballCap = a => raider(a) && a.id % 3 === 0 && !hardHat(a) && !tricorn(a);
    const hood = a => raider(a) && a.id % 7 === 2 && !ballCap(a) && !hardHat(a) && !tricorn(a);
    const bareish = a => raider(a) && !ballCap(a) && !hardHat(a) && !tricorn(a) && !hood(a);
    const beanie = a => bareish(a) && a.id % 3 !== 2;
    const hair = a => (bareish(a) && a.id % 3 === 2) || a.civilian;
    const bearer = a => raider(a) && a.id >= 0 && a.id % 3 === 0 && a.health > 0;
    const filming = a => raider(a) && a.filming && a.health > 0 && !a.retreating;
    const gun = a => a.armed && a.health > 0 && (a.police || a.temperament === 'pusher' || (a.temperament === 'follower' && a.morale > 0.7));

    // Two forces stood the line that day: Capitol Police in dark navy, and Metropolitan Police
    // in hi-vis yellow-green outer jackets. Kit was mixed, so neither is uniform here.
    const hiVis = a => a.police && a.id % 5 < 2;
    const coatColor = a => a.police ? (hiVis(a) ? '#c8d43a' : '#24394d') : a.civilian ? suits[a.id % suits.length] : a.observer ? '#3f6f8f'
        : a.id < 0 ? '#bd713f' : coats[a.id % coats.length];
    const skinColor = a => skins[Math.abs(a.id) % skins.length];
    // Body regions, in rig.js REGIONS order. Hi-vis vests and medics' tabards are the coat's colour.
    const regionColors = [
        a => a.temperament === 'medic' ? '#f1efe8' : raider(a) && a.id >= 0 && a.id % 10 === 4 ? '#c9e23c' : coatColor(a),
        coatColor,
        a => a.police ? '#1f2833' : a.civilian ? suits[a.id % suits.length] : pants[Math.abs(a.id) % pants.length],
        skinColor,
        a => a.police ? '#15181c' : a.civilian ? '#121315' : ['#2a2620', '#3d2c1f', '#1c1d1f'][Math.abs(a.id) % 3],
        a => a.police || (raider(a) && a.id % 3 === 0) ? '#202830' : skinColor(a),
    ];
    const tints = {
        hood: a => color.set(coatColor(a)).multiplyScalar(0.9),
        'puffer-band': a => color.set(coatColor(a)).multiplyScalar(0.72),
        cap: a => color.set(a.id % 5 === 0 ? '#24324f' : '#a93737'),
        'cap-brim': a => color.set(a.id % 5 === 0 ? '#24324f' : '#a93737'),
        beanie: a => color.set(knits[(a.id * 7) % knits.length]),
        pom: a => color.set(knits[(a.id * 7 + 3) % knits.length]),
        scarf: a => color.set(knits[(a.id * 5 + 1) % knits.length]),
        hair: a => color.set(hairs[Math.abs(a.id * 3) % hairs.length]),
    };

    const cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: '#202830', roughness: 0.8 });
    const knit = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const dome = new THREE.SphereGeometry(0.26, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const ring = new THREE.TorusGeometry(0.35, 0.035, 5, 16);

    // A soft dark patch under every figure: what keeps a crowd standing on the ground.
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const contact = part('contact', new THREE.PlaneGeometry(1, 1), shadowMaterial, [0, 0, 0], [0.95, 0.8, 1]);
    contact.mesh.layers.set(1);

    // Quilted puffers: two darker bands round the coat.
    part('puffer-band', ring, cloth, [0, 0.9, 0], [1.02, 0.88, 1], a => raider(a) && a.id % 4 === 0, true, { rot: Math.PI / 2, bone: 'spine' });
    part('puffer-band', ring, cloth, [0, 1.22, 0], [1.08, 0.9, 1], a => raider(a) && a.id % 4 === 0, true, { rot: Math.PI / 2 });
    const head = { bone: 'head' };
    part('hair', dome, cloth, [0, 1.87, 0.02], [0.84, 0.75, 0.92], hair, false, head);
    part('beanie', dome, knit, [0, 1.9, 0.01], [0.86, 0.9, 0.9], beanie, false, head);
    part('pom', new THREE.SphereGeometry(0.07, 6, 4), knit, [0, 2.12, 0.01], [1, 1, 1], a => beanie(a) && a.id % 6 === 1, true, head);
    part('hood', dome, cloth, [0, 1.84, 0.05], [1.04, 1.12, 1.12], hood, false, head);
    part('scarf', new THREE.TorusGeometry(0.2, 0.065, 5, 12), knit, [0, 1.62, 0], [1, 1, 0.9],
        a => raider(a) && a.id % 4 === 1, true, { rot: Math.PI / 2, bone: 'neck' });
    part('cap', dome, cloth, [0, 1.93, 0.015], [0.84, 0.62, 0.88], ballCap, false, head);
    part('cap-brim', cube, cloth, [0, 1.94, -0.27], [0.34, 0.03, 0.2], ballCap, true, head);
    part('hard-hat', dome, new THREE.MeshStandardMaterial({ color: '#e7c531', roughness: 0.5 }), [0, 1.92, 0.01], [0.98, 0.95, 1.02], hardHat, false, head);
    part('tricorn', new THREE.CylinderGeometry(0.36, 0.4, 0.13, 3), dark, [0, 2.02, 0], [1, 1, 1], tricorn, false, head);
    part('backpack', cube, dark, [0, 1.28, 0.36], [0.5, 0.6, 0.24], a => raider(a) && a.id >= 0 && a.id % 5 === 2, true);
    // Street medics: a red patch on the white tabard. A role in the crowd, not a uniform.
    part('medic-patch', cube, new THREE.MeshStandardMaterial({ color: '#c1373c', roughness: 0.9 }),
        [0, 1.3, -0.262], [0.24, 0.24, 0.02], a => a.temperament === 'medic', true);
    // Phones held up to film, in the raised right hand: the single most common thing in every
    // photograph of the day. The screen glows enough to bloom.
    const right = { bone: 'hand_R', anchor: PALM_R }, left = { bone: 'hand_L', anchor: PALM_L };
    part('phone', cube, new THREE.MeshStandardMaterial({ color: '#10161d', emissive: '#9cc8f0', emissiveIntensity: 1.6 }),
        [-0.03, 0.09, -0.04], [0.1, 0.19, 0.02], filming, true, right);
    part('helmet', new THREE.SphereGeometry(0.29, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.65),
        new THREE.MeshStandardMaterial({ color: '#1d242c', roughness: 0.35, metalness: 0.2 }), [0, 1.91, 0], [0.9, 1, 0.95], a => a.police, false, head);
    const clear = createPolycarbonateMaterial({ color: '#c4e0ea', opacity: 0.42, roughness: 0.08, dispersion: 0.04 });
    part('visor', cube, clear, [0, 1.86, -0.25], [0.46, 0.32, 0.05], a => a.police, false, head);
    part('vest', cube, dark, [0, 1.2, -0.25], [0.67, 0.64, 0.12], a => a.police || (raider(a) && a.id >= 0 && a.id % 8 === 3));
    // Reflective bands on the hi-vis outer jackets.
    const reflective = new THREE.MeshStandardMaterial({ color: '#eef1e6', roughness: 0.35, metalness: 0.25 });
    part('hi-vis-band', ring, reflective, [0, 0.98, 0], [1.06, 0.92, 1], hiVis, true, { rot: Math.PI / 2, bone: 'spine' });
    part('hi-vis-band', ring, reflective, [0, 1.24, 0], [1.1, 0.94, 1], hiVis, true, { rot: Math.PI / 2 });
    part('shield', cube, clear, [0.1, -0.1, -0.08], [0.9, 1.45, 0.09], a => a.police || a.hasShield, false, left);
    part('shield-edge', cube, dark, [0.1, -0.81, -0.08], [0.92, 0.07, 0.11], a => a.police || a.hasShield, true, left);
    const shieldCanvas = document.createElement('canvas');
    shieldCanvas.width = 256; shieldCanvas.height = 64;
    const ctx = shieldCanvas.getContext('2d');
    ctx.fillStyle = '#203046'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('POLICE', 128, 49);
    const shieldTexture = new THREE.CanvasTexture(shieldCanvas); textures.add(shieldTexture);
    part('police-label', new THREE.PlaneGeometry(0.75, 0.2), new THREE.MeshBasicMaterial({ map: shieldTexture, side: THREE.DoubleSide }),
        [0.1, 0.05, -0.135], [1, 1, 1], a => a.police, true, { ...left, yaw: Math.PI });
    part('baton', new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), dark, [0, 0, -0.04], [1, 1, 1], a => a.police && !a.armed,
        false, { ...right, rot: -0.5 });
    // Armed demo only: a plain dark block held forward. No real model is depicted.
    part('gun', cube, dark, [-0.02, 0.05, -0.2], [0.07, 0.13, 0.5], gun, false, right);
    part('flag-pole', new THREE.CylinderGeometry(0.025, 0.025, 3.2, 5),
        new THREE.MeshStandardMaterial({ color: '#b7a587' }), [0, 0.95, 0], [1, 1, 1], bearer, false, right);
    for (const kind of new Set(banners)) {
        const texture = flagTexture(kind); textures.add(texture);
        const flag = part('flag', new THREE.PlaneGeometry(1.7, 1.1, 16, 6),
            addWave(new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.9 }), time, { wind }),
            [0.86, 1.98, 0], [1, 1, 1], a => bearer(a) && banners[Math.floor(a.id / 3) % banners.length] === kind, false, right);
        flag.mesh.layers.set(1);
    }
    // Snow settling on shoulders and hats: not falling snow, the thin rime that builds up on a
    // person who has been out in it for an hour. A pale cap that grows with time outdoors.
    const rime = new THREE.MeshBasicMaterial({ color: '#e9eef2', transparent: true, opacity: 0.5, depthWrite: false });
    const rimeCap = part('rime', dome, rime, [0, 2.06, 0], [1, 1, 1], a => !a.police && a.health > 0 && (a.z ?? 0) > 15, true, head);
    rimeCap.mesh.layers.set(1);
    const rimeShoulders = part('rime-shoulders', new THREE.TorusGeometry(0.24, 0.035, 4, 12), rime, [0, 1.52, 0], [1, 1, 0.85],
        a => a.health > 0 && (a.z ?? 0) > 15, true, { rot: Math.PI / 2, bone: 'chest' });
    rimeShoulders.mesh.layers.set(1);
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
        lastNow = now;
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
            // People turn rather than snap: the simulated heading is eased for the eye only.
            const wantYaw = a.heading || 0, wasYaw = yawOf.get(key);
            b.yaw = wasYaw === undefined ? wantYaw
                : wasYaw + Math.atan2(Math.sin(wantYaw - wasYaw), Math.cos(wantYaw - wasYaw)) * (1 - Math.exp(-dt * 8));
            yawOf.set(key, b.yaw);
            const regionKey = `${key}${a.police ? 'p' : ''}${a.observer ? 'o' : ''}${a.temperament ?? ''}`;
            bodies.paint(b.slot, regionKey, region => color.set(regionColors[region](a)));
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
            const strain = a.police && a.health > 0 && !b.moving ? officerStrain(state, a) : 0;
            const brace = strain ? Math.sin(now * (1.4 + strain * 2.5) + (a.id || 0) * 1.7) * (0.012 + strain * 0.045) : 0;
            transform.position.set(
                a.x + (rest?.dx ?? 0),
                b.ground - how.drop * tall + how.lift * wide + (rest?.height ?? 0),
                a.z + (rest?.dz ?? 0));
            transform.rotation.set(how.fall + brace, b.yaw, (how.lean || 0) + (rest?.roll ?? 0));
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
                if (!p.filter(a)) continue;
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
                    shift.set(p.offset[0] * b.wide, p.offset[1] * b.tall, p.offset[2] * b.wide).applyAxisAngle(up, h);
                    transform.position.copy(anchor).add(shift);
                    // Nearby banners must not fill the entire third-person camera.
                    if (p.name === 'flag' && transform.position.distanceTo(cameraPosition) < 4) continue;
                    transform.rotation.set(p.rot || 0, h + (p.yaw || 0), 0);
                    transform.scale.set(p.scale[0] * b.wide, p.scale[1] * b.tall, p.scale[2] * b.wide);
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
                    if (p.name === 'flag') {
                        // A banner streams downwind, not the way the person carrying it faces.
                        const wx = wind?.x ?? 0, wz = wind?.z ?? 0;
                        const windYaw = Math.atan2(-wx, -wz);
                        const blend = Math.min(0.85, Math.hypot(wx, wz) / 9);
                        const dy = Math.atan2(Math.sin(windYaw - h), Math.cos(windYaw - h));
                        transform.rotation.y = h + dy * blend + 0.05 * Math.sin(state.elapsed * 1.7 + a.id);
                    }
                    if (p.name === 'rime' || p.name === 'rime-shoulders') {
                        // Rime builds on a person who has been out in it, then holds.
                        const build = Math.min(1, Math.max(0, (state.elapsed - 20) / 400));
                        if (build <= 0.01) continue;
                        transform.scale.multiplyScalar(0.55 + 0.45 * build);
                    }
                    transform.updateMatrix();
                    worn.copy(transform.matrix);
                } else {
                    if (p.bone >= 0) bodies.boneMatrix(b.slot, p.bone, boneWorld); else boneWorld.copy(slotFigure[b.slot]);
                    held.position.fromArray(p.offset);
                    held.rotation.set(p.rot || 0, p.yaw || 0, 0);
                    held.scale.fromArray(p.scale);
                    held.updateMatrix();
                    worn.multiplyMatrices(boneWorld, held.matrix);
                }
                p.mesh.setMatrixAt(count, worn);
                const tint = tints[p.name];
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
 */
export function createDistantCrowd(scene, spots, { time, shadowTexture }) {
    const count = spots.length, { map, mask } = peopleAtlas();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0, 0.5, 0);
    const cells = new Float32Array(count);
    const light = { value: 1 };
    const material = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, fog: true });
    material.onBeforeCompile = shader => {
        shader.uniforms.uTime = time;
        shader.uniforms.uLight = light;
        shader.uniforms.uCoat = { value: mask };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aCell;\nuniform float uTime;')
            .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv.x = (vMapUv.x + aCell) / ${CELLS}.0;`)
            .replace('#include <project_vertex>', `
                float swayPhase = aCell * 2.1 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
                transformed.x += sin(uTime * 1.3 + swayPhase) * 0.025 * transformed.y;
                transformed.y += max(0.0, sin(uTime * 2.2 + swayPhase * 3.0)) * 0.02;
                ${billboardChunk(true)}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uLight;\nuniform sampler2D uCoat;')
            .replace('#include <color_fragment>', `
                #ifdef USE_COLOR
                    diffuseColor.rgb = mix(diffuseColor.rgb, vColor * 0.9, texture2D(uCoat, vMapUv).r);
                #endif
                diffuseColor.rgb *= uLight;`);
    };
    material.customProgramCacheKey = () => 'pocapitol-far-crowd';
    const people = new THREE.InstancedMesh(geometry, material, count);
    const shadowGeometry = new THREE.PlaneGeometry(1, 1);
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, count);
    const pose = new THREE.Object3D(), tint = new THREE.Color();
    spots.forEach((spot, i) => {
        pose.position.set(spot.x, spot.y, spot.z); pose.rotation.set(0, 0, 0);
        pose.scale.set(0.95 * spot.scale, 1.9 * spot.scale, 1); pose.updateMatrix();
        people.setMatrixAt(i, pose.matrix);
        people.setColorAt(i, tint.set(coats[spot.coat % coats.length]));
        cells[i] = spot.cell % CELLS;
        pose.position.y += 0.015; pose.rotation.set(-Math.PI / 2, 0, 0);
        pose.scale.set(0.9 * spot.scale, 0.75 * spot.scale, 1); pose.updateMatrix();
        shadows.setMatrixAt(i, pose.matrix);
    });
    geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 1));
    for (const mesh of [people, shadows]) {
        mesh.frustumCulled = false;
        mesh.layers.set(1);
        scene.add(mesh);
    }
    return {
        setCount(n) { people.count = shadows.count = n; },
        setLight(level) { light.value = level; },
        dispose() {
            for (const mesh of [people, shadows]) { scene.remove(mesh); mesh.dispose(); }
            geometry.dispose(); shadowGeometry.dispose(); material.dispose(); shadowMaterial.dispose(); map.dispose(); mask.dispose();
        },
    };
}
