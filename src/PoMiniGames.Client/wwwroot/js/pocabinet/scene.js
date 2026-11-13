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
//   • Bedroom Floor GP and Center Court: a scan the toy road is laid in (bedroom.glb / court.glb and
//     their Gaussian splats, see models.js SCANS)
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
import { Terrain, themeOf, isPlayground, isRoom, isScan, wallFace } from './terrain.js';
import { Trackside } from './trackside.js';
import { gravel, sand, limitStripes } from './surfaces.js';
import { WORLD_SCALE } from './util.js';
import { barrier, barrierTexture, disposeObject, flatGround, hex, ribbon, startLine } from './meshes.js';
import { PLAYGROUND, keepOutFor, scanOf } from './models.js';
import { SHADOW_EXTENT } from './cameras.js';
import * as cams from './cameras.js';
import * as models from './models.js';

const SUN_BASE = 3.2;
const HEMI_BASE = 0.7;
const ENV_BASE = 0.85;
const GRASS_BLADES = { low: 0, medium: 14000, high: 36000 };
const SHADOW_SIZE = { low: 1024, medium: 1536, high: 2048 };

/** Reduced motion: <html data-motion> (the OS preference or the app's settings switch). */
const calm = () => document.documentElement.dataset.motion === 'reduce';


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
        this.room = false;        // indoors (isRoom, the bedroom): no rain
        this.scan = false;        // a toy road laid over a scan (isScan): the model is the world
        this.roomSplat = null;    // the scan's Gaussian splat (DropInViewer), when it loaded
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
                this.syncRoomSplat();
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

    setView(p) {
        return cams.setView(this, p);
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

    renderPip() {
        return cams.renderPip(this);
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
        this.scan = isScan(t);
        // Where a model is the world (the Playground, the bedroom) the scene adds no terrain,
        // trackside props or grass of its own.
        const modelWorld = this.playground || !!models.MODEL_LOOKS[this.theme];
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
        if (!ground && this.scan) {
            // Under the scan's floor (it dips to -0.07): shows through holes in the scan and, past
            // the edge of an outdoor scan, runs on to the fog.
            ground = flatGround(world, new THREE.MeshStandardMaterial({ color: scanOf(this).carpetHex, roughness: 1, metalness: 0 }), reach, tile);
            ground.position.y = scanOf(this).groundY;
        }
        if (!ground) ground = flatGround(world, groundMat, reach, tile);
        group.add(ground);
        this.groundMesh = ground;

        const hw = t.halfWidth;
        const tar = asphalt();
        const built = (i) => t.built(i);
        // The Playground keeps the straight-up normals it always had; a hill shades as one.
        const flat = this.playground;
        // A scan's road is a toy track: smooth moulded plastic, not tarmac.
        const roadMat = this.scan
            ? models.toyRoadMaterial(atmosphere)
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
        } else if (this.scan) {
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
        models.MODEL_LOOKS[this.theme]?.load(this, group);
    }

    buildRoomTrack(group, atmosphere) {
        return models.buildRoomTrack(this, group, atmosphere);
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

    async loadModel(group, url, scale, name, prepare) {
        return models.loadModel(this, group, url, scale, name, prepare);
    }

    async loadRoom(group) {
        return models.loadRoom(this, group);
    }

    loadPlayground(group) {
        return models.loadPlayground(this, group);
    }

    buildGrass() {
        if (this.grass) {
            this.scene.remove(this.grass.mesh);
            this.grass.dispose();
        }
        this.grass = null;
        const blades = GRASS_BLADES[this.quality] || 0;
        if (!this.track || !blades || this.theme === 'pressbriefing' || this.scan) return;
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

    async loadRoomSplat(group) {
        return models.loadRoomSplat(this, group);
    }

    syncRoomSplat() {
        return models.syncRoomSplat(this);
    }

    /** 'splat' (full) or 'mesh' (lite) for the scan: swaps it live on a scanned track. */
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

