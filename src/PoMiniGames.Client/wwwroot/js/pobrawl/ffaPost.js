// ffaPost.js — the battle royale's post chain, as a three RenderPipeline (TSL): one node graph
// on WebGPU and on the WebGL2 backend alike.
//
//   pass(scene) → AO → [TRAA → exposure → flare + streak] → bloom → grade → tone map + sRGB
//     → [FXAA when neither MSAA nor TRAA cleaned the edges]
//
// The bracketed stage is the shared post stack (platform/3d/postStack.js). The arena has its own
// frame-time scale (ffaRendering.js), so the stack's dynamic resolution is off here, and SSGI is
// off because GTAO already owns occlusion for sixteen bodies.
//
// The policy (ffaVisuals.visualPolicy) decides which stages exist. Each is part of the graph,
// so a policy change rebuilds it; that only happens on a tier move or a sustained slow-down.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, clamp, convertToTexture, dot, exp, mix, normalize, renderOutput, screenUV, smoothstep,
  uniform, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { ao } from 'three-eco/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three-eco/addons/tsl/display/FXAANode.js';
import { POST_LIB } from '../platform/3d/postAddons.js';
import { createPostStack } from '../platform/3d/postStack.js';

// The AO term never takes more than this share of the lit colour: sixteen bodies overlap
// constantly, and a full-strength term would paint a dark halo round every one of them.
const AO_BLEND = 0.6;
const AO_SAMPLES = 8;

export function createFfaPost(scene, renderer, policy) {
  const hitUV = uniform(new THREE.Vector2(0.5, 0.5));
  const texel = uniform(new THREE.Vector2(1, 1));
  const hit = uniform(0);
  const aspect = uniform(1);

  const pipeline = new THREE.RenderPipeline(renderer);
  // The graph ends in its own output transform, so FXAA can run on the display-referred frame.
  pipeline.outputColorTransform = false;

  let live = null;        // { policy, camera, stack, aoNode, bloomNode, ... }
  let wanted = policy;

  // The grade: a local refractive RGB split at the last heavy hit (never a whole-frame white
  // flash), a gentle cool-shadow / warm-highlight split and a faint vignette.
  const grade = (tex) => Fn(() => {
    // Hit points arrive in GL convention (y up); the frame is read y down.
    const vUv = vec2(screenUV.x, screenUV.y.oneMinus()).toVar();
    const at = (p) => tex.sample(vec2(p.x, p.y.oneMinus()));
    const radial = vUv.sub(hitUV).mul(vec2(aspect, 1)).toVar();
    const local = exp(dot(radial, radial).mul(-90)).mul(hit).toVar();
    const bend = normalize(radial.add(vec2(0.00001))).mul(texel).mul(local).mul(1.8).toVar();
    const color = vec3(
      at(clamp(vUv.add(bend), 0, 1)).r,
      at(vUv).g,
      at(clamp(vUv.sub(bend), 0, 1)).b,
    ).toVar();
    const luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color.mulAssign(mix(vec3(0.985, 1.0, 1.018), vec3(1.018, 1.004, 0.985), smoothstep(0.05, 1.2, luma)));
    color.addAssign(vec3(0.022, 0.014, 0.005).mul(local));
    const edge = vUv.sub(0.5);
    color.mulAssign(dot(edge, edge).mul(0.09).oneMinus());
    return vec4(color, 1);
  })();

  const release = () => {
    if (!live) return;
    try { live.aoNode?.dispose?.(); } catch { /* already gone */ }
    try { live.bloomNode?.dispose?.(); } catch { /* already gone */ }
    try { live.stack.dispose(); } catch { /* already gone */ }
    live = null;
  };

  const build = (camera) => {
    release();
    const next = wanted;
    // The AO stage needs a single-sample depth texture (WebGPU cannot sample a multisampled
    // one the way it reads it), so with AO on the pass drops MSAA and FXAA takes over.
    const samples = next.ao ? 0 : next.samples;
    let aoNode = null;
    const stack = createPostStack(POST_LIB, renderer, scene, camera, {
      // The policy's own rungs, as the stack's tiers: AO is the high tier, no MSAA the low one.
      tier: next.ao ? 'high' : next.samples === 0 ? 'low' : 'medium',
      samples,
      velocity: 'camera',          // no MRT: see postStack.js (compileAsync cannot build the outputs)
      features: { dynres: false, ssgi: false, ssr: false },
      exposure: { key: 0.07, strength: 0.4, min: 0.9, max: 1.15 },
      lit: (sceneTex, pass0) => {
        if (!next.ao) return sceneTex;
        // Depth-only: the normals are rebuilt from depth, so no second fighter/normal render.
        aoNode = ao(pass0.getTextureNode('depth'), null, camera);
        aoNode.resolutionScale = 0.5;
        aoNode.samples.value = AO_SAMPLES;
        return vec4(sceneTex.rgb.mul(mix(1, aoNode.getTextureNode().r, AO_BLEND)), sceneTex.a);
      },
    });
    let lit = stack.node;
    let bloomNode = null;
    if (next.bloom) {
      bloomNode = bloom(lit, 0.18, 0.4, 1.05);
      lit = lit.add(bloomNode);
    }
    let out = renderOutput(grade(convertToTexture(lit)));
    // MSAA already cleaned the edges when the pass has samples.
    const useFxaa = samples === 0 && !stack.antialiased;
    if (useFxaa) out = fxaa(out);
    pipeline.outputNode = out;
    pipeline.needsUpdate = true;
    live = { policy: next, camera, stack, aoNode, bloomNode, samples, fxaa: useFxaa };
  };

  return {
    resize(width, height, dpr) {
      const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
      texel.value.set(1 / w, 1 / h);
      aspect.value = width / height;
    },
    configure(next) { wanted = next; },
    render(camera, dt, pulse, point) {
      if (!live || live.policy !== wanted || live.camera !== camera) build(camera);
      hit.value = pulse;
      if (point) {
        const p = point.clone().project(camera);
        hitUV.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
        if (p.z < -1 || p.z > 1) hit.value = 0;
      }
      live.stack.update();
      pipeline.render();
    },
    dispose() {
      release();
      try { pipeline.dispose(); } catch { /* already gone */ }
    },
    get state() {
      const p = live?.policy ?? wanted;
      return { ao: !!p.ao, bloom: !!p.bloom, samples: live ? live.samples : p.samples, fxaa: live ? live.fxaa : p.samples === 0 };
    },
  };
}
