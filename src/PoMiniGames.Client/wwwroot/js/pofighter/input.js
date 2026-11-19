// pofighter/input.js — one human corner's controls in a fight (arcade and 2P versus).
//
// createInput(root, layout, session) reads a keyboard layout, a gamepad and (solo only) the
// page's touch buttons [data-pf-btn], and sample() returns what versus.js setInput takes:
// { left, right, up, down, attack } — attack is the first punch/kick PRESSED since the last
// sample, so a quick tap between two frames is never lost.
//
// Layouts:
//   solo  arrows or WASD, J/F punch, L/G kick; the active pad; touch buttons
//   p1    WASD, F punch, G kick; pad 1 when two pads are connected
//   p2    arrows, K punch, L kick; pad 2 with two pads, or the only pad (P1 keeps the keyboard)

import { BUTTONS, ButtonEdges, activePad, connectedPads, pressed, stick, rumble } from '../platform/gamepadBus.js';
import { vibrate } from '../platform/impactBus.js';

const MOVE_KEYS = {
    wasd: { KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down' },
    arrows: { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' },
};
export const LAYOUTS = {
    solo: { keys: { ...MOVE_KEYS.wasd, ...MOVE_KEYS.arrows, KeyJ: 'punchMid', KeyF: 'punchMid', KeyL: 'kick', KeyG: 'kick' }, touch: true },
    p1: { keys: { ...MOVE_KEYS.wasd, KeyF: 'punchMid', KeyG: 'kick' }, touch: false },
    p2: { keys: { ...MOVE_KEYS.arrows, KeyK: 'punchMid', KeyL: 'kick' }, touch: false },
};
const PAD_ATTACKS = { [BUTTONS.west]: 'punchMid', [BUTTONS.north]: 'punchMid', [BUTTONS.south]: 'kick', [BUTTONS.east]: 'kick' };
const ATTACKS = new Set(['punchMid', 'kick']);

/** The pad a layout reads now (pads can come and go mid-fight). */
export function padFor(layoutName) {
    if (layoutName === 'solo') return activePad();
    const pads = connectedPads();
    if (layoutName === 'p1') return pads.length >= 2 ? pads[0] : null;
    return pads.length >= 2 ? pads[1] : pads[0] ?? null;
}

export function createInput(root, layoutName, session) {
    const layout = LAYOUTS[layoutName] ?? LAYOUTS.solo;
    const keys = new Set(), touch = new Set(), tapped = new Set();
    const presses = [];
    const edges = new ButtonEdges();
    let device = 'keys';
    const undo = [];
    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        undo.push(() => target.removeEventListener(type, handler, options));
    };
    const press = control => {
        tapped.add(control);
        if (ATTACKS.has(control)) presses.push(control);
    };

    on(window, 'keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.target?.closest?.('input, textarea, select, dialog')) return;
        const control = layout.keys[e.code];
        if (!control) return;
        e.preventDefault();
        device = 'keys';
        if (!e.repeat) { keys.add(control); press(control); }
    });
    on(window, 'keyup', e => { const c = layout.keys[e.code]; if (c) keys.delete(c); });
    // Lost focus: forget held controls, so nobody walks on by themselves.
    on(window, 'blur', () => { keys.clear(); touch.clear(); presses.length = 0; tapped.clear(); });

    if (layout.touch && root) {
        for (const btn of root.querySelectorAll('[data-pf-btn]')) {
            const control = btn.dataset.pfBtn;
            const release = () => touch.delete(control);
            on(btn, 'pointerdown', e => {
                e.preventDefault();
                device = 'touch';
                if (root.dataset.pfDevice !== 'touch') root.dataset.pfDevice = 'touch';
                vibrate([8]);   // a tick under the thumb (off when haptics are off)
                touch.add(control);
                press(control);
            });
            on(btn, 'pointerup', release);
            on(btn, 'pointercancel', release);
            on(btn, 'pointerleave', release);
            on(btn, 'contextmenu', e => e.preventDefault());
        }
    }

    const input = {
        get device() { return device; },
        pad: () => padFor(layoutName),
        /** The controls since the last sample (see the file header). */
        sample() {
            const gp = padFor(layoutName);
            const pad = { left: false, right: false, up: false, down: false };
            for (const i of edges.update(gp)) if (PAD_ATTACKS[i]) { press(PAD_ATTACKS[i]); device = 'pad'; }
            if (gp) {
                const axis = stick(gp, 0.35);
                pad.left = pressed(gp, BUTTONS.left) || axis.x < -0.5;
                pad.right = pressed(gp, BUTTONS.right) || axis.x > 0.5;
                pad.up = pressed(gp, BUTTONS.up) || axis.y < -0.6;
                pad.down = pressed(gp, BUTTONS.down) || axis.y > 0.6;
                if (pad.left || pad.right || pad.up || pad.down) device = 'pad';
            }
            const held = n => keys.has(n) || touch.has(n) || tapped.has(n) || pad[n];
            const out = { left: held('left'), right: held('right'), up: held('up'), down: held('down'), attack: presses[0] ?? null };
            presses.length = 0;
            tapped.clear();
            return out;
        },
        /** Rumble this player's pad (gated by the Haptics setting through gamepadBus). */
        rumble(strong, weak, ms, opts) {
            const gp = padFor(layoutName);
            if (gp) rumble(gp, strong, weak, ms, opts);
        },
        dispose() { for (const u of undo.splice(0)) u(); },
    };
    session?.cleanup.push(() => input.dispose());
    return input;
}
