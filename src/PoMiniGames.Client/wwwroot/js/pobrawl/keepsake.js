// keepsake.js — something to take away from a fight: a poster made from its final frame.
//
// Two halves in one file:
//
//   THE STORE. The last fight's poster lives in memory, on `globalThis`, so they
//   outlive the engine that made them: the end card stays one button (Back to main menu), and
//   Brawl HQ's "Last fight" tab is where it is shown, downloaded and shared. Nothing is
//   uploaded and nothing is written to storage; a reload forgets them. Brawl HQ imports this
//   file on its own (it has no three.js import, so that costs nothing) and calls `describe`,
//   `download` and `share`.
//
//   THE SHOW MODULE (mixin, `this` is the live game; see show.js). In 1P, 2P and the Cup:
//     • while the fight is on, the finished frame is copied off the canvas four times a second
//       (in the same task as the render, so the drawing buffer is still readable) into one
//       reused canvas. The knockout, or the bell, keeps the copy it finds there: the last
//       exchange, both fighters in the fight's own framing. Not the knockout frame itself:
//       the KO camera cuts on that very frame, and half the time to a close-up of one head;
//     • at the result that frame becomes a poster: who beat whom, how, and when.
//   The poster costs one drawImage every quarter of a second while a fight is live.
//
// Presentation only: nothing here reads or writes the sim.

const POSTER_W = 1600;
const POSTER_H = 900;
// How often the fight's frame is copied while it is live (wall-clock ms), and how old a copy
// may be and still stand for the finish.
const ROLL_EVERY_MS = 250;
const ROLL_FRESH_MS = 1500;

/** The one store, shared by every copy of this module (the engine's and Brawl HQ's). */
function store() {
  const g = globalThis;
  g.__poBrawlKeepsake ||= { poster: null, caption: '', when: 0 };
  return g.__poBrawlKeepsake;
}

function put(slot, blob, name) {
  const s = store();
  const old = s[slot];
  if (old?.url) { try { URL.revokeObjectURL(old.url); } catch { /* already gone */ } }
  s[slot] = blob ? { blob, name, url: URL.createObjectURL(blob), mime: blob.type || '' } : null;
}

/** A file-name-safe slug of a caption. */
const slug = (text) => String(text || 'fight').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'fight';

// ── Brawl HQ ─────────────────────────────────────────────────────────────────

function canShareFile(item) {
  if (!item?.blob || typeof navigator === 'undefined' || !navigator.canShare || typeof File === 'undefined') return false;
  try {
    return navigator.canShare({ files: [new File([item.blob], item.name, { type: item.mime })] });
  } catch { return false; }
}

/**
 * What there is to show, as plain strings (the trimmed WASM client needs no interop DTO):
 * [posterUrl, caption, posterShareable '1'|''].
 * Empty strings where there is nothing.
 */
export function describe() {
  const s = store();
  return [
    s.poster?.url || '', s.caption || '', canShareFile(s.poster) ? '1' : '',
  ];
}

/** Save the poster as a file. False when there is none. */
export function download() {
  const item = store().poster;
  if (!item?.url || typeof document === 'undefined') return false;
  const link = document.createElement('a');
  link.href = item.url;
  link.download = item.name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

/**
 * Hand the poster to the device's share sheet.
 * @returns {Promise<string>} 'shared' | 'cancelled' | 'unsupported' | 'failed'
 */
export async function share() {
  const s = store();
  const item = s.poster;
  if (!canShareFile(item)) return 'unsupported';
  try {
    await navigator.share({
      files: [new File([item.blob], item.name, { type: item.mime })],
      title: 'PoBrawl',
      text: s.caption || 'PoBrawl',
    });
    return 'shared';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

// ── The poster ───────────────────────────────────────────────────────────────

const POSTER_FONT = '"Bungee", "Bungee Inline", Impact, "Arial Black", sans-serif';
const BODY_FONT = '"Inter", system-ui, "Segoe UI", sans-serif';

/** Shrink `px` until `text` fits `maxW`; returns the size used (the font is left set). */
function fitText(g, text, family, px, maxW, weight = '') {
  let size = px;
  for (; size > 18; size -= 4) {
    g.font = `${weight} ${size}px ${family}`.trim();
    if (g.measureText(text).width <= maxW) break;
  }
  return size;
}

/**
 * Draw the poster over a copy of the fight's frame.
 * @param frame   a POSTER_W x POSTER_H canvas holding the frame
 * @param meta    { headline, detail, footer }
 * @returns {Promise<Blob|null>} a JPEG, or null where the canvas cannot be encoded
 */
export async function composePoster(frame, meta) {
  const c = document.createElement('canvas');
  c.width = POSTER_W;
  c.height = POSTER_H;
  const g = c.getContext('2d');
  if (!g) return null;
  // The self-hosted display face may not have been used yet on this page: ask for it, and
  // carry on with the fallbacks if it does not arrive.
  try { await Promise.race([document.fonts?.load?.('96px "Bungee"'), new Promise((r) => setTimeout(r, 600))]); } catch { /* fallbacks */ }

  g.drawImage(frame, 0, 0, POSTER_W, POSTER_H);
  // A dark band rising from the foot of the frame, so the lettering reads over any arena.
  const band = g.createLinearGradient(0, POSTER_H * 0.42, 0, POSTER_H);
  band.addColorStop(0, 'rgba(6, 8, 18, 0)');
  band.addColorStop(0.55, 'rgba(6, 8, 18, 0.78)');
  band.addColorStop(1, 'rgba(6, 8, 18, 0.94)');
  g.fillStyle = band;
  g.fillRect(0, 0, POSTER_W, POSTER_H);
  const top = g.createLinearGradient(0, 0, 0, 150);
  top.addColorStop(0, 'rgba(6, 8, 18, 0.7)');
  top.addColorStop(1, 'rgba(6, 8, 18, 0)');
  g.fillStyle = top;
  g.fillRect(0, 0, POSTER_W, 150);

  const pad = 72;
  const maxW = POSTER_W - pad * 2;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';

  // Masthead.
  g.fillStyle = '#ffd166';
  g.font = `44px ${POSTER_FONT}`;
  g.fillText('POBRAWL', pad, 86);
  if (meta.footer) {
    g.textAlign = 'right';
    g.fillStyle = 'rgba(232, 234, 246, 0.9)';
    g.font = `600 28px ${BODY_FONT}`;
    g.fillText(meta.footer, POSTER_W - pad, 82);
    g.textAlign = 'left';
  }

  // Headline: who beat whom.
  const size = fitText(g, meta.headline, POSTER_FONT, 128, maxW);
  g.lineJoin = 'round';
  g.lineWidth = Math.max(6, size * 0.09);
  g.strokeStyle = 'rgba(6, 8, 18, 0.9)';
  g.strokeText(meta.headline, pad, POSTER_H - 150);
  g.fillStyle = '#ffffff';
  g.fillText(meta.headline, pad, POSTER_H - 150);

  // How, and where it happened.
  if (meta.detail) {
    fitText(g, meta.detail, BODY_FONT, 44, maxW, '700');
    g.fillStyle = '#ffd166';
    g.fillText(meta.detail, pad, POSTER_H - 82);
  }

  return new Promise((resolve) => {
    try { c.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9); } catch { resolve(null); }
  });
}

const mmss = (secs) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ── The show module ──────────────────────────────────────────────────────────

class KeepsakeMethods {
  _initKeepsake() {
    const mode = this.options?.mode;
    if (this.training || !(mode === '1p' || mode === '2p' || mode === 'tournament')) return;
    // cinematics.js tells the page a poster is on its way (the recap's `poster`).
    this._ksActive = true;
    this._ksFrame = null;
    this._ksGrabAt = 0;
    this._ksResult = null;
    // The rolling copy of the live fight: { canvas, at }.
    this._ksRoll = null;

    this._onShow((type, data) => {
      if (type === 'countdown') {
        // A new round: its own finish decides the frame.
        this._ksFrame = null;
        this._ksGrabAt = 0;
        this._ksResult = null;
      } else if (type === 'ko') {
        this._keepsakeHold();
        this._ksCaption = this._keepsakeMeta(data.winner, true).caption;
      } else if (type === 'result') {
        this._ksResult = this._keepsakeMeta(data.winner, data.ko);
        if (!this._ksFrame) this._keepsakeHold();   // a decision: the last exchange before the bell
        if (this._ksFrame) this._keepsakeFinish();
        else this._ksGrabAt = performance.now();    // nothing rolling yet: the frame the result lands on
      }
    });
    this._onShowRender((now) => {
      // The rolling copy, while the fight is live.
      if (this.phase === 'fighting' && now - (this._ksRoll?.at ?? -1e9) >= ROLL_EVERY_MS) {
        const canvas = this._keepsakeGrab(this._ksRoll?.canvas);
        if (canvas) this._ksRoll = { canvas, at: now };
      }
      if (!this._ksGrabAt || now < this._ksGrabAt) return;
      this._ksGrabAt = 0;
      this._ksFrame = this._keepsakeGrab();
      if (this._ksResult && this._ksFrame) this._keepsakeFinish();
    });
    this._onShowDispose(() => {
      this._ksFrame = null;
      this._ksRoll = null;
    });
  }

  /** The finish: keep the rolling copy as this round's frame, if there is a fresh one. */
  _keepsakeHold() {
    const roll = this._ksRoll;
    if (!roll || performance.now() - roll.at > ROLL_FRESH_MS) return;
    this._ksFrame = roll.canvas;
    this._ksRoll = null;   // the next round rolls into a canvas of its own
  }

  /**
   * Copy the finished frame off the canvas (cover-fit to the poster's shape) into `into`, or
   * into a new canvas. Returns the canvas, or null when the frame could not be read.
   */
  _keepsakeGrab(into = null) {
    const src = this.renderer?.domElement;
    if (!src || !src.width || !src.height) return null;
    const c = into || document.createElement('canvas');
    if (!into) {
      c.width = POSTER_W;
      c.height = POSTER_H;
    }
    const g = c.getContext('2d');
    if (!g) return null;
    const scale = Math.max(POSTER_W / src.width, POSTER_H / src.height);
    const w = src.width * scale, h = src.height * scale;
    try {
      g.drawImage(src, (POSTER_W - w) / 2, (POSTER_H - h) / 2, w, h);
    } catch { return null; }
    return c;
  }

  /** Who beat whom, how and where, as the poster's lines and a one-line caption. */
  _keepsakeMeta(winner, ko) {
    const [a, b] = this.fighters.map((f) => f.rig.config.name.toUpperCase());
    const headline = winner === 1 ? `${a} def. ${b}` : winner === 2 ? `${b} def. ${a}` : `${a} vs ${b}`;
    const how = ko ? `KO ${mmss(this.clock || 0)}` : winner ? 'Decision' : 'Draw';
    const mode = this.options?.mode;
    const rung = Number(this.options?.difficulty);
    const where = mode === '1p' ? (Number.isFinite(rung) && rung > 0 ? `Ladder rung ${rung}` : 'The ladder')
      : mode === 'tournament' ? (this._roundLabel || 'The Brawl Cup')
      : 'Two players';
    const rounds = this.match && this.match.played > 0 ? `Rounds ${this.match.wins[0]}–${this.match.wins[1]}` : null;
    const day = new Date();
    const footer = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    return {
      headline,
      detail: [how, where, rounds].filter(Boolean).join('  ·  '),
      footer,
      caption: `${headline} (${how})`,
    };
  }

  /** The result is in and the frame is held: make the poster and put it in the store. */
  _keepsakeFinish() {
    const meta = this._ksResult;
    const frame = this._ksFrame;
    this._ksResult = null;
    if (!meta || !frame) return;
    this._ksCaption = meta.caption;
    const s = store();
    s.caption = meta.caption;
    s.when = Date.now();
    composePoster(frame, meta)
      .then((blob) => { if (blob) put('poster', blob, `pobrawl-${slug(meta.caption)}.jpg`); })
      .catch(() => { /* no poster this time */ });
  }
}

export const Keepsake = KeepsakeMethods.prototype;
