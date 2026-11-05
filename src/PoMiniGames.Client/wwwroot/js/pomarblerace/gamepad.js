// gamepad.js — controller steering for the marble race, and which input the player is using.
//
// Steering: the left stick or the D-pad held left/right is the same held steer as ←/→, fed through
// Game.setSteer so the online guest's relay and the host's physics see no difference. Polled on
// its own rAF loop (the engine's loop is gated while the intro is up; this one only acts once a
// game exists and is racing). Shared polling and deadzone come from ../gamepadBus.js.
//
// Input kind: the page shows hints for the device in hand ('keys' | 'touch' | 'pad'). The last
// device used wins and is reported to the page on change (OnInputKind).
import { connectedPads, stick, pressed, BUTTONS } from '../gamepadBus.js';

const STICK_ON = 0.45;   // stick x past this holds a direction (a little hysteresis below)
const STICK_OFF = 0.3;

let raf = 0;
let held = 0;            // direction the pad is holding now: -1, 0, +1
let reportKind = null;   // (kind) => void, set by watchInput
let lastKind = '';

function setKind(kind) {
  if (kind === lastKind) return;
  lastKind = kind;
  if (reportKind) reportKind(kind);
}

/** Poll the first connected pad each frame and steer `getGame()`'s marble. Idempotent. */
export function startPad(getGame) {
  if (raf) return;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const pad = connectedPads()[0];
    let dir = 0;
    if (pad) {
      const x = stick(pad).x;
      const thresh = held ? STICK_OFF : STICK_ON;
      if (pressed(pad, BUTTONS.left) || x < -thresh) dir = -1;
      else if (pressed(pad, BUTTONS.right) || x > thresh) dir = 1;
      if (dir || pad.buttons.some((b) => b.pressed)) setKind('pad');
    }
    if (dir === held) return;
    const game = getGame();
    if (game) {
      if (held) game.setSteer(held, false);
      if (dir) game.setSteer(dir, true);
    }
    held = dir;
  };
  raf = requestAnimationFrame(loop);
}

export function stopPad() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  held = 0;
}

const onKey = () => setKind('keys');
// Only a touch switches to touch hints. A mouse click says nothing about how you steer (a touch
// laptop's player still steers with keys), so it leaves the kind alone.
const onPointer = (e) => { if (e.pointerType === 'touch' || e.pointerType === 'pen') setKind('touch'); };

/**
 * Report the input kind in use to `cb`, now and on every change. The first guess comes from the
 * pointer type: a coarse pointer is a touch screen until a key or a pad says otherwise.
 */
export function watchInput(cb) {
  unwatchInput();
  reportKind = cb;
  lastKind = '';
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onPointer, true);
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  setKind(connectedPads().length ? 'pad' : coarse ? 'touch' : 'keys');
}

export function unwatchInput() {
  reportKind = null;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('pointerdown', onPointer, true);
}
