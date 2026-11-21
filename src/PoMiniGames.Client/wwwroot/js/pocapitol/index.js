import { createAttempt, advance, shove, fire, throwPlayerGrenade, setPaused, selectLeader, frontLine, milestones, clockLabel, CURFEW_ELAPSED, areas, obstacles, columns, command, orderWait, lineDefs, ORDERS } from './world.js';
import { createAnalysis } from './analysis.js';
import { createScene } from './scene.js';
import { loadFigure } from './crowd.js';
import { createAudio } from './audio.js';
import { createLoudhailer } from './loudhailer.js';
import { createScore } from './score.js';
import { createUiFx } from './ui.js';
import { createGovernor, preferredMode, detectTier } from './quality.js';
import { fetchWeather } from './weather.js';
import { createRadar } from './radar.js';
import { createInspector } from './inspector.js';
import { createRecorder, toCsv, toText, toSvg, HEAT } from './report.js';
import { createDirector } from './director.js';
import { loadPrefs, savePrefs, matches, rebind } from './prefs.js';
import { createDebriefRouter } from './debrief.js';
import { loadCampusData } from './campusData.js';
import { loadSigns } from './signs.js';
import { startDissolve } from './dissolve.js';
import { createLeader } from './leader.js';
import { ensure, remove } from '../platform/radzenTheme.js';
import { connectedPads, stick, pressed, ButtonEdges } from '../platform/gamepadBus.js';

const GRAPHICS_KEY = 'pominigames:pocapitol-graphics';
const WEATHER_KEY = 'pominigames:pocapitol-weather';
let game = null;

/** Hosts without performance (and the Node harness) still need a clock. */
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

function storedGraphics() {
    try {
        return preferredMode(window.localStorage?.getItem(GRAPHICS_KEY));
    } catch { return 'auto'; }
}

function storedWeather() {
    try {
        const value = window.localStorage?.getItem(WEATHER_KEY);
        return value || 'historical';
    } catch { return 'historical'; }
}

async function init(hostId, reference) {
    dispose();
    const bootAt = nowMs();
    await ensure();
    const host = document.getElementById(hostId);
    if (!host) throw new Error('PoCapitol scene container was not found.');
    delete host.dataset.interfaceError;
    // The rigged figure: a small glb the service worker caches, built in code if it cannot load.
    // The footprint layer is decoration and resolves to null if it is missing, so it can only
    // delay the scene by its own timeout.
    const [figure, osm, signs] = await Promise.all([loadFigure(), loadCampusData(), loadSigns()]);
    if (!host.isConnected) return;
    const view = await createScene(host, { figure, osm, signs });
    // The app's own quality tier is a device guess made elsewhere. When it says nothing, fall back
    // to what this browser actually reports rather than assuming the best GPU.
    const caps = view.renderer?.capabilities;
    const tier = window.PoQuality?.tier?.() ?? detectTier({
        webgl2: caps?.isWebGL2 ?? true,
        maxTexture: caps?.maxTextureSize ?? 4096,
        memory: navigator.deviceMemory ?? 4,
        cores: navigator.hardwareConcurrency ?? 4,
    });
    const prefs = loadPrefs();
    applyViewPrefs(view, prefs);
    const g = {
        host, view, reference, state: createAttempt(), started: false, disposed: false,
        yaw: 0, pitch: 0, keys: new Set(), firing: false,
        notifyAt: 0, notifying: false, message: '', drag: null, edges: new ButtonEdges(), restartAt: 0,
        events: new AbortController(), audio: null, ui: null, mix: null, mixAt: 0,
        governor: createGovernor({ tier, mode: storedGraphics() }), tier, tierAt: 0,
        weather: null, radar: null, inspector: null,
        prefs, recorder: createRecorder({ labels: milestones.map(m => m.label) }), director: createDirector(),
        frames: [], longFrames: 0, captionAt: 0, initMs: Math.round(nowMs() - bootAt),
        osmBuildings: osm?.buildings?.length ?? 0, osmAttribution: osm?.attribution ?? '',
        lastMilestone: 0, telemetry: [], debrief: createDebriefRouter(),
        // Fruin density and contagion (analysis.js), rebuilt four times a second while play runs.
        analysis: createAnalysis(), analysisAt: 0, analysisElapsed: 0, snow: 0, streetMap: null, streetAsk: null,
    };
    game = g;
    view.applyQuality?.(g.governor.settings());
    track('init', { ms: g.initMs, tier,
        footprints: g.osmBuildings, signs: signs.length });

    // Weather API integration & dynamic updates
    fetchWeather(storedWeather()).then(w => {
        applyWeather(g, w);
        g.weatherRefreshAt = nowMs() + 300000;
        reference?.invokeMethodAsync('OnWeatherUpdate', w.condition).catch(() => {});
    }).catch(() => {});

    // Tactical Unit Inspector
    g.inspector = createInspector({
        onTelemetryChange: tele => {
            reference.invokeMethodAsync('OnTelemetryUpdate', tele)
                .catch(err => console.debug('[PoCapitol] telemetry update omitted:', err));
        },
    });

    // Radar HUD
    initRadar('pocapitol-radar');

    // Menu sound, motion and the glass shader. Decoration only: if it cannot start, the game still can.
    try { g.ui = createUiFx(host.parentElement); } catch (error) { console.warn('[PoCapitol] interface effects unavailable:', error); }
    g.leader = createLeader(host.parentElement);
    const signal = g.events.signal;
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const clearInput = () => { g.keys.clear(); g.firing = false; g.drag = null; };
    // Someone with a body on the field. The incident commander has none: they give orders.
    const human = () => g.state.role !== 'none' && g.state.role !== 'commander';
    const commanding = () => g.state.role === 'commander' && g.state.status === 'active';
    // An order from the keyboard or the page: the radio's reply goes to the captions.
    g.order = (name, line) => {
        // Orders arrive between frames, so what they set off is heard and seen now: the next
        // step clears the event list before the frame loop would read it.
        const mark = g.state.events.length;
        const result = command(g.state, name, line ?? g.state.command?.selected ?? 0);
        for (let i = mark; i < g.state.events.length; i++) { g.audio?.event(g.state.events[i]); g.view.onEvent?.(g.state.events[i]); }
        if (result.message) { g.caption(result.message, 'event'); g.lastReply = result.message; }
        notify(g);
        return result;
    };    const held = action => { for (const code of g.keys) if (matches(g.prefs, action, code)) return true; return false; };
    // Strafe only follows the binding itself: the arrows are reserved for turning the view.
    const bound = action => { for (const code of g.keys) if (g.prefs.keys[action] === code) return true; return false; };
    g.caption = (text, kind = 'radio') => {
        if (!g.prefs.captions || !text) return;
        const now = nowMs();
        if (kind === 'radio' && now - g.captionAt < 400) return;
        g.captionAt = now;
        reference?.invokeMethodAsync('OnCaption', String(text)).catch(() => { /* no page listening */ });
    };
    listen(window, 'keydown', e => {
        if (!g.started || e.target.closest?.('input, select, textarea, [role="slider"]')) return;
        // Esc leaves for the main menu (owner, 2026-11-21); P (or its rebinding) pauses. A menu that
        // is open (options sheet, pause panel, end card) handles its own Esc, so it is left alone.
        if (e.code === 'Escape' && !e.repeat) {
            if (g.state.status === 'active' && !document.querySelector('dialog[open]')) { e.preventDefault(); toMainMenu(); }
            return;
        }
        if (matches(g.prefs, 'pause', e.code) && !e.repeat) {
            pause(g.state.status === 'active'); e.preventDefault(); return;
        }
        // V cycles the analysis overlay: off, Fruin density, contagion. Any role, demo included.
        if (e.code === 'KeyV' && !e.repeat && !e.target.closest?.('button, a, summary, [role="radio"]')) {
            cycleOverlay(); e.preventDefault(); return;
        }
        if (commanding() && !e.target.closest?.('button, a, summary, [role="radio"]')) {
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { g.keys.add(e.code); e.preventDefault(); return; }
            if (e.repeat) return;
            const digit = /^Digit([1-5])$/.exec(e.code);
            if (digit) { g.order('select', Number(digit[1]) - 1); e.preventDefault(); return; }
            const orders = { KeyB: 'brace', KeyR: 'reinforce', KeyT: 'relieve', KeyG: 'gas', KeyF: 'fallback' };
            if (orders[e.code]) { g.order(orders[e.code]); e.preventDefault(); }
            return;
        }
        if (!human()) return;
        if (g.state.status !== 'active') return;
        if (e.target.closest?.('button, a, summary, [role="radio"]')) return;
        // ←/→ turn the camera (read from g.keys in the frame loop), so they are tracked here too.
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' ||
            ['forward', 'back', 'left', 'right', 'push', 'sprint'].some(action => matches(g.prefs, action, e.code))) {
            g.keys.add(e.code); e.preventDefault();
        }
    });
    listen(window, 'keyup', e => g.keys.delete(e.code));
    // One grenade per press, from any input: G / H, the pad's X / Y, or the touch buttons.
    const lob = kind => {
        if (!human() || g.state.status !== 'active') return false;
        const thrown = throwPlayerGrenade(g.state, view.aim(g.state, g.yaw), kind);
        if (thrown) {
            g.audio?.event(g.state.events.at(-1));
            navigator.vibrate?.(kind === 'smoke' ? 12 : 25);
        }
        return Boolean(thrown);
    };
    listen(window, 'keydown', e => {
        if (e.repeat || e.target.closest?.('button, a, summary, input, select, textarea, [role="radio"]')) return;
        if (e.code !== 'KeyG' && e.code !== 'KeyH') return;
        if (lob(e.code === 'KeyH' ? 'smoke' : 'concussion')) e.preventDefault();
    });
    listen(window, 'blur', () => { clearInput(); if (human() || commanding()) pause(true); });
    listen(document, 'visibilitychange', () => { if (document.hidden) { clearInput(); if (human() || commanding()) pause(true); } });
    // While the pointer is locked the browser keeps Esc for itself: it only releases the lock, and
    // the page never sees the key. So a release the game did not ask for, with the tab still
    // focused and visible (not an alt-tab, which blurs and pauses above), is read as that Esc.
    listen(document, 'pointerlockchange', () => {
        if (document.pointerLockElement === view.canvas || !g.started || !human()) return;
        clearInput();
        if (nowMs() - (g.selfUnlock ?? -1e9) < 600 || g.state.status !== 'active') return;
        setTimeout(() => {
            if (g.state.status !== 'active') return;
            if (document.hasFocus() && !document.hidden) toMainMenu(); else pause(true);
        }, 120);
    });
    listen(document, 'mousemove', e => {
        if (!human() || g.state.status !== 'active' || document.pointerLockElement !== view.canvas) return;
        g.yaw -= e.movementX * 0.0025 * g.prefs.sensitivity;
        g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + e.movementY * 0.003 * g.prefs.sensitivity));
    });
    listen(view.canvas, 'pointerdown', e => {
        if (!g.started || g.state.status !== 'active') return;
        
        // Inspect unit on click if not pointer locked
        if (document.pointerLockElement !== view.canvas && e.pointerType !== 'touch') {
            const picked = view.pickUnit(e.clientX, e.clientY, g.state);
            if (picked) {
                g.inspector?.select(picked, g.state);
                return;
            }
        }

        if (!human()) return;
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
        g.yaw -= (e.clientX - g.drag.x) * 0.006 * g.prefs.sensitivity;
        g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + (e.clientY - g.drag.y) * 0.004 * g.prefs.sensitivity));
        g.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    listen(window, 'pointerup', () => { g.firing = false; g.drag = null; });
    listen(window, 'pointercancel', clearInput);
    // A backgrounded tab is throttled; those long frames must not be read as a slow scene and
    // walk the quality ladder down while nobody is watching. The stage pauses with the tab.
    const stage = view.stage;
    stage.on('pause', () => g.governor.suspend(true));
    stage.on('resume', () => g.governor.suspend(false));
    listen(view.canvas, 'contextmenu', e => e.preventDefault());
    listen(view.canvas, 'webglcontextlost', e => {
        e.preventDefault();
        pause(true);
        g.started = false;
        track('context-lost', { tier: g.governor.label() });
        reference.invokeMethodAsync('OnEngineError', 'The browser lost its 3D graphics context.')
            .catch(error => console.error('[PoCapitol] graphics error notification failed:', error));
    });
    // Touch buttons name an action, not a key: the code injected is whatever that action is bound
    // to now, so a rebind moves the d-pad and PUSH with it. The code pressed is remembered per
    // button so a release always lifts the same key, even if the map changed mid-hold.
    const touchHeld = new WeakMap();
    listen(host.parentElement, 'pointerdown', e => {
        const thrower = e.target.closest('[data-capitol-throw]');
        if (thrower) { e.preventDefault(); lob(thrower.dataset.capitolThrow); return; }
        const button = e.target.closest('[data-capitol-action]');
        if (!button || !human() || g.state.status !== 'active') return;
        const code = g.prefs.keys[button.dataset.capitolAction];
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
    // The stage's frame: `elapsed` is the real seconds since the last frame (unclamped, the
    // governor reads hitches from it), `now` the stage clock in ms.
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
            // X lobs a concussion grenade, Y a smoke grenade.
            if (edges.includes(2)) lob('concussion');
            if (edges.includes(3)) lob('smoke');
            if (g.started && g.state.demo && g.restartAt && now >= g.restartAt) start(g.state.difficulty, true);
            // The app's tier can change mid-session (Settings, battery); the governor works under it.
            if (now >= g.tierAt) {
                g.tierAt = now + 1000;
                const current = window.PoQuality?.tier?.() ?? g.tier;
                if (current !== g.tier) { g.tier = current; view.applyQuality?.(g.governor.setTier(current)); }
            }
            // The opening establishing shot holds the world still, so the five seconds it lasts
            // are not five minutes off the clock and the crowd has not moved before play begins.
            const intro = g.view.introActive?.() === true;
            let x = 0, z = 0;
            if (g.started && g.state.status === 'active' && !intro) {
                const changed = g.governor.sample(elapsed);
                if (changed) view.applyQuality?.(changed);
                const left = pad && human() ? stick(pad) : { x: 0, y: 0 };
                const right = pad && human() ? stick(pad, 0.2, 1) : { x: 0, y: 0 };
                g.yaw -= ((g.keys.has('ArrowRight') ? 1 : 0) - (g.keys.has('ArrowLeft') ? 1 : 0) + right.x) * dt * 2;
                g.pitch = Math.max(-0.45, Math.min(0.65, g.pitch + right.y * dt));
                // The command crane only swings so far round its line (scene.js).
                if (g.state.role === 'commander') g.yaw = Math.max(-0.7, Math.min(0.7, g.yaw));
                const strafe = (bound('right') ? 1 : 0) - (bound('left') ? 1 : 0) + left.x;
                const forward = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0) - left.y;
                x = strafe * Math.cos(g.yaw) - forward * Math.sin(g.yaw);
                z = -strafe * Math.sin(g.yaw) - forward * Math.cos(g.yaw);
                advance(g.state, { x, z, sprint: held('sprint') || pressed(pad, 10) }, dt);
                // Read this step's events before a shove appends its own.
                for (const event of g.state.events) {
                    g.audio?.event(event);
                    view.onEvent?.(event);
                    g.hailer?.event(event, g.state);
                    if (event.type === 'openfire') g.openfire = true;
                    // A blast near the player is felt in the hands as well as heard.
                    if (human() && (event.type === 'flash' || event.type === 'grenade')) {
                        const near = 1 / (1 + Math.hypot(event.x - g.state.player.x, event.z - g.state.player.z) / 8);
                        if (near > 0.15) g.ui?.rumble?.(near, event.type === 'grenade' ? 320 : 200);
                    }
                    // A shield shatters with the same type; only a line break carries `line`.
                    if (event.type === 'break' && event.line !== undefined) g.caption('A police line has given way.');
                    if (event.type === 'openfire') g.caption('The police opened fire. The crowd breaks and runs.');
                }
                if (g.state.milestone !== g.lastMilestone) {
                    g.lastMilestone = g.state.milestone;
                    g.caption(milestones[g.state.milestone - 1]?.label ?? 'Objective reached', 'event');
                }
                g.recorder.step(g.state);
                if (now >= g.analysisAt) {
                    g.analysisAt = now + 250;
                    g.analysis.update(g.state, Math.max(0, g.state.elapsed - g.analysisElapsed));
                    g.analysisElapsed = g.state.elapsed;
                }
                g.director.observe(g.state, now);
                if (human() && (g.firing || held('push') || pressed(pad, 7))) {
                    const aim = view.aim(g.state, g.yaw);
                    // Everything the action adds is heard: a burst is a gunshot and its impact,
                    // not just whichever of the two happened to be appended last.
                    const mark = g.state.events.length;
                    if (g.state.weapon === 'mg') fire(g.state, aim); else shove(g.state, aim);
                    for (let i = mark; i < g.state.events.length; i++) { g.audio?.event(g.state.events[i]); view.onEvent?.(g.state.events[i]); }
                }
                if (g.state.status === 'completed' || g.state.status === 'failed') {
                    clearInput();
                    if (!g.ended) {
                        g.ended = true;
                        g.ui?.wipe?.('pass');
                        g.lastReport = buildReport(g.state);
                        track('end', { mode: g.state.demo ? 'demo' : 'solo', outcome: g.state.outcome, seconds: Math.round(g.state.elapsed) });
                    }
                    if (g.state.demo) g.restartAt = now + 6000;
                    if (document.pointerLockElement === view.canvas) releasePointer(g);
                }
            }
            const moving = Math.hypot(x, z) > 0.1 && g.state.status === 'active';

            // Real-time Tactical Radar & Unit Inspector updates
            initRadar('pocapitol-radar');
            if (g.radar) g.radar.render(g.state, g.inspector?.getSelected(), dt);
            g.inspector?.update(g.state);
            // The inspector card follows whoever it describes (leader.js), after the render below.
            const tethered = g.inspector?.getSelected() ?? null;

            // The auto-director only cuts while the demo is running; a paused or finished attempt
            // holds the last subject so the closing shot does not jump.
            const directed = g.state.demo && g.prefs.director && g.state.status === 'active'
                ? g.director.pick(g.state) : null;
            if (directed) g.state.subject = directed.id;
            view.render(g.state, g.yaw, g.pitch, moving, dt, {
                inspectedUnit: g.inspector?.getSelected(),
                latchedUnit: g.inspector?.isLatched() ? g.inspector.getSelected() : null,
                weather: g.weather,
                director: directed,
                analysis: g.analysis,
            });
            try { g.leader?.update(view.camera, tethered); } catch { /* the card keeps its corner */ }
            // The attempt just ended: take this frame apart into particles (dissolve.js). It has to
            // copy the canvas in the same task as the render, so it is here and not on the status change.
            if (g.ended && g.dissolve === null) {
                try { g.dissolve = startDissolve({ source: view.canvas, host, heat: { data: g.lastReport?.heat ?? [], cols: HEAT.cols, rows: HEAT.rows }, demo: g.state.demo }) ?? false; }
                catch (error) { g.dissolve = false; console.warn('[PoCapitol] dissolve failed:', error); }
            }

            const s = g.state;
            host.dataset.damaged = s.damageFlash > 0 ? 'true' : 'false';
            host.dataset.hazard = s.gassed ? 'gas' : s.sprayed > 0 ? 'spray' : '';
            host.dataset.flash = s.flashed > 0 && window.PoQuality?.reduceFlashing?.() !== true ? 'true' : 'false';
            if (g.audio) {
                if (now >= g.mixAt) { g.mixAt = now + 200; g.mix = soundMix(s); }
                // Heading changes every frame; the 5 Hz crowd read does not carry it.
                const ear = listenerOf(s);
                const yaw = s.role === 'none' ? ear.heading ?? 0 : g.yaw;
                // Whoever the camera is on is who the mix favours.
                const focus = s.role === 'none' ? (directed ?? ear) : s.role === 'commander' ? ear : s.player;
                g.audio.update({ ...g.mix, focus, x: ear.x, z: ear.z, yaw, walking: moving, gassed: s.gassed, wind: g.weather?.windSpeed, snow: g.snow, active: g.started && s.status === 'active', health: s.health, ...hudCues(g, s, ear) }, dt);
                const active = g.started && s.status === 'active';
                g.hailer?.update({ x: ear.x, z: ear.z, yaw, horn: g.mix?.horn, pressure: g.mix?.pressure, elapsed: s.elapsed, active, curfew: CURFEW_ELAPSED - 8 });
                g.score?.update({ ...g.mix, elapsed: s.elapsed, milestone: s.milestone, active, openfire: Boolean(g.openfire) }, dt);
            }
            if (g.weather?.mode === 'live' && now >= (g.weatherRefreshAt || 0)) {
                g.weatherRefreshAt = now + 300000;
                fetchWeather('live').then(w => {
                    if (g.disposed) return;
                    applyWeather(g, w);
                    reference?.invokeMethodAsync('OnWeatherUpdate', w.condition).catch(() => {});
                }).catch(() => {});
            }
            if (g.started && now >= g.notifyAt) { g.notifyAt = now + 200; notify(g); }
        } catch (error) {
            stage.stop();
            console.error('[PoCapitol] frame failed:', error);
            track('frame-error', { message: String(error?.message ?? error) });
            g.started = false;
            reference.invokeMethodAsync('OnEngineError', error.message).catch(err => console.error('[PoCapitol] error notification failed:', err));
        }
    }
    stage.on('frame', loop);
    stage.start();
}

function initRadar(canvasId = 'pocapitol-radar') {
    if (!game) return;
    const canvas = document.getElementById(canvasId);
    if (canvas && (!game.radar || game.radar.canvas !== canvas)) {
        game.radar?.destroy?.();
        game.radar = createRadar(canvas, {
            onSelectUnit: unit => game.inspector?.select(unit, game.state),
        });
        game.radar.setPalette?.(game.prefs.radar);
    }
}

/**
 * What the listener is standing in the middle of, for the sound layers. Cheap enough at 5 Hz.
 * `shear` is how fast a packed crowd is moving against itself (friction), `walkers` the nearest
 * people on the move (each gets its own footfalls), `horn` where the nearest officer stands.
 */
/**
 * Where the listener stands: the human, the leader in the demo, or for the commander just behind
 * the selected line, where a command post would put its radio.
 */
/**
 * What the sonified HUD (hudWorklet.js) sounds: the integrity of the police line nearest the
 * listener that is still holding (0..100, null when none is), and the heaviest Fruin density in
 * the few cells around them (people/m2; LOS F starts at 5.38).
 */
function hudCues(g, s, ear) {
    let lineIntegrity = null, best = 30;
    s.lines.forEach((line, i) => {
        const away = Math.abs(ear.z - lineDefs[i].z);
        if (line.state === 'holding' && away < best) { best = away; lineIntegrity = line.integrity; }
    });
    let crowdDensity = 0;
    for (const [dx, dz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) crowdDensity = Math.max(crowdDensity, g.analysis.at(ear.x + dx, ear.z + dz));
    return { lineIntegrity, crowdDensity };
}

function listenerOf(s) {
    if (s.role === 'none') return selectLeader(s) ?? s.player;
    if (s.role === 'commander') {
        const def = lineDefs[s.command?.selected ?? 0] ?? lineDefs[0];
        return { x: (def.x0 + def.x1) / 2, z: def.z - 3, heading: 0 };
    }
    return s.player;
}

/** Snow lying, 0..1, from the weather: none above freezing, a full cover in a hard frost. */
function snowFor(weather) {
    const t = weather?.tempC;
    if (!Number.isFinite(t) || t > 0.5) return 0;
    return Math.max(0, Math.min(1, 0.45 + (0.5 - t) * 0.2));
}

function applyWeather(g, w) {
    g.weather = w;
    g.snow = snowFor(w);
    g.view.setSnow?.(g.snow);
}

function soundMix(s) {
    const ear = listenerOf(s);
    let crowd = 0, morale = 0, shear = 0, packed = 0;
    const near = [];
    // Where the crowd stands round the listener, in eight compass sectors (north is toward the
    // building, clockwise): the share of people in each and how far off they are on average.
    // The voices in crowdWorklet.js are thrown from these, so the crowd is heard where it is.
    const weights = new Float32Array(8), depth = new Float32Array(8);
    let ringed = 0;
    for (const c of s.companions) {
        const distance = Math.hypot(c.x - ear.x, c.z - ear.z);
        if (c.health > 0 && distance > 1.5 && distance < 70) {
            const bearing = (Math.atan2(c.x - ear.x, -(c.z - ear.z)) + Math.PI * 2) % (Math.PI * 2);
            const sector = Math.min(7, Math.floor(bearing / (Math.PI / 4)));
            // Someone near counts for more than someone far: it is their voice that carries.
            const share = 1 / (1 + distance / 10);
            weights[sector] += share; depth[sector] += distance * share; ringed += share;
        }
        if (c.health <= 0 || distance > 22) continue;
        crowd++; morale += c.morale;
        const speed = Math.hypot(c.vx ?? 0, c.vz ?? 0);
        if (c.crowding >= 3) { shear += speed * Math.min(1, c.crowding / 6); packed++; }
        if (speed > 0.6 && distance < 30) near.push({ x: c.x, z: c.z, mass: c.mass, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    let police = 0, horn = null, hornDistance = Infinity;
    for (const e of s.enemies) {
        if (e.health <= 0) continue;
        const distance = Math.hypot(e.x - ear.x, e.z - ear.z);
        police = Math.max(police, 1 / (1 + distance / 6));
        if (distance < hornDistance) { hornDistance = distance; horn = { x: e.x, z: e.z }; }
    }
    for (let i = 0; i < 8; i++) {
        depth[i] = weights[i] > 0 ? depth[i] / weights[i] : 30;
        weights[i] = ringed > 0 ? weights[i] / ringed : 1 / 8;
    }
    const front = frontLine(s);
    const pressure = front && Math.abs(front.z - ear.z) < 28 ? Math.min(1, front.pressure / 24) : 0;
    // A door the crowd is held at gets pounded on: the Crypt and Rotunda doors while their lines
    // hold and are being leaned on, and the chamber doors once the crowd is in the last corridor.
    let door = null;
    if (front && /doors$/i.test(front.name ?? '') && pressure > 0.25) door = { x: 0, z: front.z - 0.6 };
    else if (ear.z < -44 && crowd > 3) door = { x: 0, z: -52.7 };
    return {
        x: ear.x, z: ear.z, crowd: Math.min(1, crowd / 35), morale: crowd ? morale / crowd : 0, police, pressure,
        shear: packed ? Math.min(1, shear / packed / 2.5 * Math.min(1, packed / 8)) : 0,
        walkers: near.slice(0, 6), horn, door, elapsed: s.elapsed, ring: { weights, depth },
    };
}

function notify(g) {
    if (g.notifying || g.disposed) return;
    g.notifying = true;
    const s = g.state;
    const leader = s.role === 'none'
        ? (s.subject >= 0 ? s.companions.find(c => c.id === s.subject) ?? selectLeader(s) : selectLeader(s))
        : null;
    const front = frontLine(s);
    g.reference.invokeMethodAsync('OnUpdate', Math.round(s.health), s.milestone, s.elapsed, s.status,
        s.companions.length + (s.role === 'raider' ? 1 : 0), g.message,
        s.companions.filter(c => c.health > 0).length + (s.role === 'raider' && s.health > 0 ? 1 : 0),
        s.enemies.filter(e => e.health > 0).length, leader ? leader.id + 1 : 0, s.demo,
        s.outcome, s.enemies.length, front ? front.id : -1, front ? Math.round(front.integrity) : 0, g.governor.label(),
        s.civilians.filter(p => !p.evacuated).length, s.playerGrenades ?? 0, s.playerSmoke ?? 0)
        .catch(error => {
            if (!g.disposed) {
                console.error('[PoCapitol] player interface update failed:', error);
                setPaused(g.state, true);
                const message = 'Game paused because the player interface could not update. Reload or return to all games.';
                g.host.setAttribute('aria-label', message);
                g.host.dataset.interfaceError = message;
            }
        }).finally(() => { g.notifying = false; });
    // The commander's board is its own call, so a slow board never stalls the HUD or pauses play.
    if (s.command) g.reference.invokeMethodAsync('OnCommand', commandView(s, g.lastReply)).catch(() => { /* page gone */ });
}

function start(difficulty, demo = false, role = 'raider') {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.state = createAttempt(difficulty, demo, role);
    game.yaw = role === 'police' && !demo ? Math.PI : 0;
    game.pitch = 0; game.keys.clear(); game.firing = false;
    game.started = true; game.message = ''; game.notifyAt = 0; game.restartAt = 0;
    game.inspector?.clear();
    hideAftermath();
    game.recorder.reset(); game.director.reset();
    game.analysis.reset(); game.analysisAt = 0; game.analysisElapsed = 0; game.lastReply = '';
    hideStreetMap();
    game.lastMilestone = 0; game.ended = false; game.dissolve?.dispose?.(); game.dissolve = null; game.state.subject = -1;
    track('start', { mode: demo ? 'demo' : 'solo', role, difficulty, tier: game.governor.label() });
    // The opening establishing shot: five seconds over the Capitol before the player is behind
    // the crowd. Skipped when reduced motion is asked for.
    game.view.startIntro?.();
    // The cut into the scene: a front of light lifts a veil off it (ui.js).
    game.ui?.wipe?.('reveal');
    game.view.setMenu?.(false);
    // Created on the first start, which follows a click: browsers keep audio shut until then.
    if (!game.audio) {
        const current = game;
        game.audio = createAudio({ onCaption: text => current.caption?.(text, 'radio') });
        game.audio.setFootage?.(game.prefs.footage === 'on');
        game.audio.setHudSound?.(game.prefs.hudSound !== 'off');
        game.hailer = createLoudhailer({ onCaption: text => current.caption?.(text, 'event') });
        game.score = createScore();
    }
    game.openfire = false;
    game.hailer.reset(); game.score.reset();
    game.hailer.setEnabled?.(game.prefs.hailer === 'on');
    game.score.setEnabled(game.prefs.score === 'on');
    if (!demo) game.view.canvas.focus();
}

function pause(value) {
    if (!game?.started) return;
    const was = game.state.status === 'paused';
    setPaused(game.state, value);
    game.keys.clear(); game.firing = false;
    // A pause pulls the scene out of focus behind its panel, and a front of light marks the cut.
    const now = game.state.status === 'paused';
    game.view.setMenu?.(now);
    if (now !== was) game.ui?.wipe?.('pass');
    if (value && document.pointerLockElement === game.view.canvas) releasePointer(game);
    notify(game);
}

/** 'auto' follows frame time; 'low' and 'high' pin the picture. Remembered across visits. */
function setGraphics(mode) {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.view.applyQuality?.(game.governor.setMode(mode));
    try { window.localStorage?.setItem(GRAPHICS_KEY, mode); } catch { /* private mode: this visit only */ }
    return game.governor.label();
}

async function setWeather(mode) {
    if (!game) return 'historical';
    const w = await fetchWeather(mode);
    applyWeather(game, w);
    game.weatherRefreshAt = nowMs() + 300000;
    try { window.localStorage?.setItem(WEATHER_KEY, mode); } catch {}
    return w.condition;
}

function toggleUnitLatch() {
    if (!game || !game.inspector) return false;
    return game.inspector.toggleLatch(game.state);
}

function clearUnitInspect() {
    game?.inspector?.clear();
}

/**
 * One event for the app's telemetry sink. `window.appInsights` is only present when the host
 * wires it up, so this is fire-and-forget: the ring buffer on `game.telemetry` is what the
 * diagnostics copy actually reads.
 */
function track(name, properties = {}) {
    const entry = { name, at: new Date().toISOString(), ...properties };
    if (game) {
        game.telemetry.push(entry);
        if (game.telemetry.length > 60) game.telemetry.shift();
    }
    try { window.appInsights?.trackEvent?.({ name: `pocapitol.${name}`, properties }); } catch { /* not wired */ }
    return entry;
}

const round = value => Math.round(value * 10) / 10;
const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

function getDiagnostics() {
    const renderer = game?.view?.renderer;
    return {
        // The app's own build stamp (Layout/BuildVersion), so this never drifts from what shipped.
        build: document.querySelector?.('.app-build-version')?.textContent?.trim() || 'dev',
        status: game?.state?.status ?? 'idle',
        initMs: game?.initMs ?? null,
        tier: game?.governor?.label?.() ?? 'none',
        frameMsP50: round(percentile(game?.frames ?? [], 0.5)),
        frameMsP95: round(percentile(game?.frames ?? [], 0.95)),
        longFrames: game?.longFrames ?? 0,
        drawCalls: renderer?.info?.render?.calls ?? 0,
        triangles: renderer?.info?.render?.triangles ?? 0,
        actors: Number.parseInt(game?.host?.dataset?.actorCount ?? '0', 10),
        footprints: game?.osmBuildings ?? 0,
        weather: game?.weather?.condition ?? '',
        sun: game?.view?.sun?.() ?? null,
        snow: game?.snow ?? 0,
        overlay: game?.prefs?.overlay ?? 'off',
        director: game?.prefs?.director ?? false,
        captions: game?.prefs?.captions ?? false,
        canvas: game?.view?.canvas ? { width: game.view.canvas.width, height: game.view.canvas.height } : null,
        devicePixelRatio: window.devicePixelRatio ?? 1,
        userAgent: navigator.userAgent,
        url: location.href,
        events: game?.telemetry?.slice(-10) ?? [],
        addons: { ...(game?.view?.addons?.() ?? {}), score: Boolean(window.Tone && game?.prefs?.score === 'on'), hailer: Boolean(window.Howler && game?.prefs?.hailer === 'on'), aftermath: Boolean(game?.aftermath) },
    };
}

function getDiagnosticsText() {
    const d = getDiagnostics();
    return [
        `PoCapitol build ${d.build} · ${d.status}`,
        `Init ${d.initMs ?? '—'} ms · tier ${d.tier} · ${d.drawCalls} draw calls · ${d.triangles} triangles`,
        `Frame ${d.frameMsP50} ms p50 / ${d.frameMsP95} ms p95 · ${d.longFrames} frames over 55 ms`,
        `Actors ${d.actors} · OSM footprints ${d.footprints} · weather ${d.weather || 'n/a'}`,
        `Sun ${d.sun ? `${d.sun.altitude}° up at ${d.sun.azimuth}°` : 'n/a'} · snow ${Math.round(d.snow * 100)}% · overlay ${d.overlay}`,
        `Director ${d.director ? 'on' : 'off'} · captions ${d.captions ? 'on' : 'off'}`,
        `Add-ons: debris ${d.addons.debris ?? 0} · gas ${d.addons.gas ?? 'cpu'} · paper ${d.addons.flyers ? 'on' : 'off'} · score ${d.addons.score ? 'on' : 'off'} · loudhailer ${d.addons.hailer ? 'on' : 'off'}`,
        `Canvas ${d.canvas ? `${d.canvas.width}×${d.canvas.height}` : 'none'} @ ${d.devicePixelRatio}x`,
        `URL ${d.url}`,
        `UA ${d.userAgent}`,
    ].join('\n');
}

function buildReport(state) {
    const report = game.recorder.build(state, {
        mode: state.demo ? 'demo' : 'solo',
        role: state.role,
        clock: clockLabel(state.elapsed),
    });
    const crowd = game.analysis.summary();
    report.crowd = crowd;
    Object.assign(report, {
        peakDensity: crowd.peakDensity, peakGrade: crowd.peakGrade, riskSeconds: crowd.riskSeconds,
        riskEpisodes: crowd.riskEpisodes, packedShare: crowd.packedShare, peakPushing: crowd.peakPushing,
        peakTipped: crowd.peakTipped,
    });
    report.lines = state.lines.map(l => ({ brokenAt: l.brokenAt, withdrawn: l.withdrawn === true }));
    if (state.command) report.command = { issued: state.command.issued, withdrawn: state.command.withdrawn, gasLeft: state.command.gas };
    return report;
}

/**
 * The end-of-attempt panel in the shape the page wants: SVG, CSV and text, plus flat numbers.
 * The demo restarts six seconds after it ends, so the finished attempt is remembered before
 * the recorder is cleared.
 */
function currentReport() {
    const state = game.state;
    const finished = state.status === 'completed' || state.status === 'failed';
    return finished || !game.lastReport ? buildReport(state) : game.lastReport;
}

function getReportView() {
    if (!game) return null;
    const report = currentReport();
    return {
        svg: toSvg(report),
        csv: toCsv(report),
        text: toText(report),
        mode: report.mode, role: report.role, difficulty: report.difficulty,
        outcome: report.outcome || report.status, status: report.status, clock: report.clock,
        standing: report.standing, police: report.police,
        casualties: report.casualties, immediate: report.immediate,
        lowestIntegrity: report.lowestIntegrity, peakPressure: report.peakPressure,
        firstBreak: report.firstBreak ?? -1,
        milestones: report.milestones.length,
        minutes: Math.round(report.elapsed / 60),
        peakDensity: report.peakDensity ?? 0, peakGrade: report.peakGrade ?? 'A',
        riskSeconds: report.riskSeconds ?? 0, riskEpisodes: report.riskEpisodes ?? 0, packedShare: report.packedShare ?? 0,
        peakPushing: report.peakPushing ?? 0, peakTipped: report.peakTipped ?? 0,
        orders: report.command?.issued ?? -1, withdrawn: report.command?.withdrawn ?? 0,
        // Sparklines for the end card's stat cards: each series thinned to at most 40 points,
        // comma-separated so the record stays flat for the trimmed build.
        sparkIntegrity: spark(report.series, s => s.integrity),
        sparkPressure: spark(report.series, s => s.pressure),
        sparkRaiders: spark(report.series, s => s.raiders),
        sparkPolice: spark(report.series, s => s.police),
        sparkCasualties: spark(report.series, s => s.casualties),
    };
}

/** One sampled series as at most `points` comma-separated numbers (rounded to 0.1). */
function spark(series = [], pick, points = 40) {
    if (!series?.length) return '';
    const step = Math.max(1, series.length / points), out = [];
    for (let i = 0; i < series.length; i += step) out.push(Math.round((Number(pick(series[Math.floor(i)])) || 0) * 10) / 10);
    return out.join(',');
}

/**
 * The incident commander's board for the page: one flat record. Lists are comma-separated
 * strings (integrity per line, -1 once it has gone; braced as 1/0) so the trimmed WASM build
 * reads it without nested types.
 */
function commandView(s, reply = '') {
    const cmd = s.command;
    return {
        selected: cmd.selected, gas: cmd.gas, issued: cmd.issued, reply: reply ?? '',
        reinforceIn: Math.ceil(orderWait(s, 'reinforce')), relieveIn: Math.ceil(orderWait(s, 'relieve')), gasIn: Math.ceil(orderWait(s, 'gas')),
        braced: cmd.braced.map(b => (b ? 1 : 0)).join(','),
        integrity: s.lines.map(l => (l.state === 'holding' ? Math.round(l.integrity) : -1)).join(','),
        strain: s.lines.map(l => Math.round(Math.min(1, l.strain / 95) * 100)).join(','),
        officers: lineDefs.map((_, i) => s.enemies.filter(e => e.health > 0 && e.line === i).length).join(','),
    };
}

/** One order from the page's command panel. Returns the radio's reply. */
function giveOrder(order, line) {
    if (!game?.order || game.state.role !== 'commander') return '';
    if (order !== 'select' && !ORDERS.includes(order)) return '';
    return game.order(order, line).message;
}

const OVERLAYS = ['off', 'density', 'contagion'];
const OVERLAY_NAMES = { off: 'Analysis overlay off', density: 'Overlay: crowd density (Fruin levels of service)', contagion: 'Overlay: contagion (red pushing, amber tipping, blue calm)' };

/** V: off, density, contagion, and round again. Saved like any other setting. */
function cycleOverlay() {
    if (!game) return 'off';
    const next = OVERLAYS[(OVERLAYS.indexOf(game.prefs.overlay) + 1) % OVERLAYS.length];
    setPrefs({ overlay: next });
    game.caption?.(OVERLAY_NAMES[next], 'event');
    game.reference?.invokeMethodAsync('OnPrefsChanged', prefsView(game.prefs)).catch(() => { /* page gone */ });
    return next;
}

/**
 * The attempt on OpenStreetMap (streetmap.js, MapLibre): loaded only when the player asks for
 * it. Resolves true once the map is drawing in the element with `containerId`.
 */
async function showStreetMap(containerId) {
    hideStreetMap();
    if (!game) return false;
    const container = document.getElementById(containerId);
    if (!container) return false;
    const asked = game.streetAsk = {};
    try {
        const { createStreetMap } = await import('./streetmap.js');
        const r = currentReport();
        const map = await createStreetMap(container, {
            heat: r.heat, cols: HEAT.cols, rows: HEAT.rows, rect: { x0: HEAT.x0, z0: HEAT.z0, w: HEAT.w, d: HEAT.d },
            series: r.series, lines: r.lines ?? [], outcome: r.outcome, role: r.role,
        }, { reducedMotion: document.documentElement.dataset.motion === 'reduce' || game.prefs.motion === 'reduced' });
        if (!game || game.streetAsk !== asked || !container.isConnected) { map.dispose(); return false; }
        game.streetMap = map;
        return true;
    } catch (error) {
        console.warn('[PoCapitol] street map unavailable:', error);
        return false;
    }
}

function hideStreetMap() {
    game?.streetMap?.dispose();
    if (game) { game.streetMap = null; game.streetAsk = null; }
}

/** The attempt as GeoJSON text, for the "Export GeoJSON" button. */
async function getGeoJson() {
    if (!game) return '';
    const { attemptGeoJson } = await import('./streetmap.js');
    const r = currentReport();
    return JSON.stringify(attemptGeoJson({
        heat: r.heat, cols: HEAT.cols, rows: HEAT.rows, rect: { x0: HEAT.x0, z0: HEAT.z0, w: HEAT.w, d: HEAT.d },
        series: r.series, lines: r.lines ?? [], outcome: r.outcome, role: r.role,
    }));
}

/** Evenly thin a series to at most `limit` values (the report card takes 240). */
function resample(values, limit = 240) {
    if (values.length <= limit) return values;
    return Array.from({ length: limit }, (_, i) => values[Math.round(i * (values.length - 1) / (limit - 1))]);
}

/**
 * The last attempt in the shape of POST /api/pocapitol/report-card (PoCapitolReportCardRequest):
 * the page posts it and the server draws the card with SkiaSharp. Series are thinned to 240.
 */
function getReportCard() {
    if (!game) return null;
    const r = currentReport();
    const series = r.series ?? [];
    const safe = text => String(text ?? '').replace(/[^A-Za-z0-9 _.:-]/g, '').slice(0, 32);
    let lastFront = 33;
    const fronts = series.map(s => (lastFront = s.frontZ ?? lastFront));
    return {
        outcome: safe(r.outcome || r.status), role: r.role === 'observer' ? 'none' : r.role === 'commander' ? 'police' : r.role, mode: r.mode,
        difficulty: safe(r.difficulty), clock: String(r.clock ?? '').toLowerCase().replace(/[^0-9apm: ]/g, '').slice(0, 12),
        minutes: Math.round((r.elapsed ?? 0) / 60 * 10) / 10, standing: r.standing ?? 0, police: r.police ?? 0,
        casualties: r.casualties ?? 0, lowestIntegrity: r.lowestIntegrity ?? 100, peakPressure: r.peakPressure ?? 0,
        milestones: r.milestones?.length ?? 0,
        integrity: resample(series.map(s => s.integrity)),
        pressure: resample(series.map(s => s.pressure)),
        frontZ: resample(fronts),
    };
}

/**
 * The aftermath map on the report: where the crowd stood, drawn by aftermath.js on its own
 * WebGPU renderer with TSL materials. Loaded only when a report is shown.
 */
async function showAftermath(canvasId) {
    hideAftermath();
    if (!game) return false;
    const r = currentReport();
    if (!r.heat?.some(v => v > 0)) return false;
    // The report body is only in the page once the player opens "More details", so wait for the
    // canvas (a minute at most) rather than asking the page to call again.
    const asked = game.aftermathAsk = {};
    let canvas = document.getElementById(canvasId);
    for (let waited = 0; !canvas && waited < 60000; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!game || game.aftermathAsk !== asked) return false;
        canvas = document.getElementById(canvasId);
    }
    if (!canvas) return false;
    // The frame stays collapsed until something is drawing in it.
    const frame = canvas.parentElement;
    frame.dataset.live = '1';
    try {
        const { createAftermathMap } = await import('./aftermath.js');
        const series = r.series ?? [];
        const end = Math.max(1, series.at(-1)?.at ?? 1);
        const frontPath = [];
        for (const s of series) if (s.frontZ !== null && s.frontZ !== undefined && frontPath.at(-1)?.z !== s.frontZ) frontPath.push({ z: s.frontZ, t: s.at / end });
        const map = await createAftermathMap(canvas, {
            heat: r.heat, cols: HEAT.cols, rows: HEAT.rows, rect: { x0: HEAT.x0, z0: HEAT.z0, w: HEAT.w, d: HEAT.d },
            areas, obstacles, columns, frontPath,
            reducedMotion: document.documentElement.dataset.motion === 'reduce' || game.prefs.motion === 'reduced',
        });
        if (!map.backend || !game || game.aftermathAsk !== asked || !canvas.isConnected) {
            map.dispose(); delete frame.dataset.live; return false;
        }
        game.aftermath = map;
        return true;
    } catch (error) {
        console.warn('[PoCapitol] aftermath map unavailable:', error);
        delete frame.dataset.live;
        return false;
    }
}

function hideAftermath() {
    game?.aftermath?.dispose();
    if (game) { game.aftermath = null; game.aftermathAsk = null; }
}

/** Save bytes the page holds (the report card PNG from the server). Blazor passes byte[] as a Uint8Array. */
function downloadBytes(name, bytes, type = 'application/octet-stream') {
    download(name, new Blob([bytes], { type }));
}

/** Copy text, falling back to the old selection trick where the clipboard API is blocked. */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(String(text));
        return true;
    } catch {
        try {
            const area = document.createElement('textarea');
            area.value = String(text);
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.append(area);
            area.select();
            const copied = document.execCommand('copy');
            area.remove();
            return Boolean(copied);
        } catch { return false; }
    }
}

function download(name, data) {
    const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain;charset=utf-8' }) : data;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Serialise a report chart to PNG. The SVG carries its own background and literal colours. */
async function exportPng(svgId, name = 'pocapitol-report.png') {
    const svg = document.getElementById(svgId);
    if (!svg) return false;
    const box = svg.viewBox?.baseVal;
    const width = Math.round(box?.width || 640), height = Math.round(box?.height || 220);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
        const canvas = document.createElement('canvas');
        canvas.width = width * 2; canvas.height = height * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(image, 0, 0, width, height);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (png) download(name, png);
        return Boolean(png);
    } catch { return false; } finally { URL.revokeObjectURL(url); }
}

function getPrefs() { return prefsView(game?.prefs ?? loadPrefs()); }

/** The page wants one flat record; storage keeps the key map nested. */
function prefsView(prefs) {
    return {
        sensitivity: prefs.sensitivity, fov: prefs.fov, captions: prefs.captions,
        contrast: prefs.contrast, radar: prefs.radar, director: prefs.director,
        tracers: prefs.tracers, motion: prefs.motion, footage: prefs.footage,
        debrief: prefs.debrief, debriefModel: prefs.debriefModel, score: prefs.score, hailer: prefs.hailer,
        overlay: prefs.overlay,
        forward: prefs.keys.forward, back: prefs.keys.back, left: prefs.keys.left, right: prefs.keys.right,
        push: prefs.keys.push, sprint: prefs.keys.sprint, pause: prefs.keys.pause,
    };
}

/** Save the comfort settings and apply the ones the live scene reads immediately. */
function setPrefs(patch = {}) {
    const base = game?.prefs ?? loadPrefs();
    const merged = savePrefs({ ...base, ...patch, keys: { ...base.keys, ...(patch.keys ?? {}) } });
    if (game) {
        game.prefs = merged;
        applyViewPrefs(game.view, merged);
        game.audio?.setFootage?.(merged.footage === 'on');
        game.audio?.setHudSound?.(merged.hudSound !== 'off');
        game.hailer?.setEnabled(merged.hailer === 'on');
        game.score?.setEnabled(merged.score === 'on');
        game.radar?.setPalette?.(merged.radar);
    }
    return prefsView(merged);
}

/** Bind one key. If another action already holds it the two swap; the page gets the new map. */
/** Let go of the mouse on the game's own account, so the pointer-lock handler does not read it as Esc. */
function releasePointer(g) {
    g.selfUnlock = nowMs();
    try { document.exitPointerLock(); } catch { /* not locked */ }
}

/** Esc: leave the scenario for the hub, through the Blazor router like every in-app link. */
function toMainMenu() {
    try { window.Blazor?.navigateTo?.('/'); } catch { location.assign('/'); }
}

function rebindKey(action, code) {
    const base = game?.prefs ?? loadPrefs();
    return setPrefs({ keys: rebind(base, action, code).keys });
}

/** How strongly each footage setting grades and sways the picture, 0..1. */
const FOOTAGE_AMOUNT = { on: 1, light: 0.35, off: 0 };

/** The comfort settings the live scene reads: lens, tracer style, combat shake and the footage look. */
function applyViewPrefs(view, prefs) {
    view.setFov?.(prefs.fov);
    view.setTracerMode?.(prefs.tracers);
    view.setMotionReduction?.(prefs.motion === 'reduced');
    view.setFootage?.(FOOTAGE_AMOUNT[prefs.footage] ?? 0);
    view.setOverlay?.(prefs.overlay);
    // The overlay follows the radar's palette, and 'auto' follows the app's colour-safe setting.
    const colorsafe = prefs.radar === 'colorsafe' || (prefs.radar === 'auto' && document.documentElement.hasAttribute('data-colorsafe'));
    view.setOverlayPalette?.(colorsafe ? 'colorsafe' : 'default');
}

/**
 * Write the debrief for the last attempt with whichever provider the player chose. Always
 * resolves: a local model that is missing or slow falls back to the built-in writer, and the
 * result says so.
 */
async function getDebrief() {
    if (!game) return null;
    const g = game;
    const result = await g.debrief.write(currentReport(), { provider: g.prefs.debrief, model: g.prefs.debriefModel });
    track('debrief', { provider: result.provider, ms: result.ms, tokens: result.tokens, retries: result.retries, fallback: result.fallback });
    return result;
}

/** Is a local model answering? For the options sheet's "Check" button. */
async function probeDebrief() {
    const router = game?.debrief ?? createDebriefRouter();
    const probe = await router.probe();
    return { available: probe.available, models: probe.models.slice(0, 12).join(', '), error: probe.error ?? '' };
}

function dispose() {
    if (!game) return;
    const g = game;
    g.disposed = true; g.events.abort();
    if (document.pointerLockElement === g.view.canvas) releasePointer(g);
    g.audio?.dispose?.();
    g.hailer?.dispose(); g.score?.dispose(); g.aftermath?.dispose(); g.streetMap?.dispose();
    g.ui?.dispose?.(); g.dissolve?.dispose?.();
    g.radar?.destroy?.();
    g.inspector?.clear?.();
    g.view.dispose(); remove();   // the view's stage stops the loop
    game = null;
}

// Debugging and headless checks only: with localStorage 'pominigames:pocapitol-debug' set, the
// live game is reachable as window.__pocapitol() (state, view, audio layers).
try { if (window.localStorage?.getItem('pominigames:pocapitol-debug')) window.__pocapitol = () => game; } catch { /* storage blocked */ }

window.PoCapitol = {
    init, start, pause, dispose, setGraphics, getGraphics: storedGraphics,
    setWeather, getWeather: storedWeather, initRadar, toggleUnitLatch, clearUnitInspect,
    getPrefs, setPrefs, rebindKey,
    getReportView, getDebrief, probeDebrief, download, downloadBytes, exportPng, copyText,
    getReportCard, showAftermath, hideAftermath,
    getDiagnostics, getDiagnosticsText,
    giveOrder, cycleOverlay, showStreetMap, hideStreetMap, getGeoJson,
};
