import * as THREE from 'three';
import { addWave, billboardChunk } from './look.js';

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
// Joint pivots in a 1.0-height, 1.0-build body: hips, and shoulders slightly forward.
const HIP = 0.74, SHOULDER = 1.5, SHOULDER_Z = -0.12;

export function createCrowd(scene, capacity, { time, groundHeight, shadowTexture }) {
    const parts = [], resources = new Set(), textures = new Set();
    const transform = new THREE.Object3D(), color = new THREE.Color();
    transform.rotation.order = 'YXZ'; // swing about the body's own axis, then face the heading
    let extras = true;
    // `extra` parts are the small ones nobody misses on a struggling device.
    function part(name, geometry, material, offset, scale = [1, 1, 1], filter = () => true, extra = false, more = {}) {
        resources.add(geometry); resources.add(material);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = ['coat', 'head', 'helmet', 'left-leg', 'right-leg'].includes(name);
        mesh.receiveShadow = name !== 'contact';
        scene.add(mesh);
        const item = { name, mesh, offset, scale, filter, extra, ...more };
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

    const coatColor = a => a.police ? '#24394d' : a.civilian ? suits[a.id % suits.length] : a.observer ? '#3f6f8f'
        : a.id < 0 ? '#bd713f' : coats[a.id % coats.length];
    const tints = {
        coat: a => color.set(coatColor(a)), sleeve: a => color.set(coatColor(a)),
        hood: a => color.set(coatColor(a)).multiplyScalar(0.9),
        'puffer-band': a => color.set(coatColor(a)).multiplyScalar(0.72),
        cap: a => color.set(a.id % 5 === 0 ? '#24324f' : '#a93737'),
        'cap-brim': a => color.set(a.id % 5 === 0 ? '#24324f' : '#a93737'),
        beanie: a => color.set(knits[(a.id * 7) % knits.length]),
        pom: a => color.set(knits[(a.id * 7 + 3) % knits.length]),
        scarf: a => color.set(knits[(a.id * 5 + 1) % knits.length]),
        'left-leg': a => color.set(a.police ? '#1f2833' : a.civilian ? suits[a.id % suits.length] : pants[Math.abs(a.id) % pants.length]),
        'right-leg': a => color.set(a.police ? '#1f2833' : a.civilian ? suits[a.id % suits.length] : pants[Math.abs(a.id) % pants.length]),
        head: a => color.set(skins[Math.abs(a.id) % skins.length]),
        hair: a => color.set(hairs[Math.abs(a.id * 3) % hairs.length]),
    };

    const cloth = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 });
    const denim = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: '#202830', roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 });
    const knit = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const capsule = new THREE.CapsuleGeometry(0.35, 0.72, 4, 10);
    const limb = new THREE.CapsuleGeometry(0.35, 0.72, 3, 8);
    const dome = new THREE.SphereGeometry(0.26, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const ring = new THREE.TorusGeometry(0.35, 0.035, 5, 16);

    // A soft dark patch under every figure: what keeps a crowd standing on the ground.
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const contact = part('contact', new THREE.PlaneGeometry(1, 1), shadowMaterial, [0, 0, 0], [0.95, 0.8, 1]);
    contact.mesh.layers.set(1);

    part('coat', capsule, cloth, [0, 1.06, 0], [1, 1, 0.86]);
    // Quilted puffers: two darker bands round the coat.
    for (const y of [0.9, 1.22]) part('puffer-band', ring, cloth, [0, y, 0], [1.02, 0.88, 1],
        a => raider(a) && a.id % 4 === 0, true, { rot: Math.PI / 2 });
    part('head', new THREE.SphereGeometry(0.23, 12, 8), skin, [0, 1.83, 0], [0.95, 1.05, 1]);
    part('hair', dome, cloth, [0, 1.87, 0.02], [0.95, 0.75, 1], hair);
    for (const side of [-1, 1]) {
        part(side < 0 ? 'left-leg' : 'right-leg', cube, denim, [side * 0.18, 0.4, 0], [0.24, 0.68, 0.27], undefined, false, { joint: 'leg' });
        part('boot', cube, dark, [side * 0.18, 0.1, -0.07], [0.28, 0.2, 0.43], undefined, true, { joint: 'leg' });
        part('sleeve', limb, cloth, [side * 0.46, 1.1, -0.12], [0.42, 0.7, 0.5], undefined, false, { joint: 'arm' });
        part('glove', cube, dark, [side * 0.47, 0.77, -0.12], [0.18, 0.18, 0.22], undefined, true, { joint: 'arm' });
    }
    part('beanie', dome, knit, [0, 1.9, 0], [1, 0.9, 1], beanie);
    part('pom', new THREE.SphereGeometry(0.07, 6, 4), knit, [0, 2.12, 0], [1, 1, 1], a => beanie(a) && a.id % 6 === 1, true);
    part('hood', dome, cloth, [0, 1.84, 0.05], [1.18, 1.12, 1.22], hood);
    part('scarf', new THREE.TorusGeometry(0.2, 0.065, 5, 12), knit, [0, 1.62, 0], [1, 1, 0.9],
        a => raider(a) && a.id % 4 === 1, true, { rot: Math.PI / 2 });
    part('cap', cube, cloth, [0, 2, 0], [0.48, 0.17, 0.47], ballCap);
    part('cap-brim', cube, cloth, [0, 1.96, -0.28], [0.43, 0.06, 0.23], ballCap, true);
    part('hard-hat', dome, new THREE.MeshStandardMaterial({ color: '#e7c531', roughness: 0.5 }), [0, 1.92, 0], [1.1, 0.95, 1.15], hardHat);
    part('tricorn', new THREE.CylinderGeometry(0.36, 0.4, 0.13, 3), dark, [0, 2.02, 0], [1, 1, 1], tricorn);
    // Vests and tabards are the coat's own capsule, a size up, so they read as worn not boxed.
    part('hi-vis', capsule, new THREE.MeshStandardMaterial({ color: '#c9e23c', roughness: 0.9, emissive: '#3a4208' }),
        [0, 1.14, 0], [1.07, 0.66, 0.93], a => raider(a) && a.id >= 0 && a.id % 10 === 4, true);
    part('backpack', cube, dark, [0, 1.28, 0.36], [0.5, 0.6, 0.24], a => raider(a) && a.id >= 0 && a.id % 5 === 2, true);
    // Street medics: a white tabard with a red patch. A role in the crowd, not a uniform.
    part('medic-tabard', capsule, new THREE.MeshStandardMaterial({ color: '#f1efe8', roughness: 0.9 }),
        [0, 1.14, 0], [1.07, 0.66, 0.93], a => a.temperament === 'medic');
    part('medic-patch', cube, new THREE.MeshStandardMaterial({ color: '#c1373c', roughness: 0.9 }),
        [0, 1.28, -0.36], [0.26, 0.26, 0.03], a => a.temperament === 'medic', true);
    // Phones held up to film, in the raised right hand: the single most common thing in every
    // photograph of the day. The screen glows enough to bloom.
    part('phone', cube, new THREE.MeshStandardMaterial({ color: '#10161d', emissive: '#9cc8f0', emissiveIntensity: 1.6 }),
        [0.44, 1.8, -0.86], [0.1, 0.19, 0.02], filming, true);
    part('helmet', new THREE.SphereGeometry(0.29, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.65),
        new THREE.MeshStandardMaterial({ color: '#1d242c', roughness: 0.35, metalness: 0.2 }), [0, 1.91, 0], [1, 1, 1], a => a.police);
    const clear = new THREE.MeshStandardMaterial({ color: '#c4e0ea', transparent: true, opacity: 0.4, roughness: 0.08, depthWrite: false });
    part('visor', cube, clear, [0, 1.86, -0.27], [0.5, 0.32, 0.06], a => a.police);
    part('vest', cube, dark, [0, 1.2, -0.25], [0.67, 0.64, 0.12], a => a.police || (raider(a) && a.id >= 0 && a.id % 8 === 3));
    part('shield', cube, clear, [-0.38, 1.07, -0.56], [0.9, 1.45, 0.09], a => a.police);
    part('shield-edge', cube, dark, [-0.38, 0.36, -0.56], [0.92, 0.07, 0.11], a => a.police, true);
    part('baton', new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), dark, [0.5, 0.85, -0.32], [1, 1, 1], a => a.police && !a.armed);
    // Armed demo only: a plain dark block held forward. No real model is depicted.
    part('gun', cube, dark, [0.42, 1.2, -0.5], [0.07, 0.13, 0.5],
        a => a.armed && a.health > 0 && (a.police || a.temperament === 'pusher' || (a.temperament === 'follower' && a.morale > 0.7)));
    const shieldCanvas = document.createElement('canvas');
    shieldCanvas.width = 256; shieldCanvas.height = 64;
    const ctx = shieldCanvas.getContext('2d');
    ctx.fillStyle = '#203046'; ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('POLICE', 128, 49);
    const shieldTexture = new THREE.CanvasTexture(shieldCanvas); textures.add(shieldTexture);
    part('police-label', new THREE.PlaneGeometry(0.75, 0.2), new THREE.MeshBasicMaterial({ map: shieldTexture, side: THREE.DoubleSide }),
        [-0.38, 1.22, -0.62], [1, 1, 1], a => a.police, true, { yaw: Math.PI });
    part('flag-pole', new THREE.CylinderGeometry(0.025, 0.025, 3.2, 5),
        new THREE.MeshStandardMaterial({ color: '#b7a587' }), [0.6, 2.1, -0.1], [1, 1, 1], bearer);
    for (const kind of new Set(banners)) {
        const texture = flagTexture(kind); textures.add(texture);
        const flag = part('flag', new THREE.PlaneGeometry(1.7, 1.1, 16, 6),
            addWave(new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.9 }), time),
            [1.46, 3.13, -0.1], [1, 1, 1], a => bearer(a) && banners[Math.floor(a.id / 3) % banners.length] === kind);
        flag.mesh.layers.set(1);
    }
    // Breath in the cold: a small puff in front of each face outdoors, there and gone.
    const breath = part('breath', new THREE.SphereGeometry(0.11, 6, 5),
        new THREE.MeshBasicMaterial({ color: '#f3f6f8', transparent: true, opacity: 0.2, depthWrite: false }),
        [0, 1.8, -0.42], [1, 1, 1], a => a.health > 0 && a.z > 15.5, true);
    breath.mesh.layers.set(1);

    function update(state, humanHeading, humanMoving, cameraPosition) {
        const actors = [
            ...(state.role !== 'none' ? [{ ...state.player, id: -1, health: state.health, heading: humanHeading,
                moving: humanMoving, police: state.role === 'police', observer: state.role === 'observer' }] : []),
            ...(state.armed ? state.companions.map(c => ({ ...c, armed: true })) : state.companions),
            ...state.enemies.map(e => ({ ...e, police: true, armed: state.armed })),
            // Staff and members in the chamber: plain suits, no equipment, health never changes.
            ...state.civilians.filter(p => !p.evacuated).map(p => ({ ...p, id: p.id + 1000, health: 1, civilian: true })),
        ];
        if (actors.length > capacity) throw new RangeError('Crowd renderer capacity exceeded.');
        const active = state.status === 'active';
        // Per-actor body: build, ground, gait. Worked out once, used by every part.
        const bodies = actors.map(a => {
            const tall = a.police ? 0.98 + trait(a.id, 1) * 0.09 : 0.93 + trait(a.id, 1) * 0.14;
            const wide = a.police ? 1.02 + trait(a.id, 2) * 0.1 : 0.9 + trait(a.id, 2) * 0.2;
            const moving = active && a.moving && a.health > 0;
            const phase = state.elapsed * 9 + a.id * 0.7;
            const stride = moving ? Math.sin(phase) * 0.5 : 0;
            const bob = moving ? Math.abs(Math.cos(phase)) * 0.045 : 0;
            const pushing = raider(a) && a.attacking > 0 && a.health > 0;
            const floor = groundHeight(a.x, a.z);
            return { a, tall, wide, stride, floor, ground: floor + bob, pushing, filming: filming(a),
                hidden: Math.hypot(a.x - cameraPosition.x, a.z - cameraPosition.z) < 1.1 };
        });
        for (const p of parts) {
            let count = 0;
            if (p.extra && !extras) { p.mesh.count = 0; continue; }
            for (const b of bodies) {
                const a = b.a;
                if (b.hidden || !p.filter(a)) continue;
                const h = a.heading || 0, cs = Math.cos(h), sn = Math.sin(h), o = p.offset;
                const low = a.health > 0 ? 1 : state.armed ? 0.22 : a.helped && !a.resting ? 0.82 : 0.4;
                if (p.name === 'contact') {
                    // Out of the scenario figures sit or lie, so their shadow spreads.
                    const spread = a.health > 0 ? 1 : 1.35;
                    transform.position.set(a.x, b.floor + 0.015, a.z);
                    transform.rotation.set(-Math.PI / 2, h, 0);
                    transform.scale.set(p.scale[0] * b.wide * spread, p.scale[1] * b.wide * spread, 1);
                } else {
                    let lx = o[0] * b.wide, ly = o[1] * b.tall, lz = o[2] * b.wide, rx = p.rot || 0;
                    if (p.joint && a.health > 0) {
                        const left = o[0] < 0;
                        let angle, pivotY, pivotZ;
                        if (p.joint === 'leg') {
                            angle = left ? b.stride : -b.stride; pivotY = HIP * b.tall; pivotZ = 0;
                        } else {
                            angle = (left ? -0.7 : 0.7) * b.stride; pivotY = SHOULDER * b.tall; pivotZ = SHOULDER_Z * b.wide;
                            if (b.pushing) angle = 1.3 + (left ? 0.1 : -0.1);
                            else if (!left && b.filming) angle = 1.9;
                            else if (left && a.police) angle = 0.55;
                        }
                        if (angle) {
                            const dy = ly - pivotY, dz = lz - pivotZ, c = Math.cos(angle), s = Math.sin(angle);
                            ly = pivotY + dy * c - dz * s; lz = pivotZ + dy * s + dz * c; rx += angle;
                        }
                    }
                    transform.position.set(a.x + lx * cs + lz * sn, b.ground + ly * low, a.z - lx * sn + lz * cs);
                    // Nearby banners must not fill the entire third-person camera.
                    if (p.name === 'flag' && transform.position.distanceTo(cameraPosition) < 4) continue;
                    transform.rotation.set(rx, h + (p.yaw || 0), 0);
                    transform.scale.set(p.scale[0] * b.wide, p.scale[1] * b.tall * low, p.scale[2] * b.wide);
                    if (p.name === 'baton' && a.attacking > 0 && a.tool === 'baton') transform.rotation.x = -1.3;
                    if (p.name === 'breath') {
                        const phase = (state.elapsed * 0.45 + a.id * 0.37) % 1;
                        if (phase > 0.4) continue;
                        transform.scale.setScalar(0.5 + phase * 3);
                        transform.position.y += phase * 0.5;
                    }
                    if (p.name === 'flag') transform.rotation.y += 0.06 * Math.sin(state.elapsed * 0.7 + a.id);
                }
                p.mesh.setMatrixAt(count, transform.matrix.compose(transform.position, transform.quaternion, transform.scale));
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
        parts.forEach(p => { scene.remove(p.mesh); p.mesh.dispose(); });
        resources.forEach(r => r.dispose()); textures.forEach(t => t.dispose());
    }
    return { update, dispose, setExtras(value) { extras = value; }, batchCount: parts.length };
}

// ---------------------------------------------------------------- the crowd that stayed outside

const CELLS = 8;
/**
 * Eight painted figures for the unsimulated far crowd. Coats are painted pure white and tinted
 * per instance in the shader; everything else (skin, jeans, hats, phones, flags) keeps its paint.
 */
function peopleAtlas() {
    const canvas = document.createElement('canvas');
    canvas.width = 64 * CELLS; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const round = (x, y, w, h, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); };
    const circle = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
    const looks = [
        { hat: 'beanie', skin: 0, legs: 0, knit: 0 }, { hat: 'cap', skin: 1, legs: 1, phone: true },
        { hat: 'hood', skin: 2, legs: 3 }, { hat: 'none', skin: 3, legs: 2, hair: 1, flag: '#2b477a' },
        { hat: 'beanie', skin: 4, legs: 4, knit: 1, phone: true }, { hat: 'cap', skin: 0, legs: 5, flag: '#b23a40' },
        { hat: 'none', skin: 1, legs: 0, hair: 3 }, { hat: 'beanie', skin: 3, legs: 1, knit: 3, flag: '#e8c53a' },
    ];
    looks.forEach((look, i) => {
        const cx = i * 64 + 32, skinTone = skins[look.skin];
        for (const side of [-1, 1]) {
            round(cx + side * 5 - 4, 82, 8, 42, 3, pants[look.legs]);
            round(cx + side * 5 - 5, 119, 10, 6, 2, '#1c1d1f');
        }
        round(cx - 15, 34, 30, 54, 9, '#ffffff');
        round(cx - 21, 38, 8, 40, 4, '#ffffff');
        circle(cx - 17, 80, 3.5, skinTone);
        if (look.phone || look.flag) {
            round(cx + 13, 8, 8, 34, 4, '#ffffff');
            circle(cx + 17, 8, 3.5, skinTone);
            if (look.phone) round(cx + 13, -1, 8, 10, 1, '#10161d');
        } else {
            round(cx + 13, 38, 8, 40, 4, '#ffffff');
            circle(cx + 17, 80, 3.5, skinTone);
        }
        if (look.flag) {
            ctx.fillStyle = '#8d7d62'; ctx.fillRect(cx + 16, 0, 2, 14);
            ctx.fillStyle = look.flag; ctx.fillRect(cx + 18, 0, 24, 14);
        }
        round(cx - 4, 30, 8, 8, 2, skinTone);
        circle(cx, 23, 9.5, skinTone);
        if (look.hat === 'beanie') { round(cx - 10, 11, 20, 11, 5, knits[look.knit]); }
        else if (look.hat === 'cap') { round(cx - 10, 12, 20, 9, 4, '#a93737'); ctx.fillStyle = '#a93737'; ctx.fillRect(cx - 14, 18, 8, 3); }
        else if (look.hat === 'hood') { round(cx - 13, 10, 26, 26, 11, '#ffffff'); circle(cx, 25, 7.5, skinTone); }
        else { round(cx - 10, 12, 20, 9, 5, hairs[look.hair]); }
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
}

/**
 * Thousands of figures as upright sprites: one draw call for the people and one for their
 * contact shadows. Each sprite is turned to the camera in the vertex shader and sways a little.
 */
export function createDistantCrowd(scene, spots, { time, shadowTexture }) {
    const count = spots.length, map = peopleAtlas();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.translate(0, 0.5, 0);
    const cells = new Float32Array(count);
    const light = { value: 1 };
    const material = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, fog: true });
    material.onBeforeCompile = shader => {
        shader.uniforms.uTime = time;
        shader.uniforms.uLight = light;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aCell;\nuniform float uTime;')
            .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv.x = (vMapUv.x + aCell) / ${CELLS}.0;`)
            .replace('#include <project_vertex>', `
                float swayPhase = aCell * 2.1 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
                transformed.x += sin(uTime * 1.3 + swayPhase) * 0.025 * transformed.y;
                transformed.y += max(0.0, sin(uTime * 2.2 + swayPhase * 3.0)) * 0.02;
                ${billboardChunk(true)}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uLight;')
            .replace('#include <color_fragment>', `
                #ifdef USE_COLOR
                    float coatMask = smoothstep(0.86, 0.97, min(min(sampledDiffuseColor.r, sampledDiffuseColor.g), sampledDiffuseColor.b));
                    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vColor, coatMask);
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
            geometry.dispose(); shadowGeometry.dispose(); material.dispose(); shadowMaterial.dispose(); map.dispose();
        },
    };
}
