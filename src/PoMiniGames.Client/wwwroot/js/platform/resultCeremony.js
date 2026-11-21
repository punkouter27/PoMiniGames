// resultCeremony.js — the end-of-game card as a five-beat sequence (deck idea #19).
//
//   1 freeze    the card lands; only the title shows (GameOverModal's hitstop and
//               outcome cue are already playing — this adds nothing on top)
//   2 headline  the result line and the stats rise in, one tick
//   3 rank      the rank line and the top 3 rise in, a higher tick, a few sparks
//   4 record    (new personal best only) the first stat glows, a small chord, coins
//   5 action    the footer actions get one soft pulse — the replay/exit beat
//
// ACCESSIBILITY
//   • Nothing is removed from the DOM or the accessibility tree: the beats only change
//     opacity/translate through [data-beats] on the <dialog>, so a screen reader reads
//     the whole result at once and the footer button is focusable from the first frame.
//     The footer is never hidden, only pulsed.
//   • A visible Skip control (injected here, removed when the ceremony ends) and any
//     pointer press on the card jump straight to the end.
//   • Reduced motion (OS or <html data-motion="reduce">): no ceremony at all — start()
//     returns false and the card shows everything immediately, as before.
//
// ALSO IN THE END CARD (deck idea #19 polish)
//   roll    score/stat numbers roll up like an odometer: one damped spring drives the value,
//           so the high digits move slowly and the low digits blur, and the soft ticks rise
//           with progress. Written into Blazor's own text node (never replaced), and the
//           final string is restored exactly.
//   frost   the backdrop is a blurred, darkened copy of the game's last frame. The game
//           canvas is read inside an animation frame (a WebGL/WebGPU canvas without
//           preserveDrawingBuffer is only readable in the frame it was drawn in, the same
//           rule glassFx.js follows) and rejected if it comes back blank; then the card
//           simply keeps the existing blur of the live DOM behind it. It is a still image,
//           so it stays under reduced motion; the roll and the stagger do not.
//   stagger stat cells and board rows rise in one after another (--i, game-shell.css).
//
// Not here, by the owner's rule: a "Save clip" control. The end card has exactly one action
// (Back to main menu) and takes no clip/share links, so the replay clip stays out of it.
//
// GameOverModal calls PoCeremony.start(dialog, newBest) just before showModal(); it now returns
// a promise (one frame at most) so the frost is ready before the card paints.
// The ceremony CSS lives in css/game-shell.css next to the rest of .gps-modal.

export const BEATS = Object.freeze(['freeze', 'headline', 'rank', 'record', 'action']);

/**
 * When each beat lands, in ms from open. Pure. The record beat is omitted unless the
 * game reported a new best; the action beat always closes the sequence.
 * @param {{newBest?:boolean, speed?:number}} [o]
 * @returns {{beat:string, at:number}[]}
 */
export function schedule(o = {}) {
    const speed = o.speed > 0 ? o.speed : 1;
    const t = (ms) => Math.round(ms / speed);
    const out = [
        { beat: 'freeze', at: 0 },
        { beat: 'headline', at: t(180) },
        { beat: 'rank', at: t(560) },
    ];
    if (o.newBest) out.push({ beat: 'record', at: t(940) });
    out.push({ beat: 'action', at: t(o.newBest ? 1320 : 920) });
    return out;
}

/** Tick pitch per beat (Hz) — rising, so the sequence reads as a climb. */
const TICK = { headline: 523.25, rank: 659.25, action: 880 };
const RECORD_CHORD = [783.99, 987.77, 1174.66];

function motionReduced() {
    try {
        if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
}

function lowTier() {
    return document.documentElement.getAttribute('data-gfx') === 'low';
}

const FROST_W = 640;
const FROST_WAIT_MS = 160;   // a slow frame just applies the frost after the card is up

function sceneCanvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
        if (c.closest('dialog, [aria-hidden="true"]') || c.offsetParent === null) continue;
        const a = (c.width || 0) * (c.height || 0);
        if (a > area && c.clientWidth >= 240) { area = a; best = c; }
    }
    return best;
}

/** True when a 2D canvas holds something other than a flat colour. Pure enough to test. */
export function looksBlank(ctx, w, h) {
    try {
        const d = ctx.getImageData(0, 0, w, h).data;
        let min = 255, max = 0;
        for (let i = 0; i < d.length; i += 4) {
            const l = d[i] + d[i + 1] + d[i + 2];
            if (l < min) min = l;
            if (l > max) max = l;
        }
        return d.length === 0 || max - min < 6;
    } catch { return true; }
}

/** Blurred copy of the canvas as a CSS url(), or null when unreadable/blank. */
function grabFrame(canvas) {
    try {
        const w = FROST_W;
        const h = Math.max(120, Math.round(w * canvas.height / canvas.width));
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const g = off.getContext('2d', { willReadFrequently: true });
        g.drawImage(canvas, 0, 0, w, h);
        if (looksBlank(g, w, h)) return null;
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const o = out.getContext('2d');
        o.filter = 'blur(10px) saturate(1.25) brightness(0.82)';
        o.drawImage(off, -12, -12, w + 24, h + 24);
        return `url("${out.toDataURL('image/webp', 0.7)}")`;
    } catch { return null; /* tainted or lost canvas: the live blur stays */ }
}

function frost(dialog) {
    const canvas = sceneCanvas();
    if (!canvas) return Promise.resolve(false);
    return new Promise((resolve) => {
        let done = false;
        const finishFrost = (ok) => { if (!done) { done = true; resolve(ok); } };
        const timer = setTimeout(() => finishFrost(false), FROST_WAIT_MS);
        requestAnimationFrame(() => {
            const url = grabFrame(canvas);
            clearTimeout(timer);
            if (url) { dialog.style.setProperty('--end-frost', url); dialog.setAttribute('data-frost', ''); }
            finishFrost(!!url);
        });
    });
}

// ── Number roll ──────────────────────────────────────────────────────────────
const ROLL_SPRING = Object.freeze({ stiffness: 42, damping: 11 });   // ~0.85 damped: a small overshoot
let _lastTickAt = 0;

function rollTick(progress) {
    const now = performance.now();
    if (now - _lastTickAt < 55) return;
    _lastTickAt = now;
    try { window.PoUiAudio?.playTone?.(520 + 520 * Math.min(1, progress), 22, 0.016, 'sine'); } catch { /* garnish */ }
}

/**
 * Odometer-roll every whole-number stat in `root`. Pure DOM + timers; no-op under reduced motion.
 * @param {ParentNode} root
 * @returns {boolean} true when at least one number is rolling
 */
export function roll(root) {
    if (!root || !root.querySelectorAll || motionReduced()) return false;
    let order = 0;
    for (const el of root.querySelectorAll('.gps-stat-value')) {
        const node = el.firstChild;
        const final = (el.textContent || '').trim();
        const m = /^(\d{1,3}(?:,\d{3})+|\d+)$/.exec(final);
        if (!m || !node || node.nodeType !== 3 || el.childNodes.length !== 1) continue;
        const target = parseInt(final.replace(/,/g, ''), 10);
        if (!(target >= 2)) continue;
        const grouped = final.includes(',');
        const s = { x: 0, v: 0 };
        const t0 = performance.now() + 220 + (order++) * 150;
        let last = t0;
        let shown = '0';
        node.nodeValue = '0';
        const frame = (now) => {
            if (!el.isConnected) return;
            if (now < t0) { requestAnimationFrame(frame); return; }
            const dt = Math.min(1 / 30, (now - last) / 1000);
            last = now;
            // semi-implicit Euler on the same spring form springUi.js uses
            // A linear spring in value space: the time to settle does not depend on the size of the
            // number, so 50 and 50,000 both land in about three quarters of a second.
            s.v += (-ROLL_SPRING.stiffness * (s.x - target) - ROLL_SPRING.damping * s.v) * dt;
            s.x += s.v * dt;
            const next = Math.max(0, Math.round(s.x));
            const text = grouped ? next.toLocaleString('en-US') : String(next);
            if (text !== shown) { shown = text; node.nodeValue = text; rollTick(Math.min(1, s.x / target)); }
            const settled = Math.abs(s.x - target) < Math.max(0.5, target * 0.0005) && Math.abs(s.v) < Math.max(1, target * 0.01);
            if (!settled) { requestAnimationFrame(frame); return; }
            node.nodeValue = final;
            try { window.PoImpact?.pop?.(el); } catch { /* garnish */ }
        };
        requestAnimationFrame(frame);
    }
    return order > 0;
}

let _active = null;   // { dialog, timers, skip, onPress }

function playBeat(dialog, beat) {
    const ui = window.PoUiAudio;
    try {
        if (beat === 'record') ui?.playChord?.(RECORD_CHORD, 260, 0.05);
        else if (TICK[beat]) ui?.playTone?.(TICK[beat], 70, 0.04, 'triangle');
    } catch { /* audio is a garnish */ }

    if (lowTier() || !window.PoFx?.burstAt) return;
    try {
        if (beat === 'rank') {
            const rank = dialog.querySelector('.gps-modal-rank-pos');
            if (rank) window.PoFx.burstAt(rank, { preset: 'sparks', count: 10, scale: 0.5 });
        } else if (beat === 'record') {
            const best = dialog.querySelector('.gps-modal-stats .gps-stat-value');
            if (best) window.PoFx.burstAt(best, { preset: 'coins', count: 14, scale: 0.6 });
        }
    } catch { /* particles are a garnish */ }
}

function setBeat(dialog, beat) {
    const seen = (dialog.getAttribute('data-beats') || '').split(' ').filter(Boolean);
    if (!seen.includes(beat)) seen.push(beat);
    dialog.setAttribute('data-beats', seen.join(' '));
}

/** End the ceremony now: every beat shown, Skip removed. Safe to call twice. */
export function finish() {
    const a = _active;
    if (!a) return;
    _active = null;
    for (const id of a.timers) clearTimeout(id);
    a.dialog.removeEventListener('pointerdown', a.onPress, true);
    a.skip?.remove();
    a.dialog.setAttribute('data-beats', BEATS.join(' '));
    // Leave the attributes a moment so the last transitions finish, then drop them so
    // nothing the ceremony styled can outlive it.
    setTimeout(() => {
        a.dialog.removeAttribute('data-ceremony');
        a.dialog.removeAttribute('data-beats');
    }, 450);
}

/**
 * Run the ceremony on an end-of-game <dialog>. Returns false (and does nothing) under
 * reduced motion or without a dialog.
 * @param {HTMLDialogElement} dialog
 * @param {boolean} [newBest]
 */
export async function start(dialog, newBest) {
    if (!dialog || typeof dialog.setAttribute !== 'function') return false;
    finish();
    await frost(dialog);   // at most FROST_WAIT_MS; a still image, so it also runs under reduced motion
    if (motionReduced()) return false;
    roll(dialog);

    dialog.setAttribute('data-ceremony', '');
    dialog.setAttribute('data-beats', '');
    // Stagger index for the rows that rise in together (game-shell.css reads --i).
    dialog.querySelectorAll('.gps-modal-stats > *, .gps-modal-board-row').forEach((el, i) => el.style.setProperty('--i', String(i % 8)));

    // The skip affordance only exists for the second the ceremony runs. It is not one of
    // the card's actions (Back to main menu stays the only one); it just ends the show.
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'gps-ceremony-skip';
    skip.textContent = 'Skip';
    skip.setAttribute('aria-label', 'Skip result animation');
    skip.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
    dialog.appendChild(skip);

    const onPress = (e) => { if (e.target !== skip) finish(); };
    dialog.addEventListener('pointerdown', onPress, true);

    const plan = schedule({ newBest: !!newBest });
    const timers = [];
    _active = { dialog, timers, skip, onPress };
    for (const step of plan) {
        timers.push(setTimeout(() => {
            if (!_active || _active.dialog !== dialog) return;
            setBeat(dialog, step.beat);
            playBeat(dialog, step.beat);
            if (step.beat === 'action') setTimeout(finish, 380);
        }, step.at));
    }
    return true;
}

if (typeof window !== 'undefined') {
    window.PoCeremony = { start, finish, schedule, roll, BEATS };
}
