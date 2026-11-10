// game-debug.js — the one Tab-to-see-diagnostics gesture every game shares.
//
// <GameDebugOverlay /> (rendered by GameShell) calls start(ref). From then on:
//   • Tab toggles the panel — but only while the player is IN the game. While a
//     dialog, the intro card or a form control has focus, Tab stays the browser's
//     focus mover, so keyboard navigation is never swallowed.
//   • Escape closes it.
//   • While open, a rAF loop measures frame rate and reports it back once per
//     ~500 ms so the panel can show live numbers without one interop call per frame.
//
// Single instance: the game shell unmounts before the next one mounts, and
// start() simply adopts the newest owner.

(function () {
  const SAMPLE_MS = 500;
  const INTERACTIVE = 'input, textarea, select, button, a[href], [contenteditable="true"]';

  let dotnetRef = null;
  let open = false;
  let raf = 0;
  let last = 0;
  let frames = 0;
  let elapsed = 0;

  function isPlaying() {
    // A modal dialog, the start card or the end card is up: Tab must move focus there.
    if (document.querySelector('dialog[open], .gps-intro-overlay')) return false;

    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return true;
    // Chrome around the game (top bar, header slot) keeps its own keyboard behaviour.
    if (el.closest && el.closest('.main-nav, header.topbar, .gps-header-slot')) return false;
    if (el.matches && el.matches(INTERACTIVE)) return false;
    return !!(el.closest && el.closest('.gps-game-area, .gps-shell'));
  }

  function tick(now) {
    if (!open) { raf = 0; return; }
    if (last) {
      const delta = now - last;
      if (delta < 1000) { // ignore the gap left by a hidden tab
        frames++;
        elapsed += delta;
        if (elapsed >= SAMPLE_MS) {
          const fps = frames * 1000 / elapsed;
          const frameMs = elapsed / frames;
          frames = 0;
          elapsed = 0;
          try { dotnetRef.invokeMethodAsync('OnSample', fps, frameMs); } catch { /* gone */ }
        }
      }
    }
    last = now;
    raf = requestAnimationFrame(tick);
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    last = 0;
    frames = 0;
    elapsed = 0;
    if (open && !raf) raf = requestAnimationFrame(tick);
    try { dotnetRef.invokeMethodAsync('OnToggle', open); } catch { /* gone */ }
  }

  function onKeyDown(e) {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.defaultPrevented) return; // a game already claimed Tab (PoEcosystem, PoJevArena)
    if (!isPlaying()) return;
    e.preventDefault();
    setOpen(!open);
  }

  function onKeyUp(e) {
    if (e.key === 'Escape' && open) setOpen(false);
  }

  window.poGameDebug = {
    start(ref) {
      dotnetRef = ref;
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
    },
    stop() {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      open = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      dotnetRef = null;
    },
    // One-shot environment read for the panel's static rows.
    env() {
      const mem = performance.memory;
      return {
        heapMb: mem ? mem.usedJSHeapSize / 1048576 : -1,
        cores: navigator.hardwareConcurrency || 0,
        dpr: window.devicePixelRatio || 1,
        width: window.innerWidth,
        height: window.innerHeight
      };
    }
  };
})();
