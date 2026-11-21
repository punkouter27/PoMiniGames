import * as THREE from 'three-eco/webgpu';
import { Fn, uniform, float, vec2, vec3, dot, fract, sin, floor, mix } from 'three-eco/tsl';

// Small TSL building blocks shared by PoCapitol's node materials and post passes.
//
// WHY THIS FILE EXISTS
// PoCapitol was written against r165's WebGLRenderer: its surfaces, fabric, flags, sky, smoke and
// every post pass were GLSL strings patched into three's chunks (onBeforeCompile) or ShaderMaterials.
// On r186's WebGPURenderer both of those are ignored, so each became a TSL node graph, which one
// description runs on WebGPU and on the renderer's WebGL2 backend alike. The pieces that more than
// one file needs live here.
//
// Two rules from the PoBrawl port are kept: one node graph is shared by every material that
// looks the same (a graph per material is a program per material), and nothing samples a texture
// inside a branch that depends on the pixel (WGSL rejects derivatives in non-uniform control flow).

const mirrors = new WeakMap();

/**
 * A uniform node that follows a plain `{ value }` object. The scene drives its shared uniforms by
 * writing `.value` from JavaScript, as it always has; the node copies that on each frame.
 */
export function mirror(source) {
    if (!source || source.isNode) return source;
    let node = mirrors.get(source);
    if (!node) {
        node = uniform(source.value);
        node.onFrameUpdate(() => { node.value = source.value; });
        mirrors.set(source, node);
    }
    return node;
}

/** Cheap 2D hash in 0..1, the same one every GLSL snippet in this game used. */
export const hash12 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

/** The screen-space dither hash used by the post passes (`fract(sin(dot(p, ...)))`). */
export const hashFrag = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

/** Value noise on a 2D lattice. */
export const vnoise2 = Fn(([p]) => {
    const i = floor(p), f = fract(p).toVar();
    f.assign(f.mul(f).mul(f.mul(-2).add(3)));
    const a = hash12(i), b = hash12(i.add(vec2(1, 0))), c = hash12(i.add(vec2(0, 1))), d = hash12(i.add(vec2(1, 1)));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
});

/** Five octaves of vnoise2: the sky's cloud deck. */
export const fbm2 = Fn(([p_]) => {
    const p = p_.toVar(), v = float(0).toVar(), a = float(0.5).toVar();
    for (let i = 0; i < 5; i++) {
        v.addAssign(a.mul(vnoise2(p)));
        p.mulAssign(2.03); a.mulAssign(0.5);
    }
    return v;
});

/** 3D hash and value noise for cloth. */
export const hash13 = Fn(([p_]) => {
    const p = fract(p_.mul(0.3183099).add(0.1)).toVar();
    p.mulAssign(17.0);
    return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
});
export const noise3 = Fn(([x]) => {
    const i = floor(x), f = fract(x).toVar();
    f.assign(f.mul(f).mul(f.mul(-2).add(3)));
    const h = (dx, dy, dz) => hash13(i.add(vec3(dx, dy, dz)));
    return mix(
        mix(mix(h(0, 0, 0), h(1, 0, 0), f.x), mix(h(0, 1, 0), h(1, 1, 0), f.x), f.y),
        mix(mix(h(0, 0, 1), h(1, 0, 1), f.x), mix(h(0, 1, 1), h(1, 1, 1), f.x), f.y), f.z);
});

/** True on the WebGPU backend, false on the WebGL2 backend of WebGPURenderer. */
export function isWebGPU(renderer) {
    return renderer?.backend?.isWebGPUBackend === true;
}


// ---------------------------------------------------------------- full-screen passes
//
// The post chain is a list of render-to-texture steps, as it was with r165's EffectComposer: each
// step is a node material on a QuadMesh drawn into a render target, and a step is skipped by simply
// not drawing it. (A RenderPipeline graph evaluates every node it contains every frame; steps that
// are off most of the time, like the lit air and the lens refraction, must cost nothing.)
// Reads use `.level(0)`: the passes are full of taps inside loops and branches, where WGSL does
// not allow implicit-derivative sampling.

/** A half-float render target for one pass. */
export function makeTarget(width = 1, height = 1, { depth = false, filter = THREE.LinearFilter } = {}) {
    const target = new THREE.RenderTarget(width, height, {
        type: THREE.HalfFloatType, depthBuffer: depth, magFilter: filter, minFilter: filter, generateMipmaps: false,
    });
    target.texture.minFilter = target.texture.magFilter = filter;
    return target;
}

/** A full-screen quad whose fragment is `node` (a vec4). */
export function makeQuad(node, { blend = null } = {}) {
    const material = new THREE.NodeMaterial();
    material.fragmentNode = node;
    material.depthTest = false; material.depthWrite = false; material.toneMapped = false; material.fog = false;
    if (blend) { material.transparent = true; material.blending = blend; }
    return new THREE.QuadMesh(material);
}

/** Draws a quad into a target (null = the canvas, drawn raw: no tone map, no colour-space encode). */
export function drawQuad(renderer, quad, target) {
    const tone = renderer.toneMapping, space = renderer.outputColorSpace;
    renderer.setRenderTarget(target);
    if (target === null) { renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace; }
    quad.render(renderer);
    if (target === null) { renderer.toneMapping = tone; renderer.outputColorSpace = space; }
}

/** Sample a texture node at uv, level 0. */
export const tap = (node, uv) => node.sample(uv).level(0);

// Depth textures are read with a plain `sample(uv).r`, not `.level(0)`: on the WebGL2 backend a
// level read of a depth texture comes back as a vec4 that the node's own `float` type does not
// narrow. None of the depth reads sit in a branch that depends on the pixel, so the implicit
// derivative a plain sample needs is fine.
