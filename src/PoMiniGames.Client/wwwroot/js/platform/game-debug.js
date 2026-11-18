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
//
// Pop-out: popout() opens debug-window.html, a separate developer window. Each sample is also
// posted on the 'po-debug' BroadcastChannel; while a pop-out says hello (every second) the
// sampler keeps running even with the in-page panel closed. It needs no game: /diag opens it
// too, and then it shows the page's own frame rate and environment.

(function () {
  const FIRST_SAMPLE_MS = 120;
  const SAMPLE_MS = 500;
  const INTERACTIVE = 'input, textarea, select, button, a[href], [contenteditable="true"]';

  let dotnetRef = null;
  let open = false;
  let raf = 0;
  let last = 0;
  let frames = 0;
  let elapsed = 0;
  let firstSample = true;
  let info = { gameKey: null, items: [] };   // pushed by GameDebugOverlay (setInfo)
  let watcherSeenAt = 0;                      // last hello from a pop-out window
  const WATCHER_TTL_MS = 3000;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('po-debug') : null;

  function watched() { return watcherSeenAt > 0 && Date.now() - watcherSeenAt < WATCHER_TTL_MS; }
  function sampling() { return open || watched(); }
  function ensureLoop() { if (sampling() && !raf) { last = 0; raf = requestAnimationFrame(tick); } }

  if (channel) {
    channel.onmessage = (e) => {
      const type = e.data && e.data.type;
      if (type === 'hello') { watcherSeenAt = Date.now(); ensureLoop(); }
      else if (type === 'bye') watcherSeenAt = 0;
    };
  }

  function env() {
    const mem = performance.memory;
    return {
      heapMb: mem ? mem.usedJSHeapSize / 1048576 : -1,
      cores: navigator.hardwareConcurrency || 0,
      dpr: window.devicePixelRatio || 1,
      width: window.innerWidth,
      height: window.innerHeight,
      details: window.poGameStatsDetails || []
    };
  }

  function broadcast(fps, frameMs) {
    if (!channel || !watched()) return;
    try {
      channel.postMessage({
        type: 'sample', fps, frameMs, env: env(),
        route: location.pathname + location.search,
        title: document.title, online: navigator.onLine,
        gameKey: info.gameKey, items: info.items
      });
    } catch { /* a detail that cannot be cloned: skip this sample */ }
  }

  function isPlaying() {
    // A modal dialog, the start card or the end card is up: Tab must move focus there.
    if (document.querySelector('dialog[open], .gps-intro-overlay, [aria-modal="true"]')) return false;

    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return true;
    // Chrome around the game (top bar, header slot) keeps its own keyboard behaviour.
    if (el.closest && el.closest('.main-nav, header.topbar, .gps-header-slot')) return false;
    // The diagnostics pill and the panel itself are ours: Tab opened it, so Tab has to
    // close it again even though a click left focus on a <button>.
    if (el.closest && el.closest('.gps-stats-toggle, .gps-debug')) return true;
    if (el.matches && el.matches(INTERACTIVE)) return false;
    return !!(el.closest && el.closest('.gps-game-area, .gps-shell'));
  }

  function tick(now) {
    if (!sampling()) { raf = 0; return; }
    if (last) {
      const delta = now - last;
      if (delta < 1000) { // ignore the gap left by a hidden tab
        frames++;
        elapsed += delta;
        if (elapsed >= (firstSample ? FIRST_SAMPLE_MS : SAMPLE_MS)) {
          const fps = frames * 1000 / elapsed;
          const frameMs = elapsed / frames;
          frames = 0;
          elapsed = 0;
          firstSample = false;
          if (open && dotnetRef) { try { dotnetRef.invokeMethodAsync('OnSample', fps, frameMs); } catch { /* gone */ } }
          broadcast(fps, frameMs);
        }
      }
    }
    last = now;
    raf = requestAnimationFrame(tick);
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    window.poGameStatsOpen = open;
    // Pages can keep their own HUD behind Tab with `:root.po-game-stats-open` (Brawl FFA does).
    document.documentElement.classList.toggle('po-game-stats-open', open);
    window.dispatchEvent(new CustomEvent('po-game-stats', { detail: { open } }));
    last = 0;
    frames = 0;
    elapsed = 0;
    firstSample = true;
    ensureLoop();
    if (dotnetRef) { try { dotnetRef.invokeMethodAsync('OnToggle', open); } catch { /* gone */ } }
  }

  function onKeyDown(e) {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
    if (e.defaultPrevented) return; // a game already claimed Tab (PoEcosystem)
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
      window.poGameStatsOpen = false;
      document.documentElement.classList.remove('po-game-stats-open');
      window.dispatchEvent(new CustomEvent('po-game-stats', { detail: { open: false } }));
      if (raf && !watched()) { cancelAnimationFrame(raf); raf = 0; }
      dotnetRef = null;
      info = { gameKey: null, items: [] };
    },
    toggle() {
      if (dotnetRef) setOpen(!open);
    },
    // One-shot environment read for the panel's static rows.
    env,
    // The overlay's own rows (game key, the page's Diagnostics items), for the pop-out.
    setInfo(gameKey, items) {
      info = { gameKey: gameKey || null, items: Array.isArray(items) ? items : [] };
    },
    // The separate developer window. Returns false when the browser blocked the pop-up.
    popout() {
      const w = window.open('debug-window.html', 'po-debug-window', 'popup,width=420,height=560');
      if (!w) return false;
      watcherSeenAt = Date.now();
      ensureLoop();
      return true;
    }
  };
})();
