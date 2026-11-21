// pocabinet/materials.js
//
// Shared surface kit for PoCabinet's PBR pass: procedural textures (generated
// once per page, no image assets — the service-worker precache stays small) and
// small onBeforeCompile hooks layered onto MeshStandardMaterial (chained by util.js addHook):
//
//   asphalt()   — aggregate colour, a height-derived normal map and a roughness map
//   grass()     — two-tone blade-scale colour + normal map
//   noise()     — RGBA tileable fbm, four independent octave sets, for shaders
//   macro()     — world-space low-frequency tint so a repeated texture never tiles visibly
//   wind()      — vertex sway for foliage (instanced or not), driven by one clock
//   water()     — animated wave normals for pools
//
// `clock.value` is advanced once per frame by scene.js.

import * as THREE from './three.js';
import { hash, fbm, dataTexture, normalMap, addHook, clamp01 } from './util.js';
import {
    uniform, float, vec2, vec3, vec4, mix, clamp, max, min, pow, dot, sin, cos, fract, smoothstep, normalize, texture,
    positionWorld, positionGeometry, positionView, normalView, materialColor, cameraViewMatrix, modelWorldMatrix, instanceIndex,
} from 'three-eco/tsl';

// Uniform nodes: the scene still does `clock.value = t` and `sunDirUniform.value.copy(...)`.
export const clock = uniform(0);
export const sunDirUniform = uniform(new THREE.Vector3(0.35, 0.75, 0.45));

let asphaltSet = null;
/** { map, normalMap, roughnessMap } — neutral grey, tinted by the material colour. */
export function asphalt() {
    if (asphaltSet) return asphaltSet;
    const S = 256;
    const low = fbm(S, 4, 4, 11), grit = fbm(S, 64, 2, 23);
    const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
        const stone = hash(i % S, (i / S) | 0, 5);
        const speck = stone > 0.985 ? 0.2 : stone < 0.02 ? -0.14 : 0;
        const v = clamp01(0.8 + (low[i] - 0.5) * 0.22 + (grit[i] - 0.5) * 0.3 + speck);
        col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = v * 255;
        col[i * 4 + 3] = 255;
        rough[i * 4 + 1] = (0.78 + (grit[i] - 0.5) * 0.25 - speck * 0.4) * 255;
        rough[i * 4 + 3] = 255;
        height[i] = grit[i] + speck * 1.5;
    }
    asphaltSet = {
        map: dataTexture(col, S, true),
        normalMap: dataTexture(normalMap(height, S, 5), S, false),
        roughnessMap: dataTexture(rough, S, false),
    };
    return asphaltSet;
}

let grassSet = null;
/** { map, normalMap } — near-white two-tone, tinted by the material colour. */
export function grass() {
    if (grassSet) return grassSet;
    const S = 256;
    const low = fbm(S, 4, 4, 41), blades = fbm(S, 48, 3, 57), clumps = fbm(S, 12, 2, 63);
    const col = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
        const v = 0.78 + (blades[i] - 0.5) * 0.45 + (low[i] - 0.5) * 0.15;
        const warm = (clumps[i] - 0.5) * 0.35;
        col[i * 4] = Math.min(255, Math.max(0, (v + warm * 0.9) * 255));
        col[i * 4 + 1] = Math.min(255, Math.max(0, (v + warm * 0.25) * 255));
        col[i * 4 + 2] = Math.min(255, Math.max(0, (v - warm * 0.4) * 235));
        col[i * 4 + 3] = 255;
        height[i] = blades[i];
    }
    grassSet = { map: dataTexture(col, S, true), normalMap: dataTexture(normalMap(height, S, 4), S, false) };
    return grassSet;
}

let noiseTex = null;
/** RGBA tileable fbm (four independent channels) for shader lookups. */
export function noise() {
    if (noiseTex) return noiseTex;
    const S = 128;
    const ch = [fbm(S, 4, 4, 71), fbm(S, 8, 3, 83), fbm(S, 2, 4, 97), fbm(S, 16, 2, 101)];
    const data = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = ch[c][i] * 255;
    noiseTex = dataTexture(data, S, false);
    return noiseTex;
}

// ── Hooks (TSL; see util.js addHook) ─────────────────────────────────────────
// Each hook below is a node transformer, built once per key and shared by every material that
// carries it. World position is `positionWorld`; instances differ by `instanceIndex` (the GLSL read the
// instance matrix's translation, which a positionNode no longer sees: the instance is already applied).

const wxz = () => positionWorld.xz;
const noiseAt = (uvNode) => texture(noise(), uvNode);
const phaseOf = () => fract(float(instanceIndex).mul(0.6180339)).mul(40);

/**
 * World-space low-frequency variation of the albedo: `amount` ± around 1 at
 * `scale` world units per noise tile. Kills visible tiling on big surfaces.
 */
export function macro(material, scale = 60, amount = 0.25) {
    return addHook(material, `macro${scale}:${amount}`, () => ({
        color: (c) => {
            const n1 = noiseAt(wxz().div(scale)), n2 = noiseAt(wxz().div(scale * 0.23));
            const m = n1.r.sub(0.5).mul(1.4).add(n2.g.sub(0.5).mul(0.6));
            let rgb = c.rgb.mul(float(1).add(m.mul(amount)));
            rgb = mix(rgb, rgb.mul(vec3(1.08, 1.0, 0.86)), clamp(n1.b.sub(0.45), 0, 1).mul(amount * 2));
            return vec4(rgb, c.a);
        },
    }));
}

/**
 * Foliage sway + wrapped subsurface scattering translucency (#5). Geometry is authored with
 * its root at the local origin and the free end along +`axis` ('y' for trees, 'x' for palm
 * fronds); the bend grows with distance² (× `reach`). Instances sway out of phase by index.
 */
export function wind(material, amount = 0.12, axis = 'y', reach = 1) {
    subsurface(material, 0x86c45a, 0.28);
    return addHook(material, `wind${amount}${axis}${reach}`, () => ({
        position: (p) => {
            const g = positionGeometry[axis];
            const h = max(g, 0).mul(reach);
            const ph = phaseOf();
            const gust = float(0.7).add(sin(clock.mul(0.31).add(ph)).mul(0.3));
            const sx = sin(clock.mul(1.3).add(ph)).mul(0.6).add(sin(clock.mul(2.9).add(ph.mul(1.7))).mul(0.2));
            const sz = cos(clock.mul(1.05).add(ph.mul(0.8))).mul(0.4);
            const k = h.mul(h).mul(gust);
            return p.add(vec3(sx.mul(amount).mul(k), sx.add(sz).mul(amount * 0.4).mul(k), sz.mul(amount).mul(k)));
        },
    }));
}

/**
 * A flag on a pole: a plane `width` wide in its own x, held along the edge at x = pole * width / 2
 * (`pole` -1 or +1) and rippling more the further from it, with a little droop. Two travelling
 * waves in the vertex stage on the scene's one clock, out of phase by where the flag stands. The
 * plane needs a few segments across to bend (a one-quad plane only shears).
 */
export function flutter(material, width, pole = -1, amount = 0.12) {
    const k = Math.PI * 3 / width;
    return addHook(material, `flutter${width}:${pole}:${amount}`, () => ({
        position: (p) => {
            const px = positionGeometry.x;
            const free = clamp(px.mul(-pole).div(width).add(0.5), 0, 1);
            const ph = modelWorldMatrix[3].x.mul(0.37).add(modelWorldMatrix[3].z.mul(0.23));
            const along = px.mul(-pole * k);
            const gust = float(0.75).add(sin(clock.mul(0.4).add(ph)).mul(0.25));
            const wave = sin(along.sub(clock.mul(6.2)).add(ph)).mul(0.62).add(sin(along.mul(2.3).sub(clock.mul(9.7)).add(ph.mul(1.7))).mul(0.24));
            return p.add(vec3(0, free.mul(free).mul(amount * 0.6).mul(float(1).add(wave.mul(0.4))).negate(), wave.mul(amount).mul(free).mul(gust)));
        },
    }));
}

/**
 * Wrapped subsurface scattering (#5): backlit sun transmission + soft wrap lighting for
 * foliage crowns, palms, and translucent painted plastics. The GLSL added it into the light loop
 * (so the sun's shadow took it away); a node material has no such seam, so it is added as emission:
 * the same terms, without the shadow.
 */
export function subsurface(material, tintHex = 0x90c864, strength = 0.26) {
    const c = new THREE.Color(tintHex);
    return addHook(material, `sss${c.getHexString()}:${strength}`, () => ({
        emissive: (e) => {
            const sunV = normalize(cameraViewMatrix.transformDirection(sunDirUniform));
            const viewDir = normalize(positionView.negate());
            const back = pow(clamp(dot(viewDir, sunV.negate()).mul(0.5).add(0.5), 0, 1), 2.5);
            const rim = float(1).sub(clamp(dot(normalView, viewDir), 0, 1));
            return e.add(materialColor.rgb.mul(vec3(c.r, c.g, c.b)).mul(back.mul(0.65).add(rim.mul(0.35))).mul(strength));
        },
    }));
}

/**
 * Asphalt & trackside puddle porosity (#18): low-frequency porous pooling darkens damp
 * aggregate and focuses wet SSR mirrors inside organic road depressions.
 */
export function puddlePorosity(material, uWet) {
    return addHook(material, 'puddle-porosity', () => {
        const pool = smoothstep(0.46, 0.72, noiseAt(wxz().mul(0.032)).r.mul(0.72).add(noiseAt(wxz().mul(0.14)).g.mul(0.28))).mul(uWet);
        return {
            color: (c) => vec4(c.rgb.mul(float(1).sub(uWet.mul(0.32)).sub(pool.mul(0.18))), c.a),
            rough: (r) => mix(r.mul(float(1).sub(uWet.mul(0.45))), float(0.04), pool),
        };
    });
}

/** Rippling water: animated normal perturbation on a flat, glossy surface. */
export function water(material, strength = 0.18) {
    return addHook(material, `water${strength}`, () => ({
        normal: (n) => {
            const p = wxz();
            const a = noiseAt(p.mul(0.11).add(vec2(clock.mul(0.021), clock.mul(0.013)))).rg.sub(0.5);
            const b = noiseAt(p.mul(0.23).sub(vec2(clock.mul(0.017), clock.mul(-0.024)))).ba.sub(0.5);
            const g = a.add(b).mul(strength * 2);
            return normalize(n.add(cameraViewMatrix.transformDirection(vec3(g.x, 0, g.y))));
        },
    }));
}

/**
 * Reflectivity for postfx.js's screen-space reflections: the GLSL wrote 1 - reflectivity into the
 * HDR target's alpha. The r186 chain has no SSR yet (and a stray alpha on the way to the canvas
 * is only a hazard), so this records the shared `uRefl` on the material for the pass that will
 * read it and changes nothing on screen.
 */
export function reflective(material, uRefl) {
    material.userData.refl = uRefl;
    return material;
}

/**
 * A transparent decal that makes what is under it more reflective instead of less: colour
 * blends as usual, but the target's alpha (postfx.js's 1 − reflectivity) is multiplied by
 * 1 − the decal's coverage. Standing water.
 */
export function mirrorDecal(material) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendEquation = THREE.AddEquation;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    return material;
}

