// Loose things on the ground, thrown about by a rigid-body solver: spent gas and smoke
// canisters, flash-bang bodies, water bottles, and the placards and flags people drop when they
// go down.
//
// The solver is Rapier (@dimforge/rapier3d-compat, the import map's `rapier` entry, WASM), the
// same build PoCabinet's debris and PoEcosystem's props use. It is for the picture only, like
// glass.js and cloth.js: world.js never reads it, so whether it loads changes nothing about who
// is where. What it adds is real shapes against real shapes: a canister rolls off the terrace
// steps and fetches up against a column, a dropped placard lands flat and slides, a blast kicks
// everything near it into the air and it comes down on whatever is there, and people running
// through the litter scuff it along.
//
// The props come from models/pocapitol/props.glb (scripts/pocapitol/props.mjs): Draco-compressed
// meshes with small layered metal-rough PBR textures, decoded by three's DRACOLoader with the
// decoder from the CDN. If the file, the decoder or Rapier cannot load, there is simply no
// debris. Nothing waits on it.
//
// Medium and high tiers only (quality settings with `extras`); the low tier never loads it.
import * as THREE from 'three';
import { obstacles, columns, statues } from './world.js';

const PROPS_URL = 'models/pocapitol/props.glb';
const DRACO_DECODER = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/';
/** The most loose things at once. The oldest is recycled when a new one lands. */
const CAPACITY = { canister: 24, flashbang: 16, bottle: 28, placard: 14, flag: 10 };
const STEP = 1 / 60;
const KICK_RANGE = 0.55;

let rapierLoading = null;
function loadRapier() {
    rapierLoading ??= import('rapier')
        .then(async m => { const R = m.default || m; await R.init(); return R; })
        .catch(error => { console.warn('[PoCapitol] Rapier did not load; no debris.', error); return null; });
    return rapierLoading;
}

let propsLoading = null;
function loadProps() {
    propsLoading ??= (async () => {
        try {
            const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
                import('three/addons/loaders/GLTFLoader.js'),
                import('three/addons/loaders/DRACOLoader.js'),
            ]);
            const draco = new DRACOLoader().setDecoderPath(DRACO_DECODER);
            const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(PROPS_URL);
            draco.dispose();
            const props = {};
            gltf.scene.traverse(o => { if (o.isMesh) props[o.name] = { geometry: o.geometry, material: o.material }; });
            return props;
        } catch (error) {
            console.warn('[PoCapitol] props.glb unavailable; no debris.', error);
            return null;
        }
    })();
    return propsLoading;
}

/**
 * @param scene      the three.js scene
 * @param crowd      crowd.js's handle (bannerOf says what a falling person was carrying)
 * @param bannerTexture  (kind, text) => texture: crowd.js flagTexture, so a dropped sign reads the same
 */
export function createDebris(scene, { crowd, bannerTexture }) {
    let R = null, world = null, props = null, enabled = false, disposed = false, loading = null;
    let due = 0, frame = 0;
    const pieces = [];               // { kind, body, slot, born, face? }
    const pools = {};                // kind -> { meshes: InstancedMesh[], free: number[] }
    const faces = [];                // individual meshes for the drawn side of placards and flags
    const textures = new Map();
    const fallen = new Set();
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), unit = new THREE.Vector3(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

    function begin() {
        loading ??= Promise.all([loadRapier(), loadProps()]).then(([rapier, loaded]) => {
            if (disposed || !rapier || !loaded) return;
            R = rapier; props = loaded;
            buildWorld();
            buildPools();
        });
        return loading;
    }

    /** The ground and the solid things on it, as fixed shapes matching world.js groundHeight. */
    function buildWorld() {
        world = new R.World({ x: 0, y: -9.81, z: 0 });
        const box = (x, z, w, d, top, h = 1) => {
            const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, top - h / 2, z));
            world.createCollider(R.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setFriction(0.8).setRestitution(0.2), body);
        };
        box(0, 30, 160, 200, -0.05);                       // the lawn
        box(0, -22.5, 80, 75, 0.1);                        // inside: every floor is at 0.1
        box(0, 42, 24, 60, 0.02);                          // the paved forecourt
        for (const side of [-30, 30]) box(side, 51, 9, 26, 0.05);   // the planted beds
        box(0, 16, 18, 2, 0.38);                           // the portico landing
        [0.29, 0.2, 0.11, 0.02].forEach((top, i) => box(0, 17.5 + i, 18, 1, top));   // the four steps
        for (const o of obstacles) box(o.x, o.z, o.w, o.d, o.h, o.h + 0.1);
        for (const c of columns) {
            const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(c.x, c.height / 2, c.z));
            world.createCollider(R.ColliderDesc.cylinder(c.height / 2, 0.55).setFriction(0.6), body);
        }
        for (const s of statues) {
            const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(s.x, 1.2, s.z));
            world.createCollider(R.ColliderDesc.cylinder(1.2, 0.6), body);
        }
    }

    function buildPools() {
        const instanced = (name, count) => {
            const prop = props[name];
            if (!prop) return null;
            const mesh = new THREE.InstancedMesh(prop.geometry, prop.material, count);
            mesh.name = `debris-${name}`;
            mesh.castShadow = true; mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            for (let i = 0; i < count; i++) mesh.setMatrixAt(i, hidden);
            scene.add(mesh);
            return mesh;
        };
        const parts = { canister: ['canister'], flashbang: ['flashbang'], bottle: ['bottle'], placard: ['placard', 'placard-pole'], flag: ['flag-pole'] };
        for (const [kind, names] of Object.entries(parts)) {
            const count = CAPACITY[kind];
            pools[kind] = { meshes: names.map(n => instanced(n, count)).filter(Boolean), free: Array.from({ length: count }, (_, i) => count - 1 - i) };
        }
    }

    /** Collider and mass for each kind, in metres and kilograms. */
    function shape(kind) {
        switch (kind) {
            case 'canister': return { collider: R.ColliderDesc.cylinder(0.085, 0.032), density: 1400, bounce: 0.35 };
            case 'flashbang': return { collider: R.ColliderDesc.cylinder(0.065, 0.024), density: 1600, bounce: 0.3 };
            case 'bottle': return { collider: R.ColliderDesc.cylinder(0.105, 0.033), density: 300, bounce: 0.25 };
            case 'placard': return { collider: R.ColliderDesc.cuboid(0.3, 0.21, 0.01), density: 250, bounce: 0.05, pole: [0.011, 0.375, 0.011, 0, -0.48, -0.016] };
            default: return { collider: R.ColliderDesc.cuboid(0.8, 0.03, 0.03), density: 600, bounce: 0.1 };
        }
    }

    function spawn(kind, x, y, z, velocity = { x: 0, y: 0, z: 0 }, banner = null) {
        const pool = pools[kind];
        if (!world || !pool?.meshes.length) return;
        if (!pool.free.length) {
            const oldest = pieces.findIndex(p => p.kind === kind);
            if (oldest >= 0) remove(oldest);
        }
        const slot = pool.free.pop();
        if (slot === undefined) return;
        const spec = shape(kind);
        const yaw = Math.random() * Math.PI * 2;
        const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
            .setTranslation(x, y, z)
            .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
            .setLinvel(velocity.x, velocity.y, velocity.z)
            .setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 12 })
            .setLinearDamping(0.15).setAngularDamping(0.6)
            .setCcdEnabled(true));
        world.createCollider(spec.collider.setDensity(spec.density).setRestitution(spec.bounce).setFriction(0.7), body);
        if (spec.pole) {
            const [hx, hy, hz, ox, oy, oz] = spec.pole;
            world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz).setDensity(500).setFriction(0.7), body);
        }
        const piece = { kind, body, slot, born: performance.now() };
        if (banner && (kind === 'placard' || kind === 'flag')) piece.face = face(kind, banner);
        pieces.push(piece);
    }

    /** The side of a placard or flag that shows what was on it, with that person's own design. */
    function face(kind, banner) {
        const prop = props[kind === 'placard' ? 'placard-face' : 'flag-cloth'];
        if (!prop || !bannerTexture) return null;
        const key = `${banner.kind}|${banner.text}`;
        let map = textures.get(key);
        if (!map) { map = bannerTexture(banner.kind, banner.text); textures.set(key, map); }
        const material = prop.material.clone();
        material.map = map; material.color.set('#ffffff'); material.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(prop.geometry, material);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
        faces.push(mesh);
        return mesh;
    }

    function remove(index) {
        const [piece] = pieces.splice(index, 1);
        world.removeRigidBody(piece.body);
        const pool = pools[piece.kind];
        for (const mesh of pool.meshes) { mesh.setMatrixAt(piece.slot, hidden); mesh.instanceMatrix.needsUpdate = true; }
        pool.free.push(piece.slot);
        if (piece.face) {
            scene.remove(piece.face);
            piece.face.material.dispose();
            faces.splice(faces.indexOf(piece.face), 1);
        }
    }

    /** Throw everything within `radius` of a blast up and away from it. */
    function blast(x, z, radius, strength) {
        for (const p of pieces) {
            const t = p.body.translation();
            const dx = t.x - x, dz = t.z - z, d = Math.hypot(dx, dz);
            if (d > radius) continue;
            const k = strength * (1 - d / radius) * p.body.mass();
            const n = d > 0.01 ? 1 / d : 0;
            p.body.applyImpulse({ x: dx * n * k, y: k * 0.9, z: dz * n * k }, true);
            p.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * k * 0.02, y: 0, z: (Math.random() - 0.5) * k * 0.02 }, true);
        }
    }

    /** A world.js event: what it drops on the ground and what it kicks. */
    function onEvent(event) {
        if (!enabled || !world) return;
        const up = (h, spread = 1.5) => ({ x: (Math.random() - 0.5) * spread, y: h, z: (Math.random() - 0.5) * spread });
        switch (event.type) {
            // A gas canister thrown from the police line lands with the speed it was thrown at.
            case 'gas': spawn('canister', event.x, 0.6, event.z, up(1.5, 4)); break;
            case 'smoke': spawn('canister', event.x, 0.5, event.z, up(1, 3)); break;
            case 'flash':
                blast(event.x, event.z, 4, 3.5);
                spawn('flashbang', event.x, 0.3, event.z, up(4, 3));
                break;
            case 'grenade': blast(event.x, event.z, event.radius ?? 8, 6); break;
            case 'rack': blast(event.x, event.z, 2.5, 1.2); break;
            default: break;
        }
    }

    /** People who have just gone down let go of what they were holding. */
    function watchFalls(state) {
        for (const c of state.companions) {
            if (c.health > 0) { if (fallen.size && fallen.has(c.id)) fallen.delete(c.id); continue; }
            if (fallen.has(c.id)) continue;
            fallen.add(c.id);
            const banner = crowd?.bannerOf?.(c);
            const v = { x: (c.vx ?? 0) * 0.6, y: 1.2, z: (c.vz ?? 0) * 0.6 };
            if (banner) spawn(banner.kind === 'text' ? 'placard' : 'flag', c.x, 1.4, c.z, v, banner);
            else if (c.id % 7 === 3) spawn('bottle', c.x, 1.0, c.z, v);
        }
    }

    /** Anyone running through the litter scuffs what is under their feet along with them. */
    function scuff(state) {
        if (!pieces.length) return;
        for (const p of pieces) {
            const t = p.body.translation();
            if (t.y > 0.6) continue;
            for (const c of state.companions) {
                if (c.health <= 0) continue;
                const vx = c.vx ?? 0, vz = c.vz ?? 0;
                if (vx * vx + vz * vz < 1.2) continue;
                if (Math.abs(c.x - t.x) > KICK_RANGE || Math.abs(c.z - t.z) > KICK_RANGE) continue;
                const k = p.body.mass() * 0.8;
                p.body.applyImpulse({ x: vx * k, y: k * 0.6, z: vz * k }, true);
                break;
            }
        }
    }

    function update(state, dt) {
        if (!enabled || !world) return;
        if (state.status === 'active') {
            watchFalls(state);
            if ((frame++ & 3) === 0) scuff(state);
            due = Math.min(due + dt, STEP * 3);
            while (due >= STEP) { world.step(); due -= STEP; }
        }
        const dirty = new Set();
        for (const p of pieces) {
            const t = p.body.translation(), r = p.body.rotation();
            position.set(t.x, t.y, t.z); quaternion.set(r.x, r.y, r.z, r.w);
            matrix.compose(position, quaternion, unit);
            for (const mesh of pools[p.kind].meshes) { mesh.setMatrixAt(p.slot, matrix); dirty.add(mesh); }
            if (p.face) p.face.matrix.copy(matrix);
        }
        for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
    }

    function reset() {
        while (pieces.length) remove(pieces.length - 1);
        fallen.clear();
        due = 0;
    }

    return {
        update, onEvent, reset,
        /** Medium and high tiers: the first call loads Rapier and the props. */
        setEnabled(value) {
            enabled = Boolean(value);
            if (enabled) begin();
            for (const pool of Object.values(pools)) for (const mesh of pool.meshes) mesh.visible = enabled;
            for (const mesh of faces) mesh.visible = enabled;
        },
        count: () => pieces.length,
        dispose() {
            disposed = true;
            if (world) { reset(); world.free(); world = null; }
            for (const pool of Object.values(pools)) for (const mesh of pool.meshes) { scene.remove(mesh); mesh.dispose(); }
            for (const map of textures.values()) map.dispose?.();
        },
    };
}
