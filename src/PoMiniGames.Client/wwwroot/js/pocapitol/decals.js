import * as THREE from 'three';

// Wear that stays: scuffs where people were shoved, scorch where a flash-bang or a round landed,
// and chalky residue where gas was released. Flat quads laid on the ground just above it, in two
// instanced meshes (one draw call each), recycled oldest-first when the ring is full.
//
// The marks are procedural: a radial falloff broken up by value noise and speckle, drawn once to a
// small canvas. Each instance has its own size, rotation and darkness, so no two look alike, and
// the day's light level tints them so they do not glow at dusk.

function mark(kind) {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d'), image = g.createImageData(size, size);
    // Seeded so the texture is the same on every machine.
    let s = kind === 'scuff' ? 7 : kind === 'scorch' ? 19 : kind === 'print' ? 43 : 31;
    const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const grid = Array.from({ length: 17 * 17 }, rand);
    const noise = (x, y) => {
        const gx = x * 16, gy = y * 16, ix = Math.min(15, Math.floor(gx)), iy = Math.min(15, Math.floor(gy)), tx = gx - ix, ty = gy - iy;
        const a = grid[iy * 17 + ix], b = grid[iy * 17 + ix + 1], c = grid[(iy + 1) * 17 + ix], d = grid[(iy + 1) * 17 + ix + 1];
        return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1;
        const i = (y * size + x) * 4;
        if (kind === 'print') {
            // A boot sole in snow or wet grit: a long forefoot, a narrow waist, a heel, and
            // tread bars across the ball. Pressed, so the edge is soft and the middle deepest.
            const toe = Math.hypot(u * 1.9, (v + 0.42) * 1.05) < 1;
            const heel = Math.hypot(u * 2.1, (v - 0.62) * 1.35) < 1;
            const waist = Math.abs(u) < 0.28 + 0.1 * (1 - Math.abs(v)) && Math.abs(v) < 0.66;
            const tread = (Math.abs((v + 0.42) * 7.0) % 1) > 0.34 ? 1 : 0.35;
            const inside = (toe || heel || waist) ? (toe ? tread : 1) : 0;
            const grain = 0.7 + 0.3 * noise(x / size, y / size);
            const alpha = Math.max(0, Math.min(1, inside * grain * 0.85));
            image.data[i] = 44; image.data[i + 1] = 45; image.data[i + 2] = 48;
            image.data[i + 3] = alpha * 255;
            continue;
        }
        // Scuffs are long streaks; scorch and residue are round.
        const r = kind === 'scuff' ? Math.hypot(u * 0.55, v * 1.6) : Math.hypot(u, v);
        const body = Math.max(0, 1 - r);
        const grain = 0.55 + 0.45 * noise(x / size, y / size) + (rand() - 0.5) * 0.35;
        const edge = kind === 'scorch' ? Math.pow(body, 0.55) : Math.pow(body, 1.25);
        const alpha = Math.max(0, Math.min(1, edge * grain * (kind === 'stain' ? 0.5 : 1.15)));
        const shade = kind === 'scuff' ? 38 : kind === 'scorch' ? 14 : 226;
        image.data[i] = shade * (0.8 + 0.4 * grain); image.data[i + 1] = shade * (0.78 + 0.4 * grain); image.data[i + 2] = shade * (0.72 + 0.4 * grain);
        image.data[i + 3] = alpha * 255;
    }
    g.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function ring(scene, kind, capacity) {
    const texture = mark(kind);
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAlpha', alpha);
    const material = new THREE.MeshBasicMaterial({
        map: texture, transparent: true, depthWrite: false, fog: true,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
            .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    material.customProgramCacheKey = () => `pocapitol-decal-${kind}`;
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.layers.set(1);
    mesh.count = 0;
    scene.add(mesh);
    const pose = new THREE.Object3D(), tint = new THREE.Color(0.85, 0.85, 0.85);
    const stretch = kind === 'scuff' ? 2.6 : kind === 'print' ? 1.9 : 1;
    let head = 0, filled = 0, dirty = false;
    return {
        mesh,
        add(x, y, z, width, angle, opacity) {
            pose.position.set(x, y, z); pose.rotation.set(0, angle, 0); pose.scale.set(width, 1, width * stretch);
            pose.updateMatrix();
            mesh.setMatrixAt(head, pose.matrix);
            mesh.setColorAt(head, tint); mesh.instanceColor.needsUpdate = true;
            alpha.array[head] = opacity;
            head = (head + 1) % capacity; filled = Math.min(capacity, filled + 1);
            mesh.count = filled; dirty = true;
        },
        /** Marks do not glow at dusk: the whole ring is tinted by the day's light. */
        light(level) {
            tint.setScalar(0.3 + 0.7 * level);
            for (let i = 0; i < filled; i++) mesh.setColorAt(i, tint);
            if (filled) mesh.instanceColor.needsUpdate = true;
        },
        flush() {
            if (!dirty) return;
            mesh.instanceMatrix.needsUpdate = true; alpha.needsUpdate = true; dirty = false;
        },
        dispose() { scene.remove(mesh); mesh.dispose(); geometry.dispose(); material.dispose(); texture.dispose(); },
    };
}

export function createDecals(scene, { capacity = 160 } = {}) {
    const scuffs = ring(scene, 'scuff', capacity), scorch = ring(scene, 'scorch', capacity / 2), stains = ring(scene, 'stain', capacity / 4);
    const prints = ring(scene, 'print', capacity * 2);
    const layers = [scuffs, scorch, stains, prints];
    let seed = 1, lightLevel = -1;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    return {
        /** One boot pressed into snow or wet grit. `angle` is the heading it was walking on. */
        footprint(x, floor, z, angle, opacity = 0.5) {
            prints.add(x, floor + 0.012, z, 0.2, angle, opacity);
        },
        /** Turns one world event into wear on the ground at floor height `floor`. */
        react(e, floor) {
            const y = floor + 0.015, energy = e.energy ?? 30;
            if (e.type === 'shove' || e.type === 'down' || (e.type === 'impact' && e.material === 'body')) {
                if (energy > 18) scuffs.add(e.x + (rand() - 0.5) * 0.5, y, e.z + (rand() - 0.5) * 0.5, 0.45 + Math.min(0.5, energy / 400), rand() * Math.PI, 0.35 + Math.min(0.4, energy / 300));
            } else if (e.type === 'flash') {
                scorch.add(e.x, y + 0.002, e.z, 3.2, rand() * Math.PI, 0.8);
            } else if (e.type === 'impact' && e.round) {
                scorch.add(e.x, y + 0.002, e.z, 0.5 + rand() * 0.3, rand() * Math.PI, 0.7);
            } else if (e.type === 'ricochet') {
                scorch.add(e.x, y + 0.002, e.z, 0.35 + rand() * 0.25, rand() * Math.PI, 0.65);
            } else if (e.type === 'gas') {
                stains.add(e.x, y + 0.001, e.z, 4.5, rand() * Math.PI, 0.55);
            } else if (e.type === 'break') {
                for (let i = 0; i < 5; i++) scuffs.add(e.x + (rand() - 0.5) * 12, y, e.z + (rand() - 0.5) * 3, 0.8 + rand() * 0.6, rand() * Math.PI, 0.5);
            }
        },
        update(level) {
            for (const l of layers) l.flush();
            if (Math.abs(level - lightLevel) > 0.02) { lightLevel = level; for (const l of layers) l.light(level); }
        },
        dispose() { for (const l of layers) l.dispose(); },
    };
}
