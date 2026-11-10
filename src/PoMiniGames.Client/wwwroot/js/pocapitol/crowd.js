import * as THREE from 'three';

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

export function createCrowd(scene, capacity) {
    const parts = [], resources = new Set(), textures = new Set();
    const transform = new THREE.Object3D(), color = new THREE.Color();
    const coats = ['#715945', '#303c4b', '#645f4d', '#793d34', '#8b775b', '#373c38', '#405576', '#434047'];
    const skins = ['#d4b28e', '#b98f6c', '#90694e', '#debfa3', '#73533e'];
    function part(name, geometry, material, offset, scale = [1, 1, 1], filter = () => true) {
        resources.add(geometry); resources.add(material);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = ['coat', 'head', 'helmet'].includes(name);
        mesh.receiveShadow = true;
        scene.add(mesh);
        const item = { name, mesh, offset, scale, filter };
        parts.push(item); return item;
    }
    const cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: '#202830', roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const capsule = new THREE.CapsuleGeometry(0.35, 0.72, 3, 7);
    part('coat', capsule, cloth, [0, 1.06, 0], [1, 1, 0.86]);
    part('head', new THREE.SphereGeometry(0.23, 8, 6), skin, [0, 1.83, 0]);
    for (const side of [-1, 1]) {
        part(side < 0 ? 'left-leg' : 'right-leg', cube, dark, [side * 0.18, 0.4, 0], [0.24, 0.68, 0.27]);
        part('boot', cube, dark, [side * 0.18, 0.1, -0.07], [0.28, 0.2, 0.43]);
        part('sleeve', capsule, cloth, [side * 0.46, 1.1, -0.12], [0.42, 0.7, 0.5]);
        part('glove', cube, dark, [side * 0.47, 0.77, -0.12], [0.18, 0.18, 0.22]);
    }
    part('beanie', new THREE.SphereGeometry(0.26, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        cloth, [0, 1.9, 0], [1, 0.9, 1], a => !a.police && a.id % 3 !== 0);
    part('cap', cube, cloth, [0, 2, 0], [0.48, 0.17, 0.47], a => !a.police && a.id % 3 === 0);
    part('cap-brim', cube, cloth, [0, 1.96, -0.28], [0.43, 0.06, 0.23], a => !a.police && a.id % 3 === 0);
    part('helmet', new THREE.SphereGeometry(0.29, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.65),
        dark, [0, 1.91, 0], [1, 1, 1], a => a.police);
    const clear = new THREE.MeshStandardMaterial({ color: '#c4e0ea', transparent: true, opacity: 0.43, roughness: 0.25, depthWrite: false });
    part('visor', cube, clear, [0, 1.86, -0.27], [0.5, 0.32, 0.06], a => a.police);
    part('vest', cube, dark, [0, 1.2, -0.25], [0.67, 0.64, 0.12], a => a.police);
    part('shield', cube, clear, [-0.38, 1.07, -0.56], [0.9, 1.45, 0.09], a => a.police);
    part('shield-edge', cube, dark, [-0.38, 0.36, -0.56], [0.92, 0.07, 0.11], a => a.police);
    part('baton', new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), dark, [0.5, 0.85, -0.32], [1, 1, 1], a => a.police);
    const shieldCanvas = document.createElement('canvas');
    shieldCanvas.width = 256; shieldCanvas.height = 64;
    const ctx = shieldCanvas.getContext('2d');
    ctx.fillStyle = '#203046'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('POLICE', 128, 49);
    const shieldTexture = new THREE.CanvasTexture(shieldCanvas); textures.add(shieldTexture);
    part('police-label', new THREE.PlaneGeometry(0.75, 0.2), new THREE.MeshBasicMaterial({ map: shieldTexture, side: THREE.DoubleSide }),
        [-0.38, 1.22, -0.62], [1, 1, 1], a => a.police);
    const bearer = a => !a.police && a.id % 3 === 0;
    part('flag-pole', new THREE.CylinderGeometry(0.025, 0.025, 3.2, 5),
        new THREE.MeshStandardMaterial({ color: '#b7a587' }), [0.6, 2.1, -0.1], [1, 1, 1], bearer);
    for (const kind of ['us', 'campaign']) {
        const texture = flagTexture(kind); textures.add(texture);
        part('flag', new THREE.PlaneGeometry(1.7, 1.1, 4, 1),
            new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.9 }),
            [1.46, 3.13, -0.1], [1, 1, 1], a => bearer(a) && (a.id % 2 === 0 ? 'us' : 'campaign') === kind);
    }
    function update(state, humanHeading, humanMoving, cameraPosition) {
        const actors = [
            ...(!state.demo ? [{ ...state.player, id: -1, health: state.health, heading: humanHeading, moving: humanMoving }] : []),
            ...state.companions,
            ...state.enemies.map(e => ({ ...e, police: true, moving: false })),
        ];
        if (actors.length > capacity) throw new RangeError('Crowd renderer capacity exceeded.');
        for (const p of parts) {
            let count = 0;
            for (const a of actors) {
                if (!p.filter(a)) continue;
                if (Math.hypot(a.x - cameraPosition.x, a.z - cameraPosition.z) < 1.1) continue;
                const h = a.heading || 0, cs = Math.cos(h), sn = Math.sin(h), o = p.offset;
                const moving = state.status === 'active' && a.moving && a.health > 0;
                const stride = moving ? Math.sin(state.elapsed * 9 + a.id * 0.7) * 0.5 : 0;
                transform.position.set(a.x + o[0] * cs + o[2] * sn, 0.1 + o[1], a.z - o[0] * sn + o[2] * cs);
                // Nearby banners must not fill the entire third-person camera.
                if (p.name === 'flag' && transform.position.distanceTo(cameraPosition) < 4) continue;
                transform.rotation.set(p.name === 'left-leg' ? stride : p.name === 'right-leg' ? -stride : 0,
                    h + (p.name === 'police-label' ? Math.PI : 0), 0);
                transform.scale.set(...p.scale);
                if (a.health <= 0) {
                    // Incapacitated figures sit out without graphic injury or disappearing population.
                    transform.position.y *= 0.4;
                    transform.scale.y *= 0.4;
                }
                if (p.name === 'flag') transform.rotation.y += 0.18 * Math.sin(state.elapsed * 2 + a.id);
                p.mesh.setMatrixAt(count, transform.matrix.compose(transform.position, transform.quaternion, transform.scale));
                if (p.name === 'coat' || p.name === 'sleeve' || p.name === 'beanie' || p.name.startsWith('cap')) {
                    color.set(a.police ? '#24394d' : a.id < 0 ? '#bd713f' : p.name.startsWith('cap') ? '#a93737' : coats[a.id % coats.length]);
                    p.mesh.setColorAt(count, color);
                } else if (p.name === 'head') {
                    color.set(skins[Math.abs(a.id) % skins.length]); p.mesh.setColorAt(count, color);
                }
                count++;
            }
            p.mesh.count = count;
            p.mesh.instanceMatrix.needsUpdate = true;
            if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
        }
        return actors.length;
    }
    function dispose() {
        parts.forEach(p => { scene.remove(p.mesh); p.mesh.dispose(); });
        resources.forEach(r => r.dispose()); textures.forEach(t => t.dispose());
    }
    return { update, dispose, batchCount: parts.length };
}
