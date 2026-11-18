// stage.js — the shared game host for every 2D and 3D engine.
//
// What each engine used to rebuild by hand, owned once here:
//   • canvas backing size through the ONE pixel-ratio policy (window.PoCanvasDpr)
//   • a loop-safe ResizeObserver (resize deferred a frame: resizing inside the callback logs
//     "ResizeObserver loop completed with undelivered notifications")
//   • the rAF loop (loop.js): dt clamp, optional fixed step, hitstop time scale
//   • pause on hidden tab / lost focus / user, with reasons, and a clean clock on resume
//   • the app quality tier (window.PoQuality) as `stage.tier` plus a 'tier' event
//   • a cleanup registry, so dispose() undoes every listener, observer and frame
//   • the feature registry (features.js): shared effects attach here without the game knowing
//
// What stays in the game: what it simulates and what it draws.
//
//   const stage = createStage({ kind: '2d', canvas, onStep: dt => sim(dt), onFrame: () => stage.render(draw) });
//   stage.start();  …  stage.dispose();

import { createLoop } from './loop.js';
import { resolveFeatures } from './features.js';
import './features/index.js';

// ── quality tier fan-out ─────────────────────────────────────────────────────
// PoQuality.onChange has no unsubscribe, so the stages share ONE subscription.
const tierListeners = new Set();
let tierHooked = false;
function currentTier() {
    try { return globalThis.PoQuality?.tier?.() ?? 'high'; } catch { return 'high'; }
}
function watchTier(fn) {
    if (!tierHooked && globalThis.PoQuality?.onChange) {
        tierHooked = true;
        globalThis.PoQuality.onChange(() => { for (const f of [...tierListeners]) f(currentTier()); });
    }
    tierListeners.add(fn);
    return () => tierListeners.delete(fn);
}

/** The shared DPR policy, with a fallback for hosts that did not load canvasDpr.js. */
export function resolveDpr(cssW, cssH, opts) {
    const p = globalThis.PoCanvasDpr;
    if (p?.resolve) return p.resolve(cssW, cssH, opts);
    return Math.min(globalThis.devicePixelRatio || 1, opts?.maxDpr || 2);
}

const warned = new Set();
function guard(id, hook, fn) {
    try { return fn(); } catch (err) {
        const key = `${id}:${hook}`;
        if (!warned.has(key)) { warned.add(key); console.error(`[stage] feature ${key} failed`, err); }
        return undefined;
    }
}

/**
 * @param {object} o
 * @param {'2d'|'3d'} [o.kind='2d']
 * @param {HTMLCanvasElement} [o.canvas]     drawing surface (2D: sized by the stage)
 * @param {HTMLElement} [o.container]        element to measure (default: canvas)
 * @param {'2d'|'webgl2'|'none'} [o.context] context the stage creates (2D default '2d', 3D 'none')
 * @param {object}  [o.contextOptions]
 * @param {boolean} [o.sizeCanvas]           stage writes canvas.width/height (default: kind === '2d')
 * @param {number}  [o.maxPixels] [o.maxDpr] per-game override of the shared pixel budget
 * @param {number}  [o.fixedStep] [o.maxDt] [o.maxSteps]  loop options (see loop.js)
 * @param {'impact'|(()=>number)} [o.timeScale]  'impact' follows PoImpact hitstop
 * @param {boolean} [o.renderWhilePaused]
 * @param {Array<'hidden'|'blur'>} [o.pauseOn=['hidden']]
 * @param {{scale?:number, maxPx?:number, maxUnits?:number, maxRoll?:number}} [o.shake]  tune the shared shake
 * @param {Array<string|object>} [o.use]  extra features; [o.exclude] feature ids to leave off
 * @param {(dt:number, stage)=>void} [o.onStep]
 * @param {(dt:number, alpha:number, stage)=>void} [o.onFrame]
 * @param {(view, stage)=>void} [o.onResize]
 */
export function createStage(o = {}) {
    const kind = o.kind ?? '2d';
    if (kind !== '2d' && kind !== '3d') throw new Error(`stage kind must be 2d or 3d, got ${kind}`);
    const canvas = o.canvas ?? null;
    const measureEl = o.container ?? canvas;
    const sizeCanvas = o.sizeCanvas ?? (kind === '2d');
    const contextType = o.context ?? (kind === '2d' ? '2d' : 'none');

    const cleanups = [];
    const listeners = new Map();
    const limits = { maxPixels: o.maxPixels, maxDpr: o.maxDpr };
    const pauseReasons = new Set();
    let disposed = false;

    const view = { cssW: 0, cssH: 0, w: 0, h: 0, dpr: 1, sx: 1, sy: 1 };

    function emit(evt, ...args) {
        const set = listeners.get(evt);
        if (set) for (const fn of [...set]) fn(...args);
    }

    const stage = {
        kind,
        canvas,
        container: measureEl,
        ctx: null,
        view,
        tier: currentTier(),
        /** Shared camera-shake offset; the shake feature writes it (2D: CSS px, 3D: world units). */
        shake: { amount: 0, x: 0, y: 0, z: 0, roll: 0 },
        /** 3D games set this so 3D features (shake, photo, …) can reach the camera. */
        camera: null,
        renderer: null,
        time: 0,
        frameNo: 0,
        features: new Map(),
        userData: { ...(o.userData ?? {}), ...(o.shake ? { shake: o.shake } : {}) },

        on(evt, fn) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(fn);
            return () => listeners.get(evt)?.delete(fn);
        },
        emit,

        /** Register an undo to run on dispose(). Returns the function for chaining. */
        own(fn) { if (typeof fn === 'function') cleanups.push(fn); return fn; },

        /** addEventListener that dispose() removes. */
        listen(target, type, fn, opts) {
            target.addEventListener(type, fn, opts);
            cleanups.push(() => target.removeEventListener(type, fn, opts));
        },

        /**
         * Follow a media query (orientation, reduced motion, …): fn(matches) now and on every
         * change, unsubscribed on dispose. Returns the MediaQueryList (null without matchMedia).
         */
        media(query, fn) {
            const mq = globalThis.matchMedia?.(query);
            if (!mq) return null;
            const on = () => fn(mq.matches);
            stage.listen(mq, 'change', on);
            on();
            return mq;
        },

        feature(id) { return stage.features.get(id)?.instance ?? null; },

        /** rAF timestamp (ms) of the current frame — for shaders and effects keyed to frame time. */
        get now() { return loop.now; },
        get paused() { return pauseReasons.size > 0; },
        get pauseReasons() { return [...pauseReasons]; },
        setPaused(on, reason = 'user') {
            const was = pauseReasons.size > 0;
            if (on) pauseReasons.add(reason); else pauseReasons.delete(reason);
            const now = pauseReasons.size > 0;
            if (now === was) return;
            loop.setPaused(now);
            for (const [id, f] of stage.features) if (f.instance[now ? 'pause' : 'resume']) guard(id, 'pause', () => f.instance[now ? 'pause' : 'resume']());
            emit(now ? 'pause' : 'resume', stage.pauseReasons);
        },

        start() { if (!disposed) loop.start(); },
        stop() { loop.stop(); },

        /** Re-measure now (normally automatic). Returns true when the size changed. */
        resize() { return measure(); },

        /** Move the pixel budget at runtime (e.g. a quality-tier DPR ceiling) and re-measure. */
        setLimits({ maxDpr = limits.maxDpr, maxPixels = limits.maxPixels } = {}) {
            if (maxDpr === limits.maxDpr && maxPixels === limits.maxPixels) return false;
            limits.maxDpr = maxDpr; limits.maxPixels = maxPixels;
            return measure();
        },

        /**
         * 2D: set the context transform in CSS-pixel units, with the backing scale and shake
         * folded in: drawing at (x, y) after setTransform(s, ox, oy) lands at ox + s·x CSS px.
         */
        setTransform(scale = 1, ox = 0, oy = 0, ctx = stage.ctx) {
            if (!ctx?.setTransform) return;
            const s = stage.shake;
            ctx.setTransform(view.sx * scale, 0, 0, view.sy * scale, view.sx * (ox + s.x), view.sy * (oy + s.y));
        },

        /**
         * Wrap the game's draw so features run around it.
         * 2D: the context arrives scaled to CSS px with shake applied; overlays draw after.
         * 3D: features adjust stage.camera before and restore after.
         */
        render(draw) {
            const ctx = contextType === '2d' ? stage.ctx : null;
            if (ctx) { ctx.save(); stage.setTransform(); }
            for (const [id, f] of stage.features) if (f.instance.beforeRender) guard(id, 'beforeRender', () => f.instance.beforeRender(ctx));
            try { draw?.(ctx); }
            finally {
                if (ctx) { ctx.restore(); ctx.save(); ctx.setTransform(view.sx, 0, 0, view.sy, 0, 0); }
                for (const [id, f] of [...stage.features].reverse()) if (f.instance.afterRender) guard(id, 'afterRender', () => f.instance.afterRender(ctx));
                if (ctx) ctx.restore();
            }
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            loop.stop();
            emit('dispose');
            for (const [id, f] of [...stage.features].reverse()) if (f.instance.dispose) guard(id, 'dispose', () => f.instance.dispose());
            stage.features.clear();
            for (const undo of cleanups.splice(0).reverse()) { try { undo(); } catch { /* keep tearing down */ } }
            listeners.clear();
        },
        get disposed() { return disposed; },
    };

    // ── context ──────────────────────────────────────────────────────────────
    if (canvas && contextType !== 'none') {
        stage.ctx = canvas.getContext(contextType, o.contextOptions);
        if (!stage.ctx) throw new Error(`stage: no ${contextType} context`);
    }

    // ── sizing ───────────────────────────────────────────────────────────────
    function measure() {
        if (!measureEl || disposed) return false;
        const cssW = Math.max(1, measureEl.clientWidth || 0);
        const cssH = Math.max(1, measureEl.clientHeight || 0);
        const dpr = resolveDpr(cssW, cssH, limits);
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (cssW === view.cssW && cssH === view.cssH && w === view.w && h === view.h) return false;
        Object.assign(view, { cssW, cssH, dpr, w, h, sx: w / cssW, sy: h / cssH });
        if (sizeCanvas && canvas && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
        for (const [id, f] of stage.features) if (f.instance.resize) guard(id, 'resize', () => f.instance.resize(view));
        o.onResize?.(view, stage);
        emit('resize', view);
        return true;
    }

    if (measureEl && typeof ResizeObserver !== 'undefined') {
        let pending = 0;
        const ro = new ResizeObserver(() => {
            if (pending) return;
            pending = requestAnimationFrame(() => { pending = 0; measure(); });
        });
        ro.observe(measureEl);
        cleanups.push(() => { ro.disconnect(); if (pending) cancelAnimationFrame(pending); });
    }
    if (typeof window !== 'undefined' && measureEl) stage.listen(window, 'resize', () => measure());   // DPR / zoom changes

    // ── pause sources ────────────────────────────────────────────────────────
    const pauseOn = new Set(o.pauseOn ?? ['hidden']);
    if (typeof document !== 'undefined') {
        if (pauseOn.has('hidden')) {
            stage.listen(document, 'visibilitychange', () => stage.setPaused(document.hidden, 'hidden'));
        }
        if (pauseOn.has('blur') && typeof window !== 'undefined') {
            stage.listen(window, 'blur', () => stage.setPaused(true, 'blur'));
            stage.listen(window, 'focus', () => stage.setPaused(false, 'blur'));
        }
    }

    // ── tier ─────────────────────────────────────────────────────────────────
    cleanups.push(watchTier((tier) => {
        if (tier === stage.tier) return;
        stage.tier = tier;
        for (const [id, f] of stage.features) if (f.instance.tier) guard(id, 'tier', () => f.instance.tier(tier));
        emit('tier', tier);
    }));

    // ── loop ─────────────────────────────────────────────────────────────────
    const timeScale = o.timeScale === 'impact'
        ? () => globalThis.PoImpact?.getTimeScale?.() ?? 1
        : (typeof o.timeScale === 'function' ? o.timeScale : undefined);

    const loop = createLoop({
        fixedStep: o.fixedStep, maxDt: o.maxDt, maxSteps: o.maxSteps, timeScale,
        renderWhilePaused: o.renderWhilePaused, raf: o.raf, caf: o.caf,
        step(dt) {
            stage.time += dt;
            o.onStep?.(dt, stage);
            emit('step', dt);
        },
        frame(dt, alpha) {
            stage.frameNo++;
            for (const [id, f] of stage.features) if (f.instance.update) guard(id, 'update', () => f.instance.update(dt));
            o.onFrame?.(dt, alpha, stage);
            emit('frame', dt, alpha);
        },
    });
    stage.loop = loop;

    // ── features ─────────────────────────────────────────────────────────────
    for (const def of resolveFeatures(kind, { use: o.use, exclude: o.exclude })) {
        const instance = guard(def.id, 'create', () => def.create(stage));
        if (instance) stage.features.set(def.id, { def, instance });
    }

    measure();
    if (typeof document !== 'undefined' && pauseOn.has('hidden') && document.hidden) stage.setPaused(true, 'hidden');
    if (o.autoStart) stage.start();
    return stage;
}
