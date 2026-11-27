// pocapitol/house/scene.js — the House map's picture: a scanned house you walk through, first person.
//
// The house is one Gaussian splat (models/house.ksplat, the scan PoCabinet's House Party drives
// through; same file, same frame: metres, floor on y = 0), drawn by platform/3d/splats.js. On top
// of it everything is Capitol's own: the raiders are crowd.js figures (the same rigged body,
// clothes and held gun as the armed demo), the sparks and dust are bursts.js, the smoke is
// particles.js, the scuffs on the floor decals.js.
//
// A splat has colour and no surfaces, which decides the draw order:
//
//   1. solids (the raiders, the gun in the hand, rounds in flight) write depth;
//   2. the splat blends over them back to front, depth-tested: a wall in front of a raider covers
//      them gaussian by gaussian, so they come round a door frame with the frame's real edge;
//   3. an unseen stand-in for the walls and furniture (the columns of nav.js) is written into the
//      depth buffer only;
//   4. everything see-through (smoke, sparks, dust, floor marks, the blobs under feet) is drawn
//      last, against that depth: without step 3 smoke in the next room would show through the wall.
//
// The frame is drawn into a texture and anti-aliased on the way to the canvas (FXAA), as the
// Capitol map's own post stack does. Not by a multisampled canvas: bursts.js drawn straight into
// one came out as a grid of stale tiles on a Snapdragon X laptop (Chromium 156, 2026-11-27).

import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { createCrowd } from '../crowd.js';
import { softTexture } from '../look.js';
import { createParticles } from '../particles.js';
import { createBursts } from '../bursts.js';
import { createDecals } from '../decals.js';
import { loadSplat } from '../../platform/3d/splats.js';
import { createStage } from '../../platform/stage/stage.js';
import { createRenderer, attachRenderer, webgpuAvailable } from '../../platform/3d/renderer.js';
import { fxaa } from 'three-eco/addons/tsl/display/FXAANode.js';
import { EYE, CEILING } from './nav.js';

const SPLAT = 'models/house.ksplat', SPLAT_LOW = 'models/house-low.ksplat';
/**
 * What is drawn of the scan per graphics level. `file` is which splat. Past `near` metres only
 * the file's leading share is drawn (near / distance of it; its rows are most important first),
 * so the far end of the house thins out instead of going dark. `draw` is a ceiling on one frame's
 * gaussians (the nearest are kept), there for safety, not to be the usual limit.
 *
 * `auto` moves `near` between the two `adapt` distances to keep about thirty frames a second:
 * a slow frame costs detail down the hall, never resolution. `high` pins it far out and takes
 * whatever frame rate that gives (12 to 20 a second at 1080p on a Snapdragon X laptop, 2026-11-27;
 * 2M gaussians in view all at once ran at 10).
 */
export const LEVELS = {
    low: { file: 'low', splats: 250000, draw: 250000, near: 1.2, adapt: null },
    auto: { file: 'full', splats: 2000000, draw: 600000, near: 1.2, adapt: [0.7, 2.5] },
    high: { file: 'full', splats: 2000000, draw: 900000, near: 2.5, adapt: null },
};
/** Frame times (s) the `auto` level works between: slower than the first gives detail up, faster than the second takes it back. */
const SLOW_FRAME = 0.036, FAST_FRAME = 0.024;
const BURST_SCALE = 0.3;
const FAR_AWAY = new THREE.Vector3(0, -1000, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/** The officer's hands and gun, hung off the camera: Capitol's plain dark block, seen from behind it. */
function createViewModel() {
    const group = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: '#23272c', roughness: 0.55, metalness: 0.35 });
    const grip = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.8 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#24394d', roughness: 0.9 });
    const glove = new THREE.MeshStandardMaterial({ color: '#202830', roughness: 0.85 });
    const box = (w, h, d, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
        group.add(mesh);
        return mesh;
    };
    box(0.046, 0.07, 0.34, dark, 0, 0, -0.1);                    // receiver
    box(0.024, 0.024, 0.26, dark, 0, 0.012, -0.39);              // barrel
    box(0.032, 0.032, 0.07, grip, 0, 0.012, -0.5);               // muzzle
    box(0.038, 0.05, 0.2, grip, 0, -0.005, 0.16);                // stock
    box(0.034, 0.13, 0.05, grip, 0, -0.095, -0.12, 0.25);        // magazine
    box(0.034, 0.09, 0.04, grip, 0, -0.075, 0.02, -0.3);         // pistol grip
    box(0.01, 0.028, 0.01, dark, 0, 0.049, -0.24);               // front sight
    box(0.028, 0.018, 0.01, dark, 0, 0.045, 0.03);               // rear sight
    box(0.055, 0.05, 0.07, glove, 0.004, -0.075, 0.025);         // right hand on the grip
    box(0.062, 0.062, 0.3, sleeve, 0.05, -0.15, 0.17, 0.42, -0.3);   // right forearm, back and down out of view
    box(0.05, 0.045, 0.08, glove, -0.012, -0.045, -0.27);        // left hand under the barrel
    box(0.062, 0.062, 0.32, sleeve, -0.1, -0.15, -0.16, 0.55, 0.62); // left forearm, down to the left
    const flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffd98a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const flash = new THREE.Group();
    // Three thin blades through one point: a small star at the muzzle, not a card.
    for (const turn of [0, Math.PI / 3, -Math.PI / 3]) {
        const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.022), flashMaterial);
        blade.rotation.z = turn; flash.add(blade);
    }
    flash.position.set(0, 0.012, -0.56);
    flash.renderOrder = 8;
    flash.traverse(o => { o.renderOrder = 8; });
    group.add(flash);
    return {
        group, flash, flashMaterial,
        dispose() {
            group.traverse(o => { o.geometry?.dispose(); });
            for (const m of [dark, grip, sleeve, glove, flashMaterial]) m.dispose();
        },
    };
}

/** The walls and furniture as columns, written to depth only (step 3 above). */
function createOccluder(nav) {
    const cells = [];
    for (let r = 0; r < nav.rows; r++) {
        for (let c = 0; c < nav.cols; c++) {
            const h = nav.planHeight(c, r);
            const top = h < 0 || h >= 1.75 ? CEILING : h;
            if (top < 0.3) continue;
            // A column buried in others as high as itself is never seen.
            let buried = top >= CEILING;
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nc = c + dc, nr = r + dr;
                if (nc < 0 || nr < 0 || nc >= nav.cols || nr >= nav.rows) continue;
                const nh = nav.planHeight(nc, nr);
                if (!(nh < 0 || nh >= 1.75)) buried = false;
            }
            if (!buried) cells.push([c, r, top]);
        }
    }
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true });
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, cells.length));
    const pose = new THREE.Object3D();
    cells.forEach(([c, r, top], i) => {
        // Pulled in a little, so the stand-in never pokes out in front of the wall in the picture.
        pose.position.set(nav.x0 + (c + 0.5) * nav.cell, top / 2, nav.z0 + (r + 0.5) * nav.cell);
        pose.scale.set(nav.cell * 0.9, top, nav.cell * 0.9);
        pose.updateMatrix();
        mesh.setMatrixAt(i, pose.matrix);
    });
    mesh.count = cells.length;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.name = 'house-occluder';
    return { mesh, dispose() { geometry.dispose(); material.dispose(); mesh.dispose(); } };
}

/**
 * @param host    the element the canvas goes in
 * @param figure  crowd.js loadFigure()
 * @param nav     nav.js createNav()
 * @param onScan  (percent 0..100, label) while a splat file downloads; (null) when it is in
 */
export async function createHouseScene(host, { figure, nav, onScan = null } = {}) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0a09');
    const forceWebGL = !(await webgpuAvailable()) || /[?&]capitolGl/.test(location.search) || (() => { try { return Boolean(localStorage.getItem('pominigames:pocapitol-gl')); } catch { return false; } })();
    // The scan's colours are the house as the camera saw it, so nothing is tone-mapped.
    const renderer = await createRenderer(THREE, { api: 'webgpu', forceWebGL, antialias: false, tone: 'none', shadows: false, clearColor: '#0b0a09' });
    const isWebGPU = Boolean(renderer.backend?.isWebGPUBackend);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'PoCapitol House map, first person. Click to aim.');
    const camera = new THREE.PerspectiveCamera(66, 1, 0.04, 60);
    camera.rotation.order = 'YXZ';
    camera.layers.enable(1);            // crowd.js keeps its see-through parts on layer 1
    scene.add(camera);

    // Lamp light, not daylight: the scan is a house in the evening. No shadow maps: nothing in
    // the scan could receive one, and the blob under each figure does that job.
    scene.add(new THREE.HemisphereLight('#ffe9cf', '#4a3a2e', 2.1));
    const key = new THREE.DirectionalLight('#fff1dc', 1.5);
    key.position.set(2, 6, 3);
    scene.add(key);
    // Lights that only ever flash: the officer's muzzle, two for whoever else fires, one for a blast.
    // All exist from the start at zero, so the light count never changes and nothing recompiles.
    const muzzleLight = new THREE.PointLight('#ffd590', 0, 9, 2);
    const otherLights = [new THREE.PointLight('#ffd590', 0, 8, 2), new THREE.PointLight('#ffd590', 0, 8, 2)];
    const blastLight = new THREE.PointLight('#fff2dc', 0, 16, 1.6);
    scene.add(muzzleLight, ...otherLights, blastLight);
    let otherLight = 0;

    const time = { value: 0 };
    const shadowBlob = softTexture('shadow');
    const crowd = createCrowd(scene, 24, { time, groundHeight: () => 0, shadowTexture: shadowBlob, figure, wind: null, signs: [], detail: { value: 1 }, isWebGPU });
    const particles = createParticles(scene, 160);
    particles.illuminate(new THREE.Vector3(0.2, 0.9, 0.3), 0.55, []);
    const bursts = createBursts(scene, { capacity: 6000 });
    const decals = createDecals(scene, { capacity: 96 });

    // Rounds in flight: short bright streaks. Solid, so they hold their own against the splat.
    const tracerMaterial = new THREE.MeshBasicMaterial({ color: '#fff0b4' });
    const tracers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.014, 0.014, 1), tracerMaterial, 48);
    tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tracers.frustumCulled = false; tracers.count = 0;
    scene.add(tracers);
    let tracerMode = 'luminous';
    // Grenades in the air: a dark can, three at most.
    const canMaterial = new THREE.MeshStandardMaterial({ color: '#3b4038', roughness: 0.6, metalness: 0.3 });
    const cans = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.11, 8), canMaterial, 4);
    cans.frustumCulled = false; cans.count = 0;
    scene.add(cans);

    const occluder = createOccluder(nav);
    scene.add(occluder.mesh);
    const viewModel = createViewModel();
    viewModel.group.position.set(0.13, -0.13, -0.27);
    camera.add(viewModel.group);

    // Step 4: whatever is see-through goes after the splat (order 0) and the stand-in (order 1).
    scene.traverse(o => {
        if (o === occluder.mesh || !o.material) return;
        if ([o.material].flat().some(m => m.transparent)) o.renderOrder = Math.max(o.renderOrder, 3);
    });

    const stage = createStage({ kind: '3d', container: host, maxDpr: 1.6, maxPixels: 1e9, maxDt: Infinity, exclude: ['shake'] });
    const gfx = attachRenderer(stage, renderer, { camera });
    gfx?.resize?.();
    stage.resize();

    // ---- the scan
    const upright = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // the scan's z up to three's y up
    let cloud = null, cloudFile = '', wanted = 'low', loading = 0, disposed = false;
    // How far out the scan is drawn in full. splats.js reads this object on every sort, so the
    // `auto` level only has to change `near` and ask for a sort.
    let lod = { near: LEVELS.low.near, floor: 0.08 };
    async function loadCloud(file, settings) {
        const token = ++loading;
        const range = { near: settings.near, floor: 0.08 };
        const made = await loadSplat(THREE, TSL, file === 'low' ? SPLAT_LOW : SPLAT, {
            matrix: upright, maxSplats: settings.splats, maxDraw: settings.draw, lod: range,
            toneMapped: false, name: 'house-scan',
            onProgress: p => { if (token === loading) onScan?.(Number(p) || 0, file === 'low' ? 'Loading the house' : 'Loading full detail'); },
        });
        if (disposed || token !== loading) { made.dispose(); return false; }
        made.object.renderOrder = 0;
        scene.add(made.object);
        made.warmSort?.(camera);
        cloud?.dispose();
        cloud = made; cloudFile = file; lod = range;
        onScan?.(null);
        return true;
    }
    // The light file first (6 MB, in within a second or two): the scene is not shown without it.
    await loadCloud('low', LEVELS.low);
    wanted = 'low';

    /**
     * Change the level. A level drawn from the full scan (48 MB) loads it behind whatever is on
     * screen and swaps when it is in; if it cannot load, the light one stays.
     */
    function applyLevel(next) {
        if (!LEVELS[next] || next === wanted) return;
        wanted = next;
        const settings = LEVELS[next];
        const keep = error => { console.warn('[PoCapitol] house scan unavailable, keeping the one drawn:', error); onScan?.(null); };
        if (settings.file === 'low') { if (cloudFile !== 'low') loadCloud('low', LEVELS.low).catch(keep); }
        else loadCloud('full', settings).catch(keep);
        bursts.setDensity(next === 'low' ? 0.5 : 1);
    }

    // The scene to a texture, then to the canvas through the renderer's output transform and FXAA.
    let pipeline = null;
    try {
        pipeline = new THREE.RenderPipeline(renderer);
        pipeline.outputColorTransform = false;
        pipeline.outputNode = fxaa(TSL.renderOutput(TSL.pass(scene, camera)));
    } catch (error) {
        console.warn('[PoCapitol] house: no anti-aliasing pass, drawing straight to the canvas:', error);
        pipeline = null;
    }

    // ---- per frame
    const pose = new THREE.Object3D(), dir = new THREE.Vector3();
    let clock = 0, bob = 0, bobAmount = 0, kick = 0, flashLeft = 0, shake = 0, sceneFlash = 0, fallen = 0, calm = false;
    let lastHeat = 0, drawnTracers = 0, frameTime = 1 / 60, paceAt = 0;

    /** The `auto` level: thin the far end of the house when frames are slow, fill it back in when they are not. */
    function pace(seconds, running) {
        const adapt = LEVELS[wanted]?.adapt;
        if (!adapt || !cloud || cloudFile !== LEVELS[wanted].file || !running) return;
        frameTime += (Math.min(0.2, seconds) - frameTime) * 0.08;
        paceAt += seconds;
        if (paceAt < 0.6) return;
        paceAt = 0;
        const next = frameTime > SLOW_FRAME ? Math.max(adapt[0], lod.near * 0.86) : frameTime < FAST_FRAME ? Math.min(adapt[1], lod.near * 1.07) : lod.near;
        if (Math.abs(next - lod.near) < 0.01) return;
        lod.near = next;
        cloud.warmSort?.(camera);
    }
    const reacted = new WeakSet();

    function onEvent(e, state) {
        if (reacted.has(e)) return;
        reacted.add(e);
        const y = e.y ?? 1.3;
        switch (e.type) {
            case 'gunshot':
                if (e.human) {
                    kick = Math.min(1, kick + 0.5); flashLeft = 0.045;
                    muzzleLight.intensity = calm ? 2 : 7;
                    sceneFlash = Math.max(sceneFlash, calm ? 0.008 : 0.028);
                    // The spent case, out to the right.
                    bursts.casing(e.x, 0.15, e.z, Math.cos(state.yaw ?? 0) * 1.6, -Math.sin(state.yaw ?? 0) * 1.6);
                } else {
                    const light = otherLights[otherLight++ % otherLights.length];
                    light.position.set(e.x, y, e.z); light.intensity = calm ? 3 : 12;
                    bursts.spray(e.x, y, e.z, 40, { color: [5, 3.4, 1.4], spread: 0.5, up: 0.4, calm });
                    bursts.puff(e.x, y, e.z, 20, { tone: [0.72, 0.7, 0.68], lift: 0.3, size: 0.2, life: 0.9, alpha: 0.22 });
                }
                break;
            case 'impact':
                if (e.material === 'body') {
                    if (!e.human) bursts.puff(e.x, y, e.z, 70, { tone: [0.66, 0.62, 0.56], lift: 0.3, size: 0.3, life: 0.7 });
                } else {
                    // Plaster off a wall, splinters off a floor or a table: thrown back the way the round came.
                    const wood = e.surface !== 'wall';
                    bursts.spall(e.x, y, e.z, (e.dx ?? 0) * 0.6, (e.dz ?? 0) * 0.6, wood ? 'wood' : 'marble');
                    if (e.surface === 'floor') decals.react({ type: 'impact', round: true, x: e.x, z: e.z }, 0);
                }
                break;
            case 'grenade':
                bursts.react(e, 0, calm); decals.react(e, 0);
                shake = Math.max(shake, 1 / (1 + Math.hypot(e.x - state.player.x, e.z - state.player.z) / 3));
                sceneFlash = Math.max(sceneFlash, calm ? 0.05 : 0.45);
                blastLight.position.set(e.x, 1.1, e.z); blastLight.intensity = calm ? 12 : 220;
                break;
            case 'smoke': case 'throw': case 'down':
                bursts.react(e, 0, calm);
                if (e.type === 'down') decals.react(e, 0);
                break;
            default: break;
        }
        if (e.type === 'impact' && e.human && e.material === 'body') shake = Math.max(shake, 0.35);
    }

    /**
     * Draw one frame.
     * @param state  the attempt (world.js)
     * @param yaw    which way the officer faces (0 looks down -z, positive turns left)
     * @param pitch  radians up
     * @param dt     seconds to move the picture on (the caller clamps it)
     * @param seconds  how long the last frame really took: what the `auto` level paces itself by
     */
    function render(state, yaw, pitch, dt, seconds = dt) {
        const running = state.status === 'active';
        if (running) clock += dt;
        pace(seconds, running);
        time.value = clock;
        state.yaw = yaw;
        for (const e of state.events) onEvent(e, state);

        // The eye: the officer's height, a step's bob while walking, down to the floor if they fall.
        const p = state.player;
        const speed = Math.hypot(p.vx ?? 0, p.vz ?? 0);
        bobAmount += ((p.moving ? Math.min(1, speed / 3) : 0) - bobAmount) * (1 - Math.exp(-dt * 8));
        if (running) bob += dt * (6.5 + speed * 1.4);
        fallen += ((state.health <= 0 ? 1 : 0) - fallen) * (1 - Math.exp(-dt * 3));
        shake *= Math.exp(-dt * 5);
        const jolt = calm ? 0 : shake * 0.03;
        camera.position.set(p.x + (Math.random() - 0.5) * jolt, EYE + Math.sin(bob * 2) * 0.018 * bobAmount * (calm ? 0.3 : 1) - fallen * 1.25 + (Math.random() - 0.5) * jolt, p.z + (Math.random() - 0.5) * jolt);
        camera.rotation.set(pitch + kick * 0.012 - fallen * 0.3, yaw, Math.sin(bob) * 0.004 * bobAmount + fallen * 0.9);
        camera.updateMatrixWorld();

        // The gun: back and up with each round, a sway with the walk, lowered when sprinting or down.
        kick *= Math.exp(-dt * 14);
        const heat = state.mgHeat ?? 0;
        lastHeat += (heat - lastHeat) * (1 - Math.exp(-dt * 10));
        viewModel.group.position.set(0.13 + Math.sin(bob) * 0.006 * bobAmount, -0.13 + Math.abs(Math.cos(bob)) * 0.008 * bobAmount - fallen * 0.3, -0.27 + kick * 0.035);
        viewModel.group.rotation.set(kick * 0.05 - fallen * 0.8, 0.045, 0);
        viewModel.group.visible = fallen < 0.9;
        flashLeft = Math.max(0, flashLeft - dt);
        viewModel.flashMaterial.opacity = flashLeft > 0 ? (calm ? 0.35 : 0.95) : 0;
        viewModel.flash.rotation.z = clock * 37;
        viewModel.flash.scale.setScalar(0.8 + (clock * 53 % 1) * 0.5);
        camera.getWorldDirection(dir);
        muzzleLight.position.copy(camera.position).addScaledVector(dir, 1.1);
        muzzleLight.intensity *= Math.exp(-dt * 30);
        for (const light of otherLights) light.intensity *= Math.exp(-dt * 26);
        blastLight.intensity *= Math.exp(-dt * 9);
        sceneFlash *= Math.exp(-dt * 22);
        cloud?.setLighting({ flash: sceneFlash < 0.004 ? 0 : sceneFlash });

        // The raiders. The officer has no body to draw (role 'none'), and nobody is hidden for
        // standing close to the camera, as the third-person game hides its own player.
        host.dataset.actorCount = crowd.update({ ...state, role: 'none' }, 0, false, FAR_AWAY);

        const shots = tracerMode === 'off' ? 0 : Math.min(state.shots.length, 48);
        for (let i = 0; i < shots; i++) {
            const s = state.shots[i];
            const streak = Math.min(1.6, s.length - s.t, s.t + 0.4);
            const mid = s.t + streak / 2;
            pose.position.set(s.x + s.dx * mid, s.y + s.dy * mid, s.z + s.dz * mid);
            pose.quaternion.setFromUnitVectors(FORWARD, dir.set(s.dx, s.dy, s.dz));
            pose.scale.set(1, 1, Math.max(0.05, streak));
            pose.updateMatrix();
            tracers.setMatrixAt(i, pose.matrix);
        }
        tracers.count = shots;
        if (shots || drawnTracers) tracers.instanceMatrix.needsUpdate = true;
        drawnTracers = shots;

        let can = 0;
        for (const effect of state.effects) {
            if (effect.type !== 'grenade' || can >= 4) continue;
            pose.position.set(effect.x, effect.y ?? 0.1, effect.z);
            pose.quaternion.setFromEuler(new THREE.Euler(clock * 9, clock * 5, 0));
            pose.scale.setScalar(1); pose.updateMatrix();
            cans.setMatrixAt(can++, pose.matrix);
        }
        if (can || cans.count) cans.instanceMatrix.needsUpdate = true;
        cans.count = can;

        particles.update(state.effects.filter(e => e.type === 'smoke'), clock, 0.75, calm, { x: 0.04, z: 0.02 }, 0);
        // bursts.js sizes its sparks and dust for a crowd seen across a lawn; in a room, at arm's
        // length, the same sparks are a third the size.
        bursts.update(clock, camera, renderer.domElement.height * BURST_SCALE, 0);
        decals.update(0.8, running ? dt : 0);
        cloud?.update(camera);
        if (pipeline) pipeline.render(); else renderer.render(scene, camera);
    }

    /** The unit direction the officer is looking along: what fire() and a throw take. */
    function aim(yaw, pitch) {
        const flat = Math.cos(pitch);
        return { x: -Math.sin(yaw) * flat, y: Math.sin(pitch), z: -Math.cos(yaw) * flat };
    }

    function dispose() {
        disposed = true; loading++;
        pipeline?.dispose?.();
        cloud?.dispose();
        crowd.dispose(); particles.dispose(); bursts.dispose(); decals.dispose(); occluder.dispose(); viewModel.dispose();
        tracers.geometry.dispose(); tracerMaterial.dispose(); cans.geometry.dispose(); canMaterial.dispose(); shadowBlob.dispose();
        stage.dispose();   // the renderer, its context and the canvas
    }

    return {
        canvas: renderer.domElement, scene, stage, renderer, camera, render, aim, onEvent, dispose, applyLevel,
        level: () => wanted,
        setFov(value) {
            const fov = Number(value);
            if (Number.isFinite(fov)) { camera.fov = Math.min(85, Math.max(50, fov)) + 4; camera.updateProjectionMatrix(); }
            return camera.fov;
        },
        setTracerMode(mode) { if (['luminous', 'stealth', 'off'].includes(mode)) { tracerMode = mode; tracerMaterial.color.set(mode === 'stealth' ? '#8792a3' : '#fff0b4'); } },
        setMotionReduction(value) { calm = Boolean(value); },
        /** What the scan is drawing, for the diagnostics. */
        scan: () => ({ file: cloudFile, splats: cloud?.count ?? 0, drawn: cloud?.drawn ?? 0, near: Math.round(lod.near * 100) / 100, backend: isWebGPU ? 'webgpu' : 'webgl2' }),
    };
}
