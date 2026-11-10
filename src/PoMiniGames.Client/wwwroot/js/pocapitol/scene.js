import * as THREE from 'three';
import { areas, obstacles, columns, milestones } from './world.js';

export function createScene(host) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#aebac7');
    scene.fog = new THREE.Fog('#aebac7', 65, 155);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'PoCapitol third-person scene. Click to look around.');
    host.append(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 230);
    scene.add(new THREE.HemisphereLight('#e5efff', '#786b59', 2.4));
    const sun = new THREE.DirectionalLight('#fff0ce', 3.3);
    sun.position.set(-35, 65, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 80, bottom: -80, near: 1, far: 180 });
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const materials = new Map(), geometries = new Set(), textures = new Set(), walls = [];
    function material(color, metalness = 0) {
        const key = `${color}:${metalness}`;
        if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness }));
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
    function column(x, z, height = 8, y = 0) {
        mesh(new THREE.CylinderGeometry(0.5, 0.65, height, 12), '#e2d9c8', x, y + height / 2, z);
        box(x, y + 0.25, z, 1.6, 0.5, 1.6, '#c6bca9');
        box(x, y + height, z, 1.6, 0.5, 1.6, '#f1eadb');
    }
    function label(text, x, y, z, width = 8, color = '#f6df9e') {
        const canvas = document.createElement('canvas');
        canvas.width = 768; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#172536'; ctx.fillRect(0, 0, 768, 128);
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.strokeRect(8, 8, 752, 112);
        ctx.fillStyle = color; ctx.font = '600 38px Georgia'; ctx.textAlign = 'center';
        ctx.fillText(text, 384, 78);
        const texture = new THREE.CanvasTexture(canvas);
        textures.add(texture);
        const mat = new THREE.MeshBasicMaterial({ map: texture });
        materials.set(`label-${textures.size}`, mat);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 6), mat);
        geometries.add(sign.geometry);
        sign.position.set(x, y, z);
        scene.add(sign);
    }
    box(0, -0.3, 5, 210, 0.5, 210, '#657360');
    box(0, -0.04, 42, 24, 0.12, 60, '#b8b2a5');
    for (let z = 18; z < 70; z += 4) box(0, 0.03, z, 22, 0.015, 0.04, '#93948c');
    for (const x of [-30, 30]) {
        box(x, 0, 43, 9, 0.1, 42, '#788168');
        for (const z of [22, 39, 57]) {
            mesh(new THREE.CylinderGeometry(0.2, 0.35, 4, 8), '#625343', x, 2, z);
            mesh(new THREE.SphereGeometry(3, 10, 8), '#4f6455', x, 6, z);
        }
    }
    // Exterior wings and portico evoke the public facade; interior adjacency is invented.
    for (const x of [-25, 25]) {
        box(x, 5.2, 0, 32, 10.4, 29, '#d4cbb9');
        box(x, 10.6, 0, 34, 0.8, 30, '#eee7d8');
        for (let wx = x - 13; wx <= x + 13; wx += 4.3) {
            for (const y of [3.3, 7.3]) {
                box(wx, y, 14.56, 1.5, 2.5, 0.08, '#435568');
                box(wx, y, 14.64, 0.1, 2.6, 0.08, '#e8dfcd');
            }
        }
    }
    for (let step = 0; step < 5; step++) {
        for (const x of [-22, 22]) box(x, step * 0.12, 17.8 - step * 0.5, 28, 0.2, 1, '#d9d3c4');
    }
    box(0, 10, 13, 23, 1.2, 8, '#e5ddcd');
    const pediment = new THREE.Shape();
    pediment.moveTo(-12, 0); pediment.lineTo(12, 0); pediment.lineTo(0, 4); pediment.closePath();
    mesh(new THREE.ExtrudeGeometry(pediment, { depth: 1.2, bevelEnabled: false }), '#e7dfd0', 0, 10.6, 16.5);
    for (const c of columns) column(c.x, c.z, c.height);
    label('PoCAPITOL', 0, 9.2, 17.7, 9);
    mesh(new THREE.CylinderGeometry(10.5, 12, 6, 40), '#d8d1c3', 0, 14, -12);
    for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2;
        column(Math.sin(angle) * 10.6, -12 + Math.cos(angle) * 10.6, 5, 11);
    }
    const domePoints = [[11, 0], [10.7, 2], [9.5, 5], [7, 8], [3, 10.5], [1.8, 11]]
        .map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(domePoints, 48), '#ede5d6', 0, 17, -12);
    mesh(new THREE.CylinderGeometry(1.3, 1.8, 3.2, 16), '#c9c4b8', 0, 29.5, -12);
    mesh(new THREE.SphereGeometry(0.65, 10, 8), '#484b48', 0, 32, -12);

    for (const area of areas.slice(1)) {
        box(area.x, 0.04, area.z, area.w, 0.12, area.d, '#c7bfad');
        box(area.x, 8.2, area.z, area.w, 0.3, area.d, '#ded4be');
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
        const light = new THREE.PointLight('#ffe9bc', 65, 24, 1.5);
        light.position.set(area.x, 6, area.z);
        scene.add(light);
    }
    mesh(new THREE.CylinderGeometry(6.5, 6.5, 0.04, 40), '#8e7660', 0, 0.13, -14);
    mesh(new THREE.CylinderGeometry(5.8, 5.8, 0.04, 40), '#d7c6a0', 0, 0.16, -14);
    label('ROTUNDA', 0, 5.8, -24.8, 7);
    box(0, 0.15, -47, 8, 0.1, 24, '#344f6b');
    box(0, 1, -58.5, 12, 2, 3, '#72533d');
    box(0, 3.8, -60.5, 7, 3.5, 0.15, '#24384c');
    label('HOUSE CHAMBER', 0, 6.2, -60.2, 12);
    for (const x of [-6.5, 6.5]) {
        box(x, 4, -59.9, 0.12, 5, 0.12, '#a78c4d');
        for (let i = 0; i < 7; i++) box(x, 5.5 - i * 0.32, -59.7, 2, 0.16, 0.06, i % 2 ? '#f5ead2' : '#9d4545');
        box(x - 0.55, 5.1, -59.6, 0.9, 0.9, 0.06, '#354b70');
    }
    for (const o of obstacles) {
        box(o.x, o.h / 2, o.z, o.w, o.h, o.d, o.z > 0 ? '#63717a' : '#805f43');
        box(o.x, o.h, o.z, o.w + 0.1, 0.1, o.d + 0.1, o.z > 0 ? '#bdac79' : '#b29364');
    }
    const bodyGeometry = new THREE.CapsuleGeometry(0.36, 0.85, 4, 8);
    const headGeometry = new THREE.SphereGeometry(0.25, 10, 8);
    const legGeometry = new THREE.BoxGeometry(0.22, 0.65, 0.25);
    function character(color, armed = false) {
        const group = new THREE.Group();
        mesh(bodyGeometry, color, 0, 1.05, 0, group);
        mesh(headGeometry, '#ccb398', 0, 1.85, 0, group);
        mesh(new THREE.BoxGeometry(0.5, 0.18, 0.5), '#283d50', 0, 2.05, 0, group);
        const legs = [-0.19, 0.19].map(x => mesh(legGeometry, '#27333e', x, 0.35, 0, group));
        if (armed) {
            box(0.4, 1.3, -0.3, 0.2, 0.2, 0.9, '#354a54', group);
            box(0.4, 1.3, -0.8, 0.13, 0.13, 0.1, '#7ce4ea', group);
        }
        scene.add(group);
        return { group, legs };
    }
    const player = character('#bd713f', true);
    const companions = Array.from({ length: 4 }, (_, i) => character(['#bd864f', '#9d6252', '#8e7e5d', '#a9794f'][i]));
    const enemies = Array.from({ length: 6 }, () => character('#416c87', true));
    const marker = mesh(new THREE.TorusGeometry(1.1, 0.08, 8, 36), '#ebce77', 0, 0.2, 23);
    marker.rotation.x = -Math.PI / 2;
    const beacon = mesh(new THREE.CylinderGeometry(0.06, 0.06, 3, 8), '#f3d37e', 0, 1.7, 23);
    const projectileGeometry = new THREE.SphereGeometry(0.16, 6, 6);
    const projectileMeshes = [];
    const traces = [];
    const raycaster = new THREE.Raycaster();
    const target = new THREE.Vector3(), desired = new THREE.Vector3(), offset = new THREE.Vector3();
    function resize() {
        const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host); resize();
    function pose(actor, data, heading, moving, time) {
        actor.group.position.set(data.x, 0.1, data.z);
        actor.group.rotation.y = heading;
        actor.legs.forEach((leg, i) => { leg.rotation.x = moving ? Math.sin(time * 10 + i * Math.PI) * 0.55 : 0; });
    }
    function render(state, yaw, pitch, moving, dt) {
        pose(player, state.player, yaw, moving, state.elapsed);
        state.companions.forEach((c, i) => pose(companions[i], c, yaw, moving, state.elapsed + i));
        state.enemies.forEach((e, i) => {
            enemies[i].group.visible = e.health > 0;
            pose(enemies[i], e, Math.atan2(e.x - state.player.x, e.z - state.player.z), false, state.elapsed);
        });
        const goal = milestones[state.milestone];
        marker.visible = beacon.visible = !!goal;
        if (goal) {
            marker.position.set(goal.x, 0.2, goal.z);
            beacon.position.set(goal.x, 1.7, goal.z);
        }
        while (projectileMeshes.length < state.projectiles.length) {
            projectileMeshes.push(mesh(projectileGeometry, '#87e6ef', 0, 1.3, 0));
        }
        projectileMeshes.forEach((m, i) => {
            m.visible = i < state.projectiles.length;
            if (m.visible) m.position.set(state.projectiles[i].x, 1.3, state.projectiles[i].z);
        });
        target.set(state.player.x, 1.65, state.player.z);
        desired.set(state.player.x + Math.sin(yaw) * 6.5, 3.7 + pitch * 3, state.player.z + Math.cos(yaw) * 6.5);
        offset.copy(desired).sub(target);
        raycaster.set(target, offset.clone().normalize());
        const hit = raycaster.intersectObjects(walls, false)[0];
        if (hit && hit.distance < offset.length()) desired.copy(target).addScaledVector(offset.normalize(), Math.max(0.3, hit.distance - 0.3));
        camera.position.copy(desired);
        camera.lookAt(state.player.x - Math.sin(yaw) * 10, 1.5 - pitch * 5, state.player.z - Math.cos(yaw) * 10);
        for (let i = traces.length - 1; i >= 0; i--) {
            traces[i].life -= dt;
            if (traces[i].life <= 0) {
                scene.remove(traces[i].line); traces[i].line.geometry.dispose(); traces[i].line.material.dispose();
                traces.splice(i, 1);
            }
        }
        renderer.render(scene, camera);
    }
    function aim(state, yaw) {
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const aimPoint = new THREE.Vector3();
        const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.3);
        if (!raycaster.ray.intersectPlane(floor, aimPoint) ||
            (aimPoint.x - state.player.x) * -Math.sin(yaw) + (aimPoint.z - state.player.z) * -Math.cos(yaw) <= 0) {
            return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
        }
        return { x: aimPoint.x - state.player.x, z: aimPoint.z - state.player.z };
    }
    function trace(state, shot) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(state.player.x, 1.3, state.player.z),
            new THREE.Vector3(shot.x, 1.3, shot.z),
        ]);
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: shot.hit !== null ? '#ffe19b' : '#b7e9ef' }));
        scene.add(line); traces.push({ line, life: 0.08 });
    }
    function dispose() {
        observer.disconnect();
        traces.forEach(t => { t.line.geometry.dispose(); t.line.material.dispose(); });
        geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
    return { canvas: renderer.domElement, render, aim, trace, dispose };
}
