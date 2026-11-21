// The analysis overlay: what analysis.js measures, laid on the ground of the scene.
//
//   density    Fruin's levels of service as a tinted sheet over the route: clear where people
//              move freely, green to amber as they touch, red where they are packed, and a
//              pulsing magenta where packing and force meet (crush risk). The sheet is also
//              terrain: densityField.js (a WebGPU compute pass, or the CPU where there is none)
//              gives a smoothed pressure field that raises it into hills where the crowd is
//              packed, glowing contour lines mark the Fruin boundaries on it, and a ring runs
//              out from every crush-risk cell. The heights stay modest so people stay visible.
//   contagion  a disc under every person in the crowd: red pushing, amber tipped (enough of the
//              people round them are pushing that they are about to join), blue calm, grey
//              retreating
//
// Both are on layer 1 with the other see-through things, drawn without writing depth, so they
// never hide a person and never show up in the depth-of-field or AO passes.
import * as THREE from 'three';
import { DENSITY, FRUIN, gradeIndex, contagionState } from './analysis.js';
import { createDensityField } from './densityField.js';
import { reducedMotion, qualityTier } from './gpu.js';
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

    // The terrain: the pressure field raises the sheet, draws the Fruin boundaries as contour
    // lines and sends rings out from crush-risk cells. All of it is added to the stock basic
    // material, so the grade colours from `texture` underneath are untouched.
    const field = createDensityField({ cols, rows, x0, z0, cell: DENSITY.cell });
    const fx = {
        uField: { value: field.texture },
        uRect: { value: new THREE.Vector4(x0, z0, w, d) },
        uHeight: { value: 0.85 },
        uTime: { value: 0 },
        uLevels: { value: FRUIN.slice(0, 5).map(f => f.max) },
        uLine: { value: new THREE.Color(1.0, 0.93, 0.72) },
        uRiskColour: { value: new THREE.Color(1.0, 0.16, 0.78) },
        uRisk: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0, 0, 0)) },
    };
    sheetMaterial.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, fx);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
uniform sampler2D uField; uniform vec4 uRect; uniform float uHeight;
varying vec3 vWorld; varying vec2 vField;
float pressureHeight(float p) { return uHeight * pow(clamp((p - 0.2) / 3.4, 0.0, 1.0), 0.9); }`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
vField = (transformed.xz - uRect.xy) / uRect.zw;
transformed.y += pressureHeight(texture2D(uField, vField).r);
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform sampler2D uField; uniform float uTime; uniform float uLevels[5];
uniform vec3 uLine; uniform vec3 uRiskColour; uniform vec3 uRisk[6];
varying vec3 vWorld; varying vec2 vField;`)
            .replace('#include <opaque_fragment>', `
{
    float p = texture2D(uField, vField).r;
    // Flat shading from the surface slope, so the hills read without a light in the scene.
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    n *= n.y < 0.0 ? -1.0 : 1.0;
    float shade = 0.8 + 0.38 * max(dot(n, normalize(vec3(-0.45, 0.8, 0.35))), 0.0) - 0.12;
    outgoingLight *= shade;
    // Contour lines at Fruin's grade boundaries, a constant two pixels wide, with a soft glow.
    float px = max(fwidth(p), 1e-4), lines = 0.0, glow = 0.0;
    for (int i = 0; i < 5; i++) {
        float off = abs(p - uLevels[i]) / px;
        lines = max(lines, 1.0 - smoothstep(0.7, 1.7, off));
        glow = max(glow, exp(-off * 0.22));
    }
    float lit = smoothstep(0.15, 0.5, p);
    outgoingLight += uLine * (lines * 0.95 + glow * 0.16) * lit;
    diffuseColor.a = max(diffuseColor.a, (lines * 0.9 + glow * 0.12) * lit);
    // Rings out of the crush-risk cells (a source with z = 0 is unused).
    for (int i = 0; i < 6; i++) {
        if (uRisk[i].z < 0.5) continue;
        float phase = fract(uTime * 0.55 + float(i) * 0.37);
        float ring = exp(-pow((distance(vWorld.xz, uRisk[i].xy) - phase * 10.0) / 0.55, 2.0)) * (1.0 - phase);
        outgoingLight += uRiskColour * ring * 1.3;
        diffuseColor.a = max(diffuseColor.a, ring * 0.85);
    }
}
#include <opaque_fragment>`);
    };

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

    function updateTerrain(state, analysis, dt) {
        field.update(state, analysis, dt);
        const calm = reducedMotion(), low = qualityTier() === 'low';
        fx.uHeight.value = low ? 0.5 : 0.85;
        fx.uTime.value = clock;
        // Rings are motion: none under reduced motion or on the lowest tier.
        fx.uRisk.value.forEach((v, i) => {
            const s = calm || low ? null : field.sources[i];
            v.set(s?.x ?? 0, s?.z ?? 0, s ? 1 : 0);
        });
    }

    return {
        /** 'off', 'density' or 'contagion'. */
        setMode(next) {
            mode = ['density', 'contagion'].includes(next) ? next : 'off';
            sheet.visible = mode === 'density';
            discs.visible = mode === 'contagion';
        },
        mode: () => mode,
        /** Which path makes the pressure field: 'webgpu' or 'cpu'. */
        fieldBackend: () => field.backend(),
        /** 'default' or 'colorsafe', following the radar palette. */
        setPalette(next) {
            palette = next === 'colorsafe' ? 'colorsafe' : 'default';
            const risk = RISK_RGBA[palette];
            fx.uRiskColour.value.setRGB(risk[0] / 255, risk[1] / 255, risk[2] / 255);
            fx.uLine.value.set(palette === 'colorsafe' ? 0xffffff : 0xffeeb8);
        },
        update(state, analysis, dt) {
            clock += dt;
            if (mode === 'density' && analysis) {
                paintDensity(analysis);
                updateTerrain(state, analysis, dt);
            }
            else if (mode === 'contagion') paintContagion(state);
        },
        dispose() {
            scene.remove(sheet); scene.remove(discs);
            sheetGeometry.dispose(); sheetMaterial.dispose(); texture.dispose(); field.dispose();
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
