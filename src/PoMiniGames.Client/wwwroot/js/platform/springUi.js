// springUi.js — physics-based micro-interactions for opt-in controls (deck idea #17).
//
// Opt in from markup:
//   data-spring            spring press: the control sinks on press and overshoots
//                          back on release, carrying the pointer's release velocity.
//                          A fine pointer that drags while pressed rubber-bands the
//                          control a few px (velocity-aware drag) before it springs home.
//   data-spring="0.9"      custom pressed scale (default 0.95).
//   data-magnetic          the same press spring; the hover attraction itself is
//                          fxTilt.js's (it already pulls [data-magnetic] toward the
//                          pointer with `translate`), so this file never writes
//                          `translate` on a magnetic control and the two compose.
//   data-parallax="4"      on a CHILD of a [data-spring] control: the child drifts up
//                          to N px with the pointer while hovered (hover parallax).
//
// RULES
//   • Transform-only. It writes the independent `scale` and `translate` properties
//     (never `transform`, never size or margin), so nothing reflows and a 44 px
//     target stays a 44 px target.
//   • Coarse pointers (touch) get the press spring only: no hover, no drag, no
//     parallax — on touch those would only appear mid-tap and read as a glitch.
//   • Reduced motion (the OS, or <html data-motion="reduce">) makes all of it a
//     no-op: the control is pressed and released instantly by the browser.
//   • One rAF loop, running only while a spring is still moving. An idle page costs a
//     single delegated pointerdown/pointerover listener.
//
// DEFAULT ON (deck idea #17): the opt-in attribute is no longer required for the shared
// controls. uiTargets.js lists the classes (.app-btn, segmented buttons, bottom nav, catalog
// card heads and chips, intro tabs, Radzen buttons, buttons inside .gps-modal) that spring
// without markup; data-spring="off" opts a control out.
//
// Exposed as window.PoSpring and as ES exports (springStep is pure, for tests).

import { pressTarget } from './uiTargets.js';

/** Spring constants: snappy press, a little overshoot on release. */
export const SPRING = Object.freeze({ stiffness: 520, damping: 26 });

const PRESS_SCALE = 0.95;
const DRAG_MAX_PX = 6;          // rubber-band reach while pressed and dragged
const DRAG_RESIST = 0.35;       // fraction of the pointer travel the control follows
const REST_EPS = 0.0008;
const MAX_DT = 1 / 30;          // a dropped frame must not launch the spring

/**
 * One semi-implicit Euler step of a damped spring toward `target`. Pure.
 * @param {{x:number, v:number}} s position and velocity (mutated and returned)
 * @param {number} target
 * @param {number} dt seconds
 * @param {{stiffness:number, damping:number}} [k]
 */
export function springStep(s, target, dt, k = SPRING) {
    const h = Math.min(Math.max(0, dt), MAX_DT);
    const a = -k.stiffness * (s.x - target) - k.damping * s.v;
    s.v += a * h;
    s.x += s.v * h;
    return s;
}

/** True when a spring is close enough to rest to stop animating. Pure. */
export function atRest(s, target) {
    return Math.abs(s.x - target) < REST_EPS && Math.abs(s.v) < REST_EPS * 40;
}

/** Rubber-band a raw drag offset to a soft maximum (velocity-aware drag). Pure. */
export function rubberBand(dx, max = DRAG_MAX_PX, resist = DRAG_RESIST) {
    const d = dx * resist;
    return max * Math.tanh(d / max);
}

function motionReduced() {
    try {
        if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
}

function finePointer() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
}

// el → { s: scale spring, tx/ty: drag springs, target, pressed, magnetic, ... }
const _live = new Map();
let _raf = 0;
let _last = 0;

function stateFor(el) {
    let st = _live.get(el);
    if (!st) {
        const attr = parseFloat(el.getAttribute('data-spring'));  // '' / 'off' → NaN → default
        st = {
            s: { x: 1, v: 0 },
            tx: { x: 0, v: 0 },
            ty: { x: 0, v: 0 },
            pressScale: Number.isFinite(attr) && attr > 0.7 && attr < 1 ? attr : PRESS_SCALE,
            target: 1,
            dragX: 0,
            dragY: 0,
            pressed: false,
            magnetic: el.hasAttribute('data-magnetic'),
            startX: 0, startY: 0,
            lastX: 0, lastY: 0, lastT: 0, vx: 0, vy: 0,
        };
        _live.set(el, st);
    }
    return st;
}

function write(el, st) {
    el.style.scale = st.s.x.toFixed(4);
    if (!st.magnetic) {
        const x = st.tx.x, y = st.ty.x;
        el.style.translate = (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) ? '' : `${x.toFixed(2)}px ${y.toFixed(2)}px`;
    }
}

function settle(el) {
    el.style.scale = '';
    if (!_live.get(el)?.magnetic) el.style.translate = '';
    _live.delete(el);
}

function tick(now) {
    const dt = _last ? (now - _last) / 1000 : 1 / 60;
    _last = now;
    for (const [el, st] of _live) {
        if (!el.isConnected) { _live.delete(el); continue; }
        springStep(st.s, st.target, dt);
        springStep(st.tx, st.pressed ? st.dragX : 0, dt);
        springStep(st.ty, st.pressed ? st.dragY : 0, dt);
        if (!st.pressed && atRest(st.s, 1) && atRest(st.tx, 0) && atRest(st.ty, 0)) { settle(el); continue; }
        write(el, st);
    }
    if (_live.size) _raf = requestAnimationFrame(tick);
    else { _raf = 0; _last = 0; }
}

function kick() {
    if (!_raf) { _last = 0; _raf = requestAnimationFrame(tick); }
}

function controlFrom(target) {
    const el = pressTarget(target);
    if (!el || el.getAttribute('data-spring') === 'off') return null;
    return el;
}

function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const el = controlFrom(e.target);
    if (!el || motionReduced()) return;
    const st = stateFor(el);
    st.pressed = true;
    st.target = st.pressScale;
    st.startX = st.lastX = e.clientX;
    st.startY = st.lastY = e.clientY;
    st.lastT = e.timeStamp || performance.now();
    st.vx = st.vy = 0;
    st.dragX = st.dragY = 0;
    st.drag = finePointer() && !st.magnetic;
    _pressed = el;
    kick();
}

let _pressed = null;

function onMove(e) {
    if (!_pressed) return;
    const st = _live.get(_pressed);
    if (!st || !st.pressed || !st.drag) return;
    const t = e.timeStamp || performance.now();
    const dt = Math.max(1, t - st.lastT);
    // Pointer velocity in px/s, smoothed — handed to the spring on release.
    st.vx = st.vx * 0.6 + ((e.clientX - st.lastX) / dt) * 1000 * 0.4;
    st.vy = st.vy * 0.6 + ((e.clientY - st.lastY) / dt) * 1000 * 0.4;
    st.lastX = e.clientX; st.lastY = e.clientY; st.lastT = t;
    st.dragX = rubberBand(e.clientX - st.startX);
    st.dragY = rubberBand(e.clientY - st.startY);
}

function onUp() {
    const el = _pressed;
    _pressed = null;
    if (!el) return;
    const st = _live.get(el);
    if (!st) return;
    st.pressed = false;
    st.target = 1;
    // Overshoot: a release kick upward proportional to how deep the press went.
    st.s.v += (1 - st.s.x) * 9;
    // Velocity-aware: the drag springs home carrying a damped share of the flick.
    if (st.drag) {
        st.tx.v += Math.max(-400, Math.min(400, st.vx * 0.05));
        st.ty.v += Math.max(-400, Math.min(400, st.vy * 0.05));
    }
    kick();
}

// ── Hover parallax for [data-parallax] children (fine pointers only) ─────────
let _hover = null;
let _hoverRaf = 0;
let _hx = 0, _hy = 0;

function paintParallax() {
    _hoverRaf = 0;
    if (!_hover) return;
    for (const child of _hover.querySelectorAll('[data-parallax]')) {
        const depth = Math.min(12, parseFloat(child.getAttribute('data-parallax')) || 4);
        child.style.translate = `${(_hx * depth).toFixed(2)}px ${(_hy * depth).toFixed(2)}px`;
    }
}

function clearParallax(el) {
    if (!el) return;
    for (const child of el.querySelectorAll('[data-parallax]')) child.style.translate = '';
}

function onHoverMove(e) {
    if (!_hover) return;
    const r = _hover.getBoundingClientRect();
    if (!r.width || !r.height) return;
    _hx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    _hy = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    if (!_hoverRaf) _hoverRaf = requestAnimationFrame(paintParallax);
}

function onOver(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-spring]') : null;
    const host = el && el.querySelector('[data-parallax]') ? el : null;
    if (host === _hover) return;
    if (_hover) { window.removeEventListener('pointermove', onHoverMove); clearParallax(_hover); }
    _hover = null;
    if (!host || !finePointer() || motionReduced()) return;
    _hover = host;
    window.addEventListener('pointermove', onHoverMove, { passive: true });
}

function onOut(e) {
    if (!_hover) return;
    if (e.relatedTarget && _hover.contains(e.relatedTarget)) return;
    window.removeEventListener('pointermove', onHoverMove);
    clearParallax(_hover);
    _hover = null;
}

/** Drop every in-flight spring (navigation, tests). */
export function reset() {
    for (const el of _live.keys()) settle(el);
    _live.clear();
    _pressed = null;
    if (_hover) clearParallax(_hover);
    _hover = null;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    window.addEventListener('pagehide', reset);
    window.PoSpring = { springStep, atRest, rubberBand, reset, SPRING };
}
