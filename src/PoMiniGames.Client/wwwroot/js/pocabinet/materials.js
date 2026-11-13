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

import * as THREE from 'three';
import { hash, fbm, dataTexture, normalMap, addHook, clamp01 } from './util.js';

export const clock = { value: 0 };

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

// ── Hooks ────────────────────────────────────────────────────────────────────

const WORLD_VARYING_V = `
varying vec3 vPcWorld;
`;

function ensureWorldVarying(shader) {
    if (shader.vertexShader.includes('vPcWorld')) return;
    shader.vertexShader = WORLD_VARYING_V + shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
    {
        vec4 pcw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
            pcw = instanceMatrix * pcw;
        #endif
        vPcWorld = (modelMatrix * pcw).xyz;
    }`);
    shader.fragmentShader = WORLD_VARYING_V + shader.fragmentShader;
}

/**
 * World-space low-frequency variation of the albedo: `amount` ± around 1 at
 * `scale` world units per noise tile. Kills visible tiling on big surfaces.
 */
export function macro(material, scale = 60, amount = 0.25) {
    return addHook(material, `macro${scale}:${amount}`, (shader) => {
        ensureWorldVarying(shader);
        shader.uniforms.uPcNoise = { value: noise() };
        shader.fragmentShader = 'uniform sampler2D uPcNoise;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
            vec4 n1 = texture2D(uPcNoise, vPcWorld.xz / ${scale.toFixed(1)});
            vec4 n2 = texture2D(uPcNoise, vPcWorld.xz / ${(scale * 0.23).toFixed(2)});
            float m = (n1.r - 0.5) * 1.4 + (n2.g - 0.5) * 0.6;
            diffuseColor.rgb *= 1.0 + m * ${amount.toFixed(3)};
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.0, 0.86), clamp(n1.b - 0.45, 0.0, 1.0) * ${amount.toFixed(3)} * 2.0);
        }`);
    });
}

/**
 * Foliage sway + wrapped subsurface scattering translucency (#5). Geometry is authored with
 * its root at the local origin and the free end along +`axis` ('y' for trees, 'x' for palm
 * fronds); the bend grows with distance² (× `reach`). Instances sway out of phase by position.
 */
export function wind(material, amount = 0.12, axis = 'y', reach = 1) {
    subsurface(material, 0x86c45a, 0.28);
    return addHook(material, `wind${amount}${axis}${reach}`, (shader) => {
        shader.uniforms.uPcTime = clock;
        shader.vertexShader = 'uniform float uPcTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        {
            vec3 root = vec3(0.0);
            #ifdef USE_INSTANCING
                root = instanceMatrix[3].xyz;
            #endif
            float h = max(position.${axis}, 0.0) * ${reach.toFixed(3)};
            float ph = dot(root.xz, vec2(0.37, 0.23));
            float gust = 0.7 + 0.3 * sin(uPcTime * 0.31 + root.x * 0.02);
            float sx = sin(uPcTime * 1.3 + ph) * 0.6 + sin(uPcTime * 2.9 + ph * 1.7) * 0.2;
            float sz = cos(uPcTime * 1.05 + ph * 0.8) * 0.4;
            transformed.x += sx * ${amount.toFixed(3)} * h * h * gust;
            transformed.z += sz * ${amount.toFixed(3)} * h * h * gust;
            transformed.y += (sx + sz) * ${(amount * 0.4).toFixed(3)} * h * h * gust;
        }`);
    });
}

/**
 * Wrapped subsurface scattering (#5): backlit sun transmission + soft wrap lighting for
 * foliage crowns, palms, and translucent painted plastics.
 */
export function subsurface(material, tintHex = 0x90c864, strength = 0.26) {
    const c = new THREE.Color(tintHex);
    return addHook(material, `sss${c.getHexString()}:${strength}`, (shader) => {
        if (!shader.fragmentShader.includes('#include <lights_fragment_end>')) return;
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
            vec3 sssL = normalize(vec3(0.35, 0.75, 0.45));
            float sssBack = pow(clamp(dot(geometryViewDir, -sssL) * 0.5 + 0.5, 0.0, 1.0), 2.5);
            float sssRim = 1.0 - saturate(dot(geometryNormal, geometryViewDir));
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)}) * (sssBack * 0.65 + sssRim * 0.35) * ${strength.toFixed(3)};
        }`);
    });
}

/** Rippling water: animated normal perturbation on a flat, glossy surface. */
export function water(material, strength = 0.18) {
    return addHook(material, `water${strength}`, (shader) => {
        ensureWorldVarying(shader);
        shader.uniforms.uPcTime = clock;
        shader.uniforms.uPcNoise = { value: noise() };
        shader.fragmentShader = 'uniform float uPcTime;\nuniform sampler2D uPcNoise;\n' + shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
            vec2 p = vPcWorld.xz;
            vec2 a = texture2D(uPcNoise, p * 0.11 + vec2(uPcTime * 0.021, uPcTime * 0.013)).rg - 0.5;
            vec2 b = texture2D(uPcNoise, p * 0.23 - vec2(uPcTime * 0.017, -uPcTime * 0.024)).ba - 0.5;
            vec2 g = (a + b) * ${strength.toFixed(3)} * 2.0;
            normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz);
        }`);
    });
}

/**
 * Reflectivity for postfx.js's screen-space reflections: an opaque material writes
 * 1 − reflectivity into the HDR target's alpha (everything else writes 1). `uRefl` is a
 * shared { value } so a weather change needs no recompile.
 */
export function reflective(material, uRefl) {
    return addHook(material, 'reflective', (shader) => {
        shader.uniforms.uPcRefl = uRefl;
        shader.fragmentShader = 'uniform float uPcRefl;\n' + shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.a = 1.0 - uPcRefl;`);
    });
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

