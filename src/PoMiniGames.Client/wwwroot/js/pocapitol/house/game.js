// pocapitol/house/game.js — the House map as a running game: input, the frame loop, and what the page is told.
//
// index.js owns window.PoCapitol and the Capitol grounds scenario. When the start card's Map
// dropdown says House it builds this instead and hands its calls on: the same init / start /
// pause / dispose, the same OnUpdate record to the page, the same stored comfort settings and
// key bindings (prefs.js), the same touch buttons and gamepad layout. What differs is the view
// (first person, the mouse aims up and down as well as round) and the rules (world.js here).
//
// The demo is the same game with autopilot.js at the controls: it plays an attempt through,
// waits six seconds on the result and starts another, and nothing is saved.

import { createHouseScene } from './scene.js';
import { loadNav } from './nav.js';
import { createHouseAttempt, advance, fire, throwPlayerGrenade, setPaused, summary } from './world.js';
import { createAutopilot } from './autopilot.js';
import { createAudio } from '../audio.js';
import { createUiFx } from '../ui.js';
import { matches } from '../prefs.js';
import { connectedPads, stick, pressed, ButtonEdges } from '../../platform/gamepadBus.js';

const nowMs = () => globalThis.performance?.now?.() ?? Date.now();
const PITCH = 1.25;                       // radians up or down the officer can look
const LEVEL_LABEL = { low: 'Low', auto: 'Auto', high: 'High' };

/**
 * Which level (scene.js LEVELS) a graphics mode means on this device. The full scan (48 MB, 2M gaussians)
 * needs WebGPU and more than a low-tier device: without both, every mode draws the light one.
 */
function levelFor(mode, tier, webgpu) {
    if (mode === 'low' || tier === 'low' || !webgpu) return 'low';
    return mode === 'high' ? 'high' : 'auto';
}

/** The floor plan in the corner: where the officer is, which room is next, who has been seen. */
function createPlan(nav) {
    const base = document.createElement('canvas');
    base.width = nav.cols; base.height = nav.rows;
    const paint = base.getContext('2d');
    const image = paint.createImageData(nav.cols, nav.rows);
    for (let r = 0; r < nav.rows; r++) {
        for (let c = 0; c < nav.cols; c++) {
            const i = (r * nav.cols + c) * 4, h = nav.planHeight(c, r);
            if (nav.planWalk(c, r)) image.data.set([206, 198, 184, 235], i);          // floor
            else if (h > 0.3 && h < 1.75) image.data.set([128, 118, 104, 235], i);    // furniture
            else if (h >= 1.75) image.data.set([40, 37, 34, 235], i);                 // wall
            else if (h >= 0) image.data.set([150, 142, 130, 160], i);                 // floor nobody can reach
        }
    }
    paint.putImageData(image, 0, 0);
    // The grid covers more than the house: draw only the part with floor in it.
    let c0 = nav.cols, c1 = 0, r0 = nav.rows, r1 = 0;
    for (let r = 0; r < nav.rows; r++) for (let c = 0; c < nav.cols; c++) {
        if (!nav.planWalk(c, r)) continue;
        c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
    }
    c0 = Math.max(0, c0 - 6); r0 = Math.max(0, r0 - 6); c1 = Math.min(nav.cols - 1, c1 + 6); r1 = Math.min(nav.rows - 1, r1 + 6);
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    let canvas = null, ctx = null;
    return {
        aspect: w / h,
        draw(state, yaw) {
            const found = document.getElementById('pocapitol-housemap');
            if (!found) return;
            if (found !== canvas) {
                canvas = found; ctx = canvas.getContext('2d');
                canvas.width = w * 3; canvas.height = h * 3;
            }
            const k = canvas.width / w;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(base, c0, r0, w, h, 0, 0, canvas.width, canvas.height);
            const at = (x, z) => { const [c, r] = nav.plan(x, z); return [(c - c0) * k, (r - r0) * k]; };
            // Rooms: cleared ones dimmed green, the next one outlined.
            for (const room of state.rooms) {
                // The second wave is not a place: it has nothing to outline.
                if (!nav.rooms[room.index]) continue;
                const rects = nav.rooms[room.index].rects;
                const cleared = room.left === 0, next = room.index === state.objective;
                if (!cleared && !next) continue;
                const rect = rects[0];
                const [x0, y0] = at(rect.x0, rect.z0), [x1, y1] = at(rect.x1, rect.z1);
                if (cleared) { ctx.fillStyle = 'rgba(70, 150, 90, 0.28)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
                else { ctx.strokeStyle = 'rgba(255, 196, 84, 0.95)'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2); ctx.setLineDash([]); }
            }
            // Raiders the officer has eyes on, or had a moment ago.
            ctx.fillStyle = '#d8452f';
            for (const r of state.companions) {
                if (r.health <= 0 || state.elapsed - (r.spottedAt ?? -99) > 2.5) continue;
                const [x, y] = at(r.x, r.z);
                ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
            }
            const [px, py] = at(state.player.x, state.player.z);
            ctx.save();
            ctx.translate(px, py); ctx.rotate(-yaw);
            ctx.fillStyle = '#2f7de0'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.restore();
        },
    };
}

/**
 * Build the House map in `host`. Resolves once the light scan is drawn and the start card can
 * show; the full scan streams in behind it.
 * @param reference  the page (DotNetObjectReference): OnUpdate, OnEngineError
 * @param figure     crowd.js loadFigure()
 * @param getPrefs   () => the current comfort settings and key map (prefs.js), read every frame
 * @param mode       stored graphics mode: 'auto' | 'low' | 'high'
 * @param tier       the device's tier: 'low' | 'medium' | 'high'
 * @param track      index.js's telemetry sink
 * @param toMainMenu Esc
 */
export async function createHouseGame({ host, reference, figure, getPrefs, mode = 'auto', tier = 'medium', track = () => {}, toMainMenu = () => {} }) {
    const bootAt = nowMs();
    const nav = await loadNav();
    // A small "Loading the house 42%" chip over the canvas while a scan file downloads.
    const chip = document.createElement('div');
    chip.className = 'pc-scan-loading';
    chip.setAttribute('role', 'status');
    chip.hidden = true;
    chip.innerHTML = '<span></span><i><b></b></i><em></em>';
    host.parentElement?.append(chip);
    const onScan = (percent, label) => {
        if (percent === null) { chip.hidden = true; return; }
        chip.hidden = false;
        chip.children[0].textContent = label ?? 'Loading the house';
        chip.querySelector('b').style.width = `${Math.round(percent)}%`;
        chip.children[2].textContent = `${Math.round(percent)}%`;
    };
    const view = await createHouseScene(host, { figure, nav, onScan });
    const webgpu = view.scan().backend === 'webgpu';
    const plan = createPlan(nav);
    const g = {
        host, view, nav, reference, state: createHouseAttempt(nav, 'standard', 1), started: false, disposed: false, ended: false,
        yaw: nav.start.yaw, pitch: 0, keys: new Set(), firing: false, drag: null, edges: new ButtonEdges(),
        notifyAt: 0, notifying: false, message: '', planAt: 0,
        events: new AbortController(), audio: null, ui: null, mode, tier,
        frames: [], longFrames: 0, initMs: 0, selfUnlock: -1e9,
        demo: false, pilot: createAutopilot(nav), restartAt: 0, difficulty: 'standard',
    };
    // The level's own scan (the full 48 MB one, off the low tier) streams in behind the start card.
    view.applyLevel(levelFor(mode, tier, webgpu));
    const applyPrefs = () => {
        const prefs = getPrefs();
        view.setFov(prefs.fov); view.setTracerMode(prefs.tracers); view.setMotionReduction(prefs.motion === 'reduced');
    };
    applyPrefs();
    try { g.ui = createUiFx(host.parentElement); } catch (error) { console.warn('[PoCapitol] interface effects unavailable:', error); }

    const signal = g.events.signal;
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const clearInput = () => { g.keys.clear(); g.firing = false; g.drag = null; };
    const held = action => { const prefs = getPrefs(); for (const code of g.keys) if (matches(prefs, action, code)) return true; return false; };
    const bound = action => { const prefs = getPrefs(); for (const code of g.keys) if (prefs.keys[action] === code) return true; return false; };
    const live = () => g.started && g.state.status === 'active';
    const releasePointer = () => { g.selfUnlock = nowMs(); try { document.exitPointerLock(); } catch { /* not locked */ } };
    const look = (dx, dy, scale) => {
        const sensitivity = getPrefs().sensitivity;
        g.yaw -= dx * scale * sensitivity;
        g.pitch = Math.max(-PITCH, Math.min(PITCH, g.pitch - dy * scale * sensitivity));
    };

    function pause(value) {
        if (!g.started) return;
        const was = g.state.status === 'paused';
        setPaused(g.state, value);
        clearInput();
        if ((g.state.status === 'paused') !== was) g.ui?.wipe?.('pass');
        if (value && document.pointerLockElement === view.canvas) releasePointer();
        notify();
    }

    const lob = kind => {
        if (!live()) return false;
        const mark = g.state.events.length;
        const thrown = throwPlayerGrenade(g.state, nav, view.aim(g.yaw, g.pitch), kind);
        for (let i = mark; i < g.state.events.length; i++) g.audio?.event(g.state.events[i]);
        if (thrown) navigator.vibrate?.(kind === 'smoke' ? 12 : 25);
        return Boolean(thrown);
    };

    // Esc with a menu open belongs to the menu (Radzen closes it before the key reaches window).
    let escSuppressed = false;
    const MENUS = 'dialog[open], .rz-dialog-wrapper, .rz-dialog-side, .game-opts-sheet, [data-po-dialog]';
    listen(document, 'keydown', e => { if (e.code === 'Escape') escSuppressed = Boolean(document.querySelector(`${MENUS}, [role="dialog"][aria-modal="true"]`)); }, { capture: true });
    listen(window, 'keydown', e => {
        if (!g.started || e.target.closest?.('input, select, textarea, [role="slider"]')) return;
        if (e.code === 'Escape' && !e.repeat) {
            const blocked = escSuppressed;
            escSuppressed = false;
            if (g.state.status === 'active' && !blocked && !document.querySelector(MENUS)) { e.preventDefault(); toMainMenu(); }
            return;
        }
        if (matches(getPrefs(), 'pause', e.code) && !e.repeat) { pause(g.state.status === 'active'); e.preventDefault(); return; }
        // The demo plays itself: only pause and Esc are the watcher's.
        if (g.demo || !live() || e.target.closest?.('button, a, summary, [role="radio"]')) return;
        if ((e.code === 'KeyG' || e.code === 'KeyH') && !e.repeat) { if (lob(e.code === 'KeyH' ? 'smoke' : 'concussion')) e.preventDefault(); return; }
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight'
            || ['forward', 'back', 'left', 'right', 'push', 'sprint'].some(action => matches(getPrefs(), action, e.code))) {
            g.keys.add(e.code); e.preventDefault();
        }
    });
    listen(window, 'keyup', e => g.keys.delete(e.code));
    // A player who looks away is paused; the demo carries on, as the Capitol's does.
    listen(window, 'blur', () => { clearInput(); if (!g.demo) pause(true); });
    listen(document, 'visibilitychange', () => { if (document.hidden) { clearInput(); if (!g.demo) pause(true); } });
    // With the pointer locked the browser keeps Esc for itself: a release the game did not ask
    // for, with the tab still focused, is read as that Esc (as on the Capitol map).
    listen(document, 'pointerlockchange', () => {
        if (document.pointerLockElement === view.canvas || !g.started) return;
        clearInput();
        if (nowMs() - g.selfUnlock < 600 || g.state.status !== 'active') return;
        setTimeout(() => {
            if (g.disposed || g.state.status !== 'active') return;
            if (document.hasFocus() && !document.hidden) toMainMenu(); else pause(true);
        }, 120);
    });
    listen(document, 'mousemove', e => {
        if (!live() || document.pointerLockElement !== view.canvas) return;
        look(e.movementX, e.movementY, 0.0022);
    });
    listen(view.canvas, 'pointerdown', e => {
        if (!live() || g.demo) return;
        if (e.pointerType === 'touch') {
            g.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
            view.canvas.setPointerCapture(e.pointerId);
        } else if (document.pointerLockElement === view.canvas) {
            g.firing = e.button === 0;
        } else {
            const unavailable = error => {
                console.warn('[PoCapitol] pointer lock unavailable:', error);
                g.message = 'Mouse capture unavailable. Use the arrow keys to turn, or drag on a touchscreen.';
            };
            try { view.canvas.requestPointerLock()?.catch(unavailable); } catch (error) { unavailable(error); }
        }
    });
    listen(view.canvas, 'pointermove', e => {
        if (!g.drag || g.drag.id !== e.pointerId || !live()) return;
        look(e.clientX - g.drag.x, e.clientY - g.drag.y, 0.005);
        g.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    listen(window, 'pointerup', () => { g.firing = false; g.drag = null; });
    listen(window, 'pointercancel', clearInput);
    listen(view.canvas, 'contextmenu', e => e.preventDefault());
    listen(view.canvas, 'webglcontextlost', e => {
        e.preventDefault(); pause(true); g.started = false;
        reference.invokeMethodAsync('OnEngineError', 'The browser lost its 3D graphics context.').catch(() => {});
    });
    // The page's touch buttons name an action; the key injected is whatever it is bound to now.
    const touchHeld = new WeakMap();
    listen(host.parentElement, 'pointerdown', e => {
        if (g.demo) return;
        const thrower = e.target.closest('[data-capitol-throw]');
        if (thrower) { e.preventDefault(); lob(thrower.dataset.capitolThrow); return; }
        const button = e.target.closest('[data-capitol-action]');
        if (!button || !live()) return;
        const code = getPrefs().keys[button.dataset.capitolAction];
        if (!code) return;
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        touchHeld.set(button, code);
        g.keys.add(code);
    });
    const releaseButton = e => {
        const button = e.target.closest('[data-capitol-action]');
        const code = button && touchHeld.get(button);
        if (!code) return;
        touchHeld.delete(button);
        g.keys.delete(code);
    };
    listen(host.parentElement, 'pointerup', releaseButton);
    listen(host.parentElement, 'pointercancel', releaseButton);
    listen(host.parentElement, 'lostpointercapture', releaseButton);

    function notify() {
        if (g.notifying || g.disposed) return;
        g.notifying = true;
        const s = g.state;
        const room = s.objective >= 0 ? s.rooms[s.objective] : null;
        // The Capitol map's record, read the House map's way: `milestone` is rooms cleared (the
        // second wave counts as one more), the "line" is the room to clear next (one past the
        // last room is the wave) and its "integrity" how many raiders are left in it. The crowd
        // is everyone, the second wave included, and whoever is not down yet is still standing.
        reference.invokeMethodAsync('OnUpdate', Math.round(s.health), s.milestone, s.elapsed, s.status,
            s.total, g.message, s.total - s.stats.down, 1, 0, g.demo, s.outcome, 1,
            room ? room.index : -1, room ? room.left : 0, LEVEL_LABEL[view.level()] ?? 'Auto', 0, s.playerGrenades, s.playerSmoke)
            .catch(error => {
                if (g.disposed) return;
                console.error('[PoCapitol] player interface update failed:', error);
                setPaused(g.state, true);
                host.dataset.interfaceError = 'Game paused because the player interface could not update. Reload or return to all games.';
            }).finally(() => { g.notifying = false; });
    }

    const stage = view.stage;
    function loop(elapsed) {
        if (g.disposed) return;
        try {
            const now = stage.time * 1000;
            const dt = Math.min(0.05, elapsed);
            const frameMs = elapsed * 1000;
            g.frames.push(frameMs); if (g.frames.length > 240) g.frames.shift();
            if (frameMs > 55) g.longFrames++;
            const pad = connectedPads()[0];
            const edges = g.edges.update(pad);
            if (g.started && edges.includes(9)) pause(g.state.status === 'active');
            if (!g.demo && edges.includes(2)) lob('concussion');
            if (!g.demo && edges.includes(3)) lob('smoke');
            // The demo's result stays up for six seconds, then it plays again.
            if (g.started && g.demo && g.restartAt && now >= g.restartAt) begin(g.difficulty, true);
            const s = g.state;
            // Whether the attempt moves on this frame: what it throws up is heard and acted on once.
            const stepped = live();
            if (stepped && g.demo) {
                const auto = g.pilot.step(s, dt);
                g.yaw = auto.yaw; g.pitch = auto.pitch;
                advance(s, nav, { x: auto.x, z: auto.z, sprint: auto.sprint }, dt);
                if (auto.fire) fire(s, nav, view.aim(g.yaw, g.pitch));
                if (auto.lob) throwPlayerGrenade(s, nav, view.aim(g.yaw, g.pitch), auto.lob);
            } else if (stepped) {
                const left = pad ? stick(pad) : { x: 0, y: 0 };
                const right = pad ? stick(pad, 0.2, 1) : { x: 0, y: 0 };
                g.yaw -= ((g.keys.has('ArrowRight') ? 1 : 0) - (g.keys.has('ArrowLeft') ? 1 : 0) + right.x) * dt * 2.2;
                g.pitch = Math.max(-PITCH, Math.min(PITCH, g.pitch - right.y * dt * 1.6));
                const strafe = (bound('right') ? 1 : 0) - (bound('left') ? 1 : 0) + left.x;
                const forward = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0) - left.y;
                const x = strafe * Math.cos(g.yaw) - forward * Math.sin(g.yaw);
                const z = -strafe * Math.sin(g.yaw) - forward * Math.cos(g.yaw);
                advance(s, nav, { x, z, sprint: held('sprint') || pressed(pad, 10) }, dt);
                if (g.firing || held('push') || pressed(pad, 7)) fire(s, nav, view.aim(g.yaw, g.pitch));
            }
            if (stepped) {
                for (const event of s.events) {
                    g.audio?.event(event);
                    if (event.type === 'grenade') {
                        const near = 1 / (1 + Math.hypot(event.x - s.player.x, event.z - s.player.z) / 4);
                        if (near > 0.15) g.ui?.rumble?.(near, 320);
                    }
                }
                // Who the officer can see right now, for the plan in the corner.
                for (const r of s.companions) {
                    if (r.health > 0 && Math.hypot(r.x - s.player.x, r.z - s.player.z) < 14 && nav.clearLine(s.player.x, s.player.z, r.x, r.z, 1.4)) r.spottedAt = s.elapsed;
                }
                if (s.status === 'completed' || s.status === 'failed') {
                    clearInput();
                    if (!g.ended) {
                        g.ended = true;
                        g.ui?.wipe?.('pass');
                        track('end', { mode: g.demo ? 'house-demo' : 'house', outcome: s.outcome, seconds: Math.round(s.elapsed) });
                        g.notifyAt = 0;
                        if (g.demo) g.restartAt = now + 6000;
                    }
                    if (document.pointerLockElement === view.canvas) releasePointer();
                }
            }
            view.render(s, g.yaw, g.pitch, dt, elapsed);
            if (!g.started) return;
            host.dataset.damaged = s.damageFlash > 0 ? 'true' : 'false';
            host.dataset.hazard = '';
            host.dataset.flash = s.flashed > 0.25 && window.PoQuality?.reduceFlashing?.() !== true ? 'true' : 'false';
            if (g.audio) {
                const active = s.status === 'active';
                const walkers = [];
                for (const r of s.companions) {
                    const distance = Math.hypot(r.x - s.player.x, r.z - s.player.z);
                    if (r.health > 0 && r.moving && distance < 9) walkers.push({ x: r.x, z: r.z, mass: r.mass, distance });
                }
                walkers.sort((a, b) => a.distance - b.distance);
                // `elapsed` stays 0 here: the Capitol map's clock drives its curfew alert off it.
                g.audio.update({ x: s.player.x, z: s.player.z, yaw: g.yaw, focus: s.player, active, crowd: 0, morale: 0, pressure: 0, shear: 0, police: 0,
                    walkers: walkers.slice(0, 4), walking: s.player.moving && active, gassed: false, elapsed: 0, health: s.health }, dt);
            }
            if (now >= g.planAt) { g.planAt = now + 80; plan.draw(s, g.yaw); }
            if (now >= g.notifyAt) { g.notifyAt = now + 200; notify(); }
        } catch (error) {
            stage.stop();
            console.error('[PoCapitol] house frame failed:', error);
            track('frame-error', { message: String(error?.message ?? error), map: 'house' });
            g.started = false;
            reference.invokeMethodAsync('OnEngineError', error.message).catch(() => {});
        }
    }
    /** A new attempt: the player's, or the demo's own. */
    function begin(difficulty, demo) {
        g.demo = Boolean(demo);
        // The demo plays the standard game: all seventeen raiders, and the autopilot usually wins.
        g.difficulty = g.demo ? 'standard' : difficulty === 'story' ? 'story' : 'standard';
        g.state = createHouseAttempt(nav, g.difficulty, (Date.now() & 0x7fffffff) || 1);
        g.yaw = nav.start.yaw; g.pitch = 0; clearInput(); g.pilot.reset();
        g.started = true; g.ended = false; g.message = ''; g.notifyAt = 0; g.restartAt = 0;
        track('start', { mode: g.demo ? 'house-demo' : 'house', difficulty: g.difficulty, level: view.level() });
        g.ui?.wipe?.('reveal');
        // Made on the first start. A player's follows a click; the demo's may not, and then the
        // browser keeps it silent until there is one, like every other demo here.
        g.audio ??= createAudio({ setting: 'house' });
        if (!g.demo) view.canvas.focus();
    }

    stage.on('frame', loop);
    stage.start();
    g.initMs = Math.round(nowMs() - bootAt);
    track('init', { ms: g.initMs, tier, map: 'house' });

    return {
        map: 'house', view, nav,
        get state() { return g.state; },
        get demo() { return g.demo; },
        start(difficulty, demo = false) { begin(difficulty, demo); },
        pause,
        setGraphics(next) {
            g.mode = next;
            view.applyLevel(levelFor(next, g.tier, webgpu));
            return LEVEL_LABEL[view.level()] ?? 'Auto';
        },
        applyPrefs,
        summary: () => summary(g.state),
        /** Headless checks only (window.__pocapitol()): point the officer's eyes. */
        look(yaw, pitch = 0) { g.yaw = yaw; g.pitch = pitch; },
        diagnostics() {
            const scan = view.scan();
            const sorted = [...g.frames].sort((a, b) => a - b);
            const at = p => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10 : 0;
            return { map: 'house', status: g.state.status, initMs: g.initMs, level: view.level(), frameMsP50: at(0.5), frameMsP95: at(0.95), longFrames: g.longFrames,
                scan, canvas: { width: view.canvas.width, height: view.canvas.height } };
        },
        dispose() {
            g.disposed = true; g.events.abort();
            if (document.pointerLockElement === view.canvas) releasePointer();
            g.audio?.dispose?.(); g.ui?.dispose?.();
            chip.remove();
            view.dispose();
        },
    };
}
