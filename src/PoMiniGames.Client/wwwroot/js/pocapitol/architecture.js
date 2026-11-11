import * as THREE from 'three';

// Reference-inspired public architecture, drawn from the Architect of the Capitol and House
// history pages the PRD cites. Decorative geometry never changes the playable plan: the
// walkable footprint, the collisions and the objectives all stay in world.js.
export function addArchitecturalDetail({ box, mesh, column, materials, painted }) {
    const stone = '#d8cfbb', pale = '#eee7d8', bronze = '#4c5c54', wood = '#5a3d2b';
    // Aquia Creek sandstone is warm grey, Seneca and Breccia marble are variegated browns, the
    // dome and lantern are painted white cast iron, and the Statue of Freedom is bronze.
    const aquia = '#c3b49c', seneca = '#b5a090', senecaLight = '#cfc0b2', breccia = '#8d7565';
    const gilt = '#b99b62', verdigris = '#4c6b5f';
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
    const baluster = new THREE.CylinderGeometry(0.085, 0.12, 0.6, 6);
    /** A straight run of balusters under a rail and over a base moulding. */
    const balustrade = (x0, z0, x1, z1, y, spacing = 0.55) => {
        const dx = x1 - x0, dz = z1 - z0, length = Math.hypot(dx, dz);
        const count = Math.max(2, Math.round(length / spacing));
        for (let i = 0; i <= count; i++) mesh(baluster, pale, x0 + dx * i / count, y + 0.3, z0 + dz * i / count);
        box((x0 + x1) / 2, y + 0.66, (z0 + z1) / 2, Math.abs(dx) + 0.24, 0.12, Math.abs(dz) + 0.24, pale);
        box((x0 + x1) / 2, y + 0.02, (z0 + z1) / 2, Math.abs(dx) + 0.2, 0.14, Math.abs(dz) + 0.2, pale);
    };
    /** A lit surface painted on a canvas: frames, frescoes, signs, fencing. */
    const canvasMaterial = (draw, w, h, extra = {}) => painted(draw, w, h, { lit: true, material: { roughness: 0.92, ...extra } });

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

    // The Olmsted west terrace: the marble flight the west front stands on. Raking cheek walls
    // with balustrades climb beside each staircase, newel piers stand at their feet, and the
    // cornice over the stairs ties the flight into the base of the facade.
    for (const side of [-1, 1]) {
        for (const edge of [-1, 1]) {
            const cx = side * 22 + edge * 13.75;
            for (let step = 0; step < 12; step++) {
                const y = 0.1 + step * 0.1, z = 20.2 - step * 0.42;
                box(cx, y + 0.62, z, 0.8, 1.24, 0.46, pale);
                mesh(baluster, pale, cx, y + 1.5, z);
            }
            // Newel piers at the foot of the flight, with a bronze standard on each.
            box(cx, 1.02, 20.55, 1.05, 2.05, 1.05, aquia);
            box(cx, 2.12, 20.55, 1.24, 0.16, 1.24, pale);
            mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.5, 10), verdigris, cx, 2.45, 20.55);
            mesh(new THREE.SphereGeometry(0.26, 12, 8), verdigris, cx, 2.82, 20.55);
        }
        // Cornice across the head of the flight.
        box(side * 22, 1.32, 15.4, 27.7, 0.26, 0.55, pale);
        box(side * 22, 1.5, 15.45, 27.9, 0.14, 0.45, '#e6ddcc');
        // Bunting on the stair rails: red, white and blue pleats, as the terrace was dressed.
        const bunting = canvasMaterial(ctx => {
            ctx.fillStyle = '#f0ede6'; ctx.fillRect(0, 0, 128, 64);
            for (let i = 0; i < 8; i++) {
                ctx.fillStyle = i % 2 ? '#b23a40' : '#2b477a';
                ctx.beginPath(); ctx.arc(i * 16 + 8, 64, 9, Math.PI, 0); ctx.fill();
            }
            ctx.fillStyle = '#b23a40'; ctx.fillRect(0, 0, 128, 8);
        }, 128, 64, { side: THREE.DoubleSide });
        for (const edge of [-1, 1]) {
            for (const z of [19.4, 18.2, 17.1]) {
                const swag = mesh(new THREE.PlaneGeometry(2.7, 0.5), '#ffffff', side * 22 + edge * 13.75, 1.5 + (20.2 - z) * 0.2, z);
                swag.rotation.set(0.35, 0, 0);
                swag.material = bunting;
            }
        }
    }

    // Lower West Terrace: the arched doorway the crowd fought for at the centre of the west
    // front, in Aquia Creek sandstone, with an elliptical arch, voussoirs and a keystone.
    for (const side of [-1, 1]) {
        box(side * 7.4, 2.1, 14.4, 1.4, 4.2, 1.5, aquia);
        box(side * 7.4, 4.32, 14.4, 1.75, 0.32, 1.85, pale);
        box(side * 7.4, 0.35, 14.35, 1.7, 0.7, 1.7, '#b3a893');
    }
    for (let i = 0; i < 15; i++) {
        const a = Math.PI * (i + 0.5) / 15;
        const voussoir = box(Math.cos(a) * 6.6, 4.3 + Math.sin(a) * 3.7, 14.4, 1.3, 0.72, 1.4, '#cfc3ae');
        voussoir.rotation.z = a - Math.PI / 2;
    }
    box(0, 8.06, 14.4, 1.5, 1.15, 1.6, pale);
    box(0, 8.7, 14.42, 2.6, 0.25, 1.35, pale);
    const keystoneMedallion = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.12, 20), gilt, 0, 8.72, 14.2);
    keystoneMedallion.rotation.x = Math.PI / 2;

    // Bronze lamp standards flanking the portico steps, on marble plinths.
    for (const x of [-8.4, 8.4]) {
        box(x, 0.72, 18.6, 1.15, 1.44, 1.15, aquia);
        box(x, 1.5, 18.6, 1.35, 0.16, 1.35, pale);
        mesh(new THREE.CylinderGeometry(0.13, 0.2, 3.1, 10), verdigris, x, 3.15, 18.6);
        mesh(new THREE.CylinderGeometry(0.34, 0.2, 0.3, 10), verdigris, x, 4.8, 18.6);
        mesh(new THREE.SphereGeometry(0.4, 14, 10), '#f4ead2', x, 5.25, 18.6);
        mesh(new THREE.ConeGeometry(0.22, 0.42, 10), verdigris, x, 5.75, 18.6);
    }

    // Press tower on the west lawn: the scaffold riser the cameras worked from, with a stair
    // run, two decks, rails and a camera on a tripod.
    {
        const px = -44, pz = 58, deck = (y) => {
            box(px, y, pz, 4.2, 0.16, 4.2, '#5d6468');
            for (const s of [-1, 1]) {
                box(px + s * 2.05, y + 0.55, pz, 0.08, 0.06, 4.2, '#8b9296');
                box(px, y + 0.55, pz + s * 2.05, 4.2, 0.06, 0.08, '#8b9296');
            }
        };
        for (const s of [-1, 1]) for (const t of [-1, 1]) box(px + s * 2, 3.5, pz + t * 2, 0.14, 7, 0.14, '#5d6468');
        for (const y of [1.75, 3.5]) box(px, y, pz, 4.2, 0.06, 0.09, '#5d6468');
        deck(3.4); deck(6.6);
        // Stair run up the near face.
        for (let i = 0; i < 10; i++) box(px - 2.6, 0.3 + i * 0.34, pz - 2 + i * 0.42, 1.4, 0.08, 0.44, '#6b7276');
        // White sheeting on the far side, and a camera silhouette on the top deck.
        box(px + 2.1, 3.9, pz, 0.03, 6.2, 4.2, '#e6e4dc');
        box(px - 0.4, 7.2, pz, 0.5, 0.4, 0.8, '#20262c');
        mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6), '#20262c', px - 0.4, 7.0, pz);
    }

    // Green snow fencing along the lawn edges, and a few panels knocked flat closer in.
    const snowFence = painted(ctx => {
        ctx.fillStyle = '#2f5d3a'; ctx.fillRect(0, 0, 128, 96);
        ctx.strokeStyle = '#8fae94'; ctx.lineWidth = 2;
        for (let x = 4; x < 128; x += 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 96); ctx.stroke(); }
        for (let y = 4; y < 96; y += 12) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke(); }
    }, 128, 96, { material: { side: THREE.DoubleSide } });
    materials.set('snow-fence', snowFence);
    for (const side of [-1, 1]) {
        for (let z = 20; z < 104; z += 6) {
            const panel = mesh(new THREE.PlaneGeometry(6, 1.35), '#2f5d3a', side * 38.4, 0.7, z + 3);
            panel.material = snowFence;
            panel.rotation.y = Math.PI / 2;
            for (const dz of [0, 6]) box(side * 38.4, 0.75, z + dz, 0.07, 1.5, 0.07, '#3f4a3f');
        }
    }
    for (const [x, z, turn] of [[-20.5, 34.5, 0.4], [18.5, 35, -0.3], [-13, 47, 0.2], [22, 52, -0.5]]) {
        const fallen = mesh(new THREE.PlaneGeometry(5.4, 1.2), '#2f5d3a', x, 0.16, z);
        fallen.material = snowFence;
        fallen.rotation.set(-Math.PI / 2, 0, turn);
    }

    // "AREA CLOSED" boards on the barricade line, as the Capitol grounds carried that day.
    const closedSign = canvasMaterial(ctx => {
        ctx.fillStyle = '#f2f0ea'; ctx.fillRect(0, 0, 256, 160);
        ctx.strokeStyle = '#20242a'; ctx.lineWidth = 9; ctx.strokeRect(9, 9, 238, 142);
        ctx.fillStyle = '#20242a'; ctx.textAlign = 'center'; ctx.font = 'bold 46px sans-serif';
        ctx.fillText('AREA', 128, 68); ctx.fillText('CLOSED', 128, 124);
    }, 256, 160, { side: THREE.DoubleSide });
    for (const [x, z, yaw] of [[-16, 34.6, 0.12], [16, 34.6, -0.12], [-27, 36, 0.2], [27, 36, -0.2]]) {
        const sign = mesh(new THREE.PlaneGeometry(1.5, 0.94), '#f2f0ea', x, 0.95, z);
        sign.material = closedSign;
        sign.rotation.set(0.08, yaw, 0);
        for (const s of [-1, 1]) box(x + s * 0.62, 0.5, z + 0.06, 0.06, 1, 0.06, '#8b9296');
    }

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

    // Crypt: forty Aquia Creek sandstone Doric columns carried the floor above; here are the
    // rows nearest the walls, under low groin-vault ribs, over worn Seneca paving around the
    // white marble compass stone that marks the centre of the city.
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
    // Seneca sandstone tone under the joints, so the floor is not one flat grey.
    for (let i = 0; i < 12; i++) {
        const patch = box(-7.2 + (i % 4) * 4.8, 0.108, -2 + Math.floor(i / 4) * 6.2, 3.4, 0.01, 4.4, senecaLight);
        patch.rotation.y = (i % 3 - 1) * 0.03;
    }
    // Doric columns: square abacus, echinus, fluted shaft, on a low base. Stout, as the Crypt's are.
    const doric = (x, z) => {
        box(x, 0.24, z, 1.5, 0.3, 1.5, aquia);
        mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.24, 16), '#cbbda6', x, 0.51, z);
        mesh(new THREE.CylinderGeometry(0.38, 0.5, 6, 18), '#bfb096', x, 3.62, z);
        mesh(new THREE.CylinderGeometry(0.5, 0.4, 0.3, 16), '#cdbfa7', x, 6.75, z);
        box(x, 7.02, z, 1.32, 0.24, 1.32, '#d6c9b2');
    };
    for (const side of [-1, 1]) {
        for (const z of [-2.5, 1.5, 5.5, 9.5]) doric(side * 8.35, z);
        // The thirteen original colonies, in wall niches: plain draped figures, no likenesses.
        for (const z of [-1.5, 3.5, 7.5]) {
            mesh(new THREE.CylinderGeometry(0.62, 0.62, 4.4, 12, 1, false, 0, Math.PI), '#b9ad97', side * 9.02, 2.3, z);
            box(side * 8.95, 0.35, z, 1.15, 0.7, 1.15, seneca);
            const figure = mesh(new THREE.ConeGeometry(0.36, 1.5, 9), '#8f8270', side * 8.8, 1.95, z);
            figure.rotation.y = side * 0.4;
            mesh(new THREE.SphereGeometry(0.19, 8, 6), '#8f8270', side * 8.8, 2.85, z);
        }
    }
    // The compass stone: an eight-point star in white marble, brass at its centre.
    const star = mesh(new THREE.CylinderGeometry(1.75, 1.75, 0.04, 8), '#eeeadf', 0, 0.135, 5);
    star.rotation.y = Math.PI / 8;
    const star2 = mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.045, 8), '#e2dccb', 0, 0.14, 5);
    mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), '#b99b62', 0, 0.148, 5);

    // Rotunda: 48 feet of sandstone wall under fluted Doric pilasters, an olive-wreath frieze,
    // eight framed paintings, the Frieze of American History under the windows, and the
    // Apotheosis of Washington in the canopy above the oculus. Concentric Seneca rings round a
    // white marble centre below. Fictional subjects, public placement.
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
    // The Apotheosis, painted in the canopy around the eye of the dome.
    const apotheosis = canvasMaterial(ctx => {
        const w = 512, h = 256;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#cdb089'); grad.addColorStop(0.45, '#dcc8a3'); grad.addColorStop(1, '#a98b6a');
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(247,236,212,0.45)';
        ctx.beginPath(); ctx.arc(w / 2, h * 0.3, 74, 0, Math.PI * 2); ctx.fill();
        for (let i = 0; i < 18; i++) {
            const x = (i + 0.5) / 18 * w;
            ctx.fillStyle = ['#7d6a52', '#8d7a5f', '#6b5a46', '#9a866a'][i % 4];
            ctx.beginPath(); ctx.moveTo(x - 13, h); ctx.lineTo(x - 6, h - 56); ctx.lineTo(x + 6, h - 56); ctx.lineTo(x + 13, h); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#d8b98f'; ctx.beginPath(); ctx.arc(x, h - 66, 7, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#efe4cf';
        ctx.beginPath(); ctx.moveTo(w / 2 - 28, h * 0.62); ctx.lineTo(w / 2 - 13, h * 0.2); ctx.lineTo(w / 2 + 13, h * 0.2); ctx.lineTo(w / 2 + 28, h * 0.62); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#e3cba4'; ctx.beginPath(); ctx.arc(w / 2, h * 0.14, 13, 0, Math.PI * 2); ctx.fill();
    }, 512, 256, { side: THREE.DoubleSide });
    const canopy = mesh(new THREE.SphereGeometry(11.18, 48, 14, 0, Math.PI * 2, 0, 0.34), '#e9e0cc', 0, 8, -14);
    canopy.material = apotheosis;
    torus(2.15, 0.22, 0, 19.25, -14);
    const oculus = mesh(new THREE.CircleGeometry(2.05, 48), '#e9e4d8', 0, 19.28, -14);
    oculus.rotation.x = Math.PI / 2;

    // The Frieze of American History in the belt under the windows.
    const historyFrieze = canvasMaterial(ctx => {
        ctx.fillStyle = '#cbbfa4'; ctx.fillRect(0, 0, 256, 96);
        for (let i = 0; i < 26; i++) {
            ctx.fillStyle = ['#9c8d74', '#8a7c65', '#ab9c82'][i % 3];
            const x = 6 + i * 9.6, y = 54 + (i % 3) * 6;
            ctx.beginPath(); ctx.moveTo(x, y + 26); ctx.lineTo(x + 4, y - 16); ctx.lineTo(x + 9, y + 26); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = '#b2a48a'; ctx.fillRect(0, 0, 256, 10);
        ctx.fillStyle = '#a3947a'; ctx.fillRect(0, 86, 256, 10);
    }, 256, 96, { side: THREE.DoubleSide });
    for (let i = 0; i < 24; i++) {
        const a = i / 24 * Math.PI * 2;
        const panel = mesh(new THREE.PlaneGeometry(2.3, 0.95), '#ffffff', Math.sin(a) * 11.2, 8.3, -14 + Math.cos(a) * 11.2);
        panel.material = historyFrieze;
        panel.rotation.y = a + Math.PI;
    }

    // Eight framed paintings, two per long wall, in gilded arched frames on the sandstone.
    const painting = index => canvasMaterial(ctx => {
        const w = 256, h = 320;
        const skies = ['#8b9aab', '#a9a08c', '#7d8a92', '#9aa3a1', '#a08e78', '#88919d', '#9c9184', '#8e9aa0'];
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, skies[index % skies.length]);
        grad.addColorStop(0.55, '#d9cfbb');
        grad.addColorStop(1, '#6c6353');
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(240,220,180,0.32)';
        ctx.beginPath(); ctx.arc(w * (0.3 + (index % 3) * 0.2), h * 0.24, 38, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(58,50,38,0.5)'; ctx.fillRect(0, h * 0.73, w, h * 0.27);
        for (let i = 0; i < 7; i++) {
            const x = 30 + i * 33 + (i % 2) * 7, base = h * (0.76 + (i % 3) * 0.015);
            ctx.fillStyle = ['#2f3a4a', '#6b4b3a', '#3f4a3a', '#5a3d4a'][(i + index) % 4];
            ctx.beginPath(); ctx.moveTo(x - 12, base); ctx.lineTo(x - 6, base - 44); ctx.lineTo(x + 6, base - 44); ctx.lineTo(x + 12, base); ctx.closePath(); ctx.fill();
            ctx.fillStyle = '#c8a983'; ctx.beginPath(); ctx.arc(x, base - 54, 7, 0, Math.PI * 2); ctx.fill();
        }
    }, 256, 320, { side: THREE.DoubleSide });
    const paintings = Array.from({ length: 8 }, (_, i) => painting(i));
    for (const side of [-1, 1]) {
        let index = side < 0 ? 0 : 4;
        for (const z of [-5, -11, -17, -23]) {
            const face = mesh(new THREE.PlaneGeometry(2.6, 3.2), '#ffffff', side * 16.5, 3.9, z);
            face.material = paintings[index++ % 8];
            face.rotation.y = side * Math.PI / 2;
            box(side * 16.6, 3.9, z - 1.45, 0.14, 3.3, 0.26, gilt);
            box(side * 16.6, 3.9, z + 1.45, 0.14, 3.3, 0.26, gilt);
            box(side * 16.6, 2.28, z, 0.14, 0.26, 3.1, gilt);
            const arch = mesh(new THREE.TorusGeometry(1.32, 0.15, 6, 22, Math.PI), gilt, side * 16.6, 5.52, z);
            arch.rotation.y = Math.PI / 2;
        }
        // Olive wreaths in the frieze over each pilaster, and the cornice they sit under.
        for (const z of [-5, -11, -17, -23]) {
            const wreath = mesh(new THREE.TorusGeometry(0.4, 0.085, 6, 16), '#8f9a72', side * 16.55, 6.95, z);
            wreath.rotation.y = Math.PI / 2;
            box(side * 16.5, 6.95, z, 0.06, 0.62, 0.62, '#b4a88f');
        }
        box(side * 16.55, 7.62, -14, 0.42, 0.3, 24, pale);
        box(side * 16.55, 7.86, -14, 0.5, 0.16, 24.2, '#f4eee1');
    }
    box(0, 7.62, -2.2, 33.4, 0.3, 0.42, pale);
    box(0, 7.62, -25.8, 33.4, 0.3, 0.42, pale);
    // A brass ring round the white marble slab at the centre of the floor.
    const centreRing = torus(2.1, 0.05, 0, 0.19, -14, gilt);
    centreRing.receiveShadow = true;

    // Statuary Hall: the old Hall of the House, a shallow amphitheatre of variegated Breccia
    // marble columns under Carrara capitals, a black and white marble floor, a cast-steel
    // lantern in the ceiling, the Car of History clock, and the eagle in the frieze.
    const brecciaOrder = { plinth: '#6f6153', base: '#7d7062', shaft: breccia, collar: '#9c8e7c', capital: '#efe9dc', abacus: '#f4efe3' };
    for (let i = 0; i < 9; i++) {
        const a = Math.PI * (0.12 + i * 0.095);
        const x = Math.cos(a) * 11.2, z = -37 - Math.sin(a) * 7.1;
        if (Math.abs(x) > 4.5) column(x, z, 6.8, 0.1, 0.55, brecciaOrder);
    }
    for (const [i, s] of [-10, 10].flatMap(x => [-32, -37, -42].map(z => ({ x, z }))).entries()) {
        const robe = mesh(new THREE.ConeGeometry(0.48 + (i % 2) * 0.08, 1.65, 10), i % 3 ? '#6f5b44' : bronze, s.x, 2.25, s.z);
        robe.rotation.y = i * 0.7;
        const arm = mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.9, 7), bronze, s.x + (i % 2 ? 0.35 : -0.35), 2.75, s.z);
        arm.rotation.z = i % 2 ? -0.75 : 0.75;
        box(s.x, 0.22, s.z + 0.66, 0.65, 0.18, 0.035, '#b99b62');
    }
    // More of the collection along the walls, on plinths set into shallow niches.
    const niche = new THREE.CylinderGeometry(0.6, 0.6, 3.4, 12, 1, false, 0, Math.PI);
    for (const side of [-1, 1]) {
        for (const [i, z] of [-31, -34.5, -40, -43.5].entries()) {
            mesh(niche, '#c6bba6', side * 11.75, 2, z);
            box(side * 11.45, 0.55, z, 1.15, 1.1, 1.15, senecaLight);
            const figure = mesh(new THREE.ConeGeometry(0.42 + (i % 2) * 0.07, 1.6, 9), i % 2 ? '#7c6a52' : '#8a7761', side * 11.3, 1.95, z);
            figure.rotation.y = side * (0.3 + i * 0.4);
            mesh(new THREE.SphereGeometry(0.21, 8, 6), '#8a7761', side * 11.3, 2.9, z);
        }
        // Sandstone pilasters and a cornice under the gallery walls.
        for (const z of [-30, -33, -36, -39, -42, -44]) box(side * 11.86, 4.2, z, 0.16, 8, 0.9, aquia);
        box(side * 11.8, 7.5, -37, 0.3, 0.36, 16, pale);
    }
    // Black and white marble tiles, laid as the chamber's floor is.
    const tile = new THREE.BoxGeometry(1.16, 0.02, 1.16);
    for (let ix = 0; ix < 19; ix++) for (let iz = 0; iz < 13; iz++) {
        mesh(tile, (ix + iz) % 2 ? '#31343a' : '#e9e5d9', -10.8 + ix * 1.2, 0.108, -44.4 + iz * 1.2);
    }
    // The cast-steel ceiling lantern that lights the Hall from above.
    box(0, 8.14, -37, 10.6, 0.22, 6.6, pale);
    const lanternSky = painted(ctx => {
        ctx.fillStyle = '#e8eee9'; ctx.fillRect(0, 0, 128, 96);
        ctx.strokeStyle = '#8f9a95'; ctx.lineWidth = 3;
        for (let x = 0; x <= 128; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 96); ctx.stroke(); }
        for (let y = 0; y <= 96; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke(); }
    }, 128, 96, { material: { side: THREE.DoubleSide } });
    const lantern = mesh(new THREE.PlaneGeometry(9.6, 5.6), '#ffffff', 0, 8.03, -37);
    lantern.material = lanternSky;
    lantern.rotation.x = Math.PI / 2;
    lantern.castShadow = false;
    // The Car of History: a clock above the door into the Rotunda, as Clio records the chamber.
    // The lintel gives it something to hang from, as the doorway's own header does.
    box(0, 6.95, -29.15, 8.4, 2.5, 0.4, pale);
    box(0, 6.95, -28.92, 3.4, 2.1, 0.14, '#5f5344');
    const clockFace = canvasMaterial(ctx => {
        ctx.fillStyle = '#f2ead8'; ctx.beginPath(); ctx.arc(128, 128, 118, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#2f2a22'; ctx.lineWidth = 9; ctx.stroke();
        ctx.fillStyle = '#2f2a22'; ctx.font = 'bold 26px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 1; i <= 12; i++) {
            const a = i / 12 * Math.PI * 2 - Math.PI / 2;
            ctx.fillText(String(i), 128 + Math.cos(a) * 88, 128 + Math.sin(a) * 88);
        }
        ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(128, 128); ctx.lineTo(132, 78); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(128, 128); ctx.lineTo(76, 140); ctx.stroke();
    }, 256, 256, { side: THREE.DoubleSide });
    const dial = mesh(new THREE.CircleGeometry(0.72, 32), '#f2ead8', 0, 6.72, -28.82);
    dial.material = clockFace;
    // A small bronze chariot wheel and figure above the dial.
    const wheel = mesh(new THREE.TorusGeometry(0.3, 0.05, 6, 18), verdigris, 0, 7.62, -28.82);
    box(0.36, 7.9, -28.82, 0.5, 0.16, 0.1, verdigris);
    // The sandstone relief eagle in the frieze behind the old Speaker's rostrum.
    const eagle = canvasMaterial(ctx => {
        ctx.fillStyle = '#cfc3ac'; ctx.fillRect(0, 0, 256, 128);
        ctx.strokeStyle = '#8d8069'; ctx.lineWidth = 4; ctx.strokeRect(7, 7, 242, 114);
        ctx.fillStyle = '#7e7159';
        ctx.beginPath(); ctx.moveTo(128, 22); ctx.lineTo(186, 62); ctx.lineTo(158, 62); ctx.lineTo(150, 100);
        ctx.lineTo(106, 100); ctx.lineTo(98, 62); ctx.lineTo(70, 62); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#6a5f4a'; ctx.fillRect(112, 16, 32, 16);
    }, 256, 128, { side: THREE.DoubleSide });
    const friezeEagle = mesh(new THREE.PlaneGeometry(5.6, 1.3), '#ffffff', 0, 6.9, -44.86);
    friezeEagle.material = eagle;

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
