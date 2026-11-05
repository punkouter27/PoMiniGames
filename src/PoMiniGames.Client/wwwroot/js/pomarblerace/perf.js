// perf.js — Game mixin: the performance overlay. Frame rate and frame time, the physics step,
// the render, draw calls and triangles, the live field, and how many times the adaptive quality
// tier (visualRuntime.js, 'po-gfx-tier') has stepped down this session. Off by default; F3 or
// the Settings drawer (PoMarbleRace.setPerfHud) turns it on, and the choice is remembered
// (store.js prefs.perfHud). Costs nothing while hidden beyond two performance.now() reads.
// Mixed into Game.prototype by game.js.
import { readPref, setPref } from './store.js';

const RANK = { low: 0, medium: 1, high: 2 };
const SAMPLE_S = 0.5;   // how often the text refreshes, seconds

// One listener for the page: the tier is a page-wide setting, not a race's.
let _drops = 0;
let _tier = null;
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('po-gfx-tier', (e) => {
    const t = e.detail && e.detail.tier;
    if (_tier && t && RANK[t] < RANK[_tier]) _drops++;
    _tier = t || _tier;
  });
}

export class PerfMixin {
  setPerfHud(on) {
    on = !!on;
    setPref('perfHud', on);
    this._perfOn = on;
    if (on) this._perfMount();
    else this._perfUnmount();
  }

  // Called once per rendered frame by game.js, after render. Measures its own wall time: the
  // frame's dt is clamped to 50 ms for the simulation and would hide a slow frame.
  _perfFrame() {
    const now = performance.now();
    const dt = this._perfLast ? (now - this._perfLast) / 1000 : 0;
    this._perfLast = now;
    if (this._perfOn === undefined) {
      this._perfOn = !!readPref('perfHud');
      this._perfKeys = (e) => { if (e.key === 'F3') { e.preventDefault(); this.setPerfHud(!this._perfOn); } };
      window.addEventListener('keydown', this._perfKeys);
      if (this._perfOn) this._perfMount();
    }
    if (!this._perfOn || !this._perfEl) return;
    const p = this._perfAcc;
    p.frames++; p.t += dt; p.step += this._stepMs || 0; p.render += this._renderMs || 0;
    p.worst = Math.max(p.worst, dt * 1000);
    if (p.t < SAMPLE_S) return;
    const info = this.scene.renderer && this.scene.renderer.info;
    const calls = info ? info.render.calls : 0;
    const tris = info ? info.render.triangles : 0;
    const live = this.marbleSet ? this.marbleSet.marbles.filter((m) => !m.finished && !m.eliminated).length : 0;
    const bodies = this.world ? this.world.bodies.length : 0;
    this._perfEl.textContent =
      `${(p.frames / p.t).toFixed(0)} fps  ${(p.t * 1000 / p.frames).toFixed(1)} ms (worst ${p.worst.toFixed(0)})\n` +
      `physics ${(p.step / p.frames).toFixed(1)} ms  render ${(p.render / p.frames).toFixed(1)} ms\n` +
      `draws ${calls}  tris ${(tris / 1000).toFixed(0)}k\n` +
      `marbles ${live} live  bodies ${bodies}\n` +
      `gfx ${_tier || document.documentElement.getAttribute('data-gfx') || 'high'}  drops ${_drops}`;
    this._perfAcc = { frames: 0, t: 0, step: 0, render: 0, worst: 0 };
  }

  _perfMount() {
    if (this._perfEl || !this.container) return;
    const el = document.createElement('pre');
    el.className = 'mr-perf';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '6', margin: '0', padding: '6px 8px',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace', color: '#d1fae5',
      background: 'rgba(2, 6, 23, 0.72)', borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre',
    });
    el.textContent = 'measuring…';
    this.container.appendChild(el);
    this._perfEl = el;
    this._perfAcc = { frames: 0, t: 0, step: 0, render: 0, worst: 0 };
    // Count every pass of the composer, not only the last one: reset by hand once per frame.
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.autoReset = false;
  }

  _perfUnmount() {
    if (this._perfEl) { this._perfEl.remove(); this._perfEl = null; }
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.autoReset = true;
  }

  // Before each render while the overlay is up: start this frame's draw-call count from zero.
  _perfBeforeRender() {
    if (!this._perfEl) return;
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.reset();
  }

  _perfDispose() {
    this._perfUnmount();
    if (this._perfKeys) window.removeEventListener('keydown', this._perfKeys);
  }
}
