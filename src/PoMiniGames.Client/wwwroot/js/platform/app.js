// Hub launches (same-document card-to-title morph), account-menu keys, the Ecosystem save
// probe, and the WebGL2 capability probe. Progressive enhancement throughout: every piece
// falls through to plain behaviour where the browser lacks the API.
(function () {
  'use strict';

  function motionOff() {
    var root = document.documentElement;
    if (root.getAttribute('data-motion') === 'reduce' || root.getAttribute('data-gfx') === 'low') return true;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  // Resolve once `.gps-game-title` (GameShell's heading, projected into the top bar) is in the
  // DOM, or after `ms`. A MutationObserver and a timer, not requestAnimationFrame: rendering is
  // paused while a view transition's update callback runs, so rAF would never fire in here.
  function waitForTitle(ms) {
    return new Promise(function (resolve) {
      var found = document.querySelector('.gps-game-title');
      if (found) { resolve(found); return; }
      var done = false;
      var finish = function (el) {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      };
      var observer = new MutationObserver(function () {
        var el = document.querySelector('.gps-game-title');
        if (el) finish(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      var timer = setTimeout(function () { finish(null); }, ms);
    });
  }

  // ----- 1. Hub launches: in-app navigation wrapped in a same-document view transition -----
  // The hub used to turn these links into full document loads so a cross-document transition
  // could carry the card to a boot splash, which rebooted the whole WASM runtime on every game
  // launch. Now Blazor's router swaps the page in place, inside startViewTransition: the pressed
  // card's heading is named `po-hero` in the old state and the game's title in the new one, so
  // the browser morphs one into the other. Without the API, or with motion reduced, it is a
  // plain in-app navigation.
  // BrowserViewport.cs reads the width here. It used JS eval, which the CSP (no
  // 'unsafe-eval') refuses, so IsNarrow was false on every phone.
  window.PoViewport = { width: function () { return window.innerWidth || 0; } };

  window.PoHubNav = {
    go: function (href, hero) {
      var navigate = function () { window.Blazor.navigateTo(href); };
      if (!document.startViewTransition || motionOff()) { navigate(); return; }

      var root = document.documentElement;
      var title = null;
      if (hero) hero.style.viewTransitionName = 'po-hero';
      // Item 18: the card's frame is a second shared element. Its snapshot (border, fill, accent)
      // grows into the game's play area, so the card itself becomes the stage rather than just
      // lending its heading. Cards without a frame (the hero is a bare [data-hero]) keep the
      // edge wipe.
      var card = hero && hero.closest ? hero.closest('.home-card') : null;
      var area = null;
      if (card) { card.style.viewTransitionName = 'po-card'; root.setAttribute('data-hero-card', ''); }
      // The top bar is the one HUD surface both pages share. Named on its own it is
      // captured apart from the page, so it holds still while the page wipes under it
      // instead of cross-fading with itself (po-motion.css).
      var hud = document.querySelector('.gl-top-bar');
      if (hud) hud.style.viewTransitionName = 'po-hud';
      // The new page wipes in from the edge nearest the pressed card, so the wipe and
      // the card's flight into the title travel the same way (po-motion.css).
      var r = hero && hero.getBoundingClientRect ? hero.getBoundingClientRect() : null;
      var fromRight = !!r && (r.left + r.width / 2) > window.innerWidth / 2;
      root.setAttribute('data-hero-dir', fromRight ? 'rtl' : 'ltr');
      // routeFx's colour wipe and vortex would play on top of the morph; routeFx stands
      // them down while this attribute is set, and app-shell.css hides the layer.
      root.setAttribute('data-hero-nav', '');
      var transition = document.startViewTransition(function () {
        if (hero) hero.style.viewTransitionName = '';
        if (card) card.style.viewTransitionName = '';
        navigate();
        return waitForTitle(450).then(function (el) {
          title = el;
          if (title) title.style.viewTransitionName = 'po-hero';
          area = card ? document.querySelector('.gps-game-area') : null;
          if (area) area.style.viewTransitionName = 'po-card';
        });
      });
      var cleanup = function () {
        if (title) title.style.viewTransitionName = '';
        if (hero) hero.style.viewTransitionName = '';
        if (card) card.style.viewTransitionName = '';
        if (area) area.style.viewTransitionName = '';
        root.removeAttribute('data-hero-card');
        if (hud) hud.style.viewTransitionName = '';
        root.removeAttribute('data-hero-nav');
        root.removeAttribute('data-hero-dir');
      };
      transition.finished.then(cleanup, cleanup);
      // One low-volume rising sweep as the morph starts: the transition's sound, timed
      // to the frame the animation actually begins rather than to the click.
      transition.ready.then(function () {
        try { window.PoUiAudio && window.PoUiAudio.playSweep(330, 660, 320, 0.03, 'sine'); } catch (_) { /* audio is a garnish */ }
      }, function () { /* skipped: the navigation still happened */ });
    }
  };

  // Capture phase, so this runs before Blazor's own link handling, which stands down for a
  // click whose default is already prevented. Blazor's @onclick handlers still run: nothing
  // here stops propagation.
  window.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href^="/"][data-hub-nav]');
    if (!link) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target && link.target !== '_self') return;
    if (!window.Blazor || typeof window.Blazor.navigateTo !== 'function') return;
    e.preventDefault();
    var card = link.closest('.home-card');
    var hero = (card && card.querySelector('.home-card-head')) || link.querySelector('[data-hero]');
    window.PoHubNav.go(link.getAttribute('href'), hero);
  }, true);

  // ----- 2. Account menu keys (role="menu") -----
  // A menu promises arrow-key movement. The panel is a native popover, which already gives
  // Escape and light-dismiss; this adds focus-on-open and Up/Down/Home/End.
  function menuItems(menu) {
    return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
  }

  document.addEventListener('toggle', function (e) {
    var menu = e.target;
    if (!menu || !menu.matches || !menu.matches('[popover][role="menu"]') || e.newState !== 'open') return;
    var items = menuItems(menu);
    var current = menu.querySelector('[aria-current="page"]');
    (current || items[0] || menu).focus();
  }, true);

  document.addEventListener('keydown', function (e) {
    var menu = e.target.closest && e.target.closest('[popover][role="menu"]');
    if (!menu) return;
    var items = menuItems(menu);
    if (!items.length) return;
    var i = items.indexOf(document.activeElement);
    var next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });

  // ----- 3. WebGL2 + device capability probe (callable from Blazor) -----
  // Gates the home page ambient particle field. Skips WebGL entirely on
  // low-memory devices, when prefers-reduced-motion is set, or when WebGL2
  // is unavailable. Returns a boolean — caller falls back to the CSS gradient.
  window.probeWebGL2 = function () {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return false;
      }
      // Mobile-portrait battery guard: the ambient particle field is purely
      // decorative chrome behind the game list. On portrait phones it's GPU/battery
      // cost with little payoff, so fall back to the (already frozen <=768px) CSS
      // gradient there instead of waking the GPU render loop.
      if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) {
        return false;
      }
      var mem = navigator.deviceMemory || 4;
      if (mem < 4) return false;
      var c = document.createElement('canvas');
      var gl = c.getContext && c.getContext('webgl2');
      if (!gl) return false;
      // Hand the probe's context straight back: the browser caps live contexts.
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (_) {
      return false;
    }
  };

  // `po-awake` on <html> while the viewer is active (any pointer or key in the last 3 s).
  // The demo reel's control bar fades without it, so it stops covering the game.
  var awakeTimer = 0;
  function wake() {
    document.documentElement.classList.add('po-awake');
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(function () {
      document.documentElement.classList.remove('po-awake');
    }, 3000);
  }
  ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
    window.addEventListener(type, wake, { passive: true, capture: true });
  });
  wake();

})();
