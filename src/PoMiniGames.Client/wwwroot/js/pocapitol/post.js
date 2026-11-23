import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { ao } from 'three-eco/addons/tsl/display/GTAONode.js';
import { dof } from 'three-eco/addons/tsl/display/DepthOfFieldNode.js';
import { allowHeavy } from '../platform/postPunch.js';
import { makeTarget, makeQuad, drawQuad, tap, hashFrag, isWebGPU } from './nodes.js';
import { createTemporal } from './temporal.js';
import { createVolumetric } from './volumetric.js';
import { createSmallLights } from './smallLights.js';
import { createLens } from './lens.js';

// PoCapitol's frame: scene -> ambient occlusion -> contact shadows (SSCS) ->
// diffuse global illumination (SSGI) -> screen-space reflections (SSR) -> small lights ->
// lit air -> temporal resolve -> refraction -> bloom -> sun shafts -> motion blur ->
// (transient) depth of field -> lens (metering, flare) -> tone map -> FXAA -> grade.
//
// r186 PORT. On r165 this was an EffectComposer of ShaderPass GLSL strings. It is now the same
// list of steps as TSL node graphs, each a node material on a QuadMesh drawn into a render target
// (nodes.js explains why it is not one RenderPipeline graph: the steps that are off most of the
// time must cost nothing, and the lights, the air and the velocity boxes are draws of their own).
//   - ambient occlusion is three's own GTAONode (it replaces the GTAOPass, which drew the scene a
//     second time with a normal/depth override; this one reads the scene's own depth)
//   - bloom is three's BloomNode, depth of field three's DepthOfFieldNode
//   - everything else (contact shadows, bounce, reflections, shafts, the temporal resolve, the
//     lit air, the lens and the grade) is the old GLSL, rewritten in TSL line for line
//
// DIFFERENCES FROM r165 worth knowing
//   - the scene target has no MSAA: the one place it was used (levels 1 and 2) is FXAA now. A
//     multisampled target cannot give a depth texture back on WebGPU, and changing a target's
//     sample count would rebuild every pipeline of the scene (the multi-second hitch quality.js
//     exists to avoid)
//   - the AO pass no longer needs its own depth render, so level 3 draws the scene once, not twice
//   - the scene still always goes through the targets, even with every optional step off, so a
//     quality change never flips the scene's shaders between "to screen" and "to target"
//
// Levels (post.setLevel): 3 everything, anti-aliased over time; 2 bloom, shafts, flare and
// metering with FXAA; 1 FXAA and grade; 0 grade only.

const POISSON = [[-0.326, -0.406], [-0.840, -0.074], [-0.696, 0.457], [-0.203, 0.621], [0.962, -0.195], [0.473, -0.480], [0.519, 0.767], [0.185, -0.893]];
const DOF_PEAK = 0.012, DOF_BOKEH = 2.4, DOF_BAND = 2.2;

/**
 * @param depthCamera unused now (kept for the caller): the AO and depth of field read the scene's
 *   own depth, and the see-through layer-1 things (sky, sprites, decals) do not write depth.
 */
export function createPost(renderer, scene, camera, depthCamera) {
    void depthCamera;
    const { Fn, If, float, vec2, vec3, vec4, uniform, texture, mix, clamp, max, min, select, pow, dot, smoothstep, sin, cos, fract, step, abs, normalize } = TSL;
    const gpu = isWebGPU(renderer);
    // Clip-space z for a depth read: WebGPU's is the depth itself, the WebGL2 backend's is -1..1.
    const ndcZ = d => (gpu ? d : d.mul(2).sub(1));
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateProjectionMatrix();

    // ---- targets
    const scenePass = new THREE.RenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: true, samples: 0,
        depthTexture: new THREE.DepthTexture(1, 1),
    });
    scenePass.depthTexture.type = THREE.FloatType;
    const A = makeTarget(), B = makeTarget(), D = makeTarget();
    const history = [makeTarget(), makeTarget()];
    let histAt = 0;
    const dummy = scenePass.texture;
    const src = () => texture(dummy);

    // ---- shared uniforms
    const uNear = uniform(0.1), uFar = uniform(420), uTime = uniform(0);
    const depthTex = texture(scenePass.depthTexture);
    const viewZ = uv => TSL.perspectiveDepthToViewZ(depthTex.sample(uv).r, uNear, uFar);
    // SSR and the shafts were written against this normalised depth (0 at the lens, 1 at the far plane).
    const lin01 = uv => {
        const z = depthTex.sample(uv).r;
        return uNear.mul(2).div(uFar.add(uNear).sub(z.mul(uFar.sub(uNear))));
    };
    const uTexel = uniform(new THREE.Vector2(1 / 1280, 1 / 720)), uRes = uniform(new THREE.Vector2(1280, 720));

    const temporal = createTemporal(renderer, camera, scenePass.depthTexture, ndcZ);
    const lens = createLens(renderer);
    const lightsSrc = src();
    const lights = createSmallLights(renderer, camera, scenePass.depthTexture, lightsSrc, temporal.matrices.invViewProj, ndcZ);
    const air = createVolumetric(renderer, scenePass.depthTexture, temporal.matrices.invViewProj, ndcZ);

    // ---- step 1: ambient occlusion and contact shadows
    const uSscsIntensity = uniform(0.3), uSscsReach = uniform(0.4), uLightView = uniform(new THREE.Vector3(0, 1, 0)), uProj = uniform(new THREE.Vector2(1, 1));
    const aoNode = ao(depthTex, null, camera);
    aoNode.resolutionScale = 0.5;
    aoNode.radius.value = 0.7; aoNode.distanceExponent.value = 1.5; aoNode.thickness.value = 1; aoNode.scale.value = 1; aoNode.samples.value = 8;
    const AO_BLEND = 0.85;
    const srcLit = src();
    const quadOcclusion = makeQuad(Fn(() => {
        const uv = TSL.screenUV;
        const col = tap(srcLit, uv).toVar();
        col.rgb.mulAssign(mix(1, aoNode.getTextureNode().r, AO_BLEND));
        // Contact shadows: the last few centimetres the shadow map cannot draw. From each pixel a
        // short ray is walked toward the sun through the depth buffer; if something solid stands
        // between the pixel and the light within arm's reach, the pixel is darkened. Positions are
        // rebuilt in view space, in metres, so the reach and the thickness test mean the same
        // thing next to the lens and across the lawn.
        const z = viewZ(uv);
        const at = vec3(uv.mul(2).sub(1).mul(z.negate()).div(uProj), z);
        // Further away the ray is longer, so its steps never fall inside one pixel.
        const reach = uSscsReach.mul(z.negate().mul(0.035).add(1));
        const start = hashFrag(TSL.screenCoordinate.add(fract(uTime).mul(53)));
        const shadow = float(0).toVar(), alive = float(1).toVar();
        for (let i = 0; i < 6; i++) {
            const t = reach.mul(start.add(i)).div(6);
            const p = at.add(uLightView.mul(t));
            const uvp = p.xy.mul(uProj).div(p.z.negate()).mul(0.5).add(0.5);
            alive.mulAssign(step(p.z, uNear.negate()).mul(step(0, uvp.x)).mul(step(uvp.x, 1)).mul(step(0, uvp.y)).mul(step(uvp.y, 1)));
            // How far in front of the ray the scene's surface is here. Just in front: something is in
            // the way. Far in front: a person a street nearer the lens, not a caster.
            const gap = viewZ(uvp.clamp(0, 1)).sub(p.z);
            const hit = step(t.mul(0.12).add(0.025), gap).mul(step(gap, 0.45));
            shadow.assign(max(shadow, hit.mul(alive).mul(t.div(reach).oneMinus())));
        }
        const skip = z.lessThan(-70).or(uSscsIntensity.lessThanEqual(0));
        col.rgb.mulAssign(select(skip, 1, shadow.mul(uSscsIntensity).oneMinus()));
        return col;
    })());

    // ---- step 2: bounced light and reflections
    // Bounced light, in screen space: a surface next to a brighter one picks up some of its colour.
    // Eight neighbours at about the same depth are averaged, and only what they have over the pixel
    // itself is added, so an evenly lit wall gains nothing and the shaded side of a column next to
    // sunlit paving is lifted and tinted by it. The sample pattern turns every frame; the temporal
    // resolve averages the turns.
    const uBounce = uniform(0.2), uRadius = uniform(26), uSsrIntensity = uniform(0.45);
    const srcOcc = src();
    const quadBounce = makeQuad(Fn(() => {
        const uv = TSL.screenUV;
        const col = tap(srcOcc, uv).toVar();
        const z = viewZ(uv).negate();
        const radius = vec2(uRes.y.div(uRes.x), 1).mul(clamp(uRadius.mul(0.05).div(z), 0.004, 0.06));
        const rot = hashFrag(TSL.screenCoordinate.add(fract(uTime).mul(11))).mul(6.28318);
        const cs = cos(rot), sn = sin(rot);
        const bounce = vec3(0).toVar(), total = float(0).toVar();
        for (const [px, py] of POISSON) {
            const turned = vec2(cs.mul(px).sub(sn.mul(py)), sn.mul(px).add(cs.mul(py)));
            const sUv = uv.add(turned.mul(radius));
            const inside = step(0, sUv.x).mul(step(sUv.x, 1)).mul(step(0, sUv.y)).mul(step(sUv.y, 1));
            // Only what is about as far away as this pixel can be lighting it.
            const near = abs(viewZ(sUv.clamp(0, 1)).negate().sub(z)).div(1.5).clamp(0, 1).oneMinus().mul(inside);
            bounce.addAssign(tap(srcOcc, sUv.clamp(0, 1)).rgb.mul(near));
            total.addAssign(near);
        }
        const excess = max(bounce.div(max(total, 1e-3)).sub(col.rgb), 0);
        const gain = select(z.greaterThan(120).or(uBounce.lessThanEqual(0)).or(total.lessThanEqual(0.001)), 0, 1);
        col.rgb.addAssign(min(excess, vec3(1.5)).mul(uBounce).mul(gain));

        // Screen-Space Reflections (SSR) with roughness jitter and Schlick Fresnel, from the colour the
        // pixels around this one had before the bounce.
        const depth = lin01(uv);
        const dL = lin01(uv.sub(vec2(uTexel.x, 0))), dR = lin01(uv.add(vec2(uTexel.x, 0)));
        const dU = lin01(uv.add(vec2(0, uTexel.y))), dDn = lin01(uv.sub(vec2(0, uTexel.y)));
        const n = normalize(vec3(dL.sub(dR).mul(18), dDn.sub(dU).mul(18), 1));
        const upFacing = clamp(n.y.mul(1.5).add(0.15), 0, 1);
        const rStep = vec2(n.x, n.y.negate()).mul(uTexel).mul(16);
        const refl = vec3(0).toVar(), weight = float(0).toVar(), found = float(0).toVar();
        for (let i = 1; i <= 8; i++) {
            const sUv = uv.add(rStep.mul(i));
            const ok = step(0.05, sUv.x).mul(step(sUv.x, 0.95)).mul(step(0.05, sUv.y)).mul(step(sUv.y, 0.95)).mul(found.oneMinus());
            const sDepth = lin01(sUv.clamp(0, 1));
            const hit = step(sDepth, depth.sub(0.002)).mul(step(depth.sub(sDepth), 0.055)).mul(ok);
            refl.assign(mix(refl, tap(srcOcc, sUv.clamp(0, 1)).rgb, hit));
            weight.assign(mix(weight, float(1 - i / 8), hit));
            found.assign(max(found, hit));
        }
        const fresnel = pow(clamp(n.z.oneMinus(), 0, 1), 5).mul(0.96).add(0.04);
        const live = step(depth, 0.92).mul(step(0.005, depth)).mul(step(0.1, upFacing));
        col.rgb.assign(mix(col.rgb, col.rgb.add(refl.mul(fresnel).mul(uSsrIntensity)), weight.mul(upFacing).mul(live)));
        return col;
    })());

    // ---- step 3: small lights and the lit air join the frame
    const uLightsOn = uniform(0), uAirOn = uniform(0);
    const srcLights = src(), srcAirIn = src(), srcAir = src();
    const quadAir = makeQuad(Fn(() => {
        const uv = TSL.screenUV;
        const scene_ = tap(srcAirIn, uv);
        const lit = scene_.rgb.add(tap(srcLights, uv).rgb.mul(uLightsOn)).toVar();
        const a = tap(srcAir, uv);
        lit.assign(mix(lit, lit.mul(a.a.mul(0.85).oneMinus()).add(a.rgb), uAirOn));
        return vec4(lit, scene_.a);
    })());

    // ---- step 4: temporal resolve and sharpen
    const srcNow = src(), srcHist = src(), srcResolved = src();
    const quadResolve = makeQuad(temporal.resolve(srcNow, srcHist));
    const quadSharpen = makeQuad(temporal.sharpen(srcResolved));

    // ---- step 5: refraction
    const srcRefract = src();
    const quadRefract = makeQuad(lens.refractNode(srcRefract));

    // ---- step 6: bloom and sun shafts. Only what is genuinely brighter than lit stone blooms:
    // lamps at dusk, phone screens, the flash-bang core.
    const srcBloom = src();
    const bloomNode = bloom(srcBloom, 0.45, 0.55, 1.15);
    const uSun = uniform(new THREE.Vector3(0.5, 0.5, 0)), uShaftDensity = uniform(0.8);
    const quadBloom = makeQuad(Fn(() => {
        const uv = TSL.screenUV;
        const col = tap(srcBloom, uv).toVar();
        col.rgb.addAssign(bloomNode.rgb);
        // Volumetric sun shafts (atmospheric god rays).
        const deltaUv = uv.sub(uSun.xy).mul(1 / 14).mul(uShaftDensity);
        const coord = uv.toVar(), decay = float(1).toVar(), alive = float(1).toVar(), rays = vec3(0).toVar();
        for (let i = 0; i < 14; i++) {
            coord.subAssign(deltaUv);
            alive.mulAssign(step(0, coord.x).mul(step(coord.x, 1)).mul(step(0, coord.y)).mul(step(coord.y, 1)));
            const c = coord.clamp(0, 1);
            const sky = step(0.94, lin01(c)).mul(alive);
            rays.addAssign(tap(srcBloom, c).rgb.mul(decay).mul(0.32).mul(sky));
            decay.mulAssign(0.93);
        }
        col.rgb.addAssign(rays.mul(0.18).mul(vec3(1.05, 0.98, 0.92)).mul(step(0.5, uSun.z)));
        return col;
    })());

    // ---- step 7: motion blur
    const srcBlur = src();
    const quadBlur = makeQuad(temporal.blurNode(srcBlur));

    // ---- step 8: transient depth of field (built the first time focus is racked)
    const srcDof = src();
    const uFocus = uniform(40), uBokeh = uniform(0);
    let quadDof = null;
    const dofQuad = () => {
        quadDof ??= makeQuad(dof(srcDof, TSL.perspectiveDepthToViewZ(depthTex.sample(TSL.screenUV).r, uNear, uFar), uFocus, DOF_BAND, uBokeh));
        return quadDof;
    };

    // ---- step 9: lens (flare, metering), tone map
    const srcLens = src();
    const quadDisplay = makeQuad(TSL.renderOutput(lens.combineNode(srcLens), THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace));
    const quadDisplayPlain = makeQuad(TSL.renderOutput(tap(srcLens, TSL.screenUV), THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace));

    // ---- step 10: edge-preserving FXAA (levels 1 and 2), then the display-space grade
    const srcFxaa = src();
    const lumaC = vec3(0.299, 0.587, 0.114);
    const quadFxaa = makeQuad(Fn(() => {
        const uv = TSL.screenUV, r = uTexel;
        const col = tap(srcFxaa, uv);
        const rgbNW = tap(srcFxaa, uv.add(vec2(r.x.negate(), r.y.negate()))).rgb, rgbNE = tap(srcFxaa, uv.add(vec2(r.x, r.y.negate()))).rgb;
        const rgbSW = tap(srcFxaa, uv.add(vec2(r.x.negate(), r.y))).rgb, rgbSE = tap(srcFxaa, uv.add(vec2(r.x, r.y))).rgb;
        const lNW = dot(rgbNW, lumaC), lNE = dot(rgbNE, lumaC), lSW = dot(rgbSW, lumaC), lSE = dot(rgbSE, lumaC), lM = dot(col.rgb, lumaC);
        const lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
        const dir = vec2(lNW.add(lNE).sub(lSW.add(lSE)).negate(), lNW.add(lSW).sub(lNE.add(lSE))).toVar();
        const dirReduce = max(lNW.add(lNE).add(lSW).add(lSE).mul(0.03125), 0.0078125);
        const rcpDirMin = float(1).div(min(abs(dir.x), abs(dir.y)).add(dirReduce));
        dir.assign(clamp(dir.mul(rcpDirMin), -8, 8).mul(r));
        const rgbA = tap(srcFxaa, uv.add(dir.mul(1 / 3 - 0.5))).rgb.add(tap(srcFxaa, uv.add(dir.mul(2 / 3 - 0.5))).rgb).mul(0.5);
        const rgbB = rgbA.mul(0.5).add(tap(srcFxaa, uv.add(dir.mul(-0.5))).rgb.add(tap(srcFxaa, uv.add(dir.mul(0.5))).rgb).mul(0.25));
        const lB = dot(rgbB, lumaC);
        const edge = lMax.sub(lMin).greaterThanEqual(max(0.04, lMax.mul(0.12)));
        const picked = select(lB.lessThan(lMin).or(lB.greaterThan(lMax)), rgbA, rgbB);
        return vec4(select(edge, picked, col.rgb), col.a);
    })());
    // Display-space grade: clean tone mapping, documentary saturation, subtle optical lens
    // artifacts and fine sensor grain.
    const srcDisplay = src();
    const uGrain = uniform(0.024), uVignette = uniform(0.25), uSaturation = uniform(0.94), uDistortion = uniform(0.025), uChromatic = uniform(0.0025);
    const uFlash = uniform(0), uSuppression = uniform(0), uPhone = uniform(0), uPhoneTime = uniform(0), uFootage = uniform(0);
    const quadGrade = makeQuad(Fn(() => {
        const vUv = TSL.screenUV;
        const uv0 = vUv.toVar();
        // A phone in the crowd frames portrait, and the hand holding it shakes.
        const cropped = float(0).toVar();
        If(uPhone.greaterThan(0.001), () => {
            const p = uv0.sub(0.5).toVar();
            p.x.mulAssign(0.56);
            p.y.addAssign(p.x.mul(0.02).mul(uPhone));                                  // rolling shutter skew
            p.x.addAssign(sin(uPhoneTime.mul(11)).mul(0.0016).mul(uPhone));             // hand
            p.y.addAssign(cos(uPhoneTime.mul(8.3)).mul(0.0016).mul(uPhone));
            uv0.assign(p.add(0.5));
            cropped.assign(step(0.28, abs(vUv.x.sub(0.5))));
        });
        const d = uv0.sub(0.5);
        const r2 = dot(d, d);
        // A phone's wide lens bows straight lines more than a cinema lens does, and its sensor reads
        // top to bottom, so a moving hand leans the picture.
        const uv = uv0.add(d.mul(r2.mul(uFootage.mul(0.05).add(uDistortion)))).toVar();
        uv.x.addAssign(sin(uv.y.mul(5).add(uTime.mul(6.3))).mul(0.0007).mul(uFootage));
        const tapRgb = u => tap(srcDisplay, u).rgb;
        const c = vec3(tapRgb(uv.add(d.mul(uChromatic))).r, tapRgb(uv).g, tapRgb(uv.sub(d.mul(uChromatic))).b).toVar();
        If(uFootage.greaterThan(0.001), () => {
            // Over-sharpening: the halo a phone draws round every hard edge.
            const around = tapRgb(uv.add(vec2(uTexel.x.mul(1.5), 0))).add(tapRgb(uv.sub(vec2(uTexel.x.mul(1.5), 0))))
                .add(tapRgb(uv.add(vec2(0, uTexel.y.mul(1.5))))).add(tapRgb(uv.sub(vec2(0, uTexel.y.mul(1.5)))));
            c.addAssign(c.sub(around.mul(0.25)).mul(0.4).mul(uFootage));
            // Lens smear: bright things drag a faint horizontal streak across greasy glass.
            const streak = vec3(0).toVar();
            for (let i = 1; i <= 4; i++) {
                const reach = uTexel.x.mul(i * 9);
                streak.addAssign(max(tapRgb(uv.add(vec2(reach, 0))).sub(0.82), 0).add(max(tapRgb(uv.sub(vec2(reach, 0))).sub(0.82), 0)));
            }
            c.addAssign(streak.mul(0.11).mul(uFootage));
            // Metering that never settles, a sky that clips early, and shadows that sit up grey.
            c.mulAssign(sin(uTime.mul(0.83)).mul(sin(uTime.mul(0.31).add(1))).mul(0.05).mul(uFootage).add(1));
            c.assign(mix(c, min(c.mul(1.08), vec3(1)), uFootage.mul(0.6)));
            c.assign(mix(c, c.mul(0.96).add(0.02), uFootage.mul(0.6)));
            c.mulAssign(mix(vec3(1), vec3(0.985, 1.0, 1.02), uFootage));
        });
        const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        const sat = max(0.2, uSaturation.sub(uSuppression.mul(0.45)));
        c.assign(mix(vec3(l), c, sat));
        c.addAssign(vec3(-0.012, 0.0, 0.022).mul(l.oneMinus()).add(vec3(0.018, 0.006, -0.014).mul(l)));
        const vig = uVignette.add(uSuppression.mul(0.75));
        c.mulAssign(vig.mul(r2).mul(1.6).oneMinus());
        c.assign(mix(c, vec3(1.15, 1.1, 0.98), clamp(uFlash, 0, 1)));
        const noise = hashFrag(uv.mul(980).add(fract(uTime.mul(17))));
        c.addAssign(noise.sub(0.5).mul(uGrain).mul(l.oneMinus().mul(0.6).add(0.4)));
        If(uPhone.greaterThan(0.001), () => {
            // Autofocus hunting, then metering pumping as the sky comes into frame.
            const hunt = uPhone.mul(0.0016).mul(sin(uPhoneTime.mul(3.7)).mul(0.5).add(0.5));
            const soft = tapRgb(uv.add(vec2(hunt, 0))).add(tapRgb(uv.sub(vec2(hunt, 0)))).add(tapRgb(uv.add(vec2(0, hunt)))).add(tapRgb(uv.sub(vec2(0, hunt))));
            c.assign(mix(c, soft.mul(0.25), uPhone.mul(0.55)));
            c.mulAssign(uPhone.mul(0.09).mul(sin(uPhoneTime.mul(1.9))).add(1));
            c.assign(mix(c, vec3(0.015), cropped));
        });
        return vec4(c, 1);
    })());

    // ---- rack focus: off during play, ramped in for a moment on a KO or a photo finish
    const rack = { level: 0, target: 0, hold: 0, peak: DOF_PEAK, active: false, focus: 40 };

    // ---- state
    let level = 3, dofAllowed = true, lightKey = -1, interior = null;
    const white = new THREE.Color(1, 1, 1);
    const noPeople = [], noWaves = [];

    /**
     * Cinematic light response. The same passes read differently under the low winter sun and in a
     * marble room, so their strength follows the light instead of being one fixed grade. Only
     * uniforms move here, so a change of light never recompiles a shader.
     */
    function setEnvironment({ sunlight = 1, indoors = false } = {}) {
        const key = Math.round(Math.max(0, Math.min(1, sunlight)) * 20) / 20;
        if (key === lightKey && indoors === interior) return;
        lightKey = key; interior = indoors;
        const dusk = 1 - key;
        // A contact shadow is the sun's: strong under a clear low sun, faint once it has gone.
        // Indoors the light comes in from high windows: a shorter, softer one.
        uSscsIntensity.value = indoors ? 0.16 : 0.1 + key * 0.26;
        uSscsReach.value = indoors ? 0.28 : 0.4;
        // Bounced light matters most in the rotunda, where marble returns it all.
        uBounce.value = indoors ? 0.3 : 0.14 + dusk * 0.1;
        uRadius.value = indoors ? 18 : 26;
        // Polished interior floors and wet paving reflect; grass does not.
        uSsrIntensity.value = indoors ? 0.62 : 0.3 + dusk * 0.4;
        uShaftDensity.value = indoors ? 0.45 : 0.8;
        bloomNode.threshold.value = 1.2 - dusk * 0.32;
        uSaturation.value = indoors ? 0.9 : 0.94;
    }
    function setLevel(next) {
        level = next;
        // The depth these read is drawn with the scene, so they go with the top level only.
        temporal.setEnabled(level >= 3);
        lights.setAllowed(level >= 3);
        air.setAllowed(level >= 3);
        lens.setAllowed(level >= 3);
        lens.setLens(level >= 2);
        dofAllowed = level >= 3;
        if (!dofAllowed) { rack.active = false; rack.level = 0; uBokeh.value = 0; }
    }
    function setSize(w, h, ratio) {
        const pw = Math.max(1, Math.floor(w * ratio)), ph = Math.max(1, Math.floor(h * ratio));
        for (const t of [scenePass, A, B, D, ...history]) t.setSize(pw, ph);
        uTexel.value.set(1 / pw, 1 / ph); uRes.value.set(pw, ph);
        temporal.setSize(pw, ph); lights.setSize(pw, ph); air.setSize(pw, ph); lens.setSize(pw, ph);
    }
    const sunNDC = new THREE.Vector3();
    /**
     * @param frame  what moved and what is in the air this frame: `people` for motion vectors,
     *               `lights`/`ambient`/`haze`/`gas` for the lit air, `waves`/`hazes` for
     *               refraction, `still` when nothing should smear (paused, reduced motion)
     */
    function render(dt, time, calm, cam, sunPos, environment, frame = {}) {
        if (environment) setEnvironment(environment);
        const eye = cam ?? camera;
        temporal.update(frame.people ?? noPeople, dt, time, calm || frame.still === true);
        air.update(eye, frame.lights ?? noPeople, frame.ambient ?? white, frame.haze ?? 0, frame.gas ?? 0, time);
        lens.update(eye, frame.waves ?? noWaves, frame.hazes ?? noWaves, time, calm);
        uTime.value = time; uPhoneTime.value = time;
        // The depth-reading passes work in the camera's own space, in metres.
        uNear.value = eye.near; uFar.value = eye.far;
        uProj.value.set(eye.projectionMatrix.elements[0], eye.projectionMatrix.elements[5]);
        if (frame.sunDir) uLightView.value.copy(frame.sunDir).transformDirection(eye.matrixWorldInverse);
        // A small sensor in flat light is noisy; reduced flashing keeps the frame still either way.
        uGrain.value = calm ? 0.0 : 0.024 + 0.045 * uFootage.value;
        uSun.value.z = 0;
        if (cam && sunPos && level >= 2) {
            sunNDC.copy(sunPos).project(cam);
            uSun.value.set((sunNDC.x + 1.0) * 0.5, (sunNDC.y + 1.0) * 0.5, sunNDC.z < 1.0 ? 1.0 : 0.0);
        }
        // Rack focus: ease in fast, out slow. A slow fade IN would mean the blur arrives after the
        // moment it is reacting to; a fast fade OUT would snap.
        if (rack.active) {
            if (rack.hold > 0) { rack.hold -= dt; if (rack.hold <= 0) rack.target = 0; }
            const k = rack.target > rack.level ? 9 : 2.2;
            rack.level += (rack.target - rack.level) * (1 - Math.exp(-k * dt));
            uBokeh.value = (rack.level * rack.peak / DOF_PEAK) * DOF_BOKEH;
            if (rack.target === 0 && rack.level < 0.01) { rack.level = 0; uBokeh.value = 0; rack.active = false; }
        }

        // 1. the scene, with its depth
        renderer.setRenderTarget(scenePass);
        renderer.render(scene, camera);
        let cur = scenePass.texture;
        const free = [A, B];
        let held = null;     // the target `cur` lives in, when it is one of ours
        const take = () => free.shift();
        const use = target => { if (held) free.push(held); held = target; cur = target.texture; };

        if (level >= 3) {
            // 2. occlusion and contact shadows
            srcLit.value = cur;
            const t1 = take(); drawQuad(renderer, quadOcclusion, t1); use(t1);
            // 3. bounce and reflections
            srcOcc.value = cur;
            const t2 = take(); drawQuad(renderer, quadBounce, t2); use(t2);
            // 4. small lights and the lit air
            const lit = lights.active(), haze = air.active();
            if (lit) { lightsSrc.value = cur; lights.draw(); srcLights.value = lights.target.texture; }
            if (haze) { air.draw(); srcAir.value = air.target.texture; }
            uLightsOn.value = lit ? 1 : 0; uAirOn.value = haze ? 1 : 0;
            if (lit || haze) {
                srcAirIn.value = cur;
                if (!lit) srcLights.value = cur;
                if (!haze) srcAir.value = cur;
                const t3 = take(); drawQuad(renderer, quadAir, t3); use(t3);
            }
            // 5. the resolve: this frame into the history of the old ones
            temporal.drawVelocity();
            const fresh = temporal.consumeFresh();
            const from = history[histAt], to = history[1 - histAt];
            srcNow.value = cur; srcHist.value = from.texture;
            const blend = temporal.uniforms.uBlend.value;
            if (fresh) temporal.uniforms.uBlend.value = 0;
            drawQuad(renderer, quadResolve, to);
            temporal.uniforms.uBlend.value = blend;
            histAt = 1 - histAt;
            srcResolved.value = to.texture;
            const t4 = take(); drawQuad(renderer, quadSharpen, t4); use(t4);
            // 6. refraction (only while something is bending light)
            if (lens.refractActive()) {
                srcRefract.value = cur;
                const t5 = take(); drawQuad(renderer, quadRefract, t5); use(t5);
            }
        }
        // 7. bloom and shafts
        if (level >= 2) {
            srcBloom.value = cur;
            const t6 = take(); drawQuad(renderer, quadBloom, t6); use(t6);
        }
        // 8. motion blur
        if (level >= 3 && temporal.blurOn) {
            srcBlur.value = cur;
            const t7 = take(); drawQuad(renderer, quadBlur, t7); use(t7);
        }
        // 9. rack focus
        if (rack.active && dofAllowed) {
            srcDof.value = cur; uFocus.value = rack.focus;
            const t8 = take(); drawQuad(renderer, dofQuad(), t8); use(t8);
        }
        // 10. lens and tone map
        srcLens.value = cur;
        if (level >= 2) { lens.measure(cur, dt); drawQuad(renderer, quadDisplay, D); }
        else drawQuad(renderer, quadDisplayPlain, D);
        // 11. FXAA (levels 1 and 2), then the grade, to the canvas
        let shown = D;
        if (level >= 1 && level < 3) {
            srcFxaa.value = D.texture;
            const t9 = take(); drawQuad(renderer, quadFxaa, t9); use(t9);
            shown = held;
        }
        srcDisplay.value = shown.texture;
        drawQuad(renderer, quadGrade, null);
    }
    setLevel(3);
    return {
        setLevel, setSize, render, setEnvironment,
        /** Updates retinal flash bloom and combat suppression stress. */
        setCombatStress(flash, suppression) { uFlash.value = flash; uSuppression.value = suppression; },
        /** Cuts to (or out of) a phone held up in the crowd, 0..1, with its own lens artefacts. */
        setPhone(amount) { uPhone.value = Math.max(0, Math.min(1, amount)); },
        /** The footage look, 0..1: wide-lens bow, sharpening halo, smear, clipped sky, sensor noise. */
        setFootage(amount) { uFootage.value = Math.max(0, Math.min(1, amount)); },
        /** Pulls focus onto a subject `distance` metres away for a moment (top quality only). */
        rackFocus(distance, holdSec, strength) {
            // Skipped outright below the top tier: a machine already dropping frames does not need a
            // full-frame blur at the most dramatic moment of the match.
            if (!dofAllowed || !allowHeavy()) return;
            rack.focus = distance == null ? 40 : distance;
            rack.peak = DOF_PEAK * (strength == null ? 1 : Math.max(0, Math.min(1.5, strength)));
            rack.hold = holdSec == null ? 0.9 : holdSec;
            rack.target = 1; rack.active = true;
        },
        /** Nudges the camera for temporal anti-aliasing. Call before anything copies its projection. */
        jitter() { temporal.jitter(); },
        /** After a hard camera cut: last frame's picture is no use to this one. */
        cut() { temporal.cut(); },
        /** The list of small lights: `begin()`, `add(x, y, z, reach, r, g, b, power)`, `end()`. */
        lights,
        /** Builds the scene's pipelines for the target it is drawn into, without freezing the page. */
        // compileAsync can stay pending forever on some drivers (seen on Windows ARM64, Chromium and
        // Edge, both backends): the scene then never reaches its start card. It is a head start, not a
        // requirement, so it gets three seconds and the first frame builds whatever is still missing.
        async compile(timeoutMs = 3000) {
            // On the WebGL2 backend, compileAsync compiles every TSL shader synchronously on the
            // main thread before returning a Promise, freezing the tab before setTimeout can fire.
            // Skip the upfront pass on WebGL2 and let the first draw compile lazily.
            if (!renderer.backend?.isWebGPUBackend) return;
            const was = renderer.getRenderTarget();
            renderer.setRenderTarget(scenePass);
            let timer = 0;
            try {
                await Promise.race([
                    renderer.compileAsync(scene, camera),
                    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
                ]);
            } catch { /* the first frame builds what is missing */ }
            clearTimeout(timer);
            renderer.setRenderTarget(was);
        },
        /** The gas grid's density texture and the ground it covers, for the lit air. */
        setGas(texture_, rect) { air.setGas(texture_, rect); },
        dispose() {
            temporal.dispose(); lights.dispose(); air.dispose(); lens.dispose();
            for (const q of [quadOcclusion, quadBounce, quadAir, quadResolve, quadSharpen, quadRefract, quadBloom, quadBlur, quadDisplay, quadDisplayPlain, quadFxaa, quadGrade, quadDof]) q?.material.dispose();
            for (const t of [scenePass, A, B, D, ...history]) t.dispose();
            aoNode.dispose?.(); bloomNode.dispose?.();
        },
    };
}
