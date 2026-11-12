import { createAttempt, advance, shove, fire, throwPlayerGrenade, setPaused, selectLeader, frontLine, milestones, clockLabel } from './world.js';
import { createScene } from './scene.js';
import { loadFigure } from './crowd.js';
import { createAudio } from './audio.js';
import { createUiFx } from './ui.js';
import { createGovernor, preferredMode, detectTier } from './quality.js';
import { fetchWeather } from './weather.js';
import { createRadar } from './radar.js';
import { createInspector } from './inspector.js';
import { createRecorder, toCsv, toText, toSvg } from './report.js';
import { createDirector } from './director.js';
import { loadPrefs, savePrefs, matches } from './prefs.js';
import { loadCampusData } from './campusData.js';
import { loadSigns } from './signs.js';
import { ensure, remove } from '../radzenTheme.js';
import { connectedPads, stick, pressed, ButtonEdges } from '../gamepadBus.js';

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
    const view = createScene(host, { figure, osm, signs });
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
    view.setFov?.(prefs.fov);
    const g = {
        host, view, reference, state: createAttempt(), started: false, disposed: false,
        yaw: 0, pitch: 0, keys: new Set(), firing: false, frame: 0, last: 0,
        notifyAt: 0, notifying: false, message: '', drag: null, edges: new ButtonEdges(), restartAt: 0,
        events: new AbortController(), audio: null, ui: null, mix: null, mixAt: 0,
        governor: createGovernor({ tier, mode: storedGraphics() }), tier, tierAt: 0,
        weather: null, radar: null, inspector: null,
        prefs, recorder: createRecorder({ labels: milestones.map(m => m.label) }), director: createDirector(),
        frames: [], longFrames: 0, captionAt: 0, initMs: Math.round(nowMs() - bootAt),
        osmBuildings: osm?.buildings?.length ?? 0, osmAttribution: osm?.attribution ?? '',
        lastMilestone: 0, telemetry: [],
    };
    game = g;
    view.applyQuality?.(g.governor.settings());
    track('init', { ms: g.initMs, tier,
        footprints: g.osmBuildings, signs: signs.length });

    // Weather API integration & dynamic updates
    fetchWeather(storedWeather()).then(w => {
        g.weather = w;
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
    const signal = g.events.signal;
    const listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const clearInput = () => { g.keys.clear(); g.firing = false; g.drag = null; };
    const human = () => g.state.role !== 'none';
    const held = action => { for (const code of g.keys) if (matches(g.prefs, action, code)) return true; return false; };
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
        if ((e.code === 'Escape' || matches(g.prefs, 'pause', e.code)) && !e.repeat) {
            pause(g.state.status === 'active'); e.preventDefault(); return;
        }
        if (!human()) return;
        if (g.state.status !== 'active') return;
        if (e.target.closest?.('button, a, summary, [role="radio"]')) return;
        if (['forward', 'back', 'left', 'right', 'push', 'sprint'].some(action => matches(g.prefs, action, e.code))) {
            g.keys.add(e.code); e.preventDefault();
        }
    });
    listen(window, 'keyup', e => g.keys.delete(e.code));
    // G lobs one of the one-player raider's concussion grenades, H a smoke grenade.
    listen(window, 'keydown', e => {
        if (e.repeat || e.target.closest?.('button, a, summary, [role="radio"]')) return;
        if (e.code !== 'KeyG' && e.code !== 'KeyH') return;
        if (!human() || g.state.status !== 'active') return;
        const thrown = throwPlayerGrenade(g.state, view.aim(g.state, g.yaw), e.code === 'KeyH' ? 'smoke' : 'concussion');
        if (thrown) {
            g.audio?.event(g.state.events.at(-1));
            e.preventDefault();
        }
    });
    listen(window, 'blur', () => { clearInput(); if (human()) pause(true); });
    listen(document, 'visibilitychange', () => { if (document.hidden) { clearInput(); if (human()) pause(true); } });
    listen(document, 'pointerlockchange', () => {
        if (document.pointerLockElement !== view.canvas && g.started && human()) { clearInput(); pause(true); }
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
    // walk the quality ladder down while nobody is watching.
    listen(document, 'visibilitychange', () => g.governor.suspend(document.hidden));
    listen(view.canvas, 'contextmenu', e => e.preventDefault());
    listen(view.canvas, 'webglcontextlost', e => {
        e.preventDefault();
        pause(true);
        g.started = false;
        track('context-lost', { tier: g.governor.label() });
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
            const frameMs = elapsed * 1000;
            g.frames.push(frameMs); if (g.frames.length > 240) g.frames.shift();
            if (frameMs > 55) g.longFrames++;
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
                const strafe = (bound('right') ? 1 : 0) - (bound('left') ? 1 : 0) + left.x;
                const forward = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0) - left.y;
                x = strafe * Math.cos(g.yaw) - forward * Math.sin(g.yaw);
                z = -strafe * Math.sin(g.yaw) - forward * Math.cos(g.yaw);
                advance(g.state, { x, z, sprint: held('sprint') || pressed(pad, 10) }, dt);
                // Read this step's events before a shove appends its own.
                for (const event of g.state.events) {
                    g.audio?.event(event);
                    // A shield shatters with the same type; only a line break carries `line`.
                    if (event.type === 'break' && event.line !== undefined) g.caption('A police line has given way.');
                    if (event.type === 'openfire') g.caption('The police opened fire. The crowd breaks and runs.');
                }
                if (g.state.milestone !== g.lastMilestone) {
                    g.lastMilestone = g.state.milestone;
                    g.caption(milestones[g.state.milestone - 1]?.label ?? 'Objective reached', 'event');
                }
                g.recorder.step(g.state);
                g.director.observe(g.state, now);
                if (human() && (g.firing || held('push') || pressed(pad, 7))) {
                    const aim = view.aim(g.state, g.yaw);
                    const pushed = g.state.weapon === 'mg' ? fire(g.state, aim) : shove(g.state, aim);
                    if (pushed) g.audio?.event(g.state.events.at(-1));
                }
                if (g.state.status === 'completed' || g.state.status === 'failed') {
                    clearInput();
                    if (!g.ended) {
                        g.ended = true;
                        g.lastReport = buildReport(g.state);
                        track('end', { mode: g.state.demo ? 'demo' : 'solo', outcome: g.state.outcome, seconds: Math.round(g.state.elapsed) });
                    }
                    if (g.state.demo) g.restartAt = now + 6000;
                    if (document.pointerLockElement === view.canvas) document.exitPointerLock();
                }
            }
            const moving = Math.hypot(x, z) > 0.1 && g.state.status === 'active';

            // Real-time Tactical Radar & Unit Inspector updates
            initRadar('pocapitol-radar');
            if (g.radar) g.radar.render(g.state, g.inspector?.getSelected(), dt);
            g.inspector?.update(g.state);

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
            });

            const s = g.state;
            host.dataset.damaged = s.damageFlash > 0 ? 'true' : 'false';
            host.dataset.hazard = s.gassed ? 'gas' : s.sprayed > 0 ? 'spray' : '';
            host.dataset.flash = s.flashed > 0 && window.PoQuality?.reduceFlashing?.() !== true ? 'true' : 'false';
            if (g.audio) {
                if (now >= g.mixAt) { g.mixAt = now + 200; g.mix = soundMix(s); }
                // Heading changes every frame; the 5 Hz crowd read does not carry it.
                const ear = s.role === 'none' ? selectLeader(s) ?? s.player : s.player;
                const yaw = s.role === 'none' ? ear.heading ?? 0 : g.yaw;
                g.audio.update({ ...g.mix, x: ear.x, z: ear.z, yaw, walking: moving, gassed: s.gassed, active: g.started && s.status === 'active' }, dt);
            }
            if (g.weather?.mode === 'live' && now >= (g.weatherRefreshAt || 0)) {
                g.weatherRefreshAt = now + 300000;
                fetchWeather('live').then(w => {
                    if (g.disposed) return;
                    g.weather = w;
                    reference?.invokeMethodAsync('OnWeatherUpdate', w.condition).catch(() => {});
                }).catch(() => {});
            }
            if (g.started && now >= g.notifyAt) { g.notifyAt = now + 200; notify(g); }
            g.frame = requestAnimationFrame(loop);
        } catch (error) {
            console.error('[PoCapitol] frame failed:', error);
            track('frame-error', { message: String(error?.message ?? error) });
            g.started = false;
            reference.invokeMethodAsync('OnEngineError', error.message).catch(err => console.error('[PoCapitol] error notification failed:', err));
        }
    }
    g.frame = requestAnimationFrame(loop);
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
function soundMix(s) {
    const ear = s.role === 'none' ? selectLeader(s) ?? s.player : s.player;
    let crowd = 0, morale = 0, shear = 0, packed = 0;
    const near = [];
    for (const c of s.companions) {
        const distance = Math.hypot(c.x - ear.x, c.z - ear.z);
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
    const front = frontLine(s);
    const pressure = front && Math.abs(front.z - ear.z) < 28 ? Math.min(1, front.pressure / 24) : 0;
    return {
        x: ear.x, z: ear.z, crowd: Math.min(1, crowd / 35), morale: crowd ? morale / crowd : 0, police, pressure,
        shear: packed ? Math.min(1, shear / packed / 2.5 * Math.min(1, packed / 8)) : 0,
        walkers: near.slice(0, 6), horn,
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
    g.reference.invokeMethodAsync('OnUpdate', Math.round(s.health), s.milestone, s.elapsed, s.status, s.pushes, s.staggers, g.message,
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
}

function start(difficulty, demo = false, role = 'raider') {
    if (!game) throw new Error('PoCapitol is not loaded.');
    game.state = createAttempt(difficulty, demo, role);
    game.yaw = role === 'police' && !demo ? Math.PI : 0;
    game.pitch = 0; game.keys.clear(); game.firing = false;
    game.started = true; game.message = ''; game.notifyAt = 0; game.restartAt = 0;
    game.inspector?.clear();
    game.recorder.reset(); game.director.reset();
    game.lastMilestone = 0; game.ended = false; game.state.subject = -1;
    track('start', { mode: demo ? 'demo' : 'solo', role, difficulty, tier: game.governor.label() });
    // The opening establishing shot: five seconds over the Capitol before the player is behind
    // the crowd. Skipped when reduced motion is asked for.
    game.view.startIntro?.();
    // Created on the first start, which follows a click: browsers keep audio shut until then.
    if (!game.audio) {
        const current = game;
        game.audio = createAudio({ onCaption: text => current.caption?.(text, 'radio') });
    }
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

async function setWeather(mode) {
    if (!game) return 'historical';
    const w = await fetchWeather(mode);
    game.weather = w;
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

function adjustHealth(delta) {
    if (!game?.state) return;
    game.state.health = Math.max(0, Math.min(100, Math.round((game.state.health ?? 100) + delta)));
    notify(game);
}

function getDebugStats() {
    if (!game) return { fps: 60, drawCalls: 0, actors: 0, keys: [], mode: 'auto', label: 'Auto' };
    const r = game.view?.renderer;
    const calls = r?.info?.render?.calls ?? parseInt(game.host?.dataset?.drawCalls || '0', 10);
    const actors = parseInt(game.host?.dataset?.actorCount || '0', 10);
    const now = nowMs();
    const dt = Math.max(0.001, (now - (game.last || now)) / 1000);
    const fps = Math.min(120, Math.round(1 / dt));
    return {
        fps: fps > 0 && fps < 200 ? fps : 60,
        drawCalls: calls,
        actors: actors,
        keys: Array.from(game.keys || []),
        mode: game.governor?.mode || 'auto',
        label: game.governor?.label() || 'Auto',
        weather: game.weather?.condition || 'Historical Jan 6',
    };
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
        build: '261111.1',
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
        director: game?.prefs?.director ?? false,
        captions: game?.prefs?.captions ?? false,
        canvas: game?.view?.canvas ? { width: game.view.canvas.width, height: game.view.canvas.height } : null,
        devicePixelRatio: window.devicePixelRatio ?? 1,
        userAgent: navigator.userAgent,
        url: location.href,
        events: game?.telemetry?.slice(-10) ?? [],
    };
}

function getDiagnosticsText() {
    const d = getDiagnostics();
    return [
        `PoCapitol build ${d.build} · ${d.status}`,
        `Init ${d.initMs ?? '—'} ms · tier ${d.tier} · ${d.drawCalls} draw calls · ${d.triangles} triangles`,
        `Frame ${d.frameMsP50} ms p50 / ${d.frameMsP95} ms p95 · ${d.longFrames} frames over 55 ms`,
        `Actors ${d.actors} · OSM footprints ${d.footprints} · weather ${d.weather || 'n/a'}`,
        `Director ${d.director ? 'on' : 'off'} · captions ${d.captions ? 'on' : 'off'}`,
        `Canvas ${d.canvas ? `${d.canvas.width}×${d.canvas.height}` : 'none'} @ ${d.devicePixelRatio}x`,
        `URL ${d.url}`,
        `UA ${d.userAgent}`,
    ].join('\n');
}

function buildReport(state) {
    return game.recorder.build(state, {
        mode: state.demo ? 'demo' : 'solo',
        role: state.role,
        clock: clockLabel(state.elapsed),
    });
}

function getReport() {
    if (!game) return null;
    return buildReport(game.state);
}

/**
 * The end-of-attempt panel in the shape the page wants: SVG, CSV and text, plus flat numbers.
 * The demo restarts six seconds after it ends, so the finished attempt is remembered before
 * the recorder is cleared.
 */
function getReportView() {
    if (!game) return null;
    const state = game.state;
    const finished = state.status === 'completed' || state.status === 'failed';
    const report = finished || !game.lastReport ? buildReport(state) : game.lastReport;
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
    };
}

function getReportCsv() { const report = getReport(); return report ? toCsv(report) : ''; }
function getReportText() { const report = getReport(); return report ? toText(report) : ''; }

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
        game.view.setFov?.(merged.fov);
        game.radar?.setPalette?.(merged.radar);
    }
    return prefsView(merged);
}

function setDirector(on) { return setPrefs({ director: !!on }).director; }

function setTracerMode(mode) {
    if (game?.view?.setTracerMode) game.view.setTracerMode(mode);
}

function setMotionReduction(calmVal) {
    if (game?.view?.setMotionReduction) game.view.setMotionReduction(calmVal);
}

function dispose() {
    if (!game) return;
    const g = game;
    g.disposed = true; g.events.abort(); cancelAnimationFrame(g.frame);
    if (document.pointerLockElement === g.view.canvas) document.exitPointerLock();
    g.audio?.dispose?.();
    g.ui?.dispose?.();
    g.radar?.destroy?.();
    g.inspector?.clear?.();
    g.view.dispose(); remove(); game = null;
}

window.PoCapitol = {
    init, start, pause, dispose, setGraphics, getGraphics: storedGraphics, getDebugStats,
    setWeather, getWeather: storedWeather, initRadar, toggleUnitLatch, clearUnitInspect,
    adjustHealth, setTracerMode, setMotionReduction,
    getPrefs, setPrefs, setDirector,
    getReport, getReportView, getReportCsv, getReportText, download, exportPng, copyText,
    getDiagnostics, getDiagnosticsText, track,
};
