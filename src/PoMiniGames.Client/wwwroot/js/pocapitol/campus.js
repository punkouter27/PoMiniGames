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

    // The office buildings that ring Capitol Hill: three south of the Capitol (House) and three
    // north (Senate). Long classical fronts with a rusticated base, a colonnaded centre, a heavy
    // cornice and a parapet, so the skyline either side of the west front is not empty.
    // +x is south, -x is north and +z is west in this scene, so their fronts face the Capitol.
    const officeBuilding = (x, z, { w = 60, d = 24, h = 19, rot = 0, mansard = false } = {}) => {
        const block = new THREE.Group();
        block.position.set(x, 0, z); block.rotation.y = rot;
        group.add(block);
        box(0, 0.8, 0, w + 2.4, 1.6, d + 2.4, darkStone, block);
        box(0, h / 2 + 1.6, 0, w, h, d, stone, block);
        box(0, h + 2.1, 0, w + 1.6, 1, d + 1.6, marble, block);
        box(0, h + 2.9, 0, w + 0.8, 0.6, d + 0.8, marble, block);
        box(0, h + 3.5, 0, w, 0.6, d, stone, block);
        for (const side of [-1, 1]) {
            for (let i = 0, n = Math.floor(w / 6); i < n; i++) {
                const wx = -w / 2 + 3 + i * 6;
                for (const wy of [h * 0.52, h * 0.82]) {
                    box(wx, wy + 1.6, side * (d / 2 + 0.1), 1.5, 2.6, 0.16, glass, block);
                    box(wx, wy + 0.35, side * (d / 2 + 0.2), 2, 0.24, 0.42, marble, block);
                }
            }
        }
        const cw = Math.min(w * 0.44, 18);
        for (let i = 0; i < 6; i++) column(-cw / 2 + i * cw / 5, d / 2 + 3.4, h * 0.66, block, 1.6);
        box(0, 1.6 + h * 0.66 + 0.8, d / 2 + 1.8, cw + 2.6, 1.5, 5, marble, block);
        pediment(cw + 3.4, 3.2, 1.4, 0, 1.6 + h * 0.66 + 1.55, d / 2 + 1.8, block, stone);
        box(0, 1.1, d / 2 + 1.2, cw * 0.6, 0.35, 4.8, marble, block);
        if (mansard) box(0, h + 4.6, 0, w - 5, 2, d - 5, roof, block);
        return block;
    };
    officeBuilding(97, 18, { w: 52, rot: -Math.PI / 2 });                          // Cannon
    officeBuilding(97, 78, { w: 64, rot: -Math.PI / 2 });                          // Longworth
    officeBuilding(97, 138, { w: 58, h: 21, rot: -Math.PI / 2, mansard: true });   // Rayburn
    officeBuilding(-97, -14, { w: 64, rot: Math.PI / 2 });                         // Russell
    officeBuilding(-97, 48, { w: 62, h: 21, rot: Math.PI / 2 });                   // Dirksen
    officeBuilding(-97, 104, { w: 56, rot: Math.PI / 2, mansard: true });          // Hart

    // The Botanic Garden conservatory at the foot of the hill: glass under a ribbed dome.
    const greenhouse = new THREE.MeshStandardMaterial({ color: '#cfe0e2', roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.72, envMapIntensity: 1.7 });
    materials.add(greenhouse);
    const garden = new THREE.Group(); garden.position.set(54, 0, 16); garden.rotation.y = -0.3; group.add(garden);
    box(0, 0.6, 0, 27, 1.2, 15, marble, garden);
    box(0, 4.1, 0, 25, 6, 13, greenhouse, garden);
    for (let i = -4; i <= 4; i++) for (const side of [-1, 1]) box(i * 3, 4.1, side * 6.55, 0.22, 6, 0.22, marble, garden);
    for (let i = -4; i <= 4; i++) box(0, 4.1, i * 1.45, 0.2, 6, 0.2, marble, garden);
    box(0, 7.3, 0, 26, 0.7, 14, marble, garden);
    const conservatoryDome = mesh(new THREE.SphereGeometry(6.8, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), greenhouse, 0, 7.6, 0, garden);
    conservatoryDome.scale.set(1.25, 0.7, 0.85);
    for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI;
        const rib = box(Math.sin(a) * 6.8 * 1.25, 7.6 + 3.4, Math.cos(a) * 6.8 * 0.85, 0.18, 6.6, 0.18, marble, garden);
        rib.rotation.set(Math.PI / 2 - 0.4, a, 0, 'YXZ');
    }
    cylinder(0, 12.5, 0, 0.9, 1.2, 2, copper, garden, 12);
    mesh(new THREE.ConeGeometry(1, 1.8, 10), copper, 0, 14.4, 0, garden);

    // The city within about a mile of the Capitol, each landmark on its true bearing and its
    // real distance compressed to fit the scene (+x south, -x north, +z west, -z east):
    //   west   Washington Monument 1.41 mi, National Gallery 0.59, Natural History 0.91,
    //          Air and Space 0.59, Smithsonian Castle 0.91
    //   north  Union Station 0.56 mi, NoMa towers 1.09
    //   east   Eastern Market 0.73 mi, Lincoln Park 1.22, Capitol Hill row houses
    //   south  L'Enfant Plaza 0.74 mi, Marine Barracks 0.81, the Wharf and Navy Yard 1.1-1.2
    const brick = mat('#8d5f52', 0.92, 0, SURFACE.generic);
    const tower = (x, z, w, d, h, material = darkStone) => {
        box(x, h / 2, z, w, h, d, material);
        box(x, h + 0.6, z, w + 1, 1.2, d + 1, marble);
        for (let i = 0; i < Math.floor(h / 7); i++) for (const side of [-1, 1]) {
            box(x, 4 + i * 6.5, z + side * (d / 2 + 0.1), w - 3, 1.5, 0.2, glass);
        }
    };

    // West: the Washington Monument on its knoll, and the Mall's museums flanking the axis.
    box(0, 0.7, 238, 30, 1.4, 30, stone);
    box(0, 12, 238, 12, 22, 12, marble);
    box(0, 30, 238, 9.6, 14, 9.6, marble);
    box(0, 43, 238, 8.2, 12, 8.2, marble);
    mesh(new THREE.ConeGeometry(5.4, 6.4, 4), marble, 0, 52.2, 238).rotation.y = Math.PI / 4;
    const museum = (x, w, h, dome) => {
        box(x, h / 2, 194, w, h, 28, stone);
        box(x, h + 0.6, 194, w + 2, 1.2, 30, marble);
        for (let i = 0, n = Math.floor(w / 9); i < n; i++) box(x - w / 2 + 5 + i * 9, h * 0.58, 208.1, 2.4, 3.6, 0.2, glass);
        if (dome) mesh(new THREE.SphereGeometry(h * 0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), copper, x, h + 1.2, 194);
    };
    museum(-52, 44, 15);            // National Gallery of Art
    museum(0, 54, 17, true);        // Natural History
    museum(52, 40, 13);             // Air and Space

    // North: Union Station's long colonnade and central pavilion, then the NoMa blocks.
    const station = new THREE.Group(); station.position.set(-168, 0, -18); station.rotation.y = Math.PI / 2; group.add(station);
    box(0, 0.7, 0, 124, 1.4, 26, stone, station);
    box(0, 9, 0, 120, 16, 22, stone, station);
    box(0, 17.6, 0, 122, 1.4, 24, marble, station);
    box(0, 12, 0, 32, 24, 24, stone, station);
    box(0, 25.2, 0, 36, 2.4, 28, marble, station);
    for (let i = 0; i < 8; i++) column(-48 + i * 13.7, 12.5, 12, station, 0);
    box(0, 13.6, 12.5, 112, 1.8, 4, marble, station);
    tower(-186, -96, 26, 26, 34);
    tower(-188, -64, 20, 20, 27);
    tower(-190, -128, 22, 22, 40);

    // East: the terrace of Capitol Hill row houses, then Eastern Market beyond them.
    for (let i = 0; i < 15; i++) {
        const hx = -66 + i * 9.2, hh = 11 + (i % 3) * 1.4;
        box(hx, hh / 2, -158, 8.6, hh, 14, i % 3 ? brick : stone);
        box(hx, hh + 0.5, -158, 9, 0.9, 14.6, roof);
        for (let f = 0; f < 3; f++) box(hx, 3 + f * 3.4, -150.9, 1.7, 2.1, 0.2, glass);
    }
    const market = new THREE.Group(); market.position.set(30, 0, -186); group.add(market);
    box(0, 0.6, 0, 42, 1.2, 22, stone, market);
    box(0, 5.4, 0, 40, 9.6, 20, brick, market);
    box(0, 10.6, 0, 42, 1.2, 22, marble, market);
    box(0, 12.6, 0, 13, 2.8, 13, marble, market);
    mesh(new THREE.ConeGeometry(9.5, 3, 4), roof, 0, 15.5, 0, market).rotation.y = Math.PI / 4;
    for (const side of [-1, 1]) box(0, 4.4, side * 10.1, 38, 5, 0.3, glass, market);
    // Lincoln Park at the far end of the terrace: a raised green with its low wall.
    box(-12, 0.35, -214, 44, 0.7, 34, stone);
    box(-12, 0.75, -214, 42, 0.2, 32, paving);
    box(-12, 2.2, -214, 3.4, 3.4, 3.4, marble);

    // South: L'Enfant Plaza's slabs, the Marine Barracks wall, and the Wharf beyond.
    tower(148, 92, 24, 24, 38);
    tower(154, 126, 20, 20, 30);
    tower(140, 58, 22, 18, 26, stone);
    box(112, 2.2, -96, 8, 4.4, 62, brick);
    box(123, 5, -96, 12, 10, 42, brick);
    box(123, 10.4, -96, 13, 0.8, 43, roof);
    tower(172, 168, 26, 26, 34, stone);
    tower(176, 198, 22, 22, 28);
    tower(150, 202, 20, 20, 24);

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

    // One draw call per window and per tree branch would cost far more than the detail is worth:
    // everything here is the same handful of boxes and cylinders, so identical pieces with the
    // same material become instanced batches. This is what lets the ring of office buildings and
    // the whole tree line exist without doubling the frame's draw calls.
    const batches = [];
    group.updateMatrixWorld(true);
    const pieces = [];
    group.traverse(object => { if (object.isMesh && !object.isInstancedMesh) pieces.push(object); });
    const buckets = new Map();
    for (const piece of pieces) {
        const params = piece.geometry.parameters;
        const shape = params?.shapes ? piece.geometry.uuid : `${piece.geometry.type}:${JSON.stringify(params ?? {})}`;
        const key = `${piece.material.uuid}|${shape}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(piece);
    }
    for (const members of buckets.values()) {
        if (members.length < 2) continue;
        const batch = new THREE.InstancedMesh(members[0].geometry, members[0].material, members.length);
        batch.castShadow = true; batch.receiveShadow = true;
        members.forEach((piece, i) => { batch.setMatrixAt(i, piece.matrixWorld); piece.parent.remove(piece); });
        group.add(batch);
        batches.push(batch);
    }

    return {
        group,
        update(time) { waterUniforms.uTime.value = time; },
        setDetail(value) { leaves.visible = value; },
        dispose() {
            batches.forEach(b => b.dispose());
            geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); leaves.dispose();
        },
    };
}
