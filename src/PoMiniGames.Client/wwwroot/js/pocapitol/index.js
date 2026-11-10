import { createAttempt, advance, fire, setPaused } from './world.js';
import { createScene } from './scene.js';
import { ensure, remove } from '../radzenTheme.js';
import { connectedPads, stick, pressed, ButtonEdges } from '../gamepadBus.js';

let game = null;

async function init(hostId, reference) {
    dispose();
    await ensure();
    const host = document.getElementById(hostId);
    if (!host) throw new Error('PoCapitol scene container was not found.');
    delete host.dataset.interfaceError;
    const view = createScene(host);
    const g = {
        host, view, reference, state: createAttempt(), started: false, disposed: false,
        yaw: 0, pitch: 0, keys: new Set(), firing: false, frame: 0, last: 0,
        notifyAt: 0, notifying: false, message: '', drag: null, edges: new ButtonEdges(),
        events: new AbortController(),
    };
    game = g;
    const signal = g.events.signal;
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const clearInput = () => { g.keys.clear(); g.firing = false; g.drag = null; };
    listen(window, 'keydown', e => {
        if (!g.started || e.target.closest?.('input, select, textarea, [role="slider"]')) return;
        if (['Escape', 'KeyP'].includes(e.code) && !e.repeat) {
            pause(g.state.status === 'active'); e.preventDefault(); return;
        }
        if (g.state.status !== 'active') return;
        if (e.target.closest?.('button, a, summary, [role="radio"]')) return;
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft'].includes(e.code)) {
            g.keys.add(e.code); e.preventDefault();
        }
    });
    listen(window, 'keyup', e => g.keys.delete(e.code));
    listen(window, 'blur', () => { clearInput(); pause(true); });
    listen(document, 'visibilitychange', () => { if (document.hidden) { clearInput(); pause(true); } });
    listen(document, 'pointerlockchange', () => {
        if (document.pointerLockElement !== view.canvas && g.started) { clearInput(); pause(true); }
    });
    listen(document, 'mousemove', e => {
        if (g.state.status !== 'active' || document.pointerLockElement !== view.canvas) return;
        g.yaw -= e.movementX * 0.0025;
        g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + e.movementY * 0.003));
    });
    listen(view.canvas, 'pointerdown', e => {
        if (!g.started || g.state.status !== 'active') return;
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
        if (!button || g.state.status !== 'active') return;
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
            const dt = Math.min(0.05, Math.max(0, (now - (g.last || now)) / 1000));
            g.last = now;
            const pad = connectedPads()[0];
            const edges = g.edges.update(pad);
            if (g.started && edges.includes(9)) pause(g.state.status === 'active');
            let x = 0, z = 0;
            if (g.started && g.state.status === 'active') {
                const left = pad ? stick(pad) : { x: 0, y: 0 };
                const right = pad ? stick(pad, 0.2, 1) : { x: 0, y: 0 };
                g.yaw -= ((g.keys.has('ArrowRight') ? 1 : 0) - (g.keys.has('ArrowLeft') ? 1 : 0) + right.x) * dt * 2;
                g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + right.y * dt));
                const strafe = (g.keys.has('KeyD') ? 1 : 0) - (g.keys.has('KeyA') ? 1 : 0) + left.x;
                const forward = (g.keys.has('KeyW') || g.keys.has('ArrowUp') ? 1 : 0) -
                    (g.keys.has('KeyS') || g.keys.has('ArrowDown') ? 1 : 0) - left.y;
                x = strafe * Math.cos(g.yaw) - forward * Math.sin(g.yaw);
                z = -strafe * Math.sin(g.yaw) - forward * Math.cos(g.yaw);
                advance(g.state, { x, z, sprint: g.keys.has('ShiftLeft') || pressed(pad, 10) }, dt);
                if (g.firing || g.keys.has('Space') || pressed(pad, 7)) {
                    const shot = fire(g.state, view.aim(g.state, g.yaw));
                    if (shot) { view.trace(g.state, shot); window.PoCue?.fire('ui', shot.hit !== null ? 'confirm' : 'tap'); }
                }
                if (g.state.status === 'completed' || g.state.status === 'failed') {
                    clearInput();
                    if (document.pointerLockElement === view.canvas) document.exitPointerLock();
                }
            }
            view.render(g.state, g.yaw, g.pitch, Math.hypot(x, z) > 0.1 && g.state.status === 'active', dt);
            host.dataset.damaged = g.state.damageFlash > 0 ? 'true' : 'false';
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

function notify(g) {
    if (g.notifying || g.disposed) return;
    g.notifying = true;
    const s = g.state;
    g.reference.invokeMethodAsync('OnUpdate', s.health, s.milestone, s.elapsed, s.status, s.hits, s.shots, g.message)
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

function start(difficulty) {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.state = createAttempt(difficulty);
    game.yaw = 0; game.pitch = 0; game.keys.clear(); game.firing = false;
    game.started = true; game.message = ''; game.notifyAt = 0;
    game.view.canvas.focus();
}

function pause(value) {
    if (!game?.started) return;
    setPaused(game.state, value);
    game.keys.clear(); game.firing = false;
    if (value && document.pointerLockElement === game.view.canvas) document.exitPointerLock();
    notify(game);
}

function dispose() {
    if (!game) return;
    const g = game;
    g.disposed = true; g.events.abort(); cancelAnimationFrame(g.frame);
    if (document.pointerLockElement === g.view.canvas) document.exitPointerLock();
    g.view.dispose(); remove(); game = null;
}

window.PoCapitol = { init, start, pause, dispose };
