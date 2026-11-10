import * as THREE from 'three';
import { SURFACE, addSurface } from './look.js';

// Public-reference massing and landscape detail. The playable footprint remains fictional.
export function createCampus({ surfaces, surfaceDetail } = {}) {
    const group = new THREE.Group();
    group.name = 'capitol-campus-reference';
    const geometries = new Set(), materials = new Set();
    const detail = surfaceDetail ?? { value: 1 };
    const mat = (color, roughness = 0.8, metalness = 0, kind = SURFACE.stone) => {
        const value = new THREE.MeshStandardMaterial({ color, roughness, metalness });
        if (surfaces) addSurface(value, kind, surfaces, detail);
        materials.add(value);
        return value;
    };
    const stone = mat('#c9c3b7', 0.78), marble = mat('#dedbd2', 0.58);
    const darkStone = mat('#8f8b82', 0.9), roof = mat('#59625e', 0.62, 0.35, SURFACE.generic);
    const copper = mat('#527568', 0.55, 0.55, SURFACE.generic);
    const asphalt = mat('#343638', 0.96, 0, SURFACE.generic);
    const paving = mat('#aaa69c', 0.88, 0, SURFACE.paving);
    const bark = mat('#51463b', 0.98, 0, SURFACE.generic);
    const bronze = mat('#403f32', 0.48, 0.72, SURFACE.generic);
    const glass = new THREE.MeshPhysicalMaterial({ color: '#263746', roughness: 0.12, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.16, envMapIntensity: 1.5 });
    materials.add(glass);
    const mesh = (geometry, material, x, y, z, parent = group) => {
        geometries.add(geometry);
        const value = new THREE.Mesh(geometry, material);
        value.position.set(x, y, z); value.castShadow = true; value.receiveShadow = true;
        parent.add(value); return value;
    };
    const box = (x, y, z, w, h, d, material = stone, parent) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent);
    const cylinder = (x, y, z, rt, rb, h, material = stone, parent, segments = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, segments), material, x, y, z, parent);
    const column = (x, z, height, parent, y = 0) => {
        box(x, y + 0.15, z, 1.25, 0.3, 1.25, marble, parent);
        cylinder(x, y + height / 2, z, 0.38, 0.48, height - 0.6, marble, parent, 20);
        cylinder(x, y + height - 0.25, z, 0.65, 0.4, 0.35, marble, parent, 16);
        box(x, y + height, z, 1.25, 0.18, 1.25, marble, parent);
    };
    const pediment = (width, height, depth, x, y, z, parent, material = marble) => {
        const shape = new THREE.Shape();
        shape.moveTo(-width / 2, 0); shape.lineTo(width / 2, 0); shape.lineTo(0, height); shape.closePath();
        return mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 1 }), material, x, y, z, parent);
    };
    const windows = (parent, width, depth, levels, spacing = 4) => {
        for (const side of [-1, 1]) {
            for (let x = -width / 2 + 2.5; x < width / 2 - 1; x += spacing) for (const y of levels) {
                box(x, y, side * (depth / 2 + 0.04), 1.35, 2.25, 0.12, glass, parent);
                box(x, y, side * (depth / 2 + 0.13), 0.07, 2.3, 0.08, marble, parent);
                box(x, y, side * (depth / 2 + 0.14), 1.4, 0.07, 0.08, marble, parent);
                box(x, y + 1.25, side * (depth / 2 + 0.12), 1.8, 0.18, 0.3, marble, parent);
                box(x, y - 1.22, side * (depth / 2 + 0.16), 1.7, 0.16, 0.4, marble, parent);
            }
        }
    };

    // An open basin with shallow rippled water and a small Grant Memorial silhouette.
    box(0, -0.38, 128, 31, 0.35, 57, darkStone);
    for (const x of [-15, 15]) box(x, 0.02, 128, 1, 0.55, 57, stone);
    for (const z of [100, 156]) box(0, 0.02, z, 31, 0.55, 1, stone);
    const waterUniforms = { uTime: { value: 0 } };
    const water = new THREE.MeshPhysicalMaterial({ color: '#344d59', roughness: 0.16, metalness: 0.05, transmission: 0.18, transparent: true, opacity: 0.92, ior: 1.333, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.7 });
    water.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, waterUniforms);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                transformed.z += sin(position.x * 1.7 + uTime * 0.7) * 0.018 + cos(position.y * 2.1 - uTime * 0.45) * 0.012;`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                normal = normalize(normal + vec3(sin(vViewPosition.x * 3.0 + uTime) * 0.025, cos(vViewPosition.z * 4.0 - uTime * 0.8) * 0.025, 0.0));`);
    };
    water.customProgramCacheKey = () => 'pocapitol-pool-water';
    materials.add(water);
    const pool = mesh(new THREE.PlaneGeometry(29, 55, 32, 48), water, 0, -0.08, 128);
    pool.rotation.x = -Math.PI / 2; pool.castShadow = false;
    box(0, 1.5, 96, 7, 3, 10, darkStone);
    box(0, 3.25, 96, 7.8, 0.5, 10.8, stone);
    const horse = mesh(new THREE.CapsuleGeometry(0.75, 2.8, 5, 12), bronze, 0, 5.2, 96);
    horse.rotation.x = Math.PI / 2;
    for (const x of [-0.55, 0.55]) for (const z of [94.8, 97.2]) cylinder(x, 4.25, z, 0.12, 0.17, 1.8, bronze, group, 8);
    cylinder(0, 6.25, 96, 0.32, 0.45, 1.5, bronze);
    mesh(new THREE.SphereGeometry(0.28, 12, 8), bronze, 0, 7.2, 96);
    mesh(new THREE.SphereGeometry(0.48, 12, 8), bronze, 0, 5.55, 94.25);

    // Thomas Jefferson Building: rusticated base, pavilions, windows and copper dome.
    const loc = new THREE.Group(); loc.position.set(130, 0, -22); group.add(loc);
    box(0, 1, 0, 52, 2, 46, darkStone, loc);
    box(0, 11, 0, 48, 20, 42, stone, loc);
    for (const y of [2.2, 9.5, 20.5]) box(0, y, 0, 50, 0.55, 44, marble, loc);
    for (const sx of [-22, 22]) for (const sz of [-19, 19]) {
        box(sx, 12, sz, 11, 23, 11, stone, loc);
        box(sx, 23.7, sz, 12, 0.6, 12, marble, loc);
        pediment(10, 2.4, 0.7, sx, 24, sz + Math.sign(sz) * 5.5, loc, stone);
    }
    windows(loc, 48, 42, [5.2, 12.8, 17.2]);
    cylinder(0, 24, 0, 11.5, 12.5, 6, stone, loc, 32);
    for (let i = 0; i < 20; i++) {
        const a = i / 20 * Math.PI * 2;
        column(Math.sin(a) * 11.7, Math.cos(a) * 11.7, 4.5, loc, 21.5);
    }
    const locDome = mesh(new THREE.SphereGeometry(10.5, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), copper, 0, 27, 0, loc);
    locDome.scale.y = 0.8;
    cylinder(0, 36, 0, 1.1, 1.6, 2.4, copper, loc);
    mesh(new THREE.ConeGeometry(1.3, 2.2, 16), copper, 0, 38.2, 0, loc);

    // Supreme Court: octastyle portico, pediment, stairs and marble roofline.
    const court = new THREE.Group(); court.position.set(125, 0, -82); court.rotation.y = -Math.PI / 2; group.add(court);
    box(0, 9.5, 0, 44, 19, 34, marble, court);
    box(0, 19.3, 0, 46, 0.7, 36, marble, court);
    windows(court, 44, 34, [5, 12.5], 4.2);
    for (let step = 0; step < 10; step++) box(0, 0.15 + step * 0.22, 23 - step * 0.55, 30, 0.3, 0.65, marble, court);
    box(0, 10, 17.5, 30, 1, 8, marble, court);
    for (let i = 0; i < 8; i++) column(-12.25 + i * 3.5, 20, 13.5, court, 2.2);
    box(0, 16.2, 19.5, 30, 1.1, 6, marble, court);
    pediment(30, 5, 2.2, 0, 16.8, 17.2, court);
    for (const x of [-18, 18]) box(x, 20.2, 0, 3, 1.2, 36, marble, court);

    // Roads, sidewalks, curbs, markings and patched asphalt establish human scale.
    for (const x of [-68, 68]) {
        box(x, -0.08, 30, 16, 0.12, 230, asphalt);
        for (const side of [-1, 1]) {
            box(x + side * 9, 0, 30, 2, 0.18, 230, paving);
            box(x + side * 8.05, 0.08, 30, 0.18, 0.28, 230, stone);
        }
        for (let z = -80; z < 145; z += 8) box(x, -0.005, z, 0.12, 0.015, 3.5, marble);
        for (let i = 0; i < 12; i++) {
            const patch = box(x + ((i * 7) % 11) - 5, -0.012, -65 + i * 17, 1.5 + (i % 3), 0.018, 3 + (i % 4), darkStone);
            patch.rotation.y = (i % 5 - 2) * 0.08;
        }
    }
    box(70, -0.08, -50, 150, 0.12, 16, asphalt);
    for (const z of [-59, -41]) box(70, 0, z, 150, 0.18, 2, paving);
    for (let x = 0; x < 145; x += 8) box(x, -0.005, -50, 3.5, 0.015, 0.12, marble);
    for (const x of [-68, 68]) for (let i = -5; i <= 5; i++) box(x + i * 1.25, 0.005, 82, 0.7, 0.02, 4.5, marble);

    for (const side of [-56, 56]) {
        box(side, 0.45, 55, 1.1, 1, 140, stone);
        box(side, 1.01, 55, 1.35, 0.16, 140, marble);
        for (let z = 0; z < 120; z += 20) {
            box(side - Math.sign(side) * 2.2, 0.55, z, 0.65, 0.12, 2.4, roof);
            for (const dz of [-0.9, 0.9]) box(side - Math.sign(side) * 2.2, 0.28, z + dz, 0.5, 0.55, 0.12, roof);
        }
    }
    for (const x of [-52, 52]) for (let z = 10; z <= 110; z += 25) {
        cylinder(x, 1.8, z, 0.06, 0.12, 3.6, roof, group, 8);
        mesh(new THREE.SphereGeometry(0.22, 10, 8), glass, x, 3.7, z);
        box(x - Math.sign(x) * 7.5, 0.015, z + 4, 0.8, 0.025, 0.45, roof);
    }

    // Deterministic winter trees vary in height, lean, branch density and crown shape.
    let seed = 20210106;
    const random = () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; };
    const branchGeo = new THREE.CylinderGeometry(0.45, 1, 1, 6); geometries.add(branchGeo);
    const branch = (from, direction, length, radius, depth) => {
        const value = mesh(branchGeo, bark, 0, 0, 0);
        value.position.copy(from).addScaledVector(direction, length / 2);
        value.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        value.scale.set(radius, length, radius);
        if (!depth) return;
        const children = depth > 2 ? 3 : 2;
        for (let i = 0; i < children; i++) {
            const a = random() * Math.PI * 2, tilt = 0.35 + random() * 0.65;
            const next = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).lerp(direction, 0.3).normalize();
            const start = from.clone().addScaledVector(direction, length * (0.65 + random() * 0.35));
            branch(start, next, length * (0.55 + random() * 0.15), radius * 0.58, depth - 1);
        }
    };
    const treeSites = [];
    for (const side of [-1, 1]) for (let i = 0; i < 18; i++) treeSites.push([side * (42 + random() * 15), -5 + i * 8 + random() * 3]);
    for (const [x, z] of treeSites) {
        const height = 5.5 + random() * 5, lean = new THREE.Vector3((random() - 0.5) * 0.16, 1, (random() - 0.5) * 0.16).normalize();
        branch(new THREE.Vector3(x, -0.05, z), lean, height * 0.55, 0.25 + random() * 0.18, 3);
        cylinder(x, 0.02, z, 1.1, 1.1, 0.08, darkStone, group, 16);
    }

    const leafMaterial = mat('#69533a', 1, 0, SURFACE.generic);
    const leafGeometry = new THREE.CircleGeometry(0.09, 5); geometries.add(leafGeometry);
    const leaves = new THREE.InstancedMesh(leafGeometry, leafMaterial, 420);
    const pose = new THREE.Object3D();
    for (let i = 0; i < 420; i++) {
        const site = treeSites[i % treeSites.length];
        pose.position.set(site[0] + (random() - 0.5) * 5, 0.015, site[1] + (random() - 0.5) * 5);
        pose.rotation.set(-Math.PI / 2, 0, random() * Math.PI * 2); pose.scale.set(0.5 + random(), 0.5 + random(), 1); pose.updateMatrix();
        leaves.setMatrixAt(i, pose.matrix);
    }
    leaves.receiveShadow = true; group.add(leaves);

    return {
        group,
        update(time) { waterUniforms.uTime.value = time; },
        setDetail(value) { leaves.visible = value; },
        dispose() { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); leaves.dispose(); },
    };
}
