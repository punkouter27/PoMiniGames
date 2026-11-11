// perf.js — Game mixin: the performance overlay. Frame rate and frame time, the physics step,
// the render, draw calls and triangles, the live field, and how many times the adaptive quality
// tier (visualRuntime.js, 'po-gfx-tier') has stepped down this session.
// Details join the shared Tab panel instead of mounting a second overlay.
// Mixed into Game.prototype by game.js.
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
      this._perfOn = !!window.poGameStatsOpen;
      this._perfKeys = (e) => this.setPerfHud(e.detail.open);
      window.addEventListener('po-game-stats', this._perfKeys);
      if (this._perfOn) this._perfMount();
    }
    if (!this._perfOn) return;
    const p = this._perfAcc;
    p.frames++; p.t += dt; p.step += this._stepMs || 0; p.render += this._renderMs || 0;
    p.worst = Math.max(p.worst, dt * 1000);
    if (p.t < SAMPLE_S) return;
    const info = this.scene.renderer && this.scene.renderer.info;
    const calls = info ? info.render.calls : 0;
    const tris = info ? info.render.triangles : 0;
    const live = this.marbleSet ? this.marbleSet.marbles.filter((m) => !m.finished && !m.eliminated).length : 0;
    const bodies = this.world ? this.world.bodies.length : 0;
    window.poGameStatsDetails = [
      { label: 'Physics', value: `${(p.step / p.frames).toFixed(1)} ms` },
      { label: 'Render', value: `${(p.render / p.frames).toFixed(1)} ms` },
      { label: 'Draw calls', value: String(calls) },
      { label: 'Triangles', value: String(tris) },
      { label: 'Live marbles', value: String(live) },
      { label: 'Bodies', value: String(bodies) },
      { label: 'Quality drops', value: String(_drops) }
    ];
    this._perfAcc = { frames: 0, t: 0, step: 0, render: 0, worst: 0 };
  }

  _perfMount() {
    this._perfAcc = { frames: 0, t: 0, step: 0, render: 0, worst: 0 };
    // Count every pass of the composer, not only the last one: reset by hand once per frame.
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.autoReset = false;
  }

  _perfUnmount() {
    window.poGameStatsDetails = [];
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.autoReset = true;
  }

  // Before each render while the overlay is up: start this frame's draw-call count from zero.
  _perfBeforeRender() {
    if (!this._perfOn) return;
    const info = this.scene.renderer && this.scene.renderer.info;
    if (info) info.reset();
  }

  _perfDispose() {
    this._perfUnmount();
    window.poGameStatsDetails = [];
    if (this._perfKeys) window.removeEventListener('po-game-stats', this._perfKeys);
  }
}
