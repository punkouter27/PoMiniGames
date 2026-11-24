// ui-fx.js — the marble race page's micro-interactions, mounted for the life of the page (index.js
// watchInput / unwatchInput):
//
//   #1 view transitions: the page asks for one before a big state change (the intro closing, the
//      end card opening) and says when Blazor has rendered the new state. The intro card zooms
//      away through the track glyph; the HUD standings chip flies into the end card's podium.
//   #5 buttons: a ripple from where the finger or pointer went down, and a sheen that sweeps the
//      button once as the pointer arrives (the app's own data-spring press still applies).
//   #6 the podium cards tilt toward the pointer with a highlight that follows it.
//
// One stylesheet, injected once and only active under `html[data-mr-vt]` for the transition rules.

const STYLE_ID = 'mr-ui-fx-style';
const CSS = `
.mr-rip { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; z-index: 0; }
.mr-rip-dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.55) 0%, rgba(255, 255, 255, 0.18) 55%, transparent 70%);
  transform: scale(0); animation: mr-rip 560ms cubic-bezier(.2,.7,.3,1) forwards; }
@keyframes mr-rip { to { transform: scale(var(--s, 30)); opacity: 0; } }
.mr-rip-sheen { position: absolute; top: -20%; bottom: -20%; width: 40%; left: -50%;
  background: linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.28) 50%, transparent 100%);
  transform: skewX(-18deg); animation: mr-sheen 640ms cubic-bezier(.4,0,.2,1) forwards; }
@keyframes mr-sheen { to { left: 130%; } }
html[data-mr-vt] { view-transition-name: root; }
html[data-mr-vt="intro"]::view-transition-old(root) { animation: mr-vt-out 520ms cubic-bezier(.4,0,.2,1) both; }
html[data-mr-vt="intro"]::view-transition-new(root) { animation: mr-vt-in 520ms cubic-bezier(.2,.8,.2,1) both; }
html[data-mr-vt="intro"]::view-transition-old(mr-hero) { animation: mr-vt-hero 520ms cubic-bezier(.5,0,.75,0) both; }
html[data-mr-vt="result"]::view-transition-group(mr-standings) { animation-duration: 560ms; animation-timing-function: cubic-bezier(.2,.8,.2,1); }
html[data-mr-vt="result"]::view-transition-new(root) { animation: mr-vt-in 420ms ease both; }
@keyframes mr-vt-out { to { opacity: 0; transform: scale(1.06); filter: blur(6px); } }
@keyframes mr-vt-in { from { opacity: 0; transform: scale(0.985); } }
@keyframes mr-vt-hero { to { opacity: 0; transform: scale(9); } }
@media (prefers-reduced-motion: reduce) {
  .mr-rip { display: none; }
}`;

const BUTTONS = '.gps-intro-card button, .mr-wrap button, .mr-settings button, .mr-result button, .gps-gameover button, dialog button';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let mounted = false;
let tiltCard = null;
let vtResolve = null;
let vtTimer = 0;

function hostFor(btn) {
  let host = btn.querySelector(':scope > .mr-rip');
  if (!host) {
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    host = document.createElement('span');
    host.className = 'mr-rip';
    host.setAttribute('aria-hidden', 'true');
    btn.appendChild(host);
  }
  return host;
}

function onDown(e) {
  if (reducedMotion()) return;
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (!btn || btn.disabled || !btn.closest(BUTTONS.replace(/ button/g, ''))) return;
  const r = btn.getBoundingClientRect();
  const host = hostFor(btn);
  const dot = document.createElement('span');
  dot.className = 'mr-rip-dot';
  dot.style.left = `${e.clientX - r.left}px`;
  dot.style.top = `${e.clientY - r.top}px`;
  // big enough to cover the button from wherever it started
  dot.style.setProperty('--s', String(Math.ceil((Math.hypot(r.width, r.height) * 2.2) / 12)));
  host.appendChild(dot);
  setTimeout(() => dot.remove(), 600);
}

function onOver(e) {
  if (reducedMotion()) return;
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (!btn || btn.disabled || !btn.closest(BUTTONS.replace(/ button/g, ''))) return;
  if (e.relatedTarget instanceof Node && btn.contains(e.relatedTarget)) return;   // moving within it
  const now = performance.now();
  if (now - (btn.__mrSheen || 0) < 900) return;
  btn.__mrSheen = now;
  const host = hostFor(btn);
  const sh = document.createElement('span');
  sh.className = 'mr-rip-sheen';
  host.appendChild(sh);
  setTimeout(() => sh.remove(), 700);
}

function onMove(e) {
  const card = e.target instanceof Element ? e.target.closest('.mr-podium-card') : null;
  if (tiltCard && tiltCard !== card) {
    tiltCard.style.removeProperty('--rx');
    tiltCard.style.removeProperty('--ry');
    tiltCard.classList.remove('is-tilt');
    tiltCard = null;
  }
  if (!card || reducedMotion() || e.pointerType === 'touch') return;
  const r = card.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  card.style.setProperty('--rx', `${((0.5 - y) * 14).toFixed(2)}deg`);
  card.style.setProperty('--ry', `${((x - 0.5) * 18).toFixed(2)}deg`);
  card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
  card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  card.classList.add('is-tilt');
  tiltCard = card;
}

export function mountUiFx() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointermove', onMove, { passive: true });
}

export function unmountUiFx() {
  if (!mounted) return;
  mounted = false;
  document.removeEventListener('pointerdown', onDown, true);
  document.removeEventListener('pointerover', onOver, true);
  document.removeEventListener('pointermove', onMove);
  viewTransitionDone();
}

/**
 * Start a view transition of kind 'intro' | 'result'. Resolves once the browser has captured the
 * old state, so the caller can render the new one; viewTransitionDone() (or a 700 ms guard) ends
 * the update. A no-op without the API, under reduced motion, or while one is already running.
 */
export function viewTransition(kind) {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function' || reducedMotion() || vtResolve) {
    return Promise.resolve();
  }
  return new Promise((captured) => {
    const done = new Promise((r) => { vtResolve = r; });
    document.documentElement.dataset.mrVt = kind;
    let t;
    try {
      t = document.startViewTransition(() => { captured(); return done; });
    } catch {
      delete document.documentElement.dataset.mrVt;
      vtResolve = null;
      captured();
      return;
    }
    vtTimer = setTimeout(viewTransitionDone, 700);
    const clear = () => { delete document.documentElement.dataset.mrVt; };
    t.finished.then(clear, clear);
    // a transition the browser skips never calls the update: let the caller go on regardless
    t.ready.catch(() => { captured(); viewTransitionDone(); });
  });
}

/** Blazor rendered the new state: let the transition animate to it. */
export function viewTransitionDone() {
  clearTimeout(vtTimer);
  const r = vtResolve;
  vtResolve = null;
  if (r) requestAnimationFrame(() => r());
}
