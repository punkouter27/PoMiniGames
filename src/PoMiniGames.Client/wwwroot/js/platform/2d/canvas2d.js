// canvas2d.js — 2D canvas helpers that do not need a full stage.
//
// bindCanvas: for the small canvases that live inside another engine (HUD radar, minimap,
// telemetry strips) — the shared DPR policy, a loop-safe ResizeObserver and a CSS-px
// transform, without a loop of their own.
// makeLayer: an offscreen canvas for cached drawing (tiles, track art, baked textures).

import { resolveDpr } from '../stage/stage.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{maxPixels?:number, maxDpr?:number, measure?:HTMLElement, observe?:boolean,
 *          context?:'2d'|'none', contextOptions?:object,
 *          onResize?:(view:{cssW:number,cssH:number,w:number,h:number,dpr:number,sx:number,sy:number})=>void}} [opts]
 */
export function bindCanvas(canvas, opts = {}) {
    const el = opts.measure ?? canvas;
    const view = { cssW: 0, cssH: 0, w: 0, h: 0, dpr: 1, sx: 1, sy: 1 };
    const ctx = opts.context === 'none' ? null : canvas.getContext('2d', opts.contextOptions);
    let ro = null;
    let pending = 0;

    function resize() {
        const cssW = Math.max(1, el.clientWidth || 0);
        const cssH = Math.max(1, el.clientHeight || 0);
        const dpr = resolveDpr(cssW, cssH, { maxPixels: opts.maxPixels, maxDpr: opts.maxDpr });
        const w = Math.max(1, Math.round(cssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (w === view.w && h === view.h && cssW === view.cssW && cssH === view.cssH) return false;
        Object.assign(view, { cssW, cssH, dpr, w, h, sx: w / cssW, sy: h / cssH });
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        opts.onResize?.(view);
        return true;
    }

    if (opts.observe !== false && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
            if (pending) return;
            pending = requestAnimationFrame(() => { pending = 0; resize(); });
        });
        ro.observe(el);
    }
    resize();

    return {
        canvas, ctx, view, resize,
        /** Reset the transform to CSS-px units (optionally scaled/offset in CSS px). */
        begin(scale = 1, ox = 0, oy = 0) {
            ctx?.setTransform(view.sx * scale, 0, 0, view.sy * scale, view.sx * ox, view.sy * oy);
            return ctx;
        },
        /** Clear the whole backing store. */
        clear() {
            if (!ctx) return;
            ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
        },
        dispose() { ro?.disconnect(); ro = null; if (pending) cancelAnimationFrame(pending); pending = 0; },
    };
}

/**
 * An offscreen drawing layer of CSS size w×h at `dpr`, already scaled so callers draw in CSS px.
 * Uses a DOM canvas (patterns, drawImage and toDataURL all work on it everywhere).
 */
export function makeLayer(w, h, dpr = 1) {
    const canvas = typeof document !== 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    const layer = {
        canvas, ctx, w: 0, h: 0, dpr: 1,
        resize(nw, nh, ndpr = layer.dpr) {
            layer.w = nw; layer.h = nh; layer.dpr = ndpr;
            canvas.width = Math.max(1, Math.round(nw * ndpr));
            canvas.height = Math.max(1, Math.round(nh * ndpr));
            ctx.setTransform(ndpr, 0, 0, ndpr, 0, 0);
            return layer;
        },
        clear() { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); },
        dispose() { canvas.width = canvas.height = 1; },
    };
    return layer.resize(w, h, dpr);
}
