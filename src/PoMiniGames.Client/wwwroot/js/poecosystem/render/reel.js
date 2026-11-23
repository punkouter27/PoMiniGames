// reel.js — the photo drawer (formerly the "Island Reel"): stills only, no video.
//
// The player opens it (📷 Photos in the HUD "more" menu) to take a still: a plain one at up
// to twice the screen's resolution, a tilt-shift "miniature", or a four-second long
// exposure. Photos live in memory only (blob URLs), never leave the machine unless the
// player saves or shares one, and are revoked when the engine stops. There is deliberately
// no video recorder, replay buffer or clip saving anywhere in the game.
const MAX_PHOTOS = 6;
const EXPOSURE_MS = 4000;

/** Tilt-shift: blur top and bottom, keep a sharp band, push the saturation — a model village. */
export function tiltShift(src) {
  const w = src.width; const h = src.height;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const o = out.getContext('2d');
  const blur = Math.max(4, Math.round(h / 140));
  o.filter = `blur(${blur}px) saturate(1.45) contrast(1.06)`;
  o.drawImage(src, 0, 0);
  const band = document.createElement('canvas'); band.width = w; band.height = h;
  const b = band.getContext('2d');
  b.filter = 'saturate(1.45) contrast(1.06)';
  b.drawImage(src, 0, 0);
  b.filter = 'none';
  b.globalCompositeOperation = 'destination-in';
  const g = b.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.36, 'rgba(0,0,0,1)');
  g.addColorStop(0.62, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  b.fillStyle = g; b.fillRect(0, 0, w, h);
  o.filter = 'none';
  o.drawImage(band, 0, 0);
  return out;
}

export function createReel(host, { photo = null } = {}) {
  if (!host || typeof document === 'undefined') return { afterFrame() {}, toggle() {}, setSource() {}, dispose() {}, get photos() { return []; } };

  let source = null;
  const photos = [];
  let disposed = false;

  // ── the drawer ──────────────────────────────────────────────────────
  const drawer = document.createElement('aside');
  drawer.className = 'poeco-reel';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Photos');
  drawer.innerHTML = `
    <header class="poeco-reel-head">
      <h2 class="poeco-reel-title">Photos</h2>
      <button type="button" class="poeco-reel-close" aria-label="Close photos">✕</button>
    </header>
    <div class="poeco-reel-actions">
      <button type="button" class="poeco-btn" data-act="photo">📷 Photo</button>
      <button type="button" class="poeco-btn" data-act="mini">🔍 Miniature</button>
      <button type="button" class="poeco-btn" data-act="long" title="Four seconds of light on one frame: star trails, firelight, lava">🌠 Long exposure</button>
    </div>
    <p class="poeco-reel-note"></p>
    <ol class="poeco-reel-list"></ol>`;
  host.appendChild(drawer);
  const list = drawer.querySelector('.poeco-reel-list');
  const note = drawer.querySelector('.poeco-reel-note');
  // The world host is a Blazor element with its own click handler and the canvas's input
  // listens on the window for keys; the drawer is a UI island inside it, so nothing it
  // receives may leak out to either.
  for (const t of ['click', 'pointerdown', 'keydown', 'wheel']) drawer.addEventListener(t, (e) => e.stopPropagation());
  drawer.querySelector('.poeco-reel-close').addEventListener('click', () => setOpen(false));
  drawer.querySelector('[data-act="photo"]').addEventListener('click', () => takePhoto(false));
  drawer.querySelector('[data-act="mini"]').addEventListener('click', () => takePhoto(true));
  drawer.querySelector('[data-act="long"]').addEventListener('click', () => startExposure());

  // ── long exposure ──────────────────────────
  // Every composed frame for EXPOSURE_MS is laid onto one canvas with the `lighten`
  // operator, which keeps the brightest value each pixel ever had: the stars draw their
  // arcs, a campfire becomes a column, lava a river, and a still landscape stays as it was.
  // It rides the renderer's after-render hook, so the drawing buffer is valid.
  let exposure = null;
  function startExposure() {
    if (exposure || !source || !source.width || !source.height) return;
    const w = Math.min(1920, source.width); const h = Math.max(1, Math.round(w * source.height / source.width));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    exposure = { canvas, ctx: canvas.getContext('2d', { alpha: false }), until: performance.now() + EXPOSURE_MS, frames: 0 };
    note.textContent = 'Exposing — four seconds. Best after dark, with the camera still.';
  }
  function expose(now) {
    const e = exposure;
    try {
      e.ctx.globalCompositeOperation = e.frames === 0 ? 'source-over' : 'lighten';
      e.ctx.drawImage(source, 0, 0, e.canvas.width, e.canvas.height);
      e.frames++;
    } catch { /* context lost: the frames already laid still make a picture */ }
    if (now < e.until) return;
    exposure = null;
    e.canvas.toBlob((blob) => { if (!disposed) addPhoto(blob, 'Long exposure'); }, 'image/png');
  }

  function setNote() {
    note.textContent = photos.length ? '' : 'Take a still of the island. Nothing leaves this device unless you save or share it.';
  }

  function renderList() {
    list.replaceChildren(...photos.map((c) => {
      const li = document.createElement('li');
      li.className = 'poeco-reel-item';
      const img = document.createElement('img');
      img.src = c.url; img.alt = c.caption;
      const cap = document.createElement('p'); cap.className = 'poeco-reel-caption'; cap.textContent = c.caption;
      const row = document.createElement('div'); row.className = 'poeco-reel-row';
      const save = document.createElement('a');
      save.className = 'poeco-btn'; save.href = c.url; save.download = c.filename; save.textContent = 'Save';
      row.append(save);
      if (navigator.canShare && navigator.share) {
        const share = document.createElement('button');
        share.type = 'button'; share.className = 'poeco-btn'; share.textContent = 'Share';
        share.addEventListener('click', async () => {
          try {
            const file = new File([c.blob], c.filename, { type: c.blob.type });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: c.caption });
          } catch { /* dismissed or unsupported */ }
        });
        row.append(share);
      }
      li.append(img, cap, row);
      return li;
    }));
    setNote();
  }

  function addPhoto(blob, caption) {
    if (!blob || blob.size === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const slug = (caption || 'island').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'island';
    photos.unshift({ blob, url: URL.createObjectURL(blob), caption: caption || 'The island', filename: `poecosystem-${slug}-${stamp}.png` });
    while (photos.length > MAX_PHOTOS) URL.revokeObjectURL(photos.pop().url);
    renderList();
    host.closest('.poeco-root')?.querySelector('.poeco-reel-btn')?.classList.add('poeco-pill--fresh');
  }

  async function takePhoto(miniature) {
    if (!photo) return;
    try {
      const canvas = await photo();
      if (!canvas) return;
      const final = miniature ? tiltShift(canvas) : canvas;
      const blob = await new Promise((res) => final.toBlob(res, 'image/png'));
      addPhoto(blob, miniature ? 'Miniature island' : 'The island');
    } catch { /* a failed still is not worth an error banner */ }
  }

  function setOpen(on) {
    drawer.hidden = !on;
    if (on) {
      renderList();
      host.closest('.poeco-root')?.querySelector('.poeco-reel-btn')?.classList.remove('poeco-pill--fresh');
    }
  }

  return {
    /** The WebGL canvas to read from (it changes when the renderer is rebuilt). */
    setSource(canvas) { source = canvas; },
    /** Called by the renderer right after each composed frame (feeds the long exposure). */
    afterFrame() {
      if (source && exposure) expose(performance.now());
    },
    toggle() { setOpen(drawer.hidden); return !drawer.hidden; },
    get open() { return !drawer.hidden; },
    get photos() { return photos.map(c => ({ caption: c.caption, bytes: c.blob.size })); },
    /** Begin a long exposure (also the drawer's button); the still lands in the drawer. */
    longExposure: startExposure,
    get exposing() { return !!exposure; },
    dispose() {
      disposed = true;
      for (const c of photos) URL.revokeObjectURL(c.url);
      photos.length = 0;
      drawer.remove();
    },
  };
}
