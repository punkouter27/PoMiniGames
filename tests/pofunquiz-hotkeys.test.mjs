// PoFunQuiz answer keys and controllers (src/PoMiniGames.Client/wwwroot/js/pofunquiz/hotkeys.js).
// Headless: a fake window/document/navigator and a hand-cranked animation frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Map();
let frame = null;
let pads = [];
let claim = true;
let modal = false;

globalThis.window = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
};
globalThis.document = {
    hidden: false,
    documentElement: { dataset: {} },
    querySelector: (sel) => (sel === '[data-pad-claim]' ? (claim ? {} : null) : (modal ? {} : null)),
};
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true });
globalThis.requestAnimationFrame = (fn) => { frame = fn; return 1; };
globalThis.cancelAnimationFrame = () => { frame = null; };

const keys = await import('../src/PoMiniGames.Client/wwwroot/js/pofunquiz/hotkeys.js');

const pad = (index, down = []) => ({
    index, connected: true,
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.includes(i), value: 0 })),
});
const tick = () => { const f = frame; frame = null; f?.(); };
const press = (key, extra = {}) => {
    let prevented = false;
    listeners.get('keydown')?.({ key, target: { tagName: 'BODY' }, preventDefault: () => { prevented = true; }, ...extra });
    return prevented;
};
const recorder = () => {
    const calls = [];
    return { calls, ref: { invokeMethodAsync: (...a) => calls.push(a) } };
};

test('split-screen: each half of the number row answers for its own player, and 5 is ignored', () => {
    const { calls, ref } = recorder();
    keys.register(ref);
    assert.equal(press('1'), true);
    assert.equal(press('9'), true);
    assert.equal(press('5'), false, 'the gap key is left alone');
    assert.deepEqual(calls, [['OnSplitHotkeyAsync', 'L', 0], ['OnSplitHotkeyAsync', 'R', 3]]);
    keys.unregister();
});

test('solo: keys 1-4 answer; 6-9 are not swallowed; typing and shortcuts never answer', () => {
    const { calls, ref } = recorder();
    keys.registerSolo(ref);
    press('2');
    assert.equal(press('7'), false);
    press('3', { target: { tagName: 'INPUT' } });
    press('4', { ctrlKey: true });
    assert.deepEqual(calls, [['OnSoloHotkeyAsync', 'S', 1]]);
    assert.equal(frame, null, 'solo does not poll the pads');
    keys.unregister();
});

test('split-screen pads: Y/X/B/A answer once per press, for the pad\'s own seat, never behind a dialog', () => {
    const { calls, ref } = recorder();
    pads = [pad(0), pad(1)];
    keys.register(ref);
    tick();
    assert.equal(calls.length, 0);

    pads = [pad(0, [3]), pad(1, [0])];      // pad 1 presses Y (option 1), pad 2 presses A (option 4)
    tick();
    assert.deepEqual(calls, [['OnSplitHotkeyAsync', 'L', 0], ['OnSplitHotkeyAsync', 'R', 3]]);
    assert.equal(document.documentElement.dataset.input, 'pad', 'the controller hints show once a pad is used');
    tick();
    assert.equal(calls.length, 2, 'a held button answers once');

    pads = [pad(0), pad(1)];
    tick();
    modal = true;
    pads = [pad(0, [0]), pad(1)];
    tick();
    assert.equal(calls.length, 2, 'nothing answers behind a dialog');
    modal = false;
    tick();
    assert.equal(calls.length, 2, 'a press held through the dialog does not land as a pick');

    pads = [pad(0), pad(1)];
    tick();
    pads = [pad(0, [2]), pad(1, [1])];      // X and B
    tick();
    assert.deepEqual(calls.slice(2), [['OnSplitHotkeyAsync', 'L', 1], ['OnSplitHotkeyAsync', 'R', 2]]);

    keys.unregister();
    assert.equal(frame, null, 'unregister stops the pad loop');
    assert.equal(listeners.has('keydown'), false);
    pads = [];
});
