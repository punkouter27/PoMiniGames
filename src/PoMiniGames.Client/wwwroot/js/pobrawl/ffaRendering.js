// Lightweight FFA rendering polish without changing the existing 1v1 renderer.
import * as THREE from 'three';
import * as Quality from './quality.js';
import { createFfaPost } from './ffaPost.js';
import { createFfaVisuals, visualPolicy } from './ffaVisuals.js';

const states = new WeakMap();
const DPR_FLOOR = 0.65;
const PIXEL_BUDGET = 2_000_000;
let activeState = null;

function dimensions(renderer) {
  const canvas = renderer.domElement;
  const parent = canvas?.parentElement;
  return {
    width: Math.max(1, parent?.clientWidth || canvas?.clientWidth || 800),
    height: Math.max(1, parent?.clientHeight || canvas?.clientHeight || 540),
  };
}

function targetPixelRatio(width, height, scale = 1) {
  let base = Math.min(globalThis.devicePixelRatio || 1, 1.75);
  try { base = Math.min(Quality.pixelRatio(width, height), 1.75); } catch { /* use browser DPR */ }
  const budgetCap = Math.sqrt(PIXEL_BUDGET / (width * height));
  return Math.max(DPR_FLOOR, Math.min(base, budgetCap) * scale);
}

function physicalMaterialsEnabled() {
  try { return Quality.settings().physicalMaterials !== false; }
  catch { return true; }
}

function currentTier() {
  try { return Quality.tier(); } catch { return 'high'; }
}

function applySize(state) {
  const dpr = targetPixelRatio(state.width, state.height, state.scale);
  state.renderer.setPixelRatio(dpr);
  state.renderer.setSize(state.width, state.height, false);
  state.post?.resize(state.width, state.height, dpr);
}

function makeEnvironment(renderer) {
  if (!globalThis.document?.createElement || !THREE.PMREMGenerator) return null;
  let canvas;
  let texture;
  let pmrem;
  let target;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const sky = context.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, '#111936');
    sky.addColorStop(0.48, '#59617e');
    sky.addColorStop(0.5, '#d7b98a');
    sky.addColorStop(1, '#282944');
    context.fillStyle = sky;
    context.fillRect(0, 0, 512, 256);
    for (const [x, color, width] of [[115, '#ffe4ae', 74], [380, '#a9bdff', 62]]) {
      const glow = context.createRadialGradient(x, 112, 3, x, 112, width);
      glow.addColorStop(0, color);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = glow;
      context.fillRect(x - width, 112 - width, width * 2, width * 2);
    }
    texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader?.();
    target = pmrem.fromEquirectangular(texture);
    return { texture, target, pmrem, environment: target.texture };
  } catch {
    target?.dispose?.();
    texture?.dispose?.();
    pmrem?.dispose?.();
    return null;
  } finally {
    if (canvas) canvas.width = canvas.height = 1;
  }
}

export function fighterBuildOptions(physicalMaterials = physicalMaterialsEnabled()) {
  return { physicalMaterials: physicalMaterials !== false };
}

export function setup(scene, renderer, arena) {
  if (!scene || !renderer) throw new TypeError('FFA rendering needs a scene and renderer.');
  if (states.has(scene)) dispose(scene);

  const original = {
    pixelRatio: renderer.getPixelRatio?.() || 1,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
    shadowEnabled: renderer.shadowMap?.enabled,
    shadowType: renderer.shadowMap?.type,
    environment: scene.environment,
    environmentIntensity: scene.environmentIntensity,
  };
  const { width, height } = dimensions(renderer);
  const dpr = targetPixelRatio(width, height);
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  if (THREE.SRGBColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (THREE.AgXToneMapping !== undefined) renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = Math.max(1, renderer.toneMappingExposure || 1);
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    if (THREE.PCFSoftShadowMap !== undefined) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  const lights = arena?.lights || {};
  const originalLights = [lights.key, lights.spot].filter(Boolean).map((light) => ({
    light,
    castShadow: light.castShadow,
    mapSize: light.shadow?.mapSize ? { x: light.shadow.mapSize.x, y: light.shadow.mapSize.y } : null,
  }));
  const tier = currentTier();
  if (lights.key) lights.key.castShadow = true;
  if (lights.spot) lights.spot.castShadow = tier === 'high';
  if (lights.key?.shadow?.mapSize?.set) {
    const size = tier === 'low' ? 512 : tier === 'high' && dpr >= 1.35 ? 2048 : 1024;
    lights.key.shadow.mapSize.set(size, size);
    lights.key.shadow.map?.dispose?.();
    lights.key.shadow.map = null;
  }
  if (lights.spot?.shadow?.mapSize?.set) {
    lights.spot.shadow.mapSize.set(1024, 1024);
    lights.spot.shadow.map?.dispose?.();
    lights.spot.shadow.map = null;
  }

  const environment = scene.environment ? null : makeEnvironment(renderer);
  if (environment) {
    scene.environment = environment.environment;
    scene.environmentIntensity = 0.32;
  }
  const state = {
    renderer, original, originalLights, environment, lights,
    baseDpr: dpr, scale: 1, elapsed: 0, averageFrameMs: 16.7,
    width, height, disposed: false, tier, slow: false, policy: null, post: null, visuals: null,
  };
  states.set(scene, state);
  activeState = state;
  // Headless callers retain the direct renderer contract; real WebGL hosts own
  // the full chain. Do not silently swallow shader/target failures in production.
  if (renderer.isWebGLRenderer) {
    try {
      state.policy = visualPolicy(tier);
      state.visuals = createFfaVisuals(scene, arena, state.policy);
      state.post = createFfaPost(scene, renderer, state.policy);
      state.post.resize(width, height, dpr);
    } catch (error) {
      dispose(scene);
      throw error;
    }
  }
  return {
    fighterBuildOptions: fighterBuildOptions(physicalMaterialsEnabled()),
    resize: (nextWidth, nextHeight) => {
      if (state.disposed) return;
      state.width = Math.max(1, nextWidth || 1); state.height = Math.max(1, nextHeight || 1);
      applySize(state);
    },
    render: (camera, dt) => render(scene, camera, dt),
    registerFighters: (fighters) => state.visuals?.registerFighters(fighters),
    impact: (event) => state.visuals?.impact(event),
    resetRound: () => state.visuals?.resetRound(),
    setReducedMotion: (value) => state.visuals?.setReducedMotion(value),
    get state() {
      return {
        tier: state.tier, slow: state.slow, averageFrameMs: state.averageFrameMs,
        dpr: renderer.getPixelRatio?.() || 1, disposed: state.disposed,
        post: state.post?.state || null, visuals: state.visuals?.state || null,
      };
    },
    dispose: () => dispose(scene),
  };
}

export function resize(width, height) {
  const state = activeState;
  if (!state || state.disposed) return;
  state.width = Math.max(1, width || 1);
  state.height = Math.max(1, height || 1);
  applySize(state);
}

export function render(scene, camera, dt = 0) {
  const state = states.get(scene);
  if (!state || state.disposed) return;
  const { renderer } = state;
  const size = dimensions(renderer);
  if (size.width !== state.width || size.height !== state.height) {
    state.width = size.width;
    state.height = size.height;
    applySize(state);
    if (camera) {
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix?.();
    }
  }

  if (dt > 0) {
    const frameMs = Math.min(dt * 1000, 100);
    state.averageFrameMs += (frameMs - state.averageFrameMs) * 0.08;
    state.elapsed += dt;
    if (state.elapsed >= 1) {
      state.elapsed %= 1;
      if (state.averageFrameMs > 22) state.scale = Math.max(0.68, state.scale - 0.08);
      else if (state.averageFrameMs < 15) state.scale = Math.min(1, state.scale + 0.04);
      const nextTier = currentTier();
      // Hysteresis prevents toggling targets/passes around the frame-time boundary.
      const slow = state.averageFrameMs > 25 ? true : state.averageFrameMs < 18 ? false : state.slow;
      if (state.policy && (nextTier !== state.tier || slow !== state.slow)) {
        state.tier = nextTier; state.slow = slow;
        state.policy = visualPolicy(nextTier, slow);
        state.visuals.configure(state.policy); state.post.configure(state.policy);
        if (state.lights.spot) state.lights.spot.castShadow = nextTier === 'high' && !slow;
        const key = state.lights.key;
        const shadowSize = nextTier === 'low' || slow ? 512 : nextTier === 'medium' ? 1024 : 2048;
        if (key?.shadow?.mapSize?.set && key.shadow.mapSize.x !== shadowSize) {
          key.shadow.mapSize.set(shadowSize, shadowSize);
          key.shadow.map?.dispose?.(); key.shadow.map = null; key.shadow.needsUpdate = true;
        }
        applySize(state);
      }
      const dpr = targetPixelRatio(state.width, state.height, state.scale);
      if (Math.abs((renderer.getPixelRatio?.() || 1) - dpr) > 0.02) {
        applySize(state);
      }
    }
  }
  state.visuals?.update(dt);
  if (state.post) state.post.render(camera, dt, state.visuals.pulse, state.visuals.point);
  else renderer.render(scene, camera);
}

export function dispose(scene) {
  const state = states.get(scene);
  if (!state) return;
  state.disposed = true;
  state.post?.dispose(); state.visuals?.dispose();
  if (state.environment) {
    if (scene.environment === state.environment.environment) {
      scene.environment = state.original.environment;
      scene.environmentIntensity = state.original.environmentIntensity;
    }
    state.environment.target.dispose?.();
    state.environment.texture.dispose?.();
    state.environment.pmrem.dispose?.();
  }
  for (const saved of state.originalLights) {
    saved.light.castShadow = saved.castShadow;
    if (saved.mapSize && saved.light.shadow?.mapSize?.set) {
      saved.light.shadow.map?.dispose?.(); saved.light.shadow.map = null;
      saved.light.shadow.mapSize.set(saved.mapSize.x, saved.mapSize.y);
      saved.light.shadow.needsUpdate = true;
    }
  }
  const { renderer, original } = state;
  renderer.setPixelRatio?.(original.pixelRatio);
  renderer.toneMapping = original.toneMapping;
  renderer.toneMappingExposure = original.toneMappingExposure;
  renderer.outputColorSpace = original.outputColorSpace;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = original.shadowEnabled;
    renderer.shadowMap.type = original.shadowType;
  }
  states.delete(scene);
  if (activeState === state) activeState = null;
}
