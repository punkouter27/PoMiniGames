// selectStage.js — the 2P fighter select's live portraits ("holo-glass" select).
//
// ONE renderer for the whole select screen: a single transparent canvas laid over
// .pb-select, drawn into once per portrait with setViewport/setScissor from each
// portrait element's getBoundingClientRect ("one canvas, many viewports"). Sixteen
// canvases would burn sixteen of the browser's ~16 live WebGL contexts in an SPA that
// also has to boot the arena right after.
//
// The page owns the DOM (tiles stay real <button>s); this module only paints into the
// elements' rects and never takes input — the canvas is aria-hidden, pointer-events:none.
//
//   .pb-select-portrait[data-fighter][data-index]   a grid tile's portrait (turntable)
//   .pb-select-hero[data-fighter][data-side]        a side card's hero render (rim lit)
//
// Cost control, in order of how much each saves:
//   • preserveDrawingBuffer + a round-robin budget: a frame redraws only the tiles that
//     need attention (hovered / focused / under a cursor), the two heroes, and a few of
//     the idle turntables, oldest first. The rest keep last frame's pixels.
//   • portraits outside the intro card's scrolled view are skipped until they return.
//   • the loop stops when the select is offscreen, the tab is hidden, or nobody has
//     touched anything for IDLE_MS; any input wakes it.
//   • reduced motion: no loop at all — static 3/4 portraits, redrawn on change only.
//   • low tier / no WebGL2: no canvas; the CSS keeps the plain glass tiles.
//
// Lifecycle: mount(host, state) → update(state)* → unmount(). unmount() (also called by
// PoBrawl.init before the arena boots, and on a disconnected host) disposes the renderer
// AND forces the context loss — dispose() alone leaves the context alive until GC.
//
// BACKEND. The fighters are node materials, so this is three's WebGPURenderer like the arena,
// but always on its WebGL2 backend, over a context this module creates itself: the round-robin
// budget needs preserveDrawingBuffer, and a WebGPU canvas starts every frame empty.
import * as THREE from 'three-eco/webgpu';
import { buildFighter, setExpression, CHARACTERS } from './fighters.js';
import { Animator } from './animation.js';
import * as Quality from './quality.js';
import { configureRenderer } from '../platform/3d/renderer.js';
import { disposeRenderer } from '../platform/3d/dispose.js';

const IDLE_MS = 15000;
const SPIN = 0.5;            // turntable rad/s
const FACE_YAW = 0.18;       // "turned to camera": a hair off dead-on reads less flat
const STATIC_YAW = 0.5;      // reduced motion: a fixed 3/4 view
const HERO_YAW = 0.55;       // side cards angle in toward the VS
const RIM_TILE = 0x9cc4ff;
const RIM_P1 = 0x22c55e;
const RIM_P2 = 0xef4444;

const reduced = () => document.documentElement.getAttribute('data-motion') === 'reduce';
const cue = (name, opts) => { try { window.PoCue?.fire('pobrawl', name, opts); } catch { /* best-effort */ } };
const lerpAngle = (a, b, t) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

let stage = null;

/** Whether this device gets live portraits at all (WebGL2 and not the low tier). */
function capable() {
  // Both readings: the CSS keys off the attribute (PoQuality writes it directly, e.g. a
  // ?fx=low or a Settings choice), the engine off visualRuntime's adaptive tier.
  if (Quality.tier() === 'low' || document.documentElement.getAttribute('data-gfx') === 'low') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch { return false; }
}

class SelectStage {
  constructor(host, state) {
    this.host = host;
    this.state = { p1: state.p1, p2: state.p2, p1Locked: !!state.p1Locked, p2Locked: !!state.p2Locked };
    this.rigs = new Map();            // fighterId → { rig, animator, top, lastT, grinUntil }
    this.views = new WeakMap();       // portrait element → per-viewport state
    this.hover = -1;                  // tile index under the pointer
    this.focus = -1;                  // tile index with keyboard focus
    this.lastInput = performance.now();
    this.visible = true;
    this.raf = 0;
    this.lastFrame = 0;
    this.canvasKey = '';
    this.layoutKey = '';
    this.rr = 0;
    this.reduced = reduced();
    const tier = Quality.tier();
    this.frameMs = tier === 'high' ? 0 : 1000 / 30;
    this.budget = tier === 'high' ? 5 : 3;

    // mount() is synchronous (the page reads its boolean): the renderer is built here and
    // its init() settles a moment later; nothing draws until `ready`.
    // The context is ours so it can keep its drawing buffer; its own antialias smooths the
    // canvas the renderer draws straight into. No shadows here: portraits are unshadowed.
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power',
    });
    if (!gl) throw new Error('select stage: no WebGL2 context');
    this.renderer = new THREE.WebGPURenderer({ canvas, context: gl, forceWebGL: true, alpha: true, antialias: false });
    configureRenderer(THREE, this.renderer, {
      tone: 'agx', exposure: 1.45, shadows: false, clearColor: 0x000000, clearAlpha: 0,
    });
    this.renderer.autoClear = true;
    // One frame = many render() calls; count them together (see stats()).
    this.renderer.info.autoReset = false;
    this.ready = false;
    this.renderer.init().then(() => {
      if (this.disposed) return;
      // Scissoring needs the backend, which only exists once init() has settled.
      this.renderer.setScissorTest(true);
      this.ready = true;
      this.layoutKey = '';     // the first real frame paints every portrait
      this.wake();
      if (this.reduced && !this.raf) this.raf = requestAnimationFrame(this._frame);
    }, () => { if (!this.disposed) unmount(); });
    canvas.className = 'pb-select-gl';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.tabIndex = -1;
    host.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xe4ecff, 0x2b2433, 1.15));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
    key.position.set(1.6, 3.2, 3.4);
    const fill = new THREE.DirectionalLight(0xc8d6ff, 0.55);
    fill.position.set(-3, 1.4, 2);
    this.rim = new THREE.DirectionalLight(RIM_TILE, 2.4);
    this.rim.position.set(-1.4, 2.6, -3.2);
    this.rim2 = new THREE.DirectionalLight(RIM_TILE, 1.4);
    this.rim2.position.set(1.8, 1.8, -3);
    this.scene.add(key, fill, this.rim, this.rim2);
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 30);

    this.clip = host.closest('.gps-intro-card') || null;
    this._bind();
    host.dataset.stage = 'live';
    // The heroes first, then the grid in reading order: a rig a frame keeps the first
    // paint quick and the build cost (canvas-painted face plates) off one long task.
    this.buildQueue = [this.state.p1, this.state.p2,
      ...[...host.querySelectorAll('.pb-select-portrait[data-fighter]')].map((e) => e.dataset.fighter)]
      .filter((id, i, a) => id && CHARACTERS[id] && a.indexOf(id) === i);
    this.wake();
  }

  // ── Input & visibility ──────────────────────────────────────────────
  _bind() {
    const h = this.host;
    const tileIndex = (t) => {
      const tile = t?.closest?.('.pb-select-tile');
      const p = tile?.querySelector('.pb-select-portrait');
      return p ? +p.dataset.index : -1;
    };
    let lastTick = 0;
    const tick = (el) => {
      const now = performance.now();
      if (now - lastTick < 70) return;
      lastTick = now;
      cue('selectTick', { el, fx: false, gain: 0.8 });
    };
    // A fighter that gains attention turns to camera and plays its entrance (taunt).
    const greet = (t) => {
      const id = t.closest('.pb-select-tile')?.querySelector('.pb-select-portrait')?.dataset.fighter;
      if (id && id !== this.state.p1 && id !== this.state.p2) this._perform(id);
      tick(t);
    };
    this._onOver = (e) => {
      const i = tileIndex(e.target);
      if (i !== this.hover) {
        this.hover = i;
        if (i >= 0 && i !== this.focus) greet(e.target);
      }
      this.wake();
    };
    this._onLeave = () => { this.hover = -1; this.wake(); };
    this._onFocus = (e) => {
      const i = tileIndex(e.target);
      if (i !== this.focus) { this.focus = i; if (i >= 0 && i !== this.hover) greet(e.target); }
      this.wake();
    };
    this._onBlur = () => { this.focus = -1; this.wake(); };
    // Glass specular: the pointer's spot on the card, as --mx/--my (CSS paints it).
    let pending = null;
    this._onMove = (e) => {
      const card = e.target.closest?.('.pb-select-tile, .pb-select-side');
      if (!card) return;
      if (!pending) {
        requestAnimationFrame(() => {
          const { card: c, x, y } = pending;
          pending = null;
          const r = c.getBoundingClientRect();
          c.style.setProperty('--mx', `${(((x - r.left) / r.width) * 100).toFixed(1)}%`);
          c.style.setProperty('--my', `${(((y - r.top) / r.height) * 100).toFixed(1)}%`);
        });
      }
      pending = { card, x: e.clientX, y: e.clientY };
      this.lastInput = performance.now();
      if (!this.raf) this.wake();
    };
    this._onKey = () => this.wake();
    this._onVis = () => (document.hidden ? this.sleep() : this.wake());
    h.addEventListener('pointerover', this._onOver);
    h.addEventListener('pointerleave', this._onLeave);
    h.addEventListener('pointermove', this._onMove, { passive: true });
    h.addEventListener('focusin', this._onFocus);
    h.addEventListener('focusout', this._onBlur);
    window.addEventListener('keydown', this._onKey, true);
    document.addEventListener('visibilitychange', this._onVis);
    this._io = new IntersectionObserver((entries) => {
      this.visible = entries.some((en) => en.isIntersecting);
      if (this.visible) this.wake(); else this.sleep();
    });
    this._io.observe(h);
    this._offTier = Quality.onTierChange((t) => { if (t === 'low') unmount(); });
    // A sleeping loop never sees the card go: a mode switch or a route change can drop
    // the select without a page dispose. Cheap watchdog, so the context never outlives it.
    this._watch = setInterval(() => { if (!h.isConnected) unmount(); }, 1500);
  }

  wake() {
    this.lastInput = performance.now();
    if (this.disposed || this.raf || !this.visible || document.hidden) return;
    this.raf = requestAnimationFrame(this._frame);
  }

  sleep() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  _frame = (now) => {
    this.raf = 0;
    if (this.disposed) return;
    if (!this.host.isConnected) { unmount(); return; }
    // The backend is still starting: come back next frame.
    if (!this.ready) { this.raf = requestAnimationFrame(this._frame); return; }
    const building = this.buildQueue.length > 0;
    if (building) this._ensureRig(this.buildQueue.shift());
    const idle = now - this.lastInput > IDLE_MS;
    if (this.frameMs && now - this.lastFrame < this.frameMs - 2 && !building) {
      this.raf = requestAnimationFrame(this._frame);
      return;
    }
    const dt = Math.min(0.1, this.lastFrame ? (now - this.lastFrame) / 1000 : 0.016);
    this.lastFrame = now;
    // Reduced motion and idle both draw everything once, statically, then stop.
    this._draw(now / 1000, dt, this.reduced || idle);
    if (building || (!this.reduced && !idle)) this.raf = requestAnimationFrame(this._frame);
  };

  // ── Rigs ────────────────────────────────────────────────────────────
  _ensureRig(id) {
    if (!id || !CHARACTERS[id]) return null;
    let r = this.rigs.get(id);
    if (r) return r;
    const rig = buildFighter(id, { physicalMaterials: false });
    rig.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    const animator = new Animator(rig.joints, rig.config.stance);
    // Settle into the guard so the first paint is not the build's rest pose.
    for (let i = 0; i < 24; i++) animator.update({ dt: 0.05, speed: 0, idleT: i * 0.05, root: null });
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.root);
    r = { rig, animator, top: box.max.y, lastT: 0, grinUntil: 0 };
    this.rigs.set(id, r);
    return r;
  }

  _perform(id, track) {
    const r = this.rigs.get(id);
    if (!r || this.reduced) return;
    r.animator.play(track || CHARACTERS[id]?.entrance || 'ready');
    r.grinUntil = performance.now() / 1000 + 1.6;
  }

  // ── State from the page ─────────────────────────────────────────────
  update(s) {
    const prev = this.state;
    const next = { p1: s.p1, p2: s.p2, p1Locked: !!s.p1Locked, p2Locked: !!s.p2Locked };
    this.state = next;
    for (const side of [1, 2]) {
      const id = next[`p${side}`], was = prev[`p${side}`];
      const locked = next[`p${side}Locked`], wasLocked = prev[`p${side}Locked`];
      if (id !== was) {
        this._ensureRig(id);
        this._perform(id);
      }
      if (locked && !wasLocked) {
        this._ensureRig(id);
        this._perform(id, 'victory');
      }
    }
    this.wake();
    // Reduced motion has no loop; repaint the changed corners now.
    if (this.reduced && !this.raf) this.raf = requestAnimationFrame(this._frame);
  }

  // ── Drawing ─────────────────────────────────────────────────────────
  _draw(t, dt, drawAll) {
    const host = this.host;
    const hr = host.getBoundingClientRect();
    const els = [...host.querySelectorAll('.pb-select-hero[data-fighter], .pb-select-portrait[data-fighter]')];
    const rects = els.map((e) => e.getBoundingClientRect());
    const live = rects.filter((r) => r.width > 4 && r.height > 4);
    if (!live.length) return;
    this.renderer.info.reset();

    // The canvas spans the union of the portrait rects, in host coordinates.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of live) { x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
    const cw = Math.ceil(x1 - x0), ch = Math.ceil(y1 - y0);
    const left = Math.round(x0 - hr.left), top = Math.round(y0 - hr.top);
    const canvasKey = `${left},${top},${cw},${ch}`;
    let all = drawAll;
    if (canvasKey !== this.canvasKey) {
      this.canvasKey = canvasKey;
      const s = this.renderer.domElement.style;
      s.left = `${left}px`; s.top = `${top}px`;
      this.renderer.setPixelRatio(Math.min(1.5, Quality.pixelRatio(cw, ch)));
      this.renderer.setSize(cw, ch);   // resizing clears the buffer
      all = true;
    }
    // Anything moved inside the canvas: wipe it, or the old spot keeps a ghost.
    const layoutKey = rects.map((r) => `${Math.round(r.left - x0)},${Math.round(r.top - y0)},${Math.round(r.width)},${Math.round(r.height)}`).join('|');
    if (layoutKey !== this.layoutKey) {
      if (this.layoutKey && !all) {
        this.renderer.setScissorTest(false);
        this.renderer.clear();
        this.renderer.setScissorTest(true);
      }
      this.layoutKey = layoutKey;
      all = true;
    }

    // What is on screen: the intro card scrolls, and its overflow clips us.
    const cr = this.clip ? this.clip.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    const vTop = Math.max(0, cr.top), vBottom = Math.min(innerHeight, cr.bottom);

    const { p1, p2 } = this.state;
    const cursor = new Set([this._indexOf(p1, 1), this._indexOf(p2, 2)]);
    const jobs = [];
    const idle = [];
    els.forEach((el, i) => {
      const r = rects[i];
      if (r.width <= 4 || r.height <= 4) return;
      let v = this.views.get(el);
      if (!v) { v = { drawn: -1, face: 0, phase: Math.random() * Math.PI * 2, id: null, onScreen: false }; this.views.set(el, v); }
      const id = el.dataset.fighter;
      if (v.id !== id) { v.id = id; v.drawn = -1; }
      const onScreen = r.bottom > vTop && r.top < vBottom;
      if (!onScreen) { v.onScreen = false; return; }
      if (!v.onScreen) { v.onScreen = true; v.drawn = -1; }
      const side = el.dataset.side ? +el.dataset.side : 0;
      const idx = el.dataset.index !== undefined ? +el.dataset.index : -1;
      const attention = side > 0 || idx === this.hover || idx === this.focus || cursor.has(idx);
      const job = { el, r, v, id, side, idx, attention };
      if (all || v.drawn < 0 || attention || v.face > 0.01) jobs.push(job); else idle.push(job);
    });
    // The idle turntables, oldest first, up to the frame's budget.
    idle.sort((a, b) => a.v.drawn - b.v.drawn);
    for (let i = 0; i < idle.length && i < this.budget; i++) jobs.push(idle[i]);

    const advanced = new Set();
    for (const job of jobs) this._drawOne(job, t, dt, x0, y0, ch, advanced);
  }

  _indexOf(id, side) {
    const el = this.host.querySelector(`.pb-select-tile--p${side} .pb-select-portrait`);
    return el && el.dataset.fighter === id ? +el.dataset.index : -1;
  }

  _drawOne(job, t, dt, x0, y0, ch, advanced) {
    const { r, v, id, side, attention } = job;
    const entry = this.rigs.get(id) || (this.buildQueue.length ? null : this._ensureRig(id));
    if (!entry) return;
    const { rig, animator } = entry;

    // Pose: one animator per fighter, advanced once per frame by however long it has
    // been since it last moved (a round-robin tile can sit out several frames).
    if (!advanced.has(id)) {
      advanced.add(id);
      const step = this.reduced ? 0 : Math.min(0.1, entry.lastT ? t - entry.lastT : dt);
      entry.lastT = t;
      if (step > 0) animator.update({ dt: step, speed: 0, idleT: t, root: null });
      setExpression(rig, t < entry.grinUntil ? 'grin' : 'neutral');
    }

    // Yaw: turntable when idle, turned to camera when it has attention.
    const k = this.reduced ? 1 : Math.min(1, (v.drawn > 0 ? t - v.drawn : 1) * 5);
    v.face += ((attention ? 1 : 0) - v.face) * k;
    let yaw;
    if (side) {
      yaw = (side === 1 ? HERO_YAW : -HERO_YAW) + (this.reduced ? 0 : Math.sin(t * 0.7 + side) * 0.07);
    } else {
      const spin = this.reduced ? STATIC_YAW : v.phase + t * SPIN;
      yaw = lerpAngle(spin, FACE_YAW, v.face);
    }
    rig.root.rotation.y = yaw;

    // Framing from the rig's own height: heroes waist-up, tiles head and shoulders.
    const cam = this.camera;
    const aspect = r.width / r.height;
    const frameH = side ? 1.15 : 0.66;
    const lookY = entry.top - (side ? 0.46 : 0.28);
    const dist = (frameH / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / Math.min(1, aspect / 0.75);
    cam.aspect = aspect;
    cam.position.set(0, lookY + 0.08, dist);
    cam.lookAt(0, lookY, 0);
    cam.updateProjectionMatrix();

    const rimColor = side === 1 ? RIM_P1 : side === 2 ? RIM_P2 : RIM_TILE;
    this.rim.color.setHex(rimColor);
    this.rim2.color.setHex(rimColor);
    this.rim.intensity = side ? 9 : 2.4;
    this.rim2.intensity = side ? 5 : 1.4;
    // The rim sits behind the shoulder the fighter turned away from.
    this.rim.position.x = side === 2 ? 1.4 : -1.4;
    this.rim2.position.x = side === 2 ? -1.8 : 1.8;

    const x = r.left - x0, w = r.width, h = r.height;
    // Top-left origin, y down: this renderer's viewport and scissor follow the page, not GL.
    const y = r.top - y0;
    this.renderer.setViewport(x, y, w, h);
    // Scissor inside the card's rounded corners: the bottom edge (shoulders) hides under
    // the name plate's scrim, so a square cut there never shows.
    this.renderer.setScissor(x + 2, y + 2, w - 4, h - 9);
    this.scene.add(rig.root);
    this.renderer.render(this.scene, cam);
    this.scene.remove(rig.root);
    v.drawn = t;
  }

  /** Both locked: the VS sting and the diagonal slash. Resolves when it has played. */
  versus() {
    cue('selectVs', { fx: false });
    if (this.reduced) return Promise.resolve(true);
    return slash(this.host);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sleep();
    const h = this.host;
    h.removeEventListener('pointerover', this._onOver);
    h.removeEventListener('pointerleave', this._onLeave);
    h.removeEventListener('pointermove', this._onMove);
    h.removeEventListener('focusin', this._onFocus);
    h.removeEventListener('focusout', this._onBlur);
    window.removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('visibilitychange', this._onVis);
    this._io?.disconnect();
    this._offTier?.();
    clearInterval(this._watch);
    for (const { rig } of this.rigs.values()) {
      rig.root.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    }
    this.rigs.clear();
    disposeRenderer(this.renderer);   // dispose + context loss + canvas removal (see game.js dispose)
    if (h.dataset.stage === 'live') delete h.dataset.stage;
  }
}

/** The diagonal VS slash across the screen. Pure DOM/CSS; removes itself. */
function slash(host) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'pb-vs-slash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="pb-vs-slash-band"></span><span class="pb-vs-slash-word">VS</span>';
    // Into the intro overlay, above the card (the card's sticky bar would sit over it
    // inside the select); the page's CSS styles it through .pb-intro ::deep.
    (host.closest('.gps-intro-overlay') || host).appendChild(el);
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(true); setTimeout(() => el.remove(), 400); };
    el.addEventListener('animationend', (e) => { if (e.target.classList.contains('pb-vs-slash-word')) finish(); });
    setTimeout(finish, 1100);   // no animationend (CSS not applied, tab hidden)
  });
}

// ── Module API (index.js exposes these as window.PoBrawl.select) ──────────
/**
 * Mount the live portraits on the select host. Returns false (and marks the host
 * data-stage="off" so the CSS drops the empty portrait slots) when this device does not
 * get them. Idempotent for the same host.
 * @param {string|Element} hostOrId  the .pb-select element or its id
 * @param {{p1: string, p2: string, p1Locked: boolean, p2Locked: boolean}} state
 */
let pending = null;   // { id, state, raf, until } while waiting for the host to render

export function mount(hostOrId, state) {
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  if (!host) {
    // The page's first after-render can beat the select into the DOM (GameShell renders
    // its content after its WebGL probe). Wait for it a while rather than miss it.
    if (typeof hostOrId !== 'string') return false;
    cancelPending();
    pending = { id: hostOrId, state, until: performance.now() + 15000, raf: 0 };
    const poll = () => {
      if (!pending) return;
      const el = document.getElementById(pending.id);
      if (el) { const s = pending.state; pending = null; mount(el, s); return; }
      if (performance.now() > pending.until) { pending = null; return; }
      pending.raf = requestAnimationFrame(poll);
    };
    pending.raf = requestAnimationFrame(poll);
    return true;
  }
  cancelPending();
  if (stage && stage.host === host && !stage.disposed) { update(state); return true; }
  unmount();
  last = { ...(state || {}) };
  lastHost = host;
  if (!capable()) { host.dataset.stage = 'off'; return false; }
  try {
    stage = new SelectStage(host, state || {});
    return true;
  } catch (e) {
    console.warn('[PoBrawl] select stage unavailable:', e?.message || e);
    stage = null;
    host.dataset.stage = 'off';
    return false;
  }
}

// The last state the page pushed, for the cues: they play with or without a live stage.
let last = null;
let lastHost = null;

function cuesFor(host, s) {
  const prev = last;
  last = { ...s };
  lastHost = host;
  if (!prev) return;
  for (const side of [1, 2]) {
    const pan = side === 1 ? -0.45 : 0.45;
    const locked = s[`p${side}Locked`];
    if (locked && !prev[`p${side}Locked`]) {
      const card = host?.querySelector(`.pb-select-side--p${side}`);
      cue('selectLock', { el: card || undefined, pan });
    } else if (!locked && s[`p${side}`] !== prev[`p${side}`]) {
      cue('selectTick', { fx: false, pan });
    }
  }
}

function cancelPending() {
  if (pending) cancelAnimationFrame(pending.raf);
  pending = null;
}

export function update(state) {
  const s = state || {};
  if (pending) { pending.state = s; return; }
  cuesFor(stage?.host || lastHost, s);
  if (stage && !stage.disposed) stage.update(s);
}

/** Plays the VS sting + slash; resolves when the page may start the fight. */
export function versus(hostOrId) {
  if (stage && !stage.disposed) return stage.versus();
  // No live stage (low tier): the sting and slash are DOM-only and still play.
  cue('selectVs', { fx: false });
  const host = typeof hostOrId === 'string' ? document.getElementById(hostOrId) : hostOrId;
  return host && !reduced() ? slash(host) : Promise.resolve(true);
}

export function unmount() {
  cancelPending();
  if (stage) { stage.dispose(); stage = null; }
  last = null;
  lastHost = null;
}

/** Diagnostics for headless checks: draw calls of the last frame, rigs built, live or not. */
export function stats() {
  if (!stage || stage.disposed) return null;
  const info = stage.renderer.info;
  return { rigs: stage.rigs.size, calls: info.render.calls, triangles: info.render.triangles,
    programs: info.programs?.length ?? 0, looping: !!stage.raf, canvas: stage.canvasKey };
}
