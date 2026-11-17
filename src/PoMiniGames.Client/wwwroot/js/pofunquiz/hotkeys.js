// PoFunQuiz answer keys and controllers.
//
// Razor can't subscribe to global keyboard events directly, so the quiz page imports this
// module and registers itself; each press is forwarded to the page's .NET handlers
// (OnSplitHotkeyAsync / OnSoloHotkeyAsync). The page calls unregister() on dispose.
//
// Keys:
//   - Split-screen 2P: 1/2/3/4 → left player's options 0-3; 6/7/8/9 → right player's.
//   - Solo: 1/2/3/4 → options 0-3.
//   - 5 is ignored on purpose (the gap between the two halves of the number row), so a
//     cross-side hit is less likely.
//
// Controllers (split-screen only): the first pad answers for the left player and the second
// for the right, with the face buttons Y / X / B / A as options 1-4 (the order the
// "Controller" hint under each name shows). Solo needs nothing here: gamepadBus.js already
// moves focus with the D-pad and clicks with A. The split board carries [data-pad-claim] so
// that focus navigation stands down while two pads are answering.
//
// Keypresses inside an input or a contenteditable are ignored, so typing never answers.

import { BUTTONS, connectedPads, pressed } from '../platform/gamepadBus.js';

/** Standard-mapping face buttons in option order: Y, X, B, A. */
export const PAD_OPTION_BUTTONS = Object.freeze([BUTTONS.north, BUTTONS.west, BUTTONS.east, BUTTONS.south]);
const SIDES = ['L', 'R'];
const SOLO_KEYS = { 1: 0, 2: 1, 3: 2, 4: 3 };
const RIGHT_KEYS = { 6: 0, 7: 1, 8: 2, 9: 3 };

let dotnetRef = null;
let mode = null;                 // 'split' | 'solo' | null when unregistered
let padRaf = 0;
const padWasDown = new Map();    // pad index → Set of the face buttons held last frame

function isTyping(target) {
    if (!target) return false;
    const tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!target.isContentEditable;
}

function send(method, side, optionIndex) {
    try {
        dotnetRef?.invokeMethodAsync(method, side, optionIndex);
    } catch {
        // .NET ref disposed during navigation — nothing to answer.
    }
}

function onKeyDown(ev) {
    if (!mode || !dotnetRef || isTyping(ev.target)) return;
    // Plain presses only: the browser keeps its own shortcuts.
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    const left = SOLO_KEYS[ev.key];
    const right = mode === 'split' ? RIGHT_KEYS[ev.key] : undefined;
    if (left === undefined && right === undefined) return;

    // The digit must not also scroll the page or move focus.
    ev.preventDefault();
    if (mode === 'solo') send('OnSoloHotkeyAsync', 'S', left);
    else if (left !== undefined) send('OnSplitHotkeyAsync', 'L', left);
    else send('OnSplitHotkeyAsync', 'R', right);
}

function padFrame() {
    padRaf = 0;
    if (mode !== 'split') return;
    const pads = connectedPads();
    if (!pads.length) return;                  // gamepadconnected starts the loop again
    padRaf = requestAnimationFrame(padFrame);
    // Only the board answers: behind the start card or the game-over sheet the pads belong to
    // gamepadBus's dialog navigation, and a button held through one must not land as a pick.
    const live = !document.hidden && !!document.querySelector('[data-pad-claim]')
        && !document.querySelector('dialog[open], [aria-modal="true"]');
    pads.slice(0, SIDES.length).forEach((pad, seat) => {
        const before = padWasDown.get(pad.index) || new Set();
        const now = new Set();
        PAD_OPTION_BUTTONS.forEach((button, optionIndex) => {
            if (!pressed(pad, button)) return;
            now.add(button);
            if (!live || before.has(button)) return;
            // The "Controller" hints under each name show once a pad is actually in use.
            document.documentElement.dataset.input = 'pad';
            send('OnSplitHotkeyAsync', SIDES[seat], optionIndex);
        });
        padWasDown.set(pad.index, now);
    });
}

function startPads() {
    if (!padRaf && mode === 'split') padRaf = requestAnimationFrame(padFrame);
}

/** Split-screen 2P: both halves of the number row, plus one controller per player. */
export function register(ref) {
    unregister();
    dotnetRef = ref;
    mode = 'split';
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('gamepadconnected', startPads);
    startPads();
}

/** Solo: keys 1-4 only; 6-9 are left alone so the digit is not swallowed for nothing. */
export function registerSolo(ref) {
    unregister();
    dotnetRef = ref;
    mode = 'solo';
    window.addEventListener('keydown', onKeyDown, true);
}

/** Tear down every listener and the pad loop. Safe to call more than once. */
export function unregister() {
    mode = null;
    dotnetRef = null;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('gamepadconnected', startPads);
    if (padRaf) cancelAnimationFrame(padRaf);
    padRaf = 0;
    padWasDown.clear();
}
