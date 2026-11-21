// minimap.js — High-DPI 2D live track minimap overlay for PoMarbleRace.
// Renders the randomized Grand Circuit centerline, color-coded Act zones, all 100 rival marbles,
// and the player's pulsing red marble on a lightweight corner canvas (no DOM thrash).
const ACTS = [
  { from: 0.00, to: 0.21, color: '#f59e0b' }, // Act 1: Spiral Works (Split Lanes)
  { from: 0.21, to: 0.52, color: '#e879f9' }, // Act 2: Neon Canyon (Plinko & Bobs)
  { from: 0.52, to: 0.69, color: '#fbbf24' }, // Act 3: Grand Spiral (Vortex Funnel & Plunge)
  { from: 0.69, to: 0.86, color: '#38bdf8' }, // Act 4: Playground Run (Drop Tunnel & Slide)
  { from: 0.86, to: 1.00, color: '#ef4444' }, // Act 5: Double Gauntlet & Finish
];

export function createMinimap(container) {
  if (!container || typeof document === 'undefined') {
    return { setTrack() { }, update() { }, dispose() { } };
  }

  const W = 92, H = 220;
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
    borderRadius: '12px',
    background: 'rgba(10, 14, 30, 0.56)',
    border: '1px solid rgba(148, 163, 184, 0.24)',
    backdropFilter: 'blur(6px)',
    pointerEvents: 'none',
    zIndex: '4',
  });
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let pts = [];
  let minX = -1, maxX = 1, maxZ = 1;
  let trackLen = 1;
  let pulseT = 0;

  function toScreen(x, z) {
    const padX = 14, padY = 14;
    const nx = (x - minX) / Math.max(1, maxX - minX);
    const nz = z / Math.max(1, maxZ);
    return [padX + nx * (W - padX * 2), padY + nz * (H - padY * 2)];
  }

  function setTrack(track) {
    pts = [];
    if (!track || !track.centerAt || !track.length) return;
    trackLen = track.length;
    minX = Infinity; maxX = -Infinity; maxZ = trackLen;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const p = track.centerAt(f * trackLen);
      pts.push({ f, x: p.x, z: p.z });
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    const span = Math.max(60, maxX - minX);
    const mid = (minX + maxX) * 0.5;
    minX = mid - span * 0.55;
    maxX = mid + span * 0.55;
  }

  function update(marbles, chosenIdx, dt = 0.016) {
    if (!ctx || pts.length < 2) return;
    pulseT += dt * 5;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Draw color-coded Act segments along the randomized spline.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const act of ACTS) {
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.f < act.from - 0.01 || p.f > act.to + 0.01) continue;
        const [sx, sy] = toScreen(p.x, p.z);
        if (!started) { ctx.moveTo(sx, sy); started = true; }
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = act.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw rival pack dots.
    if (marbles && marbles.length) {
      for (let i = 0; i < marbles.length; i++) {
        if (i === chosenIdx) continue;
        const m = marbles[i];
        if (!m || m.eliminated || !m.body) continue;
        const [sx, sy] = toScreen(m.body.position.x, m.body.position.z);
        ctx.fillStyle = m.finished ? 'rgba(255,255,255,0.4)' : 'rgba(148,163,184,0.85)';
        ctx.fillRect(sx - 1.2, sy - 1.2, 2.4, 2.4);
      }

      // Draw player's red marble with a crisp pulsing halo.
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
      }
    }
  }

  function dispose() {
    canvas.remove();
  }

  return { setTrack, update, dispose };
}
