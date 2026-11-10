import { createAttempt, advance, shove, setPaused, selectLeader, frontLine } from './world.js';
import { createScene } from './scene.js';
import { loadFigure } from './crowd.js';
import { createAudio } from './audio.js';
import { createGovernor, MODES } from './quality.js';
import { ensure, remove } from '../radzenTheme.js';
import { connectedPads, stick, pressed, ButtonEdges } from '../gamepadBus.js';

const GRAPHICS_KEY = 'pocapitol.graphics';
let game = null;

function storedGraphics() {
    try {
        const value = window.localStorage?.getItem(GRAPHICS_KEY);
        return MODES.includes(value) ? value : 'auto';
    } catch { return 'auto'; }
}

async function init(hostId, reference) {
    dispose();
    await ensure();
    const host = document.getElementById(hostId);
    if (!host) throw new Error('PoCapitol scene container was not found.');
    delete host.dataset.interfaceError;
    // The rigged figure: a small glb the service worker caches, built in code if it cannot load.
    const figure = await loadFigure();
    if (!host.isConnected) return;
    const view = createScene(host, { figure });
    const tier = window.PoQuality?.tier?.() ?? 'high';
    const g = {
        host, view, reference, state: createAttempt(), started: false, disposed: false,
        yaw: 0, pitch: 0, keys: new Set(), firing: false, frame: 0, last: 0,
        notifyAt: 0, notifying: false, message: '', drag: null, edges: new ButtonEdges(), restartAt: 0,
        events: new AbortController(), audio: null, mix: null, mixAt: 0,
        governor: createGovernor({ tier, mode: storedGraphics() }), tier, tierAt: 0,
    };
    game = g;
    view.applyQuality?.(g.governor.settings());
    const signal = g.events.signal;
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const clearInput = () => { g.keys.clear(); g.firing = false; g.drag = null; };
    const human = () => g.state.role !== 'none';
    listen(window, 'keydown', e => {
        if (!g.started || e.target.closest?.('input, select, textarea, [role="slider"]')) return;
        if (['Escape', 'KeyP'].includes(e.code) && !e.repeat) {
            pause(g.state.status === 'active'); e.preventDefault(); return;
        }
        if (!human()) return;
        if (g.state.status !== 'active') return;
        if (e.target.closest?.('button, a, summary, [role="radio"]')) return;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft'].includes(e.code)) {
            g.keys.add(e.code); e.preventDefault();
        }
    });
    listen(window, 'keyup', e => g.keys.delete(e.code));
    listen(window, 'blur', () => { clearInput(); if (human()) pause(true); });
    listen(document, 'visibilitychange', () => { if (document.hidden) { clearInput(); if (human()) pause(true); } });
    listen(document, 'pointerlockchange', () => {
        if (document.pointerLockElement !== view.canvas && g.started && human()) { clearInput(); pause(true); }
    });
    listen(document, 'mousemove', e => {
        if (!human() || g.state.status !== 'active' || document.pointerLockElement !== view.canvas) return;
        g.yaw -= e.movementX * 0.0025;
        g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + e.movementY * 0.003));
    });
    listen(view.canvas, 'pointerdown', e => {
        if (!g.started || !human() || g.state.status !== 'active') return;
        if (e.pointerType === 'touch') {
            g.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
            view.canvas.setPointerCapture(e.pointerId);
        } else if (document.pointerLockElement === view.canvas) {
            g.firing = e.button === 0;
        } else {
            const unavailable = error => {
                console.warn('[PoCapitol] pointer lock unavailable:', error);
                g.message = 'Mouse capture unavailable. Use arrow keys to turn, or drag on a touchscreen.';
            };
            try {
                const request = view.canvas.requestPointerLock();
                request?.catch(unavailable);
            } catch (error) { unavailable(error); }
        }
    });
    listen(view.canvas, 'pointermove', e => {
        if (!g.drag || g.drag.id !== e.pointerId || g.state.status !== 'active') return;
        g.yaw -= (e.clientX - g.drag.x) * 0.006;
        g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + (e.clientY - g.drag.y) * 0.004));
        g.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    listen(window, 'pointerup', () => { g.firing = false; g.drag = null; });
    listen(window, 'pointercancel', clearInput);
    listen(view.canvas, 'contextmenu', e => e.preventDefault());
    listen(view.canvas, 'webglcontextlost', e => {
        e.preventDefault();
        pause(true);
        g.started = false;
        reference.invokeMethodAsync('OnEngineError', 'The browser lost its 3D graphics context.')
            .catch(error => console.error('[PoCapitol] graphics error notification failed:', error));
    });
    listen(host.parentElement, 'pointerdown', e => {
        const button = e.target.closest('[data-capitol-key]');
        if (!button || !human() || g.state.status !== 'active') return;
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        g.keys.add(button.dataset.capitolKey);
    });
    const releaseButton = e => {
        const button = e.target.closest('[data-capitol-key]');
        if (button) g.keys.delete(button.dataset.capitolKey);
    };
    listen(host.parentElement, 'pointerup', releaseButton);
    listen(host.parentElement, 'pointercancel', releaseButton);
    listen(host.parentElement, 'lostpointercapture', releaseButton);
    function loop(now) {
        if (g.disposed) return;
        try {
            const elapsed = Math.max(0, (now - (g.last || now)) / 1000);
            const dt = Math.min(0.05, elapsed);
            g.last = now;
            const pad = connectedPads()[0];
            const edges = g.edges.update(pad);
            if (g.started && edges.includes(9)) pause(g.state.status === 'active');
            if (g.started && g.state.demo && g.restartAt && now >= g.restartAt) start(g.state.difficulty, true);
            // The app's tier can change mid-session (Settings, battery); the governor works under it.
            if (now >= g.tierAt) {
                g.tierAt = now + 1000;
                const current = window.PoQuality?.tier?.() ?? g.tier;
                if (current !== g.tier) { g.tier = current; view.applyQuality?.(g.governor.setTier(current)); }
            }
            let x = 0, z = 0;
            if (g.started && g.state.status === 'active') {
                const changed = g.governor.sample(elapsed);
                if (changed) view.applyQuality?.(changed);
                const left = pad && human() ? stick(pad) : { x: 0, y: 0 };
                const right = pad && human() ? stick(pad, 0.2, 1) : { x: 0, y: 0 };
                g.yaw -= ((g.keys.has('ArrowRight') ? 1 : 0) - (g.keys.has('ArrowLeft') ? 1 : 0) + right.x) * dt * 2;
                g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + right.y * dt));
                const strafe = (g.keys.has('KeyD') ? 1 : 0) - (g.keys.has('KeyA') ? 1 : 0) + left.x;
                const forward = (g.keys.has('KeyW') || g.keys.has('ArrowUp') ? 1 : 0) -
                    (g.keys.has('KeyS') || g.keys.has('ArrowDown') ? 1 : 0) - left.y;
                x = strafe * Math.cos(g.yaw) - forward * Math.sin(g.yaw);
                z = -strafe * Math.sin(g.yaw) - forward * Math.cos(g.yaw);
                advance(g.state, { x, z, sprint: g.keys.has('ShiftLeft') || pressed(pad, 10) }, dt);
                // Read this step's events before a shove appends its own.
                for (const event of g.state.events) g.audio?.event(event);
                if (human() && (g.firing || g.keys.has('Space') || pressed(pad, 7))) {
                    const pushed = shove(g.state, view.aim(g.state, g.yaw));
                    if (pushed) g.audio?.event({ type: 'shove', x: g.state.player.x, z: g.state.player.z, human: true });
                }
                if (g.state.status === 'completed' || g.state.status === 'failed') {
                    clearInput();
                    if (g.state.demo) g.restartAt = now + 6000;
                    if (document.pointerLockElement === view.canvas) document.exitPointerLock();
                }
            }
            const moving = Math.hypot(x, z) > 0.1 && g.state.status === 'active';
            view.render(g.state, g.yaw, g.pitch, moving, dt);
            const s = g.state;
            host.dataset.damaged = s.damageFlash > 0 ? 'true' : 'false';
            host.dataset.hazard = s.gassed ? 'gas' : s.sprayed > 0 ? 'spray' : '';
            host.dataset.flash = s.flashed > 0 && window.PoQuality?.reduceFlashing?.() !== true ? 'true' : 'false';
            if (g.audio) {
                if (now >= g.mixAt) { g.mixAt = now + 200; g.mix = soundMix(s); }
                g.audio.update({ ...g.mix, walking: moving, gassed: s.gassed, active: g.started && s.status === 'active' }, dt);
            }
            if (g.started && now >= g.notifyAt) { g.notifyAt = now + 200; notify(g); }
            g.frame = requestAnimationFrame(loop);
        } catch (error) {
            console.error('[PoCapitol] frame failed:', error);
            g.started = false;
            reference.invokeMethodAsync('OnEngineError', error.message).catch(err => console.error('[PoCapitol] error notification failed:', err));
        }
    }
    g.frame = requestAnimationFrame(loop);
}

/** What the listener is standing in the middle of, for the sound layers. Cheap enough at 5 Hz. */
function soundMix(s) {
    const ear = s.role === 'none' ? selectLeader(s) ?? s.player : s.player;
    let crowd = 0, morale = 0;
    for (const c of s.companions) {
        if (c.health <= 0 || Math.hypot(c.x - ear.x, c.z - ear.z) > 22) continue;
        crowd++; morale += c.morale;
    }
    let police = 0;
    for (const e of s.enemies) {
        if (e.health > 0) police = Math.max(police, 1 / (1 + Math.hypot(e.x - ear.x, e.z - ear.z) / 6));
    }
    const front = frontLine(s);
    const pressure = front && Math.abs(front.z - ear.z) < 28 ? Math.min(1, front.pressure / 24) : 0;
    return { x: ear.x, z: ear.z, crowd: Math.min(1, crowd / 35), morale: crowd ? morale / crowd : 0, police, pressure };
}

function notify(g) {
    if (g.notifying || g.disposed) return;
    g.notifying = true;
    const s = g.state;
    const leader = s.role === 'none' ? selectLeader(s) : null;
    const front = frontLine(s);
    g.reference.invokeMethodAsync('OnUpdate', s.health, s.milestone, s.elapsed, s.status, s.pushes, s.staggers, g.message,
        s.companions.filter(c => c.health > 0).length + (s.role === 'raider' && s.health > 0 ? 1 : 0),
        s.enemies.filter(e => e.health > 0).length, leader ? leader.id + 1 : 0, s.demo,
        s.outcome, s.enemies.length, front ? front.id : -1, front ? Math.round(front.integrity) : 0, g.governor.label(),
        s.civilians.filter(p => !p.evacuated).length)
        .catch(error => {
            if (!g.disposed) {
                console.error('[PoCapitol] player interface update failed:', error);
                setPaused(g.state, true);
                const message = 'Game paused because the player interface could not update. Reload or return to all games.';
                g.host.setAttribute('aria-label', message);
                g.host.dataset.interfaceError = message;
            }
        }).finally(() => { g.notifying = false; });
}

function start(difficulty, demo = false, role = 'raider') {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.state = createAttempt(difficulty, demo, role);
    game.yaw = role === 'police' && !demo ? Math.PI : 0;
    game.pitch = 0; game.keys.clear(); game.firing = false;
    game.started = true; game.message = ''; game.notifyAt = 0; game.restartAt = 0;
    // Created on the first start, which follows a click: browsers keep audio shut until then.
    game.audio ??= createAudio();
    if (!demo) game.view.canvas.focus();
}

function pause(value) {
    if (!game?.started) return;
    setPaused(game.state, value);
    game.keys.clear(); game.firing = false;
    if (value && document.pointerLockElement === game.view.canvas) document.exitPointerLock();
    notify(game);
}

/** 'auto' follows frame time; 'low' and 'high' pin the picture. Remembered across visits. */
function setGraphics(mode) {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.view.applyQuality?.(game.governor.setMode(mode));
    try { window.localStorage?.setItem(GRAPHICS_KEY, mode); } catch { /* private mode: this visit only */ }
    return game.governor.label();
}

function dispose() {
    if (!game) return;
    const g = game;
    g.disposed = true; g.events.abort(); cancelAnimationFrame(g.frame);
    if (document.pointerLockElement === g.view.canvas) document.exitPointerLock();
    g.audio?.dispose();
    g.view.dispose(); remove(); game = null;
}

window.PoCapitol = { init, start, pause, dispose, setGraphics, getGraphics: storedGraphics };
