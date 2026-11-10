import * as THREE from 'three';

// Reference-inspired public architecture. Decorative geometry never changes the playable plan.
export function addArchitecturalDetail({ box, mesh, column, materials }) {
    const stone = '#d8cfbb', pale = '#eee7d8', bronze = '#4c5c54', wood = '#5a3d2b';
    const torus = (radius, tube, x, y, z, color = pale, arc = Math.PI * 2) => {
        const value = mesh(new THREE.TorusGeometry(radius, tube, 8, 64, arc), color, x, y, z);
        value.rotation.x = Math.PI / 2;
        return value;
    };
    const frame = (x, y, z, w, h, color = pale) => {
        box(x - w / 2, y, z, 0.16, h, 0.22, color);
        box(x + w / 2, y, z, 0.16, h, 0.22, color);
        box(x, y + h / 2, z, w + 0.16, 0.18, 0.25, color);
        box(x, y - h / 2, z, w + 0.3, 0.16, 0.35, color);
    };

    // Layered west-front stairs, terrace expansion joints, and recessed window surrounds.
    for (const side of [-1, 1]) {
        for (let step = 0; step < 12; step++) {
            box(side * 22, 0.1 + step * 0.1, 20.2 - step * 0.42, 27.5, 0.2, 0.48, '#c6bca9');
        }
        for (const wx0 of [-13, -8.7, -4.4, 4.4, 8.7, 13]) {
            const wx = side * 25 + wx0;
            for (const y of [3.3, 7.3]) {
                frame(wx, y, 14.73, 1.65, 2.65);
                box(wx, y, 14.51, 1.42, 2.42, 0.06, '#202c38');
                for (const dy of [-0.62, 0, 0.62]) box(wx, y + dy, 14.77, 1.48, 0.055, 0.07, '#d8cfbb');
                box(wx, y, 14.78, 0.055, 2.45, 0.07, '#d8cfbb');
            }
        }
    }
    for (let x = -38; x <= 38; x += 2.4) box(x, 0.035, 20.8, 0.025, 0.015, 5.5, '#93948c');

    // Dome panel seams, drum pilasters, balustraded attic, and lantern detailing.
    for (let i = 0; i < 36; i++) {
        const a = i / 36 * Math.PI * 2;
        const x = Math.sin(a), z = Math.cos(a);
        const pilaster = box(x * 12.48, 22, -14 + z * 12.48, 0.32, 5.4, 0.28, pale);
        pilaster.rotation.y = a;
        const baluster = mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.65, 6), pale, x * 11.45, 26.75, -14 + z * 11.45);
        baluster.rotation.y = a;
    }
    torus(11.45, 0.11, 0, 27.1, -14);
    for (const [r, y] of [[10.72, 28.7], [9.52, 31.7], [7.02, 34.7]]) torus(r, 0.055, 0, y, -14, '#c7c1b6');

    // Crypt: low groin-vault ribs and worn sandstone floor joints around the compass.
    for (const z of [0, 5, 10]) {
        for (const side of [-1, 1]) {
            const points = [];
            for (let i = 0; i <= 16; i++) {
                const t = i / 16;
                points.push(new THREE.Vector3(side * (0.4 + t * 8.1), 7.9 - Math.sin(t * Math.PI) * 1.25, z - 2.2 + t * 4.4));
            }
            mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.13, 6, false), '#b8af9e', 0, 0, 0);
        }
    }
    for (let x = -8; x <= 8; x += 1.6) box(x, 0.112, 5.5, 0.018, 0.008, 18, '#93948c');
    for (let z = -3; z <= 14; z += 1.6) box(0, 0.113, z, 17, 0.008, 0.018, '#93948c');

    // Rotunda: continuous balcony, pilasters, framed recesses, coffers and oculus rings.
    torus(11.25, 0.18, 0, 8.65, -14);
    torus(11.15, 0.1, 0, 9.25, -14);
    for (let i = 0; i < 48; i++) {
        const a = i / 48 * Math.PI * 2;
        mesh(new THREE.CylinderGeometry(0.045, 0.065, 0.58, 6), pale, Math.sin(a) * 11.18, 8.95, -14 + Math.cos(a) * 11.18);
    }
    for (let ring = 0; ring < 4; ring++) {
        const phi = 0.2 + ring * 0.25, radius = Math.sin(phi) * 11.35;
        const y = 8 + Math.cos(phi) * 11.35;
        torus(radius, 0.09, 0, y, -14, '#baae97');
        const count = 12 + ring * 8;
        for (let i = 0; i < count; i++) {
            const a = i / count * Math.PI * 2;
            const coffer = box(Math.sin(a) * radius, y - 0.04, -14 + Math.cos(a) * radius, 0.55 + ring * 0.18, 0.08, 0.7, '#8f8371');
            coffer.rotation.set(phi, a, 0, 'YXZ');
        }
    }
    torus(2.15, 0.22, 0, 19.25, -14);
    const oculus = mesh(new THREE.CircleGeometry(2.05, 48), '#e9e4d8', 0, 19.28, -14);
    oculus.rotation.x = Math.PI / 2;

    // Statuary Hall: a shallow semicircular colonnade and varied, non-likeness sculptures.
    for (let i = 0; i < 9; i++) {
        const a = Math.PI * (0.12 + i * 0.095);
        const x = Math.cos(a) * 11.2, z = -37 - Math.sin(a) * 7.1;
        if (Math.abs(x) > 4.5) column(x, z, 6.8, 0.1, 0.55);
    }
    for (const [i, s] of [-10, 10].flatMap(x => [-32, -37, -42].map(z => ({ x, z }))).entries()) {
        const robe = mesh(new THREE.ConeGeometry(0.48 + (i % 2) * 0.08, 1.65, 10), i % 3 ? '#6f5b44' : bronze, s.x, 2.25, s.z);
        robe.rotation.y = i * 0.7;
        const arm = mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.9, 7), bronze, s.x + (i % 2 ? 0.35 : -0.35), 2.75, s.z);
        arm.rotation.z = i % 2 ? -0.75 : 0.75;
        box(s.x, 0.22, s.z + 0.66, 0.65, 0.18, 0.035, '#b99b62');
    }

    // House chamber: curved desk rows, rostrum panels, gallery rails and chandeliers.
    for (const side of [-1, 1]) {
        for (let row = 0; row < 5; row++) for (let seat = 0; seat < 5; seat++) {
            const x = side * (5.5 + seat * 2.35), z = -57 - row * 3.3;
            box(x, 0.85, z - 0.55, 1.35, 0.12, 0.65, wood);
            box(x, 0.48, z - 0.55, 0.1, 0.75, 0.5, wood);
            box(x, 1.02, z - 0.55, 0.32, 0.025, 0.22, '#d8cfbb');
        }
        for (let z = -75; z <= -57; z += 1.1) box(side * 11.7, 5.65, z, 0.09, 0.85, 0.09, '#b99b62');
        box(side * 11.7, 6.08, -66, 0.16, 0.12, 21, '#b99b62');
    }
    for (const x of [-4.5, -1.5, 1.5, 4.5]) frame(x, 3.8, -78.35, 2.5, 3.1, '#e1d7c6');

    const glow = new THREE.MeshStandardMaterial({ color: '#f4ead2', emissive: '#ffd9a0', emissiveIntensity: 1.4, roughness: 0.35 });
    materials.set('architectural-lamp-glow', glow);
    const interiorLights = [];
    for (const [x, y, z, intensity, distance] of [[0, 6.8, 5, 32, 17], [0, 12.5, -14, 85, 28], [0, 6.8, -37, 48, 22], [0, 6.5, -66, 55, 28]]) {
        const light = new THREE.PointLight('#ffe9bc', intensity, distance, 1.7);
        light.position.set(x, y, z);
        interiorLights.push(light);
        const fixture = mesh(new THREE.SphereGeometry(0.22, 12, 8), '#f4ead2', x, y, z);
        fixture.material = glow;
        for (let i = 0; i < 6; i++) {
            const a = i / 6 * Math.PI * 2;
            const bulb = mesh(new THREE.SphereGeometry(0.09, 8, 6), '#f4ead2', x + Math.sin(a) * 0.65, y - 0.25, z + Math.cos(a) * 0.65);
            bulb.material = glow;
        }
    }
    return { interiorLights, glow };
}
