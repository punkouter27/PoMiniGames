// hud.js — the race's engine-owned overlays (no Blazor round trip per frame, like minimap.js):
//
//   · #7 the standings tower: the top five with gaps in seconds, your row pinned under them when you
//     are further back. Every row is absolutely placed and moved by `transform`, so an overtake is
//     a row sliding past another with a little spring, not a list re-rendering;
//   · #8 threat arrows: chevrons on the bottom edge for rivals closing on you from behind, out of
//     shot. They grow and turn red as the gap closes;
//   · #9 the leader-cam label, pinned to the inset scene.js composites in the lens;
//   · #2 the iris: a marble-round wipe that opens out of your marble on GO and closes onto the
//     winner at the line, with a lit ring on its edge;
//   · #3 the flyover's set-piece tags, pinned to the course while the camera looks down on it.
//
// Text goes in by textContent only. Everything respects prefers-reduced-motion.

const STYLE_ID = 'mr-hud-style';
const CSS = `
@property --mr-iris { syntax: '<length>'; inherits: false; initial-value: 0px; }
.mr-tower { position: absolute; left: 14px; top: 78px; z-index: 4; width: 214px; pointer-events: none;
  font: 600 12px/1 var(--font-display, system-ui, sans-serif); color: #e2e8f0;
  padding: 6px; border-radius: 12px; background: rgba(8, 12, 24, 0.62);
  border: 1px solid rgba(148, 163, 184, 0.22); box-shadow: 0 6px 18px rgba(2, 6, 18, 0.4);
  backdrop-filter: blur(8px) saturate(1.2); transition: opacity 260ms ease, transform 320ms cubic-bezier(.22,1,.36,1); }
.mr-tower.is-off { opacity: 0; transform: translateX(-12px); }
.mr-tower-rows { position: relative; }
.mr-tower-row { position: absolute; left: 0; right: 0; top: 0; height: 22px; display: flex; align-items: center; gap: 7px;
  padding: 0 6px; border-radius: 7px; will-change: transform;
  transition: transform 420ms cubic-bezier(.34,1.56,.64,1), opacity 240ms ease, background 240ms ease; }
.mr-tower-row.is-me { background: rgba(239, 68, 68, 0.2); box-shadow: inset 2px 0 0 #ef4444; }
.mr-tower-row.is-gone { opacity: 0; }
.mr-tower-row.is-flash { background: rgba(250, 204, 21, 0.28); }
.mr-tower-pos { width: 22px; text-align: right; font-variant-numeric: tabular-nums; color: #94a3b8; font-weight: 800; }
.mr-tower-row:nth-child(n) .mr-tower-pos.is-p1 { color: #facc15; }
.mr-tower-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dot); box-shadow: 0 0 6px var(--dot); }
.mr-tower-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mr-tower-gap { font-variant-numeric: tabular-nums; color: #94a3b8; font-weight: 600; }
.mr-tower-sep { position: absolute; left: 8px; right: 8px; height: 0; border-top: 1px dashed rgba(148, 163, 184, 0.35); transition: transform 420ms cubic-bezier(.34,1.56,.64,1), opacity 200ms ease; }
.mr-threat { position: absolute; bottom: 10px; z-index: 4; width: 34px; height: 20px; margin-left: -17px; pointer-events: none;
  background: var(--c, #fb923c); clip-path: polygon(50% 0, 100% 100%, 72% 100%, 50% 42%, 28% 100%, 0 100%);
  filter: drop-shadow(0 0 6px var(--c, #fb923c)); opacity: 0; transform: scale(var(--k, 1)); transform-origin: 50% 100%;
  transition: opacity 160ms ease; }
.mr-pip-label { position: absolute; z-index: 5; pointer-events: none; display: flex; align-items: center; gap: 6px;
  padding: 3px 9px 3px 7px; border-radius: 999px; background: rgba(8, 12, 24, 0.78);
  border: 1px solid rgba(250, 204, 21, 0.55); color: #fde68a; font: 800 10.5px/1.2 var(--font-display, system-ui, sans-serif);
  letter-spacing: 0.08em; transform: translateY(-50%); opacity: 0; transition: opacity 220ms ease; white-space: nowrap; }
.mr-pip-label i { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 6px #ef4444; animation: mr-rec 1.1s steps(2, jump-none) infinite; }
@keyframes mr-rec { 50% { opacity: 0.2; } }
.mr-iris { position: absolute; inset: 0; z-index: 6; pointer-events: none; opacity: 0; --mr-iris: 0px;
  background: radial-gradient(circle at var(--x, 50%) var(--y, 50%),
    transparent calc(var(--mr-iris) - 4px), var(--ring, rgba(56, 189, 248, 0.95)) calc(var(--mr-iris) - 2px),
    rgba(255, 255, 255, 0.9) var(--mr-iris), rgba(2, 6, 23, 0.97) calc(var(--mr-iris) + 3px)); }
.mr-tag { position: absolute; z-index: 5; pointer-events: none; transform: translate(-50%, -100%); opacity: 0;
  transition: opacity 260ms ease; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.mr-tag b { padding: 3px 9px; border-radius: 999px; background: rgba(8, 12, 24, 0.82); border: 1px solid var(--c);
  color: #f8fafc; font: 700 11px/1.2 var(--font-display, system-ui, sans-serif); white-space: nowrap;
  box-shadow: 0 0 12px color-mix(in srgb, var(--c) 45%, transparent); }
.mr-tag i { width: 2px; height: 14px; background: linear-gradient(var(--c), transparent); }
.mr-tag.is-on { opacity: 1; }
@media (max-width: 560px) { .mr-tower { display: none; } }
@media (max-height: 480px) { .mr-tower { display: none; } }
@media (prefers-reduced-motion: reduce) {
  .mr-tower-row, .mr-tower-sep { transition: opacity 200ms ease; }
  .mr-pip-label i { animation: none; }
  .mr-iris { display: none; }
}`;

const ROW_H = 24;
const TOP_N = 5;
const THREATS = 3;
const THREAT_RANGE = 26;   // course units behind you that count as "closing"

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const hexCss = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export function createHud(container) {
  const noop = () => { };
  // Headless (the node harness's DOM stub) or anything without real element styles: no overlays.
  const probe = typeof document !== 'undefined' && document.createElement ? document.createElement('div') : null;
  if (!container || !probe || typeof probe.style?.setProperty !== 'function' || typeof probe.animate !== 'function') {
    return { tower: noop, hideTower: noop, threats: noop, pipLabel: noop, iris: noop, tags: noop, clearTags: noop, dispose: noop };
  }
  ensureStyle();

  // ── #7 tower ──
  const tower = el('div', 'mr-tower is-off', container);
  tower.setAttribute('aria-hidden', 'true');
  const rowsBox = el('div', 'mr-tower-rows', tower);
  const sep = el('div', 'mr-tower-sep', rowsBox);
  const rows = new Map();   // marble index -> { root, pos, dot, name, gap, slot }
  function rowFor(idx) {
    let r = rows.get(idx);
    if (r) return r;
    const root = el('div', 'mr-tower-row is-gone', rowsBox);
    const pos = el('span', 'mr-tower-pos', root);
    const dot = el('span', 'mr-tower-dot', root);
    const name = el('span', 'mr-tower-name', root);
    const gap = el('span', 'mr-tower-gap', root);
    r = { root, pos, dot, name, gap, slot: -1, place: -1, text: '' };
    rows.set(idx, r);
    return r;
  }

  /**
   * `list`: [{ index, place, name, color (number), gap (s, 0 for the leader), me }], already the
   * rows to show in order (top five, then yours if you are outside them).
   */
  function showTower(list) {
    tower.classList.remove('is-off');
    const keep = new Set();
    let slot = 0;
    let pinned = false;
    for (const it of list) {
      const r = rowFor(it.index);
      keep.add(it.index);
      if (it.me && it.place > TOP_N) { pinned = true; slot = TOP_N; }
      const y = (slot + (pinned && it.me ? 0.35 : 0)) * ROW_H;
      if (r.slot !== slot) {
        r.root.style.transform = `translateY(${y}px)`;
        // a row that climbs flashes as it lands
        if (r.slot > slot && r.slot >= 0) {
          r.root.classList.add('is-flash');
          setTimeout(() => r.root.classList.remove('is-flash'), 380);
        }
        r.slot = slot;
      }
      r.root.classList.remove('is-gone');
      r.root.classList.toggle('is-me', !!it.me);
      if (r.place !== it.place) {
        r.place = it.place;
        r.pos.textContent = String(it.place);
        r.pos.classList.toggle('is-p1', it.place === 1);
      }
      const nm = it.name;
      if (r.name.textContent !== nm) r.name.textContent = nm;
      r.dot.style.setProperty('--dot', hexCss(it.color));
      const g = it.place === 1 ? 'LEAD' : it.finished ? 'FIN' : `+${it.gap.toFixed(1)}`;
      if (r.text !== g) { r.text = g; r.gap.textContent = g; }
      slot++;
    }
    sep.style.opacity = pinned ? '1' : '0';
    sep.style.transform = `translateY(${TOP_N * ROW_H + 4}px)`;
    rowsBox.style.height = `${(pinned ? TOP_N + 1.35 : Math.min(TOP_N, list.length)) * ROW_H}px`;
    for (const [idx, r] of rows) {
      if (keep.has(idx)) continue;
      // a row that dropped out slides down and fades, then goes
      r.root.classList.add('is-gone');
      r.root.style.transform = `translateY(${(TOP_N + 0.6) * ROW_H}px)`;
      r.slot = -1;
      if (!r.dead) {
        r.dead = setTimeout(() => {
          if (r.slot === -1) { r.root.remove(); rows.delete(idx); }
          r.dead = 0;
        }, 300);
      }
    }
  }
  function hideTower() { tower.classList.add('is-off'); }

  // ── #8 threat arrows ──
  const threatEls = Array.from({ length: THREATS }, () => el('div', 'mr-threat', container));
  /** `list`: [{ x (0..1 across the bottom), close 0..1, color }]. */
  function threats(list) {
    for (let i = 0; i < THREATS; i++) {
      const e = threatEls[i];
      const t = list[i];
      if (!t) { e.style.opacity = '0'; continue; }
      e.style.left = `${Math.max(4, Math.min(96, t.x * 100))}%`;
      e.style.setProperty('--k', (0.8 + t.close * 0.7).toFixed(2));
      // amber far, red close
      const c = t.close > 0.6 ? '#ef4444' : t.close > 0.3 ? '#f97316' : '#fbbf24';
      e.style.setProperty('--c', c);
      e.style.opacity = (0.35 + t.close * 0.65).toFixed(2);
    }
  }

  // ── #9 leader-cam label ──
  const pip = el('div', 'mr-pip-label', container);
  pip.setAttribute('aria-hidden', 'true');
  el('i', '', pip);
  const pipText = el('span', '', pip);
  function pipLabel(rect, alpha, text) {
    if (!rect || alpha <= 0.01) { pip.style.opacity = '0'; return; }
    pip.style.left = `calc(${(rect[0] * 100).toFixed(3)}% + 10px)`;
    pip.style.top = `calc(${(rect[1] * 100).toFixed(3)}% + 14px)`;
    pip.style.opacity = alpha.toFixed(2);
    if (pipText.textContent !== text) pipText.textContent = text;
  }

  // ── #2 iris ──
  const irisEl = el('div', 'mr-iris', container);
  let irisAnim = null;
  /**
   * `mode` 'open' (out of a point to the full frame) or 'blink' (close onto the point, hold, open).
   * x, y: 0..1 of the container.
   */
  function iris(mode, x, y, ring) {
    if (reducedMotion() || typeof irisEl.animate !== 'function') return;
    irisEl.style.setProperty('--x', `${(x * 100).toFixed(2)}%`);
    irisEl.style.setProperty('--y', `${(y * 100).toFixed(2)}%`);
    if (ring) irisEl.style.setProperty('--ring', ring);
    irisAnim?.cancel();
    const R = Math.hypot(container.clientWidth, container.clientHeight) * 1.05;
    const frames = mode === 'blink'
      ? [
        { '--mr-iris': `${R}px`, opacity: 1, easing: 'cubic-bezier(.55,0,.75,.4)' },
        { '--mr-iris': '34px', opacity: 1, offset: 0.42 },
        { '--mr-iris': '34px', opacity: 1, offset: 0.55, easing: 'cubic-bezier(.2,.7,.3,1)' },
        { '--mr-iris': `${R}px`, opacity: 1 },
      ]
      : [
        { '--mr-iris': '22px', opacity: 1, easing: 'cubic-bezier(.3,.6,.2,1)' },
        { '--mr-iris': `${R}px`, opacity: 1 },
      ];
    irisAnim = irisEl.animate(frames, { duration: mode === 'blink' ? 1250 : 760, fill: 'none' });
  }

  // ── #3 flyover tags ──
  const tagEls = [];
  /** `list`: [{ x, y (0..1) | null when off screen, text, color, on }]. */
  function tags(list) {
    while (tagEls.length < list.length) {
      const t = el('div', 'mr-tag', container);
      const b = el('b', '', t);
      el('i', '', t);
      tagEls.push({ t, b });
    }
    tagEls.forEach((e, i) => {
      const it = list[i];
      if (!it || it.x == null) { e.t.classList.remove('is-on'); return; }
      e.t.style.left = `${(it.x * 100).toFixed(2)}%`;
      e.t.style.top = `${(it.y * 100).toFixed(2)}%`;
      e.t.style.setProperty('--c', it.color);
      if (e.b.textContent !== it.text) e.b.textContent = it.text;
      e.t.classList.toggle('is-on', !!it.on);
    });
  }
  function clearTags() { for (const e of tagEls) e.t.classList.remove('is-on'); }

  function dispose() {
    irisAnim?.cancel();
    for (const r of rows.values()) if (r.dead) clearTimeout(r.dead);
    tower.remove();
    for (const e of threatEls) e.remove();
    pip.remove();
    irisEl.remove();
    for (const e of tagEls) e.t.remove();
  }

  return { tower: showTower, hideTower, threats, pipLabel, iris, tags, clearTags, dispose };
}
