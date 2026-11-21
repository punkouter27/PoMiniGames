// quality.js — renderer creation and the one place that decides how much GPU work the
// arena is allowed to spend.
//
// Two jobs:
//   1. createRenderer() — WebGPU first, WebGL2 fallback. WebGPU is opt-in per the notes
//      on WEBGPU_STATUS below; the fallback is the shipping default and both return the
//      same { renderer, api } shape so nothing downstream branches on it.
//   2. resolveQuality() — a tier (low/medium/high/ultra) that gates every expensive
//      feature added in the polish pass. Callers read booleans off the returned object;
//      they never sniff the GPU themselves, so one edit here retunes the whole game.
//
// The tier can be forced with ?gfx=low|medium|high|ultra on the page URL, which is how
// you A/B a pass without editing code. Hardware only sets the initial auto ceiling;
// sustained visible frame times then lower rendering and decorative chip budgets.
// Structural debris, scoring, masses and the physics timestep remain unchanged.

import { loadSettings } from './settings.js';
import { createRenderer as createSharedRenderer } from '../platform/3d/renderer.js';

const TIERS = ['low', 'medium', 'high', 'ultra'];

// Backend status. The game renders with three r186's WebGPURenderer ('three-eco/webgpu'), whose
// own fallback is a WebGL2 backend running the SAME node graphs (TSL materials + the post
// pipeline in post.js), so "WebGPU or not" is a backend choice and not a second renderer. The
// r165 situation this used to document (a WebGL-only EffectComposer chain and a raw-GLSL sky,
// so a WebGPU context rendered a downgraded picture) is gone with the port.
//   ?gpu=webgl  forces the WebGL2 backend (A/B, or a driver whose WebGPU misbehaves)
export const WEBGPU_STATUS = ({
  supported: typeof navigator !== 'undefined' && 'gpu' in navigator,
  usable: false,     // set true by createRenderer when a real WebGPU backend came up
  reason: '',
});

function urlFlag(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function detectChoice() {
  const forced = (urlFlag('gfx') || '').toLowerCase();
  if (TIERS.includes(forced)) return { tier: forced, auto: false };
  // The player's own choice (pause dialog → Graphics) beats the guess below.
  const chosen = loadSettings().gfx;
  if (TIERS.includes(chosen)) return { tier: chosen, auto: false };

  const device = typeof navigator === 'undefined' ? {} : navigator;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent || '');
  if (mobile) return { tier: 'low', auto: true };

  const cores = device.hardwareConcurrency || 4;
  const memory = device.deviceMemory || 4; // GB, Chromium-only; undefined elsewhere
  // CPU threads and RAM do not identify a discrete GPU. Ultra must be opt-in.
  return { tier: cores <= 4 || memory <= 4 ? 'medium' : 'high', auto: true };
}

export function detectTier() {
  return detectChoice().tier;
}

/**
 * Feature switches per tier. Everything the polish pass added is listed here, so the
 * cost of a tier is readable in one screen instead of scattered across five modules.
 */
export function resolveQuality(tier) {
  const choice = tier === undefined ? detectChoice() : { tier, auto: false };
  tier = choice.tier;
  const at = (min) => TIERS.indexOf(tier) >= TIERS.indexOf(min);
  // <html data-motion> is the OS preference OR the player's own switch in the settings sheet.
  const reducedMotion = document.documentElement.dataset.motion === 'reduce'
    || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return {
    tier,
    renderTier: tier,
    auto: choice.auto,
    // Auto cannot infer GPU fill rate from a high-density screen either.
    pixelRatioCap: choice.auto ? 1 : 2,
    reducedMotion,
    // Post chain
    bloom: !choice.auto || tier !== 'low',
    smaa: at('medium'),             // edge shimmer is worst at high voxel density
    ssao: at('medium'),
    ssaoHalfRes: !at('ultra'),      // AO at half resolution below ultra
    temporalAo: at('medium'),       // temporal reprojection smoothing of AO (#7)
    godRays: at('high'),
    contactShadows: at('medium'),   // screen-space contact shadows (#5)
    farShadows: at('high'),         // coarse outer shadow cascade for distant fortress (#5)
    heatHaze: at('medium') && !reducedMotion, // screen-space refractive heat haze (#2)
    wetReflections: at('high'),     // screen-space wet puddle reflections (#6)
    motionBlur: at('medium') && !reducedMotion, // per-pixel velocity motion blur (#8)
    lensEffects: at('medium'),      // chromatic aberration, anamorphic flare, film grain (#10)
    // Scene
    pbr: at('medium'),              // MeshStandardMaterial + env map vs MeshLambert
    envMap: at('high'),
    shadowMapSize: at('ultra') ? 4096 : at('high') ? 2048 : 1024,
    shadows: !choice.auto || tier !== 'low',
    timeOfDay: true,                // pure uniform updates; free at every tier
    // Renders fewer pixels when frames run long, then hands them back when they do not.
    // Only an explicit ultra choice trades frame rate for the full picture.
    dynamicResolution: choice.auto || !at('ultra'),
    // Content
    particles: at('low') ? (at('high') ? 4000 : 1200) : 0,
    softSmoke: at('medium'),        // depth-fade + sunlit forward scattering on smoke (#3)
    fireball: at('low'),            // volumetric FBM fireball (#1)
    sparks: at('medium') ? (at('high') ? 320 : 140) : 0, // velocity-stretched sparks & dust skirt (#9)
    decals: at('medium') ? (at('ultra') ? 120 : 48) : 0,
    // Simulated voxels in flight. These are real rigid bodies, so this is the single
    // most CPU-expensive setting in the file: every one of them is a broadphase entry
    // and a contact solve. Low tier keeps the old vanish-with-a-puff behaviour.
    // MEASURED against the physics step, not guessed. Every one of these is a rigid body
    // in cannon, and cannon costs roughly 0.15 ms per dynamic body per step in JS: 180 of
    // them measured 28 ms of an 81 ms step, on their own. These counts keep the effect —
    // stone visibly leaving the wall — at a price the simulation can pay.
    shrapnel: at('medium') ? (choice.auto ? 48 : at('ultra') ? 140 : at('high') ? 90 : 48) : 0,
    // Fragment/vertex-shader work with no CPU cost per frame.
    hotCarve: at('medium'),          // glowing rim on fresh cuts (materials.js)
    rainDrops: at('high') ? 1600 : at('medium') ? 800 : 0,
    // Audio (cost is CPU on the audio thread, not GPU, but it tiers the same way)
    spatialAudio: true,
    convolutionReverb: at('medium'),
    audioOcclusion: at('medium'),
    earlyReflections: at('high'),
    rubbleTicks: at('medium'),
  };
}

/** Demotion keeps structural bodies/materials intact; chips are sampled visual effects. */
export function applyRenderTier(quality, tier) {
  const next = resolveQuality(tier);
  for (const key of [
    'ssao', 'ssaoHalfRes', 'temporalAo', 'godRays', 'smaa', 'shadowMapSize',
    'contactShadows', 'farShadows', 'heatHaze', 'wetReflections', 'motionBlur',
    'lensEffects', 'softSmoke', 'fireball', 'sparks',
    'audioOcclusion', 'earlyReflections', 'rubbleTicks',
  ]) {
    quality[key] = next[key];
  }
  quality.renderTier = tier;
  quality.bloom = tier !== 'low';
  quality.shadows = tier !== 'low';
  if (quality.auto) quality.shrapnel = tier === 'low' ? 0 : tier === 'medium' ? 24 : 48;
}

/**
 * Visible rAF intervals, not clamped simulation dt. One-way auto demotion prevents
 * quality flapping; resolution can recover inside the current render tier.
 */
export class AdaptiveQuality {
  constructor(quality) {
    this.auto = quality.auto;
    this.tier = quality.renderTier;
    this.scale = 1;
    this.reset();
  }

  reset() {
    this.elapsed = 0;
    this.frames = 0;
    this.slowTime = 0;
    this.warmup = 1;
  }

  update(dt, visible = true) {
    // Tab suspension/stale initial timestamps are not evidence of rendering cost.
    if (!visible || !Number.isFinite(dt) || dt <= 0 || dt > 0.5) {
      this.reset();
      return null;
    }
    if (this.warmup > 0) {
      this.warmup -= dt;
      return null;
    }
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < 0.5) return null;

    const average = this.elapsed / this.frames;
    const oldScale = this.scale;
    const oldTier = this.tier;
    if (average > 1 / 60 * 1.35) this.scale = Math.max(0.6, this.scale - 0.1);
    else if (average < 1 / 60 * 1.05) this.scale = Math.min(1, this.scale + 0.05);
    this.slowTime = this.auto && this.scale <= 0.600001 && average > 1 / 30
      ? this.slowTime + this.elapsed : 0;
    if (this.slowTime >= 2 && this.tier !== 'low') {
      this.tier = TIERS[Math.max(0, TIERS.indexOf(this.tier) - 1)];
      this.slowTime = 0;
    }
    this.elapsed = 0;
    this.frames = 0;
    return this.scale !== oldScale || this.tier !== oldTier
      ? { scale: this.scale, tier: this.tier } : null;
  }
}

/**
 * Build the renderer through the shared factory. Returns { renderer, api: 'webgpu' | 'webgl2' }.
 * WebGPU is the default where the browser has it; otherwise (or with ?gpu=webgl, or if the
 * adapter request fails) the same WebGPURenderer runs on its WebGL2 backend.
 * `look` is the shared factory's tone / exposure / shadows / pixelRatio.
 */
export async function createRenderer(THREE, { antialias = true, ...look } = {}) {
  // The canvas itself is never the multisampled target: the scene is drawn by the post
  // pipeline's pass (which owns its own sample count), so canvas MSAA would be wasted fill.
  // 'default' is a legacy WebGL value; it is not a GPUPowerPreference, so requestAdapter() threw and the renderer
  // silently fell back to the WebGL2 backend even on a WebGPU machine.
  const base = { antialias: false, powerPreference: 'high-performance', ...look };
  void antialias;
  const flag = (urlFlag('gpu') || '').toLowerCase();
  let forceWebGL = flag === 'webgl' || !WEBGPU_STATUS.supported;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const renderer = await createSharedRenderer(THREE, { ...base, api: 'webgpu', forceWebGL });
      const gpu = !!renderer.backend?.isWebGPUBackend;
      WEBGPU_STATUS.usable = gpu;
      WEBGPU_STATUS.reason = gpu ? '' : (forceWebGL ? 'WebGL2 backend requested or WebGPU absent' : 'WebGPU adapter unavailable');
      return { renderer, api: gpu ? 'webgpu' : 'webgl2' };
    } catch (e) {
      if (forceWebGL) throw e;
      console.warn('[povoxelstrike/quality] WebGPU backend failed, retrying on WebGL2:', e);
      forceWebGL = true;
    }
  }
  throw new Error('renderer unavailable');
}
