// diegeticBoard.js — cinematic in-world overlays with a flat HUD that never goes away
// (deck idea #7).
//
// Standings, sector gaps and event cards read best when they live IN the world — a big
// screen over the start straight, an arena board — lit and framed by the same camera as
// everything else. They are also the most important text in the game, which a moving camera,
// a dark screen or a screen reader cannot read off a texture. So the rule is absolute:
//
//   every line drawn on the board is ALSO in the flat HUD fallback.
//
// The board is a CanvasTexture on a plane (toneMapped off, so it glows like a screen). The
// fallback is a small DOM panel placed over the canvas: an `aria-live="polite"` region for
// event cards, and an ordered list for standings that is visually hidden while the board is
// on screen and shown when it is not (off-camera, low tier, reduced motion, no WebGL).
//
// formatStandings() and boardOnScreen() are pure, for tests.

/**
 * Lines for a standings list. rows: [{ name, pos?, gap?, you? }], already in race order.
 * @returns {string[]}
 */
export function formatStandings(rows, max = 6) {
    const out = [];
    const list = Array.isArray(rows) ? rows : [];
    for (let i = 0; i < Math.min(max, list.length); i++) {
        const r = list[i] || {};
        const pos = Number.isFinite(r.pos) ? r.pos : i + 1;
        const name = String(r.name ?? `Car ${i + 1}`).slice(0, 14);
        const gap = r.gap == null || i === 0 ? '' : typeof r.gap === 'number' ? ` +${r.gap.toFixed(1)}` : ` ${r.gap}`;
        out.push(`P${pos} ${name}${r.you ? ' ◀' : ''}${gap}`);
    }
    return out;
}

/**
 * Whether a board centred at `p` facing `n` is readable from a camera at `cam` looking `dir`:
 * in front of the camera, within `maxDist`, and not seen edge-on/from behind.
 */
export function boardOnScreen(p, n, cam, dir, maxDist = 160) {
    const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > maxDist || d < 0.5) return false;
    const inFront = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (inFront < 0.55) return false;                   // outside a ~110° cone
    const facing = -(dx * n.x + dy * n.y + dz * n.z) / d;
    return facing > 0.2;                                // the face points back at the camera
}

function lowOrCalm() {
    try {
        if (document.documentElement.dataset.motion === 'reduce') return true;
        return window.PoQuality?.tier?.() === 'low';
    } catch { return false; }
}

const HUD_CSS = 'position:absolute;right:12px;top:72px;max-width:min(46vw,240px);z-index:3;pointer-events:none;'
    + 'font:600 13px/1.35 system-ui,sans-serif;color:#fff;background:rgba(10,14,24,.72);border-radius:8px;padding:6px 10px;';
const HIDDEN_CSS = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;';

export class DiegeticBoard {
    /**
     * @param {{ THREE: any, width?: number, height?: number, worldWidth?: number, title?: string,
     *           hudHost?: HTMLElement|null, label?: string, hudStandings?: boolean }} opts
     *        hudStandings — also SHOW the standings list in the flat HUD when the board is not
     *        readable. Off for games whose own HUD already shows positions: the list then stays
     *        in the accessibility tree only, and just the event cards surface visibly.
     */
    constructor({ THREE, width = 512, height = 256, worldWidth = 12, title = '', hudHost = null, label = 'Standings', hudStandings = false }) {
        this.THREE = THREE;
        this.hudStandings = !!hudStandings;
        this.title = title;
        this.lines = [];
        this.card = null;      // { text, until }
        this.dirty = true;
        this.visible = false;
        this._pos = { x: 0, y: 0, z: 0 };
        this._normal = { x: 0, y: 0, z: 1 };
        this._dir = new THREE.Vector3();
        this._lastHudText = '';

        this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
        if (this.canvas) { this.canvas.width = width; this.canvas.height = height; }
        this.ctx = this.canvas?.getContext?.('2d') || null;
        this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
        if (this.texture) {
            this.texture.colorSpace = THREE.SRGBColorSpace ?? this.texture.colorSpace;
            this.texture.anisotropy = 4;
        }
        const geo = new THREE.PlaneGeometry(worldWidth, worldWidth * height / width);
        const mat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, side: THREE.FrontSide });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.name = 'po-diegetic-board';
        // A dark bezel behind the screen so its back is not a hole in the world.
        const back = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth * 1.04, worldWidth * height / width * 1.08),
            new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide }));
        back.position.z = -0.05;
        this.mesh.add(back);
        this._back = back;

        // ── flat HUD fallback ─────────────────────────────────────────
        this.hud = null;
        if (hudHost && typeof document !== 'undefined') {
            const hud = document.createElement('section');
            hud.className = 'po-diegetic-hud';
            hud.setAttribute('aria-label', label);
            hud.style.cssText = HIDDEN_CSS;
            const live = document.createElement('p');
            live.setAttribute('aria-live', 'polite');
            live.setAttribute('role', 'status');
            live.style.margin = '0 0 4px';
            const list = document.createElement('ol');
            list.style.cssText = this.hudStandings ? 'margin:0;padding:0;list-style:none;' : HIDDEN_CSS;
            hud.append(live, list);
            if (getComputedStyle(hudHost).position === 'static') hudHost.style.position = 'relative';
            hudHost.appendChild(hud);
            this.hud = { root: hud, live, list, shown: null };
        }
    }

    /** Place the board: position and the direction its face points (world space). */
    place(x, y, z, faceX, faceZ) {
        this.mesh.position.set(x, y, z);
        this.mesh.lookAt(x + faceX, y, z + faceZ);
        const l = Math.hypot(faceX, faceZ) || 1;
        this._pos.x = x; this._pos.y = y; this._pos.z = z;
        this._normal.x = faceX / l; this._normal.y = 0; this._normal.z = faceZ / l;
    }

    /** Standings rows (see formatStandings). Only redraws when the text changes. */
    setStandings(rows) {
        const lines = formatStandings(rows);
        if (lines.length === this.lines.length && lines.every((l, i) => l === this.lines[i])) return;
        this.lines = lines;
        this.dirty = true;
        this._syncList();
    }

    /** A headline card for `ms` (e.g. "CONTACT!", "PHOTO FINISH"). Announced politely. */
    showEvent(text, ms = 2200) {
        const t = String(text || '').slice(0, 40);
        if (!t) return;
        this.card = { text: t, until: (typeof performance !== 'undefined' ? performance.now() : Date.now()) + ms };
        this.dirty = true;
        if (this.hud) this.hud.live.textContent = t;
    }

    _syncList() {
        if (!this.hud) return;
        const text = this.lines.join('|');
        if (text === this._lastHudText) return;
        this._lastHudText = text;
        const list = this.hud.list;
        list.textContent = '';
        for (const line of this.lines) {
            const li = document.createElement('li');
            li.textContent = line;
            list.appendChild(li);
        }
    }

    _draw(now) {
        const g = this.ctx;
        if (!g) return;
        const w = this.canvas.width, h = this.canvas.height;
        g.fillStyle = '#0b0f1a';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(120,180,255,.55)';
        g.lineWidth = 6;
        g.strokeRect(3, 3, w - 6, h - 6);
        const card = this.card && now < this.card.until ? this.card : null;
        if (card) {
            g.fillStyle = '#ffcf3f';
            g.font = `800 ${Math.round(h * 0.26)}px system-ui, sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(card.text, w / 2, h / 2, w - 30);
        } else {
            g.textAlign = 'left';
            g.textBaseline = 'top';
            if (this.title) {
                g.fillStyle = '#7fc4ff';
                g.font = `700 ${Math.round(h * 0.11)}px system-ui, sans-serif`;
                g.fillText(this.title, 18, 14, w - 36);
            }
            const top = this.title ? h * 0.2 : 16;
            const rowH = (h - top - 10) / Math.max(4, this.lines.length);
            g.font = `600 ${Math.round(rowH * 0.72)}px system-ui, sans-serif`;
            this.lines.forEach((line, i) => {
                g.fillStyle = line.includes('◀') ? '#ffe27a' : '#ffffff';
                g.fillText(line, 18, top + i * rowH, w - 36);
            });
        }
        if (this.texture) this.texture.needsUpdate = true;
        this._cardShown = !!card;
    }

    /** Per frame: redraw if dirty, and show the flat HUD whenever the board is not readable. */
    update(camera, now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
        if (this.card && now >= this.card.until && this._cardShown) { this.card = null; this.dirty = true; }
        if (this.dirty) { this.dirty = false; this._draw(now); }
        let onScreen = false;
        if (camera && this.mesh.parent) {
            camera.getWorldDirection(this._dir);
            onScreen = boardOnScreen(this._pos, this._normal, camera.position, this._dir);
        }
        this.visible = onScreen;
        if (this.hud) {
            const unreadable = !onScreen || lowOrCalm();
            const cardUp = !!(this.card && now < this.card.until);
            const show = unreadable && (this.hudStandings ? this.lines.length > 0 || cardUp : cardUp);
            if (show !== this.hud.shown) {
                this.hud.shown = show;
                this.hud.root.style.cssText = show ? HUD_CSS : HIDDEN_CSS;
            }
        }
    }

    dispose() {
        this.mesh.parent?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this._back.geometry.dispose();
        this._back.material.dispose();
        this.texture?.dispose();
        this.hud?.root.remove();
    }
}

if (typeof window !== 'undefined') {
    window.PoDiegeticBoard = { formatStandings, boardOnScreen, DiegeticBoard };
}
