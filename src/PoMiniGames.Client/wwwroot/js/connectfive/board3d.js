// connectfive/board3d.js — the optional 3D Connect Five board, drawn on the shared 3D stage.
//
// WHAT THIS IS AND IS NOT
// The DOM board (.cf-board) stays the single source of truth: it takes the pointer and the keyboard,
// holds the game state and the aria grid + live region. This module only DRAWS it. fx.js reads the
// DOM into a snapshot (81 cells, the hover ghost, the keyboard cursor) and calls sync(); a fixed,
// pointer-events:none canvas sits exactly over the board, so the discs a player clicks are the discs
// they see. The canvas is built at the board's own scale (one world unit = one cell pitch) and the
// camera sits on the axis at rest, so the front plane of the discs maps onto the DOM cells to the
// pixel; the tilt toward the active column is a few degrees and returns to zero.
//
// SHARED PARTS REUSED
//   stage/stage.js         the rAF loop, resize, pause on hidden tab, tier events, cleanup registry,
//                          and the shared 'shake' feature (PoImpact trauma moves the camera)
//   3d/renderer.js         createRenderer (WebGPU, WebGL2 backend when there is no adapter) + attachRenderer
//   3d/dispose.js          freeing the scene
//   2d/tween.js            damp() for the camera tilt
//   fx.js                  discRgb() (the --disc-* tokens), and landed() — the same landing feel the
//                          2D board gets (sound, bump, dust, haptic), fired when a disc really hits
//
// WHAT FAILS OVER TO 2D (fx.js decides, this module reports): no WebGPU/WebGL, quality tier low,
// renderer or module load error (mount() rejects), a lost context, three failed frames, or the tier
// dropping to low mid-game. In every case the DOM board's own visuals return.

import * as THREE from 'three-eco/webgpu';
import { createStage } from '../platform/stage/stage.js';
import { createRenderer, attachRenderer } from '../platform/3d/renderer.js';
import { disposeObject3D } from '../platform/3d/dispose.js';
import { damp } from '../platform/2d/tween.js';
import { holdQuality } from '../platform/visualRuntime.js';
import { discRgb } from './fx.js';

const COLS = 9;
const ROWS = 7;
const CELLS = ROWS * COLS;
const HALF_COL = (COLS - 1) / 2;
const HALF_ROW = (ROWS - 1) / 2;
/** Half the canvas, in cell pitches: the grid (4.5) + frame, feet and shadow room. */
const WORLD_HALF = 6.6;
const FOV = 24;
const PLATE_HALF_W = COLS / 2 + 0.22;
const PLATE_HALF_H = ROWS / 2 + 0.22;
const SPAWN_Y = HALF_ROW + 1.7;
const GRAVITY = 62;          // cell pitches / s²: a 7-row fall in ~0.48 s
const DISC_R = 0.42;
const DISC_HALF_T = 0.15;
/** A resting disc glows a little, so the tone mapper does not turn the yellow to olive. */
const DISC_GLOW = 0.1;

function colorOf(name, shade) {
    const [r, g, b] = discRgb(name, shade);
    return new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
}

function roundedRect(hw, hh, r) {
    const s = new THREE.Shape();
    s.moveTo(-hw + r, -hh);
    s.lineTo(hw - r, -hh);
    s.quadraticCurveTo(hw, -hh, hw, -hh + r);
    s.lineTo(hw, hh - r);
    s.quadraticCurveTo(hw, hh, hw - r, hh);
    s.lineTo(-hw + r, hh);
    s.quadraticCurveTo(-hw, hh, -hw, hh - r);
    s.lineTo(-hw, -hh + r);
    s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    return s;
}

/** The disc: a bevelled coin with a recessed face, lathed about Y then turned to face +Z. */
function discGeometry() {
    const t = DISC_HALF_T;
    const pts = [
        [0, -t + 0.02], [0.26, -t + 0.02], [0.30, -t + 0.005], [0.31, -t], [0.38, -t], [DISC_R - 0.025, -t + 0.025], [DISC_R, -t + 0.07],
        [DISC_R, t - 0.07], [DISC_R - 0.025, t - 0.025], [0.38, t], [0.31, t], [0.30, t - 0.005], [0.26, t - 0.02], [0, t - 0.02],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.LatheGeometry(pts, 40);
    g.rotateX(Math.PI / 2);
    return g;
}

/** Studio environment for reflections: a dark room with two soft boxes and a warm strip. */
function makeEnvironment(renderer) {
    try {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 256;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 0, 256);
        grd.addColorStop(0, 'rgb(150 165 195)');
        grd.addColorStop(0.5, 'rgb(48 54 70)');
        grd.addColorStop(1, 'rgb(16 18 26)');
        g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
        g.fillStyle = 'rgb(255 255 255 / 0.96)'; g.fillRect(70, 40, 120, 70);      // key soft box
        g.fillStyle = 'rgb(210 225 255 / 0.85)'; g.fillRect(330, 50, 90, 55);      // fill
        g.fillStyle = 'rgb(255 214 170 / 0.8)'; g.fillRect(230, 120, 60, 10);      // warm strip
        const src = new THREE.CanvasTexture(c);
        src.mapping = THREE.EquirectangularReflectionMapping;
        src.colorSpace = THREE.SRGBColorSpace;
        const pm = new THREE.PMREMGenerator(renderer);
        const rt = pm.fromEquirectangular(src);
        pm.dispose();
        src.dispose();
        return rt;
    } catch {
        return null;
    }
}

function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgb(255 255 255 / 1)');
    grd.addColorStop(0.3, 'rgb(255 255 255 / 0.55)');
    grd.addColorStop(1, 'rgb(255 255 255 / 0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/**
 * Build the 3D board over `board` (the .cf-board element).
 * @param {HTMLElement} board
 * @param {{landed:(o:object)=>void, reduced:()=>boolean, tier:()=>string, onFail:(tierDrop?:boolean)=>void}} api
 * @returns {Promise<{sync:(snap:object)=>void, glow:(cells:Array|null, color?:string, outcome?:string)=>void, dispose:()=>void}>}
 */
export async function mount(board, api) {
    // Building the renderer and its shaders stalls frames; that says nothing about the GPU, so the
    // adaptive tier must not read it as a slow machine and drop to low (which would end the 3D board).
    try { holdQuality(7000); } catch { /* chrome, never the game's problem */ }
    const host = document.createElement('div');
    host.className = 'cf-3d-host';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);

    let renderer;
    try {
        // 'webgpu' = WebGPURenderer, which itself drops to the WebGL2 backend when there is no adapter.
        renderer = await createRenderer(THREE, {
            api: 'webgpu', antialias: true, alpha: true, tone: 'aces', exposure: 1.05, shadows: 'pcfsoft',
            clearColor: 0x000000, clearAlpha: 0,
        });
    } catch (err) {
        host.remove();
        throw err;
    }

    let disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 80);
    const stage = createStage({
        kind: '3d', container: host, maxDt: 0.05, maxDpr: 2, exclude: ['photoMode'],
        shake: { maxUnits: 0.1, maxRoll: 0.008 },
        onFrame: (dt) => frame(dt),
    });
    attachRenderer(stage, renderer, { camera });
    const owned = [];                       // anything the scene graph walk would miss

    // ── environment + lights ─────────────────────────────────────────────
    const env = makeEnvironment(renderer);
    if (env) { scene.environment = env.texture; scene.environmentIntensity = 0.65; owned.push(env); }
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f45, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-6, 9, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -7; key.shadow.camera.right = 7;
    key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
    key.shadow.camera.near = 4; key.shadow.camera.far = 32;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9db8ff, 0.8);
    rim.position.set(8, 3, -7);
    scene.add(rim);

    // ── the physical board ───────────────────────────────────────────────
    const frameMat = new THREE.MeshPhysicalMaterial({ color: 0x1d4ed8, roughness: 0.34, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.18 });
    const backMat = new THREE.MeshPhysicalMaterial({ color: 0x1e3a8a, roughness: 0.5, metalness: 0.05, clearcoat: 0.4 });
    const frontMat = new THREE.MeshPhysicalMaterial({
        color: 0x2563eb, roughness: 0.2, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.1,
        transparent: true, opacity: 0.58, depthWrite: false,
    });

    const plate = roundedRect(PLATE_HALF_W, PLATE_HALF_H, 0.35);
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const hole = new THREE.Path();
            hole.absarc(c - HALF_COL, HALF_ROW - r, 0.455, 0, Math.PI * 2, true);
            plate.holes.push(hole);
        }
    }
    const bevel = { bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 24 };
    const frontGeo = new THREE.ExtrudeGeometry(plate, { depth: 0.2, ...bevel });
    frontGeo.translate(0, 0, 0.2);
    const front = new THREE.Mesh(frontGeo, frontMat);
    front.castShadow = true;
    front.renderOrder = 2;
    const backGeo = new THREE.ExtrudeGeometry(roundedRect(PLATE_HALF_W, PLATE_HALF_H, 0.35), { depth: 0.2, ...bevel });
    backGeo.translate(0, 0, -0.4);
    const back = new THREE.Mesh(backGeo, backMat);
    back.receiveShadow = true;
    scene.add(back, front);

    const addBox = (w, h, d, x, y, z, mat = frameMat) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        m.castShadow = true; m.receiveShadow = true;
        scene.add(m);
        return m;
    };
    addBox(0.34, PLATE_HALF_H * 2 + 0.6, 0.98, -(PLATE_HALF_W + 0.12), -0.1, 0);   // side rails
    addBox(0.34, PLATE_HALF_H * 2 + 0.6, 0.98, PLATE_HALF_W + 0.12, -0.1, 0);
    addBox(PLATE_HALF_W * 2 + 1, 0.5, 1.5, 0, -PLATE_HALF_H - 0.2, 0);             // base bar
    addBox(0.6, 0.38, 2.0, -(PLATE_HALF_W - 0.4), -PLATE_HALF_H - 0.64, 0);        // feet
    addBox(0.6, 0.38, 2.0, PLATE_HALF_W - 0.4, -PLATE_HALF_H - 0.64, 0);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 7), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -PLATE_HALF_H - 0.84, 0);
    floor.receiveShadow = true;
    scene.add(floor);

    // ── discs ────────────────────────────────────────────────────────────
    const discGeo = discGeometry();
    const discMats = {};
    for (const name of ['red', 'yellow']) {
        discMats[name] = new THREE.MeshPhysicalMaterial({
            color: colorOf(name, 'mid'), roughness: 0.3, metalness: 0.04, clearcoat: 0.9, clearcoatRoughness: 0.12,
            emissive: colorOf(name, 'mid'), emissiveIntensity: DISC_GLOW,
        });
    }
    const ghostMats = {};
    for (const name of ['red', 'yellow']) {
        ghostMats[name] = new THREE.MeshStandardMaterial({ color: colorOf(name, 'lit'), roughness: 0.4, transparent: true, opacity: 0.38, depthWrite: false });
    }
    const ghost = new THREE.Mesh(discGeo, ghostMats.red);
    ghost.visible = false;
    ghost.renderOrder = 1;
    scene.add(ghost);

    /** @type {Array<null|{mesh:THREE.Mesh, mode:'fall'|'rest'|'out', y:number, vy:number, ty:number, row:number, col:number, color:string, bounces:number, own:THREE.Material|null}>} */
    const discs = new Array(CELLS).fill(null);

    function spawn(i, colorName, instant, silent) {
        const row = (i / COLS) | 0;
        const col = i % COLS;
        const ty = HALF_ROW - row;
        const mesh = new THREE.Mesh(discGeo, discMats[colorName]);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.position.set(col - HALF_COL, instant ? ty : SPAWN_Y, 0);
        scene.add(mesh);
        const d = { mesh, mode: instant ? 'rest' : 'fall', y: instant ? ty : SPAWN_Y, vy: 0, ty, row, col, color: colorName, bounces: 0, own: null };
        discs[i] = d;
        if (instant && !silent) land(d, 0.6);
    }

    function land(d, speedFrac) {
        const h = Math.min(1, (SPAWN_Y - d.ty) / (SPAWN_Y + HALF_ROW + 0.6));
        camera.updateMatrixWorld();
        const v = new THREE.Vector3(d.col - HALF_COL, d.ty - 0.3, 0.2).project(camera);
        const r = host.getBoundingClientRect();
        try {
            api.landed({
                col: d.col, row: d.row, color: d.color, h: Math.max(0.15, h * (0.6 + 0.4 * speedFrac)),
                x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height,
            });
        } catch { /* feedback is best-effort */ }
    }

    // ── glow (win line) ──────────────────────────────────────────────────
    const glowTex = glowTexture();
    owned.push(glowTex);
    let glowState = null;
    function clearGlow() {
        if (!glowState) return;
        for (const g of glowState.discs) {
            if (g.d.own) { g.d.mesh.material = discMats[g.d.color]; g.d.own.dispose(); g.d.own = null; }
            g.d.mesh.position.z = 0;
        }
        for (const o of glowState.objects) { scene.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.(); }
        glowState = null;
    }
    function glow(cells, colorName = 'red', outcome = 'win') {
        clearGlow();
        if (!cells || !cells.length) { dirty = true; return; }
        const lit = colorOf(colorName, 'lit');
        const list = cells.map(({ row, col }) => discs[row * COLS + col]).filter(Boolean).map((d) => {
            d.own = d.mesh.material.clone();
            d.own.emissive = lit.clone();
            d.mesh.material = d.own;
            return { d };
        });
        const objects = [];
        const first = cells[0];
        const last = cells[cells.length - 1];
        const a = new THREE.Vector3(first.col - HALF_COL, HALF_ROW - first.row, 0.5);
        const b = new THREE.Vector3(last.col - HALF_COL, HALF_ROW - last.row, 0.5);
        const len = a.distanceTo(b);
        const soft = outcome !== 'win';
        const bar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.1, len + 0.9, 12),
            new THREE.MeshBasicMaterial({ color: lit, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        bar.position.copy(a).add(b).multiplyScalar(0.5);
        bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        bar.renderOrder = 5;
        scene.add(bar); objects.push(bar);
        const orb = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
        orb.scale.setScalar(2.2);
        orb.renderOrder = 6;
        scene.add(orb); objects.push(orb);
        const halos = list.map(({ d }) => {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: lit, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
            s.position.set(d.col - HALF_COL, d.ty, 0.6);
            s.renderOrder = 5;
            scene.add(s); objects.push(s);
            return s;
        });
        glowState = { t: 0, discs: list, objects, bar, orb, halos, a, b, soft, lit };
        dirty = true;
    }

    function stepGlow(dt) {
        const g = glowState;
        if (!g) return;
        g.t += dt;
        const reduce = api.reduced();
        const k = g.soft ? 0.4 : 1;
        g.bar.material.opacity = Math.min(0.55 * k, g.t * 2) * (g.t > 2.9 ? Math.max(0, (3.3 - g.t) / 0.4) : 1);
        g.orb.visible = !reduce && g.t < 1.9;
        if (g.orb.visible) {
            const phase = (g.t % 0.95) / 0.95;
            g.orb.position.lerpVectors(g.a, g.b, phase);
            g.orb.material.opacity = 0.9 * k * Math.sin(Math.PI * phase);
        }
        g.discs.forEach(({ d }, i) => {
            // Each disc lights as the sweep reaches it (all at once when motion is reduced).
            const on = g.t >= (reduce ? 0 : (i / Math.max(1, g.discs.length - 1)) * 0.8);
            const pulse = on ? 0.5 + 0.5 * Math.sin(g.t * 6.5 - i * 0.9) : 0;
            const fade = g.t > 2.9 ? Math.max(0, (3.3 - g.t) / 0.4) : 1;
            d.own.emissiveIntensity = DISC_GLOW + (0.35 + 0.9 * pulse) * k * fade * (on ? 1 : 0);
            if (!reduce) d.mesh.position.z = 0.1 * pulse * k;
            const h = g.halos[i];
            h.material.opacity = (0.25 + 0.55 * pulse) * k * fade * (on ? 1 : 0);
            h.scale.setScalar(1.7 + 0.5 * pulse);
        });
        dirty = true;
    }

    // ── DOM -> scene ─────────────────────────────────────────────────────
    let dirty = true;
    let tiltYaw = 0;
    let tiltPitch = 0;
    let targetCol = -1;
    let ghostWanted = null;
    const hoverCapable = () => { try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; } };

    function sync(snap) {
        if (disposed || !snap?.ok) return;
        const { state } = snap;
        const fresh = [];
        for (let i = 0; i < CELLS; i++) {
            const d = discs[i];
            if (state[i] && !d) fresh.push(i);
            else if (!state[i] && d && d.mode !== 'out') { d.mode = 'out'; d.vy = 0; discs[i] = null; outgoing.push(d); }
            else if (state[i] && d && d.mode === 'out') { /* re-filled the same frame: the new disc was spawned above */ }
        }
        const bulk = fresh.length > 2;
        const instant = bulk || api.reduced();
        for (const i of fresh) spawn(i, state[i] === 2 ? 'yellow' : 'red', instant, bulk);

        const g = snap.ghost;
        ghostWanted = null;
        ghost.visible = false;
        targetCol = g ? g.col : snap.cursor;
        dirty = true;
    }
    /** Discs released by a new game: they drop out of the bottom of the frame. */
    const outgoing = [];

    // ── placement over the DOM board ─────────────────────────────────────
    let lastPlace = '';
    let camDist = 30;
    function place() {
        const cells = board.querySelectorAll('.cf-cell');
        if (cells.length < CELLS) { host.style.visibility = 'hidden'; return; }
        const a = cells[0].getBoundingClientRect();
        const z = cells[CELLS - 1].getBoundingClientRect();
        if (a.width < 4) { host.style.visibility = 'hidden'; return; }
        const pitch = ((z.left + z.width / 2) - (a.left + a.width / 2)) / (COLS - 1);
        const cx = ((a.left + a.width / 2) + (z.left + z.width / 2)) / 2;
        const cy = ((a.top + a.height / 2) + (z.top + z.height / 2)) / 2;
        const size = pitch * WORLD_HALF * 2;
        const key2 = `${Math.round(cx * 2)}|${Math.round(cy * 2)}|${Math.round(size * 2)}`;
        if (key2 === lastPlace) return;
        lastPlace = key2;
        host.style.visibility = 'visible';
        host.style.left = `${cx - size / 2}px`;
        host.style.top = `${cy - size / 2}px`;
        host.style.width = `${size}px`;
        host.style.height = `${size}px`;
        camDist = WORLD_HALF / Math.tan((FOV * Math.PI) / 360);
        stage.resize();
        dirty = true;
    }

    // ── frame ────────────────────────────────────────────────────────────
    let badFrames = 0;
    function frame(dt) {
        if (disposed) return;
        place();
        const reduce = api.reduced();

        for (let i = 0; i < CELLS; i++) {
            const d = discs[i];
            if (!d || d.mode !== 'fall') continue;
            d.vy -= GRAVITY * dt;
            d.y += d.vy * dt;
            if (d.y <= d.ty) {
                const speed = -d.vy;
                d.y = d.ty;
                if (d.bounces === 0) land(d, Math.min(1, speed / 24));
                if (speed > 4 && d.bounces < 2) { d.vy = speed * 0.2; d.bounces++; }
                else { d.vy = 0; d.mode = 'rest'; }
            }
            d.mesh.position.y = d.y;
            dirty = true;
        }
        for (let k = outgoing.length - 1; k >= 0; k--) {
            const d = outgoing[k];
            d.vy -= GRAVITY * dt;
            d.y += d.vy * dt;
            d.mesh.position.y = d.y;
            if (d.y < -9) {
                scene.remove(d.mesh);
                d.own?.dispose();
                outgoing.splice(k, 1);
            }
            dirty = true;
        }
        stepGlow(dt);

        // Gentle tilt toward the active column; zero when nothing is active or motion is reduced.
        const wantYaw = !reduce && targetCol >= 0 ? ((targetCol - HALF_COL) / HALF_COL) * 0.075 : 0;
        const wantPitch = !reduce && targetCol >= 0 ? 0.035 : 0;
        const ny = damp(tiltYaw, wantYaw, 5, dt);
        const np = damp(tiltPitch, wantPitch, 5, dt);
        if (Math.abs(ny - tiltYaw) > 1e-5 || Math.abs(np - tiltPitch) > 1e-5 || Math.abs(ny - wantYaw) > 1e-4) dirty = true;
        tiltYaw = Math.abs(ny - wantYaw) < 1e-5 ? wantYaw : ny;
        tiltPitch = Math.abs(np - wantPitch) < 1e-5 ? wantPitch : np;
        const cp = Math.cos(tiltPitch);
        camera.position.set(Math.sin(tiltYaw) * cp * camDist, Math.sin(tiltPitch) * camDist, Math.cos(tiltYaw) * cp * camDist);
        camera.lookAt(0, 0, 0);

        if (!dirty && stage.shake.amount <= 0.0005) return;
        dirty = false;
        try {
            stage.render(() => renderer.render(scene, camera));
            badFrames = 0;
        } catch (err) {
            if (++badFrames >= 3) { console.warn('PoConnectFive 3D: render failed, back to 2D:', err?.message || err); api.onFail(); }
        }
    }

    // ── failure paths ────────────────────────────────────────────────────
    // The tier that matters is data-gfx (visualRuntime's adaptive loop writes it and announces it here).
    const onGfx = (e) => { if (e?.detail?.tier === 'low' || api.tier() === 'low') api.onFail(true); };
    window.addEventListener('po-gfx-tier', onGfx);
    stage.own(() => window.removeEventListener('po-gfx-tier', onGfx));
    stage.on('tier', (t) => { if (t === 'low') api.onFail(true); });
    stage.on('resize', () => { dirty = true; });
    stage.listen(renderer.domElement, 'webglcontextlost', (e) => { e.preventDefault(); api.onFail(); });
    try { renderer.backend?.device?.lost?.then(() => { if (!disposed) api.onFail(); }); } catch { /* no device handle */ }

    // First frame must succeed before the caller hides the DOM board.
    place();
    stage.resize();
    camera.position.set(0, 0, camDist);
    camera.lookAt(0, 0, 0);
    stage.render(() => renderer.render(scene, camera));
    stage.start();

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearGlow();
        stage.dispose();                       // loop, listeners, features, renderer + canvas
        disposeObject3D(scene);
        for (const o of owned) { try { o.dispose?.(); } catch { /* already gone */ } }
        host.remove();
    }

    return { sync, glow, dispose };
}
