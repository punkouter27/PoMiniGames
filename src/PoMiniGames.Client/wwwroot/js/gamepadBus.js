// gamepadBus.js — the one shared place a controller is read.
//
// Three users:
//   1. Engines. KeyBridge turns a pad into synthetic keydown/keyup for the key codes it is
//      holding (PoBrawl's model, moved here from pobrawl/gamepad.js unchanged), and the helpers
//      below (pressed, stick, rumble, ButtonEdges) are the polling, deadzone and edge detection
//      every engine was writing for itself.
//   2. The DOM. startNav() lets the D-pad or left stick move focus around the page (hub cards and
//      chips, dialog buttons, the TicTacToe and ConnectFive boards), A clicks what has focus and B
//      is Escape / back. It stays out of the canvas games, which read the pad themselves, unless
//      a modal (the intro card, a menu, the game-over sheet) is open over them.
//   3. impactBus.js. Once a pad is in use, window.PoGamepad.rumblePattern() plays the haptic
//      presets as dual-rumble on it, alongside navigator.vibrate. Every rumble from here goes
//      through impactBus's haptics gate (the Haptics setting, reduced haptics, duty caps).
//
// Loaded lazily: index.html imports this on the first `gamepadconnected`, so a player with no
// controller never fetches it. Engines that import it directly share the same module instance.

/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const BUTTONS = Object.freeze({
  south: 0, east: 1, west: 2, north: 3, lb: 4, rb: 5, lt: 6, rt: 7,
  select: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15,
});

export const supported = () => typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

/** A button counts as down when pressed, or an analogue trigger past half travel. */
export function pressed(pad, i) {
  const b = pad && pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

/** Connected pads in navigator order. Never throws (some browsers do, without a secure context). */
export function connectedPads() {
  if (!supported()) return [];
  let pads;
  try { pads = navigator.getGamepads(); } catch { return []; }
  const live = [];
  for (const p of pads || []) if (p && p.connected) live.push(p);
  return live;
}

/** Left (or right, stick = 1) stick with a radial deadzone, rescaled so the edge of it reads 0. */
export function stick(pad, deadzone = 0.25, which = 0) {
  const x = pad.axes[which * 2] || 0, y = pad.axes[which * 2 + 1] || 0;
  const m = Math.hypot(x, y);
  if (m <= deadzone) return { x: 0, y: 0 };
  const k = Math.min(1, (m - deadzone) / (1 - deadzone)) / m;
  return { x: x * k, y: y * k };
}

/**
 * Dual-rumble on one pad. Magnitudes 0..1. A no-op without a pad, or on a browser without
 * vibrationActuator (Firefox, Safari): rumble is garnish. Goes through impactBus's haptics gate
 * (the Haptics setting, reduced haptics, rate and duty caps) whenever that is loaded — it is, on
 * every page, from index.html. `opts`: { priority, ambient } (see impactBus.gateRumble).
 */
export function rumble(pad, strong, weak, ms, opts) {
  const act = pad && pad.vibrationActuator;
  if (!act || typeof act.playEffect !== 'function') return;
  const bus = typeof window !== 'undefined' ? window.PoImpact : null;
  if (bus && typeof bus.playRumble === 'function') { bus.playRumble(act, strong, weak, ms, opts); return; }
  try {
    act.playEffect('dual-rumble', {
      startDelay: 0,
      duration: Math.round(ms),
      strongMagnitude: Math.min(1, Math.max(0, strong)),
      weakMagnitude: Math.min(1, Math.max(0, weak)),
    }).catch(() => { /* a pad unplugged mid-effect */ });
  } catch { /* an actuator that throws instead of rejecting */ }
}

/** Button edge detection for one pad: update() returns the indices that went down this poll. */
export class ButtonEdges {
  constructor() { this.was = []; }
  update(pad) {
    const down = [];
    const n = pad ? pad.buttons.length : 0;
    for (let i = 0; i < n; i++) {
      const now = pressed(pad, i);
      if (now && !this.was[i]) down.push(i);
      this.was[i] = now;
    }
    this.was.length = n;
    return down;
  }
}

/**
 * A pad is not a new input path: each poll turns its state into the set of KEY CODES it is holding
 * and dispatches synthetic keydown/keyup for the difference, exactly as a touch panel would. So a
 * keyboard controller drives a pad with no code of its own, and rebinding a key rebinds the button.
 *
 * A pad only ever RELEASES codes it pressed itself, so a player on the keyboard and a pad on the
 * same layout do not cancel each other's held keys.
 */
export class KeyBridge {
  /**
   * @param {any[]} slots one key per pad slot (PoBrawl: the layout number); the first connected
   *   pad drives slots[0], the second slots[1].
   * @param {(pad: Gamepad, slot: any) => Set<string>} codesFor the key codes this pad holds now
   */
  constructor(slots, codesFor) {
    this.slots = slots;
    this.codesFor = codesFor;
    this.held = slots.map(() => new Set());
    this.padIndex = slots.map(() => -1); // navigator index currently driving each slot
    this.supported = supported();
  }

  poll() {
    if (!this.supported) return;
    const live = connectedPads();
    // Slots are sticky: a pad keeps its slot until IT disconnects. Re-deriving "the n-th live
    // pad" every poll moved player 2's pad onto player 1 mid-fight the moment pad 1 was pulled.
    // A pad plugged in mid-game takes the lowest free slot.
    const byIndex = new Map(live.map((p) => [p.index, p]));
    for (let s = 0; s < this.slots.length; s++) {
      if (this.padIndex[s] >= 0 && !byIndex.has(this.padIndex[s])) this.padIndex[s] = -1;
    }
    for (const pad of live) {
      if (this.padIndex.includes(pad.index)) continue;
      const free = this.padIndex.indexOf(-1);
      if (free < 0) break;
      this.padIndex[free] = pad.index;
    }
    for (let s = 0; s < this.slots.length; s++) {
      const pad = this.padIndex[s] >= 0 ? byIndex.get(this.padIndex[s]) : null;
      this._apply(s, pad ? this.codesFor(pad, this.slots[s]) : null);
    }
  }

  /**
   * Release every key the pads are holding (the engine paused, or the window lost focus). A pad
   * still held down presses its keys again on the next poll.
   */
  releaseAll() {
    for (let s = 0; s < this.held.length; s++) this._apply(s, null);
  }

  _apply(s, want) {
    const held = this.held[s];
    for (const code of [...held]) {
      if (want && want.has(code)) continue;
      held.delete(code);
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    }
    if (!want) return;
    for (const code of want) {
      if (held.has(code)) continue;
      held.add(code);
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
    }
  }

  /** True when a pad is driving `slot` right now. */
  hasPad(slot) {
    const s = this.slots.indexOf(slot);
    return s >= 0 && this.padIndex[s] >= 0;
  }

  /** Dual-rumble on the pad driving `slot` (a value from `slots`). */
  rumble(slot, strong, weak, ms, opts) {
    const s = this.slots.indexOf(slot);
    if (s < 0 || this.padIndex[s] < 0) return;
    let pad;
    try { pad = navigator.getGamepads()[this.padIndex[s]]; } catch { return; }
    rumble(pad, strong, weak, ms, opts);
  }

  dispose() {
    // Release everything so an engine disposed mid-hold does not leave a key stuck down.
    this.releaseAll();
  }
}

// ── DOM focus navigation ──────────────────────────────────────────────────

// Canvas games: their engines read the pad (or the keyboard) themselves, so outside a modal the
// D-pad is theirs. Everything else (hub, boards, quizzes, profile, leaderboards) is DOM.
const CANVAS_GAMES = /^\/(pobrawl|pocabinet|pocapitol|poecosystem|pojevarena|pomarblerace|pomule|poracer|povoxelstrike|sandplayground)(\/|$)/i;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const NAV_DEADZONE = 0.5;
const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 140;

let navRunning = false, raf = 0;
let activePadIndex = -1;
const edges = new Map();       // pad index → ButtonEdges
let heldDir = null, heldSince = 0, lastRepeat = 0;

const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
  || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

function topModal() {
  const open = [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].filter(visible);
  return open.length ? open[open.length - 1] : null;
}

/** Where the pad may move focus right now, or null when it belongs to a game. */
function navScope() {
  const modal = topModal();
  if (modal) return modal;
  if (CANVAS_GAMES.test(location.pathname)) return null;
  return document.querySelector('main') || document.body;
}

function candidates(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(visible);
}

function focusEl(el) {
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

/**
 * Spatial navigation: the nearest focusable in that direction, preferring ones that overlap the
 * current element across the axis (the next card in a row, the cell beside this one).
 */
function move(dir, scope) {
  const list = candidates(scope);
  if (!list.length) return;
  const cur = document.activeElement;
  if (!cur || cur === document.body || !scope.contains(cur) || !list.includes(cur)) {
    const auto = scope.querySelector('[autofocus]');
    focusEl(auto && list.includes(auto) ? auto : list[0]);
    return;
  }
  const a = cur.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const along = horizontal
      ? sign > 0 ? b.left - a.right : a.left - b.right
      : sign > 0 ? b.top - a.bottom : a.top - b.bottom;
    const centre = horizontal
      ? sign * ((b.left + b.right) - (a.left + a.right)) / 2
      : sign * ((b.top + b.bottom) - (a.top + a.bottom)) / 2;
    if (centre <= 2) continue;                       // not in that direction at all
    const overlap = horizontal
      ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const across = overlap > 0 ? 0 : -overlap;
    const score = Math.max(0, along) + across * 3 + (overlap > 0 ? 0 : 40);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusEl(best);
  else if (!horizontal && scope === (document.querySelector('main') || document.body)) {
    // Nothing further that way: scroll a long page instead.
    window.scrollBy({ top: sign * 240, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
}

function activate(scope) {
  const el = document.activeElement;
  if (!el || el === document.body || !scope.contains(el)) { move('down', scope); return; }
  el.click();
}

function back(modal) {
  if (modal) {
    if (modal.tagName === 'DIALOG') {
      if (typeof modal.requestClose === 'function') { modal.requestClose(); return; }
      const ev = new Event('cancel', { cancelable: true });
      if (modal.dispatchEvent(ev)) modal.close();
      return;
    }
    // An aria-modal overlay: the same Escape a keyboard player would press.
    const target = modal.contains(document.activeElement) ? document.activeElement : modal;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return;
  }
  if (location.pathname !== '/') history.back();
}

function padDir(pad) {
  const s = stick(pad, NAV_DEADZONE);
  if (pressed(pad, BUTTONS.up) || s.y < -0.01 && Math.abs(s.y) >= Math.abs(s.x)) return 'up';
  if (pressed(pad, BUTTONS.down) || s.y > 0.01 && Math.abs(s.y) >= Math.abs(s.x)) return 'down';
  if (pressed(pad, BUTTONS.left) || s.x < -0.01) return 'left';
  if (pressed(pad, BUTTONS.right) || s.x > 0.01) return 'right';
  return null;
}

function markPadInput() {
  if (document.documentElement.dataset.input !== 'pad') document.documentElement.dataset.input = 'pad';
}

function navFrame(now) {
  raf = 0;
  const pads = connectedPads();
  if (!pads.length) { navRunning = false; return; }
  raf = requestAnimationFrame(navFrame);
  if (document.hidden) return;

  let dir = null, a = false, b = false;
  for (const pad of pads) {
    let e = edges.get(pad.index);
    if (!e) edges.set(pad.index, e = new ButtonEdges());
    const down = e.update(pad);
    const d = padDir(pad);
    if (down.length || d) activePadIndex = pad.index;
    dir = dir || d;
    if (down.includes(BUTTONS.south)) a = true;
    if (down.includes(BUTTONS.east)) b = true;
  }

  const scope = navScope();
  if (!scope) { heldDir = null; return; }
  if (dir || a || b) markPadInput();

  if (dir !== heldDir) {
    heldDir = dir; heldSince = lastRepeat = now;
    if (dir) move(dir, scope);
  } else if (dir && now - heldSince >= REPEAT_FIRST_MS && now - lastRepeat >= REPEAT_MS) {
    lastRepeat = now;
    move(dir, scope);
  }
  if (a) activate(scope);
  if (b) back(topModal());
}

function ensureLoop() {
  if (navRunning || !connectedPads().length) return;
  navRunning = true;
  raf = requestAnimationFrame(navFrame);
}

/** The pad last used, else the first connected one, else null. */
export function activePad() {
  const pads = connectedPads();
  return pads.find((p) => p.index === activePadIndex) || pads[0] || null;
}

/**
 * impactBus's phone patterns ([on, off, on, …] ms) played on the active pad. One effect rather
 * than a timer chain: the first pulse sets the weight (a longer pulse leans on the strong, low
 * motor) and the pattern's length the duration, so no queued pulse can outlive a gate check (the
 * Haptics setting switched off mid-pattern).
 */
export function rumblePattern(pattern) {
  const pad = activePad();
  if (!pad || !Array.isArray(pattern) || !pattern.length) return;
  const first = Math.max(0, pattern[0] || 0);
  const total = pattern.reduce((a, ms) => a + Math.max(0, ms || 0), 0);
  rumble(pad, Math.min(1, first / 60), Math.min(1, 0.35 + first / 80), Math.max(30, Math.min(total, 400)));
}

/** Start the DOM navigation and publish window.PoGamepad. Safe to call more than once. */
export function startNav() {
  if (typeof window === 'undefined' || window.PoGamepad) { ensureLoop(); return; }
  window.PoGamepad = { rumblePattern, activePad };
  // Focus rings: a programmatic focus is not always :focus-visible, so a pad user gets one here.
  const style = document.createElement('style');
  style.textContent = 'html[data-input="pad"] :focus{outline:3px solid #38bdf8 !important;outline-offset:3px !important;}';
  document.head.appendChild(style);
  // The mouse or a real key takes over again.
  const off = () => { if (document.documentElement.dataset.input === 'pad') delete document.documentElement.dataset.input; };
  window.addEventListener('pointerdown', off, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => { if (e.isTrusted) off(); }, { capture: true, passive: true });
  window.addEventListener('gamepadconnected', ensureLoop);
  window.addEventListener('gamepaddisconnected', (e) => {
    edges.delete(e.gamepad?.index);
    if (e.gamepad?.index === activePadIndex) activePadIndex = -1;
  });
  ensureLoop();
}
