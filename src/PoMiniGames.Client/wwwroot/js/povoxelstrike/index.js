// index.js — public interop surface for PoVoxelStrike. The Blazor page calls these
// through window.PoVoxelStrike after awaiting loadEngine('povoxelstrike').

import { Engine } from './game.js';
import { loadAssets } from './assets.js';
import { loadSettings, saveSettings } from './settings.js';

let engine = null;
// Monotonic token for the in-flight start(): assets are fetched over the network, so two
// starts can overlap (navigate away and back) and the slower one must not install its
// Engine over the newer one's. Same pattern as PoMarbleRace's map fetch.
let startToken = 0;
// Decoded voxel volumes, kept for the life of the page visit. Every start() after the
// first — "Play again", a different seed, the squad's arena — costs one world build, not a
// manifest fetch and a decode. stop() drops it, so a later visit sees late-ingested assets.
let volumesPromise = null;

// ── Synthesized UI micro-sounds & cinematic DOM helpers (#19, #20) ───────────
let _lastHoverSound = 0;
let _lastTickSound = 0;
let _uiListenersInstalled = false;

function isReducedMotion() {
  try {
    if (document.documentElement?.dataset?.motion === 'reduce') return true;
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch {
    return false;
  }
}

/**
 * Synthesize lightweight UI micro-sounds on the shared PoAudioBus ('ui' / 'sfx' stage)
 * so global mute and volume settings apply automatically.
 */
function playUiSound(kind, step = 0) {
  try {
    const bus = window.PoAudioBus;
    if (!bus || bus.isMuted?.()) return;
    const ctx = bus.contextSync?.();
    const dest = bus.busSync?.('ui') || bus.busSync?.('sfx');
    if (!ctx || !dest) {
      bus.context?.().catch?.(() => { });
      return;
    }
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => { });
    const now = ctx.currentTime;
    const wall = performance.now();

    if (kind === 'hover') {
      if (wall - _lastHoverSound < 42) return;
      _lastHoverSound = wall;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1380, now);
      osc.frequency.exponentialRampToValueAtTime(1860, now + 0.018);
      gain.gain.setValueAtTime(0.038, now);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.02);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.022);
    } else if (kind === 'click') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(760, now);
      osc.frequency.exponentialRampToValueAtTime(340, now + 0.035);
      gain.gain.setValueAtTime(0.085, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.038);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (kind === 'launch') {
      // Siege launch: low stone thud + warm brass fifth + metallic lock click.
      const freqs = [110, 165, 660];
      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = idx === 2 ? 'triangle' : 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        osc.frequency.exponentialRampToValueAtTime(idx === 2 ? f * 1.35 : f * 0.72, now + 0.22);
        const peak = idx === 0 ? 0.14 : idx === 1 ? 0.09 : 0.06;
        gain.gain.setValueAtTime(peak, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
        osc.connect(gain).connect(dest);
        osc.start(now);
        osc.stop(now + 0.25);
      });
    } else if (kind === 'pause') {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(420, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.16);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, now);
      filter.frequency.exponentialRampToValueAtTime(220, now + 0.16);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      osc.connect(filter).connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (kind === 'resume') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(920, now + 0.17);
      gain.gain.setValueAtTime(0.095, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.19);
    } else if (kind === 'tick') {
      if (wall - _lastTickSound < 48) return;
      _lastTickSound = wall;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const pitch = Math.min(1900, 920 + step * 38);
      osc.frequency.setValueAtTime(pitch, now);
      osc.frequency.exponentialRampToValueAtTime(pitch * 1.12, now + 0.02);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.024);
      osc.connect(gain).connect(dest);
      osc.start(now);
      osc.stop(now + 0.026);
    } else if (kind === 'medal') {
      [587.33, 880].forEach((f, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        const t0 = now + idx * 0.055;
        osc.frequency.setValueAtTime(f, t0);
        gain.gain.setValueAtTime(0.08, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
        osc.connect(gain).connect(dest);
        osc.start(t0);
        osc.stop(t0 + 0.23);
      });
    }
  } catch { /* audio never blocks UI */ }
}

/**
 * Spawn a transient grid of tumbling voxel tiles over the arena host when the start card
 * dissolves into active play (#20). Runs after engine.enter() so Pointer Lock is already
 * requested synchronously inside the click gesture.
 */
function spawnVoxelDissolve(host) {
  if (!host || isReducedMotion()) return;
  try {
    host.querySelector('.pvs-voxel-dissolve')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'pvs-voxel-dissolve';
    wrap.setAttribute('aria-hidden', 'true');
    const cols = 8;
    const rows = 5;
    const shades = [
      'rgba(30, 41, 59, 0.92)',
      'rgba(51, 65, 85, 0.88)',
      'rgba(71, 85, 105, 0.86)',
      'rgba(232, 161, 28, 0.78)',
      'rgba(15, 23, 42, 0.94)',
    ];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('span');
        cell.className = 'pvs-voxel-cell';
        const nx = (c + 0.5) / cols - 0.5;
        const ny = (r + 0.5) / rows - 0.5;
        const dist = Math.hypot(nx, ny);
        const dx = (nx * 180 + (Math.random() - 0.5) * 36).toFixed(1);
        const dy = (ny * 150 + 48 + Math.random() * 40).toFixed(1);
        const rz = ((nx * 95) + (Math.random() - 0.5) * 50).toFixed(1);
        const delay = (dist * 140 + Math.random() * 45).toFixed(0);
        const shade = shades[(r * cols + c) % shades.length];
        cell.style.setProperty('--dx', `${dx}px`);
        cell.style.setProperty('--dy', `${dy}px`);
        cell.style.setProperty('--rz', `${rz}deg`);
        cell.style.setProperty('--delay', `${delay}ms`);
        cell.style.setProperty('--voxel-bg', shade);
        wrap.appendChild(cell);
      }
    }
    host.appendChild(wrap);
    setTimeout(() => wrap.remove(), 680);
  } catch { /* non-critical visual */ }
}

function triggerIrisResume(host) {
  if (!host || isReducedMotion()) return;
  host.classList.remove('pvs-iris-opening');
  // Force style recalc so repeated resumes replay the circular clip-path wipe.
  void host.offsetWidth;
  host.classList.add('pvs-iris-opening');
  setTimeout(() => host.classList.remove('pvs-iris-opening'), 540);
}

/**
 * Delegated pointer tracking for button/card 3D tilt (--tx, --ty), radial ripple origin
 * (--rx, --ry), and hover/press micro-sounds (#19).
 */
function installUiMicroInteractions() {
  if (_uiListenersInstalled || typeof document === 'undefined') return;
  _uiListenersInstalled = true;

  const interactiveSel = '.pvs-btn, .pvs-hud-btn, .pvs-start .gps-intro-ok, .pvs-start .app-seg__btn, .pvs-tile';
  const buttonSel = '.pvs-btn, .pvs-hud-btn, .pvs-start .gps-intro-ok, .pvs-start .app-seg__btn';

  document.addEventListener('pointermove', (e) => {
    const el = e.target?.closest?.(interactiveSel);
    if (!el || isReducedMotion()) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    el.style.setProperty('--rx', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--ry', `${(py * 100).toFixed(1)}%`);
    el.style.setProperty('--tx', `${((0.5 - py) * 7).toFixed(2)}deg`);
    el.style.setProperty('--ty', `${((px - 0.5) * 7).toFixed(2)}deg`);
  }, { passive: true });

  document.addEventListener('pointerover', (e) => {
    const btn = e.target?.closest?.(buttonSel);
    if (!btn || btn.contains(e.relatedTarget)) return;
    playUiSound('hover');
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    const btn = e.target?.closest?.(buttonSel);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      btn.style.setProperty('--rx', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
      btn.style.setProperty('--ry', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
    }
    if (!btn.classList.contains('gps-intro-ok')) playUiSound('click');
  }, { passive: true });

  document.addEventListener('pointerout', (e) => {
    const el = e.target?.closest?.(interactiveSel);
    if (!el || el.contains(e.relatedTarget)) return;
    el.style.setProperty('--tx', '0deg');
    el.style.setProperty('--ty', '0deg');
  }, { passive: true });
}

function volumes() {
  volumesPromise ??= loadAssets().catch((err) => {
    // Manifest unreachable (offline, cold server). The procedural fallback world in
    // world.js still needs no assets — play on with an empty list rather than dying, and
    // forget the failure so the next start() tries the network again.
    console.warn('[PoVoxelStrike] asset load failed, using procedural world:', err);
    volumesPromise = null;
    return [];
  });
  return volumesPromise;
}

async function boot(host, dotnetRef, demo, loaded, online, opts) {
  // Engine.start() is async: the renderer factory awaits WebGPU adapter init before it
  // can fall back. The await has to be INSIDE the try or a rejected start would surface
  // as an unhandled rejection instead of OnFatalError.
  try {
    engine = new Engine(host, dotnetRef, demo, loaded, online ? 'multi' : 'solo', online || null, opts || {});
    if (online) {
      const send = (method, ...args) => {
        try {
          const p = dotnetRef.invokeMethodAsync(method, ...args);
          if (p && p.catch) p.catch(() => { });
        } catch { }
      };
      // Each lockstep batch goes to the page, which ships it through the lockstep hub.
      // 20 Hz, so it crosses interop as positional primitives (no object for .NET to
      // reflect over). Bits: 1 forward, 2 back, 4 left, 8 right, 16 fire, 32 alt fire, 64 down.
      engine.multiplayerSink = (batch) => {
        const i = batch.inputs[0];
        if (!i) return;
        const bits = (i.forward ? 1 : 0) | (i.back ? 2 : 0) | (i.left ? 4 : 0) | (i.right ? 8 : 0)
          | (i.fire ? 16 : 0) | (i.altFire ? 32 : 0) | (i.down ? 64 : 0);
        send('OnLockstepInput', batch.tick, bits, i.yaw, i.pitch, i.x, i.y, i.z);
      };
      // Carves and the win ride their own messages: neither may be dropped the way a
      // stale position batch is.
      engine.carveSink = (kind, structure, x, y, z) => send('OnCarve', kind, structure, x, y, z);
      engine.winSink = () => send('OnChaliceClaimed');
    }
    await engine.start();
  } catch (err) {
    console.error('[PoVoxelStrike] engine boot failed:', err);
    try { dotnetRef.invokeMethodAsync('OnFatalError', String(err?.message ?? err)); } catch { }
  }
}

window.PoVoxelStrike = {
  /**
   * Build a run. It comes up in 'ready' (rendered, frozen) behind the page's start card;
   * enter() is what starts it. Calling start() again replaces the run — that is "Play
   * again", a change of seed, and the squad's arena, all the same call.
   *
   * Flat primitives, like the rest of this surface — no DTO for the page to keep in step.
   * @param seed the arena to build; 0 lets the engine roll one. Online, the session's seed.
   * @param survival solo only: the roaming horde is on
   * @param playerNumber this player's seat in an online run; 0 for solo and demo
   * @param names online: display names, indexed by player number − 1
   */
  async start(containerId, dotnetRef, demo, seed, survival, playerNumber, names) {
    installUiMicroInteractions();
    const token = ++startToken;
    if (engine) { engine.dispose(); engine = null; }

    const host = document.getElementById(containerId);
    if (!host) { console.error('[PoVoxelStrike] container not found:', containerId); return; }

    const loaded = await volumes();
    if (token !== startToken) return; // a newer start() or stop() landed mid-fetch
    const online = playerNumber > 0
      ? { playerNumber, seed, names: Object.fromEntries((names || []).map((n, i) => [i + 1, n])) }
      : null;
    boot(host, dotnetRef, demo, loaded, online, { seed, survival: !!survival });
  },

  /**
   * The start card's button (a click, so the Pointer Lock request is legal).
   * engine.enter() MUST run synchronously first so the browser honours requestPointerLock;
   * the voxel-dissolve burst and launch sound run immediately after.
   */
  enter() {
    engine?.enter();
    playUiSound('launch');
    spawnVoxelDissolve(engine?.host || document.getElementById('povoxelstrike-container'));
  },

  /** Online: a relayed lockstep frame (every peer's latest batch) for the engine to apply. */
  applyFrame(frame) { engine?.applyLockstepFrame(frame); },

  /** Online: a squadmate's carve. Flat primitives, like every other hot-ish interop call. */
  applyCarve(playerNumber, kind, structure, x, y, z) {
    engine?.applyCarve(playerNumber, kind, structure, x, y, z);
  },

  /** Online: a squadmate took the chalice. */
  squadWon() { engine?.squadWin(); },

  resume() {
    engine?.resume();
    playUiSound('resume');
    triggerIrisResume(engine?.host || document.getElementById('povoxelstrike-container'));
  },

  /** Play a synthesized UI micro-sound ('hover' | 'click' | 'launch' | 'pause' | 'resume' | 'tick' | 'medal'). */
  uiSound(kind) { playUiSound(kind); },

  /**
   * Animate the end-of-run summary stat tiles from 0 up to their recorded targets with
   * subtle synthesized audio ticks (#20). Respects prefers-reduced-motion.
   */
  animateSummary() {
    if (isReducedMotion() || typeof document === 'undefined') return;
    const nodes = Array.from(document.querySelectorAll('.pvs-summary .pvs-tile-value[data-count-target]'));
    if (!nodes.length) return;
    const duration = 780;
    const t0 = performance.now();
    let step = 0;

    const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const ease = 1 - Math.pow(1 - p, 3);
      for (const el of nodes) {
        const target = Number(el.dataset.countTarget || 0);
        const mode = el.dataset.countMode || 'int';
        const suffix = el.dataset.countSuffix || '';
        const cur = Math.round(target * ease);
        if (mode === 'time') el.textContent = fmtTime(cur);
        else if (mode === 'ratio') el.textContent = `${cur}${suffix}`;
        else el.textContent = cur.toLocaleString() + suffix;
      }
      if (p < 1) {
        playUiSound('tick', step++);
        requestAnimationFrame(tick);
      } else {
        for (const el of nodes) {
          if (el.dataset.countFinal) el.textContent = el.dataset.countFinal;
        }
        playUiSound('medal');
      }
    };
    requestAnimationFrame(tick);
  },

  /** Settings as "sens|invertY|fov|gfx" — a string, so the page needs no DTO to read it. */
  getSettings() {
    const s = loadSettings();
    return `${s.sens}|${s.invertY ? 1 : 0}|${s.fov}|${s.gfx}`;
  },

  /** Persist, and apply to the live run. The graphics tier takes effect on the next start(). */
  setSettings(sens, invertY, fov, gfx) {
    const s = saveSettings({ sens, invertY, fov, gfx });
    engine?.applySettings(s);
  },


  /**
   * Fullscreen the canvas host (the engine's ResizeObserver handles the resize).
   * Fires from a Blazor button click, so the gesture requirement is satisfied.
   */
  toggleFullscreen() {
    const host = engine?.host || document.getElementById('povoxelstrike-container');
    if (!host) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => { });
    else host.requestFullscreen?.().catch?.(() => { });
  },

  /** Interop surface: cancel the current run immediately (no game-over
   *  event fires). Same teardown as stop(); the distinct name keeps call sites
   *  honest about intent — abort mid-run vs stop on page dispose. */
  abort() { this.stop(); },

  stop() {
    startToken++;
    volumesPromise = null;
    if (engine) { engine.dispose(); engine = null; }
  },

  /** Tear the run down but keep the decoded assets: the page is switching mode, not leaving. */
  unload() { startToken++; if (engine) { engine.dispose(); engine = null; } },
};

// TEMP DEBUG — headless verification hook (same convention as PoMarbleRace's __game):
// lets a scripted browser carve/inspect without pointer lock, which headless runs
// cannot acquire.
window.__pvs = () => engine;
