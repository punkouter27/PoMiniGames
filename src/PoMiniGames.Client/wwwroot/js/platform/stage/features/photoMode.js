// photoMode.js (feature) — N (or Select on a pad) while playing: freeze the game, fly a free
// camera, pull focus, set exposure, save a PNG. Written once for every 3D stage.
//
// WHY it is built this way — the stage cannot draw by itself. Each game calls its own render
// (a RenderPipeline, a composer, a bare renderer.render) from its onFrame, so a paused stage
// has no "draw one frame" to call. Instead of editing every game, photo mode LEARNS the draw:
//   • for ~3 frames before pausing it wraps renderer.render and (WebGPU) RenderPipeline.render
//     to remember the scene and the game's own post pipeline;
//   • it then pauses the stage (the sim freezes, key/pointer input is swallowed so WASD does
//     not walk the player) and runs its own rAF that moves stage.camera and calls that same
//     pipeline, so bloom, grading and AA stay exactly as the player saw them;
//   • exposure and DoF are wrapped around the pipeline's outputNode (TSL, built lazily the
//     first time a slider moves, restored on exit). The DoF is three's own DepthOfFieldNode on
//     an extra scene pass for view-Z — photo mode only, so it costs nothing in play.
// Games that draw some other way set `stage.userData.photoRender = () => …` (called each photo
// frame, replaces everything above); without a WebGPU pipeline exposure falls back to
// renderer.toneMappingExposure and DoF is hidden.
//
// Esc / N restores the camera object exactly (position, quaternion, up, fov, near/far, zoom),
// the node graph, the exposure, the hidden HUD and the stage clock. Keys released while
// frozen get a synthetic keyup so the game does not see a stuck key.
//
// Gameplay only (the owner's rule for debug views): never while a dialog, the start card or the
// end card is up, while the stage is already paused, or with focus in a form control.
// A game opts out with `stage.userData.photoMode = false` or `exclude: ['photoMode']`; its key
// can move with `stage.userData.photoKey = 'KeyO'`.
//
// NEVER ONLINE. Pausing the stage and flying a free camera is a single-player act: in a live match the
// sim cannot stop, and a free camera would show the whole arena to one seat. So it never opens when
// `stage.userData.online === true`, when `stage.userData.isOnline()` says so (Brawl, Marble Race and
// VoxelStrike set it from their own online/multi flag), or - the catch-all for every game, hubs and
// lobbies included - when the route is /multi, /online or /lobby.
//
// NEVER A KEY THE GAME BINDS. The default is N: nothing in Brawl, Marble Race, Ecosystem, VoxelStrike,
// Cabinet, Racer, Fighter or Capitol uses it (P pauses in Brawl, Cabinet, Racer and Capitol and is the
// picture-in-picture key in Ecosystem, which is why it is not the default). A game that does bind it
// lists its keys in `stage.userData.boundKeys` (event.code strings) and photo mode takes the first of
// N, U, I, Y, Z that is free; and a keydown some game handler already consumed (defaultPrevented) is
// never ours.

import { registerFeature } from '../features.js';
import { saveBlob } from '../../fileDownload.js';

const MIN_WIDTH = 640;
const ONLINE_ROUTE = /\/(multi|online|lobby)(\/|$)/i;
const SWALLOW = ['mousedown', 'mouseup', 'click', 'dblclick', 'mousemove', 'touchstart', 'touchmove', 'touchend'];
const MOVE_KEYS = { KeyW: [0, 0, 1], KeyS: [0, 0, -1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyQ: [0, -1, 0], KeyE: [0, 1, 0],
    ArrowUp: [0, 0, 1], ArrowDown: [0, 0, -1], ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0] };

let styled = false;
function injectStyle() {
    if (styled) return;
    styled = true;
    const s = document.createElement('style');
    s.textContent = `
.po-photo{position:fixed;right:var(--po-space-4,16px);top:calc(var(--po-header-h,56px) + var(--po-space-3,12px));z-index:60;width:248px;
 max-width:calc(100vw - 2*var(--po-space-4,16px));padding:var(--po-space-3,12px) var(--po-space-4,16px);background:var(--po-surface);color:var(--po-text);
 border:1px solid var(--po-border);border-radius:var(--po-radius,12px);box-shadow:var(--po-shadow);font:var(--po-text-sm,14px)/1.35 var(--po-font,system-ui);
 display:grid;gap:var(--po-space-2,8px)}
.po-photo h2{margin:0;font-size:var(--po-text-md,16px);font-family:var(--po-font-display,inherit)}
.po-photo label{display:grid;gap:2px;color:var(--po-text-muted)}
.po-photo label span b{float:right;font-weight:500;color:var(--po-text);font-family:var(--po-font-mono,monospace)}
.po-photo input[type=range]{width:100%;accent-color:var(--po-accent)}
.po-photo .po-photo-row{display:flex;gap:var(--po-space-2,8px)}
.po-photo button{flex:1;min-height:36px;border-radius:var(--po-radius-sm,8px);border:1px solid var(--po-border);background:var(--po-surface-2);color:var(--po-text);font:inherit;cursor:pointer}
.po-photo button.primary{background:var(--po-accent);color:var(--po-on-accent);border-color:transparent}
.po-photo button:focus-visible,.po-photo input:focus-visible{outline:2px solid var(--po-focus);outline-offset:2px}
.po-photo small{color:var(--po-text-muted);font-size:var(--po-text-xs,12px)}
@media (max-width:640px){.po-photo{left:var(--po-space-4,16px);right:var(--po-space-4,16px);top:auto;bottom:var(--po-space-4,16px);width:auto}}`;
    document.head.append(s);
}

const modal = () => !!document.querySelector('dialog[open], .gps-intro-overlay, [aria-modal="true"]');
const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export default registerFeature({
    id: 'photoMode',
    kind: '3d',
    default: true,
    create(stage) {
        if (typeof document === 'undefined') return null;
        let active = false, busy = false;
        let cap = null;                 // { scene, pipeline, renderer }
        let saved = null;               // camera + renderer + graph state to restore
        let ui = null;
        let raf = 0, lastT = 0;
        let ctl = null;                 // orbit state
        const keys = new Set();         // physically held while frozen
        const downBefore = new Set();   // held when photo mode opened
        const tracked = new Set();      // every key currently down (always on, tiny)
        const hidden = [];
        const gfx = { exposure: 1, aperture: 0, focus: 12, hud: true, graph: null, dofBuilt: null, mode: 'orig' };
        let padWas = false;
        let status = null;

        const canvasEl = () => stage.renderer?.domElement ?? stage.canvas ?? null;
        const cam = () => stage.camera;
        const myKey = () => {
            const bound = new Set(stage.userData.boundKeys ?? []);
            if (stage.userData.photoKey && !bound.has(stage.userData.photoKey)) return stage.userData.photoKey;
            return ['KeyN', 'KeyU', 'KeyI', 'KeyY', 'KeyZ'].find((k) => !bound.has(k)) ?? 'KeyN';
        };
        const isOnline = () => {
            try {
                if (stage.userData.online === true) return true;
                if (typeof stage.userData.isOnline === 'function' && stage.userData.isOnline()) return true;
                return ONLINE_ROUTE.test(globalThis.location?.pathname ?? '');
            } catch { return false; }
        };

        // ── eligibility ─────────────────────────────────────────────────────────────────
        /** Why photo mode cannot open right now ('' when it can). Also the debug answer to "the photo key does nothing". */
        function whyNot(target) {
            const c = canvasEl();
            if (stage.disposed) return 'stage disposed';
            if (!c || !cam()) return 'no canvas or camera on the stage';
            if (!c.isConnected || c.clientWidth < MIN_WIDTH) return 'canvas hidden or too small';
            if (stage.userData.photoMode === false) return 'game opted out';
            if (isOnline()) return 'online play';
            if (stage.paused) return `stage paused (${stage.pauseReasons.join(',')})`;
            if (!stage.loop?.running) return 'stage not running';
            if (document.hidden) return 'tab hidden';
            if (modal()) return 'a dialog or card is open';
            if (typing(target)) return 'typing in a field';
            return '';
        }
        const eligible = (target) => !whyNot(target);

        // ── learn how the game draws ───────────────────────────────────────────────────
        async function prime() {
            const r = stage.renderer;
            const out = { scene: null, pipeline: null, renderer: r };
            if (!r || stage.userData.photoRender) return { ...out, custom: true };
            const hadOwn = Object.prototype.hasOwnProperty.call(r, 'render');
            const orig = r.render;
            r.render = function (scene, camera) { if (camera === cam()) out.scene = scene; return orig.apply(this, arguments); };
            let proto = null, protoOrig = null;
            if (r.isWebGPURenderer) {
                try {
                    const W = await import('three-eco/webgpu');
                    proto = (W.RenderPipeline ?? W.PostProcessing)?.prototype ?? null;
                    if (proto) {
                        protoOrig = proto.render;
                        proto.render = function () { if (this.renderer === r) out.pipeline = this; return protoOrig.apply(this, arguments); };
                    }
                } catch { /* plain render path */ }
            }
            for (let i = 0; i < 3; i++) await new Promise((res) => requestAnimationFrame(res));
            if (hadOwn) r.render = orig; else delete r.render;
            if (proto) proto.render = protoOrig;
            return out;
        }

        // ── enter / exit ────────────────────────────────────────────────────────────────
        async function enter() {
            if (active || busy) return false;
            busy = true;
            try {
                const c0 = cam();
                if (!c0) return false;
                cap = await prime();
                if (!eligible(null) || (!cap.custom && !cap.scene)) { cap = null; return false; }
                const c = cam();
                saved = {
                    pos: c.position.clone(), quat: c.quaternion.clone(), up: c.up.clone(), fov: c.fov, near: c.near, far: c.far, zoom: c.zoom,
                    exposure: stage.renderer.toneMappingExposure, output: cap.pipeline?.outputNode ?? null,
                };
                downBefore.clear(); for (const k of tracked) downBefore.add(k);
                gfx.exposure = 1; gfx.aperture = 0; gfx.mode = 'orig'; gfx.dofBuilt = null; gfx.graph = null; gfx.hud = true;
                const f = c.getWorldDirection(c.position.clone());
                gfx.focus = Math.max(2, Math.min(40, stage.userData.photoFocus ?? 12));
                ctl = {
                    tx: c.position.x + f.x * gfx.focus, ty: c.position.y + f.y * gfx.focus, tz: c.position.z + f.z * gfx.focus,
                    yaw: Math.atan2(f.x, f.z), pitch: Math.asin(Math.max(-1, Math.min(1, f.y))), dist: gfx.focus, drag: null, dx: 0, dy: 0,
                };
                active = true;
                stage.setPaused(true, 'photo');
                bindInput();
                buildUi();
                applyHud();
                lastT = performance.now();
                raf = requestAnimationFrame(tick);
                window.dispatchEvent(new CustomEvent('po-photo', { detail: { open: true } }));
                return true;
            } finally { busy = false; }
        }

        function exit() {
            if (!active) return;
            active = false;
            cancelAnimationFrame(raf);
            unbindInput();
            const c = cam();
            if (c && saved) {
                c.position.copy(saved.pos); c.quaternion.copy(saved.quat); c.up.copy(saved.up);
                c.fov = saved.fov; c.near = saved.near; c.far = saved.far; c.zoom = saved.zoom;
                c.updateProjectionMatrix?.(); c.updateMatrixWorld?.(true);
            }
            if (cap?.pipeline && saved?.output) { cap.pipeline.outputNode = saved.output; cap.pipeline.needsUpdate = true; }
            if (stage.renderer && saved) stage.renderer.toneMappingExposure = saved.exposure;
            for (const [el, v] of hidden.splice(0)) el.style.visibility = v;
            ui?.remove(); ui = null;
            // The game never saw the keyups of keys released while frozen: give them back.
            for (const code of downBefore) {
                if (!tracked.has(code)) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
            }
            keys.clear(); downBefore.clear();
            saved = null; cap = null; ctl = null;
            stage.setPaused(false, 'photo');
            window.dispatchEvent(new CustomEvent('po-photo', { detail: { open: false } }));
        }

        // ── drawing ─────────────────────────────────────────────────────────────────────
        function place() {
            const c = cam();
            const cp = Math.cos(ctl.pitch);
            const fx = Math.sin(ctl.yaw) * cp, fy = Math.sin(ctl.pitch), fz = Math.cos(ctl.yaw) * cp;
            c.position.set(ctl.tx - fx * ctl.dist, ctl.ty - fy * ctl.dist, ctl.tz - fz * ctl.dist);
            c.lookAt(ctl.tx, ctl.ty, ctl.tz);
            c.updateMatrixWorld(true);
            return [fx, fy, fz];
        }

        function draw() {
            if (stage.userData.photoRender) { stage.userData.photoRender(); return; }
            if (cap.pipeline) cap.pipeline.render();
            else cap.renderer.render(cap.scene, cam());
        }

        function tick(now) {
            if (!active) return;
            raf = requestAnimationFrame(tick);
            const dt = Math.min(0.1, (now - lastT) / 1000);
            lastT = now;
            pollPad(dt);
            let mx = 0, my = 0, mz = 0;
            for (const k of keys) { const v = MOVE_KEYS[k]; if (v) { mx += v[0]; my += v[1]; mz += v[2]; } }
            mx += ctl.pmx || 0; mz += ctl.pmz || 0; my += ctl.pmy || 0;
            if (mx || my || mz) {
                const sp = Math.max(2, ctl.dist * 0.8) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1) * dt;
                const cp = Math.cos(ctl.pitch);
                const fx = Math.sin(ctl.yaw) * cp, fy = Math.sin(ctl.pitch), fz = Math.cos(ctl.yaw) * cp;
                const rx = Math.cos(ctl.yaw), rz = -Math.sin(ctl.yaw);   // right vector, flat
                ctl.tx += (fx * mz + rx * mx) * sp; ctl.ty += (fy * mz + my) * sp; ctl.tz += (fz * mz + rz * mx) * sp;
            }
            place();
            try { draw(); } catch (e) { if (!tick.warned) { tick.warned = true; console.warn('[photo] draw failed', e); } }
            if (ctl.snap) { const snap = ctl.snap; ctl.snap = null; snap(); }   // toBlob in THIS task: the WebGPU canvas is still valid
        }

        // ── exposure / DoF graph (lazy) ───────────────────────────────────────────────
        async function applyGraph() {
            const p = cap?.pipeline;
            if (!p) { if (stage.renderer) stage.renderer.toneMappingExposure = (saved?.exposure ?? 1) * gfx.exposure; return; }
            const wantDof = gfx.aperture > 0.01;
            const want = wantDof ? 'dof' : (Math.abs(gfx.exposure - 1) > 0.01 ? 'exp' : 'orig');
            if (want === 'orig') { p.outputNode = saved.output; p.needsUpdate = true; gfx.mode = 'orig'; return; }
            if (!gfx.graph) {
                const { pass, uniform, convertToTexture, vec4 } = await import('three-eco/tsl');
                const { dof } = await import('three-eco/addons/tsl/display/DepthOfFieldNode.js');
                if (!active || !cap?.scene) return;
                const u = { exposure: uniform(1), focus: uniform(12), band: uniform(40), bokeh: uniform(0) };
                const base = convertToTexture(saved.output);
                const lit = vec4(base.rgb.mul(u.exposure), base.a);
                // Prefer the game's own scene pass (its depth is already drawn: free); a second pass of
                // the scene is the fallback, and costs a full extra scene render while photo mode is open.
                let scenePass = null;
                try { saved.output.traverse?.((n) => { if (!scenePass && n.isPassNode) scenePass = n; }); } catch { /* fallback */ }
                const viewZ = (scenePass ?? pass(cap.scene, cam())).getViewZNode();
                gfx.graph = { u, exp: lit, dof: null, build: () => convertToTexture(dof(convertToTexture(lit), viewZ, u.focus, u.band, u.bokeh)) };
            }
            const g = gfx.graph;
            g.u.exposure.value = gfx.exposure; g.u.focus.value = gfx.focus;
            g.u.band.value = 60 - 58 * Math.min(1, gfx.aperture);     // smaller band = shallower focus
            g.u.bokeh.value = 0.5 + 2.5 * gfx.aperture;
            if (want === 'dof' && !g.dof) g.dof = g.build();
            const node = want === 'dof' ? g.dof : g.exp;
            if (gfx.mode !== want) { p.outputNode = node; p.needsUpdate = true; gfx.mode = want; }
        }

        // ── HUD ─────────────────────────────────────────────────────────────────────────
        function applyHud() {
            for (const [el, v] of hidden.splice(0)) el.style.visibility = v;
            if (!gfx.hud) return;
            // The HUD is whatever else sits beside the canvas: walk up from it to the game area and hide
            // each level's siblings (not the chain itself, and never the page header or our panel).
            const els = [];
            let node = canvasEl();
            for (let i = 0; i < 5 && node && node.parentElement && node !== document.body; i++) {
                const up = node.parentElement;
                for (const sib of up.children) if (sib !== node && !sib.matches('script, style, .po-photo')) els.push(sib);
                if (up.matches('.gps-game-area, .gps-shell, main') ) break;
                node = up;
            }
            els.push(...document.querySelectorAll('.po-version, .gps-stats-toggle'));
            for (const el of els) { hidden.push([el, el.style.visibility]); el.style.visibility = 'hidden'; }
        }

        // ── UI ──────────────────────────────────────────────────────────────────────────
        function buildUi() {
            injectStyle();
            const el = document.createElement('section');
            el.className = 'po-photo';
            el.setAttribute('role', 'region');
            el.setAttribute('aria-label', 'Photo mode');
            const slider = (id, label, min, max, step, val) =>
                `<label><span>${label}<b id="po-ph-${id}-v"></b></span><input id="po-ph-${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
            el.innerHTML = `<h2>Photo mode</h2>
${cap.pipeline ? slider('focus', 'Focus distance', 1, 80, 0.5, gfx.focus) + slider('ap', 'Aperture', 0, 1, 0.01, 0) : ''}
${slider('exp', 'Exposure', 0.25, 3, 0.05, 1)}
<label style="display:flex;gap:8px;align-items:center"><input id="po-ph-hud" type="checkbox" checked> Hide HUD</label>
<div class="po-photo-row"><button class="primary" id="po-ph-save" type="button">Save PNG</button><button id="po-ph-exit" type="button">Exit</button></div>
<small id="po-ph-msg">Drag orbit, right-drag or WASD move, wheel zoom. Esc exits.</small>`;
            document.body.append(el);
            ui = el;
            status = el.querySelector('#po-ph-msg');
            const show = () => {
                const set = (id, t) => { const n = el.querySelector(`#po-ph-${id}-v`); if (n) n.textContent = t; };
                set('focus', `${gfx.focus.toFixed(1)} m`); set('ap', gfx.aperture > 0.01 ? gfx.aperture.toFixed(2) : 'off'); set('exp', `${gfx.exposure.toFixed(2)}x`);
            };
            show();
            const on = (id, fn) => el.querySelector(`#po-ph-${id}`)?.addEventListener('input', (e) => { fn(e.target); show(); applyGraph(); });
            on('focus', (t) => { gfx.focus = +t.value; });
            on('ap', (t) => { gfx.aperture = +t.value; });
            on('exp', (t) => { gfx.exposure = +t.value; });
            el.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('change', () => r.blur()));
            el.querySelector('#po-ph-hud').addEventListener('change', (e) => { gfx.hud = e.target.checked; applyHud(); });
            el.querySelector('#po-ph-save').addEventListener('click', savePng);
            el.querySelector('#po-ph-exit').addEventListener('click', exit);
        }

        function savePng() {
            if (!active) return;
            const c = canvasEl();
            ctl.snap = () => c.toBlob((b) => {
                if (!b) { if (status) status.textContent = 'Could not capture the picture.'; return; }
                const name = `pominigames-photo-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.png`;
                saveBlob(name, b);
                if (status) status.textContent = `Saved ${name}`;
            }, 'image/png');
        }

        // ── input ───────────────────────────────────────────────────────────────────────
        const inPanel = (e) => !!ui && ui.contains(e.target);
        const inView = (e) => { const c = canvasEl(); return !!c && (e.target === c || stage.container?.contains(e.target)) && !inPanel(e); };
        const onKeyDown = (e) => {
            if (inPanel(e) && e.code !== 'Escape') return;
            if (e.code === 'Escape' || e.code === myKey()) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) exit(); return; }
            if (e.ctrlKey || e.metaKey || e.altKey || e.code === 'Tab' || /^F\d/.test(e.code)) return;
            e.stopImmediatePropagation();
            tracked.add(e.code);
            if (MOVE_KEYS[e.code] || e.code.startsWith('Shift')) { e.preventDefault(); keys.add(e.code); }
        };
        const onKeyUp = (e) => { if (inPanel(e)) return; keys.delete(e.code); tracked.delete(e.code); if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation(); };
        const onDown = (e) => {
            if (!inView(e)) return;
            e.stopImmediatePropagation();
            if (e.type !== 'pointerdown') return;
            e.preventDefault();
            ctl.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
            ctl.pts ??= new Map(); ctl.pts.set(e.pointerId, [e.clientX, e.clientY]);
            try { canvasEl().setPointerCapture(e.pointerId); } catch { /* fine */ }
        };
        const onMove = (e) => {
            if (!ctl) return;
            if (!ctl.drag && inView(e)) { e.stopImmediatePropagation(); return; }
            if (e.type !== 'pointermove' || !ctl.drag || e.pointerId !== ctl.drag.id) return;
            e.stopImmediatePropagation();
            const dx = e.clientX - ctl.drag.x, dy = e.clientY - ctl.drag.y;
            ctl.drag.x = e.clientX; ctl.drag.y = e.clientY;
            if (ctl.pts?.size === 2) {   // pinch: dolly by the change in finger distance
                const o = [...ctl.pts.entries()].find(([id]) => id !== e.pointerId)[1];
                const before = Math.hypot(e.clientX - dx - o[0], e.clientY - dy - o[1]);
                const after = Math.hypot(e.clientX - o[0], e.clientY - o[1]);
                if (before > 0) ctl.dist = Math.max(0.5, Math.min(200, ctl.dist * before / after));
                ctl.pts.set(e.pointerId, [e.clientX, e.clientY]);
                return;
            }
            ctl.pts?.set(e.pointerId, [e.clientX, e.clientY]);
            if (ctl.drag.pan) {
                const k = ctl.dist * 0.0015;
                const rx = Math.cos(ctl.yaw), rz = -Math.sin(ctl.yaw);
                ctl.tx -= rx * dx * k; ctl.tz -= rz * dx * k; ctl.ty += dy * k;
            } else { ctl.yaw -= dx * 0.006; ctl.pitch = Math.max(-1.5, Math.min(1.5, ctl.pitch - dy * 0.006)); }
        };
        const onUp = (e) => { if (ctl?.drag?.id === e.pointerId) ctl.drag = null; ctl?.pts?.delete(e.pointerId); if (inView(e)) e.stopImmediatePropagation(); };
        const onWheel = (e) => { if (!inView(e)) return; e.preventDefault(); e.stopImmediatePropagation(); ctl.dist = Math.max(0.5, Math.min(200, ctl.dist * Math.exp(e.deltaY * 0.0012))); };
        const onCtx = (e) => { if (inView(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
        const swallow = (e) => { if (inView(e)) e.stopImmediatePropagation(); };
        function bindInput() {
            window.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('keyup', onKeyUp, true);
            window.addEventListener('pointerdown', onDown, true);
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onUp, true);
            window.addEventListener('wheel', onWheel, { capture: true, passive: false });
            window.addEventListener('contextmenu', onCtx, true);
            for (const t of SWALLOW) window.addEventListener(t, swallow, true);
        }
        function unbindInput() {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
            window.removeEventListener('wheel', onWheel, { capture: true });
            window.removeEventListener('contextmenu', onCtx, true);
            for (const t of SWALLOW) window.removeEventListener(t, swallow, true);
        }

        // ── gamepad: Select opens; sticks fly, triggers raise/lower, A saves, B exits ──────
        function pollPad(dt) {
            const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
            if (!pad || !ctl) return;
            const dz = (v) => (Math.abs(v) < 0.2 ? 0 : v);
            ctl.pmx = dz(pad.axes[0]); ctl.pmz = -dz(pad.axes[1]);
            ctl.pmy = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
            ctl.yaw -= dz(pad.axes[2] ?? 0) * 2 * dt;
            ctl.pitch = Math.max(-1.5, Math.min(1.5, ctl.pitch - dz(pad.axes[3] ?? 0) * 1.6 * dt));
            const a = !!pad.buttons[0]?.pressed, b = !!pad.buttons[1]?.pressed;
            if (a && !padWas) savePng();
            if (b && !padWas) exit();
            padWas = a || b;
        }
        let selWas = false;
        let padSeen = false;
        stage.listen(window, 'gamepadconnected', () => { padSeen = true; });
        const padOpen = () => {
            if (!padSeen) return;
            const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
            const sel = !!pad?.buttons[8]?.pressed;
            if (sel && !selWas && !active && eligible(null)) enter();
            selWas = sel;
        };

        // ── hotkey (always on, passive) ───────────────────────────────────────────────
        stage.listen(window, 'keydown', (e) => {
            tracked.add(e.code);
            if (active || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            if (e.code === myKey() && eligible(e.target)) enter();
        });
        stage.listen(window, 'keyup', (e) => { tracked.delete(e.code); });
        stage.listen(window, 'blur', () => { tracked.clear(); });

        stage.own(() => { if (active) exit(); });
        const api = { why: () => whyNot(null), get active() { return active; }, get saved() { return saved; }, get camera() { return cam(); }, enter, exit, savePng, state: gfx, setLook(o) { Object.assign(gfx, o); applyGraph(); ui?.querySelectorAll('input[type=range]').forEach((r) => { const k = { 'po-ph-focus': gfx.focus, 'po-ph-ap': gfx.aperture, 'po-ph-exp': gfx.exposure }[r.id]; if (k !== undefined) { r.value = k; r.dispatchEvent(new Event('input')); } }); } };
        stage.photo = api;
        window.PoPhoto = api;
        return {
            update() { padOpen(); },
            dispose() { if (active) exit(); if (window.PoPhoto === api) window.PoPhoto = null; if (stage.photo === api) stage.photo = null; },
        };
    },
});
