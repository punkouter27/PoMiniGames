import * as THREE from 'three';
import { areas, obstacles, columns, seats, milestones, selectLeader, CROWD_SIZE } from './world.js';
import { createCrowd, flagTexture } from './crowd.js';

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
            for (const side of [-1, 1]) {
                const branch = mesh(new THREE.CylinderGeometry(0.06, 0.15, 3.8, 5), '#625343', x + side, 4.8, z);
                branch.rotation.z = side * 0.65;
            }
        }
    }
    // Exterior wings and portico evoke the public facade; interior adjacency is invented.
    for (const x of [-25, 25]) {
        box(x, 5.2, 0, 32, 10.4, 29, '#d4cbb9');
        box(x, 10.6, 0, 34, 0.8, 30, '#eee7d8');
        for (let wx = x - 13; wx <= x + 13; wx += 4.3) {
            box(wx, 10, 15, 2.8, 0.4, 0.8, '#b8af9e');
            for (const y of [3.3, 7.3]) {
                box(wx, y, 14.56, 1.5, 2.5, 0.08, '#435568');
                box(wx, y, 14.64, 0.1, 2.6, 0.08, '#e8dfcd');
                box(wx, y, 14.65, 1.5, 0.08, 0.09, '#e8dfcd');
                box(wx, y + 1.4, 14.65, 2.2, 0.25, 0.5, '#eee7d8');
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
    mesh(new THREE.CylinderGeometry(11, 12.5, 6, 40), '#d8d1c3', 0, 22, -14);
    for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2;
        column(Math.sin(angle) * 11.6, -14 + Math.cos(angle) * 11.6, 5, 19);
        const window = box(Math.sin(angle) * 11.2, 21.3, -14 + Math.cos(angle) * 11.2, 1.1, 2.6, 0.12, '#566371');
        window.rotation.y = angle;
    }
    for (const [radius, y] of [[12.4, 19], [12.4, 24.7], [11.2, 26.4]])
        mesh(new THREE.CylinderGeometry(radius, radius, 0.55, 48), '#ede5d6', 0, y, -14);
    const domePoints = [[11, 0], [10.7, 2], [9.5, 5], [7, 8], [3, 10.5], [1.8, 11]]
        .map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(domePoints, 48), '#ede5d6', 0, 26.7, -14);
    for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2;
        const points = domePoints.map(p => new THREE.Vector3(Math.sin(angle) * (p.x + 0.04), p.y + 26.7, -14 + Math.cos(angle) * (p.x + 0.04)));
        mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.07, 4, false), '#c7c1b6', 0, 0, 0);
    }
    mesh(new THREE.CylinderGeometry(1.3, 1.8, 2.8, 16), '#c9c4b8', 0, 39, -14);
    mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.45, 16), '#ede5d6', 0, 40.5, -14);
    mesh(new THREE.ConeGeometry(0.55, 2.1, 8), '#4c5c54', 0, 41.8, -14);
    mesh(new THREE.SphereGeometry(0.27, 8, 6), '#4c5c54', 0, 43.1, -14);
    box(0.37, 42, -14, 0.22, 1.1, 0.22, '#4c5c54');

    for (const area of areas.slice(1)) {
        box(area.x, 0.04, area.z, area.w, 0.12, area.d, '#c7bfad');
        if (area.z !== -14) box(area.x, 8.2, area.z, area.w, 0.3, area.d, '#ded4be');
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
    for (let ring = 10, i = 0; ring > 0; ring -= 1.4, i++)
        mesh(new THREE.CylinderGeometry(ring, ring, 0.025, 64), ring < 2 ? '#eeeadf' : i % 2 ? '#b5a090' : '#ebe2cd',
            0, 0.14 + i * 0.006, -14);
    const innerDome = mesh(new THREE.SphereGeometry(11.5, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), '#d6c6ad', 0, 8, -14);
    const domeMaterial = new THREE.MeshStandardMaterial({ color: '#d6c6ad', roughness: 0.95, side: THREE.DoubleSide });
    materials.set('inner-dome', domeMaterial); innerDome.material = domeMaterial;
    for (const y of [7.6, 8.2]) {
        const cornice = mesh(new THREE.TorusGeometry(11.4, 0.22, 6, 64), '#e4dac6', 0, y, -14);
        cornice.rotation.x = Math.PI / 2;
    }
    for (const side of [-1, 1]) for (const z of [-5, -11, -17, -23]) {
        box(side * 16.65, 4, z, 0.25, 7.5, 1.1, '#e8dfc9');
        box(side * 16.4, 7.3, z, 0.55, 0.45, 1.6, '#baae97');
        // Abstract panels do not pass invented artwork off as the actual historical paintings.
        box(side * 16.5, 3.8, z + 2.1, 0.12, 3.7, 3.3, '#947544');
        box(side * 16.4, 3.8, z + 2.1, 0.12, 3.25, 2.85, '#5d6665');
    }
    label('ROTUNDA', 0, 5.8, -24.8, 7);
    box(0, 0.15, -47, 8, 0.1, 24, '#344f6b');
    box(0, 1, -58.5, 12, 2, 3, '#72533d');
    box(0, 3.8, -60.5, 7, 3.5, 0.15, '#e1d7c6');
    box(0, 2.25, -57.7, 3.5, 0.5, 1.6, '#9a7956');
    box(0, 3.15, -59, 1.5, 1, 0.6, '#70503b');
    for (const side of [-1, 1]) {
        box(side * 15, 4.7, -48, 6.8, 0.4, 21, '#ae9a78');
        box(side * 11.7, 5.2, -48, 0.18, 1, 21, '#84694a');
        box(side * 3.3, 4, -60.2, 0.18, 3.1, 0.15, '#b99b62');
    }
    for (const seat of seats) {
        box(seat.x, 0.55, seat.z, seat.w, 0.55, 1.1, '#465c73');
        box(seat.x, 1.1, seat.z + 0.45, seat.w, 0.95, 0.16, '#40556c');
    }
    label('HOUSE CHAMBER', 0, 6.2, -60.2, 12);
    for (const x of [0]) {
        box(x - 2, 4, -60.1, 0.12, 5, 0.12, '#a78c4d');
        const texture = flagTexture(); textures.add(texture);
        const mat = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide });
        materials.set(`chamber-flag-${x}`, mat);
        const flag = mesh(new THREE.PlaneGeometry(3.8, 2.5), '#ffffff', x, 5.4, -59.7);
        flag.material = mat;
    }
    for (const o of obstacles) {
        box(o.x, o.h / 2, o.z, o.w, o.h, o.d, o.z > 0 ? '#63717a' : '#805f43');
        box(o.x, o.h, o.z, o.w + 0.1, 0.1, o.d + 0.1, o.z > 0 ? '#bdac79' : '#b29364');
    }
    const architectureBatches = [];
    scene.updateMatrixWorld(true);
    const repeated = new Map();
    for (const object of scene.children.filter(c => c.isMesh)) {
        const key = object.material.uuid + ':' + object.geometry.type + ':' + JSON.stringify(object.geometry.parameters);
        if (!repeated.has(key)) repeated.set(key, []);
        repeated.get(key).push(object);
    }
    for (const objects of repeated.values()) {
        if (objects.length < 2) continue;
        const batch = new THREE.InstancedMesh(objects[0].geometry, objects[0].material, objects.length);
        batch.castShadow = true; batch.receiveShadow = true;
        objects.forEach((object, i) => { batch.setMatrixAt(i, object.matrixWorld); scene.remove(object); });
        scene.add(batch); architectureBatches.push(batch);
    }
    const crowd = createCrowd(scene, CROWD_SIZE + 12);
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
    let followYaw = 0, cameraReady = false;
    const lastFocus = { x: 0, z: 58 };
    function render(state, yaw, pitch, moving, dt) {
        const subject = state.demo ? selectLeader(state) : state.player;
        host.dataset.crowdBatches = crowd.batchCount;
        host.dataset.cameraSubject = state.demo ? subject?.id ?? 'none' : 'human';
        if (state.demo) {
            if (subject) {
                const delta = subject.heading - followYaw;
                followYaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * (1 - Math.exp(-dt * 3));
            }
            yaw = followYaw; pitch = -0.12;
        } else followYaw = yaw;
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
            if (m.visible) {
                const projectile = state.projectiles[i];
                m.position.set(projectile.x, 1.3, projectile.z);
                m.material = material(projectile.faction === 'raider' ? '#e5c079' : '#87e6ef');
            }
        });
        if (subject) { lastFocus.x = subject.x; lastFocus.z = subject.z; }
        const focus = subject || lastFocus;
        target.set(focus.x, 1.65, focus.z);
        desired.set(focus.x + Math.sin(yaw) * 6.5, 3.7 + pitch * 3, focus.z + Math.cos(yaw) * 6.5);
        offset.copy(desired).sub(target);
        raycaster.set(target, offset.clone().normalize());
        const hit = raycaster.intersectObjects(walls, false)[0];
        if (hit && hit.distance < offset.length()) desired.copy(target).addScaledVector(offset.normalize(), Math.max(0.3, hit.distance - 0.3));
        if (state.demo && cameraReady && camera.position.distanceTo(desired) < 20) camera.position.lerp(desired, 1 - Math.exp(-dt * 7));
        else camera.position.copy(desired);
        cameraReady = true;
        camera.lookAt(focus.x - Math.sin(yaw) * 10, 1.5 - pitch * 5, focus.z - Math.cos(yaw) * 10);
        for (let i = traces.length - 1; i >= 0; i--) {
            traces[i].life -= dt;
            if (traces[i].life <= 0) {
                scene.remove(traces[i].line); traces[i].line.geometry.dispose(); traces[i].line.material.dispose();
                traces.splice(i, 1);
            }
        }
        host.dataset.actorCount = crowd.update(state, state.demo ? 0 : yaw, moving, camera.position);
        renderer.render(scene, camera);
        host.dataset.drawCalls = renderer.info.render.calls;
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
        crowd.dispose();
        architectureBatches.forEach(b => b.dispose());
        traces.forEach(t => { t.line.geometry.dispose(); t.line.material.dispose(); });
        geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    }
    return { canvas: renderer.domElement, render, aim, trace, dispose };
}
