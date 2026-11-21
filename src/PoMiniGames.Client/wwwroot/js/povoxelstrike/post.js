// post.js — PoVoxelStrike's post-processing chain, as a three r186 RenderPipeline (TSL).
//
//   scene pass (HDR colour + depth) ─▶ Combine ─▶ Bloom ─▶ output transform (ACES + sRGB) ─▶ FXAA
//
// This replaces the WebGL-only chain (EffectComposer + a hand-written SSAO pass + a shaft pass
// + one big Combine ShaderPass + UnrealBloom + SMAA). The same node graph runs on WebGPU and on
// three's WebGL2 backend, which is what lets the game move to r186 without a downgrade.
//
// WHAT CHANGED, AND WHY
//   * AO is three's own GTAONode (depth-only: the arena is axis-aligned voxels, so normals
//     rebuilt from depth are exact, and we still pay no normal pre-pass). It replaces the old
//     depth-only SSAO + its TEMPORAL history blend: GTAO is a better estimator per frame and a
//     ping-ponged half-res history target does not exist in a node graph. Half resolution is kept
//     (`ssaoHalfRes`).
//   * Everything the old Combine pass folded in is still folded into ONE node here, because it
//     is one fetch of the scene colour and one of depth: heat shimmer, heat haze around hot
//     carves, chromatic aberration under trauma, per-pixel motion blur, the AO multiply,
//     contact shadows, wet-puddle reflections, sun shafts, the anamorphic sun streak, lens
//     dust, desaturation, low-HP grain and the lightning exposure spike. The maths is the
//     old GLSL's; the loops are unrolled because TSL has no `continue`.
//   * Sun shafts used to run at quarter resolution into their own target; here they are 14
//     jittered taps at full resolution inside the combine, behind a uniform branch that skips
//     them entirely when the sun is off screen or down (the common case).
//   * FXAA replaces SMAA (three's SMAA is a WebGL-only pass). It runs on the display-referred
//     frame, so the graph ends in renderOutput() and the pipeline's own output transform is off.
//
// STRUCTURE vs UNIFORM. Whether a feature EXISTS (ao, shafts, contact shadows, haze, wet
// reflections, motion blur, lens, bloom, fxaa) is structural: a tier change rebuilds the graph
// (rare, and never mid-frame: `render()` does it). Everything that varies per frame (trauma,
// heat, flash, sun position, camera matrices) is a uniform, so the steady state costs no
// recompile. Texture reads are never inside a branch that depends on a pixel value (WGSL
// uniformity rules): masks are `select`s, and the only `If`s test uniforms.
//
// Coordinates: the node graph below works in "y up" UV like the old shader did (so every
// constant that said "low on the screen" still means low), and flips once when it samples.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, abs, clamp, convertToTexture, cos, cross, distance, dot, exp, float, floor, fract, getScreenPosition,
  getViewPosition, interleavedGradientNoise, length, max, min, mix, normalize, pass, pow, reflect, renderOutput,
  screenCoordinate, screenSize, screenUV, select, sin, smoothstep, uniform, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { ao } from 'three-eco/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three-eco/addons/tsl/display/FXAANode.js';
import { getHotCarves } from './materials.js';

const HAZE_LIFE_S = 2.2;
const SHAFT_STEPS = 14;
const WET_STEPS = 6;

/** The engine-facing uniform bag. Plain `.value` writes; the engine owns every number. */
export function createPostUniforms() {
  return {
    time: uniform(0),
    heat: uniform(0),        // 0..1 gun heat above 70%: shimmer off the barrel
    dust: uniform(0),        // 0..1 grit on the lens after a collapse nearby
    desat: uniform(0),       // 0..1 the colour draining out at low HP
    flash: uniform(0),       // 0..1 lightning
    lowHp: uniform(0),
    trauma: uniform(0),
    sprintBlur: uniform(0),
    wetness: uniform(0),
    sunVisible: uniform(0),
    shaftStrength: uniform(0),
    camMoved: uniform(0),    // 1 when the view changed since last frame (motion blur has work)
    sunScreen: uniform(new THREE.Vector2(0.5, 0.5)),   // y up
    sunColor: uniform(new THREE.Color(0xfff2df)),
    sunDirView: uniform(new THREE.Vector3(0.4, 0.8, 0.25)),
    proj: uniform(new THREE.Matrix4()),
    projInv: uniform(new THREE.Matrix4()),
    camWorld: uniform(new THREE.Matrix4()),
    camWorldInv: uniform(new THREE.Matrix4()),
    prevViewProj: uniform(new THREE.Matrix4()),
  };
}

const hash21 = (p0) => {
  const p = fract(p0.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
};
const valueNoise = (p) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  return mix(
    mix(hash21(i), hash21(i.add(vec2(1, 0))), f.x),
    mix(hash21(i.add(vec2(0, 1))), hash21(i.add(vec2(1, 1))), f.x), f.y);
};
const luma = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
const flipV = (p) => vec2(p.x, p.y.oneMinus());

/**
 * @param {THREE.WebGPURenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {object} u createPostUniforms()
 */
export function createPost(renderer, scene, camera, u) {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  let live = null;
  let wanted = null;

  const release = () => {
    if (!live) return;
    try { live.aoNode?.dispose?.(); } catch { /* already gone */ }
    try { live.bloomNode?.dispose?.(); } catch { /* already gone */ }
    try { live.scenePass.dispose?.(); } catch { /* already gone */ }
    live = null;
  };

  const build = (feat) => {
    release();
    const needsDepth = feat.ao || feat.shafts || feat.contact || feat.haze || feat.wet || feat.motion || feat.lens;
    // A multisampled depth texture cannot be sampled, so any depth reader drops MSAA and FXAA
    // takes over; a chain with no depth reader keeps hardware MSAA when FXAA is off.
    const samples = needsDepth || feat.fxaa ? 0 : 4;
    const scenePass = pass(scene, camera, { samples });
    const colorTex = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    const S = (uvUp) => colorTex.sample(flipV(uvUp));
    const D = (uvDown) => depthTex.sample(uvDown);
    const viewAt = (uvDown) => getViewPosition(uvDown, D(uvDown), u.projInv);

    let aoNode = null;
    if (feat.ao) {
      aoNode = ao(depthTex, null, camera);
      aoNode.resolutionScale = feat.aoHalfRes ? 0.5 : 1;
      aoNode.samples.value = 12;
    }
    const hot = getHotCarves();
    const aspect = screenSize.x.div(screenSize.y);

    const combined = Fn(() => {
      const uvUp = vec2(screenUV.x, screenUV.y.oneMinus());
      const uv = uvUp.toVar();

      // Heat shimmer off the barrel: strongest low and centre, gone by the screen edge.
      if (feat.lens || feat.haze) {
        const m = u.heat.mul(smoothstep(0, 0.7, distance(uvUp, vec2(0.5, 0.34))).oneMinus());
        uv.addAssign(vec2(sin(uvUp.y.mul(95).add(u.time.mul(9))), cos(uvUp.x.mul(70).add(u.time.mul(7)))).mul(0.0024).mul(m));
      }

      // Screen-space heat haze rising off recent blasts and hot carves.
      if (feat.haze) {
        const haze = vec2(0).toVar();
        for (let i = 0; i < 8; i++) {
          const age = hot.time.sub(hot.births[i]);
          const sph = hot.spheres[i];
          const viewC = u.camWorldInv.mul(vec4(sph.xyz, 1));
          const clipC = u.proj.mul(viewC);
          const screenPos = clipC.xy.div(clipC.w).mul(0.5).add(0.5);
          const dUv = uv.sub(screenPos).toVar();
          dUv.x.mulAssign(aspect);
          const projRadius = clamp(sph.w.div(max(1, viewC.z.negate())), 0.02, 0.35);
          // Stretched vertically so the shimmer rises above the crater.
          const plume = vec2(dUv.x, max(0, dUv.y.sub(projRadius.mul(0.6))).mul(0.55).add(min(0, dUv.y)));
          const dist = length(plume).div(projRadius);
          const cool = age.div(HAZE_LIFE_S).oneMinus();
          const falloff = smoothstep(0.2, 1.35, dist).oneMinus().mul(cool).mul(cool);
          const live = age.greaterThanEqual(0).and(age.lessThanEqual(HAZE_LIFE_S)).and(viewC.z.lessThan(-0.2)).and(dist.lessThan(1.35));
          const wave = vec2(
            sin(uv.y.mul(75).sub(u.time.mul(16)).add(i * 2.1)),
            cos(uv.x.mul(65).sub(u.time.mul(13)).add(i * 3.7)));
          haze.addAssign(wave.mul(0.0038).mul(select(live, falloff, 0)));
        }
        uv.assign(clamp(uv.add(haze), 0.001, 0.999));
      }

      const uvDown = flipV(uv);
      const rawDepth = D(uvDown);
      const viewP = select(rawDepth.lessThan(1), getViewPosition(uvDown, rawDepth, u.projInv), vec3(0, 0, -500)).toVar();
      const worldP = u.camWorld.mul(vec4(viewP, 1));

      // Radial chromatic aberration under trauma.
      const c = S(uv).toVar();
      if (feat.lens) {
        If(u.trauma.greaterThan(0.01), () => {
          const radial = uv.sub(0.5);
          const k = u.trauma.mul(dot(radial, radial).mul(0.008).add(0.004));
          c.assign(vec4(
            S(clamp(uv.add(radial.mul(k)), 0.001, 0.999)).r,
            c.g,
            S(clamp(uv.sub(radial.mul(k)), 0.001, 0.999)).b,
            c.a));
        });
      }

      // Camera motion blur at the screen edges when sprinting, shaking or near blasts.
      if (feat.motion) {
        If(u.camMoved.greaterThan(0.5), () => {
          const prevClip = u.prevViewProj.mul(worldP);
          const prevUv = prevClip.xy.div(prevClip.w).mul(0.5).add(0.5);
          const edgeW = smoothstep(0.15, 0.72, distance(uv, vec2(0.5)));
          const activeW = clamp(edgeW.mul(u.sprintBlur.mul(0.85).add(u.trauma.mul(1.2)).add(0.35)), 0, 1);
          const blur = clamp(uv.sub(prevUv).mul(activeW).mul(0.55), -0.025, 0.025);
          const acc = c.rgb.add(S(clamp(uv.sub(blur.mul(0.33)), 0.001, 0.999)).rgb)
            .add(S(clamp(uv.sub(blur.mul(0.66)), 0.001, 0.999)).rgb)
            .add(S(clamp(uv.sub(blur), 0.001, 0.999)).rgb);
          const applies = rawDepth.lessThan(1).and(prevClip.w.greaterThan(0.0001)).and(dot(blur, blur).greaterThan(0.000002));
          c.rgb.assign(select(applies, acc.mul(0.25), c.rgb));
        });
      }

      if (aoNode) {
        // AO darkens ambient, not direct light, so keep a floor: a hard multiply turns every
        // voxel crease into a black seam at this density.
        c.rgb.mulAssign(mix(0.55, 1, aoNode.getTextureNode().sample(uvDown).r));
      }

      // Screen-space contact shadows: a short march toward the sun in view space.
      if (feat.contact) {
        const rayDir = normalize(u.sunDirView).mul(0.14);
        let occ = float(0);
        for (let s = 1; s <= 6; s++) {
          const marchPos = viewP.add(rayDir.mul(s));
          const sUvDown = getScreenPosition(marchPos, u.proj);
          const inside = sUvDown.x.greaterThanEqual(0).and(sUvDown.x.lessThanEqual(1))
            .and(sUvDown.y.greaterThanEqual(0)).and(sUvDown.y.lessThanEqual(1));
          const sd = D(clamp(sUvDown, 0, 1));
          const sp = getViewPosition(clamp(sUvDown, 0, 1), sd, u.projInv);
          const diff = sp.z.sub(marchPos.z);
          occ = max(occ, select(inside.and(sd.lessThan(1)).and(diff.greaterThan(0.025)).and(diff.lessThan(0.65)), 1, 0));
        }
        const near = rawDepth.lessThan(0.9995);
        const distFade = smoothstep(45, 95, viewP.z.negate()).oneMinus();
        c.rgb.mulAssign(occ.mul(0.24).mul(distFade).mul(select(near, 1, 0)).oneMinus());
      }

      // Wet puddle reflections on upward-facing tops, once rain has soaked the stone.
      if (feat.wet) {
        If(u.wetness.greaterThan(0.01), () => {
          const texel = vec2(1).div(screenSize);
          const pR = viewAt(clamp(uvDown.add(vec2(texel.x, 0)), 0, 1));
          const pU = viewAt(clamp(uvDown.sub(vec2(0, texel.y)), 0, 1));
          const viewN = normalize(cross(pR.sub(viewP), pU.sub(viewP)));
          const worldN = normalize(u.camWorld.mul(vec4(viewN, 0)).xyz);
          const noise = valueNoise(worldP.xz.mul(0.22)).mul(0.65).add(valueNoise(worldP.xz.mul(0.68)).mul(0.35));
          const puddle = smoothstep(0.42, 0.68, noise).mul(u.wetness).mul(smoothstep(0.85, 0.96, worldN.y));
          const reflV = reflect(normalize(viewP), viewN);
          let rPos = viewP;
          let hitUv = vec2(uv.x, clamp(uv.y.mul(0.65).oneMinus(), 0.05, 0.95));
          let stopped = float(0);
          for (let r = 1; r <= WET_STEPS; r++) {
            rPos = rPos.add(reflV.mul(r * 0.75));
            const rDown = getScreenPosition(rPos, u.proj);
            const inb = rDown.x.greaterThan(0.01).and(rDown.x.lessThan(0.99)).and(rDown.y.greaterThan(0.01)).and(rDown.y.lessThan(0.99));
            const rp = getViewPosition(clamp(rDown, 0, 1), D(clamp(rDown, 0, 1)), u.projInv);
            const hit = stopped.lessThan(0.5).and(inb).and(rp.z.greaterThanEqual(rPos.z.sub(0.15)));
            hitUv = select(hit, flipV(rDown), hitUv);
            stopped = max(stopped, select(hit.or(inb.not()), 1, 0));
          }
          const reflCol = S(hitUv).rgb.mul(u.flash.mul(1.4).add(1));
          const fresnel = pow(max(0, dot(normalize(viewP).negate(), viewN)).oneMinus(), 3).mul(0.58).add(0.22);
          const applies = worldN.y.greaterThan(0.85).and(rawDepth.lessThan(0.999)).and(viewP.z.negate().lessThan(85)).and(puddle.greaterThan(0.01));
          c.rgb.assign(select(applies, mix(c.rgb.mul(0.82), reflCol, clamp(puddle.mul(fresnel), 0, 0.65)), c.rgb));
        });
      }

      // Sun shafts: radial blur of the sky-only mask toward the sun, jittered against banding.
      if (feat.shafts) {
        If(u.shaftStrength.greaterThan(0.001), () => {
          const delta = uvUp.sub(u.sunScreen).mul(0.85 / SHAFT_STEPS);
          const jitter = interleavedGradientNoise(screenCoordinate.xy);
          const acc = vec3(0).toVar();
          let illum = 1;
          for (let k = 1; k <= SHAFT_STEPS; k++) {
            const p = uvUp.sub(delta.mul(jitter.add(k - 1)));
            const pd = clamp(flipV(p), 0, 1);
            const sky = D(pd).greaterThanEqual(1);
            acc.addAssign(select(sky, colorTex.sample(pd).rgb, vec3(0)).mul(illum * 0.24));
            illum *= 0.94;
          }
          c.rgb.addAssign(acc.mul(u.sunColor).mul(u.shaftStrength).div(SHAFT_STEPS));
        });
      }

      // Anamorphic horizontal sun streak, only where the sun is unoccluded in depth.
      if (feat.lens) {
        If(u.sunVisible.greaterThan(0.01), () => {
          const centerDepth = D(clamp(flipV(u.sunScreen), 0.001, 0.999));
          const dy = abs(uvUp.y.sub(u.sunScreen.y)), dx = abs(uvUp.x.sub(u.sunScreen.x));
          const streak = exp(dy.mul(-95)).mul(exp(dx.mul(-3.8)));
          const core = exp(dx.mul(dx).add(dy.mul(dy)).mul(-240));
          const flare = mix(u.sunColor, vec3(0.65, 0.82, 1.0), 0.38).mul(streak.mul(0.35).add(core.mul(0.25))).mul(u.sunVisible);
          c.rgb.addAssign(select(centerDepth.greaterThanEqual(0.999), flare, vec3(0)));
        });
      }

      // Grit on the lens, thicker toward the edge. Screen-fixed on purpose: it is on the glass.
      let n = valueNoise(uvUp.mul(6)).mul(0.6).add(valueNoise(uvUp.mul(19)).mul(0.4));
      n = smoothstep(0.5, 0.86, n).mul(smoothstep(0.12, 0.72, distance(uvUp, vec2(0.5))).mul(0.65).add(0.35));
      c.rgb.assign(mix(c.rgb, vec3(0.62, 0.55, 0.45).mul(luma(c.rgb).add(0.45)), n.mul(u.dust).mul(0.6)));
      c.rgb.assign(mix(c.rgb, vec3(luma(c.rgb)).mul(vec3(1, 0.93, 0.92)), u.desat));
      if (feat.lens) {
        const grain = hash21(uvUp.mul(screenSize).add(vec2(u.time.mul(61.7), u.time.mul(37.3)))).sub(0.5);
        c.rgb.addAssign(grain.mul(0.09).mul(u.lowHp));
      }
      c.rgb.mulAssign(u.flash.mul(1.5).add(1));
      return c;
    })();

    let lit = combined;
    let bloomNode = null;
    if (feat.bloom) {
      // Bloom's mip chain is the most expensive thing in the chain and is low-frequency by
      // definition; the node runs at its own reduced internal resolution.
      bloomNode = bloom(lit, 0.35, 0.5, 0.82);
      lit = lit.add(bloomNode);
    }
    let out = renderOutput(convertToTexture(lit));
    if (feat.fxaa) out = fxaa(out);
    pipeline.outputColorTransform = !feat.fxaa;
    pipeline.outputNode = feat.fxaa ? out : lit;
    pipeline.needsUpdate = true;
    live = { feat, key: JSON.stringify(feat), scenePass, aoNode, bloomNode, samples };
  };

  return {
    /** Declare the feature set; the graph rebuilds on the next render() if it changed. */
    configure(feat) { wanted = feat; },
    render() {
      if (!wanted) return;
      const key = JSON.stringify(wanted);
      if (!live || live.key !== key) build(wanted);
      pipeline.render();
    },
    get state() { return live ? { ...live.feat, samples: live.samples } : null; },
    dispose() {
      release();
      try { pipeline.dispose(); } catch { /* already gone */ }
    },
  };
}
