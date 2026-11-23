// pip.js — the island in a corner of the desktop while the player does something else.
//
// Two mechanisms, tried in order:
//   1. Document Picture-in-Picture (Chromium 116+): an always-on-top window that gets a 2D
//      canvas MIRROR of the WebGL canvas. The GL canvas stays in the main document — moving
//      a live WebGL element between documents is not something every browser survives — and
//      the mirror costs one drawImage per frame. The pop-out window also lends its
//      requestAnimationFrame to the render loop, because a hidden tab's own clock stops.
//   2. Video Picture-in-Picture (Chromium, Safari): the canvas is captured into a muted
//      <video> and that is popped out. Portable, but a hidden tab still starves the loop,
//      so the picture only moves while the tab is visible or the timer fallback fires.
export function createPip(canvas, { onChange = () => {} } = {}) {
  let win = null;          // document PiP window
  let mirror = null;       // { canvas, ctx } inside win
  let video = null;        // video PiP element
  let stream = null;
  let active = false;

  const set = (on) => { if (active === on) return; active = on; onChange(on); };

  function closeDocument() {
    if (!win) return;
    const w = win; win = null; mirror = null;
    try { w.close(); } catch { /* already gone */ }
    set(false);
  }

  async function openDocument() {
    const api = globalThis.documentPictureInPicture;
    if (!api?.requestWindow) return false;
    const aspect = (canvas.clientWidth || 16) / (canvas.clientHeight || 9);
    win = await api.requestWindow({ width: 520, height: Math.round(520 / aspect) });
    const doc = win.document;
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    const c = doc.createElement('canvas');
    c.style.cssText = 'display:block;width:100%;height:100%';
    doc.body.append(c);
    mirror = { canvas: c, ctx: c.getContext('2d') };
    win.addEventListener('pagehide', () => { win = null; mirror = null; set(false); });
    set(true);
    return true;
  }

  function closeVideo() {
    if (!video) return;
    const v = video; video = null;
    try { if (document.pictureInPictureElement === v) document.exitPictureInPicture(); } catch { /* ignore */ }
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    v.remove();
    set(false);
  }

  async function openVideo() {
    if (!document.pictureInPictureEnabled || !canvas.captureStream) return false;
    stream = canvas.captureStream(30);
    video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    video.srcObject = stream;
    document.body.append(video);
    await video.play();
    await video.requestPictureInPicture();
    video.addEventListener('leavepictureinpicture', closeVideo, { once: true });
    set(true);
    return true;
  }

  return {
    get active() { return active; },
    /** Open or close the pop-out. Resolves to the new state. */
    async toggle() {
      if (active) { closeDocument(); closeVideo(); return false; }
      try { if (await openDocument()) return true; } catch { win = null; mirror = null; }
      try { return await openVideo(); } catch { closeVideo(); return false; }
    },
    /** Copy the rendered frame into the pop-out window (document PiP only). */
    mirror() {
      if (!mirror) return;
      const { canvas: c, ctx } = mirror;
      const w = c.clientWidth || 1; const h = c.clientHeight || 1;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      ctx.drawImage(canvas, 0, 0, w, h);
    },
    /**
     * Schedule the next frame on whichever clock is running: the pop-out window's while a
     * document PiP is open, a coarse timer while a video PiP survives a hidden tab, else
     * the page's own requestAnimationFrame.
     */
    raf(fn) {
      // The pop-out's clock, but this document's time: a rAF timestamp counts from ITS window's
      // time origin (zero when the pop-out opened), so handed on as-is it ran the loop's dt
      // hugely negative and every effect backwards — the island went magenta.
      if (win) { win.requestAnimationFrame(() => fn(performance.now())); return; }
      if (video && document.hidden) { setTimeout(() => fn(performance.now()), 200); return; }
      requestAnimationFrame(fn);
    },
    dispose() { closeDocument(); closeVideo(); },
  };
}
