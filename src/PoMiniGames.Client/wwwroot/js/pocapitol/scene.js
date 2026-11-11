import * as THREE from 'three';
import { areas, obstacles, columns, statues, milestones, lineDefs, selectLeader, groundHeight, CROWD_SIZE, MAX_POLICE, CIVILIANS, CURFEW_ELAPSED } from './world.js';
import { createCrowd, createDistantCrowd, flagTexture, coats } from './crowd.js';
import { SURFACE, addSurface, surfaceTexture, createSky, setSkyColors, createEnvironment, addWave, softTexture } from './look.js';
import { createParticles } from './particles.js';
import { createBursts } from './bursts.js';
import { createDecals } from './decals.js';
import { createPost } from './post.js';
import { createCampus } from './campus.js';
import { addArchitecturalDetail } from './architecture.js';

// The chamber is drawn but never walked: its doors stay barricaded, as they did. It is only
// seen in the closing shot, empty.
const CHAMBER_Z = -66;
// Sky, sun and fill light across the day, keyed by the share of 12:50 pm to 6:00 pm elapsed.
// Overcast and flat until the light goes at about five.
const SKY = [[0, '#aab3bd'], [0.6, '#a2a9b2'], [0.8, '#b09a8b'], [0.92, '#6a6877'], [1, '#2c3344']];
const SUN = [[0, 1.6], [0.6, 1.35], [0.8, 0.8], [0.92, 0.3], [1, 0.08]];
const FILL = [[0, 2.6], [0.8, 2.1], [1, 0.9]];
const ENV = [[0, 0.75], [0.8, 0.6], [0.92, 0.32], [1, 0.12]];
// Haze: thick enough that the far crowd and the dome sit in the air, as on a raw January day.
// Kept light enough that the city a mile out still reads as silhouettes through it.
const FOG_OUT = 0.0048, FOG_GAS = 0.024;
// The environment light is re-baked only when the sky has visibly changed.
const ENV_STAGES = [0, 0.62, 0.78, 0.88, 0.96];

// Surface kinds by base colour. Anything else light is dressed stone; darker colours get a
// fine generic grain.
const GRASS = new Set(['#657360', '#788168']);
const PAVING = new Set(['#b8b2a5', '#93948c', '#c7bfad', '#d9d3c4', '#c6bca9']);
// Plastic sheeting and painted seating: cloth-smooth, no stone coursing.
const PLAIN = new Set(['#e6e4dc', '#e9e9e4', '#8d8f8a']);
const MARBLE = new Set(['#eee7d8', '#e9e1cf', '#eeeadf', '#f1eadb', '#e1d7c6']);
const WOOD = new Set(['#5a3d2b', '#6c4b35', '#72533d', '#805f43', '#70503b', '#9a7956']);
const GLASS = new Set(['#435568', '#566371']);
const METAL = new Map([['#5d6468', [0.65, 0.42]], ['#4c5c54', [0.55, 0.5]], ['#b99b62', [0.8, 0.35]], ['#a78c4d', [0.8, 0.35]], ['#2f3236', [0.5, 0.5]]]);

function keyframe(frames, t) {
    let i = 0;
    while (i < frames.length - 2 && t > frames[i + 1][0]) i++;
    const [t0, a] = frames[i], [t1, b] = frames[i + 1];
    return { a, b, mix: Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) };
}
const level = (frames, t) => { const k = keyframe(frames, t); return k.a + (k.b - k.a) * k.mix; };

// Deterministic scatter so the far crowd and the litter sit in the same place every visit.
function scatter(seed) {
    return () => {
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Where the sun stands over the west front on 6 January, as a unit vector. +x is south and +z
 * west in this scene. 12:50 pm is about 29° up, a little west of south; it sets at about
 * 4:59 pm in the south-west. Kept a few degrees up so shadows never run to infinity.
 */
export function sunDirection(day, out = new THREE.Vector3()) {
    const minutes = day * CURFEW_ELAPSED, toSunset = Math.min(1, minutes / 249);
    const altitude = THREE.MathUtils.degToRad(Math.max(4, 29 * (1 - toSunset ** 1.6)));
    const azimuth = THREE.MathUtils.degToRad(190 + 48 * toSunset);
    return out.set(-Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude), -Math.sin(azimuth) * Math.cos(altitude));
}

export function createScene(host, { figure } = {}) {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(SKY[0][1], FOG_OUT);
    // The composer does the anti-aliasing (MSAA on its own target), so the canvas needs none.
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'PoCapitol third-person scene. Click to look around.');
    host.append(renderer.domElement);
    // Far enough to hold the city ring a mile out; near stays 0.1 so contact detail reads.
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 420);
    // Everything see-through (sky, sprites, decals, cloth) lives on layer 1. The main camera
    // sees both layers; the depth camera used by AO and depth of field sees solids only.
    camera.layers.enable(1);
    const depthCamera = new THREE.PerspectiveCamera();
    const fill = new THREE.HemisphereLight('#e5efff', '#786b59', FILL[0][1]);
    scene.add(fill);
    const sun = new THREE.DirectionalLight('#f4efe6', SUN[0][1]);
    sun.target.position.set(0, 0, 12);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 48, bottom: -48, near: 10, far: 210 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 3;
    scene.add(sun);
    const sunDir = sunDirection(0);
    const placeSun = () => sun.position.copy(sun.target.position).addScaledVector(sunDir, 110);
    placeSun();

    const time = { value: 0 };
    let breathClock = 0;
    const surfaceDetail = { value: 1 };
    const sky = createSky();
    sky.mesh.layers.set(1);
    scene.add(sky.mesh);
    const environment = createEnvironment(renderer);
    const skyColor = new THREE.Color(SKY[0][1]);
    setSkyColors(sky.uniforms, skyColor);
    setSkyColors(environment.uniforms, skyColor);
    scene.environment = environment.build();
    let envStage = 0;

    const materials = new Map(), geometries = new Set(), textures = new Set(), walls = [], loose = [];
    const surfaces = surfaceTexture();
    textures.add(surfaces);
    const shadowBlob = softTexture('shadow');
    textures.add(shadowBlob);
    function surfaceKind(color) {
        if (GRASS.has(color)) return SURFACE.grass;
        if (PAVING.has(color)) return SURFACE.paving;
        if (PLAIN.has(color)) return SURFACE.generic;
        if (MARBLE.has(color)) return SURFACE.marble;
        if (WOOD.has(color)) return SURFACE.wood;
        const c = new THREE.Color(color);
        return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.45 ? SURFACE.stone : SURFACE.generic;
    }
    function material(color, metalness = 0) {
        const key = `${color}:${metalness}`;
        if (!materials.has(key)) {
            let value;
            if (GLASS.has(color)) {
                // Old window glass: dark, smooth, and it shows the overcast.
                value = new THREE.MeshStandardMaterial({ color: '#2a3542', roughness: 0.08, metalness: 0.1, envMapIntensity: 1.6 });
            } else if (METAL.has(color)) {
                const [metal, rough] = METAL.get(color);
                value = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
            } else {
                value = addSurface(new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness }), surfaceKind(color), surfaces, surfaceDetail);
            }
            materials.set(key, value);
        }
        return materials.get(key);
    }
    function mesh(geometry, color, x, y, z, parent = scene) {
        geometries.add(geometry);
        const value = new THREE.Mesh(geometry, material(color));
        value.position.set(x, y, z);
        value.castShadow = true;
        value.receiveShadow = true;
        parent.add(value);
        return value;
    }
    function box(x, y, z, w, h, d, color, parent) {
        return mesh(new THREE.BoxGeometry(w, h, d), color, x, y, z, parent);
    }
    // `palette` is for the one order in the building that is not white marble: Statuary Hall's
    // variegated Breccia shaft under a Carrara capital.
    function column(x, z, height = 8, y = 0, girth = 1, palette = null) {
        const p = palette ?? { plinth: '#b8af9e', base: '#c6bca9', shaft: '#e2d9c8', collar: '#d5cca9', capital: '#ede5d6', abacus: '#f1eadb' };
        // Stepped square plinth base
        box(x, y + 0.14, z, 1.8 * girth, 0.28, 1.8 * girth, p.plinth);
        // Circular molded torus base
        mesh(new THREE.CylinderGeometry(0.72 * girth, 0.82 * girth, 0.26, 24), p.base, x, y + 0.41, z);
        // Fluted entasised column shaft
        mesh(new THREE.CylinderGeometry(0.52 * girth, 0.65 * girth, height - 1.2, 24), p.shaft, x, y + 0.54 + (height - 1.2) / 2, z);
        // Classical Corinthian / Composite capital: astragal collar, bell, and abacus
        mesh(new THREE.CylinderGeometry(0.58 * girth, 0.53 * girth, 0.16, 24), p.collar, x, y + height - 0.58, z);
        mesh(new THREE.CylinderGeometry(0.78 * girth, 0.55 * girth, 0.38, 24), p.capital, x, y + height - 0.31, z);
        box(x, y + height - 0.06, z, 1.68 * girth, 0.16, 1.68 * girth, p.abacus);
    }
    function painted(draw, width, height, options = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        draw(canvas.getContext('2d'));
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        textures.add(texture);
        const mat = new (options.lit ? THREE.MeshStandardMaterial : THREE.MeshBasicMaterial)({ map: texture, side: THREE.DoubleSide, ...options.material });
        materials.set(`painted-${textures.size}`, mat);
        return mat;
    }
    function label(text, x, y, z, width = 8, color = '#f6df9e') {
        const mat = painted(ctx => {
            ctx.fillStyle = '#172536'; ctx.fillRect(0, 0, 768, 128);
            ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.strokeRect(8, 8, 752, 112);
            ctx.fillStyle = color; ctx.font = '600 38px Georgia'; ctx.textAlign = 'center';
            ctx.fillText(text, 384, 78);
        }, 768, 128, { material: { side: THREE.FrontSide } });
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 6), mat);
        geometries.add(sign.geometry);
        sign.position.set(x, y, z);
        scene.add(sign);
    }
    const UP = new THREE.Vector3(0, 1, 0);
    /** A cylinder from `from` along `dir` (unit) for `length`, e.g. a branch or a brace. */
    function strut(geometry, color, from, dir, length) {
        const value = mesh(geometry, color, from.x + dir.x * length / 2, from.y + dir.y * length / 2, from.z + dir.z * length / 2);
        value.quaternion.setFromUnitVectors(UP, dir);
        return value;
    }

    // The grounds run out far enough to carry the city around the Capitol. The far edge sits in
    // the haze, so the plane reads as ground to the horizon rather than a lawn with an end.
    box(0, -0.3, 40, 420, 0.5, 520, '#657360');
    box(0, -0.04, 42, 24, 0.12, 60, '#b8b2a5');
    for (let z = 18; z < 70; z += 4) box(0, 0.03, z, 22, 0.015, 0.04, '#93948c');
    // Bare January trees: a trunk that forks three times, each fork a little thinner.
    const BRANCH = [[2.4, 0.13], [1.7, 0.08], [1.15, 0.045], [0.75, 0.022]].map(([length, radius]) => {
        const geometry = new THREE.CylinderGeometry(radius * 0.6, radius, length, 5);
        geometries.add(geometry);
        return { geometry, length };
    });
    function branch(from, dir, depth, rand) {
        const { geometry, length } = BRANCH[depth];
        strut(geometry, '#625343', from, dir, length);
        if (depth === BRANCH.length - 1) return;
        for (let k = 0; k < 3; k++) {
            const angle = k / 3 * Math.PI * 2 + rand() * 1.2;
            const tilt = 0.45 + rand() * 0.4;
            const child = new THREE.Vector3(Math.cos(angle) * Math.sin(tilt), Math.cos(tilt), Math.sin(angle) * Math.sin(tilt))
                .lerp(dir, 0.35).normalize();
            const at = from.clone().addScaledVector(dir, length * (0.65 + rand() * 0.35));
            branch(at, child, depth + 1, rand);
        }
    }
    for (const x of [-30, 30]) {
        box(x, 0, 51, 9, 0.1, 26, '#788168');
        for (const z of [22, 43, 57]) {
            const tx = x + (z === 22 ? 6 : 0), rand = scatter(tx * 31 + z);
            mesh(new THREE.CylinderGeometry(0.2, 0.35, 4, 8), '#625343', tx, 2, z);
            branch(new THREE.Vector3(tx, 3.6, z), new THREE.Vector3(0, 1, 0), 0, rand);
        }
    }
    // Exterior wings and portico evoke the public facade; interior adjacency is invented.
    const pedimentShape = new THREE.Shape();
    pedimentShape.moveTo(-1.2, 0); pedimentShape.lineTo(1.2, 0); pedimentShape.lineTo(0, 0.5); pedimentShape.closePath();
    const windowPediment = new THREE.ExtrudeGeometry(pedimentShape, { depth: 0.45, bevelEnabled: false });
    const baluster = new THREE.CylinderGeometry(0.08, 0.12, 0.62, 6);
    for (const x of [-25, 25]) {
        box(x, 5.2, 0, 32, 10.4, 29, '#d4cbb9');
        box(x, 10.6, 0, 34, 0.8, 30, '#eee7d8');
        // A continuous cornice and a balustrade along the roof line.
        box(x, 10.15, 15.05, 32.6, 0.3, 0.6, '#e9e1d1');
        box(x, 0.35, 14.75, 32.4, 0.7, 0.5, '#c6bca9');
        box(x, 11.05, 14.7, 33.6, 0.1, 0.45, '#eee7d8');
        box(x, 11.65, 14.7, 33.6, 0.14, 0.4, '#eee7d8');
        for (let bx = x - 16.5; bx <= x + 16.5; bx += 0.55) mesh(baluster, '#e8e0cf', bx, 11.35, 14.7);
        for (let wx = x - 13; wx <= x + 13; wx += 4.3) {
            box(wx, 10, 15, 2.8, 0.4, 0.8, '#b8af9e');
            box(wx, 11.35, 14.7, 0.5, 0.75, 0.5, '#eee7d8');
            for (const y of [3.3, 7.3]) {
                box(wx, y, 14.56, 1.5, 2.5, 0.08, '#435568');
                box(wx, y, 14.64, 0.1, 2.6, 0.08, '#e8dfcd');
                box(wx, y, 14.65, 1.5, 0.08, 0.09, '#e8dfcd');
                box(wx, y + 1.4, 14.65, 2.2, 0.25, 0.5, '#eee7d8');
                box(wx, y - 1.35, 14.68, 1.9, 0.14, 0.45, '#eee7d8');
            }
            mesh(windowPediment, '#eee7d8', wx, 8.85, 14.45);
        }
    }
    for (let step = 0; step < 5; step++) {
        for (const x of [-22, 22]) box(x, step * 0.12, 17.8 - step * 0.5, 28, 0.2, 1, '#d9d3c4');
    }
    box(0, 10, 13, 23, 1.2, 8, '#e5ddcd');
    const pediment = new THREE.Shape();
    pediment.moveTo(-12, 0); pediment.lineTo(12, 0); pediment.lineTo(0, 4); pediment.closePath();
    mesh(new THREE.ExtrudeGeometry(pediment, { depth: 1.2, bevelEnabled: false }), '#e7dfd0', 0, 10.6, 16.5);
    // Classical dentil molding row under the pediment cornice
    for (let dx = -11.2; dx <= 11.2; dx += 0.7) {
        box(dx, 10.42, 16.55, 0.38, 0.24, 0.3, '#dcd4c3');
    }
    for (const c of columns) column(c.x, c.z, c.height);
    label('PoCAPITOL', 0, 9.2, 17.7, 9);
    // The drum's lower wall. The Rotunda's inner dome rises to 19 m, well above the wings'
    // roofline, so without this the sphere shows from outside as a smooth mound under the dome.
    mesh(new THREE.CylinderGeometry(11.9, 12.4, 9.2, 48), '#ded7c9', 0, 14.8, -14);
    mesh(new THREE.CylinderGeometry(12.5, 12.6, 0.5, 48), '#e7e0d2', 0, 10.4, -14);
    mesh(new THREE.CylinderGeometry(12.15, 12.15, 0.35, 48), '#e7e0d2', 0, 19.4, -14);
    // The dome: drum and peristyle of 36 columns, attic, cast-iron shell with ribs and a ring
    // of windows, lantern with its own colonnade, and a robed bronze figure on top.
    mesh(new THREE.CylinderGeometry(11, 12.5, 6, 48), '#d8d1c3', 0, 22, -14);
    for (let i = 0; i < 36; i++) {
        const angle = i / 36 * Math.PI * 2, between = angle + Math.PI / 36;
        column(Math.sin(angle) * 11.9, -14 + Math.cos(angle) * 11.9, 5, 19, 0.75);
        const pane = box(Math.sin(between) * 11.05, 21.4, -14 + Math.cos(between) * 11.05, 1, 2.8, 0.12, '#566371');
        pane.rotation.y = between;
        const attic = box(Math.sin(between) * 11.18, 25.65, -14 + Math.cos(between) * 11.18, 0.55, 0.7, 0.08, '#566371');
        attic.rotation.y = between;
    }
    for (const [radius, y] of [[12.6, 19], [12.6, 24.7], [11.25, 26.4]])
        mesh(new THREE.CylinderGeometry(radius, radius, 0.55, 64), '#ede5d6', 0, y, -14);
    mesh(new THREE.CylinderGeometry(11.12, 11.12, 1.5, 64), '#e2dacb', 0, 25.6, -14);
    const domePoints = [[11, 0], [10.7, 2], [9.5, 5], [7, 8], [3, 10.5], [1.8, 11]]
        .map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(domePoints, 64), '#ede5d6', 0, 26.7, -14);
    for (let i = 0; i < 36; i++) {
        const angle = i / 36 * Math.PI * 2;
        const points = domePoints.map(p => new THREE.Vector3(Math.sin(angle) * (p.x + 0.04), p.y + 26.7, -14 + Math.cos(angle) * (p.x + 0.04)));
        mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.07, 4, false), '#c7c1b6', 0, 0, 0);
        const between = angle + Math.PI / 36;
        const dormer = box(Math.sin(between) * 10.92, 27.7, -14 + Math.cos(between) * 10.92, 0.45, 0.9, 0.08, '#566371');
        dormer.rotation.set(-0.1, between, 0, 'YXZ');
    }
    mesh(new THREE.CylinderGeometry(1.3, 1.8, 2.8, 24), '#c9c4b8', 0, 39, -14);
    for (let i = 0; i < 12; i++) {
        const angle = i / 12 * Math.PI * 2;
        mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.6, 6), '#ede5d6', Math.sin(angle) * 1.95, 39, -14 + Math.cos(angle) * 1.95);
    }
    mesh(new THREE.CylinderGeometry(2.1, 2.1, 0.3, 24), '#ede5d6', 0, 40.35, -14);
    mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.45, 24), '#ede5d6', 0, 40.5, -14);
    mesh(new THREE.SphereGeometry(0.42, 12, 8), '#4c5c54', 0, 41.05, -14);
    const robe = [[0.42, 0], [0.36, 0.6], [0.24, 1.25], [0.2, 1.5], [0.27, 1.62], [0, 1.72]].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(robe, 12), '#4c5c54', 0, 41.35, -14);
    mesh(new THREE.SphereGeometry(0.17, 10, 8), '#4c5c54', 0, 43.22, -14);
    box(0, 43.5, -14, 0.08, 0.42, 0.28, '#4c5c54');
    mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), '#4c5c54', 0.4, 42.4, -14);
    const shield = mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), '#4c5c54', -0.36, 42, -14);
    shield.rotation.z = Math.PI / 2;

    for (const area of areas.slice(1)) {
        box(area.x, 0.04, area.z, area.w, 0.12, area.d, '#c7bfad');
        if (area.name !== 'Rotunda') box(area.x, 8.2, area.z, area.w, 0.3, area.d, '#ded4be');
        // Merge exposed edge runs, omitting shared doorways between fictional rooms.
        for (const axis of ['x', 'z']) {
            const length = axis === 'x' ? area.w : area.d;
            for (const sign of [-1, 1]) {
                let start = null;
                for (let t = -length / 2; t <= length / 2 + 0.01; t += 0.5) {
                    const x = axis === 'x' ? area.x + t : area.x + sign * area.w / 2;
                    const z = axis === 'z' ? area.z + t : area.z + sign * area.d / 2;
                    const ox = x + (axis === 'z' ? sign * 0.2 : 0);
                    const oz = z + (axis === 'x' ? sign * 0.2 : 0);
                    const exposed = t < length / 2 && !areas.some(other => other !== area &&
                        Math.abs(ox - other.x) < other.w / 2 && Math.abs(oz - other.z) < other.d / 2);
                    if (exposed && start === null) start = t;
                    if (!exposed && start !== null) {
                        const mid = (start + t) / 2;
                        const wall = box(axis === 'x' ? area.x + mid : x, 4, axis === 'z' ? area.z + mid : z,
                            axis === 'x' ? t - start : 0.35, 8, axis === 'z' ? t - start : 0.35, '#d8cfbb');
                        walls.push(wall);
                        start = null;
                    }
                }
            }
        }
        if (area.w < 10) continue;
        const light = new THREE.PointLight('#ffe9bc', 24, 20, 1.8);
        light.position.set(area.x, 6, area.z);
        scene.add(light);
    }
    // Crypt: the compass star in the floor under the forest of columns.
    mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.03, 8), '#e9e1cf', 0, 0.13, 5);
    mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.035, 8), '#8f8371', 0, 0.14, 5);
    // Door headers: the rooms meet at full-height openings, so each sign gets a beam to sit on.
    box(0, 6.9, -3.85, 18, 2.6, 0.3, '#d8cfbb');
    box(0, 6.9, -44.85, 8, 2.6, 0.3, '#d8cfbb');
    box(0, 6.9, -25.85, 8, 2.6, 0.3, '#d8cfbb');
    label('ROTUNDA', 0, 6.6, -3.65, 6);
    for (let ring = 10, i = 0; ring > 0; ring -= 1.4, i++)
        mesh(new THREE.CylinderGeometry(ring, ring, 0.025, 64), ring < 2 ? '#eeeadf' : i % 2 ? '#b5a090' : '#ebe2cd',
            0, 0.14 + i * 0.006, -14);
    const innerDome = mesh(new THREE.SphereGeometry(11.5, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), '#d6c6ad', 0, 8, -14);
    const domeMaterial = addSurface(new THREE.MeshStandardMaterial({ color: '#d6c6ad', roughness: 0.95, side: THREE.DoubleSide }),
        SURFACE.stone, surfaces, surfaceDetail);
    materials.set('inner-dome', domeMaterial); innerDome.material = domeMaterial;
    for (const y of [7.6, 8.2]) {
        const cornice = mesh(new THREE.TorusGeometry(11.4, 0.22, 6, 64), '#e4dac6', 0, y, -14);
        cornice.rotation.x = Math.PI / 2;
    }
    for (const side of [-1, 1]) for (const z of [-5, -11, -17, -23]) {
        box(side * 16.65, 4, z, 0.25, 7.5, 1.1, '#e8dfc9');
        box(side * 16.4, 7.3, z, 0.55, 0.45, 1.6, '#baae97');
    }
    label('STATUARY HALL', 0, 6.6, -25.65, 7);
    // Statuary Hall's plain figures on plinths are drawn with the rest of its detail; the
    // black and white marble floor is laid there too.
    for (const s of statues) {
        box(s.x, 0.75, s.z, 1.3, 1.5, 1.3, '#cfc6b3');
        mesh(new THREE.CapsuleGeometry(0.32, 1.1, 3, 8), '#6f5b44', s.x, 2.45, s.z);
        mesh(new THREE.SphereGeometry(0.24, 8, 6), '#6f5b44', s.x, 3.45, s.z);
    }
    label('HOUSE WING', 0, 6.6, -44.65, 6);
    // The chamber doors: shut, and they stay shut.
    for (const side of [-1, 1]) {
        box(side * 1.25, 3, -52.75, 2.4, 6, 0.18, '#5a3d2b');
        box(side * 1.25, 3.4, -52.64, 1.6, 2.2, 0.05, '#6c4b35');
        box(side * 0.25, 2.9, -52.62, 0.08, 0.5, 0.08, '#c2a25a');
        box(side * 2.7, 3.1, -52.7, 0.4, 6.4, 0.3, '#e1d7c6');
    }
    box(0, 6.3, -52.7, 5.8, 0.4, 0.3, '#e1d7c6');
    label('HOUSE CHAMBER', 0, 7.1, -52.6, 5.5);
    // Chamber interior, shifted behind those doors.
    const cz = z => z - 18;
    box(0, 0.04, CHAMBER_Z, 38, 0.12, 26, '#c7bfad');
    box(0, 8.2, CHAMBER_Z, 38, 0.3, 26, '#ded4be');
    for (const side of [-1, 1]) box(side * 19, 4, CHAMBER_Z, 0.35, 8, 26, '#d8cfbb');
    box(0, 4, CHAMBER_Z - 13, 38, 8, 0.35, '#d8cfbb');
    for (const side of [-1, 1]) box(side * 11.5, 4, CHAMBER_Z + 13 - 0.4, 15, 8, 0.35, '#d8cfbb');
    box(0, 0.15, cz(-47), 8, 0.1, 24, '#344f6b');
    box(0, 1, cz(-58.5), 12, 2, 3, '#72533d');
    box(0, 3.8, cz(-60.5), 7, 3.5, 0.15, '#e1d7c6');
    box(0, 2.25, cz(-57.7), 3.5, 0.5, 1.6, '#9a7956');
    box(0, 3.15, cz(-59), 1.5, 1, 0.6, '#70503b');
    for (const side of [-1, 1]) {
        box(side * 15, 4.7, cz(-48), 6.8, 0.4, 21, '#ae9a78');
        box(side * 11.7, 5.2, cz(-48), 0.18, 1, 21, '#84694a');
        box(side * 3.3, 4, cz(-60.2), 0.18, 3.1, 0.15, '#b99b62');
        for (let row = 0; row < 5; row++) for (let seat = 0; seat < 5; seat++) {
            const x = side * (5.5 + seat * 2.35), z = cz(-39 - row * 3.3);
            box(x, 0.55, z, 1.15, 0.55, 1.1, '#465c73');
            box(x, 1.1, z + 0.45, 1.15, 0.95, 0.16, '#40556c');
        }
        // Furniture stacked against the inside of the doors.
        box(side * 1.6, 0.7, CHAMBER_Z + 11.6, 2.6, 1.4, 1.1, '#805f43');
        box(side * 1.1, 1.75, CHAMBER_Z + 11.5, 1.8, 0.7, 0.9, '#72533d');
    }
    const chamberLight = new THREE.PointLight('#ffe9bc', 38, 30, 1.8);
    chamberLight.position.set(0, 6.5, CHAMBER_Z);
    scene.add(chamberLight);
    const flagMaterial = new THREE.MeshStandardMaterial({ map: flagTexture(), side: THREE.DoubleSide, roughness: 0.9 });
    textures.add(flagMaterial.map); materials.set('chamber-flag', flagMaterial);
    box(-2, 4, cz(-60.1), 0.12, 5, 0.12, '#a78c4d');
    mesh(new THREE.PlaneGeometry(3.8, 2.5), '#ffffff', 0, 5.4, cz(-59.7)).material = flagMaterial;
    const brace = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
    for (const o of obstacles) {
        if (o.kind === 'bleacher') {
            // Inauguration stands: tiers rising toward the building, on scaffold, with bunting,
            // wrapped at the sides and back in white plastic sheeting.
            for (let tier = 0; tier < 4; tier++) {
                box(o.x, (tier + 1) * 0.55, o.z + 2.25 - tier * 1.5, o.w, (tier + 1) * 1.1, 1.5, '#8d8f8a');
            }
            const posts = [-o.w / 2, -o.w / 6, o.w / 6, o.w / 2];
            for (const dx of posts) for (const dz of [-o.d / 2, o.d / 2]) {
                box(o.x + dx, 3.2, o.z + dz, 0.14, 6.4, 0.14, '#5d6468');
            }
            // Cross-bracing on the open front above the seats.
            for (let i = 0; i < posts.length - 1; i++) {
                const from = new THREE.Vector3(o.x + posts[i], 4.5, o.z + o.d / 2);
                const to = new THREE.Vector3(o.x + posts[i + 1], 6.2, o.z + o.d / 2);
                const dir = to.clone().sub(from), length = dir.length();
                strut(brace, '#5d6468', from, dir.normalize(), length).scale.set(1, length, 1);
            }
            box(o.x, 6.3, o.z, o.w + 0.4, 0.14, o.d + 0.4, '#e9e9e4');
            for (const side of [-1, 1]) box(o.x + side * (o.w / 2 + 0.1), 3.2, o.z, 0.04, 6.3, o.d, '#e6e4dc');
            box(o.x, 3.2, o.z - o.d / 2 - 0.1, o.w, 6.3, 0.04, '#e6e4dc');
            box(o.x, 1.05, o.z + o.d / 2 + 0.06, o.w, 0.7, 0.06, '#2b477a');
            box(o.x, 0.55, o.z + o.d / 2 + 0.07, o.w, 0.25, 0.06, '#b23a40');
        } else {
            box(o.x, o.h / 2, o.z, o.w, o.h, o.d, '#805f43');
            box(o.x, o.h, o.z, o.w + 0.1, 0.1, o.d + 0.1, '#b29364');
        }
    }
    // Lamps at the portico, lit as the afternoon goes.
    const lamps = [-7, 7].map(x => {
        const lamp = new THREE.PointLight('#ffd9a0', 0, 30, 1.6);
        lamp.position.set(x, 5, 19);
        scene.add(lamp);
        return lamp;
    });
    // Grounds lamp posts along the forecourt. Their globes glow (and bloom) at dusk; they add
    // no light of their own, which would cost every lit pixel.
    const globeMaterial = new THREE.MeshStandardMaterial({ color: '#f4ead2', emissive: '#ffd9a0', emissiveIntensity: 0, roughness: 0.3 });
    materials.set('lamp-globes', globeMaterial);
    for (const x of [-11.6, 11.6]) for (const z of [22, 30, 46, 54, 62]) {
        mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 8), '#2f3236', x, 0.25, z);
        mesh(new THREE.CylinderGeometry(0.06, 0.1, 3.4, 8), '#2f3236', x, 2, z);
        mesh(new THREE.SphereGeometry(0.24, 12, 8), '#f4ead2', x, 3.9, z).material = globeMaterial;
    }

    const architecturalDetail = addArchitecturalDetail({ box, mesh, column, materials, painted });
    for (const light of architecturalDetail.interiorLights) scene.add(light);

    const architectureBatches = [];
    scene.updateMatrixWorld(true);
    const repeated = new Map();
    for (const object of scene.children.filter(c => c.isMesh && c !== sky.mesh)) {
        const key = object.material.uuid + ':' + object.geometry.uuid;
        const shape = object.material.uuid + ':' + object.geometry.type + ':' + JSON.stringify(object.geometry.parameters);
        const id = object.geometry.parameters?.shapes ? key : shape;
        if (!repeated.has(id)) repeated.set(id, []);
        repeated.get(id).push(object);
    }
    for (const objects of repeated.values()) {
        if (objects.length < 2) continue;
        const batch = new THREE.InstancedMesh(objects[0].geometry, objects[0].material, objects.length);
        batch.castShadow = true; batch.receiveShadow = true;
        objects.forEach((object, i) => { batch.setMatrixAt(i, object.matrixWorld); scene.remove(object); });
        scene.add(batch); architectureBatches.push(batch);
    }

    // Everything below moves or appears during play, so it stays out of the static batches.
    const random = scatter(20210106), pose = new THREE.Object3D(), tint = new THREE.Color();
    function instanced(geometry, mat, count) {
        geometries.add(geometry);
        const value = new THREE.InstancedMesh(geometry, mat, count);
        value.frustumCulled = false;
        scene.add(value); loose.push(value);
        return value;
    }
    // The thousands who stayed outside: painted figures turned to the camera, never simulated.
    const DISTANT = 1400;
    const farSpots = [];
    for (let i = 0; i < DISTANT; i++) {
        const behind = random() < 0.55;
        const x = behind ? (random() * 2 - 1) * 82 : (random() < 0.5 ? -1 : 1) * (40.5 + random() ** 1.6 * 46);
        const z = behind ? 110 + random() ** 1.5 * 44 : 18 + random() * 92;
        farSpots.push({ x, z, y: groundHeight(x, z), scale: 0.92 + random() * 0.16,
            coat: Math.floor(random() * coats.length), cell: Math.floor(random() * 8) });
    }
    const farCrowd = createDistantCrowd(scene, farSpots, { time, shadowTexture: shadowBlob });
    const farFlagMaterial = addWave(new THREE.MeshLambertMaterial({ map: flagTexture(), side: THREE.DoubleSide }), time);
    textures.add(farFlagMaterial.map); materials.set('far-flags', farFlagMaterial);
    const farFlags = instanced(new THREE.PlaneGeometry(1.7, 1.1, 12, 4), farFlagMaterial, 70);
    farFlags.layers.set(1);
    const poleMaterial = new THREE.MeshStandardMaterial({ color: '#b7a587', roughness: 0.6 });
    materials.set('far-poles', poleMaterial);
    const farPoles = instanced(new THREE.CylinderGeometry(0.025, 0.03, 1, 5), poleMaterial, 70);
    for (let i = 0; i < 70; i++) {
        const spot = farSpots[i * 20], yaw = random() * 0.6 - 0.3, top = 3.3 + random() * 0.6;
        pose.position.set(spot.x, spot.y + top, spot.z); pose.rotation.set(0, yaw, 0);
        pose.scale.setScalar(1); pose.updateMatrix();
        farFlags.setMatrixAt(i, pose.matrix);
        const poleX = spot.x - Math.cos(yaw) * 0.85, poleZ = spot.z + Math.sin(yaw) * 0.85;
        pose.position.set(poleX, spot.y + (top + 0.55) / 2, poleZ); pose.rotation.set(0, 0, 0);
        pose.scale.set(1, top + 0.55, 1); pose.updateMatrix();
        farPoles.setMatrixAt(i, pose.matrix);
    }
    // Bike racks along the first line. They bow with the line and go over when it breaks.
    const rackMaterial = painted(ctx => {
        ctx.strokeStyle = '#aab1b6'; ctx.lineCap = 'round';
        ctx.lineWidth = 9; ctx.strokeRect(8, 10, 240, 96);
        ctx.lineWidth = 5;
        for (let x = 30; x < 240; x += 22) { ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, 106); ctx.stroke(); }
        ctx.lineWidth = 9;
        for (const x of [24, 232]) { ctx.beginPath(); ctx.moveTo(x - 14, 122); ctx.lineTo(x + 14, 122); ctx.moveTo(x, 106); ctx.lineTo(x, 122); ctx.stroke(); }
    }, 256, 128, { lit: true, material: { alphaTest: 0.4, metalness: 0.5, roughness: 0.5 } });
    const RACKS = 9, rackSpan = lineDefs[0].x1 - lineDefs[0].x0;
    const racks = instanced(new THREE.PlaneGeometry(rackSpan / RACKS, 1.2), rackMaterial, RACKS);
    racks.castShadow = true;
    // Velvet ropes in Statuary Hall, knocked flat once the doorway line gives.
    const ropes = [-1, 1].map(side => {
        const group = new THREE.Group();
        group.position.set(side * 7.6, 0, -37);
        for (const z of [-5, 0, 5]) mesh(new THREE.CylinderGeometry(0.06, 0.1, 1, 8), '#b99b62', 0, 0.55, z, group);
        for (const z of [-2.5, 2.5]) box(0, 0.86, z, 0.07, 0.07, 5, '#7c2c36', group);
        scene.add(group);
        return { group, side };
    });
    // Smashed panes beside the doors, shown once the building is entered.
    const crackMaterial = painted(ctx => {
        ctx.fillStyle = '#0d141b';
        ctx.beginPath();
        for (const [x, y] of [[40, 30], [96, 18], [112, 80], [84, 150], [30, 132], [52, 84]]) ctx.lineTo(x, y);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#eef3f5'; ctx.lineWidth = 2;
        for (const [x, y] of [[4, 6], [124, 4], [126, 190], [6, 196], [64, 2], [2, 100], [126, 110]]) {
            ctx.beginPath(); ctx.moveTo(70, 86); ctx.lineTo(x, y); ctx.stroke();
        }
    }, 128, 200, { material: { transparent: true, side: THREE.FrontSide } });
    const cracks = [-16.3, -12, 12, 16.3].map(x => {
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.5), crackMaterial);
        geometries.add(pane.geometry);
        pane.position.set(x, 3.3, 14.72); pane.visible = false;
        pane.layers.set(1);
        scene.add(pane);
        return pane;
    });
    // Papers on the floor of each room the crowd has reached, ordered by the line guarding it.
    const paperMaterial = new THREE.MeshStandardMaterial({ color: '#ece7da', side: THREE.DoubleSide, roughness: 0.9 });
    materials.set('papers', paperMaterial);
    const paperRooms = [[1, 1, 26], [2, 2, 40], [4, 3, 34], [5, 4, 14]];
    const papers = instanced(new THREE.PlaneGeometry(0.3, 0.22), paperMaterial, paperRooms.reduce((n, r) => n + r[2], 0));
    papers.receiveShadow = true;
    const paperGates = [];
    for (const [areaIndex, gate, count] of paperRooms) {
        const area = areas[areaIndex];
        for (let i = 0; i < count; i++) {
            pose.position.set(area.x + (random() - 0.5) * (area.w - 2), 0.12 + paperGates.length * 0.0004, area.z + (random() - 0.5) * (area.d - 2));
            pose.rotation.set(-Math.PI / 2, 0, random() * Math.PI * 2); pose.scale.setScalar(0.8 + random() * 0.6); pose.updateMatrix();
            papers.setMatrixAt(paperGates.length, pose.matrix);
            paperGates.push(gate);
        }
    }
    papers.count = 0;
    // Outdoor environmental debris & protest clutter: placards, stakes, and debris
    const placardMaterial = new THREE.MeshStandardMaterial({ color: '#e8e0cc', roughness: 0.85 });
    materials.set('placards', placardMaterial);
    const CLUTTER_COUNT = 96;
    const clutterPlacards = instanced(new THREE.BoxGeometry(0.75, 0.03, 0.55), placardMaterial, CLUTTER_COUNT);
    clutterPlacards.receiveShadow = true;
    clutterPlacards.castShadow = true;
    for (let i = 0; i < CLUTTER_COUNT; i++) {
        const cx = (random() * 2 - 1) * 36;
        const cz = 22 + random() * 64;
        const cy = groundHeight(cx, cz) + 0.04;
        pose.position.set(cx, cy, cz);
        pose.rotation.set((random() - 0.5) * 0.15, random() * Math.PI * 2, (random() - 0.5) * 0.15);
        pose.scale.setScalar(0.75 + random() * 0.5);
        pose.updateMatrix();
        clutterPlacards.setMatrixAt(i, pose.matrix);
    }
    clutterPlacards.instanceMatrix.needsUpdate = true;
    // Gas, spray and flash-bangs: soft sprites, plus the flash's light.
    const particles = createParticles(scene);
    // Rounds in flight in the armed demo: short bright streaks, no impact effects.
    const tracerMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe9a8').multiplyScalar(3) });
    materials.set('tracers', tracerMaterial);
    const tracers = instanced(new THREE.BoxGeometry(0.06, 0.06, 0.9), tracerMaterial, 64);
    tracers.layers.set(1);
    tracers.count = 0;
    let tracerMode = 'luminous';
    let motionReduction = false;
    function setTracerMode(mode) {
        if (['luminous', 'stealth', 'off'].includes(mode)) {
            tracerMode = mode;
            if (mode === 'stealth') {
                tracerMaterial.color.set('#64748b');
            } else {
                tracerMaterial.color.set(new THREE.Color('#ffe9a8').multiplyScalar(3));
            }
        }
    }
    function setMotionReduction(calmVal) {
        motionReduction = Boolean(calmVal);
    }
    const flashLight = new THREE.PointLight('#ffffff', 0, 45, 1.2);
    scene.add(flashLight);
    const muzzleLight = new THREE.PointLight('#ffe494', 0, 16, 2.0);
    scene.add(muzzleLight);
    let recoilPitch = 0, recoilDolly = 0, retinalFlash = 0;
    // GPU bursts (sparks and dust solved in the vertex shader), wear that stays on the ground, and
    // two flare lights that blaze where a spark shower lands. The lights exist from the start at
    // zero so the light count never changes and no shader recompiles when one is needed.
    const bursts = createBursts(scene);
    const decals = createDecals(scene);
    const flares = [0, 1].map(() => { const light = new THREE.PointLight('#ffb35c', 0, 14, 1.8); scene.add(light); return light; });
    const reacted = new WeakSet();
    function flare(x, y, z, intensity, color) {
        const light = flares[0].intensity <= flares[1].intensity ? flares[0] : flares[1];
        light.position.set(x, y, z); light.color.set(color); light.intensity = intensity;
    }

    const crowd = createCrowd(scene, CROWD_SIZE + MAX_POLICE + CIVILIANS + 1, { time, groundHeight, shadowTexture: shadowBlob, figure });
    const marker = mesh(new THREE.TorusGeometry(1.1, 0.08, 8, 36), '#ebce77', 0, 0.2, 23);
    marker.rotation.x = -Math.PI / 2;
    marker.material = new THREE.MeshStandardMaterial({ color: '#ebce77', emissive: '#c99a2e', emissiveIntensity: 0.6 });
    materials.set('marker', marker.material);
    const beacon = mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), '#f3d37e', 0, 1.7, 23);
    beacon.material = marker.material;

    // OpenStreetMap 3D surrounding grounds and monumental structures
    const campus = createCampus({ surfaces, surfaceDetail });
    scene.add(campus.group);

    // Tactical Unit Inspector target selection ring
    const selectRingGeo = new THREE.RingGeometry(0.65, 0.9, 32);
    selectRingGeo.rotateX(-Math.PI / 2);
    const selectRingMat = new THREE.MeshBasicMaterial({ color: 0xff3838, side: THREE.DoubleSide });
    const selectRing = new THREE.Mesh(selectRingGeo, selectRingMat);
    selectRing.visible = false;
    scene.add(selectRing);

    const post = createPost(renderer, scene, camera, depthCamera);
    const raycaster = new THREE.Raycaster();
    const target = new THREE.Vector3(), desired = new THREE.Vector3(), offset = new THREE.Vector3(), look = new THREE.Vector3(), smoothLook = new THREE.Vector3();
    let renderScale = 1;
    function resize() {
        const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
        const ratio = Math.min(devicePixelRatio, 1.6) * renderScale;
        renderer.setPixelRatio(ratio);
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
        post.setSize(w, h, ratio);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host); resize();

    /** Applies one rung of quality.js: resolution, shadows, far-crowd size, post and small detail. */
    function applyQuality(settings) {
        renderScale = settings.scale;
        resize();
        const shadows = settings.shadows > 0;
        if (renderer.shadowMap.autoUpdate !== shadows) {
            // Switching shadows off the usual way recompiles every lit shader, a multi-second
            // freeze on exactly the devices that need the help. Instead the shadow pass is
            // parked: one last render with nothing in range leaves an empty map, and it is
            // never redrawn. Same shaders, no shadow pass, no hitch.
            Object.assign(sun.shadow.camera, shadows ? { near: 1, far: 230 } : { near: 0.01, far: 0.02 });
            sun.shadow.camera.updateProjectionMatrix();
            renderer.shadowMap.autoUpdate = shadows;
            renderer.shadowMap.needsUpdate = true;
        }
        if (shadows && sun.shadow.mapSize.x !== settings.shadows) {
            sun.shadow.mapSize.set(settings.shadows, settings.shadows);
            sun.shadow.map?.dispose(); sun.shadow.map = null;
        }
        const distant = Math.floor(DISTANT * settings.distant);
        farCrowd.setCount(distant);
        farFlags.count = farPoles.count = Math.floor(70 * settings.distant);
        crowd.setExtras(settings.extras);
        bursts.setDensity(settings.extras ? 1 : 0.3);
        papers.visible = settings.extras;
        clutterPlacards.visible = settings.extras;
        campus.setDetail(settings.extras);
        // Surface detail is a uniform, not a define: lowering it costs no recompile.
        surfaceDetail.value = settings.detail ?? 1;
        post.setLevel(settings.post ?? 0);
        host.dataset.renderScale = settings.scale;
        host.dataset.shadows = settings.shadows;
        host.dataset.post = settings.post ?? 0;
    }

    const calm = () => window.PoQuality?.reduceFlashing?.() === true || matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The opening establishing shot: five seconds high over the west front, sweeping across the
    // grounds, the crowd and the whole building before the camera drops behind the player. It
    // runs once per attempt, holds the world still so the opening costs no clock, and is skipped
    // for anyone who asked for reduced motion.
    const INTRO_SECONDS = 5, INTRO_RETURN = 1.6;
    const intro = { active: false, t: 0 };
    const introPos = new THREE.Vector3(), introLook = new THREE.Vector3(), introAim = new THREE.Vector3();
    function startIntro() { intro.active = !calm(); intro.t = 0; }
    const introActive = () => intro.active;
    let followYaw = 0, cameraReady = false, closing = 0, lastSubject = null, clock = 0, lastRack = -99;
    let lastHealth = null, lastDaze = -99;
    const dazzled = new WeakSet();
    const lastFocus = { x: 0, z: 100 };
    // Scenario time for the GPU bursts: it stops with the game, so a paused spark shower hangs in the air.
    let fxClock = 0;
    function render(state, yaw, pitch, moving, dt, options = {}) {
        clock += dt;
        time.value = clock;
        sky.uniforms.uTime.value = clock;
        campus.update(clock);
        const spectating = state.role === 'none';
        // How much of the establishing shot is on screen this frame, 0 when it is not running.
        let introWeight = 0;
        if (intro.active) {
            intro.t += dt;
            if (intro.t >= INTRO_SECONDS + INTRO_RETURN) intro.active = false;
            else {
                const p = Math.min(1, intro.t / INTRO_SECONDS);
                const ease = p * p * (3 - 2 * p);
                const fadeIn = Math.min(1, intro.t / 0.9);
                const fadeOut = intro.t <= INTRO_SECONDS ? 1 : Math.max(0, 1 - (intro.t - INTRO_SECONDS) / INTRO_RETURN);
                introWeight = fadeIn * fadeOut;
                // A slow arc from the south-west of the lawn round to the north-east, looking back
                // at the west front: the plaza, the two lines and the dome all stay in frame.
                introPos.set(-62 + 118 * ease, 48 - 8 * ease, 118 - 22 * ease);
                introLook.set(0, 24 - 2 * ease, 0);
            }
        }
        const latched = options.latchedUnit;
        const inspected = options.inspectedUnit;
        const weather = options.weather;

        if (inspected) {
            selectRing.position.set(inspected.x, groundHeight(inspected.x, inspected.z) + 0.05, inspected.z);
            selectRing.visible = true;
        } else {
            selectRing.visible = false;
        }

        const subject = latched || (spectating ? selectLeader(state) : state.player);
        host.dataset.crowdBatches = crowd.batchCount;
        host.dataset.cameraSubject = spectating ? subject?.id ?? 'none' : 'human';
        if (spectating || latched) {
            if (subject) {
                if (spectating && !latched) {
                    // Demo mode: follow the general advance direction of the crowd towards the Capitol (-Z)
                    // Blend individual heading with the broader march direction towards the facade
                    const marchDir = Math.atan2(0 - subject.x, -50 - subject.z);
                    const targetYaw = (subject.heading ?? 0) * 0.25 + marchDir * 0.75;
                    const delta = targetYaw - followYaw;
                    // Slower, cinematic heading rotation without sudden snaps or jitter
                    followYaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-dt * 0.85));
                    pitch = -0.16;
                } else {
                    const delta = (subject.heading ?? 0) - followYaw;
                    followYaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-dt * 3));
                    pitch = -0.12;
                }
            }
            yaw = followYaw;
        } else followYaw = yaw;

        // The day: a raw overcast with a low sun that sinks south-west and is gone by five.
        const day = Math.min(1, state.elapsed / CURFEW_ELAPSED);
        const sky0 = keyframe(SKY, day);
        skyColor.set(sky0.a).lerp(tint.set(sky0.b), sky0.mix);
        setSkyColors(sky.uniforms, skyColor);
        scene.fog.color.copy(skyColor);
        sun.intensity = level(SUN, day);
        // The image-based light now carries most of the ambient, so the old fill is cut back.
        fill.intensity = level(FILL, day) * 0.4;
        scene.environmentIntensity = level(ENV, day);
        sun.color.set('#f4efe6').lerp(tint.set('#ffc48a'), Math.max(0, Math.min(1, (day - 0.55) / 0.25)));
        sunDirection(day, sunDir); placeSun();
        sky.uniforms.uSunDir.value.copy(sunDir);
        sky.uniforms.uSunColor.value.copy(sun.color);
        let stage = 0;
        while (stage < ENV_STAGES.length - 1 && day >= ENV_STAGES[stage + 1]) stage++;
        if (stage !== envStage) {
            envStage = stage;
            setSkyColors(environment.uniforms, skyColor);
            environment.uniforms.uSunDir.value.copy(sunDir);
            scene.environment = environment.build();
        }
        const dusk = Math.max(0, Math.min(1, (day - 0.75) / 0.15));
        for (const lamp of lamps) lamp.intensity = dusk * 70;
        globeMaterial.emissiveIntensity = 0.2 + dusk * 4;
        const daylight = Math.min(1, (sun.intensity + fill.intensity * 2.5) / (SUN[0][1] + FILL[0][1]));
        farCrowd.setLight(0.3 + 0.62 * daylight);
        const indoorGas = state.effects.some(e => e.type === 'gas' && e.z < 14);
        const baseFog = weather?.fogDensity ?? FOG_OUT;
        if (weather?.cloudCover !== undefined) sky.uniforms.uCloud.value = weather.cloudCover;
        const indoors = subject?.z < 15;
        // The establishing shot looks through thinner air, or the whole scene would be haze.
        const targetFog = (indoorGas ? FOG_GAS : baseFog * (indoors ? 0.22 : 1)) * (1 - 0.4 * introWeight);
        scene.fog.density += (targetFog - scene.fog.density) * (1 - Math.exp(-dt * 1.5));

        const goal = state.role === 'raider' || spectating ? milestones[state.milestone] : null;
        marker.visible = beacon.visible = !!goal;
        if (goal) {
            marker.position.set(goal.x, 0.2, goal.z);
            beacon.position.set(goal.x, 1.7, goal.z);
        }

        // The first line's racks.
        const first = state.lines[0], firstDef = lineDefs[0];
        for (let i = 0; i < RACKS; i++) {
            const x = firstDef.x0 + (i + 0.5) * rackSpan / RACKS;
            if (first.state === 'holding') {
                const bow = (1 - first.integrity / 100) * 1.4 * Math.cos(Math.PI * x / rackSpan);
                pose.position.set(x, 0.62, firstDef.z + 0.35 - bow);
                pose.rotation.set(-(1 - first.integrity / 100) * 0.25, 0, 0);
            } else {
                pose.position.set(x + (i % 3 - 1) * 0.7, 0.08, firstDef.z - 0.6 - (i % 4) * 0.9);
                pose.rotation.set(-Math.PI / 2, 0, (i * 37 % 11 - 5) * 0.12);
            }
            pose.scale.setScalar(1); pose.updateMatrix();
            racks.setMatrixAt(i, pose.matrix);
        }
        racks.instanceMatrix.needsUpdate = true;
        const hallOpen = state.lines[3].state === 'broken';
        for (const rope of ropes) {
            rope.group.rotation.z = hallOpen ? rope.side * 1.45 : 0;
            rope.group.position.y = hallOpen ? 0.1 : 0;
        }
        const enteredBuilding = state.lines[1].state === 'broken';
        for (const pane of cracks) pane.visible = enteredBuilding;
        let visiblePapers = 0;
        while (visiblePapers < paperGates.length && state.lines[paperGates[visiblePapers]].state === 'broken') visiblePapers++;
        papers.count = visiblePapers;

        const quiet = calm();
        particles.update(state.effects, state.elapsed, daylight, quiet);
        // World events become sparks, dust, wear and a flash of light, once each.
        for (const e of state.events) {
            if (reacted.has(e)) continue;
            reacted.add(e);
            const floor = groundHeight(e.x, e.z);
            bursts.react(e, floor, quiet);
            decals.react(e, floor);
            const energy = e.energy ?? 0;
            if (e.type === 'gunshot') {
                muzzleLight.position.set(e.x, floor + 1.35, e.z);
                muzzleLight.intensity = quiet ? 35 : 240;
                recoilPitch += 0.035; recoilDolly += 0.07;
            } else if (e.type === 'flash') {
                retinalFlash = 1.0;
            }
            if (!quiet && (e.type === 'gunshot' || e.type === 'baton' || (e.type === 'impact' && e.material !== 'body' && energy > 60))) {
                flare(e.tx ?? e.x, floor + 1.2, e.tz ?? e.z, e.type === 'gunshot' ? 120 : 40 + Math.min(200, energy), e.material === 'metal' ? '#9fc4ff' : '#ffb35c');
            }
        }
        for (const light of flares) light.intensity *= Math.exp(-dt * 14);
        muzzleLight.intensity *= Math.exp(-dt * 26);
        const calmMode = quiet || motionReduction;
        retinalFlash = Math.max(0, retinalFlash - dt * 1.4);
        recoilPitch *= Math.exp(-dt * 12);
        recoilDolly *= Math.exp(-dt * 9);
        post.setCombatStress?.(calmMode ? 0 : retinalFlash, calmMode ? ((state.suppression ?? 0) * 0.2) : (state.suppression ?? 0));

        if (state.status === 'active') fxClock += dt;
        bursts.update(fxClock, camera, renderer.domElement.height, groundHeight(camera.position.x, camera.position.z));
        decals.update(daylight);
        let flash = 0, flashAt = null;
        for (const effect of state.effects) {
            if (effect.type !== 'flash') continue;
            flashLight.position.set(effect.x, 2.2, effect.z);
            flash = (calmMode ? 35 : 900) * effect.life / effect.span;
            flashAt = effect;
        }
        const shots = tracerMode === 'off' ? 0 : Math.min(state.shots.length, 64);
        for (let i = 0; i < shots; i++) {
            const shot = state.shots[i];
            pose.position.set(shot.x, shot.y ?? 1.35, shot.z); pose.rotation.set(0, Math.atan2(shot.dx, shot.dz), 0);
            const scale = tracerMode === 'stealth' ? 0.45 : 1.0;
            pose.scale.set(scale, scale, scale); pose.updateMatrix();
            tracers.setMatrixAt(i, pose.matrix);
        }
        tracers.count = shots; tracers.instanceMatrix.needsUpdate = true;
        flashLight.intensity = flash;

        if (subject) { lastFocus.x = subject.x; lastFocus.z = subject.z; }
        const focus = subject || lastFocus;
        sun.target.position.lerp(new THREE.Vector3(focus.x, 0, focus.z), 0.08);
        sun.position.copy(sun.target.position).addScaledVector(sunDir, 110);
        const floor = groundHeight(focus.x, focus.z);
        target.set(focus.x, floor + 1.65, focus.z);
        // In demo mode: higher, wider cinematic framing to capture crowd formations and advancing line
        const camDist = (spectating && !latched) ? 9.2 : 6.5;
        const camHeight = (spectating && !latched) ? 4.8 : 3.7;
        desired.set(focus.x + Math.sin(yaw) * camDist, floor + camHeight + pitch * 3, focus.z + Math.cos(yaw) * camDist);
        // Recoil kick and combat suppression jitter
        if (!quiet) {
            desired.y += recoilPitch * 1.5;
            desired.x += Math.sin(yaw) * recoilDolly + ((state.suppression ?? 0) > 0 ? Math.sin(clock * 32) * 0.04 * state.suppression : 0);
            desired.z += Math.cos(yaw) * recoilDolly;
        }
        // Walking: the camera rides the step a little, unless the viewer asked for less motion.
        if (!spectating && moving && !quiet && state.status === 'active') desired.y += Math.abs(Math.sin(clock * 8.5)) * 0.05;
        offset.copy(desired).sub(target);
        raycaster.set(target, offset.clone().normalize());
        const hit = raycaster.intersectObjects(walls, false)[0];
        if (hit && hit.distance < offset.length()) desired.copy(target).addScaledVector(offset.normalize(), Math.max(0.3, hit.distance - 0.3));
        look.set(focus.x - Math.sin(yaw) * 10, floor + 1.5 - pitch * 5, focus.z - Math.cos(yaw) * 10);
        // Closing shot: past the doors nobody got through, into the chamber they had emptied.
        const wasClosing = closing > 0;
        closing = state.outcome === 'doors' && state.status !== 'active' ? Math.min(1, closing + dt / 2.5) : 0;
        if (closing > 0) {
            const ease = closing * closing * (3 - 2 * closing);
            desired.lerp(target.set(0, 6.4, CHAMBER_Z + 11), ease);
            look.lerp(target.set(0, 1.4, CHAMBER_Z - 9), ease);
            camera.position.copy(desired);
            if (!wasClosing) post.rackFocus(14, 2.2, 0.7);
        } else if (spectating && cameraReady) {
            // Slower, cinematic gliding crane/dolly: zero fast cuts or sudden snaps
            const followSpeed = latched ? 3.0 : 1.35;
            camera.position.lerp(desired, 1 - Math.exp(-dt * followSpeed));
        } else camera.position.copy(desired);
        cameraReady = true;
        // Spectator view: gentle steadycam drift
        if (spectating && closing === 0 && !quiet) {
            camera.position.x += Math.sin(clock * 0.35) * 0.03 + Math.sin(clock * 0.85 + 2) * 0.015;
            camera.position.y += Math.sin(clock * 0.45 + 1) * 0.025;
        }
        // Smooth cinematic look-at: pans gracefully across subject changes instead of snapping
        if (spectating && cameraReady) {
            smoothLook.lerp(look, 1 - Math.exp(-dt * 2.0));
            camera.lookAt(smoothLook);
        } else {
            smoothLook.copy(look);
            camera.lookAt(look);
        }
        // The establishing shot blends position and aim together, so the camera glides up over
        // the grounds and back down behind the player instead of cutting.
        if (introWeight > 0) {
            camera.position.lerp(introPos, introWeight);
            introAim.copy(smoothLook).lerp(introLook, introWeight);
            camera.lookAt(introAim);
        }
        // A new subject gets a gentle, subtle pull of focus (no jarring blur)
        if (spectating && subject && subject.id !== lastSubject && lastSubject !== null && clock - lastRack > 14) {
            post.rackFocus(9.2, 1.2, 0.35); lastRack = clock;
        }
        lastSubject = subject?.id ?? lastSubject;
        // In play the eyes lose focus for a moment: a blow, a flash-bang close by, going down.
        if (!spectating && state.status === 'active') {
            const drop = lastHealth === null ? 0 : lastHealth - state.health;
            const strength = quiet ? 0.5 : 1;
            if (state.health <= 0 && lastHealth > 0) { post.rackFocus(1.2, 2.4, strength); lastDaze = clock; }
            else if (drop >= 2.5 && clock - lastDaze > 1.2) { post.rackFocus(1.2, 0.25, 0.85 * strength); lastDaze = clock; }
            for (const effect of state.effects) {
                if (effect.type !== 'flash' || dazzled.has(effect)) continue;
                dazzled.add(effect);
                if (Math.hypot(effect.x - state.player.x, effect.z - state.player.z) < 12) {
                    post.rackFocus(1, 0.9, 1.2 * strength); lastDaze = clock;
                }
            }
        }
        lastHealth = spectating ? null : state.health;
        // A nearby flash-bang jolts the camera.
        if (flashAt && !quiet) {
            const near = Math.max(0, 1 - Math.hypot(flashAt.x - camera.position.x, flashAt.z - camera.position.z) / 25);
            const jolt = near * (flashAt.life / flashAt.span) ** 2 * 0.25;
            camera.translateX(Math.sin(clock * 47) * jolt); camera.translateY(Math.sin(clock * 61 + 1) * jolt);
        }
        sky.mesh.position.copy(camera.position);
        depthCamera.copy(camera);
        depthCamera.layers.set(0);
        host.dataset.actorCount = crowd.update(state, spectating ? 0 : yaw, moving, camera.position);
        breathClock += dt;
        if (breathClock > 1.8 && !quiet) {
            breathClock = 0;
            const camPos = camera.position;
            const nearby = [
                ...(state.player ? [state.player] : []),
                ...(state.companions || []).slice(0, 24),
                ...(state.enemies || []).slice(0, 16),
            ];
            for (const a of nearby) {
                if (a && a.health > 0 && Math.hypot(a.x - camPos.x, a.z - camPos.z) < 18) {
                    const h = a.heading || 0;
                    const fl = groundHeight(a.x, a.z);
                    bursts.breath(a.x - Math.sin(h) * 0.22, fl + 1.62, a.z - Math.cos(h) * 0.22, -Math.sin(h), -Math.cos(h));
                }
            }
        }
        renderer.info.reset();
        post.render(dt, clock, quiet, camera, sun.position);
        host.dataset.drawCalls = renderer.info.render.calls;
    }
    function aim(state, yaw) {
        return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    }
    function pickUnit(clientX, clientY, state) {
        if (!state) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera({ x, y }, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(plane, hit)) return null;

        let best = null, bestDist = 2.8;
        const pool = [...state.companions, ...state.enemies];
        for (const actor of pool) {
            const d = Math.hypot(actor.x - hit.x, actor.z - hit.z);
            if (d < bestDist) {
                bestDist = d;
                best = actor;
            }
        }
        return best;
    }
    function dispose() {
        observer.disconnect();
        crowd.dispose();
        farCrowd.dispose();
        particles.dispose();
        bursts.dispose(); decals.dispose();
        for (const light of flares) scene.remove(light);
        post.dispose();
        campus.dispose();
        environment.dispose();
        scene.environment = null;
        sky.mesh.geometry.dispose(); sky.mesh.material.dispose();
        architectureBatches.forEach(b => b.dispose());
        loose.forEach(b => b.dispose());
        geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
    return { canvas: renderer.domElement, render, aim, pickUnit, applyQuality, dispose, renderer, camera, startIntro, introActive, setTracerMode, setMotionReduction };
}
