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
// GameOverModal calls PoCeremony.start(dialog, newBest) just before showModal().
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
export function start(dialog, newBest) {
    if (!dialog || typeof dialog.setAttribute !== 'function') return false;
    finish();
    if (motionReduced()) return false;

    dialog.setAttribute('data-ceremony', '');
    dialog.setAttribute('data-beats', '');

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
    window.PoCeremony = { start, finish, schedule, BEATS };
}
