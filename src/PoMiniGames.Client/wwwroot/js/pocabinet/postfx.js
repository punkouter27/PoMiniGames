// pocabinet/postfx.js  (r186 TSL port)
//
// HDR post-processing for PoCabinet as ONE three RenderPipeline node graph, which runs on the
// WebGPU backend and on WebGPURenderer's own WebGL2 fallback alike. The r165 version was 1,500 lines
// of hand-written GLSL passes over WebGLRenderTargets; this keeps the look and the `PostFx` API that
// scene.js drives (`render(scene, camera, fx, t)`, `setQuality`, `setSize`, `dispose`).
//
//   pass(scene) (linear HDR, no MSAA)  ──►  GTAO ambient occlusion (medium, high)
//        └─► BloomNode (threshold, 5 mips)
//   composite, in the same order the GLSL took:
//        speed radial blur + chromatic fringe  →  lens rain drops  →  bloom + light shafts toward the sun
//        (the bloom smeared along the line to the sun) + glare and ghosts  →  speed lines
//        →  ACES filmic (exposure) + saturation + slow-motion grade + vignette + flash + grain
//   →  sRGB (the pipeline's output transform)  →  FXAA (the MSAA the r165 target had)
//
// Tone mapping is ours, in the composite (the renderer's own is 'none', scene.js mount), so the
// pipeline's output transform is only the colour-space encode.
//
// SHARED FRONT HALF. The scene pass, TRAA (with a real per-object velocity buffer, so cars reproject
// exactly), auto-exposure, SSGI and SSR come from platform/3d/postStack.js, the same stack PoMarbleRace
// and PoBrawl run. SSGI/SSR are "earned" there: off at boot, on only after the measured frame time
// shows headroom, shed at once when it does not. SSR reads the roughness the road material writes
// (setWeather sets 0.3 in rain, so the wet asphalt mirrors the cars and the sky again; dry it is 1
// and nothing reflects), and is asked for only while it rains (stack.setReflections). Everything
// below the stack (AO, bloom, speed/rain/shafts/tone map/grade, FXAA) is this file's own.
//
// STILL NOT PORTED: the dynamic-light accumulation (LIGHT_FRAG), the old per-object motion blur (the
// speed radial blur stays), the heat-haze/mirage refraction (already off on every tier), and the
// depth-occluded quarter-res light shafts (the cheaper bloom-smear variant that the GLSL used where
// depth passes were off is what runs here).
//
// SCREEN UV: the pipeline's uv runs y down; the scene (fx.sun) speaks GL, y up. The graph works in
// y-up `up` space like the GLSL did and flips once where it reads a texture.

import { RenderPipeline, Vector3, Color } from './three.js';
import {
    mat3, uniform, screenUV, vec2, vec3, vec4, float, mix, clamp, smoothstep, length, dot, fract, floor, sin, cos, abs, exp, max, min,
    atan, step, pow, select, renderOutput, screenSize, convertToTexture,
} from 'three-eco/tsl';
import { POST_LIB } from '../platform/3d/postAddons.js';
import { createPostStack, currentTier } from '../platform/3d/postStack.js';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { ao } from 'three-eco/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three-eco/addons/tsl/display/FXAANode.js';

const SHAFT_TAPS = { low: 10, medium: 14, high: 24 };
const AO_STRENGTH = 0.9;

const hash12 = (p) => {
    let p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
    p3 = p3.add(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
};
const hash22 = (p) => {
    let p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973)));
    p3 = p3.add(dot(p3, p3.yzx.add(33.33)));
    return fract(vec2(p3.x.add(p3.y), p3.y.add(p3.z)).mul(vec2(p3.z, p3.y)));
};

// ACES filmic (the Narkowicz-fit RRT/ODT the GLSL carried; matrices column-major as in GLSL).
const acesFilmic = (c) => {
    const inM = mat3Cols([0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]);
    const outM = mat3Cols([1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]);
    const v = inM.mul(c);
    const a = v.mul(v.add(0.0245786)).sub(0.000090537);
    const b = v.mul(v.mul(0.983729).add(0.432951)).add(0.238081);
    return clamp(outM.mul(a.div(b)), 0, 1);
};
function mat3Cols(a, b, c) { return mat3(vec3(...a), vec3(...b), vec3(...c)); }

export class PostFx {
    constructor(renderer) {
        this.renderer = renderer;
        this.quality = 'high';
        this.scene = null;
        this.camera = null;
        this.pipeline = null;
        this.nodes = null;
        // The values scene.js's fx bag writes each frame (same meaning as the GLSL uniforms).
        this.u = {
            time: uniform(0), speed: uniform(0), motion: uniform(1), rain: uniform(0), flash: uniform(0), slow: uniform(0),
            bloom: uniform(0.7), exposure: uniform(1), threshold: uniform(1),
            // sun: x, y (screen uv, y up here), z = visibility; sunColor: linear rgb.
            sun: uniform(new Vector3()), sunColor: uniform(new Color(1, 1, 1)),
        };
    }

    /**
     * scene.js calls this with the BUDGET's rung tier, which moves down and up during a session (and down
     * hard while shaders compile). The pipeline is a graph per tier and every rebuild gives the scene pass
     * a new MRT, which recompiles every material: that churn took the first seconds of a race to ~0.3 FPS.
     * So the graph follows the player's own tier (<html data-gfx>) and rebuilds only when THAT changes; the
     * budget still scales resolution, particles and shadows through scene.js.
     */
    setQuality(q) {
        const app = currentTier();
        if (this.pipeline && app === this.builtTier) return;
        this.quality = q;
        this.pipeline = null;      // rebuilt on the next frame with the new tier
    }

    /** The pass and every stage target follow the renderer's drawing-buffer size on their own. */
    setSize() {}

    build(scene, camera) {
        const q = this.builtTier = currentTier(), U = this.u;
        this.dispose(true);
        this.scene = scene; this.camera = camera;
        // The shared HDR front half. dynres is off: scene.js's applyBudget already owns the resolution.
        // Exposure's strength is low: the composite below has its own authored exposure and weather rig.
        const stack = createPostStack(POST_LIB, this.renderer, scene, camera, {
            // MRT (per-object velocity + normals + roughness, the price of SSR) makes every material compile a second
            // program (about 350 instead of 165 here, ~15 s of boot compile on a slow GPU), so only the high tier on
            // WebGPU pays it; WebGL2 fallback and medium reproject from the camera alone ('camera' velocity: no MRT).
            velocity: q === 'high' && !!this.renderer?.backend?.isWebGPUBackend ? 'mrt' : 'camera',
            tier: q, features: { dynres: false, flare: false, streak: false }, samples: 0,   // GTAO below needs a sampleable (single-sample) depth
            reflections: { enabled: false, intensity: 0.9, maxDistance: 80 },
            exposure: { strength: 0.3, min: 0.9, max: 1.12 },
        });
        this.stack = stack;
        const scenePass = stack.scenePass;
        const sceneTex = convertToTexture(stack.node);
        const useAo = q !== 'low';
        let aoNode = null;
        if (useAo) {
            aoNode = ao(stack.depthNode, null, camera);
            aoNode.radius.value = 1.6 * 0.5;
            aoNode.samples.value = q === 'high' ? 12 : 8;
            aoNode.resolutionScale = 0.5;
        }
        const bloomNode = bloom(sceneTex, 1, 0.55, U.threshold);
        const bloomTex = bloomNode.getTextureNode();
        const aoTex = aoNode ? aoNode.getTextureNode() : null;
        const out = this.composite(sceneTex, bloomTex, aoTex, SHAFT_TAPS[q] ?? 14);
        const pipeline = new RenderPipeline(this.renderer);
        pipeline.outputColorTransform = false;
        pipeline.outputNode = fxaa(renderOutput(out));
        this.pipeline = pipeline;
        this.nodes = { scenePass, aoNode, bloomNode, sceneTex };
    }

    composite(sceneTex, bloomTex, aoTex, taps) {
        const U = this.u;
        const q = screenUV;
        const up = vec2(q.x, float(1).sub(q.y));
        const at = (p) => vec2(p.x, float(1).sub(p.y));
        const aspect = screenSize.x.div(screenSize.y);
        const asp = vec2(aspect, 1);
        const lit = (uv) => {
            const c = sceneTex.sample(at(uv)).rgb;
            return aoTex ? c.mul(mix(float(1), aoTex.sample(at(uv)).r, AO_STRENGTH)) : c;
        };
        const center = vec2(0.5, 0.5);
        const toC = up.sub(center);

        // ── Speed: radial blur + fringing ──
        const bmask = smoothstep(0.18, 0.66, length(toC.mul(asp)));
        const amt = U.speed.mul(U.speed).mul(0.032).mul(U.motion).mul(bmask);
        let col = vec3(0);
        for (let i = 0; i < 8; i++) col = col.add(lit(up.sub(toC.mul(amt).mul(i / 7))));
        col = col.div(8);
        const ca = float(0.0004).add(U.speed.mul(0.0018)).mul(U.motion).mul(bmask);
        col = vec3(
            mix(col.r, sceneTex.sample(at(up.add(toC.mul(ca)))).r, 0.7),
            col.g,
            mix(col.b, sceneTex.sample(at(up.sub(toC.mul(ca)))).b, 0.7),
        );

        // ── Lens rain: refracting drops on the camera glass ──
        const drops = (p, scale, density) => {
            const g = p.mul(scale), id = floor(g), f = fract(g).sub(0.5), r = hash22(id);
            const rate = float(0.08).add(r.y.mul(0.1));
            const life = fract(U.time.mul(rate).add(r.x));
            const c0 = hash22(id.add(floor(U.time.mul(rate).add(r.x)))).sub(0.5).mul(0.45);
            const c = vec2(c0.x, c0.y.sub(life.mul(0.25).mul(float(0.3).add(U.speed))));
            const rad = float(0.1).add(r.y.mul(0.13)).mul(smoothstep(0, 0.1, life)).mul(smoothstep(0.8, 1, life).oneMinus());
            let dv = f.sub(c);
            dv = vec2(dv.x.mul(float(1).add(U.speed.mul(0.6))), dv.y);
            const m = smoothstep(rad.mul(0.55), rad, length(dv)).oneMinus().mul(select(hash12(id.add(17.31)).greaterThan(density), float(0), float(1)));
            return vec3(dv.div(max(rad, 1e-3)).mul(m), m);
        };
        const rq = up.sub(vec2(0.5, 0)).mul(asp);
        const d1 = drops(rq, 7, U.rain.mul(0.3)), d2 = drops(rq.add(vec2(0.371, 0.113)), 16, U.rain.mul(0.25));
        const dm = max(d1.z, d2.z);
        const dn = d1.xy.mul(0.035).add(d2.xy.mul(0.018));
        const dropCol = lit(up.sub(dn.mul(1.6))).mul(1.05);
        const rained = mix(col, dropCol, dm).mul(float(1).sub(dm.mul(float(1).sub(dm))));
        col = mix(col, rained, step(0.001, U.rain));

        // ── Bloom + light shafts toward the sun ──
        col = col.add(bloomTex.sample(at(up)).rgb.mul(U.bloom));
        const sp = U.sun.xy, vis = U.sun.z;
        const dlt = sp.sub(up).div(taps);
        let shafts = vec3(0), p = up, decay = float(1);
        for (let i = 0; i < taps; i++) {
            p = p.add(dlt);
            shafts = shafts.add(bloomTex.sample(at(p)).rgb.mul(decay));
            decay = decay.mul(0.95 ** (28 / taps));
        }
        const sunCol = U.sunColor;
        col = col.add(shafts.div(taps).mul(sunCol).mul(vis).mul(0.9));
        const ds = up.sub(sp).mul(asp);
        const glare = exp(length(ds).mul(-7)).mul(0.35).add(exp(abs(ds.y).mul(-90)).mul(exp(abs(ds.x).mul(-3))).mul(0.12));
        let ghosts = float(0);
        const axis = center.sub(sp);
        for (let g = 1; g <= 3; g++) {
            const gp = sp.add(axis.mul(0.6 + g * 0.45));
            ghosts = ghosts.add(smoothstep(0, 0.05 + g * 0.02, length(up.sub(gp).mul(asp))).oneMinus().mul(0.05));
        }
        col = col.add(sunCol.mul(glare.add(ghosts)).mul(vis));

        // ── Speed lines (after bloom so they stay crisp) ──
        const dir = toC.mul(asp), len = length(dir), ang = atan(dir.y, dir.x);
        const laneF = ang.mul(180 / Math.PI), lane = floor(laneF), lr = hash12(vec2(lane, 3.1));
        let streak = step(0.94, lr).mul(smoothstep(0.42, 0.9, len));
        const travel = fract(len.mul(1.1).sub(U.time.mul(float(1.6).add(lr.mul(2)))).add(lr.mul(7)));
        streak = streak.mul(smoothstep(0, 0.05, travel)).mul(smoothstep(0.08, 0.32, travel).oneMinus());
        streak = streak.mul(smoothstep(0.05, 0.22, abs(fract(laneF).sub(0.5))).oneMinus());
        col = col.add(vec3(0.9, 0.95, 1).mul(streak).mul(pow(U.speed, 3)).mul(0.12).mul(U.motion));

        // ── Tone map + grade ──
        col = acesFilmic(col.mul(U.exposure).div(0.6));
        const luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(luma), col, 1.08);
        col = mix(col, vec3(luma).mul(vec3(0.9, 0.97, 1.08)), U.slow.mul(0.55));
        const vig = smoothstep(0.5, 1.2, length(toC.mul(asp).mul(vec2(0.9, 1))));
        col = col.mul(float(1).sub(vig.mul(float(0.35).add(U.speed.mul(0.15).mul(U.motion)).add(U.slow.mul(0.35)))));
        col = mix(col, vec3(1, 0.98, 0.95), clamp(U.flash, 0, 1));
        col = col.add(hash12(q.mul(screenSize).add(fract(U.time.mul(7.3)).mul(91))).sub(0.5).mul(0.004));
        return vec4(clamp(col, 0, 1), 1);
    }

    render(scene, camera, fx, timeSeconds) {
        if (!this.pipeline || this.scene !== scene || this.camera !== camera) this.build(scene, camera);
        const U = this.u, motion = !fx.reduced;
        U.time.value = timeSeconds % 1000;
        U.speed.value = Math.min(1, Math.max(0, fx.speed || 0));
        U.motion.value = motion ? 1 : 0;
        U.rain.value = fx.rain || 0;
        U.flash.value = fx.flash || 0;
        U.slow.value = fx.slow || 0;
        U.bloom.value = fx.bloom ?? 0.7;
        U.exposure.value = fx.exposure || 1;
        U.threshold.value = fx.bloomThreshold || 1.0;
        if (fx.sun) U.sun.value.set(fx.sun.x, 1 - fx.sun.y, fx.sun.v); else U.sun.value.set(0, 0, 0);
        if (fx.sunColor) U.sunColor.value.copy(fx.sunColor);
        // Reflections only matter on the wet road; a dry race should not even bid for the pass.
        this.stack?.setReflections((fx.rain || 0) > 0);
        this.stack?.update();
        this.pipeline.render();
    }

    dispose(keepUniforms = false) {
        const n = this.nodes;
        if (n) {
            try { n.aoNode?.dispose?.(); } catch { /* already gone */ }
            try { n.bloomNode?.dispose?.(); } catch { /* already gone */ }
        }
        try { this.stack?.dispose?.(); } catch { /* already gone */ }
        this.stack = null;
        try { this.pipeline?.dispose?.(); } catch { /* already gone */ }
        this.pipeline = null;
        this.nodes = null;
    }
}
