// vfx.js — screen feel and scene polish for PoVoxelStrike.
//
// Render path (three r186, WebGPURenderer with its WebGL2 backend as the fallback). The scene
// is rendered ONCE by a pass node (HDR colour + depth); every screen-space effect after that
// reads depth instead of re-rendering geometry, because the arena carries ~2.2 M triangles and
// a second geometry pass costs more than any one effect is worth. The chain itself is post.js
// (one TSL node graph: GTAO, a combine node that folds the screen-feel effects together,
// bloom, tone map, FXAA); this file owns the state that feeds it.
//
//   scene ─▶ pass(scene, camera) ─▶ post.js graph ─▶ screen
//
// Everything in the graph is gated by the quality tier (see quality.js), and the whole chain
// is best-effort: a pipeline failure falls back to a plain renderer.render() rather than
// killing the game, which is how it shipped and how the software-rendered CI browser still
// gets a picture.
//
// Also here: trauma screen shake, damage vignette, pooled muzzle light, shockwave rings,
// the gradient sky dome, and the time-of-day driver that moves the sun and repaints the
// sky, fog and shaft colour together.
//
// prefers-reduced-motion turns off shake and the damage flash (the two effects that move
// or strobe the whole viewport); the static passes stay.

import * as THREE from 'three-eco/webgpu';
import {
  dot, float, max, pow, positionWorld, uniform, vec3,
} from 'three-eco/tsl';
import { getWetness } from './materials.js';
import { createPost, createPostUniforms } from './post.js';
import { FireballPool } from './fireball.js';
import { SparkSystem } from './sparks.js';

const SHOCK_LIFE_S = 0.45;

// One in-game day. Short enough that a single run sees the light move, long enough that
// it never reads as a strobe. Phase 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
const DAY_LENGTH_S = 360;
// Start in bright morning, not at dusk. The fortress interior is the whole point of the
// game and a dusk start left the vault, the wards and every breach in near-darkness.
const START_PHASE = 0.34;

// Key colours per phase, interpolated by dayPhase. Kept as one table so the sky, the fog,
// the sun and the shafts can never drift out of agreement.
// `hemi` and `amb` are the two that matter indoors: neither is shadowed, so together they
// are the only light that reaches a vault with a roof on it. They were tuned for an
// outdoor arena and left every interior a grey silhouette.
//
// Night is deliberately NOT dark any more. This is a fortress you have to fight your way
// through; a realistic 0.15-intensity midnight made the objective invisible for a third
// of every cycle, so the night keys are lit like a full moon over snow rather than like
// actual night.
// Calibrated against actual frames, not by eye on the numbers: the first pass at these
// values (sun 3.8 / hemi 3.0 / exposure 1.45) blew the stone and the sky to white. Direct
// sun is back near its original level and the LIFT lives in `hemi` and `amb`, which is
// where it belongs — those are the two that are not shadowed, so they are what actually
// reaches an interior, and raising them brightens the vault without flaring the exterior.
const SKY_KEYS = [
  { p: 0.00, top: 0x141a30, horizon: 0x2a3350, sun: 0x8fa3cc, sunI: 0.90, hemi: 1.05, amb: 0.45 }, // midnight
  { p: 0.22, top: 0x2a3a60, horizon: 0x8a6270, sun: 0xffb277, sunI: 1.70, hemi: 1.35, amb: 0.48 }, // dawn
  { p: 0.35, top: 0x3f74b4, horizon: 0xa9c7e0, sun: 0xfff6ea, sunI: 2.50, hemi: 1.85, amb: 0.55 }, // morning
  { p: 0.50, top: 0x4a8ad4, horizon: 0xc2d9ee, sun: 0xfffdf6, sunI: 2.80, hemi: 2.05, amb: 0.60 }, // noon
  { p: 0.68, top: 0x3a63a0, horizon: 0xdcb083, sun: 0xffe4bb, sunI: 2.35, hemi: 1.75, amb: 0.55 }, // afternoon
  { p: 0.78, top: 0x263050, horizon: 0x6d7c9a, sun: 0xfff2df, sunI: 2.05, hemi: 1.50, amb: 0.50 }, // dusk
  { p: 0.88, top: 0x1a2140, horizon: 0x424c68, sun: 0xa9a0c0, sunI: 1.20, hemi: 1.20, amb: 0.48 }, // night falls
  { p: 1.00, top: 0x141a30, horizon: 0x2a3350, sun: 0x8fa3cc, sunI: 0.90, hemi: 1.05, amb: 0.45 }, // wraps
];

export class Vfx {
  constructor(renderer, scene, camera, host, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.host = host;
    this.q = quality;
    this.reducedMotion = quality.reducedMotion;

    this.trauma = 0;
    this.time = 0;
    this.dayPhase = START_PHASE;
    this.shocks = [];
    // Post-graph terms (see post.js). Targets are eased in update().
    this._heat = 0;
    this._dust = 0;
    this._desat = 0;
    this._desatTarget = 0;
    this._flash = 0;
    this._lowHp = 0;
    this._sprintBlur = 0;
    this._hasPrevViewProj = false;
    this._prevViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this.overcast = 0;   // 0..1 from weather.js: greys the sky and takes the edge off the sun
    this.sun = null; // set by attachSun()
    this.farSun = null;  // coarse outer shadow cascade directional light (#5)
    this._sunDir = new THREE.Vector3(0.4, 0.8, 0.25).normalize();
    this._sunDirView = new THREE.Vector3(0.4, 0.8, 0.25);
    this.onSmoke = null; // optional (point, radius) callback wired by Engine for fireball smoke

    // The post pipeline is best-effort: SwiftShader/odd drivers can refuse float targets, and
    // the game must render either way.
    this.post = null;
    this.pu = createPostUniforms();
    try {
      this.post = createPost(renderer, scene, camera, this.pu);
      this.syncQuality();
    } catch (e) {
      console.warn('[povoxelstrike/vfx] post-processing unavailable, rendering plain:', e);
      this.post = null;
    }

    // Damage vignette overlay (styled in PoVoxelStrikePage.razor.css via ::deep).
    this.hitOverlay = document.createElement('div');
    this.hitOverlay.className = 'pvs-hit';
    this.hitOverlay.style.opacity = '0';
    host.appendChild(this.hitOverlay);
    this._hitOpacity = 0;

    // Pooled muzzle light.
    this.muzzleLight = new THREE.PointLight(0xffc46b, 0, 14, 1.8);
    this.muzzleLight.visible = false;
    scene.add(this.muzzleLight);
    this._muzzleT = 0;

    this.shockGeometry = new THREE.RingGeometry(0.55, 1, 28);
    this.shockMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc27a, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    this.fireballs = new FireballPool(scene, (pt, rad) => this.onSmoke?.(pt, rad));
    this.sparkSystem = new SparkSystem(scene, this.q.sparks || 0);

    this._sunWorld = new THREE.Vector3();
    this._sunProjected = new THREE.Vector3();
    this._currViewProj = new THREE.Matrix4();
  }

  /** Hand the sun + hemisphere lights over so time-of-day can drive them. */
  attachSun(sun, hemi, ambient = null, farSun = null) {
    this.sun = sun;
    this.hemi = hemi;
    // Ambient is the interior fill. Hemisphere light alone leans strongly on the up
    // vector, so a voxel wall's vertical faces inside a roofed room got almost nothing.
    this.ambient = ambient;
    this.farSun = farSun;
    this._applyDayPhase();
  }

  /** Gradient sky dome; call once after the scene exists. Returns the dome mesh. */
  buildSky() {
    const geometry = new THREE.SphereGeometry(430, 24, 14);
    // Uniform nodes the time-of-day driver writes (see _applyDayPhase).
    const su = this.skyU = {
      top: uniform(new THREE.Color(0x151b2c)),
      horizon: uniform(new THREE.Color(0x46536e)),
      sunDir: uniform(new THREE.Vector3(0.4, 0.8, 0.25).normalize()),
      sunColor: uniform(new THREE.Color(0xfff2df)),
      sunIntensity: uniform(1),
    };
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const v = positionWorld.normalize();
    const h = v.y.clamp(0, 1);
    let c = su.horizon.mix(su.top, pow(h, 0.55));
    // Sun disc + broad glow. The disc has to actually exist in the sky for the shaft pass to
    // have anything to mask against — a light rig alone gives none.
    const d = max(0, dot(v, su.sunDir.normalize()));
    c = c.add(su.sunColor.mul(su.sunIntensity).mul(pow(d, 2200).mul(6).add(pow(d, 24).mul(0.35))));
    material.colorNode = c;
    this.sky = new THREE.Mesh(geometry, material);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.background = null; // the dome is the background now
    this._applyDayPhase();
    return this.sky;
  }

  // ── Time of day ──────────────────────────────────────────────────────────

  /** Set the day phase directly, 0..1 (0 = midnight, 0.5 = noon). */
  setDayPhase(phase) {
    this.dayPhase = ((phase % 1) + 1) % 1;
    this._applyDayPhase();
  }

  _sample(phase) {
    let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
    for (let i = 0; i < SKY_KEYS.length - 1; i++) {
      if (phase >= SKY_KEYS[i].p && phase <= SKY_KEYS[i + 1].p) {
        a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break;
      }
    }
    const t = b.p === a.p ? 0 : (phase - a.p) / (b.p - a.p);
    const k = {
      top: new THREE.Color(a.top).lerp(new THREE.Color(b.top), t),
      horizon: new THREE.Color(a.horizon).lerp(new THREE.Color(b.horizon), t),
      sun: new THREE.Color(a.sun).lerp(new THREE.Color(b.sun), t),
      sunI: a.sunI + (b.sunI - a.sunI) * t,
      hemi: a.hemi + (b.hemi - a.hemi) * t,
      amb: a.amb + (b.amb - a.amb) * t,
    };
    if (this.overcast > 0) {
      // Cloud cover: the sky greys toward its own luminance and the sun loses its edge.
      // The unshadowed fills (hemi, amb) keep most of their level — overcast light is
      // flat, not dark, and the vault still has to be readable in a storm.
      const o = this.overcast;
      const grey = new THREE.Color(0x66707f).multiplyScalar(0.35 + 0.65 * Math.min(1, k.sunI / 2.8));
      k.top.lerp(grey, o * 0.8);
      k.horizon.lerp(grey, o * 0.6);
      k.sunI *= 1 - 0.6 * o;
      k.hemi *= 1 - 0.12 * o;
    }
    return k;
  }

  _applyDayPhase() {
    const k = this._sample(this.dayPhase);
    // Sun arc: rises in +x, sets in −x, tilted on z so it never sits exactly overhead —
    // an overhead sun flattens every voxel face into the same shade.
    const ang = (this.dayPhase - 0.25) * Math.PI * 2;
    this._sunDir.set(Math.cos(ang), Math.sin(ang), 0.32).normalize();

    if (this.sun) {
      this.sun.position.copy(this._sunDir).multiplyScalar(140);
      this.sun.color.copy(k.sun);
      this.sun.intensity = k.sunI;
      this.sun.target.position.set(0, 0, 0);
      this.sun.target.updateMatrixWorld();
    }
    if (this.farSun) {
      this.farSun.position.copy(this._sunDir).multiplyScalar(220);
      this.farSun.color.copy(k.sun);
      this.farSun.intensity = this.q.farShadows && this.q.shadows ? k.sunI * 0.28 : 0;
      this.farSun.castShadow = !!(this.q.farShadows && this.q.shadows);
      this.farSun.target.position.set(0, 0, 0);
      this.farSun.target.updateMatrixWorld();
    }
    if (this.hemi) {
      this.hemi.intensity = k.hemi;
      this.hemi.color.copy(k.horizon).lerp(new THREE.Color(0xffffff), 0.55);
      this.hemi.groundColor.copy(k.horizon).multiplyScalar(0.45);
    }
    if (this.ambient) {
      this.ambient.intensity = k.amb;
      this.ambient.color.copy(k.horizon).lerp(new THREE.Color(0xffffff), 0.6);
    }
    if (this.skyU) {
      const u = this.skyU;
      u.top.value.copy(k.top);
      u.horizon.value.copy(k.horizon);
      u.sunDir.value.copy(this._sunDir);
      u.sunColor.value.copy(k.sun);
      u.sunIntensity.value = Math.max(0, k.sunI / 3);
    }
    if (this.scene.fog) this.scene.fog.color.copy(k.horizon);
    this.pu.sunColor.value.copy(k.sun);
    this.skyKey = k;
  }

  /** The pipeline's targets follow the renderer's drawing buffer; only history is reset here. */
  resize() {
    this._hasPrevViewProj = false;
  }

  /** Declare which post features exist at the current tier; post.js rebuilds on the next frame. */
  syncQuality() {
    const q = this.q;
    this.post?.configure({
      ao: !!q.ssao, aoHalfRes: !!q.ssaoHalfRes,
      shafts: !!q.godRays, contact: !!q.contactShadows,
      haze: !!q.heatHaze && !this.reducedMotion,
      wet: !!q.wetReflections,
      motion: !!q.motionBlur && !this.reducedMotion,
      lens: !!q.lensEffects,
      bloom: !!q.bloom, fxaa: !!q.smaa,
    });
    if (this.farSun) {
      this.farSun.castShadow = !!(q.farShadows && q.shadows);
      this.farSun.visible = !!(q.farShadows && q.shadows);
    }
  }

  /** Add shake trauma, 0..1 per event. Shake amplitude is trauma², so small events whisper. */
  addShake(amount) {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Red vignette pulse; intensity 0..1. */
  flashDamage(intensity) {
    if (this.reducedMotion) return;
    this._hitOpacity = Math.min(0.85, this._hitOpacity + intensity);
  }

  muzzleFlash(position) {
    this.muzzleLight.position.copy(position);
    this.muzzleLight.intensity = 55;
    this.muzzleLight.visible = true;
    this._muzzleT = 0.06;
  }

  shockwave(position) {
    const mesh = new THREE.Mesh(this.shockGeometry, this.shockMaterial.clone());
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.shocks.push({ mesh, life: SHOCK_LIFE_S, total: SHOCK_LIFE_S, grow: 14 });
    this.fireball(position, 4.5);
  }

  /** Spawn a volumetric FBM fireball + pooled blast light (#1). */
  fireball(position, radius = 4.5) {
    this.fireballs?.spawn(position, radius, !!this.q.fireball);
  }

  /** Emit velocity-stretched sparks (#9). */
  sparks(position, normal = null, count = 12) {
    if (!this.q.sparks) return;
    this.sparkSystem?.sparks(position, normal, count);
  }

  /** Spawn a ground-hugging dust ring skirt (#9). */
  dustSkirt(position, radius = 2.5) {
    if (!this.q.sparks) return;
    this.sparkSystem?.dustSkirt(position, radius);
  }

  /** Set low-HP film grain intensity ratio 0..1 (#10). */
  setLowHp(ratio) {
    this._lowHp = THREE.MathUtils.clamp(ratio || 0, 0, 1);
  }

  /** Feed player speed / sprint state for edge motion blur (#8). */
  setPlayerSpeed(speed, sprinting = false) {
    this._sprintBlur = this.reducedMotion
      ? 0
      : THREE.MathUtils.clamp((speed - 8) / 10 + (sprinting ? 0.35 : 0), 0, 1);
  }

  /**
   * The dust front of a big collapse: the same ring, laid flat on the ground, slower,
   * wider and the colour of masonry. `groundY` keeps it on the surface rather than at the
   * height the mass detached from.
   */
  groundRing(position, groundY) {
    const material = this.shockMaterial.clone();
    material.color.set(0xb9ab95);
    material.blending = THREE.NormalBlending;
    const mesh = new THREE.Mesh(this.shockGeometry, material);
    mesh.position.set(position.x, groundY + 0.25, position.z);
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);
    this.shocks.push({ mesh, life: 1.1, total: 1.1, grow: 30, flat: true });
  }

  /** Gun heat, 0..1. Only the top 30% shimmers; reduced motion gets none (it moves the frame). */
  setHeat(heat) {
    this._heat = this.reducedMotion ? 0 : THREE.MathUtils.clamp((heat - 0.7) / 0.3, 0, 1);
  }

  /** Throw grit at the lens, 0..1. It settles over a few seconds. */
  lensDust(amount) { this._dust = Math.min(1, this._dust + amount); }

  /** How washed-out the picture should be, 0..1. Eased, so it never snaps. */
  setDesat(target) { this._desatTarget = target; }

  /** Lightning: a full-frame exposure spike that dies in a fraction of a second. */
  flash(amount) { this._flash = Math.min(1, this._flash + amount); }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    // Pin the dome to the camera. A world-pinned dome of radius R needs a far plane of
    // R + (camera distance from origin); riding the camera keeps it at exactly R, so the
    // sky can never clip no matter how far the player walks.
    if (this.sky) this.sky.position.copy(this.camera.position);

    if (this.q.timeOfDay) {
      this.dayPhase = (this.dayPhase + dt / DAY_LENGTH_S) % 1;
      this._applyDayPhase();
    }

    if (this._muzzleT > 0) {
      this._muzzleT -= dt;
      this.muzzleLight.intensity *= Math.exp(-dt * 40);
      if (this._muzzleT <= 0) this.muzzleLight.visible = false;
    }

    if (this._hitOpacity > 0.005) {
      this._hitOpacity *= Math.exp(-dt * 4.5);
      this.hitOverlay.style.opacity = this._hitOpacity.toFixed(3);
    } else if (this.hitOverlay.style.opacity !== '0') {
      this.hitOverlay.style.opacity = '0';
      this._hitOpacity = 0;
    }

    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
        this.shocks.splice(i, 1);
        continue;
      }
      const t = 1 - s.life / s.total;
      s.mesh.scale.setScalar(1 + t * s.grow);
      s.mesh.material.opacity = (s.flat ? 0.5 : 0.8) * (1 - t);
      if (!s.flat) s.mesh.quaternion.copy(this.camera.quaternion); // billboard toward the camera
    }

    this.fireballs?.update(dt);
    this.sparkSystem?.update(dt);

    this._dust = Math.max(0, this._dust - dt * 0.28);
    this._flash *= Math.exp(-dt * 9);
    this._desat += (this._desatTarget - this._desat) * Math.min(1, dt * 2.5);
    const u = this.pu;
    u.time.value = this.time;
    u.heat.value = this._heat;
    u.dust.value = this._dust;
    u.desat.value = this._desat;
    u.flash.value = this._flash < 0.004 ? 0 : this._flash;
    u.wetness.value = getWetness();
    u.trauma.value = this.reducedMotion ? 0 : this.trauma;
    u.lowHp.value = this._lowHp;
    u.sprintBlur.value = this._sprintBlur;
  }


  /**
   * Apply shake to the camera. Call AFTER the follow/lookAt has oriented it.
   * Layered sines at incommensurate frequencies read as noise without allocating one.
   */
  applyShake() {
    if (this.trauma <= 0) return;
    const a = this.trauma * this.trauma;
    const t = this.time;
    const yaw = a * 0.05 * (Math.sin(t * 31.7) + 0.6 * Math.sin(t * 47.3));
    const pitch = a * 0.04 * (Math.sin(t * 37.1) + 0.6 * Math.sin(t * 53.9));
    const roll = a * 0.025 * Math.sin(t * 41.3);
    this.camera.rotateY(yaw);
    this.camera.rotateX(pitch);
    this.camera.rotateZ(roll);
  }

  _updateSunScreen() {
    if (!this.camera) return 0;
    this._sunWorld.copy(this._sunDir).multiplyScalar(400).add(this.camera.position);
    this._sunProjected.copy(this._sunWorld).project(this.camera);
    const sx = this._sunProjected.x * 0.5 + 0.5;
    const sy = this._sunProjected.y * 0.5 + 0.5;
    const behind = this._sunProjected.z > 1;
    const offscreen = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) - 0.5;
    const edgeFade = THREE.MathUtils.clamp(1 - offscreen / 0.35, 0, 1);
    const elevation = THREE.MathUtils.clamp(this._sunDir.y * 3, 0, 1);
    const strength = behind ? 0 : edgeFade * elevation;
    const u = this.pu;
    u.sunScreen.value.set(sx, sy);
    u.shaftStrength.value = strength;
    u.sunVisible.value = strength * (1 - this.overcast * 0.85);
    return strength;
  }

  render() {
    if (!this.post) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.camera?.updateMatrixWorld) {
      this.camera.updateMatrixWorld();
      // Detect large camera cuts (> 4 m jump or > ~25 deg rotation) to reset the motion history.
      const moved = this.camera.position.distanceToSquared(this._prevCamPos) > 16;
      const turned = Math.abs(this.camera.quaternion.dot(this._prevCamQuat)) < 0.96;
      if (moved || turned) this._hasPrevViewProj = false;
      this._currViewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      if (!this._hasPrevViewProj) this._prevViewProj.copy(this._currViewProj);
      this._sunDirView.copy(this._sunDir).transformDirection(this.camera.matrixWorldInverse);
      const u = this.pu;
      u.proj.value.copy(this.camera.projectionMatrix);
      u.projInv.value.copy(this.camera.projectionMatrixInverse);
      u.camWorld.value.copy(this.camera.matrixWorld);
      u.camWorldInv.value.copy(this.camera.matrixWorldInverse);
      u.prevViewProj.value.copy(this._prevViewProj);
      u.sunDirView.value.copy(this._sunDirView);
      // Motion blur has nothing to do on a still frame: let the graph skip its taps.
      let changed = 0;
      const a = this._currViewProj.elements, b = this._prevViewProj.elements;
      for (let i = 0; i < 16; i++) changed += Math.abs(a[i] - b[i]);
      u.camMoved.value = changed > 1e-4 ? 1 : 0;
      this._updateSunScreen();
    }

    try {
      this.post.render();
    } catch (e) {
      // A graph that cannot compile (driver, WGSL) must not take the game down: draw plain.
      console.warn('[povoxelstrike/vfx] post pipeline failed, rendering plain:', e);
      try { this.post.dispose(); } catch { /* already gone */ }
      this.post = null;
      this.renderer.render(this.scene, this.camera);
    }

    if (this.camera?.position && this._currViewProj) {
      this._prevViewProj.copy(this._currViewProj);
      this._prevCamPos.copy(this.camera.position);
      this._prevCamQuat.copy(this.camera.quaternion);
      this._hasPrevViewProj = true;
    }
  }

  dispose() {
    for (const s of this.shocks) { this.scene.remove(s.mesh); s.mesh.material.dispose(); }
    this.shocks.length = 0;
    this.shockGeometry.dispose();
    this.shockMaterial.dispose();
    this.fireballs?.dispose();
    this.sparkSystem?.dispose();
    this.scene.remove(this.muzzleLight);
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      this.sky.material.dispose();
    }
    this.post?.dispose();
    this.hitOverlay.remove();
  }
}
