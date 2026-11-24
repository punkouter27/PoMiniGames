// minimap.js — High-DPI 2D live track minimap, elevation bar, radial speed/boost arc, and
// Act-transition glass banner for PoMarbleRace (zero Blazor DOM thrash).
// The fallback acts; a dealt course brings its own (track.acts, composer.js).
const DEFAULT_ACTS = [
  { from: 0.00, to: 0.21, color: '#f59e0b', tag: 'ACT 1 · SPIRAL WORKS', sub: 'Brake Strip & Split-Lane Island' },
  { from: 0.21, to: 0.52, color: '#e879f9', tag: 'ACT 2 · NEON CANYON', sub: 'Plinko Scramble, Kickers & Pendulums' },
  { from: 0.52, to: 0.69, color: '#fbbf24', tag: 'ACT 3 · GRAND SPIRAL', sub: 'Washboard, Vortex Funnel & Plunge' },
  { from: 0.69, to: 0.86, color: '#38bdf8', tag: 'ACT 4 · PLAYGROUND RUN', sub: 'Enclosed Drop Tunnel & Big Slide' },
  { from: 0.86, to: 1.00, color: '#ef4444', tag: 'ACT 5 · GRAND FINALE', sub: 'Double Gauntlet to the Checkered Tray' },
];

const LEADER_COLORS = ['#facc15', '#e2e8f0', '#fb923c']; // 1st gold, 2nd silver, 3rd bronze

export function createMinimap(container) {
  if (!container || typeof document === 'undefined') {
    return { setTrack() { }, update() { }, showAct() { }, showBanner() { }, dispose() { } };
  }

  const W = 104, H = 228;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.className = 'mr-minimap';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    right: '14px',
    bottom: '84px',
    width: `${W}px`,
    height: `${H}px`,
    borderRadius: '14px',
    background: 'rgba(10, 14, 30, 0.62)',
    border: '1px solid rgba(148, 163, 184, 0.28)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'none',
    zIndex: '4',
  });
  container.appendChild(canvas);

  // Diegetic radial speed & boost arc at bottom-center.
  const GW = 160, GH = 58;
  const gauge = document.createElement('canvas');
  gauge.width = Math.round(GW * dpr);
  gauge.height = Math.round(GH * dpr);
  gauge.className = 'mr-speed-arc';
  gauge.setAttribute('aria-hidden', 'true');
  Object.assign(gauge.style, {
    position: 'absolute',
    left: '50%',
    bottom: '14px',
    transform: 'translateX(-50%)',
    width: `${GW}px`,
    height: `${GH}px`,
    pointerEvents: 'none',
    zIndex: '4',
  });
  container.appendChild(gauge);

  // Act-transition glass toast banner at top-center.
  const banner = document.createElement('div');
  banner.className = 'mr-act-banner';
  banner.setAttribute('aria-live', 'polite');
  Object.assign(banner.style, {
    position: 'absolute',
    top: '16px',
    left: '50%',
    transform: 'translate(-50%, -18px)',
    opacity: '0',
    padding: '8px 18px',
    borderRadius: '999px',
    background: 'rgba(10, 14, 30, 0.72)',
    border: '1px solid rgba(34, 211, 238, 0.45)',
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(10px)',
    color: '#f8fafc',
    font: '600 13px/1.25 system-ui, sans-serif',
    letterSpacing: '0.04em',
    textAlign: 'center',
    pointerEvents: 'none',
    transition: 'opacity 260ms ease, transform 320ms cubic-bezier(.22,1,.36,1)',
    zIndex: '5',
    whiteSpace: 'nowrap',
  });
  container.appendChild(banner);
  let bannerTimer = 0;

  const ctx = canvas.getContext('2d');
  const gctx = gauge.getContext('2d');
  let pts = [];
  let minX = -1, maxX = 1, minY = 0, maxY = 1, maxZ = 1;
  let trackLen = 1;
  let pulseT = 0;
  let smoothSpd = 0;

  function toScreen(x, z) {
    const padL = 22, padR = 12, padY = 14;
    const nx = (x - minX) / Math.max(1, maxX - minX);
    const nz = z / Math.max(1, maxZ);
    return [padL + nx * (W - padL - padR), padY + nz * (H - padY * 2)];
  }

  let acts = DEFAULT_ACTS;
  function setTrack(track) {
    pts = [];
    acts = track && track.acts && track.acts.length ? track.acts : DEFAULT_ACTS;
    if (!track || !track.centerAt || !track.length) return;
    trackLen = track.length;
    minX = Infinity; maxX = -Infinity;
    minY = Infinity; maxY = -Infinity;
    maxZ = trackLen;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const p = track.centerAt(f * trackLen);
      pts.push({ f, x: p.x, y: p.y, z: p.z });
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(60, maxX - minX);
    const mid = (minX + maxX) * 0.5;
    minX = mid - span * 0.55;
    maxX = mid + span * 0.55;
  }

  function showAct(actIdx) {
    const act = acts[actIdx];
    if (!act) return;
    showBanner(act.tag, act.sub, act.color);
  }

  // The glass banner: a tag in the accent colour and a quieter subtitle. Text only (textContent),
  // never markup.
  function showBanner(tag, sub, color, ms = 2800) {
    banner.textContent = '';
    const a = document.createElement('span');
    a.style.cssText = `color:${color};font-weight:700`;
    a.textContent = tag;
    const b = document.createElement('span');
    b.style.cssText = 'opacity:.78;margin-left:6px;font-weight:500';
    b.textContent = sub;
    banner.appendChild(a);
    banner.appendChild(b);
    banner.style.borderColor = color;
    banner.style.opacity = '1';
    banner.style.transform = 'translate(-50%, 0)';
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transform = 'translate(-50%, -14px)';
    }, ms);
  }

  function drawSpeedArc(speed, boosting, braking) {
    if (!gctx) return;
    smoothSpd += (speed - smoothSpd) * 0.18;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, GW, GH);

    const cx = GW / 2, cy = GH + 18, r = 58;
    const a0 = Math.PI * 1.15, a1 = Math.PI * 1.85;
    const frac = Math.max(0, Math.min(1, smoothSpd / 115));

    // Track backdrop arc
    gctx.beginPath();
    gctx.arc(cx, cy, r, a0, a1);
    gctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    gctx.lineWidth = 6;
    gctx.lineCap = 'round';
    gctx.stroke();

    // Active velocity arc
    const col = boosting ? '#22d3ee' : braking ? '#f97316' : '#a855f7';
    gctx.beginPath();
    gctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac);
    gctx.strokeStyle = col;
    gctx.lineWidth = boosting ? 8 : 6;
    gctx.shadowColor = col;
    gctx.shadowBlur = boosting ? 12 : 4;
    gctx.stroke();
    gctx.shadowBlur = 0;

    // Compact speed readout
    gctx.fillStyle = '#f8fafc';
    gctx.font = '700 13px system-ui, sans-serif';
    gctx.textAlign = 'center';
    gctx.fillText(`${Math.round(smoothSpd)} u/s`, cx, GH - 6);
  }

  function update(marbles, chosenIdx, dt = 0.016, order = null, boosting = false, braking = false) {
    if (!ctx || pts.length < 2) return;
    pulseT += dt * 5;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Left-edge vertical elevation profile bar
    const barX = 9, barTop = 14, barH = H - 28;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barX, barTop);
    ctx.lineTo(barX, barTop + barH);
    ctx.stroke();

    // Draw color-coded Act segments along the randomized spline.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const act of acts) {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.f < act.from - 0.01 || p.f > act.to + 0.01) continue;
        const [sx, sy] = toScreen(p.x, p.z);
        if (!started) { ctx.moveTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = act.color;
      ctx.globalAlpha = 0.58;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (marbles && marbles.length) {
      // Top-3 leader indices (for gold/silver/bronze dots)
      const top3 = new Map();
      if (order && order.length) {
        for (let k = 0; k < Math.min(3, order.length); k++) top3.set(order[k].index, k);
      }

      // Draw rival pack dots
      for (let i = 0; i < marbles.length; i++) {
        if (i === chosenIdx || top3.has(i)) continue;
        const m = marbles[i];
        if (!m || m.eliminated || !m.body) continue;
        const [sx, sy] = toScreen(m.body.position.x, m.body.position.z);
        ctx.fillStyle = m.finished ? 'rgba(255,255,255,0.4)' : 'rgba(148,163,184,0.82)';
        ctx.fillRect(sx - 1.1, sy - 1.1, 2.2, 2.2);
      }

      // Draw Top-3 podium leader crowns (gold/silver/bronze)
      for (const [idx, rank] of top3) {
        if (idx === chosenIdx) continue;
        const m = marbles[idx];
        if (!m || m.eliminated || !m.body) continue;
        const [sx, sy] = toScreen(m.body.position.x, m.body.position.z);
        ctx.beginPath();
        ctx.arc(sx, sy, 3.0, 0, Math.PI * 2);
        ctx.fillStyle = LEADER_COLORS[rank];
        ctx.fill();
      }

      // Draw player's red marble + altitude tick on elevation bar + radial speed arc
      const me = marbles[chosenIdx >= 0 ? chosenIdx : 0];
      if (me && !me.eliminated && me.body) {
        const [sx, sy] = toScreen(me.body.position.x, me.body.position.z);
        const r = 4.2 + Math.sin(pulseT) * 1.1;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        // Altitude marker on left elevation bar
        const altFrac = 1 - Math.max(0, Math.min(1, (me.body.position.y - minY) / Math.max(1, maxY - minY)));
        const ay = barTop + altFrac * barH;
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(barX - 3, ay - 2, 6, 4);

        const spd = me.body.velocity ? me.body.velocity.length() : 0;
        drawSpeedArc(spd, boosting, braking);
      }
    }
  }

  function dispose() {
    clearTimeout(bannerTimer);
    canvas.remove();
    gauge.remove();
    banner.remove();
  }

  return { setTrack, update, showAct, showBanner, dispose };
}
