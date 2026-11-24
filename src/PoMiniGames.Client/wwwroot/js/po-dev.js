// po-dev.js — drives po-dev.html, this app's consolidated developer window.
// Polls the server every 2 s, reads the opener page's live stats (window.__poStats),
// and listens on BroadcastChannel('po-debug') for per-game frame samples.
// Uses safe DOM APIs (no innerHTML).
(function () {
  var DIAG_CANDIDATES = ['/api/diag', '/health'];
  var diagUrl = null;
  var $ = function (id) { return document.getElementById(id); };

  function makeBadge(status) {
    var s = String(status || '').toLowerCase();
    var cls = /healthy|ok|up|reachable|pass|working|ready/.test(s) ? 'ok'
            : /degraded|warn|slow|not.?configured|unknown|skipped/.test(s) ? 'warn' : 'bad';
    var span = document.createElement('span');
    span.className = 'po-badge po-badge--' + cls;
    span.textContent = status || '?';
    return span;
  }

  function makeEmpty(tag, text) {
    var el = document.createElement(tag);
    el.className = 'empty';
    el.textContent = text;
    return el;
  }

  // Collect {name, status, ms} entries from whatever shape the app's diag JSON has.
  function collect(node, out, nameHint) {
    if (!node || typeof node !== 'object' || out.length > 60) return;
    if (Array.isArray(node)) { node.forEach(function (n) { collect(n, out); }); return; }
    var status = node.status || node.Status || node.state || node.verdict;
    var name = node.name || node.Name || node.key || node.title || node.label || nameHint;
    if (status && name && typeof status === 'string') {
      var ms = node.durationMs || node.latencyMs || node.duration || node.elapsedMs || node.ms;
      out.push({ name: name, status: status, ms: typeof ms === 'number' ? Math.round(ms) : (typeof ms === 'string' ? ms : '') });
    }
    Object.keys(node).forEach(function (k) {
      var v = node[k];
      if (v && typeof v === 'object') collect(v, out, k);
    });
  }

  async function findDiag() {
    for (var i = 0; i < DIAG_CANDIDATES.length; i++) {
      try {
        var r = await fetch(DIAG_CANDIDATES[i], { headers: { Accept: 'application/json' }, cache: 'no-store' });
        var ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.indexOf('json') < 0) continue;
        var found = []; collect(await r.json(), found);
        if (found.length) return DIAG_CANDIDATES[i];
      } catch (_) { }
    }
    return null;
  }

  async function pollServer() {
    var t0 = performance.now();
    try {
      var r = await fetch('/health/live', { cache: 'no-store' });
      $('latency').textContent = Math.round(performance.now() - t0);
      $('live').textContent = r.ok ? 'UP' : r.status;
      var c = r.headers.get('x-commit');
      $('commit').textContent = c ? c.slice(0, 7) : '–';
    } catch (e) {
      $('live').textContent = 'DOWN'; $('latency').textContent = '–';
    }
    var depsEl = $('deps');
    if (diagUrl === null) diagUrl = (await findDiag()) || '';
    if (!diagUrl) { depsEl.replaceChildren(makeEmpty('p', 'This app exposes no JSON diagnostics endpoint.')); return; }
    $('source').textContent = diagUrl;
    try {
      var d = await fetch(diagUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      var json = await d.json();
      var items = []; collect(json, items);
      var seen = {}; items = items.filter(function (i) { var k = i.name + '|' + i.status; if (seen[k]) return false; seen[k] = 1; return true; });
      if (!items.length) {
        depsEl.replaceChildren(makeEmpty('p', diagUrl + ' answered ' + d.status + ' with no named checks.'));
        return;
      }
      var frag = document.createDocumentFragment();
      items.forEach(function (i) {
        var row = document.createElement('div');
        row.className = 'row';
        var nameSpan = document.createElement('span');
        nameSpan.textContent = i.name;
        var code = document.createElement('code');
        code.textContent = i.ms !== '' ? i.ms + ' ms' : '';
        row.append(nameSpan, code, makeBadge(i.status));
        frag.appendChild(row);
      });
      depsEl.replaceChildren(frag);
    } catch (e) {
      depsEl.replaceChildren(makeEmpty('p', 'Could not read ' + diagUrl + ': ' + e.message));
    }
  }

  function readOpener() {
    var o = null;
    try { o = window.opener && !window.opener.closed ? window.opener : null; } catch (_) { }
    var s = o && o.__poStats;
    if (!s) { $('route').textContent = 'The app window is closed, so page stats are paused.'; return; }
    try {
      var title = o.document.title;
      $('app').textContent = title ? title + ' · developer view' : 'Developer view';
      document.title = $('app').textContent;
      var stamp = o.document.querySelector('.po-version');
      $('build').textContent = stamp ? stamp.textContent.trim() : '–';
      $('route').textContent = 'Route ' + o.location.pathname + ' · ' + s.navigations + ' navigations';
      var mem = o.performance && o.performance.memory;
      $('mem').textContent = mem ? (mem.usedJSHeapSize / 1048576).toFixed(1) : 'n/a';
    } catch (_) { }
    $('fps').textContent = s.fps;
    $('longtasks').textContent = s.longTasks;
    var secs = Math.round((Date.now() - s.startedAt) / 1000);
    $('uptime').textContent = secs < 120 ? secs + 's' : Math.round(secs / 60) + 'm';
    var errEl = $('errors');
    if (s.errors.length) {
      var frag = document.createDocumentFragment();
      s.errors.slice(-15).reverse().forEach(function (e) {
        var li = document.createElement('li');
        li.textContent = e.at.slice(11, 19) + ' ' + e.msg;
        frag.appendChild(li);
      });
      errEl.replaceChildren(frag);
    } else {
      var empty = makeEmpty('li', 'No errors since the page opened.');
      empty.style.listStyle = 'none';
      empty.style.marginLeft = '-18px';
      errEl.replaceChildren(empty);
    }
  }

  // Live per-game telemetry over BroadcastChannel('po-debug') (formerly debug-window.js).
  if (typeof BroadcastChannel !== 'undefined') {
    var channel = new BroadcastChannel('po-debug');
    var HISTORY = 120;
    var fpsHistory = [];

    function drawGraph() {
      var canvas = $('dw-graph');
      if (!canvas) return;
      canvas.hidden = false;
      var ctx = canvas.getContext('2d');
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      var style = getComputedStyle(document.body);
      ctx.strokeStyle = style.getPropertyValue('--po-border') || '#888';
      ctx.beginPath();
      ctx.moveTo(0, h - (60 / 70) * h);
      ctx.lineTo(w, h - (60 / 70) * h);
      ctx.stroke();
      if (fpsHistory.length < 2) return;
      ctx.strokeStyle = style.getPropertyValue('--po-accent') || '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      fpsHistory.forEach(function (fps, i) {
        var x = (i / (HISTORY - 1)) * w;
        var y = h - Math.min(1, fps / 70) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    channel.onmessage = function (e) {
      var m = e.data;
      if (!m || m.type !== 'sample') return;
      if (m.fps != null) {
        $('fps').textContent = m.fps.toFixed(0);
        fpsHistory.push(m.fps);
        if (fpsHistory.length > HISTORY) fpsHistory.shift();
        drawGraph();
      }
      var env = m.env || {};
      var rows = [];
      if (m.gameKey) rows.push(['Game', m.gameKey]);
      if (m.frameMs != null) rows.push(['Frame', m.frameMs.toFixed(1) + ' ms']);
      if (env.width && env.height) rows.push(['Viewport', env.width + '×' + env.height + (env.dpr && env.dpr !== 1 ? ' · ' + env.dpr + '×' : '')]);
      if (env.cores) rows.push(['Cores', String(env.cores)]);
      (m.items || []).forEach(function (item) { rows.push([item.label, item.value]); });
      (env.details || []).forEach(function (item) { rows.push([item.label, item.value]); });
      var section = $('dw-game-section');
      var dl = $('dw-game');
      if (section && dl) {
        section.hidden = rows.length === 0;
        var frag = document.createDocumentFragment();
        rows.forEach(function (r) {
          var dt = document.createElement('dt');
          dt.textContent = r[0];
          var dd = document.createElement('dd');
          dd.textContent = r[1];
          frag.append(dt, dd);
        });
        dl.replaceChildren(frag);
      }
    };

    var hello = function () { channel.postMessage({ type: 'hello' }); };
    hello();
    setInterval(hello, 1000);
    window.addEventListener('pagehide', function () { channel.postMessage({ type: 'bye' }); });
  }

  function loop() {
    readOpener();
    pollServer().finally(function () { $('updated').textContent = 'updated ' + new Date().toLocaleTimeString(); });
  }
  loop();
  setInterval(readOpener, 1000);
  setInterval(function () { pollServer().finally(function () { $('updated').textContent = 'updated ' + new Date().toLocaleTimeString(); }); }, 2000);
})();
