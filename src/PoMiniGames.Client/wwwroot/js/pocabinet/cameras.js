// pocabinet/cameras.js
//
// Where the camera goes each frame: the chase / far / TV cameras (setView), the demo's
// picture-in-picture (renderPip), FOV kick and shake (applyFx), the sun's shadow frustum riding
// with the car in focus (followShadow) and the sun's spot on screen for the glare. Every function
// takes the SceneHandle first; scene.js keeps thin methods that call them.

import * as THREE from 'three';
import { RUN_OFF } from './physics.js';
import { wallFace } from './terrain.js';
import { WORLD_SCALE } from './util.js';

export const SHADOW_EXTENT = 38;
export const PIP_WIDTH = 0.26;   // of the canvas width

/**
 * Place the camera for a car pose. mode: 'chase' | 'far' | 'tv'.
 * Car forward = (cos h, 0, sin h) in three's x/z.
 */
export function setView(sh, p) {
    if (sh.disposed || !p) return;
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
        const target = sh._v.set(x - fx * back, h - rise * back + up, z - fz * back);
        // Lagged follow so the car swings in frame through corners; time-based so
        // the lag is the same at 30 fps as at 144.
        const dt = Number(p.dt) || 0;
        const k = dt > 0 ? 1 - Math.exp(-dt * (far ? 5 : 8)) : 0.18;
        const ahead = far ? 6 : 4.5;
        const look = new THREE.Vector3(x + fx * ahead, h + rise * ahead + (far ? 0.6 : 1.0), z + fz * ahead);
        if (!sh._chaseInit || p.snap) {
            sh._chase.copy(target);
            sh._chaseLook.copy(look);
            sh._chaseInit = true;
        } else {
            sh._chase.lerp(target, k);
            sh._chaseLook.lerp(look, 1 - Math.exp(-(dt || 0.016) * 14));
        }
        sh._chase.y = Math.max(sh._chase.y, h + 0.7);
        // Never inside a hillside the road cuts past.
        if (sh.terrain) sh._chase.y = Math.max(sh._chase.y, sh.terrain.worldHeight(sh._chase.x * WORLD_SCALE, sh._chase.z * WORLD_SCALE) + 0.6);
        sh.camera.position.copy(sh._chase);
        sh.camera.lookAt(sh._chaseLook);
        return;
    }
    // TV: fixed trackside cameras every eighth of the lap, handing off as the car passes.
    sh._chaseInit = false;
    const t = sh.track;
    if (!t) return;
    const along = Number(p.along) || 0;
    const idx = Math.floor(((along % t.length) + t.length) % t.length / (t.length / 8) + 0.5) % 8;
    if (idx !== sh._tvIndex || !sh._tvPos) {
        sh._tvIndex = idx;
        // Camera 0 stands level with the start gantry, not 40 past it: from there it looked
        // back at the cars coming to the line straight through the gantry's beam.
        const at = idx * (t.length / 8) + (idx === 0 ? 2 : 40);
        const q = t.pointAt(at);
        const side = (sh.playground ? t.halfWidth + RUN_OFF : wallFace(t, t.indexAt(at), 1)) + 30;
        const gx = q.x - q.ty * side, gy = q.y + q.tx * side;
        // On its mast on the ground, or (in the air, the Playground) at the road's height.
        const road = t.heightAt(at) / WORLD_SCALE;
        const ground = sh.terrain ? Math.max(road, sh.terrain.worldHeight(gx, gy)) : road;
        sh._tvPos = new THREE.Vector3(gx / WORLD_SCALE, 7 + ground, gy / WORLD_SCALE);
    }
    sh.camera.position.copy(sh._tvPos);
    sh.camera.lookAt(x, h + 0.6, z);
}

/**
 * The PiP pass: an HDR frame of its own, tone-mapped into a corner of the canvas by the post
 * pass (postfx.js drawInset; without one, straight to the canvas through a scissor with the
 * renderer's tone mapping), reusing this frame's shadow map. Left out on the low
 * tier, where the frame has no time for a second scene, and on a narrow canvas, where the
 * inset would be too small to read. pipRect (canvas CSS px from the top left) tells the
 * page where to put the frame and label, or null when nothing was drawn.
 */
export function renderPip(sh) {
    const r = sh.renderer;
    const size = r.getSize(sh._pipSize || (sh._pipSize = new THREE.Vector2()));
    if (sh.quality === 'low' || size.x < 560) { sh.pipRect = null; return; }
    const p = sh.pip;
    const w = Math.round(size.x * PIP_WIDTH), h = Math.round(w * 9 / 16);
    const m = Math.round(Math.max(8, size.x * 0.012));
    const x = size.x - w - m, y = m;   // bottom right (the viewport counts y from the bottom)
    const cam = sh.pipCamera || (sh.pipCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.2, 2000));
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
    if (sh.post) {
        const shadows = r.shadowMap.autoUpdate;
        r.shadowMap.autoUpdate = false;
        try {
            sh.post.drawInset(sh.scene, cam, x, y, w, h, sh.fx.exposure || 1);
        } finally {
            r.shadowMap.autoUpdate = shadows;
        }
        sh.pipRect = { x, y: size.y - y - h, w, h };
        return;
    }
    const tone = r.toneMapping, exposure = r.toneMappingExposure, shadows = r.shadowMap.autoUpdate;
    r.setRenderTarget(null);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = sh.fx.exposure || 1;
    r.shadowMap.autoUpdate = false;
    r.setScissorTest(true);
    r.setScissor(x, y, w, h);
    r.setViewport(x, y, w, h);
    try {
        r.render(sh.scene, cam);
    } finally {
        r.setScissorTest(false);
        r.setViewport(0, 0, size.x, size.y);
        r.toneMapping = tone;
        r.toneMappingExposure = exposure;
        r.shadowMap.autoUpdate = shadows;
    }
    sh.pipRect = { x, y: size.y - y - h, w, h };
}

/**
 * Speed FOV kick + camera shake, applied after setView has placed the camera
 * for this frame (setView fully re-places it next frame, so nothing accumulates).
 */
export function applyFx(sh, dt) {
    const fx = sh.fx;
    const motion = !fx.reduced;
    const fov = sh.baseFov + (motion ? Math.pow(Math.min(1, fx.speed), 1.6) * 8 : 0);
    const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
    const next = sh.camera.fov + (fov - sh.camera.fov) * k;
    if (Math.abs(next - sh.camera.fov) > 0.01) {
        sh.camera.fov = next;
        sh.camera.updateProjectionMatrix();
    }
    const trauma = motion ? Math.min(1, fx.shake + fx.rumble * 0.4) : 0;
    const traumaSq = trauma * trauma;
    const now = (sh._camClock = (sh._camClock || 0) + (dt || 0.016));
    if (traumaSq > 0.001) {
        // Multi-octave harmonic spring trauma (#14) — crisp suspension feel without white-noise strobe
        const n1 = Math.sin(now * 37.3) * 0.6 + Math.sin(now * 61.9) * 0.4;
        const n2 = Math.cos(now * 43.1) * 0.6 + Math.sin(now * 73.7) * 0.4;
        const n3 = Math.sin(now * 29.5 + 1.1) * 0.65 + Math.cos(now * 53.3) * 0.35;
        sh.camera.position.x += n1 * 0.065 * traumaSq;
        sh.camera.position.y += (n2 * 0.075 - (fx.susp || 0) * 0.045) * traumaSq;
        sh.camera.rotateX(n2 * 0.011 * traumaSq);
        sh.camera.rotateZ(n3 * 0.015 * traumaSq);
    }
    if (motion && Math.abs(fx.latG || 0) > 0.001) {
        sh._camRoll = (sh._camRoll || 0) + ((fx.latG * 0.032) - (sh._camRoll || 0)) * k;
        sh.camera.rotateZ(sh._camRoll);
    }
    const decay = dt > 0 ? Math.exp(-dt * 6.5) : 1;
    fx.shake *= decay;
    fx.flash *= dt > 0 ? Math.exp(-dt * 4.5) : 1;
    if (fx.flash < 0.004) fx.flash = 0;
}

/** Keep the sun's shadow frustum centred on the action, snapped to texels (no shimmer). */
export function followShadow(sh) {
    if (!sh.sun.castShadow) return;
    const f = sh.fx.focus;
    const cx = f ? f.x : sh.camera.position.x;
    const cz = f ? f.z : sh.camera.position.z;
    const cy = (f && f.y) || 0;   // the road's height under the car in focus
    const texel = (SHADOW_EXTENT * 2) / sh.sun.shadow.mapSize.x;
    const sx = Math.round(cx / texel) * texel, sz = Math.round(cz / texel) * texel;
    sh.sun.target.position.set(sx, cy, sz);
    sh.sun.position.set(sx + sh.sunDir.x * 90, cy + sh.sunDir.y * 90, sz + sh.sunDir.z * 90);
}

/** Sun position on screen for the glare/shafts, and how visible it is. */
export function updateSunScreen(sh) {
    const vis = sh.sunVisibility;
    if (!(vis > 0.01) || !sh.sunDirVisual) { sh.fx.sun = null; return; }
    const p = sh._v.copy(sh.sunDirVisual).multiplyScalar(1000).add(sh.camera.position).project(sh.camera);
    const facing = sh.camera.getWorldDirection(new THREE.Vector3()).dot(sh.sunDirVisual);
    if (p.z >= 1 || facing <= 0) { sh.fx.sun = null; return; }
    const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
    const fade = Math.max(0, 1 - Math.max(0, edge - 0.85) / 0.35);
    sh.fx.sun = { x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, v: vis * fade };
}
