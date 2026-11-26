// resultGlass.js — the frozen-frame glass behind the result. Showtime module (see show.js);
// mixin, `this` is the live game.
//
// When the result modal (GameShell's GameOverModal, a top-layer <dialog>) opens over the arena,
// the finished frame is captured in _onShowRender — the same task as composer.render(), so the
// drawing buffer is still readable — into a texture on a small overlay WebGL2 canvas. The frame
// is dual-Kawase blurred once (it is frozen), and every frame after that only a composite runs:
// the frosted, dimmed frame, and a thick glass slab under the modal's bounding rect with
// refraction off a rounded-rect SDF normal, chromatic dispersion at the bevel, a soft specular
// that follows the pointer (or the phone's tilt, where that needs no permission prompt) and one
// light sweep on arrival. Once that frosted frame is fully in, and not before, the modal itself
// goes translucent over it (smoked in the dark scheme, milky in the light one).
//
// The modal is rendered by GameShell, outside any element PoBrawlPage's scoped CSS can reach
// with ::deep, so the Brawl-only modal rules ride on a constructable stylesheet this module
// adopts while the glass is up (data-pb-glass on <html>) and drops with it.
//
// Created lazily on the modal, destroyed on 'countdown' / 'reset' / dispose or when the modal
// closes; the extra context is released with loseContext. Low tier: nothing here — the modal's
// own CSS backdrop-filter is the fallback. Reduced motion: no sweep and a fixed highlight.
// Presentation only.

import * as Quality from './quality.js';

const LEVELS = 5;          // dual-Kawase depth (1/2 … 1/32)
const FADE_SEC = 0.5;
const SWEEP_SEC = 1.3;
const POLL_FRAMES = 6;     // look for the modal every Nth frame
const PLATE = 14;          // css px the glass plate stands out past the card

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uHalf;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 s = texture(uTex, vUv) * 4.0;
  s += texture(uTex, vUv - uHalf);
  s += texture(uTex, vUv + uHalf);
  s += texture(uTex, vUv + vec2(uHalf.x, -uHalf.y));
  s += texture(uTex, vUv - vec2(uHalf.x, -uHalf.y));
  o = s / 8.0;
}`;

const UP = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uHalf;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uHalf;
  vec4 s = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0));
  s += texture(uTex, vUv + vec2(-h.x, h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(0.0, h.y * 2.0));
  s += texture(uTex, vUv + vec2(h.x, h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(h.x * 2.0, 0.0));
  s += texture(uTex, vUv + vec2(h.x, -h.y)) * 2.0;
  s += texture(uTex, vUv + vec2(0.0, -h.y * 2.0));
  s += texture(uTex, vUv + vec2(-h.x, -h.y)) * 2.0;
  o = s / 12.0;
}`;

const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uMid;
uniform sampler2D uBlur;
uniform vec2 uRes;      // canvas px
uniform vec4 uRect;     // slab x, y (bottom-left, GL px), w, h
uniform float uRad;     // corner radius, px
uniform float uBevel;   // bevel width, px
uniform vec2 uPtr;      // light position, GL px
uniform float uFade;    // 0..1 arrival
uniform float uSweep;   // 0..1 light sweep progress, <0 off
uniform float uDpr;
uniform float uLight;   // 1 = light scheme: milky plate
in vec2 vUv;
out vec4 o;

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uRes;
  vec3 src = texture(uSrc, uv).rgb;

  // The room behind: frosted, dimmed toward the night-blue of the hall.
  vec3 bg = mix(texture(uMid, uv).rgb, texture(uBlur, uv).rgb, 0.55);
  bg = mix(bg * 0.56, vec3(0.03, 0.05, 0.11), 0.2);

  vec2 hb = uRect.zw * 0.5;
  vec2 p = px - (uRect.xy + hb);
  float rad = min(uRad, min(hb.x, hb.y));
  float d = sdBox(p, hb, rad);

  // Contact shadow under the slab, dropped a little.
  float ds = sdBox(p + vec2(0.0, 16.0 * uDpr), hb, rad);
  bg *= 1.0 - 0.55 * exp(-max(ds, 0.0) / (34.0 * uDpr)) * step(0.0, d);
  // A dark hairline just outside the rim gives the plate its edge.
  bg *= 1.0 - 0.45 * smoothstep(3.0 * uDpr, 0.0, d) * step(0.0, d);

  // Bevel: SDF gradient = the edge normal; slope strongest at the rim.
  vec2 e = vec2(1.0, 0.0);
  vec2 n = vec2(sdBox(p + e.xy, hb, rad) - sdBox(p - e.xy, hb, rad),
                sdBox(p + e.yx, hb, rad) - sdBox(p - e.yx, hb, rad));
  n = length(n) > 1e-5 ? normalize(n) : vec2(0.0);
  float b = clamp(-d / uBevel, 0.0, 1.0);
  float slope = (1.0 - b) * (1.0 - b);

  // Refraction pulls the frame in toward the rim; each channel bends a little differently.
  vec2 off = -n * slope * 46.0 * uDpr / uRes;
  vec3 glass = vec3(
    texture(uBlur, uv + off * 1.0).r,
    texture(uBlur, uv + off * 1.18).g,
    texture(uBlur, uv + off * 1.36).b);
  // Navy body, so the card's text keeps its contrast.
  glass = mix(glass * 0.6 + vec3(0.06, 0.08, 0.13), glass * 0.42 + vec3(0.56, 0.58, 0.62), uLight);

  // Specular: the bevel facing the light catches it; a broad soft spot under the light.
  vec2 toL = uPtr - (uRect.xy + hb);
  vec2 ldir = length(toL) > 1.0 ? normalize(toL) : vec2(-0.6, 0.8);
  float facing = max(dot(n, ldir), 0.0);
  float rim = smoothstep(2.4 * uDpr, 0.0, abs(d + 1.4 * uDpr));
  vec2 dl = (px - uPtr) / (220.0 * uDpr);
  float spot = exp(-dot(dl, dl)) * 0.085;
  glass += vec3(0.95, 0.97, 1.0) * (slope * (0.05 + facing * 0.3) + rim * (0.2 + 0.5 * facing) + spot);

  // One diagonal light sweep across the slab on arrival, with a faint caustic ripple in it.
  if (uSweep >= 0.0) {
    float q = (p.x + p.y) / (hb.x + hb.y);
    float c = mix(-1.5, 1.5, uSweep);
    float band = exp(-pow((q - c) * 5.0, 2.0));
    float caustic = 0.6 + 0.4 * sin(p.x * 0.045 / uDpr + p.y * 0.07 / uDpr + uSweep * 9.0);
    glass += vec3(0.9, 0.95, 1.0) * band * caustic * 0.16 * (1.0 - uSweep * 0.5);
  }

  float inside = 1.0 - smoothstep(-0.75, 0.75, d);
  vec3 col = mix(bg, glass, inside);
  o = vec4(mix(src, col, uFade), 1.0);
}`;

// Only once the frosted frame is fully in (data-pb-glass is set by _glassDraw then, never before):
// until that moment the modal keeps its own opaque, frosted panel and the stock backdrop.
const SHEET = `
:root[data-pb-glass] dialog.gps-modal.gps-modal,
:root[data-pb-glass] dialog.gps-modal.gps-modal[data-glass-live] {
  background: rgba(10, 14, 28, 0.42) !important;
  background-image: none !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  border-color: rgba(255, 255, 255, 0.26) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.05) !important;
  transition: background-color 0.35s ease-out;
}
:root[data-pb-glass='light'] dialog.gps-modal.gps-modal,
:root[data-pb-glass='light'] dialog.gps-modal.gps-modal[data-glass-live] {
  background: rgba(255, 255, 255, 0.6) !important;
  border-color: rgba(255, 255, 255, 0.7) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 0 0 1px rgba(15, 23, 42, 0.12) !important;
}
:root[data-pb-glass] .gl-top-bar,
:root[data-pb-glass] .pb-canvas-host > :not(canvas),
:root[data-pb-glass] .pb-wrap > :not(.pb-canvas-host) {
  filter: blur(5px) brightness(0.7);
}
:root[data-pb-glass] dialog.gps-modal::backdrop {
  background: transparent !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  transition: background-color 0.35s ease-out;
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  return p;
}

function target(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

class ResultGlassMethods {
  _initResultGlass() {
    this._rg = {
      armed: false, want: false, poll: 0,
      dialog: null, gone: 0, closing: 0,
      g: null,            // the live overlay: { canvas, gl, ... }
      t: 0, calm: false,
      ptrX: -1, ptrY: -1, tiltX: 0, tiltY: 0, tilt: false,
      sheet: null,
    };
    this._rgMove = (e) => { this._rg.ptrX = e.clientX; this._rg.ptrY = e.clientY; };
    this._rgTilt = (e) => {
      if (e.gamma == null || e.beta == null) return;
      const rg = this._rg;
      rg.tilt = true;
      rg.tiltX = Math.max(-1, Math.min(1, e.gamma / 35));
      rg.tiltY = Math.max(-1, Math.min(1, (e.beta - 45) / 35));
    };
    this._onShow((type) => {
      const rg = this._rg;
      if (type === 'result') {
        rg.armed = true;
        rg.poll = 0;
      } else if (type === 'countdown' || type === 'reset') {
        rg.armed = false;
        rg.want = false;
        this._glassDestroy();
      }
    });
    this._onShowUpdate((dt) => this._glassUpdate(dt));
    this._onShowRender(() => this._glassRender());
    this._onShowDispose(() => { this._rg.armed = false; this._glassDestroy(); });
  }

  _glassUpdate(dt) {
    const rg = this._rg;
    if (rg.g) {
      rg.t += dt;
      const open = Boolean(rg.dialog && rg.dialog.isConnected && (rg.dialog.tagName !== 'DIALOG' || rg.dialog.open));
      if (!open && !rg.closing) rg.closing = 0.0001;
      if (rg.closing) {
        rg.closing += dt;
        if (rg.closing > 0.25) this._glassDestroy();
      }
      return;
    }
    if (!rg.armed || this.phase !== 'result' || rg.want) return;
    if (++rg.poll % POLL_FRAMES) return;
    const d = document.querySelector('.gps-modal[data-po-dialog="gameover"], dialog.gps-modal[open]');
    if (!d) return;
    rg.armed = false;
    // Low tier keeps the modal's own backdrop-filter; nothing to build.
    if (Quality.tier() === 'low') return;
    rg.dialog = d;
    rg.want = true;
  }

  _glassRender() {
    const rg = this._rg;
    if (rg.want) {
      rg.want = false;
      try { this._glassBuild(); } catch (e) {
        console.warn('[PoBrawl] result glass unavailable', e);
        this._glassDestroy();
        return;
      }
    }
    if (rg.g) {
      try { this._glassDraw(); } catch { this._glassDestroy(); }
    }
  }

  // Same task as the frame's render: capture it, blur it once, put the overlay in.
  _glassBuild() {
    const rg = this._rg;
    const src = this.renderer?.domElement;
    if (!src || !src.width || !src.height || !this.container) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'pb-glass';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = src.width;
    canvas.height = src.height;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
    });
    if (!gl) return;
    const g = { canvas, gl, levels: [], mid: null, src: null, vao: null, progs: null, u: null };
    rg.g = g;
    g.vao = gl.createVertexArray();
    gl.bindVertexArray(g.vao);
    const down = compile(gl, VS, DOWN), up = compile(gl, VS, UP), comp = compile(gl, VS, COMPOSITE);
    g.progs = [down, up, comp];
    const loc = (p, n) => gl.getUniformLocation(p, n);
    g.u = {
      down: { tex: loc(down, 'uTex'), half: loc(down, 'uHalf') },
      up: { tex: loc(up, 'uTex'), half: loc(up, 'uHalf') },
      c: {
        src: loc(comp, 'uSrc'), mid: loc(comp, 'uMid'), blur: loc(comp, 'uBlur'), res: loc(comp, 'uRes'),
        rect: loc(comp, 'uRect'), rad: loc(comp, 'uRad'), bevel: loc(comp, 'uBevel'), ptr: loc(comp, 'uPtr'),
        fade: loc(comp, 'uFade'), sweep: loc(comp, 'uSweep'), dpr: loc(comp, 'uDpr'), light: loc(comp, 'uLight'),
      },
    };

    // The finished frame.
    const W = canvas.width, H = canvas.height;
    g.src = target(gl, W, H);
    gl.bindTexture(gl.TEXTURE_2D, g.src.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Dual Kawase: down the pyramid, back up to half size. `mid` is a gentler two-level pass.
    let w = W, h = H;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      g.levels.push(target(gl, w, h));
    }
    const pass = (prog, u, from, to) => {
      gl.useProgram(prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
      gl.viewport(0, 0, to.w, to.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform1i(u.tex, 0);
      gl.uniform2f(u.half, 1 / from.w, 1 / from.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    let prev = g.src;
    for (const t of g.levels) { pass(down, g.u.down, prev, t); prev = t; }
    g.mid = target(gl, g.levels[0].w, g.levels[0].h);
    pass(up, g.u.up, g.levels[1], g.mid);
    g.ups = [];
    for (let i = LEVELS - 2; i >= 0; i--) {
      const t = target(gl, g.levels[i].w, g.levels[i].h);
      g.ups.push(t);
      pass(up, g.u.up, prev, t);
      prev = t;
    }
    g.blur = prev;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const cs = getComputedStyle(rg.dialog);
    g.radius = parseFloat(cs.borderTopLeftRadius) || 20;
    // Light scheme: the card's text is dark, so the plate goes milky instead of smoked.
    const rgb = (cs.color.match(/[\d.]+/g) || ['255', '255', '255']).map(Number);
    g.light = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / (cs.color.startsWith('rgb') ? 255 : 1) < 0.5;
    g.attr = false;
    rg.t = 0;
    rg.closing = 0;
    rg.calm = document.documentElement.getAttribute('data-motion') === 'reduce';
    rg.ptrX = rg.ptrY = -1;
    rg.tilt = false;
    window.addEventListener('pointermove', this._rgMove, { passive: true });
    // Tilt only where it needs no permission prompt (iOS asks; there it stays on the pointer).
    if (!rg.calm && typeof DeviceOrientationEvent !== 'undefined'
        && typeof DeviceOrientationEvent.requestPermission !== 'function') {
      window.addEventListener('deviceorientation', this._rgTilt, { passive: true });
    }
    try {
      if (!rg.sheet && typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
        rg.sheet = new CSSStyleSheet();
        rg.sheet.replaceSync(SHEET);
      }
      if (rg.sheet && !document.adoptedStyleSheets.includes(rg.sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, rg.sheet];
      }
    } catch { /* the modal keeps its own glass */ }

    // Under the shatter (if it is still falling) and every later overlay. Inserted after this
    // task, so a shatter armed on this same frame (spectacle.js) lands before it in DOM order.
    queueMicrotask(() => {
      if (rg.g !== g) return;
      const at = this._shatterEl && this._shatterEl.isConnected ? this._shatterEl : null;
      if (at) at.before(canvas); else src.after(canvas);
    });
  }

  _glassDraw() {
    const rg = this._rg;
    const g = rg.g;
    const gl = g.gl;
    if (gl.isContextLost()) { this._glassDestroy(); return; }
    const c = g.canvas;
    const hr = this.container.getBoundingClientRect();
    if (!hr.width || !hr.height) return;
    const sx = c.width / hr.width, sy = c.height / hr.height;
    // The plate stands a little proud of the card, so its bevel shows round the border.
    const r = rg.dialog.getBoundingClientRect();
    const x = (r.left - PLATE - hr.left) * sx;
    const w = (r.width + PLATE * 2) * sx, h = (r.height + PLATE * 2) * sy;
    const y = c.height - ((r.top - PLATE - hr.top) * sy + h);

    // Light: the pointer, or the phone's tilt, or (reduced motion / no pointer yet) top-left.
    let lx, ly;
    if (!rg.calm && rg.tilt) {
      lx = x + w * (0.5 + rg.tiltX * 0.7);
      ly = y + h * (0.5 - rg.tiltY * 0.7);
    } else if (!rg.calm && rg.ptrX >= 0) {
      lx = (rg.ptrX - hr.left) * sx;
      ly = c.height - (rg.ptrY - hr.top) * sy;
    } else {
      lx = x + w * 0.15;
      ly = y + h * 1.05;
    }

    const fadeIn = rg.calm ? 1 : Math.min(1, rg.t / FADE_SEC);
    const fadeOut = rg.closing ? Math.max(0, 1 - rg.closing / 0.25) : 1;
    const fade = fadeIn * (2 - fadeIn) * fadeOut;
    const sweepT = (rg.t - 0.25) / SWEEP_SEC;
    const sweep = rg.calm || sweepT < 0 || sweepT > 1 ? -1 : sweepT;

    const u = g.u.c;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(g.progs[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.src.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g.mid.tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, g.blur.tex);
    gl.uniform1i(u.src, 0);
    gl.uniform1i(u.mid, 1);
    gl.uniform1i(u.blur, 2);
    gl.uniform2f(u.res, c.width, c.height);
    gl.uniform4f(u.rect, x, y, w, h);
    gl.uniform1f(u.rad, (g.radius + PLATE) * sx);
    gl.uniform1f(u.bevel, 30 * sx);
    gl.uniform2f(u.ptr, lx, ly);
    gl.uniform1f(u.fade, fade);
    gl.uniform1f(u.sweep, sweep);
    gl.uniform1f(u.dpr, sx);
    gl.uniform1f(u.light, g.light ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The card goes translucent only once the frosted frame is fully in under it.
    if (!g.attr && fadeIn >= 1 && !rg.closing) {
      g.attr = true;
      document.documentElement.setAttribute('data-pb-glass', g.light ? 'light' : 'dark');
    }
  }

  _glassDestroy() {
    const rg = this._rg;
    if (!rg) return;
    document.documentElement.removeAttribute('data-pb-glass');
    if (rg.sheet) {
      try { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== rg.sheet); } catch { /* gone */ }
    }
    window.removeEventListener('pointermove', this._rgMove);
    window.removeEventListener('deviceorientation', this._rgTilt);
    const g = rg.g;
    rg.g = null;
    rg.dialog = null;
    rg.closing = 0;
    if (!g) return;
    const gl = g.gl;
    try {
      if (!gl.isContextLost()) {
        for (const t of [g.src, g.mid, ...g.levels, ...(g.ups || [])]) {
          if (!t) continue;
          gl.deleteFramebuffer(t.fbo);
          gl.deleteTexture(t.tex);
        }
        for (const p of g.progs || []) gl.deleteProgram(p);
        if (g.vao) gl.deleteVertexArray(g.vao);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* already lost */ }
    g.canvas.remove();
    g.canvas.width = g.canvas.height = 1;
  }
}

export const ResultGlass = ResultGlassMethods.prototype;
