// debug-window.js — the pop-out developer window (debug-window.html).
//
// The app tab (game-debug.js) samples frame rate and the page's diagnostics and posts them on
// the 'po-debug' BroadcastChannel; this window only listens and draws. It says hello on open and
// every second after, which is how the app tab knows someone is watching and keeps sampling
// even with its own in-page panel closed. Same origin only: BroadcastChannel never leaves it.

(function () {
  const channel = new BroadcastChannel('po-debug');
  const HISTORY = 120;           // samples kept for the graph (about a minute at 500 ms)
  const STALE_MS = 2500;
  const fpsHistory = [];
  let lastMessageAt = 0;

  const $ = (id) => document.getElementById(id);

  function row(dl, label, value, cls) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  }

  function fill(id, rows) {
    const dl = $(id);
    dl.replaceChildren();
    for (const r of rows) row(dl, r[0], r[1], r[2]);
  }

  function tier(fps) { return fps >= 55 ? 'ok' : fps >= 30 ? 'warn' : 'bad'; }

  function drawGraph() {
    const canvas = $('dw-graph');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.body);
    ctx.strokeStyle = style.getPropertyValue('--color-border') || '#888';
    ctx.beginPath();
    ctx.moveTo(0, h - (60 / 70) * h);
    ctx.lineTo(w, h - (60 / 70) * h);
    ctx.stroke();
    if (fpsHistory.length < 2) return;
    ctx.strokeStyle = style.getPropertyValue('--color-accent') || '#6366f1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    fpsHistory.forEach((fps, i) => {
      const x = (i / (HISTORY - 1)) * w;
      const y = h - Math.min(1, fps / 70) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function setLive(live, text) {
    $('dw-state').classList.toggle('dw-live', live);
    $('dw-state-text').textContent = text;
  }

  channel.onmessage = (e) => {
    const m = e.data;
    if (!m || m.type !== 'sample') return;
    lastMessageAt = Date.now();
    setLive(true, `Live · ${m.title || 'PoMiniGames'}`);
    if (m.fps != null) {
      fpsHistory.push(m.fps);
      if (fpsHistory.length > HISTORY) fpsHistory.shift();
    }
    fill('dw-frame', [
      ['FPS', m.fps != null ? m.fps.toFixed(0) : '—', m.fps != null ? tier(m.fps) : ''],
      ['Frame', m.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : '—'],
      ['Worst of last minute', fpsHistory.length ? `${Math.min(...fpsHistory).toFixed(0)} fps` : '—'],
    ]);
    const env = m.env || {};
    fill('dw-page', [
      ['Route', m.route || '/'],
      ['Viewport', `${env.width}×${env.height}${env.dpr && env.dpr !== 1 ? ` · ${env.dpr}×` : ''}`],
      ['Heap', env.heapMb >= 0 ? `${env.heapMb.toFixed(1)} MB` : 'n/a'],
      ['Cores', env.cores || 'n/a'],
      ['Online', m.online ? 'yes' : 'no'],
    ]);
    const game = [];
    if (m.gameKey) game.push(['Game', m.gameKey]);
    for (const item of m.items || []) game.push([item.label, item.value]);
    for (const item of (env.details || [])) game.push([item.label, item.value]);
    $('dw-game-section').hidden = game.length === 0;
    fill('dw-game', game);
    drawGraph();
  };

  function hello() { channel.postMessage({ type: 'hello' }); }
  hello();
  setInterval(() => {
    hello();
    if (lastMessageAt && Date.now() - lastMessageAt > STALE_MS) setLive(false, 'The app tab is closed or hidden');
  }, 1000);
  window.addEventListener('pagehide', () => channel.postMessage({ type: 'bye' }));
})();
