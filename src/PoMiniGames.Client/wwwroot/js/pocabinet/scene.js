// pocabinet/scene.js
//
// Three.js scene for PoCabinet. Owns the renderer, camera, fog, lights and the
// static track meshes, all built from the static world the page hands over
// (PoCabinetTrackGeometry.BuildStaticWorld — the same centerline the physics
// runs on, client and server).
//
// Rendering is physically based: MeshStandard/Physical materials lit by a sun
// (DirectionalLight with a shadow map that follows the car in focus), a
// hemisphere fill, and image-based lighting from a PMREM capture of the sky dome
// (re-captured whenever the weather changes). The frame goes through postfx.js
// (HDR bloom, light shafts, ACES tone mapping). Surfaces use procedural textures
// from materials.js — asphalt with a normal and roughness map, grass with a
// world-space macro tint so it never tiles — plus camera-riding grass blades
// (grass.js) on the green tracks.
//
//   • ground: a terrain heightfield (terrain.js) that lies on the road's plane under the road
//     and its run-off and rolls away into hills beyond the barriers, sized past the fog
//   • asphalt ribbon as wide as the road is at each sample (track.hw), painted edge lines,
//     a chequered start line
//   • the run-off either side: lawn, a gravel trap (beach sand on the beach road) or tarmac
//     run-off with painted track-limit stripes, as deep as physics.js makes it (runOffAt)
//   • barrier walls with a striped face, exactly where physics.js stops a car (wallAt),
//     following the road's height and bank
//   • patches, the rubbered-in racing line, road dividers with their JOKER signs, braking
//     boards and corner numbers (trackside.js)
//   • sky dome (sky.js) and trackside scenery (scenery.js), dressed zone by zone
//     (track.zoneAt: the stadium, Senate Hill, the court, the beach)
//   • the scanned basketball court the lap crosses (models.js: court.ksplat / court.glb,
//     cropped to the court, standing where track.scan says)
//
// World mapping: sim (x, y) → three (x / 10, h, y / 10). h is the road's height (track.z,
// tilted across by track.bank) on the road and its run-off out to the barriers, and the
// terrain's height (groundHeight) everywhere else.
//
// Camera: third person only. 'chase' (close), 'far' (high and
// long) and 'tv' (trackside cameras handing off along the lap).
//
// Quality follows the app's tier (qualityTiers.js, window.PoQuality: the player's choice in
// Settings, else what the device can take): a mount starts there and a change of it applies at
// once. Under it, platform/renderBudget.js reads the 95th-percentile frame time and walks a
// ladder one rung at a time — pixel ratio, smoke share, throttled shadows, then the tier's
// bloom depth, shadow map and grass — down fast when frames run long and back up slowly
// when there is headroom, never above the app's tier.
//
// Presentation on top (never the sim): a pre-impact light swell when the focus car is about
// to hit another (platform/anticipation.js), the light rig for lightning and wreck beacons
// (platform/lightRig.js), and an in-world race-order board whose text is mirrored in a flat
// HUD fallback (platform/diegeticBoard.js).
//
// Weather (setWeather, from environment.js) is the scene's: fog, sky and light, the wet
// asphalt and run-off, the falling-rain streaks and the lens drops (fx.rain). `raining` is
// the live flag the render and audio layers read.
//
// `handle.fx` is the per-frame bag race.js writes into (speed, flash, shake, kerb rumble,
// slow motion, focus); the loop turns it into FOV kick, camera shake and the shadow/grass
// follow, and fills in the sun's screen position and exposure for the post pass.
//
// API surface:
//   const handle = await mount(canvas, world);
//   handle.setView({ x, y, heading, mode, speed, dt });
//   handle.setStartLights(lit, go); handle.setWeather(rain); handle.setRubber(r, wet);
//   handle.groundHeight(xSim, ySim) — world height of the ground there
//   unmount(handle);

import * as THREE from './three.js';
import { uniform } from 'three-eco/tsl';
import { buildTrack } from './track.js';
import { runOffAt } from './physics.js';
import { computeKerbs } from './kerbs.js';
import { Sky } from './sky.js';
import { Scenery } from './scenery.js';
import { PostFx } from './postfx.js';
import { Grass } from './grass.js';
import { asphalt, grass as grassTextures, macro, clock, reflective, puddlePorosity, sunDirUniform } from './materials.js';
import { Terrain, themeOf, wallFace } from './terrain.js';
import { Trackside } from './trackside.js';
import { gravel, sand, limitStripes } from './surfaces.js';
import { WORLD_SCALE } from './util.js';
import { barrier, barrierTexture, disposeObject, flatGround, hex, ribbon, startLine } from './meshes.js';
import { SHADOW_EXTENT } from './cameras.js';
import * as cams from './cameras.js';
import * as models from './models.js';
// Platform GFX layer (deck ideas #1, #2, #6, #7): the fine-grained render budget under the
// app tier, the pre-impact light swell, the shared light rig (lightning, wreck beacons, rim
// pulse) and the in-world standings board with its flat HUD fallback.
import { createStage } from '../platform/stage/stage.js';
import { createRenderer, attachRenderer, configureRenderer, webgpuAvailable } from '../platform/3d/renderer.js';
import { POST_LIB } from '../platform/3d/postAddons.js';
import { applySunShadows } from '../platform/3d/shadows.js';
import { Anticipation, closestApproach } from '../platform/anticipation.js';
import { LightRig } from '../platform/lightRig.js';
import { DiegeticBoard } from '../platform/diegeticBoard.js';

const SUN_BASE = 3.2;
const HEMI_BASE = 0.7;
const ENV_BASE = 0.85;
const GRASS_BLADES = { low: 0, medium: 14000, high: 36000 };
const SHADOW_SIZE = { low: 1024, medium: 1536, high: 2048 };

/** Reduced motion: <html data-motion> (the OS preference or the app's settings switch). */
const calm = () => document.documentElement.dataset.motion === 'reduce';


// Full resolution on every tier: a lower frame rate beats a softer picture (the owner's call).
const RENDER_SCALE = { low: 1, medium: 1, high: 1 };

/** The app's quality tier (qualityTiers.js), or 'high' where it is not loaded. */
function appTier() {
    const t = window.PoQuality?.tier?.();
    return RENDER_SCALE[t] ? t : 'high';
}



class SceneHandle {
    constructor(renderer, scene, camera, hemi, sun, canvas) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.ambient = hemi;     // kept under the old name for callers that dim "ambient"
        this.hemi = hemi;
        this.sun = sun;
        this.canvas = canvas;
        this.disposed = false;
        // The stage owns the loop, the resize observer, the pixel-ratio policy, the tier and the
        // render budget. Camera shake stays the scene's own (cameras.applyFx), so no shared shake.
        this.stage = createStage({
            kind: '3d', container: canvas, maxDt: 0.1, use: ['renderBudget'], exclude: ['shake'],
            onFrame: (dt) => this._frame(dt),
        });
        attachRenderer(this.stage, renderer, { camera, onResize: (view) => this._applyDpr(view) });
        this.stage.on('rung', (rung) => this.applyBudget(rung));
        this.track = null;
        this.trackGroup = null;
        this.groundMesh = null;
        this.roadMesh = null;
        this.terrain = null;      // terrain.js
        this.trackside = null;    // trackside.js
        this.runoffMats = null;   // gravel / tarmac run-off materials, wetted by setWeather
        this.roadRefl = { value: 0.02 };   // the road's reflectivity for postfx.js, set by setWeather
        this.theme = 'grandprix';
        this.roomSplat = null;    // the court scan's Gaussian splat (DropInViewer), when it loaded
        this.roomProgress = null; // its loading bar over the canvas
        this.roomDetail = null;   // 'auto' | 'splat' (full) | 'mesh' (lite); read from the stored settings when unset
        this.sky = null;
        this.envSky = null;
        this.envTarget = null;
        this.pmrem = new THREE.PMREMGenerator(renderer);
        this.scenery = null;
        this.grass = null;
        this.ownedTextures = [];   // textures a loaded model brought (the rest are module-cached)
        this.post = null;
        this.quality = 'high';
        this.baseFov = camera.fov;
        this.fps = { frames: 0, time: 0, slow: 0 };
        this.userScale = 1;
        this.sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
        this.sunDirVisual = null;
        this.sunVisibility = 0;
        this.raining = false;
        this.wetUniform = uniform(0);
        this.rain = null;         // the falling-rain streaks while it rains (setRainStreaks)
        this.fx = {
            speed: 0, rain: 0, flash: 0, slow: 0,
            shake: 0, rumble: 0, latG: 0, susp: 0, reduced: false, focus: null,
            exposure: 1, bloom: 0.7, bloomThreshold: 1, sun: null, sunDir: this.sunDir,
            sunColor: new THREE.Color(1, 0.9, 0.75), lights: null,
        };
        this.baseAtmosphere = null;
        this._frameCbs = new Set();
        this._tvIndex = -1;
        this._chase = new THREE.Vector3();
        this._chaseLook = new THREE.Vector3();
        this._chaseInit = false;
        this._v = new THREE.Vector3();
        // Render budget (#1): p95 frame time walks a ladder of resolution / particle / shadow
        // settings under the app tier. Replaces the old one-way three-slow-seconds step-down.
        this.particleScale = 1;
        // Anticipation (#2) and the light rig (#6): presentation only, never the sim.
        this.antic = new Anticipation();
        this.lightRig = new LightRig({ sun, hemi });
        this.wreckNear = 0;   // fx.js: 0..1, a wrecked car close to the camera (beacons)
        this._prevPos = new WeakMap();
        this._contactCooldown = 0;
        this._prevSlow = 0;
        this.board = null;   // #7, made by placeBoard()
    }

    /** The stage's renderBudget feature (platform/renderBudget.js ladder under the app tier). */
    get budget() { return this.stage.budget; }

    /** Register a per-frame callback (receives a DOMHighResTimeStamp). */
    onFrame(cb) {
        if (!this.disposed && typeof cb === 'function') this._frameCbs.add(cb);
    }

    offFrame(cb) {
        this._frameCbs.delete(cb);
    }

    startLoop() {
        this.stage.start();
    }

    /** One frame (the stage's onFrame): dt is already clamped to 0.1 s. */
    _frame(dt) {
        if (this.disposed) return;
        const now = performance.now();
        clock.value = now / 1000;
        for (const cb of this._frameCbs) {
            try { cb(now); } catch { /* one bad effect never kills the frame */ }
        }
        try {
            this.applyFx(dt);
            this.updateRain(dt);
            this.followShadow();
            this.grass?.update(this.camera);
            this.sky?.update(this.camera, this.scene.fog, now / 1000);
            this.scenery?.update(dt, this.fx.focus);
            this.updateSunScreen();
            this.syncRoomSplat();
        } catch { /* decoration never kills the frame */ }
        // Pre-impact swell and the light rig scale the frame's exposure and bloom for this
        // render only; the engine's own values are put back right after.
        const e0 = this.fx.exposure, b0 = this.fx.bloom;
        try {
            const a = this.updateAnticipation(now, dt);
            this.lightRig.setRim(a.rim);
            this.lightRig.setOverlay('emergency', Math.min(0.6, this.wreckNear || 0));
            const rig = this.lightRig.update(dt);
            this.fx.exposure = (e0 || 1) * a.exposure * rig.exposure;
            this.fx.bloom = (b0 ?? 0.7) + a.bloom;
        } catch { /* decoration never kills the frame */ }
        if (this.post) this.post.render(this.scene, this.camera, this.fx, now / 1000);
        else this.renderer.render(this.scene, this.camera);
        this.fx.exposure = e0;
        this.fx.bloom = b0;
        try { this.board?.update(this.camera, now); } catch { /* the HUD fallback still has the text */ }
    }

    stopLoop() {
        this.stage.stop();
    }

    setView(p) {
        return cams.setView(this, p);
    }

    applyFx(dt) {
        return cams.applyFx(this, dt);
    }

    followShadow() {
        return cams.followShadow(this);
    }

    updateSunScreen() {
        return cams.updateSunScreen(this);
    }

    /** Apply player view preferences (reduced motion is the platform's). */
    applyView() {
        if (this.disposed) return;
        this.fx.reduced = calm();
    }

    /**
     * One budget rung (the stage's 'rung' event; the feature has already moved the shadow policy):
     * pixel ratio (this scene's per-tier scale x the rung's), particle share, quality tier.
     */
    applyBudget(rung) {
        if (this.disposed || !rung || !RENDER_SCALE[rung.tier]) return;
        this.fps.slow = 0;
        this.renderer.shadowMap.needsUpdate = true;
        this.particleScale = this.budget.particleScale;
        this.sunShadows?.setSoftness(rung.tier === 'high' ? 1 : rung.tier === 'medium' ? 0.65 : 0);
        this.setQuality(rung.tier);
        this._applyDpr(this.stage.view);
    }

    /** The budget's pixel ratio on top of the shared DPR policy, then the post targets. */
    _applyDpr(view) {
        const rung = this.budget?.rung;
        if (!rung || !RENDER_SCALE[rung.tier]) return;
        const dpr = Math.min(view.dpr, rung.maxDpr) * rung.resScale * RENDER_SCALE[rung.tier];
        if (Math.abs(dpr - this.renderer.getPixelRatio()) > 1e-4) this.renderer.setPixelRatio(dpr);
        this.sunShadows?.updateFrustums();
        this.post?.setSize();
    }

    /** Switch the whole frame to tier `q` (the app's choice): the budget restarts at its top rung. */
    applyTier(q) {
        if (this.disposed || !RENDER_SCALE[q]) return;
        this.budget.snapTo(q);
        this.applyBudget(this.budget.rung);
    }

    /**
     * Pre-impact light (#2). Predicts contact between the focus car and any other car from
     * their on-screen motion (closest approach inside a second, under a car's width apart,
     * closing fast) and arms the swell for that moment; the photo-finish slow motion arms a
     * 'win' swell. Returns the envelope sample.
     */
    updateAnticipation(now, dt) {
        const fx = this.fx;
        const slow = fx.slow || 0;
        if (slow > 0.2 && this._prevSlow <= 0.2) {
            this.antic.arm('win', { leadMs: 900 });
            this.board?.showEvent('PHOTO FINISH');
        }
        this._prevSlow = slow;
        this._contactCooldown = Math.max(0, this._contactCooldown - dt);
        const focus = fx.focus;
        const movers = fx.movers;
        if (!(dt > 0) || !focus || !movers || !(fx.speed > 0)) return this.antic.sample(now);
        // Velocities from last frame's positions (cars only; the crowd mesh is instanced).
        let me = null, mvx = 0, mvz = 0, bestD = 9;
        for (const m of movers) {
            if (m.isInstancedMesh) continue;
            const p = m.position;
            const prev = this._prevPos.get(m);
            const vx = prev ? (p.x - prev.x) / dt : 0, vz = prev ? (p.z - prev.z) / dt : 0;
            if (prev) { prev.x = p.x; prev.z = p.z; prev.vx = vx; prev.vz = vz; }
            else this._prevPos.set(m, { x: p.x, z: p.z, vx: 0, vz: 0 });
            const d = (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2;
            if (d < bestD) { bestD = d; me = m; mvx = vx; mvz = vz; }
        }
        if (!me || this._contactCooldown > 0) return this.antic.sample(now);
        let soonest = Infinity, strength = 0;
        for (const m of movers) {
            if (m === me || m.isInstancedMesh) continue;
            const p = m.position, v = this._prevPos.get(m);
            if (!v || (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2 > 1600) continue;
            const c = closestApproach(focus.x, focus.z, mvx, mvz, p.x, p.z, v.vx, v.vz);
            if (c.t > 0.05 && c.t < 1 && c.miss < 2.2 && c.closing > 6 && c.t < soonest) {
                soonest = c.t;
                strength = Math.min(1.2, c.closing / 30);
            }
        }
        if (soonest < Infinity && this.antic.arm('impact', { at: now + soonest * 1000, strength })) {
            this._contactCooldown = 1.2;
        }
        return this.antic.sample(now);
    }

    /**
     * The in-world board (#7) over the run-up to the line, facing the oncoming cars. The flat HUD
     * fallback lives over the canvas; the race page's own HUD already lists positions, so only
     * the event cards surface visibly there (the list stays in the accessibility tree).
     */
    placeBoard() {
        const t = this.track;
        if (!t) {
            if (this.board) this.board.mesh.visible = false;
            return;
        }
        if (!this.board) {
            this.board = new DiegeticBoard({
                THREE, title: 'RACE ORDER', worldWidth: 12, label: 'Race order',
                hudHost: this.canvas?.parentElement || null,
            });
            this.scene.add(this.board.mesh);
        }
        this.board.mesh.visible = true;
        const d = 40 * WORLD_SCALE;
        const p = t.pointAt(d);
        const side = (t.halfWidth || 6 * WORLD_SCALE) / WORLD_SCALE + 3.5;
        // Left of travel (+ lateral = right in sim units), raised clear of the barrier.
        const x = (p.x + p.ty * side * WORLD_SCALE) / WORLD_SCALE;
        const z = (p.y - p.tx * side * WORLD_SCALE) / WORLD_SCALE;
        const y = t.heightAt(d) / WORLD_SCALE + 6.5;
        this.board.place(x, y, z, -p.tx, -p.ty);
    }

    /** Race order from fx.js (rows: { name, pos, gap, you }), and a card when the focus car gains a place. */
    setStandings(rows, gained = 0) {
        this.board?.setStandings(rows);
        if (gained > 0) {
            const me = rows.find(r => r.you);
            if (me) this.board?.showEvent(`P${me.pos} \u25B2`, 1600);
            this.antic.arm('overtake', { leadMs: 0, strength: 0.8 });
        }
    }

    setQuality(q) {
        if (q === this.quality) return;
        this.quality = q;
        this.post?.setQuality(q);
        const size = SHADOW_SIZE[q];
        if (this.sun.shadow.mapSize.x !== size) {
            this.sun.shadow.mapSize.set(size, size);
            this.sun.shadow.map?.dispose();
            this.sun.shadow.map = null;
        }
        this.buildGrass();
    }

    /** Start gantry: `lit` pods red (0..5), or all green on `go`. */
    setStartLights(lit, go) {
        this.scenery?.setStartLights(lit, go);
    }

    /** Rain or clear: fog and sky colour, light levels, the sky's clouds, and a fresh IBL capture. */
    setWeather(rain) {
        this.raining = !!rain;
        this.wetUniform.value = rain ? 1 : 0;
        const base = this.baseAtmosphere || {};
        const fog = hex(base.fogHex, '#14233f');
        if (rain) fog.lerp(new THREE.Color('#4d545c'), 0.35);
        this.scene.background = fog.clone();
        if (this.scene.fog) {
            this.scene.fog.color.copy(fog);
            this.scene.fog.near = (Number(base.fogStart) || 220) * (rain ? 0.6 : 1);
            this.scene.fog.far = (Number(base.fogEnd) || 900) * (rain ? 0.75 : 1);
        }
        const ambient = (Number(base.ambientIntensity) || 0.5) / 0.55;
        const day = rain ? 0.5 : 1;
        this.sun.intensity = SUN_BASE * ambient * day;
        this.hemi.intensity = HEMI_BASE * ambient * (0.3 + 0.7 * day);
        this.scene.environmentIntensity = ENV_BASE * (0.25 + 0.75 * day);
        this.sunVisibility = this.sky ? this.sky.preset.sunSize > 0 ? day * (rain ? 0 : 1) : 0 : 0;
        this.fx.exposure = 1;
        this.fx.bloomThreshold = 1.1;
        this.sky?.setRain(rain);
        this.fx.rain = rain ? 1 : 0;   // lens drops (postfx.js)
        this.wetRoad(rain);
        this.setRainStreaks(rain);
        // The post pass's reflections: wet asphalt is a blurred mirror; dry, the road only marks
        // itself (0.02) so the far tarmac can shimmer like a mirage on a clear day.
        this.roadRefl.value = rain ? 0.55 : 0.02;
        this.fx.skyColor = fog.clone();
        this.fx.mirage = rain ? 0 : 1;
        // Standing water, the rubbered line drying first, and wet gravel and run-off tarmac.
        this.trackside?.setWet(rain);
        this.trackside?.setRubber(this.trackside.level, rain);
        const r = this.runoffMats;
        if (r) {
            for (const [mat, dry] of r.dry) {
                mat.color.copy(dry.color).multiplyScalar(rain ? dry.wetShade : 1);
                mat.roughness = rain ? dry.wetRough : dry.roughness;
            }
        }
        this.captureEnvironment();
        // The light rig scales what the weather just set (lightning, beacons, rim pulse).
        this.lightRig?.captureBase();
    }

    /**
     * Wet asphalt: darker and near-mirror, so the sky reflects in it through the environment
     * map (and the post pass's SSR, roadRefl above). The dry values are kept on the material,
     * which setTrack rebuilds, so a new track always starts from its own dry look.
     */
    wetRoad(rain) {
        const m = this.roadMesh?.material;
        if (!m || !m.isMeshStandardMaterial) return;
        const dry = m.userData.dry || (m.userData.dry = {
            color: m.color.clone(), roughness: m.roughness, env: m.envMapIntensity, ns: m.normalScale.clone(),
        });
        m.color.copy(dry.color).multiplyScalar(rain ? 0.55 : 1);
        m.roughness = rain ? 0.3 : dry.roughness;
        m.envMapIntensity = rain ? 1.6 : dry.env;
        if (rain) m.normalScale.set(0.35, 0.35); else m.normalScale.copy(dry.ns);
    }

    /** Falling rain: a camera-parented LineSegments streak field, recycled in a box ahead of it. */
    setRainStreaks(rain) {
        if (!rain) {
            if (!this.rain) return;
            this.camera.remove(this.rain.lines);
            this.rain.lines.geometry.dispose();
            this.rain.lines.material.dispose();
            this.rain = null;
            return;
        }
        if (this.rain) return;
        const count = calm() ? 120 : 320;
        const positions = new Float32Array(count * 6);
        const dropY = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const x = (Math.random() * 2 - 1) * 16, y = Math.random() * 12, z = -Math.random() * 26;
            dropY[i] = y;
            positions.set([x, y, z, x, y - 0.55, z], i * 6);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x9db8d8, transparent: true, opacity: 0.42 }));
        lines.frustumCulled = false;
        this.camera.add(lines);
        this.rain = { lines, dropY, count };
    }

    updateRain(dt) {
        const r = this.rain;
        if (!r || !(dt > 0)) return;
        const attr = r.lines.geometry.attributes.position, pos = attr.array;
        const fall = (calm() ? 9 : 22) * Math.min(dt, 0.05);
        for (let i = 0; i < r.count; i++) {
            let y = r.dropY[i] - fall;
            if (y < -1) y += 12;
            r.dropY[i] = y;
            pos[i * 6 + 1] = y;
            pos[i * 6 + 4] = y - 0.55;
        }
        attr.needsUpdate = true;
    }

    /** Rubber down on the racing line (0..1, track.js rubberAt) and whether it is raining. */
    setRubber(r, wet) {
        this.trackside?.setRubber(r, wet);
    }

    /** World height of the ground under a sim point (the court's floor on the scan). */
    groundHeight(xSim, ySim) {
        return this.terrain ? this.terrain.worldHeight(xSim, ySim) : 0;
    }

    /** Re-render the sky dome into a PMREM cube for image-based lighting and reflections. */
    captureEnvironment() {
        if (!this.sky) return;
        try {
            if (!this.envSky) {
                this.envSky = new Sky();
                this.envScene = new THREE.Scene();
                this.envScene.add(this.envSky.mesh);
            }
            const src = this.sky.material.uniforms, dst = this.envSky.material.uniforms;
            for (const k of Object.keys(src)) {
                const v = src[k].value;
                dst[k].value = v && v.clone ? v.clone() : v;
            }
            if (this.scene.fog) dst.uHorizon.value.copy(this.scene.fog.color);
            this.envSky.mesh.position.set(0, 0, 0);
            const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
            this.envTarget?.dispose();
            this.envTarget = next;
            this.scene.environment = next.texture;
        } catch (e) {
            console.warn('pocabinet/scene: environment capture skipped', e);
        }
    }

    /** Build (or rebuild) every track mesh for a static world. */
    setTrack(world) {
        if (this.disposed) return;
        const atmosphere = world.atmosphere || {};
        this.baseAtmosphere = { ...atmosphere };
        this.scene.background = hex(atmosphere.skyHex, '#14233f');
        this.scene.fog = new THREE.Fog(hex(atmosphere.fogHex, '#14233f').getHex(),
            Number(atmosphere.fogStart) || 220, Number(atmosphere.fogEnd) || 900);

        this.disposeTrackMeshes();
        this.track = buildTrack(world);
        const t = this.track;
        this.theme = themeOf(t);
        const group = new THREE.Group();
        group.name = 'pocabinet-track';

        // Ground: a terrain that follows the road, reaching past the fog's far edge so it fades
        // into the sky's horizon. Under the scan it steps down out of the scan's way.
        const reach = (Number(atmosphere.fogEnd) || 900) * 1.3;
        const tile = 7;
        const tex = grassTextures();
        const groundMat = macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.groundHex, '#2a3a24'), roughness: 0.95, metalness: 0,
            map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
        }), 70, 0.35);
        let ground = null;
        try {
            this.terrain = new Terrain(t);
            ground = this.terrain.mesh(groundMat, reach, tile);
        } catch (e) {
            this.terrain = null;
            console.warn('pocabinet/scene: terrain skipped', e);
        }
        if (!ground) ground = flatGround(world, groundMat, reach, tile);
        group.add(ground);
        this.groundMesh = ground;

        const tar = asphalt();
        const roadMat = reflective(puddlePorosity(macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.roadHex, '#393b42'), roughness: 1, metalness: 0,
            map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: tar.roughnessMap,
            side: THREE.DoubleSide,
        }), 30, 0.2), this.wetUniform), this.roadRefl);
        this.roadMesh = new THREE.Mesh(ribbon(t, (i) => -t.hw[i], (i) => t.hw[i], 0.02, 45), roadMat);
        this.roadMesh.receiveShadow = true;
        // Over the scan the road is a deck a hand above the court: it throws a shadow on it.
        this.roadMesh.castShadow = !!t.scan;
        group.add(this.roadMesh);
        this.buildRunoff(group, atmosphere, groundMat, tile);
        models.buildScanFloor(this, group);

        // Edge lines on the tarmac, then the barriers where physics puts the wall.
        const lineMat = new THREE.MeshStandardMaterial({
            color: 0xe8e8e8, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        for (const [a, b] of [[(i) => -t.hw[i], (i) => -t.hw[i] + 2.2], [(i) => t.hw[i] - 2.2, (i) => t.hw[i]]]) {
            const line = new THREE.Mesh(ribbon(t, a, b, 0.03, 45), lineMat);
            line.receiveShadow = true;
            group.add(line);
        }
        // physics.js stops a car's centre at wallAt (hw + run-off depth - CAR_RADIUS/2); its
        // flank is half a car width further out, so that is where the barrier face belongs.
        const barrierMat = new THREE.MeshStandardMaterial({
            map: barrierTexture(atmosphere.accentHex), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
        });
        for (const s of [-1, 1]) {
            const wallMesh = new THREE.Mesh(barrier(t, (i) => s * wallFace(t, i, s), s, 0.7, 2.5), barrierMat);
            wallMesh.castShadow = true;
            wallMesh.receiveShadow = true;
            group.add(wallMesh);
        }

        group.add(startLine(t));

        try {
            this.trackside = new Trackside(t, { theme: this.theme, terrain: this.terrain, atmosphere });
            group.add(this.trackside.group);
        } catch (e) {
            this.trackside = null;
            console.warn('pocabinet/scene: trackside skipped', e);
        }

        try {
            this.sky = new Sky();
            group.add(this.sky.mesh);
            this.sunDir = new THREE.Vector3(...this.sky.preset.sun).normalize();
            const light = this.sky.lightDirection();
            this.sunDir.copy(light);
            this.fx.sunDir = this.sunDir;
            sunDirUniform.value.copy(this.sunDir);
            this.sun.color.copy(new THREE.Color(this.sky.preset.sunSize > 0 ? this.sky.preset.sunColor : '#b8a8ff').lerp(new THREE.Color('#ffffff'), 0.55));
            this.fx.sunColor.copy(new THREE.Color(this.sky.preset.sunColor));
            this.sunDirVisual = new THREE.Vector3(...this.sky.preset.sun).normalize();
            this.hemi.color.copy(new THREE.Color(this.sky.preset.zenith).lerp(new THREE.Color('#ffffff'), 0.5));
            this.hemi.groundColor.copy(hex(atmosphere.groundHex, '#2a3a24'));
        } catch (e) {
            this.sky = null;
            console.warn('pocabinet/scene: sky skipped', e);
        }
        try {
            this.scenery = new Scenery(t, {
                ...world, kerbs: computeKerbs(t), theme: this.theme, terrain: this.terrain,
            });
            group.add(this.scenery.group);
        } catch (e) {
            this.scenery = null;
            console.warn('pocabinet/scene: scenery skipped', e);
        }

        this.scene.add(group);
        this.trackGroup = group;
        this.buildGrass();
        this.setWeather(false);
        models.loadScan(this, group);
        try { this.placeBoard(); } catch (e) { console.warn('pocabinet/scene: board skipped', e); }
    }

    /**
     * Run-off either side, per sample as deep as the physics makes it (runOffAt): the lawn
     * (the ground's own material, mapped the same, so it meets the terrain seamlessly), a
     * gravel trap (beach sand in the beach zone) or tarmac run-off with painted track-limit
     * stripes along the edge (blue on the court, red elsewhere). Laid on the road's plane, a
     * hair under the tarmac, and on under the barrier.
     */
    buildRunoff(group, atmosphere, lawn, lawnTile) {
        const t = this.track;
        const trap = (beach) => {
            const g = beach ? sand() : gravel();
            return macro(new THREE.MeshStandardMaterial({
                color: beach ? '#efe3c6' : '#c4b8a2', map: g.map, normalMap: g.normalMap,
                normalScale: new THREE.Vector2(beach ? 0.5 : 1, beach ? 0.5 : 1), roughness: 1, metalness: 0,
            }), 25, 0.2);
        };
        const gravelMat = trap(false), sandMat = trap(true);
        const tar = asphalt();
        const runMat = macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.roadHex, '#393b42').multiplyScalar(1.18).lerp(new THREE.Color('#5a6272'), 0.18),
            map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: tar.roughnessMap,
            roughness: 1, metalness: 0,
        }), 30, 0.2);
        const stripes = (colour) => new THREE.MeshStandardMaterial({
            map: limitStripes(colour, '#f2f2f2'), roughness: 0.55, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        const redMat = stripes('#c8202a'), blueMat = stripes('#1f5fbf');
        const dry = new Map();
        for (const m of [gravelMat, sandMat]) dry.set(m, { color: m.color.clone(), roughness: 1, wetShade: 0.72, wetRough: 0.6 });
        dry.set(runMat, { color: runMat.color.clone(), roughness: 1, wetShade: 0.58, wetRough: 0.32 });
        for (const m of [redMat, blueMat]) dry.set(m, { color: m.color.clone(), roughness: 0.55, wetShade: 0.8, wetRough: 0.25 });
        this.runoffMats = { dry };
        const beach = (i) => t.zoneAt(i) === 'maralago', court = (i) => t.zoneAt(i) === 'court';
        // What is laid: [name, run-off kind, material, tile, which samples, the stripes' material].
        const surfaces = [
            ['grass', 0, lawn, lawnTile, () => true, null],
            ['gravel', 1, gravelMat, 2.6, (i) => !beach(i), null],
            ['sand', 1, sandMat, 4, beach, null],
            ['tarmac', 2, runMat, 4.5, (i) => !court(i), redMat],
            ['court', 2, runMat, 4.5, court, blueMat],
        ];
        for (const side of [-1, 1]) {
            const inner = (i) => t.hw[i] - 0.5;   // tucked under the tarmac's edge
            const outer = (i) => t.hw[i] + runOffAt(t, i, side) + 3;
            const from = side < 0 ? (i) => -outer(i) : inner;
            const to = side < 0 ? (i) => -inner(i) : outer;
            for (const [name, kind, mat, matTile, where, stripeMat] of surfaces) {
                const pick = (i) => t.drawn(i) && t.runoffAt(i, side) === kind && where(i);
                let any = false;
                for (let i = 0; i < t.count && !any; i++) any = pick(i);
                if (!any) continue;
                const mesh = new THREE.Mesh(ribbon(t, from, to, 0.012, 45, pick, { worldTile: matTile }), mat);
                mesh.name = `pocabinet-runoff-${name}`;
                mesh.receiveShadow = true;
                mesh.castShadow = name === 'court';   // the deck over the scan, like the road
                group.add(mesh);
                if (!stripeMat) continue;
                // Track limits: a painted band along the edge of the tarmac run-off.
                const a = side < 0 ? (i) => -(t.hw[i] + 5) : (i) => t.hw[i] + 0.5;
                const b = side < 0 ? (i) => -(t.hw[i] + 0.5) : (i) => t.hw[i] + 5;
                const band = new THREE.Mesh(ribbon(t, a, b, 0.022, 24, pick), stripeMat);
                band.receiveShadow = true;
                group.add(band);
            }
        }
    }

    buildGrass() {
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
        }
        this.grass = null;
        const blades = GRASS_BLADES[this.quality] || 0;
        if (!this.track || !blades) return;
        try {
            this.grass = new Grass(this.track, hex(this.baseAtmosphere?.groundHex, '#2a3a24'), blades, {
                keepOut: models.scanRing(this.track), terrain: this.terrain,
            });
            this.scene.add(this.grass.mesh);
        } catch (e) {
            this.grass = null;
            console.warn('pocabinet/scene: grass skipped', e);
        }
    }

    syncRoomSplat() {
        return models.syncRoomSplat(this);
    }

    /** 'auto', 'splat' (full) or 'mesh' (lite) for the court scan: swaps it live. */
    setRoomDetail(detail) {
        return models.setRoomDetail(this, detail);
    }

    disposeTrackMeshes() {
        models.disposeRoomSplat(this);
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
            this.grass = null;
        }
        if (!this.trackGroup) return;
        this.scene.remove(this.trackGroup);
        this.scenery?.dispose();
        this.trackside?.dispose();
        this.trackside = null;
        this.terrain?.dispose();
        this.terrain = null;
        this.runoffMats = null;
        disposeObject(this.trackGroup);
        for (const t of this.ownedTextures) t.dispose();
        this.ownedTextures = [];
        this.trackGroup = null;
        this.roadMesh = null;
        this.scenery = null;
        this.sky = null;
        this.envSky?.dispose();
        this.envSky = null;
    }

    /** Re-measure the canvas now (the stage also does it on every resize). */
    resize() {
        if (!this.disposed) this.stage.resize();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.stopLoop();
        this._frameCbs.clear();
        this.disposeTrackMeshes();
        this.setRainStreaks(false);
        this.board?.dispose();
        this.board = null;
        this.lightRig?.restore();
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.sunShadows?.dispose();
        this.sunShadows = null;
        this.post?.dispose();
        this.post = null;
        // The stage disposes the renderer and hands its GL context back.
        this.stage.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Geometry builders. Lateral offsets are sim units (+ = right of travel).
// ──────────────────────────────────────────────────────────────────────────









// ──────────────────────────────────────────────────────────────────────────
//  Public mount / unmount.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mount the scene on a canvas.
 * @param {HTMLCanvasElement|string} canvas the element, or its DOM id — Blazor's
 *        IJSRuntime does not marshal ElementReference as a live element.
 * @param {{ atmosphere: object, centerXY: number[], trackWidth: number,
 *           minX: number, minY: number, maxX: number, maxY: number }} world
 */
export async function mount(canvas, world) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas) throw new Error('pocabinet/scene: canvas element is required');
    if (!world || !world.atmosphere) throw new Error('pocabinet/scene: world is required');

    // Tone mapping is the post pass's (it falls back to ACES below without one).
    // PostFx owns its own offscreen pass + FXAA/TRAA, so canvas MSAA / preserveDrawingBuffer
    // would only double VRAM without improving the picture.
    // r186 WebGPURenderer: the WebGPU backend where an adapter exists, else its own WebGL2 backend (the build
    // has no WebGLRenderer). `?cabwebgl` forces the WebGL2 backend, for comparing the two.
    const gpu = await webgpuAvailable();
    const renderer = await createRenderer(THREE, { api: 'webgpu', canvas, antialias: false, preserveDrawingBuffer: false, tone: 'none', forceWebGL: !gpu || /[?&]cabwebgl/.test(location.search) });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 5000);
    camera.position.set(0, 3, 0);
    scene.add(camera);

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a4a2a, HEMI_BASE);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, SUN_BASE);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_SIZE.high, SHADOW_SIZE.high);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
    sc.near = 1; sc.far = 220;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);

    // Boot-time cascaded + contact-hardening PCSS sun shadows (platform/3d/shadows.js).
    let sunShadows = null;
    try {
        const tier = appTier();
        sunShadows = applySunShadows(POST_LIB, sun, {
            tier,
            cascades: 2,
            maxFar: 185,
            splits: [0.22],
            lightMargin: 45,
            pcss: { lightAngle: 0.055, blockerSamples: 8, filterSamples: 12, searchTexels: 7, maxTexels: 9 },
            renderer,
        });
    } catch (e) {
        console.warn('pocabinet/scene: CSM/PCSS shadows unavailable, using single shadow map', e);
    }

    const handle = new SceneHandle(renderer, scene, camera, hemi, sun, canvas);
    handle.sunShadows = sunShadows;
    try {
        handle.post = new PostFx(renderer);
    } catch (e) {
        handle.post = null;   // no post pass: the scene renders straight to the canvas
        configureRenderer(THREE, renderer, { tone: 'aces' });
        console.warn('pocabinet/scene: post-processing unavailable', e);
    }
    handle.applyTier(appTier());
    handle.setTrack(world);
    const start = handle.track.pointAt(-40);
    handle.setView({ x: start.x, y: start.y, h: handle.track.heightAt(-40) / WORLD_SCALE, heading: Math.atan2(start.ty, start.tx), mode: 'chase', snap: true });
    handle.resize();
    handle.startLoop();
    return handle;
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

