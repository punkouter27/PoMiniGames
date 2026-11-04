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
//   • ground (grass, or a plaza on Press Briefing): a terrain heightfield (terrain.js) that
//     lies on the road's plane under the road and its run-off and rolls away into hills
//     beyond the barriers, sized past the fog
//   • asphalt ribbon as wide as the road is at each sample (track.hw), painted edge lines,
//     a chequered start line
//   • the run-off either side: lawn, a gravel trap (beach sand at Mar-a-Lago) or tarmac
//     run-off with painted track-limit stripes, as deep as physics.js makes it (runOffAt)
//   • barrier walls with a striped face, exactly where physics.js stops a car (wallAt),
//     following the road's height and bank
//   • patches, the rubbered-in racing line, road dividers with their JOKER signs, braking
//     boards and corner numbers (trackside.js)
//   • sky dome (sky.js) and trackside scenery (scenery.js), dressed by track.theme
//   • Playground only: the imported playground.glb (see PLAYGROUND)
//   • Bedroom Floor GP: the imported bedroom.glb, a scanned room the road is laid in (see ROOM)
//
// World mapping: sim (x, y) → three (x / 10, h, y / 10). h is the road's height (track.z,
// tilted across by track.bank) on the road and its run-off out to the barriers, and the
// terrain's height (groundHeight) everywhere else. The Playground run keeps its own staging:
// the part of the loop that is only a return link (track.drawn) is not built at all, tarmac
// is only laid from track.roadFrom on (track.built; before it, an open chute), the run-off
// is a deck in the air, there are no barrier walls and the lawn is flat.
//
// Camera: third person only. 'chase' (close), 'far' (high and
// long) and 'tv' (trackside cameras handing off along the lap).
//
// Quality follows the app's tier (qualityTiers.js, window.PoQuality: the player's choice in
// Settings, else what the device can take): a mount starts there and a change of it applies at
// once. Under it, the loop watches the frame rate and steps the pixel ratio, bloom depth,
// shadow map and grass down a tier after a sustained dip below 45 fps; it never steps back up
// on its own mid-race.
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
//   handle.setPip(pose | null)   — demo broadcast inset; handle.pipRect says where it landed
//   unmount(handle);

import * as THREE from 'three';
import { buildTrack } from './track.js';
import { RUN_OFF, runOffAt } from './physics.js';
import { computeKerbs } from './kerbs.js';
import { Sky } from './sky.js';
import { Scenery } from './scenery.js';
import { PostFx } from './postfx.js';
import { Grass } from './grass.js';
import { asphalt, grass as grassTextures, macro, clock, reflective } from './materials.js';
import { Terrain, themeOf, isPlayground, isRoom, wallFace } from './terrain.js';
import { Trackside } from './trackside.js';
import { gravel, sand, limitStripes } from './surfaces.js';
import { WORLD_SCALE, roadPlane, canvasTexture } from './util.js';

const SUN_BASE = 3.2;
const HEMI_BASE = 0.7;
const ENV_BASE = 0.85;
const SHADOW_EXTENT = 38;
const GRASS_BLADES = { low: 0, medium: 14000, high: 36000 };
const SHADOW_SIZE = { low: 1024, medium: 1536, high: 2048 };

/** Reduced motion: <html data-motion> (the OS preference or the app's settings switch). */
const calm = () => document.documentElement.dataset.motion === 'reduce';

function hex(value, fallback) {
    try { return new THREE.Color(value || fallback); } catch { return new THREE.Color(fallback); }
}

const RENDER_SCALE = { low: 0.6, medium: 0.8, high: 1 };

/** The app's quality tier (qualityTiers.js), or 'high' where it is not loaded. */
function appTier() {
    const t = window.PoQuality?.tier?.();
    return RENDER_SCALE[t] ? t : 'high';
}

// Mounted scenes follow a change of the app's tier. PoQuality has no unsubscribe, so one
// listener serves every mount and a disposed scene leaves the set.
const liveScenes = new Set();
let tierListening = false;
function followAppTier(handle) {
    liveScenes.add(handle);
    if (tierListening || !window.PoQuality?.onChange) return;
    tierListening = true;
    window.PoQuality.onChange(() => {
        const t = appTier();
        for (const h of liveScenes) h.applyTier(t);
    });
}
const PIP_WIDTH = 0.26;   // of the canvas width

// Playground Marble Run: wwwroot/models/playground.glb (metres, +Y up) drawn at 50× around
// the world origin, so 1 model metre = 50 scene units = 500 sim units — the scale the track's
// knots in PoCabinetTrackGeometry were baked at, and the one at which the marble gutter's
// 26 cm floor is as wide as the physics corridor (road + run-off). The track is the marble
// run, without its walls (the gutter's sides would stand eight units
// tall around a one-unit car and hide the rest of the scene). So the model's gutter is hidden
// and, down to track.roadFrom, the scene lays an open chute in its place: the gutter's
// floor, same width, same bank, on the same supports, with two edge lines. From there on
// the gutter has ended at the drop well (marbles fall; cars get a ramp) and the scene builds
// a road: the ramp, down the slide, into the finish tray — tarmac and run-off deck. No
// barriers anywhere; the physics still stops a car at the edge. The well and the four
// marbles are hidden too. Render-only (neither physics copy knows the model exists). Loaded
// async after the track is built; if it fails the race runs on the chute over a plain lawn.
const PLAYGROUND = {
    url: 'models/playground.glb',
    scale: 50,
    hidden: /^SM_Marble(Track|DropWell|_\d)/,
    chuteHex: '#2f86d6',
    // Outline (model metres, x/z) of everything it puts on the ground — pad, posts, slide,
    // marble-run supports and tray — kept free of grass blades.
    footprint: [
        6.9, 0.6, 7.49, 1.99, 7.22, 3.38, 6.52, 4.62, 5.26, 5.36, 3.58, 5.21, 2.3, 4.94, 1.32, 4.71,
        0.5, 5, -0.5, 5.63, -1.49, 5.4, -2.43, 4.98, -3.41, 4.51, -4.32, 3.82, -5.27, 2.99, -6.05, 1.9,
        -6.2, 0.6, -6.07, -0.71, -5.92, -2.06, -5.26, -3.25, -4.21, -4.11, -2.73, -4.24, -1.54, -4.32, -0.48, -4.34,
        0.5, -4.1, 1.26, -3.22, 2.03, -3.09, 3.1, -3.3, 3.96, -2.86, 4.81, -2.28, 5.51, -1.48, 5.86, -0.47,
    ],
};
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/';

// Bedroom Floor GP: wwwroot/models/bedroom.glb, a scanned bedroom that
// scripts/blender/pocabinet-bedroom.py stands up (floor on y = 0), cuts the ceiling off,
// decimates and checks the route against. It is in the scan's room units (~4.3 to the metre),
// drawn at 15x: 150 sim units per room unit, the scale the track's knots were printed at, so a
// car is a ~4 cm toy on the carpet. The scan is unlit (its textures carry the room's own light)
// and single-sided, so a camera outside a wall sees through it. The road is the toy track: orange
// plastic decked out to the rails and standing on stilts wherever it is off the carpet (the whole
// lap, ~4 ft up), and the scene's sun reaches the room only through a shadow catcher on the floor.
// Render-only; if the model fails the race runs on a plain carpet-coloured floor.
const ROOM = {
    url: 'models/bedroom.glb',
    scale: 15,
    carpetHex: '#7b7166',
    lift: 1.15,           // the scan's colours, brightened for the post pass's grade and vignette
    deckFrom: 8,         // sim height past which the road is off the carpet: decked, on stilts
};

/** Sim-unit ring of the model's footprint, or null on tracks without a model. */
function keepOutFor(trackId) {
    return trackId === 'playground' ? PLAYGROUND.footprint.map(v => v * PLAYGROUND.scale * WORLD_SCALE) : null;
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
        this.track = null;
        this.trackGroup = null;
        this.groundMesh = null;
        this.roadMesh = null;
        this.terrain = null;      // terrain.js (every track but the Playground)
        this.trackside = null;    // trackside.js
        this.runoffMats = null;   // gravel / tarmac run-off materials, wetted by setWeather
        this.roadRefl = { value: 0.02 };   // the road's reflectivity for postfx.js, set by setWeather
        this.theme = 'capitol';
        this.playground = false;
        this.room = false;        // a road laid in a scanned room (isRoom): the model is the world
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
        this.rain = null;         // the falling-rain streaks while it rains (setRainStreaks)
        this.fx = {
            speed: 0, rain: 0, flash: 0, slow: 0,
            shake: 0, rumble: 0, reduced: false, focus: null,
            exposure: 1, bloom: 0.7, bloomThreshold: 1, sun: null, sunColor: new THREE.Color(1, 0.9, 0.75),
        };
        this.baseAtmosphere = null;
        this._frameCbs = new Set();
        this._raf = null;
        this._lastNow = null;
        this._tvIndex = -1;
        this._chase = new THREE.Vector3();
        this._chaseLook = new THREE.Vector3();
        this._chaseInit = false;
        this._v = new THREE.Vector3();
        this.pip = null;
        this.pipRect = null;
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    /** Register a per-frame callback (receives a DOMHighResTimeStamp). */
    onFrame(cb) {
        if (!this.disposed && typeof cb === 'function') this._frameCbs.add(cb);
    }

    offFrame(cb) {
        this._frameCbs.delete(cb);
    }

    startLoop() {
        if (this._raf !== null) return;
        const loop = (now) => {
            if (this.disposed) return;
            this._raf = requestAnimationFrame(loop);
            const dt = this._lastNow === null ? 0 : Math.min(0.1, (now - this._lastNow) / 1000);
            this._lastNow = now;
            clock.value = now / 1000;
            for (const cb of this._frameCbs) {
                try { cb(now); } catch { /* one bad effect never kills the frame */ }
            }
            this.autoQuality(dt);
            try {
                this.applyFx(dt);
                this.updateRain(dt);
                this.followShadow();
                this.grass?.update(this.camera);
                this.sky?.update(this.camera, this.scene.fog, now / 1000);
                this.scenery?.update(dt, this.fx.focus);
                this.updateSunScreen();
            } catch { /* decoration never kills the frame */ }
            if (this.post) this.post.render(this.scene, this.camera, this.fx, now / 1000);
            else this.renderer.render(this.scene, this.camera);
            if (this.pip) {
                try { this.renderPip(); } catch { this.pipRect = null; }
            }
        };
        this._raf = requestAnimationFrame(loop);
    }

    stopLoop() {
        if (this._raf !== null) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
    }

    /**
     * Place the camera for a car pose. mode: 'chase' | 'far' | 'tv'.
     * Car forward = (cos h, 0, sin h) in three's x/z.
     */
    setView(p) {
        if (this.disposed || !p) return;
        const x = (Number(p.x) || 0) / WORLD_SCALE;
        const z = (Number(p.y) || 0) / WORLD_SCALE;
        const heading = Number(p.heading) || 0;
        const mode = p.mode || 'chase';
        const fx = Math.cos(heading), fz = Math.sin(heading);
        // Road height under the car and its slope (both 0 on a flat track): the camera sits
        // back up the slope and looks down it, so a descent reads as one.
        const h = Number(p.h) || 0;
        const rise = Math.tan(Number(p.pitch) || 0);
        if (mode === 'chase' || mode === 'far') {
            const far = mode === 'far';
            const s01 = Math.min(1, Math.abs(Number(p.speed) || 0) / 140);
            const back = (far ? 13 : 7.4) + s01 * (far ? 2 : 1.6);
            const up = (far ? 5.2 : 2.35) + s01 * 0.25;
            const target = this._v.set(x - fx * back, h - rise * back + up, z - fz * back);
            // Lagged follow so the car swings in frame through corners; time-based so
            // the lag is the same at 30 fps as at 144.
            const dt = Number(p.dt) || 0;
            const k = dt > 0 ? 1 - Math.exp(-dt * (far ? 5 : 8)) : 0.18;
            const ahead = far ? 6 : 4.5;
            const look = new THREE.Vector3(x + fx * ahead, h + rise * ahead + (far ? 0.6 : 1.0), z + fz * ahead);
            if (!this._chaseInit || p.snap) {
                this._chase.copy(target);
                this._chaseLook.copy(look);
                this._chaseInit = true;
            } else {
                this._chase.lerp(target, k);
                this._chaseLook.lerp(look, 1 - Math.exp(-(dt || 0.016) * 14));
            }
            this._chase.y = Math.max(this._chase.y, h + 0.7);
            // Never inside a hillside the road cuts past.
            if (this.terrain) this._chase.y = Math.max(this._chase.y, this.terrain.worldHeight(this._chase.x * WORLD_SCALE, this._chase.z * WORLD_SCALE) + 0.6);
            this.camera.position.copy(this._chase);
            this.camera.lookAt(this._chaseLook);
            return;
        }
        // TV: fixed trackside cameras every eighth of the lap, handing off as the car passes.
        this._chaseInit = false;
        const t = this.track;
        if (!t) return;
        const along = Number(p.along) || 0;
        const idx = Math.floor(((along % t.length) + t.length) % t.length / (t.length / 8) + 0.5) % 8;
        if (idx !== this._tvIndex || !this._tvPos) {
            this._tvIndex = idx;
            // Camera 0 stands level with the start gantry, not 40 past it: from there it looked
            // back at the cars coming to the line straight through the gantry's beam.
            const at = idx * (t.length / 8) + (idx === 0 ? 2 : 40);
            const q = t.pointAt(at);
            const side = (this.playground ? t.halfWidth + RUN_OFF : wallFace(t, t.indexAt(at), 1)) + 30;
            const gx = q.x - q.ty * side, gy = q.y + q.tx * side;
            // On its mast on the ground, or (in the air, the Playground) at the road's height.
            const road = t.heightAt(at) / WORLD_SCALE;
            const ground = this.terrain ? Math.max(road, this.terrain.worldHeight(gx, gy)) : road;
            this._tvPos = new THREE.Vector3(gx / WORLD_SCALE, 7 + ground, gy / WORLD_SCALE);
        }
        this.camera.position.copy(this._tvPos);
        this.camera.lookAt(x, h + 0.6, z);
    }

    /**
     * Picture in picture (the demo's broadcast.js): a camera on a car's roof, looking ahead or
     * (back) behind, drawn into a corner of the canvas after the main frame. p = a car pose
     * { x, y, heading, h, pitch, back } in sim units, or null for none.
     */
    setPip(p) {
        this.pip = p || null;
        if (!this.pip) this.pipRect = null;
    }

    /**
     * The PiP pass: an HDR frame of its own, tone-mapped into a corner of the canvas by the post
     * pass (postfx.js drawInset; without one, straight to the canvas through a scissor with the
     * renderer's tone mapping), reusing this frame's shadow map. Left out on the low
     * tier, where the frame has no time for a second scene, and on a narrow canvas, where the
     * inset would be too small to read. pipRect (canvas CSS px from the top left) tells the
     * page where to put the frame and label, or null when nothing was drawn.
     */
    renderPip() {
        const r = this.renderer;
        const size = r.getSize(this._pipSize || (this._pipSize = new THREE.Vector2()));
        if (this.quality === 'low' || size.x < 560) { this.pipRect = null; return; }
        const p = this.pip;
        const w = Math.round(size.x * PIP_WIDTH), h = Math.round(w * 9 / 16);
        const m = Math.round(Math.max(8, size.x * 0.012));
        const x = size.x - w - m, y = m;   // bottom right (the viewport counts y from the bottom)
        const cam = this.pipCamera || (this.pipCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 2000));
        if (Math.abs(cam.aspect - w / h) > 1e-3) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
        const cx = (Number(p.x) || 0) / WORLD_SCALE, cz = (Number(p.y) || 0) / WORLD_SCALE;
        const ground = Number(p.h) || 0;
        const rise = Math.tan(Number(p.pitch) || 0);
        const dir = p.back ? -1 : 1;
        const fx = Math.cos(Number(p.heading) || 0) * dir, fz = Math.sin(Number(p.heading) || 0) * dir;
        // Above the roof line of the tallest body (the van's, 1.42), a touch towards the view.
        cam.position.set(cx + fx * 0.6, ground + 1.75 + rise * 0.6 * dir, cz + fz * 0.6);
        const ahead = p.back ? 14 : 30;
        cam.lookAt(cx + fx * ahead, ground + rise * ahead * dir + (p.back ? 0.9 : 1.1), cz + fz * ahead);

        // Through the post pass when there is one: drawn into a linear HDR target, the inset uses
        // the very programs the main pass compiled (drawn straight to the canvas with tone mapping,
        // every material needs a second variant, and compiling ~25 of them the moment the demo's
        // PiP first appears froze the start for seconds), then tone-mapped into its corner.
        if (this.post) {
            const shadows = r.shadowMap.autoUpdate;
            r.shadowMap.autoUpdate = false;
            try {
                this.post.drawInset(this.scene, cam, x, y, w, h, this.fx.exposure || 1);
            } finally {
                r.shadowMap.autoUpdate = shadows;
            }
            this.pipRect = { x, y: size.y - y - h, w, h };
            return;
        }
        const tone = r.toneMapping, exposure = r.toneMappingExposure, shadows = r.shadowMap.autoUpdate;
        r.setRenderTarget(null);
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = this.fx.exposure || 1;
        r.shadowMap.autoUpdate = false;
        r.setScissorTest(true);
        r.setScissor(x, y, w, h);
        r.setViewport(x, y, w, h);
        try {
            r.render(this.scene, cam);
        } finally {
            r.setScissorTest(false);
            r.setViewport(0, 0, size.x, size.y);
            r.toneMapping = tone;
            r.toneMappingExposure = exposure;
            r.shadowMap.autoUpdate = shadows;
        }
        this.pipRect = { x, y: size.y - y - h, w, h };
    }

    /**
     * Speed FOV kick + camera shake, applied after setView has placed the camera
     * for this frame (setView fully re-places it next frame, so nothing accumulates).
     */
    applyFx(dt) {
        const fx = this.fx;
        const motion = !fx.reduced;
        const fov = this.baseFov + (motion ? Math.pow(Math.min(1, fx.speed), 1.6) * 8 : 0);
        const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
        const next = this.camera.fov + (fov - this.camera.fov) * k;
        if (Math.abs(next - this.camera.fov) > 0.01) {
            this.camera.fov = next;
            this.camera.updateProjectionMatrix();
        }
        const amp = motion ? Math.min(1, fx.shake + fx.rumble * 0.35) : 0;
        if (amp > 0.002) {
            const r = () => Math.random() - 0.5;
            this.camera.position.x += r() * 0.06 * amp;
            this.camera.position.y += r() * 0.08 * amp;
            this.camera.rotateX(r() * 0.012 * amp);
            this.camera.rotateZ(r() * 0.016 * amp);
        }
        const decay = dt > 0 ? Math.exp(-dt * 7) : 1;
        fx.shake *= decay;
        fx.flash *= dt > 0 ? Math.exp(-dt * 4.5) : 1;
        if (fx.flash < 0.004) fx.flash = 0;
    }

    /** Keep the sun's shadow frustum centred on the action, snapped to texels (no shimmer). */
    followShadow() {
        if (!this.sun.castShadow) return;
        const f = this.fx.focus;
        const cx = f ? f.x : this.camera.position.x;
        const cz = f ? f.z : this.camera.position.z;
        const cy = (f && f.y) || 0;   // the road's height under the car in focus
        const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
        const sx = Math.round(cx / texel) * texel, sz = Math.round(cz / texel) * texel;
        this.sun.target.position.set(sx, cy, sz);
        this.sun.position.set(sx + this.sunDir.x * 90, cy + this.sunDir.y * 90, sz + this.sunDir.z * 90);
    }

    /** Sun position on screen for the glare/shafts, and how visible it is. */
    updateSunScreen() {
        const vis = this.sunVisibility;
        if (!(vis > 0.01) || !this.sunDirVisual) { this.fx.sun = null; return; }
        const p = this._v.copy(this.sunDirVisual).multiplyScalar(1000).add(this.camera.position).project(this.camera);
        const facing = this.camera.getWorldDirection(new THREE.Vector3()).dot(this.sunDirVisual);
        if (p.z >= 1 || facing <= 0) { this.fx.sun = null; return; }
        const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
        const fade = Math.max(0, 1 - Math.max(0, edge - 0.85) / 0.35);
        this.fx.sun = { x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, v: vis * fade };
    }

    /** Apply player view preferences (reduced motion is the platform's). */
    applyView() {
        if (this.disposed) return;
        this.fx.reduced = calm();
    }

    /** Step quality down a tier after ~3 s averaging under 45 fps (see the header). */
    autoQuality(dt) {
        const f = this.fps;
        if (!(dt > 0) || this.quality === 'low') return;
        f.frames++;
        f.time += dt;
        if (f.time < 1) return;
        const rate = f.frames / f.time;
        f.frames = 0;
        f.time = 0;
        f.slow = rate < 45 ? f.slow + 1 : 0;
        if (f.slow < 3) return;
        this.applyTier(this.quality === 'high' ? 'medium' : 'low');
    }

    /** Switch the whole frame to tier `q`: pixel ratio, bloom depth, shadow map, grass. */
    applyTier(q) {
        if (this.disposed || !RENDER_SCALE[q]) return;
        this.fps.slow = 0;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE[q]);
        this.setQuality(q);
        this.resize();
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

    /** World height of the ground under a sim point (the road's height on the Playground's flat lawn: 0). */
    groundHeight(xSim, ySim) {
        return this.terrain ? this.terrain.worldHeight(xSim, ySim) : 0;
    }

    /** Re-render the sky dome into a PMREM cube for image-based lighting and reflections. */
    captureEnvironment() {
        if (!this.sky) return;
        try {
            if (!this.envSky) {
                this.envSky = new Sky(this.theme);
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
        this.playground = isPlayground(t);
        this.room = isRoom(t);
        // Where a model is the world (the Playground, the bedroom) the scene adds no terrain,
        // trackside props or grass of its own.
        const modelWorld = this.playground || this.room;
        const group = new THREE.Group();
        group.name = 'pocabinet-track';
        const plaza = this.theme === 'pressbriefing';

        // Ground: reaches past the fog's far edge so it fades into the sky's horizon. A terrain
        // that follows the road everywhere but the Playground, whose lawn is flat.
        const reach = (Number(atmosphere.fogEnd) || 900) * 1.3;
        const tile = plaza ? 5 : 7;
        const tex = plaza ? asphalt() : grassTextures();
        const groundMat = macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.groundHex, '#2a3a24'), roughness: plaza ? 0.75 : 0.95, metalness: 0,
            map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
            roughnessMap: plaza ? tex.roughnessMap : null,
        }), plaza ? 40 : 70, plaza ? 0.15 : 0.35);
        let ground = null;
        if (!modelWorld) {
            try {
                this.terrain = new Terrain(t, this.theme);
                ground = this.terrain.mesh(groundMat, reach, tile);
            } catch (e) {
                this.terrain = null;
                console.warn('pocabinet/scene: terrain skipped', e);
            }
        }
        if (!ground && this.room) {
            // Under the scan's floor (it dips to -0.07): shows only through holes in the scan.
            ground = flatGround(world, new THREE.MeshStandardMaterial({ color: ROOM.carpetHex, roughness: 1, metalness: 0 }), reach, tile);
            ground.position.y = -0.2;
        }
        if (!ground) ground = flatGround(world, groundMat, reach, tile);
        group.add(ground);
        this.groundMesh = ground;

        const hw = t.halfWidth;
        const tar = asphalt();
        const built = (i) => t.built(i);
        // The Playground keeps the straight-up normals it always had; a hill shades as one.
        const flat = this.playground;
        // The bedroom's road is a toy track: smooth moulded plastic, not tarmac.
        const roadMat = this.room
            ? new THREE.MeshStandardMaterial({ color: hex(atmosphere.roadHex, '#d9581a'), roughness: 0.55, metalness: 0, side: THREE.DoubleSide })
            : reflective(macro(new THREE.MeshStandardMaterial({
                color: hex(atmosphere.roadHex, '#393b42'), roughness: 1, metalness: 0,
                map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughnessMap: tar.roughnessMap,
                side: THREE.DoubleSide,
            }), 30, 0.2), this.roadRefl);
        this.roadMesh = new THREE.Mesh(ribbon(t, (i) => -t.hw[i], (i) => t.hw[i], 0.02, 45, built, { flat }), roadMat);
        this.roadMesh.receiveShadow = true;
        group.add(this.roadMesh);
        if (this.playground) {
            // A road in the air has no lawn beside it: deck the run-off out to where a car is stopped.
            if (t.z) {
                const deckMat = new THREE.MeshStandardMaterial({
                    color: hex(atmosphere.groundHex, '#2a3a24').multiplyScalar(0.8), roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
                });
                for (const [a, b] of [[-hw - RUN_OFF, -hw], [hw, hw + RUN_OFF]]) {
                    const deck = new THREE.Mesh(ribbon(t, a, b, 0.02, 45, built, { flat }), deckMat);
                    deck.receiveShadow = true;
                    deck.castShadow = true;
                    group.add(deck);
                }
                this.roadMesh.castShadow = true;
            }
            // Where the track stands in for a model's gutter (Playground): the gutter's floor
            // without its walls, as wide as the tarmac and run-off together, the run-off a shade
            // darker. Three strips that meet under the edge lines, not one: where the bank
            // changes a strip twists, and a line laid on a wider strip dips through it.
            if (t.roadFrom) {
                const out = hw + RUN_OFF + 8;   // a car stopped at the edge keeps its wheels on it
                const onChute = (i) => t.drawn(i) && !built(i);
                for (const [a, b, shade] of [[-out, -hw, 0.72], [-hw, hw, 1], [hw, out, 0.72]]) {
                    const chute = new THREE.Mesh(ribbon(t, a, b, 0.02, 45, onChute, { flat }), new THREE.MeshStandardMaterial({
                        color: hex(PLAYGROUND.chuteHex, '#2f86d6').multiplyScalar(shade), roughness: 0.55, metalness: 0, side: THREE.DoubleSide,
                    }));
                    chute.receiveShadow = true;
                    chute.castShadow = true;
                    group.add(chute);
                }
            }
        } else if (this.room) {
            this.buildRoomTrack(group, atmosphere);
        } else {
            this.buildRunoff(group, atmosphere, groundMat, tile);
        }

        // Edge lines on the tarmac, then the barriers where physics puts the wall.
        const lineMat = new THREE.MeshStandardMaterial({
            color: 0xe8e8e8, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        // On the Playground's chute the lines are all that marks the tarmac: outside them is
        // run-off, which drags like grass.
        for (const [a, b] of [[(i) => -t.hw[i], (i) => -t.hw[i] + 2.2], [(i) => t.hw[i] - 2.2, (i) => t.hw[i]]]) {
            const line = new THREE.Mesh(ribbon(t, a, b, 0.03, 45, undefined, { flat }), lineMat);
            line.receiveShadow = true;
            group.add(line);
        }
        // physics.js stops a car's centre at wallAt (hw + run-off depth - CAR_RADIUS/2); its
        // flank is half a car width further out, so that is where the barrier face belongs.
        // The Playground run has none: in its gutter the gutter's own sides are the wall, and
        // on its ramp and slide the edge of the deck is. The physics still stops a car there.
        const barrierMat = new THREE.MeshStandardMaterial({
            map: barrierTexture(atmosphere.accentHex), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
        });
        for (const s of this.playground ? [] : [-1, 1]) {
            const wallMesh = new THREE.Mesh(barrier(t, (i) => s * wallFace(t, i, s), s, 0.7, 2.5), barrierMat);
            wallMesh.castShadow = true;
            wallMesh.receiveShadow = true;
            group.add(wallMesh);
        }

        group.add(startLine(t));

        if (!modelWorld) {
            try {
                this.trackside = new Trackside(t, { theme: this.theme, terrain: this.terrain, atmosphere });
                group.add(this.trackside.group);
            } catch (e) {
                this.trackside = null;
                console.warn('pocabinet/scene: trackside skipped', e);
            }
        }

        try {
            this.sky = new Sky(this.theme);
            group.add(this.sky.mesh);
            this.sunDir = new THREE.Vector3(...this.sky.preset.sun).normalize();
            const light = this.sky.lightDirection();
            this.sunDir.copy(light);
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
                ...world, kerbs: computeKerbs(t), theme: this.theme, terrain: this.terrain, playground: modelWorld,
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
        if (t.id === 'playground') this.loadPlayground(group);
        else if (this.room) this.loadRoom(group);
    }

    /**
     * The bedroom's toy track off the carpet: where the road climbs (track.z past ROOM.deckFrom)
     * the run-off is decked in darker plastic out to the barrier and the deck stands on stilts
     * down to the floor (on the cushion they stand inside it). Plus a shadow catcher on the floor,
     * so the cars, road and rails throw shadows onto the unlit scan.
     */
    buildRoomTrack(group, atmosphere) {
        const t = this.track;
        const n = t.count;
        const up = (i) => !!t.z && Math.min(t.z[i], t.z[(i + 1) % n]) > ROOM.deckFrom;
        const deckMat = new THREE.MeshStandardMaterial({
            color: hex(atmosphere.roadHex, '#d9581a').multiplyScalar(0.62), roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
        });
        for (const [a, b] of [[(i) => -wallFace(t, i, -1), (i) => -t.hw[i]], [(i) => t.hw[i], (i) => wallFace(t, i, 1)]]) {
            const deck = new THREE.Mesh(ribbon(t, a, b, 0.015, 45, (i) => t.drawn(i) && up(i)), deckMat);
            deck.castShadow = true;
            deck.receiveShadow = true;
            group.add(deck);
        }
        this.roadMesh.castShadow = true;

        // Stilts: a pair every few samples under the deck's edges, floor to deck.
        const spots = [];
        for (let i = 0; i < n; i += 4) {
            if (!up(i)) continue;
            for (const s of [-1, 1]) {
                const lat = s * (wallFace(t, i, s) - 3);
                const h = roadPlane(t, i, lat) / WORLD_SCALE;
                const x = (t.x[i] - t.ty[i] * lat) / WORLD_SCALE, z = (t.y[i] + t.tx[i] * lat) / WORLD_SCALE;
                spots.push([x, h, z]);
            }
        }
        if (spots.length) {
            const stilt = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.6, 1, 10),
                new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.5, metalness: 0 }), spots.length);
            const m = new THREE.Matrix4();
            spots.forEach(([x, h, z], k) => stilt.setMatrixAt(k, m.compose(
                new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1))));
            stilt.castShadow = true;
            stilt.name = 'pocabinet-room-stilts';
            group.add(stilt);
        }

        const pad = 60;
        const xs = [], ys = [];
        for (let i = 0; i < n; i++) { xs.push(t.x[i]); ys.push(t.y[i]); }
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = (maxX - minX) / WORLD_SCALE + pad * 2, d = (maxY - minY) / WORLD_SCALE + pad * 2;
        const catcher = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
            new THREE.ShadowMaterial({ opacity: 0.32 }));
        catcher.position.set((minX + maxX) / 2 / WORLD_SCALE, 0.09, (minY + maxY) / 2 / WORLD_SCALE);
        catcher.receiveShadow = true;
        catcher.name = 'pocabinet-room-shadows';
        group.add(catcher);
    }

    /**
     * Run-off either side, per sample as deep as the physics makes it (runOffAt): the lawn
     * (the ground's own material, mapped the same, so it meets the terrain seamlessly), a
     * gravel trap (beach sand at Mar-a-Lago) or tarmac run-off with painted track-limit
     * stripes along the edge. Laid on the road's plane, a hair under the tarmac, and on under
     * the barrier.
     */
    buildRunoff(group, atmosphere, lawn, lawnTile) {
        const t = this.track;
        const beach = this.theme === 'maralago';
        const g = beach ? sand() : gravel();
        const gravelMat = macro(new THREE.MeshStandardMaterial({
            color: beach ? '#efe3c6' : '#c4b8a2', map: g.map, normalMap: g.normalMap,
            normalScale: new THREE.Vector2(beach ? 0.5 : 1, beach ? 0.5 : 1), roughness: 1, metalness: 0,
        }), 25, 0.2);
        const tar = asphalt();
        const runMat = macro(new THREE.MeshStandardMaterial({
            color: hex(atmosphere.roadHex, '#393b42').multiplyScalar(1.18).lerp(new THREE.Color('#5a6272'), 0.18),
            map: tar.map, normalMap: tar.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: tar.roughnessMap,
            roughness: 1, metalness: 0,
        }), 30, 0.2);
        const blue = this.theme === 'pressbriefing' || this.theme === 'maralago';
        const stripeMat = new THREE.MeshStandardMaterial({
            map: limitStripes(blue ? '#1f5fbf' : '#c8202a', '#f2f2f2'), roughness: 0.55, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        const dry = new Map();
        dry.set(gravelMat, { color: gravelMat.color.clone(), roughness: 1, wetShade: 0.72, wetRough: 0.6 });
        dry.set(runMat, { color: runMat.color.clone(), roughness: 1, wetShade: 0.58, wetRough: 0.32 });
        dry.set(stripeMat, { color: stripeMat.color.clone(), roughness: 0.55, wetShade: 0.8, wetRough: 0.25 });
        this.runoffMats = { dry };
        const mats = [lawn, gravelMat, runMat];
        const tiles = [lawnTile, beach ? 4 : 2.6, 4.5];
        for (const side of [-1, 1]) {
            const inner = (i) => t.hw[i] - 0.5;   // tucked under the tarmac's edge
            const outer = (i) => t.hw[i] + runOffAt(t, i, side) + 3;
            const from = side < 0 ? (i) => -outer(i) : inner;
            const to = side < 0 ? (i) => -inner(i) : outer;
            for (const kind of [0, 1, 2]) {
                const pick = (i) => t.drawn(i) && t.runoffAt(i, side) === kind;
                let any = false;
                for (let i = 0; i < t.count && !any; i++) any = pick(i);
                if (!any) continue;
                const mesh = new THREE.Mesh(ribbon(t, from, to, 0.012, 45, pick, { worldTile: tiles[kind] }), mats[kind]);
                mesh.name = `pocabinet-runoff-${['grass', 'gravel', 'tarmac'][kind]}`;
                mesh.receiveShadow = true;
                group.add(mesh);
                if (kind !== 2) continue;
                // Track limits: a painted band along the edge of the tarmac run-off.
                const a = side < 0 ? (i) => -(t.hw[i] + 5) : (i) => t.hw[i] + 0.5;
                const b = side < 0 ? (i) => -(t.hw[i] + 0.5) : (i) => t.hw[i] + 5;
                const stripes = new THREE.Mesh(ribbon(t, a, b, 0.022, 24, pick), stripeMat);
                stripes.receiveShadow = true;
                group.add(stripes);
            }
        }
    }

    /**
     * Fetch a Draco GLB and place it in `group` at `scale`, after `prepare(mesh)` has had each
     * mesh; non-fatal, and dropped if the track changed meanwhile.
     */
    async loadModel(group, url, scale, name, prepare) {
        let draco = null;
        try {
            const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
                import('three/addons/loaders/GLTFLoader.js'),
                import('three/addons/loaders/DRACOLoader.js'),
            ]);
            draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
            const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(url);
            const model = gltf.scene;
            const textures = new Set();
            model.traverse(o => {
                if (!o.isMesh) return;
                for (const m of [o.material].flat()) {
                    for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
                }
                prepare(o);
            });
            if (this.disposed || this.trackGroup !== group) {
                disposeObject(model);
                for (const t of textures) t.dispose();
                return;
            }
            model.name = name;
            model.scale.setScalar(scale);
            group.add(model);
            this.ownedTextures.push(...textures);
        } catch (e) {
            console.warn(`pocabinet/scene: ${name} skipped`, e);
        } finally {
            draco?.dispose();
        }
    }

    /**
     * The bedroom scan: unlit and single-sided as exported; it neither casts nor takes the sun's
     * shadows (the catcher does). Its textures are already the room as the camera saw it, so they
     * skip the filmic curve (which would grey them) and get a little lift for the post grade.
     */
    loadRoom(group) {
        return this.loadModel(group, ROOM.url, ROOM.scale, 'pocabinet-room', (o) => {
            o.castShadow = false;
            o.receiveShadow = false;
            for (const m of [o.material].flat()) {
                m.toneMapped = false;
                m.color?.multiplyScalar(ROOM.lift);
            }
        });
    }

    /** Fetch and place playground.glb into `group`. */
    loadPlayground(group) {
        return this.loadModel(group, PLAYGROUND.url, PLAYGROUND.scale, 'pocabinet-playground', (o) => {
            if (PLAYGROUND.hidden.test(o.name)) {
                o.visible = false;
            } else if (o.name.startsWith('SM_Ground')) {
                // The pad has ~0.36 m of relief and dips up to 0.13 m below y = 0, where the
                // scene's own lawn would cut holes in it: lift the dips to just above the lawn
                // (mounds keep their shape) and let it take shadows without casting them.
                const pos = o.geometry.attributes.position;
                for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.006) pos.setY(i, 0.006);
                pos.needsUpdate = true;
                o.geometry.computeBoundingSphere();
                o.receiveShadow = true;
            } else {
                o.castShadow = true;
                o.receiveShadow = true;
            }
        });
    }

    buildGrass() {
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
        }
        this.grass = null;
        const blades = GRASS_BLADES[this.quality] || 0;
        if (!this.track || !blades || this.theme === 'pressbriefing' || this.room) return;
        try {
            this.grass = new Grass(this.track, hex(this.baseAtmosphere?.groundHex, '#2a3a24'), blades, {
                keepOut: keepOutFor(this.track.id), terrain: this.terrain, playground: this.playground,
            });
            this.scene.add(this.grass.mesh);
        } catch (e) {
            this.grass = null;
            console.warn('pocabinet/scene: grass skipped', e);
        }
    }

    disposeTrackMeshes() {
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

    /** Match the canvas size to its CSS box; called on resize + after mount. */
    resize() {
        if (this.disposed || !this.canvas) return;
        const w = this.canvas.clientWidth || 800;
        const h = this.canvas.clientHeight || 450;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.post?.setSize();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        liveScenes.delete(this);
        window.removeEventListener('resize', this._onResize);
        this.stopLoop();
        this._frameCbs.clear();
        this.disposeTrackMeshes();
        this.setRainStreaks(false);
        this.envTarget?.dispose();
        this.pmrem.dispose();
        this.post?.dispose();
        this.post = null;
        this.renderer.dispose();
        // dispose() does not hand the context back; see pobrawl/game.js dispose().
        try { this.renderer.forceContextLoss?.(); } catch { /* context already gone */ }
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Geometry builders. Lateral offsets are sim units (+ = right of travel).
// ──────────────────────────────────────────────────────────────────────────

/** Free every geometry and material under `root` (textures are the caller's). */
function disposeObject(root) {
    root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        for (const m of [o.material].flat()) m?.dispose();
    });
}

function scaleUv(geom, su, sv) {
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
}

/**
 * The road surface's normal at sample `k` (world space): tilted back by the grade and
 * across by the bank. Straight up on a flat track.
 */
function roadNormal(track, k, out) {
    const n = track.count;
    const p = (k - 1 + n) % n, q = (k + 1) % n;
    const span = track.segLen[p] + track.segLen[k];
    const g = track.z && span > 1e-9 ? (track.z[q] - track.z[p]) / span : 0;
    const b = track.bank ? track.bank[k] : 0;
    const tx = track.tx[k], ty = track.ty[k];
    // (lateral, bank) x (forward, grade), lateral = (-ty, tx).
    return out.set(b * ty - tx * g, 1, -ty * g - b * tx).normalize();
}

/**
 * A strip between two lateral offsets (sim units; numbers, or functions of the sample for a
 * road whose width changes), following the road's height and bank; uv = (lateral, distance)
 * / tile (sim units), or world xz / opts.worldTile (world units) for a surface that has to
 * meet the terrain's mapping. `pick(i)` chooses the segments to lay (default: everything
 * but the return link). Normals follow the road's slope, or point straight up (opts.flat).
 */
function ribbon(track, fromLat, toLat, height, tile, pick = (i) => track.drawn(i), opts = {}) {
    const from = typeof fromLat === 'function' ? fromLat : () => fromLat;
    const to = typeof toLat === 'function' ? toLat : () => toLat;
    const positions = [], uvs = [], normals = [];
    const n = track.count;
    const nrm = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const x = track.x[k], y = track.y[k];
        const a = from(k), b = to(k);
        const ax = (x + nx * a) / WORLD_SCALE, az = (y + ny * a) / WORLD_SCALE;
        const bx = (x + nx * b) / WORLD_SCALE, bz = (y + ny * b) / WORLD_SCALE;
        positions.push(ax, height + roadPlane(track, k, a) / WORLD_SCALE, az, bx, height + roadPlane(track, k, b) / WORLD_SCALE, bz);
        if (opts.worldTile) {
            uvs.push(ax / opts.worldTile, az / opts.worldTile, bx / opts.worldTile, bz / opts.worldTile);
        } else {
            const v = (i === n ? track.length : track.cum[k]) / tile;
            uvs.push(a / tile, v, b / tile, v);
        }
        if (opts.flat) nrm.set(0, 1, 0);
        else roadNormal(track, k, nrm);
        normals.push(nrm.x, nrm.y, nrm.z, nrm.x, nrm.y, nrm.z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    const indices = [];
    for (let i = 0; i < n; i++) {
        if (!pick(i)) continue;
        const a0 = i * 2, a1 = i * 2 + 1, b0 = (i + 1) * 2, b1 = (i + 1) * 2 + 1;
        indices.push(a0, a1, b0, a1, b1, b0);
    }
    geom.setIndex(indices);
    return geom;
}

/** The Playground's lawn (and the fallback if the terrain fails): one flat plane past the fog. */
function flatGround(world, material, reach, tile) {
    const minX = Number(world.minX) || 0, maxX = Number(world.maxX) || 0;
    const minY = Number(world.minY) || 0, maxY = Number(world.maxY) || 0;
    const w = (maxX - minX) / WORLD_SCALE + reach * 2, d = (maxY - minY) / WORLD_SCALE + reach * 2;
    const geom = new THREE.PlaneGeometry(w, d);
    geom.rotateX(-Math.PI / 2);
    scaleUv(geom, w / tile, d / tile);
    const ground = new THREE.Mesh(geom, material);
    ground.position.set((minX + maxX) / 2 / WORLD_SCALE, 0, (minY + maxY) / 2 / WORLD_SCALE);
    ground.receiveShadow = true;
    return ground;
}

/**
 * Barrier wall: inner face at `lateral` (a number, or a function of the sample), a top, and
 * an outer face `thick` sim units further out (on side `s`), standing on the road's plane
 * (height and bank) with its foot sunk below it so no slope of the ground opens a gap.
 * uv.x runs along the lap for the striped texture.
 *
 * Where the face would stand on another part of the road (the inside of a corner tighter than
 * the wall's offset, or a stretch whose run-off reaches a neighbouring one), that piece is not
 * drawn: the physics measures its wall from the nearest point of the road, so there is no wall
 * there, and cars used to drive straight through one standing across the track.
 */
function barrier(track, lateral, s, height, thick) {
    const lat = typeof lateral === 'function' ? lateral : () => lateral;
    const positions = [], uvs = [];
    const n = track.count;
    const onRoad = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
        const face = lat(k);
        const pr = track.project(track.x[k] - track.ty[k] * face, track.y[k] + track.tx[k] * face, -1);
        if (Math.abs(pr.lateral) < track.hwAt(pr.index) + 1) onRoad[k] = 1;
    }
    const rows = [[0, -0.3], [0, height], [s * thick, height], [s * thick, -1.2]];
    const vs = [0, 0.8, 0.9, 1];
    for (let i = 0; i <= n; i++) {
        const k = i % n;
        const nx = -track.ty[k], ny = track.tx[k];
        const u = (i === n ? track.length : track.cum[k]) / 80;
        const face = lat(k);
        // The top follows the plane at the face, so the wall stands level across its thickness.
        const base = roadPlane(track, k, face) / WORLD_SCALE;
        rows.forEach(([dl, h], r) => {
            const l = face + dl;
            positions.push((track.x[k] + nx * l) / WORLD_SCALE, base + h, (track.y[k] + ny * l) / WORLD_SCALE);
            uvs.push(u, vs[r]);
        });
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const idx = [];
    for (let i = 0; i < n; i++) {
        if (onRoad[i] || onRoad[(i + 1) % n]) continue;
        for (let r = 0; r < 3; r++) {
            const a0 = i * 4 + r, a1 = i * 4 + r + 1, b0 = (i + 1) * 4 + r, b1 = (i + 1) * 4 + r + 1;
            idx.push(a0, a1, b0, a1, b1, b0);
        }
    }
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return geom;
}

const barrierTextures = new Map();
function barrierTexture(accentHex) {
    const key = accentHex || '#c6a35a';
    if (barrierTextures.has(key)) return barrierTextures.get(key);
    const tex = canvasTexture(256, 64, (g) => {
        for (let i = 0; i < 4; i++) {
            g.fillStyle = i % 2 ? '#e9e6df' : key;
            g.fillRect(i * 64, 0, 64, 52);
        }
        g.fillStyle = '#3a3c40';
        g.fillRect(0, 52, 256, 12);
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(0, 0, 256, 4);
    }, { repeat: 's', anisotropy: 8 });
    barrierTextures.set(key, tex);
    return tex;
}

/** Chequered strip across the road where a lap ends: distance 0 on a circuit, the finish of a point-to-point run. */
function startLine(track) {
    const group = new THREE.Group();
    const p = track.pointAt(track.lapLength);
    const y0 = 0.035 + track.heightAt(track.lapLength) / WORLD_SCALE;
    const bank = track.bankAt(track.lapLength);
    const cols = 12, rows = 2, hw = track.hw[track.indexAt(track.lapLength)];
    const cell = (hw * 2) / cols;
    const geom = new THREE.PlaneGeometry(cell / WORLD_SCALE, cell / WORLD_SCALE);
    geom.rotateX(-Math.PI / 2);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.55 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = -hw + cell * (c + 0.5);
            const fwd = (r - 0.5) * cell;
            const m = new THREE.Mesh(geom, (r + c) % 2 === 0 ? white : black);
            m.position.set(
                (p.x + -p.ty * lat + p.tx * fwd) / WORLD_SCALE,
                y0 + bank * lat / WORLD_SCALE,
                (p.y + p.tx * lat + p.ty * fwd) / WORLD_SCALE);
            m.rotation.y = -Math.atan2(p.ty, p.tx);
            m.receiveShadow = true;
            group.add(m);
        }
    }
    return group;
}

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

    // preserveDrawingBuffer so the clip recorder and the result card can read frames back.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

    const handle = new SceneHandle(renderer, scene, camera, hemi, sun, canvas);
    try {
        handle.post = new PostFx(renderer);
    } catch (e) {
        handle.post = null;   // no post pass: the scene renders straight to the canvas
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        console.warn('pocabinet/scene: post-processing unavailable', e);
    }
    handle.applyTier(appTier());
    followAppTier(handle);
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

