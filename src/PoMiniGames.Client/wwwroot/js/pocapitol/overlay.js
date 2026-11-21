// The analysis overlay: what analysis.js measures, laid on the ground of the scene.
//
//   density    Fruin's levels of service as a tinted sheet over the route: clear where people
//              move freely, green to amber as they touch, red where they are packed, and a
//              pulsing magenta where packing and force meet (crush risk)
//   contagion  a disc under every person in the crowd: red pushing, amber tipped (enough of the
//              people round them are pushing that they are about to join), blue calm, grey
//              retreating
//
// Both are on layer 1 with the other see-through things, drawn without writing depth, so they
// never hide a person and never show up in the depth-of-field or AO passes.
import * as THREE from 'three';
import { DENSITY, FRUIN, gradeIndex, contagionState } from './analysis.js';
import { groundHeight, CROWD_SIZE } from './world.js';

/** Grade colours, A..F, as [r, g, b, alpha] bytes. A is left clear so the lawn still reads. */
const GRADE_RGBA = {
    default: [[0, 0, 0, 0], [70, 190, 120, 70], [170, 210, 80, 95], [245, 165, 40, 120], [230, 70, 50, 150], [220, 40, 160, 175]],
    // Colour-safe: a single-hue ramp (light to dark blue) that does not lean on red/green.
    colorsafe: [[0, 0, 0, 0], [190, 215, 240, 70], [130, 175, 225, 95], [70, 125, 200, 120], [35, 75, 160, 150], [15, 35, 110, 180]],
};
const RISK_RGBA = { default: [255, 40, 200, 210], colorsafe: [255, 160, 0, 210] };

const STATE_COLOURS = {
    default: { pushing: '#e5484d', tipped: '#f5a524', calm: '#4c8dff', retreating: '#8b8d98' },
    colorsafe: { pushing: '#d55e00', tipped: '#f0e442', calm: '#0072b2', retreating: '#999999' },
};

export function createOverlay(scene) {
    const { cols, rows, x0, z0, w, d } = DENSITY;
    let mode = 'off', palette = 'default', clock = 0;

    // The density sheet: a grid of vertices that follows the ground, carrying one texel per cell.
    const pixels = new Uint8Array(cols * rows * 4);
    const texture = new THREE.DataTexture(pixels, cols, rows, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const sheetGeometry = new THREE.PlaneGeometry(w, d, cols, rows);
    sheetGeometry.rotateX(-Math.PI / 2);
    const at = sheetGeometry.attributes.position, uv = sheetGeometry.attributes.uv;
    for (let i = 0; i < at.count; i++) {
        const x = at.getX(i) + x0 + w / 2, z = at.getZ(i) + z0 + d / 2;
        at.setXYZ(i, x, groundHeight(x, z) + 0.05, z);
        // PlaneGeometry's v runs bottom to top before the rotation; after it, v = 0 sits at +z.
        uv.setXY(i, (x - x0) / w, (z - z0) / d);
    }
    at.needsUpdate = true; uv.needsUpdate = true;
    sheetGeometry.computeBoundingSphere();
    const sheetMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const sheet = new THREE.Mesh(sheetGeometry, sheetMaterial);
    sheet.layers.set(1); sheet.visible = false; sheet.renderOrder = 2; sheet.frustumCulled = false;
    scene.add(sheet);

    // The contagion discs: one instance per person in the crowd.
    const discGeometry = new THREE.CircleGeometry(0.36, 14);
    discGeometry.rotateX(-Math.PI / 2);
    const discMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, fog: false });
    const discs = new THREE.InstancedMesh(discGeometry, discMaterial, CROWD_SIZE);
    discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    discs.setColorAt(0, new THREE.Color());
    discs.layers.set(1); discs.visible = false; discs.renderOrder = 2; discs.frustumCulled = false; discs.count = 0;
    scene.add(discs);
    const pose = new THREE.Object3D(), colour = new THREE.Color();

    function paintDensity(analysis) {
        const ramp = GRADE_RGBA[palette] ?? GRADE_RGBA.default;
        const riskColour = RISK_RGBA[palette] ?? RISK_RGBA.default;
        const pulse = 0.65 + 0.35 * Math.sin(clock * 6);
        for (let i = 0; i < cols * rows; i++) {
            const o = i * 4;
            if (analysis.risk[i]) {
                pixels[o] = riskColour[0]; pixels[o + 1] = riskColour[1]; pixels[o + 2] = riskColour[2];
                pixels[o + 3] = Math.round(riskColour[3] * pulse);
                continue;
            }
            const c = ramp[gradeIndex(analysis.density[i])];
            pixels[o] = c[0]; pixels[o + 1] = c[1]; pixels[o + 2] = c[2]; pixels[o + 3] = c[3];
        }
        texture.needsUpdate = true;
    }

    function paintContagion(state) {
        const colours = STATE_COLOURS[palette] ?? STATE_COLOURS.default;
        let n = 0;
        for (const c of state.companions) {
            const kind = contagionState(c);
            if (kind === 'down' || n >= CROWD_SIZE) continue;
            pose.position.set(c.x, groundHeight(c.x, c.z) + 0.04 + (c.y ?? 0), c.z);
            pose.scale.setScalar(kind === 'tipped' ? 1.15 : 1);
            pose.updateMatrix();
            discs.setMatrixAt(n, pose.matrix);
            discs.setColorAt(n, colour.set(colours[kind]));
            n++;
        }
        discs.count = n;
        discs.instanceMatrix.needsUpdate = true;
        if (discs.instanceColor) discs.instanceColor.needsUpdate = true;
    }

    return {
        /** 'off', 'density' or 'contagion'. */
        setMode(next) {
            mode = ['density', 'contagion'].includes(next) ? next : 'off';
            sheet.visible = mode === 'density';
            discs.visible = mode === 'contagion';
        },
        mode: () => mode,
        /** 'default' or 'colorsafe', following the radar palette. */
        setPalette(next) { palette = next === 'colorsafe' ? 'colorsafe' : 'default'; },
        update(state, analysis, dt) {
            clock += dt;
            if (mode === 'density' && analysis) paintDensity(analysis);
            else if (mode === 'contagion') paintContagion(state);
        },
        dispose() {
            scene.remove(sheet); scene.remove(discs);
            sheetGeometry.dispose(); sheetMaterial.dispose(); texture.dispose();
            discGeometry.dispose(); discMaterial.dispose(); discs.dispose();
        },
    };
}

/** The legend rows for the page: grade letter, label and the density range it covers. */
export function densityLegend() {
    let low = 0;
    return FRUIN.map(f => {
        const row = { grade: f.grade, label: f.label, range: Number.isFinite(f.max) ? `${low.toFixed(2)}–${f.max.toFixed(2)}` : `> ${low.toFixed(2)}` };
        low = f.max;
        return row;
    });
}
