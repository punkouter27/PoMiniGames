// connectfive/extras.js — the second Connect Five feel layer, beside fx.js.
//
// fx.js owns the landing bump/dust/click, the win sweep + confetti + brass and the optional 3D
// board. This module adds what it does not, in the same style: a DOM observer over the live
// .cf-board (the .NET page owns the rules; nothing here can change the game) plus a WebGPU layer.
//
//   board light (WebGPU)   a falling disc lights the empty holes it passes and rims the discs
//                          beside it; a light ring runs out from each landing; a glass edge with
//                          a chromatic fringe and a highlight that follows the pointer; dust motes
//                          drifting in a soft beam tinted toward whoever is to move
//   held disc              a disc in hand above the board that follows the pointer on a spring;
//                          the physics drop (index.js) starts from it. On touch: drag along the
//                          board and let go to drop. While the CPU thinks, its disc scans the
//                          columns it is weighing (the hottest ones first)
//   last move              a ring on each side's most recent disc
//   big block              a disc that stops a five: the board swells while it falls, then a
//                          shockwave, a heavy bump, a low boom and a "Blocked" tag on landing
//   column notes           each landing also plays a quiet pentatonic note for its column,
//                          brighter the higher it lands (a spectral height cue on top of fx.js's pan)
//   drain                  when a finished board clears, its discs fall out of the bottom with a
//                          clatter instead of vanishing
//   turn baton             a glow that glides between the names in the turn strip
//   intro transition       the start card hands over to the board with a View Transition
//
// GATES: reduced motion → no held-disc spring, scan, motes, ring, drain or transition (the
// marker and notes stay); data-gfx="low" → no WebGPU layer and no drain; no WebGPU → the
// board light is simply absent; mute → no notes or boom. Every piece is best-effort.

import * as Dsp from '../platform/dsp.js';
import { springStep } from '../platform/springUi.js';

const COLS = 9;
const ROWS = 7;
const CELLS = ROWS * COLS;
const CSS_HREF = 'css/connectfive-extras.css';
/** C major pentatonic across the nine columns, C4 … G5. */
const NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// ─── Gates ───────────────────────────────────────────────────────────────
function motionReduced() {
    try {
        if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
}
function tier() {
    try { return document.documentElement.getAttribute('data-gfx') || 'high'; } catch { return 'high'; }
}
function muted() {
    try { return !!window.PoAudioBus?.isMuted?.(); } catch { return false; }
}
function finePointer() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; }
}
function pageMode() {
    const seg = location.pathname.split('/').filter(Boolean);
    const m = (seg[1] || '1p').toLowerCase();
    return m === 'demo' ? 'demo' : m === '2p' || m === 'two' ? '2p' : m === 'online' || m === 'multiplayer' ? 'online' : 'ai';
}

// ─── Board analysis (pure) ───────────────────────────────────────────────
/** Every 5-cell window on the 9×7 grid, as index lists. Built once. */
const WINDOWS = (() => {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            for (const [dr, dc] of DIRS) {
                const er = r + dr * 4;
                const ec = c + dc * 4;
                if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
                const w = [];
                for (let k = 0; k < 5; k++) w.push((r + dr * k) * COLS + (c + dc * k));
                out.push(w);
            }
        }
    }
    return out;
})();

/** Lowest empty row of each column (-1 when full). Row 6 is the bottom. */
function landingRows(state) {
    const out = new Int8Array(COLS).fill(-1);
    for (let c = 0; c < COLS; c++) {
        for (let r = ROWS - 1; r >= 0; r--) if (!state[r * COLS + c]) { out[c] = r; break; }
    }
    return out;
}

/**
 * Threat heat per empty cell for each side (0..1): the best window through that cell holding
 * only that side's discs, 2 → 0.2, 3 → 0.6, 4 → 1. Plus the board's worst threat per side.
 */
function analyse(state) {
    const heat = new Float32Array(CELLS * 2);
    let maxR = 0;
    let maxY = 0;
    for (const w of WINDOWS) {
        let r = 0;
        let y = 0;
        for (const i of w) { if (state[i] === 1) r++; else if (state[i] === 2) y++; }
        if ((r && y) || (r < 2 && y < 2)) continue;
        const n = r || y;
        const side = r ? 0 : 1;
        const v = n >= 4 ? 1 : n === 3 ? 0.6 : 0.2;
        if (side === 0) maxR = Math.max(maxR, n); else maxY = Math.max(maxY, n);
        for (const i of w) if (!state[i] && heat[i * 2 + side] < v) heat[i * 2 + side] = v;
    }
    return { heat, maxR, maxY };
}

/** Did `color` (1|2) at `idx` take away a cell the other side needed for five? */
function isBlock(before, idx, color) {
    const opp = color === 1 ? 2 : 1;
    for (const w of WINDOWS) {
        if (!w.includes(idx)) continue;
        let o = 0;
        let mine = 0;
        for (const i of w) { if (before[i] === opp) o++; else if (before[i] === color) mine++; }
        if (o === 4 && mine === 0) return true;
    }
    return false;
}

// ─── Module state ────────────────────────────────────────────────────────
let _started = false;
let _board = null;
let _rootObs = null;
let _boardObs = null;
let _scanRaf = 0;
let _syncRaf = 0;
let _loopRaf = 0;
let _prev = new Uint8Array(CELLS);
let _analysis = analyse(_prev);
const _last = { 1: -1, 2: -1 };
/** Cell index → true: a block that lands later. */
const _blocks = new Map();
/** The disc in flight, for the board light: { idx, color, since }. */
let _fall = null;
/** Last landing, for the light ring: { x, y, at, strength, color } in viewport px. */
let _flash = null;
let _pointer = null;            // viewport px of the pointer over the board, or null
const _timers = new Set();

function later(fn, ms) {
    const id = setTimeout(() => { _timers.delete(id); fn(); }, ms);
    _timers.add(id);
    return id;
}

function ensureCss() {
    if (document.querySelector('link[data-cf-extras-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL(CSS_HREF, document.baseURI).href;
    l.dataset.cfExtrasCss = '1';
    document.head.appendChild(l);
}

// ─── Reading the DOM board ───────────────────────────────────────────────
function cellEls() { return _board ? _board.querySelectorAll('.cf-cell') : []; }

function readState() {
    const cells = cellEls();
    const state = new Uint8Array(CELLS);
    let ghost = null;
    if (cells.length < CELLS) return { state, cells, ghost, ok: false };
    for (let i = 0; i < CELLS; i++) {
        const p = cells[i].firstElementChild;
        if (!p || !p.classList.contains('piece')) continue;
        const v = p.classList.contains('yellow-piece') ? 2 : p.classList.contains('red-piece') ? 1 : 0;
        if (p.classList.contains('ghost-piece')) ghost = { col: i % COLS, color: v === 2 ? 2 : 1 };
        else state[i] = v;
    }
    return { state, cells, ghost, ok: true };
}

/** Grid geometry in viewport px, measured off the live cells (the ground truth at any size). */
function geometry() {
    const cells = cellEls();
    if (cells.length < CELLS) return null;
    const c0 = cells[0].getBoundingClientRect();
    const c1 = cells[1].getBoundingClientRect();
    const c9 = cells[9].getBoundingClientRect();
    const b = _board.getBoundingClientRect();
    return {
        board: b,
        size: c0.width,
        x0: c0.left + c0.width / 2,
        y0: c0.top + c0.height / 2,
        sx: (c1.left - c0.left) || c0.width,
        sy: (c9.top - c0.top) || c0.height,
    };
}
function colX(g, col) { return g.x0 + col * g.sx; }
function cellXY(g, idx) { return { x: g.x0 + (idx % COLS) * g.sx, y: g.y0 + ((idx / COLS) | 0) * g.sy }; }

/** Whose move the turn strip shows: 1 red (left), 2 yellow (right), 0 nobody. */
function activeSide() {
    const a = document.querySelector('.cf-status-slot .turn-strip__side--active');
    if (!a) return 0;
    return a.classList.contains('turn-strip__side--right') ? 2 : 1;
}
function cpuThinking() {
    const t = document.querySelector('.cf-status-text');
    return pageMode() === 'ai' && !!t && /thinking/i.test(t.textContent || '');
}
function boardIs3d() { return !!_board?.classList.contains('cf-board--3d'); }
/** A human may drop now: the board takes input and nobody is thinking. */
function humanTurn() {
    if (!_board || pageMode() === 'demo' || boardIs3d()) return false;
    if (_board.tabIndex < 0 || cpuThinking()) return false;
    if (cellEls()[0]?.classList.contains('disabled')) return false;
    if (activeSide() === 0) return false;
    // Online: only on our own turn (OnlineTurnSession.StatusText reads exactly "Your turn").
    if (pageMode() === 'online') return /^\s*your turn/i.test(document.querySelector('.cf-status-text')?.textContent || '');
    return true;
}

// ─── Scan: what changed ──────────────────────────────────────────────────
function scheduleScan() {
    if (_scanRaf) return;
    _scanRaf = requestAnimationFrame(() => { _scanRaf = 0; scan(); });
}

function scan() {
    if (!_started || !_board) return;
    const snap = readState();
    if (!snap.ok) return;
    const { state } = snap;
    let added = 0;
    let removed = 0;
    let filled = 0;
    let prevFilled = 0;
    for (let i = 0; i < CELLS; i++) {
        if (state[i]) filled++;
        if (_prev[i]) prevFilled++;
        if (!_prev[i] && state[i]) added++;
        else if (_prev[i] && !state[i]) removed++;
    }

    if (removed > 0) {
        if (filled === 0 && prevFilled >= 4) drain(_prev);
        _last[1] = -1; _last[2] = -1;
        _blocks.clear();
        _fall = null;
    }
    if (added > 0 && added <= 2 && removed === 0) {
        for (let i = 0; i < CELLS; i++) {
            if (_prev[i] || !state[i]) continue;
            const color = state[i];
            _last[color] = i;
            _fall = { idx: i, color, since: performance.now() };
            if (isBlock(_prev, i, color)) {
                _blocks.set(i, true);
                if (!motionReduced()) {
                    _board.classList.add('cf-anticipate');
                    later(() => _board?.classList.remove('cf-anticipate'), 900);
                }
            }
            held.onDrop(i % COLS);
        }
    }
    _prev = state;
    _analysis = analyse(state);
    paintLast(snap.cells);
    gpu.upload();
}

function paintLast(cells = cellEls()) {
    for (let i = 0; i < cells.length; i++) {
        // A disc still in the air has no ring yet: its cell is empty-looking until it lands.
        const flying = _fall && _fall.idx === i;
        const want = flying ? null : i === _last[1] ? 'red' : i === _last[2] ? 'yellow' : null;
        const has = cells[i].getAttribute('data-cf-last');
        if (want !== has) {
            if (want) cells[i].setAttribute('data-cf-last', want);
            else cells[i].removeAttribute('data-cf-last');
        }
    }
}

// ─── Landing: notes, block hit, light ring ───────────────────────────────
function onLanded(e) {
    const d = e?.detail;
    if (!_started || !d || !_board) return;
    const idx = d.row * COLS + d.col;
    const g = geometry();
    const p = g ? cellXY(g, idx) : null;
    if (_fall?.idx === idx) { _fall = null; paintLast(); }
    if (p) _flash = { x: p.x, y: p.y, at: performance.now(), strength: 0.5 + 0.5 * (d.fall ?? 0.5), color: d.color === 'yellow' ? 2 : 1 };
    if (!d.silent && !muted()) columnNote(d.col, d.row);
    if (_blocks.has(idx)) {
        _blocks.delete(idx);
        bigBlock(p, d.color === 'yellow' ? 2 : 1);
    }
}

/** Quiet pentatonic note for the column; the higher the landing, the brighter (a height cue). */
function columnNote(col, row) {
    const height = 1 - row / (ROWS - 1);          // 0 bottom … 1 top
    const f = NOTES[col] || 440;
    const pan = Math.max(-1, Math.min(1, ((col - 4) / 4) * 0.8));
    try {
        Dsp.playAll([
            { wave: 'triangle', freq: f, dur: 0.55, gain: 0.03, attack: 0.004, decay: 0.5, cutoff: 900 + 3200 * height, pan },
            { wave: 'sine', freq: f * 2, dur: 0.35, gain: 0.012 + 0.012 * height, attack: 0.004, decay: 0.3, pan, delay: 0.005 },
        ], 'sfx');
    } catch { /* best-effort */ }
}

function bigBlock(p, color) {
    if (!motionReduced()) {
        try { if (p) window.PoImpact?.shockwave?.(p.x, p.y, 1.1); } catch { /* best-effort */ }
        try { window.PoImpact?.addTrauma?.(0.55); } catch { /* best-effort */ }
        try { window.PoImpact?.hitstop?.(90); } catch { /* best-effort */ }
    }
    if (!muted()) {
        try {
            Dsp.playAll([
                { wave: 'sine', freq: 92, freqEnd: 46, sweep: 0.35, dur: 0.5, gain: 0.16, attack: 0.003, decay: 0.45 },
                { wave: 'noise', freq: 0, dur: 0.18, gain: 0.06, attack: 0.002, decay: 0.16, cutoff: 900, cutoffEnd: 200, q: 0.8 },
                { wave: 'modal', freq: 196, dur: 0.6, gain: 0.07, material: 'ceramic', damping: 1.2, delay: 0.01 },
            ], 'sfx');
        } catch { /* best-effort */ }
    }
    try { if (pageMode() !== 'demo') window.PoImpact?.vibrate?.([30, 40, 30], { pad: false }); } catch { /* best-effort */ }
    if (p) {
        const tag = document.createElement('div');
        tag.className = `cf-x-tag cf-x-tag--${color === 2 ? 'yellow' : 'red'}`;
        tag.textContent = 'Blocked!';
        tag.setAttribute('aria-hidden', 'true');
        tag.style.left = `${p.x}px`;
        tag.style.top = `${p.y}px`;
        document.body.appendChild(tag);
        later(() => tag.remove(), 1300);
    }
}

// ─── Drain: a cleared board's discs fall out of the bottom ───────────────
function drain(before) {
    if (motionReduced() || tier() === 'low' || boardIs3d()) return;
    const g = geometry();
    if (!g) return;
    const discs = [];
    const size = g.size * 0.84;
    for (let i = 0; i < CELLS; i++) {
        if (!before[i]) continue;
        const { x, y } = cellXY(g, i);
        const row = (i / COLS) | 0;
        const el = document.createElement('div');
        el.className = `cf-physics-clone cf-x-drain ${before[i] === 2 ? 'yellow-piece' : 'red-piece'}`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
        discs.push({
            el, x: x - size / 2, y: y - size / 2, vx: (Math.random() - 0.5) * 90, vy: 0, rot: 0,
            spin: (Math.random() - 0.5) * 300,
            // The bottom row lets go first, each row above a beat later, so the columns fall as stacks.
            at: (ROWS - 1 - row) * 45 + (i % COLS) * 10,
        });
    }
    if (!discs.length) return;
    const t0 = performance.now();
    let last = t0;
    const floor = window.innerHeight + 80;
    const step = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        let alive = 0;
        for (const d of discs) {
            if (!d.el) continue;
            if (now - t0 >= d.at) {
                d.vy += 2600 * dt;
                d.x += d.vx * dt;
                d.y += d.vy * dt;
                d.rot += d.spin * dt;
            }
            d.el.style.transform = `translate3d(${d.x}px, ${d.y}px, 0) rotate(${d.rot}deg)`;
            if (d.y > floor || now - t0 > 3000) { d.el.remove(); d.el = null; } else alive++;
        }
        if (alive && _started) requestAnimationFrame(step);
        else for (const d of discs) d.el?.remove();
    };
    requestAnimationFrame(step);
    if (!muted()) {
        // A clatter: a handful of small ceramic knocks as the stacks let go.
        const voices = [];
        const n = Math.min(10, 3 + Math.round(discs.length / 4));
        for (let k = 0; k < n; k++) {
            voices.push({
                wave: 'modal', freq: 600 + Math.random() * 900, dur: 0.25, gain: 0.03 + Math.random() * 0.025,
                material: 'ceramic', damping: 2.2, delay: 0.05 + k * 0.07 + Math.random() * 0.05, pan: (Math.random() - 0.5) * 1.2,
            });
        }
        try { Dsp.playAll(voices, 'sfx'); } catch { /* best-effort */ }
    }
}

// ─── Held disc, touch drag, CPU scan ─────────────────────────────────────
const held = (() => {
    let el = null;
    let mode = 'off';         // 'off' | 'hover' | 'drag' | 'cpu'
    let color = 1;
    const sx = { x: 0, v: 0 };
    let targetX = 0;
    let visibleAt = 0;
    let lastPos = null;       // { x, y, col, at }
    let drag = null;          // { id, x0, moved }
    let swallowUntil = 0;
    let scan = null;          // { cols, i, until }

    function ensure() {
        if (el) return el;
        el = document.createElement('div');
        el.className = 'cf-physics-clone cf-x-held red-piece';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
        return el;
    }
    function show(m, c, x) {
        const wasOff = mode === 'off';
        mode = m;
        if (c !== color || wasOff) {
            color = c;
            ensure().classList.toggle('yellow-piece', c === 2);
            el.classList.toggle('red-piece', c !== 2);
        }
        if (wasOff) { sx.x = x; sx.v = 0; visibleAt = performance.now(); }
        targetX = x;
        ensure().classList.add('cf-x-held--on');
    }
    function hide() {
        mode = 'off';
        scan = null;
        el?.classList.remove('cf-x-held--on');
    }
    function colFromX(g, x) {
        return Math.max(0, Math.min(COLS - 1, Math.round((x - g.x0) / g.sx)));
    }

    function frame(dt, g) {
        if (!_board || !g) { hide(); return; }
        const reduce = motionReduced();
        // Who holds the disc this frame.
        if (mode !== 'drag') {
            if (cpuThinking() && !reduce && !boardIs3d()) {
                if (mode !== 'cpu') { show('cpu', 2, colX(g, 4)); scan = null; }
                runScan(g);
            } else if (mode === 'cpu') {
                hide();
            } else if (_pointer && finePointer() && humanTurn() && !reduce) {
                const side = activeSide() || 1;
                const snapX = colX(g, colFromX(g, _pointer.x));
                // Mostly the pointer, a little pull toward the column it will land in.
                show('hover', side, _pointer.x * 0.55 + snapX * 0.45);
            } else if (mode === 'hover') {
                hide();
            }
        }
        if (mode === 'off' || !el) return;
        const minX = colX(g, 0);
        const maxX = colX(g, COLS - 1);
        const tx = Math.max(minX, Math.min(maxX, targetX));
        if (reduce) { sx.x = tx; sx.v = 0; } else springStep(sx, tx, dt);
        // Parked in the gap between the turn strip and the board (connectfive-extras.css widens it
        // on desktop), sized to fit it, so the disc in hand never covers the strip's text.
        const strip = document.querySelector('.cf-status-slot');
        const sb = strip ? strip.getBoundingClientRect().bottom : g.board.top - g.sy;
        const gap = Math.max(0, g.board.top - sb);
        const size = Math.max(g.size * 0.5, Math.min(g.size * 0.84, gap - 6));
        const y = gap >= size ? sb + gap / 2 : g.board.top - size * 0.35;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        const tilt = Math.max(-14, Math.min(14, sx.v * 0.02));
        el.style.transform = `translate3d(${sx.x - size / 2}px, ${y - size / 2}px, 0) rotate(${tilt}deg)`;
        lastPos = { x: sx.x, y, col: colFromX(g, sx.x), at: performance.now() };
    }

    function runScan(g) {
        const now = performance.now();
        if (!scan) {
            // The columns the CPU is most likely weighing: hottest landing cells first, then the centre.
            const rows = landingRows(_prev);
            const scored = [];
            for (let c = 0; c < COLS; c++) {
                if (rows[c] < 0) continue;
                const i = rows[c] * COLS + c;
                const h = _analysis.heat[i * 2] + _analysis.heat[i * 2 + 1];
                scored.push({ c, s: h + (4 - Math.abs(c - 4)) * 0.06 + Math.random() * 0.25 });
            }
            scored.sort((a, b) => b.s - a.s);
            scan = { cols: scored.slice(0, 4).map((o) => o.c), i: 0, until: now + 160 };
            if (scan.cols.length) targetX = colX(g, scan.cols[0]);
            return;
        }
        if (now >= scan.until && scan.cols.length) {
            scan.i = (scan.i + 1) % scan.cols.length;
            scan.until = now + 150 + Math.random() * 120;
            targetX = colX(g, scan.cols[scan.i]);
        }
    }

    /** A disc was just added in `col`: the one in hand becomes it. */
    function onDrop() { if (mode !== 'drag') hide(); }

    // Touch / pen: drag across the board, let go to drop.
    function onDown(e) {
        if (e.pointerType === 'mouse' || !humanTurn() || motionReduced()) return;
        drag = { id: e.pointerId, x0: e.clientX, moved: false };
        const g = geometry();
        if (g) show('drag', activeSide() || 1, e.clientX);
    }
    function onMove(e) {
        if (e.pointerType === 'mouse') {
            _pointer = { x: e.clientX, y: e.clientY };
            return;
        }
        if (!drag || e.pointerId !== drag.id) return;
        if (Math.abs(e.clientX - drag.x0) > 12) drag.moved = true;
        targetX = e.clientX;
    }
    function onUp(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        const g = geometry();
        if (d.moved && g && humanTurn()) {
            const col = colFromX(g, targetX);
            // The native click after a drag would land on whatever cell is under the finger;
            // drop through the column the disc is over instead, and swallow that click.
            swallowUntil = performance.now() + 450;
            const cell = cellEls()[col];
            mode = 'hover';           // keep the disc visible for take() until the drop starts
            try { cell?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch { /* best-effort */ }
            later(() => { if (mode === 'hover' && !finePointer()) hide(); }, 250);
        } else {
            hide();
        }
    }
    function onCancel() { drag = null; if (mode === 'drag') hide(); }
    function onClickCapture(e) {
        if (performance.now() < swallowUntil && e.isTrusted) { e.stopPropagation(); e.preventDefault(); swallowUntil = 0; }
    }
    function onLeave(e) { if (e.pointerType === 'mouse') _pointer = null; }

    return {
        frame, onDrop, hide,
        bind(board) {
            board.addEventListener('pointerdown', onDown);
            board.addEventListener('pointermove', onMove);
            board.addEventListener('pointerup', onUp);
            board.addEventListener('pointercancel', onCancel);
            board.addEventListener('pointerleave', onLeave);
            board.addEventListener('click', onClickCapture, true);
        },
        unbind(board) {
            board.removeEventListener('pointerdown', onDown);
            board.removeEventListener('pointermove', onMove);
            board.removeEventListener('pointerup', onUp);
            board.removeEventListener('pointercancel', onCancel);
            board.removeEventListener('pointerleave', onLeave);
            board.removeEventListener('click', onClickCapture, true);
            drag = null;
        },
        dispose() { hide(); el?.remove(); el = null; },
        /** index.js: where the disc in hand is, when it is over `col` and was shown just now. */
        take(col) {
            if (!lastPos || performance.now() - lastPos.at > 250) return null;
            if (mode === 'off' && performance.now() - lastPos.at > 120) return null;
            if (lastPos.col !== col || performance.now() - visibleAt < 60) return null;
            return { x: lastPos.x, y: lastPos.y };
        },
    };
})();

// ─── Turn baton ──────────────────────────────────────────────────────────
const baton = (() => {
    let el = null;
    const s = { x: { x: 0, v: 0 }, w: { x: 0, v: 0 } };
    let shown = false;
    return {
        frame(dt) {
            const a = _board ? document.querySelector('.cf-status-slot .turn-strip__side--active') : null;
            if (!a) { if (el) el.classList.remove('cf-x-baton--on'); shown = false; return; }
            if (!el) {
                el = document.createElement('div');
                el.className = 'cf-x-baton';
                el.setAttribute('aria-hidden', 'true');
                document.body.appendChild(el);
            }
            // Hug the colour mark and the name, not the whole (flex-grown) side.
            const parts = [...a.querySelectorAll('.turn-strip__mark, .turn-strip__name')].map((n) => n.getBoundingClientRect());
            const rs = parts.length ? parts : [a.getBoundingClientRect()];
            const left = Math.min(...rs.map((q) => q.left));
            const right = Math.max(...rs.map((q) => q.right));
            const top = Math.min(...rs.map((q) => q.top));
            const bottom = Math.max(...rs.map((q) => q.bottom));
            const r = { left, top, width: right - left, height: bottom - top };
            const side = a.classList.contains('turn-strip__side--right') ? 2 : 1;
            el.classList.toggle('cf-x-baton--yellow', side === 2);
            if (!shown || motionReduced()) { s.x.x = r.left; s.x.v = 0; s.w.x = r.width; s.w.v = 0; }
            else {
                springStep(s.x, r.left, dt, { stiffness: 180, damping: 22 });
                springStep(s.w, r.width, dt, { stiffness: 180, damping: 22 });
            }
            shown = true;
            el.classList.add('cf-x-baton--on');
            el.style.transform = `translate3d(${s.x.x - 10}px, ${r.top - 5}px, 0)`;
            el.style.width = `${Math.max(0, s.w.x + 20)}px`;
            el.style.height = `${r.height + 10}px`;
        },
        dispose() { el?.remove(); el = null; shown = false; },
    };
})();

// ─── WebGPU board light ──────────────────────────────────────────────────
const SHADER = /* wgsl */ `
struct U { v: array<vec4f, 10> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> cells: array<vec4f, 63>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn hash4(p: vec2f) -> vec4f {
  var q = fract(vec4f(p.xyxy) * vec4f(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}
fn band(x: f32, c: f32, w: f32) -> f32 { let d = (x - c) / w; return exp(-d * d); }

@fragment fn fs(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let p = fp.xy;
  let t = u.v[0].z;
  let dpr = u.v[0].w;
  let o = u.v[1].xy;
  let st = u.v[1].zw;
  let cs = u.v[2].x;
  let turn = u.v[2].y;
  let motes = u.v[2].w;
  let red = u.v[8].xyz;
  let yel = u.v[9].xyz;
  let bmin = u.v[6].xy;
  let bmax = u.v[6].zw;
  let rad = u.v[7].x;

  // Board rounded-rect SDF (negative inside).
  let cen = (bmin + bmax) * 0.5;
  let hs = (bmax - bmin) * 0.5;
  let q = abs(p - cen) - hs + rad;
  let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
  if (sd > 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let e = -sd;

  var col = vec3f(0.0);

  // Nearest cell.
  let g = (p - o) / st;
  let ci = clamp(round(g), vec2f(0.0), vec2f(8.0, 6.0));
  let c = o + ci * st;
  let dv = p - c;
  let d = length(dv);
  let r = cs * 0.5;
  let inCell = select(0.0, 1.0, abs(g.x - ci.x) <= 0.5 && abs(g.y - ci.y) <= 0.5);
  let idx = u32(ci.y) * 9u + u32(ci.x);
  let cell = cells[idx];
  let empty = cell.x < 0.5;
  let hole = (1.0 - smoothstep(r * 0.80, r * 0.95, d)) * inCell;
  let surface = 1.0 - hole;

  // Falling disc: lights the empty holes near it and rims the discs it passes.
  let fall = u.v[3];
  if (fall.w > 0.5) {
    let fc = select(red, yel, fall.z > 1.5);
    let fd = length(p - fall.xy) / st.x;
    let L = 1.0 / (1.0 + fd * fd * 1.8);
    if (empty) {
      col += fc * L * hole * 0.55;
    } else {
      let ring = smoothstep(r * 0.6, r * 0.8, d) * (1.0 - smoothstep(r * 0.8, r * 0.88, d));
      let facing = max(0.0, dot(normalize(dv + vec2f(1e-4)), normalize(fall.xy - c + vec2f(1e-4))));
      col += fc * L * ring * facing * 0.8 * inCell;
    }
    col += fc * L * surface * 0.06;
  }

  // Landing ring.
  let fl = u.v[5];
  let fcol = select(red, yel, u.v[7].z > 1.5);
  if (fl.z < 0.7 && u.v[7].y < 0.5) {
    let age = fl.z;
    let rr = age * st.x * 6.0;
    let w = st.x * 0.35;
    let ringv = band(length(p - fl.xy), rr, w) * (1.0 - age / 0.7) * fl.w;
    col += mix(vec3f(1.0), fcol, 0.6) * ringv * 0.22;
  }

  // Glass edge: a thin chromatic fringe inside the rim, a soft inner glow, and a highlight
  // on the stretch of rim facing the pointer.
  let fw = 0.9 * dpr;
  col += vec3f(band(e, 1.4 * dpr, fw), band(e, 2.5 * dpr, fw), band(e, 3.6 * dpr, fw)) * 0.18;
  col += vec3f(0.6, 0.75, 1.0) * exp(-e / (9.0 * dpr)) * 0.035;
  let ptr = u.v[4];
  if (ptr.z > 0.5) {
    let n = normalize(p - cen + vec2f(1e-4));
    let lv = normalize(ptr.xy - cen + vec2f(1e-4));
    let spec = pow(max(dot(n, lv), 0.0), 10.0) * exp(-e / (5.0 * dpr));
    col += vec3f(1.0) * spec * 0.35;
  }

  // Dust motes in a soft beam from above, tinted toward whoever is to move.
  if (motes > 0.5) {
    let tint = select(select(vec3f(1.0), red, turn > 0.5 && turn < 1.5), yel, turn > 1.5);
    let lightc = mix(vec3f(1.0, 0.97, 0.9), tint, 0.35);
    let vy = (p.y - bmin.y) / max(1.0, bmax.y - bmin.y);
    let spread = hs.x * (0.35 + 0.75 * vy);
    let beam = smoothstep(1.0, 0.0, abs(p.x - cen.x) / spread) * (1.0 - 0.4 * vy);
    col += lightc * beam * 0.03;
    let gs = 44.0 * dpr;
    let qp = p + vec2f(sin(t * 0.13) * 20.0 * dpr, t * 7.0 * dpr);
    let id = floor(qp / gs);
    var m = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let cid = id + vec2f(f32(i), f32(j));
        let h = hash4(cid);
        let mc = (cid + 0.15 + 0.7 * h.xy) * gs + vec2f(sin(t * 0.6 + h.z * 6.3), cos(t * 0.5 + h.w * 6.3)) * 5.0 * dpr;
        let sz = (0.7 + 1.5 * h.w) * dpr;
        let tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (0.8 + h.z) + h.w * 30.0), 2.0);
        m += smoothstep(sz, 0.0, length(qp - mc)) * tw * step(0.45, h.z);
      }
    }
    col += lightc * m * beam * 0.55;
  }

  // Additive: the canvas is mix-blend-mode: plus-lighter, so black adds nothing.
  return vec4f(min(col, vec3f(1.0)), 1.0);
}`;

const gpu = (() => {
    let canvas = null;
    let device = null;
    let ctx = null;
    let pipeline = null;
    let bind = null;
    let ubuf = null;
    let cbuf = null;
    let failed = false;
    let booting = null;
    const u = new Float32Array(40);
    const cellData = new Float32Array(CELLS * 4);
    let dirty = true;

    function wanted() {
        return !failed && !!navigator.gpu && tier() !== 'low' && !!_board && !boardIs3d();
    }

    async function boot() {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('no adapter');
            device = await adapter.requestDevice();
            device.lost.then(() => { device = null; teardown(); });
            canvas = document.createElement('canvas');
            canvas.className = 'cf-x-light';
            canvas.setAttribute('aria-hidden', 'true');
            document.body.appendChild(canvas);
            ctx = canvas.getContext('webgpu');
            const format = navigator.gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: 'opaque' });
            const module = device.createShaderModule({ code: SHADER });
            pipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            ubuf = device.createBuffer({ size: u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            cbuf = device.createBuffer({ size: cellData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            bind = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: cbuf } }],
            });
            dirty = true;
        } catch (err) {
            failed = true;
            console.warn('PoConnectFive extras: board light unavailable:', err?.message || err);
            teardown();
        }
    }

    function teardown() {
        canvas?.remove();
        canvas = null;
        ctx = null;
        pipeline = null;
        bind = null;
        try { ubuf?.destroy(); cbuf?.destroy(); } catch { /* gone */ }
        ubuf = null;
        cbuf = null;
        try { device?.destroy(); } catch { /* gone */ }
        device = null;
        booting = null;
    }

    function upload() { dirty = true; }

    function writeCells() {
        const rows = landingRows(_prev);
        const h = _analysis.heat;
        for (let i = 0; i < CELLS; i++) {
            const c = i % COLS;
            const r = (i / COLS) | 0;
            cellData[i * 4] = _prev[i];
            cellData[i * 4 + 1] = h[i * 2];
            cellData[i * 4 + 2] = h[i * 2 + 1];
            cellData[i * 4 + 3] = rows[c] === r ? 1 : 0;
        }
        device.queue.writeBuffer(cbuf, 0, cellData);
        dirty = false;
    }

    function frame(g, now) {
        if (!wanted() || !g) { if (canvas) canvas.style.display = 'none'; return; }
        if (!device) { if (!booting && !failed) booting = boot(); return; }
        if (!canvas || !pipeline) return;
        const b = g.board;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(b.width * dpr));
        const h = Math.max(1, Math.round(b.height * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        canvas.style.display = '';
        canvas.style.transform = `translate3d(${b.left}px, ${b.top}px, 0)`;
        canvas.style.width = `${b.width}px`;
        canvas.style.height = `${b.height}px`;
        // Never paint over the sticky header when the board scrolls under it.
        const head = document.querySelector('.po-header');
        const hb = head ? head.getBoundingClientRect().bottom : 0;
        canvas.style.clipPath = b.top < hb ? `inset(${hb - b.top}px 0 0 0)` : '';

        const px = (x) => (x - b.left) * dpr;
        const py = (y) => (y - b.top) * dpr;
        const reduce = motionReduced();
        u[0] = w; u[1] = h; u[2] = (now / 1000) % 3600; u[3] = dpr;
        u[4] = px(g.x0); u[5] = py(g.y0); u[6] = g.sx * dpr; u[7] = g.sy * dpr;
        u[8] = g.size * dpr; u[9] = activeSide(); u[10] = 0; u[11] = !reduce && tier() === 'high' ? 1 : 0;
        // The disc in flight: the physics clone, else the cell's own (keyframe-dropping) disc.
        u[12] = 0; u[13] = 0; u[14] = 0; u[15] = 0;
        if (_fall && now - _fall.since < 1100) {
            const clone = document.querySelector('.cf-physics-clone:not(.cf-x-held):not(.cf-x-drain)');
            const src = clone || cellEls()[_fall.idx]?.querySelector('.piece');
            if (src) {
                const r = src.getBoundingClientRect();
                if (r.width > 0 && getComputedStyle(src).visibility !== 'hidden') {
                    u[12] = px(r.left + r.width / 2); u[13] = py(r.top + r.height / 2); u[14] = _fall.color; u[15] = 1;
                }
            }
        }
        if (_pointer && finePointer()) { u[16] = px(_pointer.x); u[17] = py(_pointer.y); u[18] = 1; } else { u[18] = 0; }
        if (_flash) {
            u[20] = px(_flash.x); u[21] = py(_flash.y); u[22] = (now - _flash.at) / 1000; u[23] = _flash.strength;
            if (u[22] > 1) _flash = null;
        } else { u[22] = 9; }
        u[24] = 0; u[25] = 0; u[26] = w; u[27] = h;
        let radius = 12;
        try { radius = parseFloat(getComputedStyle(_board).borderTopLeftRadius) || 12; } catch { /* default */ }
        u[28] = radius * dpr; u[29] = reduce ? 1 : 0; u[30] = _flash?.color || 1;
        const red = discRgb('red');
        const yel = discRgb('yellow');
        u[32] = red[0]; u[33] = red[1]; u[34] = red[2];
        u[36] = yel[0]; u[37] = yel[1]; u[38] = yel[2];
        device.queue.writeBuffer(ubuf, 0, u);
        if (dirty) writeCells();

        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
    }

    return { frame, upload, dispose: teardown };
})();

const _rgb = new Map();
/** 0..1 rgb of a disc colour from the --disc-*-mid tokens (fx.js reads them the same way). */
function discRgb(color) {
    if (_rgb.has(color)) return _rgb.get(color);
    let out = color === 'yellow' ? [0.98, 0.8, 0.2] : [0.9, 0.22, 0.25];
    try {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        probe.style.color = `var(--disc-${color}-mid)`;
        document.body.appendChild(probe);
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
        probe.remove();
        if (m) {
            const p = m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map((v) => parseFloat(v) / 255);
            if (p.length === 3 && p.every(Number.isFinite)) out = p;
        }
    } catch { /* fallback */ }
    _rgb.set(color, out);
    return out;
}

// ─── The frame loop ──────────────────────────────────────────────────────
let _lastFrame = 0;
function loop(now) {
    _loopRaf = 0;
    if (!_started) return;
    const dt = _lastFrame ? Math.min(0.05, (now - _lastFrame) / 1000) : 1 / 60;
    _lastFrame = now;
    if (_board && !document.hidden) {
        const g = geometry();
        held.frame(dt, g);
        baton.frame(dt);
        try { gpu.frame(g, now); } catch (err) { console.warn('PoConnectFive extras: frame failed', err?.message || err); }
    }
    _loopRaf = requestAnimationFrame(loop);
}

// ─── Intro → board View Transition ───────────────────────────────────────
/**
 * Called by the page just before it closes the start card. Resolves once the browser has the
 * "before" snapshot, so the page can render; the transition then waits for the card to go.
 */
export function beginIntroTransition() {
    if (!document.startViewTransition || motionReduced()) return Promise.resolve(false);
    return new Promise((resolve) => {
        let vt;
        try {
            document.documentElement.classList.add('cf-vt');
            vt = document.startViewTransition(() => new Promise((done) => {
                resolve(true);
                // Timers, not rAF: rendering (and so rAF) is paused while the update callback runs.
                const t0 = performance.now();
                const poll = () => {
                    if (!document.querySelector('.gps-intro-overlay') || performance.now() - t0 > 700) done();
                    else setTimeout(poll, 16);
                };
                setTimeout(poll, 16);
            }));
            const clear = () => document.documentElement.classList.remove('cf-vt');
            vt.ready.catch(() => {});
            vt.updateCallbackDone.catch(() => {});
            vt.finished.then(clear, clear);
        } catch {
            document.documentElement.classList.remove('cf-vt');
            resolve(false);
        }
        // Never hold the page up if the browser stalls the update callback.
        setTimeout(() => resolve(false), 400);
    });
}

// ─── Attach / detach ─────────────────────────────────────────────────────
function attach(board) {
    _board = board;
    _prev = readState().state;
    _analysis = analyse(_prev);
    _last[1] = -1; _last[2] = -1;
    _boardObs = new MutationObserver(scheduleScan);
    _boardObs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    held.bind(board);
    gpu.upload();
}

function detach() {
    if (_boardObs) { _boardObs.disconnect(); _boardObs = null; }
    if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = 0; }
    if (_board) {
        held.unbind(_board);
        _board.classList.remove('cf-anticipate');
    }
    held.hide();
    _board = null;
    _fall = null;
    _flash = null;
    _pointer = null;
}

function syncBoard() {
    _syncRaf = 0;
    if (!_started) return;
    if (!location.pathname.toLowerCase().startsWith('/connectfive')) { stop(); return; }
    const b = document.querySelector('.cf-board');
    if (b === _board) return;
    detach();
    if (b) attach(b);
}

export function start() {
    if (_started) { syncBoard(); return true; }
    _started = true;
    ensureCss();
    window.addEventListener('po-cf-landed', onLanded);
    _rootObs = new MutationObserver(() => { if (!_syncRaf) _syncRaf = requestAnimationFrame(syncBoard); });
    _rootObs.observe(document.body, { childList: true, subtree: true });
    syncBoard();
    _lastFrame = 0;
    _loopRaf = requestAnimationFrame(loop);
    return true;
}

export function stop() {
    if (!_started) return;
    _started = false;
    window.removeEventListener('po-cf-landed', onLanded);
    if (_rootObs) { _rootObs.disconnect(); _rootObs = null; }
    if (_syncRaf) { cancelAnimationFrame(_syncRaf); _syncRaf = 0; }
    if (_loopRaf) { cancelAnimationFrame(_loopRaf); _loopRaf = 0; }
    for (const id of _timers) clearTimeout(id);
    _timers.clear();
    detach();
    held.dispose();
    baton.dispose();
    gpu.dispose();
    for (const el of document.querySelectorAll('.cf-x-tag, .cf-x-drain')) el.remove();
}

/** Debug and test hook: the live state, never used by the game. */
export function debug() {
    return {
        started: _started, board: !!_board, last: { ..._last }, blocksPending: _blocks.size,
        maxThreat: { red: _analysis.maxR, yellow: _analysis.maxY },
        light: !!document.querySelector('canvas.cf-x-light'),
    };
}

// Pure helpers for tests.
export const _test = { analyse, isBlock, landingRows, WINDOWS, drain, bigBlock };

window.PoConnectFiveHeld = { take: (col) => held.take(col) };
window.PoConnectFiveExtras = { start, stop, beginIntroTransition, debug };
