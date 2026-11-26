// connectfive/fx.js — landing feel, win celebration and the optional 3D board, as a DOM observer.
//
// WHY AN OBSERVER AND NOT CALLS FROM THE PAGE
// ConnectFivePage.razor owns the rules and the board model; this module owns how the board FEELS.
// It watches the live .cf-board (the DOM board stays the source of truth for input, game state,
// keyboard play and the aria grid) and reacts to what it sees:
//
//   a disc appears in a cell      -> landing feel (sound, bump, dust, haptic) once it has landed
//   po-cf-drop-landed             -> the same, exact, when the matter.js drop in index.js finished
//   .win-cell / .win-cell-static  -> win celebration (sweep + bloom along the line, confetti,
//                                    crowd + brass; a softer variant when the CPU wins)
//   63 discs and no win           -> a neutral chime
//
// Nothing here is a new engine. It composes the shared platform layers:
//   impactBus (PoImpact)  trauma shake of the registered board, phone haptics (one gate)
//   gameCues  (PoCue)     the connectfive 'land' cue, pitched and panned per drop
//   gpuFx     (PoFx)      the shared GPU particle layer: dust, sparks, confetti, in the disc's colour
//   dsp.js                the AudioWorklet voices for the crowd and the brass sting
//   audioBus              mute and volume (dsp and the cues already stop at mute; read here to skip work)
//   stage + renderer      board3d.js builds the optional 3D board on the shared 3D stage
//
// GATES: reduced motion (data-motion or the OS setting) skips the bump, dust and sweep motion;
// data-gfx="low" skips dust, sparks and the 3D board; mute skips every sound and every haptic.
//
// Lifecycle: start() is called by index.js init() (and by the page when matter.js is blocked) and
// stop() by reset()/Dispose. stop() undoes every observer, timer, overlay and the 3D stage.

import * as Dsp from '../platform/dsp.js';

const BOARD_KEY = 'pominigames:connectfive:board';   // '2d' | '3d'
const CSS_HREF = 'css/connectfive-fx.css';
const ROWS = 7;
const COLS = 9;
const CELLS = ROWS * COLS;
/** Where the CSS keyframe drop (cf-slide-down, 0.55 s) reaches the board: the first contact, ~68% in. */
const CSS_LAND_MS = 340;
/** Physics owns the landing; the event normally cancels this. It only fires if the event never comes. */
const PHYS_LAND_FALLBACK_MS = 900;
/** The win cascade starts with the disc; the celebration waits for it to land. */
const CELEBRATE_AFTER_CSS_MS = 380;
const CELEBRATE_AFTER_PHYS_MS = 560;
/** GameShell holds the end modal for 5 s (GameOverDelayMs); every overlay is gone before 4.2 s. */
const CELEBRATION_MS = 3400;

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
function pageMode() {
    const seg = location.pathname.split('/').filter(Boolean);
    const m = (seg[1] || '1p').toLowerCase();
    return m === 'demo' ? 'demo' : m === '2p' || m === 'two' ? '2p' : m === 'online' || m === 'multiplayer' ? 'online' : 'ai';
}

// ─── Colour ──────────────────────────────────────────────────────────────
// The disc tokens (--disc-red-mid …) are the single source of the discs' colour. They are read the
// way gpuFx reads its tint: set as a probe's colour and take the computed rgb().
const FALLBACK_RGB = {
    red: { mid: [0.9, 0.22, 0.25], lit: [1, 0.55, 0.52] },
    yellow: { mid: [0.98, 0.8, 0.2], lit: [1, 0.93, 0.55] },
};
const _rgbCache = new Map();
function tokenRgb(varName, fallback) {
    if (_rgbCache.has(varName)) return _rgbCache.get(varName);
    let out = fallback;
    try {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        probe.style.color = `var(${varName})`;
        document.body.appendChild(probe);
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
        probe.remove();
        if (m) {
            const p = m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map((v) => parseFloat(v) / 255);
            if (p.length === 3 && p.every(Number.isFinite)) out = p;
        }
    } catch { /* keep the fallback */ }
    _rgbCache.set(varName, out);
    return out;
}
/** 0..1 rgb of a disc colour ('red' | 'yellow'), 'mid' or 'lit' shade. */
export function discRgb(color, shade = 'mid') {
    const c = color === 'yellow' ? 'yellow' : 'red';
    return tokenRgb(`--disc-${c}-${shade}`, FALLBACK_RGB[c][shade]);
}

// ─── Module state ────────────────────────────────────────────────────────
let _started = false;
let _board = null;
let _rootObs = null;
let _boardObs = null;
let _scanRaf = 0;
let _syncRaf = 0;
let _prev = new Uint8Array(CELLS);   // 0 none, 1 red, 2 yellow
let _winSeen = false;
let _drawSeen = false;
let _unregisterShake = null;
const _pending = new Map();          // cell index -> fallback landing timer
const _timers = new Set();
let _overlay = null;
let _b3d = null;                     // the live 3D board controller
let _b3dBusy = false;
/** The adaptive tier dropped to low and took the 3D board down: do not rebuild it on the next rise. */
let _tierLatched = false;
let _lastLandAt = 0;

function later(fn, ms) {
    const id = setTimeout(() => { _timers.delete(id); fn(); }, ms);
    _timers.add(id);
    return id;
}

function ensureCss() {
    if (document.querySelector('link[data-cf-fx-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL(CSS_HREF, document.baseURI).href;
    l.dataset.cfFxCss = '1';
    document.head.appendChild(l);
}

// ─── Reading the DOM board ───────────────────────────────────────────────
function cellEls() {
    return _board ? _board.querySelectorAll('.cf-cell') : [];
}
function readState() {
    const cells = cellEls();
    const state = new Uint8Array(CELLS);
    if (cells.length < CELLS) return { state, cells, ghost: null, cursor: -1, ok: false };
    let ghost = null;
    let cursor = -1;
    for (let i = 0; i < CELLS; i++) {
        const c = cells[i];
        if (c.classList.contains('cf-cell--cursor')) cursor = i % COLS;
        const piece = c.firstElementChild;
        if (!piece || !piece.classList.contains('piece')) continue;
        const col = piece.classList.contains('yellow-piece') ? 2 : piece.classList.contains('red-piece') ? 1 : 0;
        if (piece.classList.contains('ghost-piece')) {
            ghost = { row: (i / COLS) | 0, col: i % COLS, color: col === 2 ? 'yellow' : 'red' };
        } else {
            state[i] = col;
        }
    }
    return { state, cells, ghost, cursor, ok: true };
}
function cellCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

// ─── Landing feel ────────────────────────────────────────────────────────
function physicsOwnsDrops() {
    try {
        if (!window.PoConnectFive?.isAvailable?.()) return false;
        if (motionReduced() || tier() === 'low') return false;
        return !_board?.classList.contains('cf-board--3d');
    } catch { return false; }
}

/**
 * One landing, from any source. `row`/`col`/`color` identify the disc; `h` (0..1) is how far it fell
 * (row 0 is the shortest fall, row 8 the longest, the same 1.6-row run-up the physics drop uses);
 * `x`/`y` are viewport px of the landing cell when the caller knows them.
 */
export function landed({ col, row, color, h, x, y, silent } = {}) {
    if (!_started) return;
    const now = performance.now();
    _lastLandAt = now;
    const fall = h != null ? h : Math.min(1, (row + 1.6) / (ROWS + 1.2));
    const demo = pageMode() === 'demo';
    // One landing signal for extras.js (notes, block hit, board light), from every drop path.
    try { window.dispatchEvent(new CustomEvent('po-cf-landed', { detail: { col, row, color, fall, silent: !!silent } })); }
    catch { /* best-effort */ }

    // Sound: the connectfive 'land' cue (hollow ceramic click), heavier and lower for a long fall,
    // panned to its column. soundOnly: the bump, dust and haptic below are composed here so they
    // can follow the gates.
    if (!silent && !muted()) {
        try {
            window.PoCue?.fire('connectfive', 'land', {
                pitch: 1.16 - 0.3 * fall,
                pan: Math.max(-1, Math.min(1, ((col - 4) / 4) * 0.8)),
                gain: 0.4 + 0.45 * fall,
                soundOnly: true,
            });
        } catch { /* feedback is best-effort */ }
    }

    // Bump: trauma the impactBus decays and squares, applied to the registered board (2D) or the
    // camera (3D, through the stage's shake feature). Reduced motion and the quality tier are
    // gated inside addTrauma/getShake.
    if (!motionReduced()) {
        try { window.PoImpact?.addTrauma(0.1 + 0.26 * fall); } catch { /* best-effort */ }
    }

    // Haptic tap through the one haptics gate (setting, reduced haptics, duty cap, kiosk guard).
    if (!demo && !muted()) {
        try { window.PoImpact?.vibrate([Math.round(6 + 9 * fall)], { pad: false }); } catch { /* best-effort */ }
    }

    // Dust and sparks in the disc's own colour at the landing cell, on the shared GPU particle layer.
    if (!motionReduced() && tier() !== 'low' && window.PoFx?.burst) {
        let px = x;
        let py = y;
        if (px == null || py == null) {
            const el = cellEls()[row * COLS + col];
            if (!el) return;
            const c = cellCenter(el);
            px = c.x;
            py = c.y + c.h * 0.28;
        }
        try {
            window.PoFx.burst({
                x: px, y: py, preset: 'dust', color: discRgb(color, 'mid'),
                count: Math.round(7 + 8 * fall), scale: 0.5 + 0.35 * fall, angle: -Math.PI / 2, spread: Math.PI * 1.1,
            });
            if (tier() === 'high') {
                window.PoFx.burst({
                    x: px, y: py, preset: 'sparks', color: discRgb(color, 'lit'),
                    count: Math.round(3 + 6 * fall), scale: 0.3 + 0.2 * fall, angle: -Math.PI / 2, spread: Math.PI * 0.9,
                });
            }
        } catch { /* best-effort */ }
    }
}

function onPhysicsLanded(e) {
    const d = e?.detail;
    if (!_started || !d) return;
    const idx = d.row * COLS + d.col;
    const t = _pending.get(idx);
    if (t != null) { clearTimeout(t); _timers.delete(t); _pending.delete(idx); }
    landed({ col: d.col, row: d.row, color: d.color });
}

// ─── Scan: what changed on the board since last time ─────────────────────
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
    for (let i = 0; i < CELLS; i++) {
        if (state[i]) filled++;
        if (!_prev[i] && state[i]) added++;
        else if (_prev[i] && !state[i]) removed++;
    }

    if (removed > 0) {
        // A new game (or an online resync): everything pending and every celebration is stale.
        cancelCelebration();
        for (const t of _pending.values()) { clearTimeout(t); _timers.delete(t); }
        _pending.clear();
        _winSeen = false;
        _drawSeen = false;
    }

    const drop3d = _board.classList.contains('cf-board--3d');
    if (added > 0 && added <= 2 && removed === 0 && !drop3d) {
        const owns = physicsOwnsDrops();
        for (let i = 0; i < CELLS; i++) {
            if (_prev[i] || !state[i]) continue;
            const row = (i / COLS) | 0;
            const col = i % COLS;
            const color = state[i] === 2 ? 'yellow' : 'red';
            if (_pending.has(i)) continue;
            const id = later(() => {
                _pending.delete(i);
                landed({ col, row, color });
            }, owns ? PHYS_LAND_FALLBACK_MS : CSS_LAND_MS);
            _pending.set(i, id);
        }
    }
    _prev = state;

    if (_b3d) _b3d.sync(snap);

    // Win: the page marks the line with .win-cell / .win-cell-static.
    if (!_winSeen) {
        const winEls = _board.querySelectorAll('.win-cell, .win-cell-static');
        if (winEls.length >= 5) {
            _winSeen = true;
            const els = [...winEls];
            const first = els[0].querySelector('.piece');
            const color = first?.classList.contains('yellow-piece') ? 'yellow' : 'red';
            const delay = drop3d ? 700 : added > 0 && physicsOwnsDrops() ? CELEBRATE_AFTER_PHYS_MS : added > 0 ? CELEBRATE_AFTER_CSS_MS : 120;
            const outcome = resultFor(color);
            later(() => celebrate(els, color, outcome), delay);
        }
    }
    // Draw: a full board and no line.
    if (!_drawSeen && !_winSeen && filled === CELLS) {
        _drawSeen = true;
        later(() => celebrate([], 'red', 'draw'), added > 0 ? 600 : 150);
    }
}

/** 'win' | 'loss' | 'draw'. data-result (the page's own verdict, from the player's side) wins. */
function resultFor(winnerColor) {
    const r = (_board?.dataset.result || '').toLowerCase();
    if (r === 'win' || r === 'loss' || r === 'draw') return r;
    return pageMode() === 'ai' && winnerColor === 'yellow' ? 'loss' : 'win';
}

// ─── Win celebration ─────────────────────────────────────────────────────
function cancelCelebration() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    try { _b3d?.glow(null); } catch { /* best-effort */ }
}

function sortedCenters(els) {
    return els
        .map((el) => ({ el, ...cellCenter(el), r: Array.prototype.indexOf.call(cellEls(), el) }))
        .sort((a, b) => a.r - b.r);
}

function collinear(pts) {
    if (pts.length < 3) return true;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return pts.every((p) => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len < p.w * 0.35);
}

function celebrate(winEls, color, outcome) {
    if (!_started || !_board) return;
    cancelCelebration();
    const reduce = motionReduced();
    const pts = winEls.length ? sortedCenters(winEls) : [];
    const rgb = discRgb(color, 'mid');
    const lit = discRgb(color, 'lit');
    const soft = outcome !== 'win';

    // Sound first: it must not wait on the visuals.
    if (!muted()) celebrationSound(outcome);

    // Light: sweep along the five discs, then a bloom on each. In 3D the board draws its own.
    if (outcome !== 'draw' && _b3d && _board.classList.contains('cf-board--3d')) {
        const cells = pts.map((p) => ({ row: (p.r / COLS) | 0, col: p.r % COLS }));
        _b3d.glow(cells, color, outcome);
    } else {
        drawLight(pts, color, outcome, reduce);
    }

    // Confetti in the winner's colour on the shared GPU layer; none for the CPU's win, a draw or
    // reduced motion (the light above stays, as a still glow).
    if (!soft && !reduce && window.PoFx?.burst) {
        const br = _board.getBoundingClientRect();
        const jets = 5;
        for (let j = 0; j < jets; j++) {
            const shade = j % 2 ? lit : rgb;
            try {
                window.PoFx.burst({
                    x: br.left + (br.width * (j + 0.5)) / jets, y: br.top - 6, preset: 'confetti', color: shade,
                    scale: 0.8, angle: Math.PI / 2, spread: Math.PI * 0.5,
                });
            } catch { /* best-effort */ }
        }
        if (pts.length) {
            const mid = pts[(pts.length / 2) | 0];
            try {
                window.PoFx.burst({ x: mid.x, y: mid.y, preset: 'confetti', color: lit, scale: 0.9, angle: -Math.PI / 2, spread: Math.PI * 0.8 });
                window.PoFx.burst({ x: mid.x, y: mid.y, preset: 'sparks', color: lit, scale: 0.8 });
            } catch { /* best-effort */ }
        }
    }
    if (!soft) {
        try { window.PoImpact?.impact('win', 0.6); } catch { /* best-effort */ }
    } else if (outcome === 'loss' && !muted()) {
        try { window.PoImpact?.vibrate([40], { pad: false }); } catch { /* best-effort */ }
    }
    later(cancelCelebration, CELEBRATION_MS);
}

function drawLight(pts, color, outcome, reduce) {
    const host = document.createElement('div');
    host.className = `cf-fx cf-fx--${outcome}${reduce ? ' cf-fx--still' : ''}`;
    host.setAttribute('aria-hidden', 'true');
    if (outcome !== 'draw') {
        host.style.setProperty('--cf-fx-glow', `var(--disc-${color}-lit)`);
        host.style.setProperty('--cf-fx-core', `var(--disc-${color}-mid)`);
    }

    if (outcome === 'draw' || !pts.length) {
        const br = _board.getBoundingClientRect();
        const sweep = document.createElement('div');
        sweep.className = 'cf-fx__sweep cf-fx__sweep--board';
        sweep.style.cssText = `left:${br.left}px;top:${br.top}px;width:${br.width}px;height:${br.height}px`;
        host.appendChild(sweep);
    } else {
        const a = pts[0];
        const b = pts[pts.length - 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (collinear(pts) && len > 0) {
            const sweep = document.createElement('div');
            sweep.className = 'cf-fx__sweep';
            const th = a.h * 0.9;
            // Centred on the segment, extended by one cell so the ends are lit too.
            sweep.style.cssText = `left:${(a.x + b.x) / 2 - (len + a.w) / 2}px;top:${(a.y + b.y) / 2 - th / 2}px;`
                + `width:${len + a.w}px;height:${th}px;transform:rotate(${ang}rad)`;
            host.appendChild(sweep);
        }
        pts.forEach((p, i) => {
            const bloom = document.createElement('div');
            bloom.className = 'cf-fx__bloom';
            const s = p.w * 1.7;
            bloom.style.cssText = `left:${p.x - s / 2}px;top:${p.y - s / 2}px;width:${s}px;height:${s}px;--i:${i}`;
            host.appendChild(bloom);
        });
    }
    document.body.appendChild(host);
    _overlay = host;
}

// ─── Celebration sound ───────────────────────────────────────────────────
// Voices are dsp.js data. The crowd is bandpass-ish noise swelling in and out with a patter of
// claps on top; the sting is a stacked saw chord through a rising filter. The CPU's win is a
// quiet, falling "aww" and nothing brassy; a draw is two soft bell tones.
function v(wave, freq, dur, gain, extra) { return { wave, freq, dur, gain, ...(extra || {}) }; }

function celebrationSound(outcome) {
    try {
        if (outcome === 'win') {
            const voices = [
                // Brass sting: C major, then an octave stab.
                v('saw', 261.6, 0.5, 0.07, { attack: 0.03, decay: 0.42, cutoff: 900, cutoffEnd: 3400, q: 1.2, drive: 0.3 }),
                v('saw', 329.6, 0.5, 0.06, { attack: 0.03, decay: 0.42, cutoff: 900, cutoffEnd: 3400, q: 1.2, drive: 0.3, pan: -0.2 }),
                v('saw', 392.0, 0.5, 0.06, { attack: 0.03, decay: 0.42, cutoff: 900, cutoffEnd: 3400, q: 1.2, drive: 0.3, pan: 0.2 }),
                v('saw', 523.3, 0.9, 0.08, { attack: 0.02, decay: 0.8, cutoff: 1200, cutoffEnd: 4200, q: 1.4, drive: 0.35, delay: 0.24 }),
                v('saw', 659.3, 0.9, 0.06, { attack: 0.02, decay: 0.8, cutoff: 1200, cutoffEnd: 4200, q: 1.4, drive: 0.35, delay: 0.24, pan: 0.15 }),
                v('saw', 784.0, 0.9, 0.06, { attack: 0.02, decay: 0.8, cutoff: 1200, cutoffEnd: 4200, q: 1.4, drive: 0.35, delay: 0.24, pan: -0.15 }),
                // Crowd: a swell of band-limited noise ...
                v('noise', 0, 1.8, 0.11, { attack: 0.35, decay: 1.4, cutoff: 700, cutoffEnd: 2600, q: 0.9, delay: 0.1, pan: -0.3 }),
                v('noise', 0, 1.8, 0.09, { attack: 0.45, decay: 1.4, cutoff: 1500, cutoffEnd: 4200, q: 0.8, delay: 0.2, pan: 0.3, lfoRate: 7, lfoDepth: 0.4 }),
            ];
            // ... and hand claps scattered through it.
            for (let i = 0; i < 16; i++) {
                voices.push(v('noise', 0, 0.04, 0.05, {
                    decay: 0.035, cutoff: 2400 + Math.random() * 2400, q: 1.6, delay: 0.5 + i * 0.09 + Math.random() * 0.07,
                    pan: (Math.random() - 0.5) * 1.2,
                }));
            }
            Dsp.playAll(voices, 'sfx');
            try { window.PoAudioBus?.duck?.(0.55, 2200); } catch { /* best-effort */ }
        } else if (outcome === 'loss') {
            Dsp.playAll([
                v('triangle', 392, 0.5, 0.08, { freqEnd: 311, sweep: 0.45, attack: 0.04, decay: 0.45, cutoff: 1400 }),
                v('triangle', 330, 0.6, 0.07, { freqEnd: 247, sweep: 0.55, attack: 0.04, decay: 0.55, cutoff: 1200, delay: 0.18 }),
                v('sine', 123, 0.7, 0.09, { freqEnd: 98, sweep: 0.6, attack: 0.05, decay: 0.6, delay: 0.3 }),
                v('noise', 0, 0.9, 0.035, { attack: 0.25, decay: 0.7, cutoff: 600, cutoffEnd: 300, q: 0.8, delay: 0.1 }),
            ], 'sfx');
        } else {
            Dsp.playAll([
                v('sine', 659.3, 0.7, 0.07, { attack: 0.01, decay: 0.65 }),
                v('sine', 987.8, 0.7, 0.045, { attack: 0.01, decay: 0.6, delay: 0.02 }),
                v('modal', 523.3, 0.6, 0.08, { material: 'ceramic', damping: 1.4, delay: 0.18 }),
                v('sine', 784.0, 0.8, 0.05, { attack: 0.01, decay: 0.75, delay: 0.26, pan: 0.15 }),
            ], 'sfx');
        }
    } catch { /* feedback is best-effort */ }
}

// ─── Optional 3D board ───────────────────────────────────────────────────
export function wanted3d() {
    try { return localStorage.getItem(BOARD_KEY) === '3d'; } catch { return false; }
}

export function setBoardMode(mode) {
    _tierLatched = false;   // an explicit choice is a fresh try
    try { localStorage.setItem(BOARD_KEY, mode === '3d' ? '3d' : '2d'); } catch { /* private mode: this session only */ }
    refresh();
}

/** Can this device draw the 3D board at all? WebGPU or WebGL, on a tier above low. */
async function canUse3d() {
    if (tier() === 'low') return false;
    try {
        if (navigator.gpu && await navigator.gpu.requestAdapter()) return true;
    } catch { /* fall through to WebGL */ }
    return typeof window.isWebGlAvailable === 'function' ? !!window.isWebGlAvailable() : false;
}

function fall2d() {
    if (_b3d) { try { _b3d.dispose(); } catch { /* already gone */ } _b3d = null; }
    _board?.classList.remove('cf-board--3d');
    // The 2D board is the one with the shake handle.
    if (_board && !_unregisterShake && window.PoImpact?.registerStage) _unregisterShake = window.PoImpact.registerStage(_board);
}

/** Reconcile the board with the stored 2D/3D choice. Safe to call any time. */
export async function refresh() {
    if (!_started || !_board || _b3dBusy) return;
    const want = wanted3d() && !_tierLatched;
    if (!want) { if (_b3d || _board.classList.contains('cf-board--3d')) fall2d(); return; }
    if (_b3d) return;
    _b3dBusy = true;
    const board = _board;
    try {
        if (!(await canUse3d())) throw new Error('no 3D support');
        const mod = await import('./board3d.js');
        if (!_started || _board !== board || !wanted3d()) return;
        const ctl = await mod.mount(board, {
            landed,
            reduced: motionReduced,
            tier,
            onFail: (tierDrop) => { if (tierDrop) _tierLatched = true; if (_b3d === ctl) fall2d(); },
        });
        if (!_started || _board !== board || !wanted3d()) { ctl.dispose(); return; }
        _b3d = ctl;
        if (_unregisterShake) { _unregisterShake(); _unregisterShake = null; }
        _b3d.sync(readState());
        board.classList.add('cf-board--3d');
    } catch (err) {
        console.warn('PoConnectFive: 3D board unavailable, staying on the 2D board:', err?.message || err);
        fall2d();
    } finally {
        _b3dBusy = false;
    }
}

// ─── Attach / detach ─────────────────────────────────────────────────────
function attach(board) {
    _board = board;
    _prev = readState().state;           // what is already there is not a drop
    _winSeen = board.querySelectorAll('.win-cell, .win-cell-static').length >= 5;
    _drawSeen = false;
    _boardObs = new MutationObserver(scheduleScan);
    _boardObs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-result'] });
    if (window.PoImpact?.registerStage) _unregisterShake = window.PoImpact.registerStage(board);
    refresh();
}

function detach() {
    cancelCelebration();
    if (_boardObs) { _boardObs.disconnect(); _boardObs = null; }
    if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = 0; }
    for (const id of _timers) clearTimeout(id);
    _timers.clear();
    _pending.clear();
    if (_b3d) { try { _b3d.dispose(); } catch { /* already gone */ } _b3d = null; }
    if (_unregisterShake) { _unregisterShake(); _unregisterShake = null; }
    _board?.classList.remove('cf-board--3d');
    _board = null;
}

function syncBoard() {
    _syncRaf = 0;
    if (!_started) return;
    // The page left (a missed Dispose): stop watching the whole document.
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
    window.addEventListener('po-cf-drop-landed', onPhysicsLanded);
    window.addEventListener('storage', onStorage);
    _rootObs = new MutationObserver(() => { if (!_syncRaf) _syncRaf = requestAnimationFrame(syncBoard); });
    _rootObs.observe(document.body, { childList: true, subtree: true });
    syncBoard();
    // The second observer: board light, coach, held disc, CPU scan, notes, music, drain (extras.js).
    _extras = import('./extras.js').then((m) => { if (_started) m.start(); return m; })
        .catch((e) => { console.warn('PoConnectFive extras unavailable:', e?.message || e); return null; });
    return true;
}
let _extras = null;

function onStorage(e) { if (e.key === BOARD_KEY) refresh(); }

export function stop() {
    if (!_started) return;
    _started = false;
    window.removeEventListener('po-cf-drop-landed', onPhysicsLanded);
    window.removeEventListener('storage', onStorage);
    if (_rootObs) { _rootObs.disconnect(); _rootObs = null; }
    if (_syncRaf) { cancelAnimationFrame(_syncRaf); _syncRaf = 0; }
    detach();
    _extras?.then((m) => m?.stop());
}

/** Debug and test hook: the live state, never used by the game. */
export function debug() {
    return { started: _started, board: !!_board, threeD: !!_b3d, lastLandAt: _lastLandAt, wants3d: wanted3d() };
}

window.PoConnectFiveFx = { start, stop, refresh, setBoardMode, landed, debug, sound: celebrationSound };
