// sceneSetup.js — renderer, post chain, quality tier, shadows, IBL and anisotropy.
// Mixin (see mixin.js). Never reads match state; the sim stays in game.js.
//
// The post chain is a three RenderPipeline (TSL), so one node graph runs on WebGPU and on
// WebGPURenderer's own WebGL2 backend alike:
//
//   pass(scene) → GTAO → bloom → [afterimage] → [rack focus] → CA/vignette/grade → output
//
// The engine still talks to it through the handles the old EffectComposer chain had
// (`composer.render()`, `bloomPass.strength`, `fxPass.uniforms`, `afterimage.enabled`,
// `rackFocus.pass`), so nothing outside this file knows which renderer is underneath.

import * as THREE from 'three-eco/webgpu';
import { convertToTexture, mix, pass, renderOutput, uniform, vec4 } from 'three-eco/tsl';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { ao } from 'three-eco/addons/tsl/display/GTAONode.js';
import { afterImage } from 'three-eco/addons/tsl/display/AfterImageNode.js';
import { dof } from 'three-eco/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three-eco/addons/tsl/display/FXAANode.js';
import { allowHeavy } from '../platform/postPunch.js';
import * as Quality from './quality.js';
import { bindView, setMaxDpr } from './stageHost.js';
import { createFxStage } from './postShader.js';

// scene.environmentIntensity; 0 disables IBL. game.js start() derives exposureBase
// from it. Kept low so it reflects in clearcoat/sheen without lifting the shadows.
export const ENV_INTENSITY = 0.38;

// How strongly the AO term darkens the lit frame (the old GTAOPass blendIntensity).
const AO_BLEND = 0.85;
// Rack focus: the engine drives `maxblur` on the scale the old BokehPass used (0.012 at full
// strength); the DoF node wants a unitless bokeh size and a sharp band in world metres.
const DOF_PEAK = 0.012;
const DOF_BOKEH = 2.4;
const DOF_BAND = 2.2;

class SceneSetupMethods {
  // Build (or rebuild) the post chain: MSAA scene pass, GTAO, bloom, afterimage, rack focus, CA/vignette.
  _buildComposer(w, h) {
    this._disposeComposer();

    const q = Quality.settings();
    // _applyQuality rebuilds only when one of these changes: each is baked into the graph
    // (a render-target property, or a stage that is present or absent).
    this._composerKey = composerKey(q);

    // The scene renders into a HalfFloat target with no tone mapping; the pipeline's output
    // transform applies renderer.toneMapping at the very end, so the chain is linear HDR.
    // MSAA lives on this pass, tiered 4 → 2 → 0. The AO stage reads the pass's depth, and a
    // multisampled depth texture cannot be sampled the way it needs on WebGPU, so with AO on
    // the pass renders single-sample and FXAA cleans the edges at the end instead.
    const useFxaa = !!q.gtao;
    const scenePass = pass(this.scene, this.camera, { samples: useFxaa ? 0 : q.msaaSamples });
    // The pass only gives its target these on its first render. The warm-up compiles the
    // scene against that target BEFORE then (game.js _warmupRender), and a target that later
    // changes sample count or type is a different render context: every material would be
    // built a second time, synchronously, on the first real frame.
    scenePass.renderTarget.samples = useFxaa ? 0 : q.msaaSamples;
    scenePass.renderTarget.texture.type = this.renderer.getOutputBufferType?.() ?? THREE.HalfFloatType;
    const sceneTex = scenePass.getTextureNode('output');

    // GTAO is by far the most expensive stage; 'high' tier only, at half resolution.
    let lit = sceneTex;
    let aoNode = null;
    if (q.gtao) {
      try {
        aoNode = ao(scenePass.getTextureNode('depth'), null, this.camera);
        aoNode.resolutionScale = 0.5;
        aoNode.samples.value = q.gtaoSamples;
        const occlusion = mix(1, aoNode.getTextureNode().r, AO_BLEND);
        lit = vec4(sceneTex.rgb.mul(occlusion), sceneTex.a);
      } catch { aoNode = null; lit = sceneTex; /* AO is a nicety — never block the game on it */ }
    }
    this.gtaoPass = { enabled: !!aoNode, node: aoNode };

    let bloomNode = null;
    if (q.bloom) {
      bloomNode = bloom(lit, 0.32, 0.55, 0.8);
      lit = lit.add(bloomNode);
    }
    // A stand-in keeps the engine's per-frame `bloomPass.strength` writes valid on the low tier.
    const strength = bloomNode ? bloomNode.strength : { value: 0.32 };
    this.bloomPass = {
      enabled: !!bloomNode,
      node: bloomNode,
      get strength() { return strength.value; },
      set strength(v) { strength.value = v; },
    };

    // Everything after this samples the lit frame as a texture.
    const base = convertToTexture(lit);

    // The two transient stages. Each is built once and joins the graph only while it is
    // switched on: a stage that is merely idle would still cost its full-screen draws
    // every frame, and the rack focus alone is several.
    const damp = uniform(0);
    let smear = null;
    // The smear's result texture is tied to its node, so sampling it runs the stage.
    const smearTex = () => (smear || (smear = afterImage(base, damp))).getTextureNode();
    const focus = uniform(40), bokeh = uniform(0);
    const viewZ = scenePass.getViewZNode();
    const fx = createFxStage();
    const outputs = new Map();
    const variant = (withSmear, withFocus) => {
      const key = (withSmear ? 1 : 0) | (withFocus ? 2 : 0);
      let node = outputs.get(key);
      if (!node) {
        let tex = withSmear ? smearTex() : base;
        // The DoF node has to be in the graph itself to run: its own result texture is a plain
        // texture, so reading only that leaves the stage un-updated and the frame blank.
        if (withFocus) tex = convertToTexture(dof(tex, viewZ, focus, DOF_BAND, bokeh));
        node = fx.build(tex);
        // FXAA works on the display-referred frame, so the output transform moves in front of it.
        if (useFxaa) node = fxaa(renderOutput(node));
        outputs.set(key, node);
      }
      return node;
    };

    const pipeline = new THREE.RenderPipeline(this.renderer);
    pipeline.outputColorTransform = !useFxaa;
    const state = { smear: false, focus: false, live: -1 };
    const apply = () => {
      const key = (state.smear ? 1 : 0) | (state.focus ? 2 : 0);
      if (key === state.live) return;
      state.live = key;
      pipeline.outputNode = variant(state.smear, state.focus);
      pipeline.needsUpdate = true;
    };
    apply();

    // Frame-feedback smear for dashes/launches/super: one quad instead of ghost rig
    // copies. After bloom so the trail carries the glow. Off (free) until needed.
    this.afterimage = {
      uniforms: { damp },
      get enabled() { return state.smear; },
      set enabled(v) { state.smear = !!v; apply(); },
    };
    // KO-only DoF. After bloom, so highlights defocus like a real lens.
    this.rackFocus = createRackFocus({
      get enabled() { return state.focus; },
      set enabled(v) { state.focus = !!v; apply(); },
    });
    const rack = this.rackFocus.pass.uniforms;
    this.fxPass = { uniforms: fx.uniforms };

    this.composer = {
      pipeline,
      scenePass,
      // What RenderPass used to draw into: the warm-up compiles the scene against it.
      get readBuffer() { return scenePass.renderTarget; },
      render: () => {
        fx.sync();
        focus.value = rack.focus.value;
        bokeh.value = (rack.maxblur.value / DOF_PEAK) * DOF_BOKEH;
        pipeline.render();
      },
      // The pass and every stage target follow the renderer's drawing-buffer size on their own.
      setSize() {},
      setPixelRatio() {},
      dispose: () => {
        try { aoNode?.dispose?.(); } catch { /* already gone */ }
        try { bloomNode?.dispose?.(); } catch { /* already gone */ }
        try { smear?.dispose?.(); } catch { /* already gone */ }
        try { scenePass.dispose?.(); } catch { /* already gone */ }
        try { pipeline.dispose(); } catch { /* already gone */ }
      },
    };
    // Size the camera aspect with the renderer from now on.
    bindView(this.stage, { camera: this.camera, composer: this.composer });
  }

  _disposeComposer() {
    if (this.composer) this.composer.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.fxPass = null;
    this.afterimage = null;
    this.rackFocus = null;
    this.gtaoPass = null;
  }

  /**
   * Re-apply the quality tier to the live renderer. `liveOnly` (a tier change
   * mid-match) applies just the pixel ratio and marks the rest dirty: rebuilding
   * the post graph or flipping a shadow caster compiles shaders, a 0.3-2 s freeze
   * in a fight. resetMatch applies the rest ahead of its warm-up.
   */
  _applyQuality(liveOnly = false) {
    const q = Quality.settings();
    const cw = this.container.clientWidth || 800;
    const ch = this.container.clientHeight || 540;

    // The stage owns the pixel ratio; only its tier ceiling moves here.
    setMaxDpr(this.stage, q.maxDpr);

    if (liveOnly) { this._qualityDirty = true; return; }
    this._qualityDirty = false;

    // MSAA samples, GTAO and bloom are all part of the graph: a change to any is a rebuild,
    // carrying the live uniform values across.
    if (this.composer && this._composerKey !== composerKey(q)) {
      const kept = this.fxPass?.uniforms;
      this._buildComposer(cw, ch);
      if (kept) for (const key in kept) this.fxPass.uniforms[key].value = kept[key].value;
    }

    const L = this.arena?.lights;
    if (L) {
      this._setShadowSize(L.key, q.keyShadow);
      // spotShadow 0 = stop casting entirely (drops a whole shadow pass).
      if (q.spotShadow > 0) {
        L.spot.castShadow = true;
        this._setShadowSize(L.spot, q.spotShadow);
      } else if (L.spot.castShadow) {
        // The map is kept: disposing it under a frame already queued is a GPU validation
        // error, and it is one small depth texture.
        L.spot.castShadow = false;
      }
    }
  }

  /**
   * Set one light's shadow-map size. Only before its map exists (boot): on this renderer a
   * live map cannot be resized safely. Resizing in place leaves bindings on the destroyed
   * texture, which blanks every frame until the next change, and disposing the map makes
   * the renderer rebuild a shadow material for every caster, a two-second freeze. A session
   * keeps the shadow resolution of the tier it booted on; it is one depth texture.
   */
  _setShadowSize(light, size) {
    if (!light || light.shadow.map || light.shadow.mapSize.width === size) return;
    light.shadow.mapSize.set(size, size);
  }

  // IBL from a painted 512×256 equirect caricature of the arena —
  // cheaper than a live cubemap, which would need re-rendering every round.
  _buildEnvironment() {
    if (ENV_INTENSITY <= 0) return;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');

    // v=0 is +Y (up) in three's equirect convention, v=1 is −Y (down).
    const sky = g.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0.00, '#39406e');   // ceiling / truss haze
    sky.addColorStop(0.42, '#161a2e');   // the dark upper hall
    sky.addColorStop(0.58, '#121526');   // horizon — darkest band
    sky.addColorStop(1.00, '#3d4680');   // ring canvas bounce (matches arena.js)
    g.fillStyle = sky;
    g.fillRect(0, 0, 512, 256);

    // Overhead house light: the highlight clearcoat lobes actually show.
    const pool = g.createRadialGradient(256, 26, 4, 256, 26, 120);
    pool.addColorStop(0, 'rgba(255, 246, 222, 1)');
    pool.addColorStop(0.35, 'rgba(255, 232, 186, 0.5)');
    pool.addColorStop(1, 'rgba(255, 232, 186, 0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, 512, 160);

    // Truss lenses: a moving fighter catches a sequence of highlights.
    const lens = ['#fff2d0', '#bcd0ff', '#fff2d0', '#ffd0d0'];
    for (let i = 0; i < 8; i++) {
      const x = 32 + i * 64;
      const lg = g.createRadialGradient(x, 58, 2, x, 58, 34);
      lg.addColorStop(0, lens[i % lens.length]);
      lg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.5;
      g.fillStyle = lg;
      g.fillRect(x - 34, 24, 68, 68);
    }
    g.globalAlpha = 1;

    // Red/blue corner lights 180° apart: opposing warm/cool rims.
    for (const [x, col] of [[96, 'rgba(255, 92, 92, 0.55)'], [352, 'rgba(96, 140, 255, 0.55)']]) {
      const cg = g.createRadialGradient(x, 148, 3, x, 148, 90);
      cg.addColorStop(0, col);
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = cg;
      g.fillRect(x - 90, 58, 180, 180);
    }

    // Crowd band: breaks up the horizon in reflections.
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 512;
      const y = 132 + Math.random() * 34;
      g.fillStyle = `rgba(${120 + Math.random() * 60 | 0}, ${130 + Math.random() * 60 | 0}, 190, ${0.05 + Math.random() * 0.13})`;
      g.fillRect(x, y, 3 + Math.random() * 5, 2 + Math.random() * 3);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    // The renderer prefilters an equirect environment itself (its own PMREM), so the painted
    // canvas is handed over as it is. We own the texture; dispose() releases it.
    this._envTex = tex;
    this.scene.environment = tex;
    this.scene.environmentIntensity = ENV_INTENSITY;
  }

  // Anisotropic filtering for every scene texture (mainly the grazing-angle ring mat).
  _applyTextureAnisotropy() {
    const maxAniso = this.renderer.getMaxAnisotropy?.() ?? 1;
    if (!maxAniso || maxAniso <= 1) return;
    const aniso = Math.min(maxAniso, 8); // 8 is where the returns flatten
    const seen = new Set();
    const MAPS = ['map', 'roughnessMap', 'normalMap', 'bumpMap', 'aoMap',
                  'metalnessMap', 'emissiveMap', 'alphaMap'];
    this.scene.traverse((o) => {
      if (!o.isMesh && !o.isPoints) return;
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!mat) continue;
        for (const slot of MAPS) {
          const tex = mat[slot];
          if (!tex || seen.has(tex.uuid) || tex.anisotropy === aniso) continue;
          seen.add(tex.uuid);
          tex.anisotropy = aniso;
          tex.needsUpdate = true;
        }
      }
    });
  }
}

function composerKey(q) {
  return `${q.msaaSamples}|${q.gtao ? q.gtaoSamples : 0}|${q.bloom ? 1 : 0}`;
}

/**
 * The KO rack focus: off during play, ramped in for a moment on a KO. `pass.enabled` puts the
 * DoF stage in the graph and takes it out again; `pass.uniforms` are the two values the engine
 * steers (focus distance in world units, blur on the old BokehPass scale).
 */
function createRackFocus(pass) {
  pass.uniforms = { focus: { value: 40 }, maxblur: { value: 0 } };
  let hold = 0;        // seconds left at full blur
  let level = 0;       // current 0..1
  let target = 0;
  let peak = DOF_PEAK; // maxblur at level 1

  /** Rack the focus onto a point `focusDistance` away, hold `holdSec`, then ease back out. */
  function trigger(focusDistance, holdSec, strength) {
    // Skipped below the top tier: a machine already dropping frames does not need extra
    // full-screen draws at the most dramatic moment of the match.
    if (!allowHeavy()) return;
    pass.uniforms.focus.value = focusDistance == null ? 40 : focusDistance;
    peak = DOF_PEAK * (strength == null ? 1 : Math.max(0, Math.min(1.5, strength)));
    hold = holdSec == null ? 0.9 : holdSec;
    target = 1;
    pass.enabled = true;
  }

  /** Call every frame with the frame delta in seconds. */
  function update(dt) {
    if (!pass.enabled) return;
    if (hold > 0) {
      hold -= dt;
      if (hold <= 0) target = 0;
    }
    // Ease in fast, out slow: a slow fade IN would arrive after the moment it reacts to.
    const k = target > level ? 9 : 2.2;
    level += (target - level) * (1 - Math.exp(-k * dt));
    pass.uniforms.maxblur.value = level * peak;
    if (target === 0 && level < 0.01) {
      level = 0;
      pass.uniforms.maxblur.value = 0;
      pass.enabled = false;
    }
  }

  return { pass, trigger, update, setSize() {}, dispose() {} };
}

export const SceneSetup = SceneSetupMethods.prototype;
