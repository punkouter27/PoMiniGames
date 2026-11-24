// showcase.js — Game mixin: the presentation layer that sits on top of the race without touching
// its rules. Mixed into Game.prototype by game.js.
//
//   #2  the iris wipe on GO (out of your marble) and at the line (onto the winner)  → hud.js
//   #3  the pre-race flyover: the whole dealt course from high up, its set-pieces tagged, then a
//       dive to the grid                                                              → scene.js
//   #4  the start gantry's lamps follow the countdown                                  → gantry.js
//   #7  the standings tower, #8 the arrows for rivals closing from behind              → hud.js
//   #9  the leader cam when you are not leading                                        → lens.js
//   #10 your place every half second, handed to the page for the result chart
//   #16 an eliminated marble shatters
//   #18 a rival passing close by is heard as a Doppler whoosh                          → audio.js
//   #20 rumble on the pad / vibration on a phone for the hits you feel                 → gamepad.js
import * as THREE from 'three-eco/webgpu';
import { createGantry } from './gantry.js';
import { marbleColor } from './marbles.js';
import { rumble } from './gamepad.js';
import { GUEST_COLOR, FINAL_STRETCH } from './tuning.js';

const FLY_HOLD = 0.85;      // s on the high shot of the whole course
const FLY_DIVE = 1.75;      // s diving from it to the grid
const TOWER_EVERY = 0.2;    // s between tower refreshes
const HISTORY_EVERY = 0.5;  // s of race clock between place samples
const THREAT_RANGE = 18;    // course units behind you that count as closing
const THREAT_CLOSING = 4;   // u/s faster than you, at least, to be shown
const PASS_NEAR = 9;        // a rival within this many units counts as passing you
const PASS_GAP = 0.3;       // s between two pass whooshes

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pipDir = new THREE.Vector3();
const _pipPos = new THREE.Vector3();

const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ShowcaseMixin {
  // ── lifecycle ──
  _showcaseTrack() {
    if (this._gantry) { this._gantry.dispose(); this._gantry = null; }
    try {
      this._gantry = createGantry(this.track);
      if (this._gantry) { this.scene.add(this._gantry.group); this._gantry.set(1); }
    } catch (err) {
      console.warn('[PoMarbleRace] start gantry unavailable:', err?.message || err);
      this._gantry = null;
    }
    this._flyT = 0;
    this._flyDone = this.demo || reducedMotion();
    this._flySpans = null;
    this._history = [];
    this._historyActs = [];
    this._historyNext = 0;
    this._historyAct = -1;
    this._towerT = 0;
    this._passT = 0;
    this.hud?.hideTower();
    this.hud?.clearTags();
    this.hud?.threats([]);
    this.scene.setClearAir?.(0);
  }

  _showcaseDispose() {
    if (this._gantry) { this._gantry.dispose(); this._gantry = null; }
    this.hud?.dispose();
  }

  /** The marble this browser's human steers (yours; the white one on an online guest). */
  _myMarble() {
    if (!this.marbleSet || this.demo) return null;
    const i = this.isGuest ? this.guestIndex : this.chosen;
    return i >= 0 ? this.marbleSet.marbles[i] : null;
  }

  _nameOf(m) {
    const mine = this.isGuest ? this.guestIndex : this.chosen;
    if (!this.demo && m.index === mine) return 'You';
    if (this.online && (m.index === this.guestIndex || m.index === 0)) return 'Rival';
    return `Marble ${m.index + 1}`;
  }

  _colorOf(m) {
    return this.online && m.index === this.guestIndex ? GUEST_COLOR : marbleColor(m.index);
  }

  // ── #3 flyover ──
  // The pick phase's first seconds: a high shot of the whole course with every dealt set-piece
  // tagged where it sits, held, then a dive down to the start overview, where followTarget takes
  // over. Returns true while it owns the camera.
  _flyoverFrame(dt) {
    if (this._flyDone || !this.track || this._paused) return false;
    const t = this.track;
    if (!this._flySpans) this._flySetup();
    this._flyT += dt;
    const T = this._flyT;
    const f = this._fly;
    const k = T < FLY_HOLD ? 0 : easeInOut(Math.min(1, (T - FLY_HOLD) / FLY_DIVE));
    // the high shot drifts a little sideways while it holds, so it is alive, not a still
    const drift = (1 - k) * Math.min(1, T / (FLY_HOLD + FLY_DIVE)) * 0.18;
    _camPos.copy(f.hiPos).addScaledVector(f.side, drift * f.span);
    _camPos.lerp(f.loPos, k);
    _look.copy(f.hiLook).lerp(f.loLook, smooth(k));
    this.scene.setClearAir?.(1 - smooth(Math.min(1, k * 1.25)));
    this.scene.setCameraPose(_camPos, _look, k > 0.6 ? f.loLook : _look);

    // tags: in on the hold, staggered; out early in the dive
    const tags = this._flyTags;
    for (let i = 0; i < tags.length; i++) {
      const g = tags[i];
      const sp = this.scene.screenOf(g.pos);
      g.x = sp && sp.x > 0.03 && sp.x < 0.97 && sp.y > 0.06 && sp.y < 0.94 ? sp.x : null;
      g.y = sp ? sp.y : 0;
      g.on = T > 0.12 + i * 0.07 && k < 0.3;
      // far down the course the tags bunch up in perspective: one that would overlap a tag
      // already shown gives way (the finish, last in the list, always wins its spot)
      if (g.x != null && i < tags.length - 1) {
        for (let j = 0; j < tags.length; j++) {
          const o = tags[j];
          if (o === g || o.x == null || (j > i && j !== tags.length - 1)) continue;
          if (Math.abs(o.y - g.y) < 0.04 && Math.abs(o.x - g.x) < 0.14) { g.x = null; break; }
        }
      }
    }
    this.hud.tags(tags);

    if (T >= FLY_HOLD + FLY_DIVE) {
      this._flyDone = true;
      this.hud.clearTags();
      this.scene.setClearAir?.(0);
      return false;
    }
    return true;
  }

  _flySetup() {
    const t = this.track;
    // the course's extent, sampled along its centerline
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let s = 0; s <= t.length; s += 40) {
      t.centerAt(s, _a);
      min.min(_a); max.max(_a);
    }
    const mid = min.clone().add(max).multiplyScalar(0.5);
    const span = Math.max(120, Math.hypot(max.x - min.x, max.z - min.z));
    const d0 = t.dirAt(0, new THREE.Vector3());
    d0.y = 0; if (d0.lengthSq() < 1e-6) d0.set(0, 0, 1); d0.normalize();
    const side = new THREE.Vector3(-d0.z, 0, d0.x);
    // high and behind the start, looking at the middle of the course: the whole descent in frame
    const hiPos = mid.clone().addScaledVector(d0, -span * 0.42).add(new THREE.Vector3(0, span * 0.5 + (max.y - min.y) * 0.45, 0));
    const hiLook = mid.clone().addScaledVector(d0, span * 0.05);
    // the start overview, as followTarget will frame it (behind and above the start, looking down-track)
    const ov = t.overviewTarget;
    const loPos = ov.clone().addScaledVector(d0, -28).add(new THREE.Vector3(0, 23, 0));
    const loLook = ov.clone().addScaledVector(d0, 12).add(new THREE.Vector3(0, 3, 0));
    this._fly = { hiPos, hiLook, loPos, loLook, side, span };
    // one tag per dealt set-piece at its middle, plus the finish
    const tags = [];
    const acts = t.acts || [];
    const colorAt = (f) => { let c = '#38bdf8'; for (const a of acts) if (f >= a.from) c = a.color || c; return c; };
    for (const sp of t.spans || []) {
      const fm = (sp.a + sp.b) / 2;
      tags.push({ pos: t.centerAt(fm * t.length, new THREE.Vector3()).add(new THREE.Vector3(0, 6, 0)), text: sp.name, color: colorAt(fm), x: null, y: 0, on: false });
    }
    tags.push({ pos: t.centerAt(t.finishS ?? t.length * 0.98, new THREE.Vector3()).add(new THREE.Vector3(0, 6, 0)), text: 'Finish', color: '#ef4444', x: null, y: 0, on: false });
    this._flyTags = tags;
    this._flySpans = true;
  }

  // ── #4 gantry ──
  /** The page's countdown pip. Each non-final beat lights one more lamp. */
  _gantryBeat(final) {
    const g = this._gantry;
    if (!g) return;
    if (final) this._gantryGo();
    else g.set(g.lit + 1);
  }

  _gantryGo() {
    const g = this._gantry;
    if (!g) return;
    g.set(3, true);
    this.scene.pulseLight(g.lampWorld, 0x4ade80, 2.2);
  }

  /** GO: the gantry goes green, the iris opens out of your marble, a short rumble. */
  _showcaseGo() {
    this._gantryGo();
    this._flyDone = true;
    this.hud.clearTags();
    this.scene.setClearAir?.(0);
    const me = this._myMarble();
    if (me) {
      const sp = this.scene.screenOf(me.mesh.position);
      this.hud.iris('open', sp ? sp.x : 0.5, sp ? sp.y : 0.6, 'rgba(239, 68, 68, 0.95)');
      this._rumble(0.35, 0.35, 120);
    }
  }

  // ── per frame, every phase ──
  _showcaseFrame(dt) {
    this._gantry?.update(dt);
    const racing = this.phase === 'racing';
    let leader = null;
    let final = 0;
    if (racing && this.marbleSet) {
      const order = this._order || [];
      const lead = order[0];
      const me = this._myMarble();
      final = Math.max(0, Math.min(1, (this.marbleSet.progress() - (FINAL_STRETCH - 0.16)) / 0.16));
      // #9 the leader cam: only when you are still racing and someone else leads
      if (lead && me && !me.finished && !me.eliminated && lead !== me && !lead.finished) {
        this.track.dirAt(lead.s, _pipDir);
        _pipPos.copy(lead.mesh.position);
        leader = { pos: _pipPos, dir: _pipDir };
        this._pipName = this._nameOf(lead);
      }
    }
    this.scene.lensFrame?.(dt, { racing, final, leader });
    this.hud.pipLabel(this.scene.pipRect, this.scene.pipAlpha || 0, `LEADER · ${this._pipName || ''}`);
  }

  // ── per racing frame (host and guest), after the standings are settled ──
  _showcaseRace(order, dt) {
    this._order = order;
    const me = this._myMarble();
    this._recordPlace(me);
    this._towerT -= dt;
    if (this._towerT <= 0) { this._towerT = TOWER_EVERY; this._feedTower(order, me); }
    this._feedThreats(me);
    this._detectPasses(me, dt);
  }

  _feedTower(order, me) {
    if (!order.length) return;
    const lead = order[0];
    const leadSpeed = Math.max(18, lead.speed || 0);
    const row = (m, place) => ({
      index: m.index, place, name: this._nameOf(m), color: this._colorOf(m), me: m === me,
      finished: m.finished && m !== lead,
      gap: m.finished && lead.finished ? Math.max(0, (m.finishTime || 0) - (lead.finishTime || 0)) : Math.max(0, (lead.s - m.s) / leadSpeed),
    });
    const list = [];
    for (let i = 0; i < Math.min(5, order.length); i++) list.push(row(order[i], i + 1));
    if (me && !me.eliminated) {
      const at = order.indexOf(me);
      if (at >= 5) list.push(row(me, at + 1));
    }
    this.hud.tower(list);
  }

  _feedThreats(me) {
    if (!me || me.finished || me.eliminated || this.demo) { this.hud.threats([]); return; }
    const cam = this.scene.camera;
    _camPos.copy(cam.position);
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    const list = this._threatList || (this._threatList = []);
    list.length = 0;
    for (const m of this.marbleSet.marbles) {
      if (m === me || m.finished || m.eliminated) continue;
      const gap = me.s - m.s;
      if (gap <= 0.5 || gap > THREAT_RANGE) continue;
      // only a marble genuinely running you down: a pack trailing at your pace is not news
      if ((m.speed || 0) - (me.speed || 0) < THREAT_CLOSING) continue;
      const sp = this.scene.screenOf(m.mesh.position);
      if (sp && sp.x > 0 && sp.x < 1 && sp.y > 0 && sp.y < 0.97) continue;   // already in shot
      _a.copy(m.mesh.position).sub(_camPos);
      const lat = _a.dot(_right) / Math.max(1, _a.length());
      list.push({ x: 0.5 + Math.max(-1, Math.min(1, lat * 1.8)) * 0.42, close: 1 - gap / THREAT_RANGE });
    }
    list.sort((p, q) => q.close - p.close);
    this.hud.threats(list.slice(0, 2));
  }

  // ── #18 Doppler pass ──
  _detectPasses(me, dt) {
    this._passT -= dt;
    if (!me || me.finished || me.eliminated || this.demo) return;
    let best = null, bestRel = 0;
    for (const m of this.marbleSet.marbles) {
      if (m === me || m.finished || m.eliminated) { m._passSign = 0; continue; }
      const ds = m.s - me.s;
      if (Math.abs(ds) > PASS_NEAR * 1.5) { m._passSign = 0; continue; }
      const sign = ds >= 0 ? 1 : -1;
      const near = m.mesh.position.distanceTo(me.mesh.position) < PASS_NEAR;
      if (m._passSign && sign !== m._passSign && near) {
        const rel = Math.abs((m.speed || 0) - (me.speed || 0));
        if (rel > bestRel) { bestRel = rel; best = m; }
      }
      m._passSign = sign;
    }
    if (best && bestRel > 3 && this._passT <= 0) {
      this._passT = PASS_GAP;
      this.audio.playPass?.(this.scene.audioCue(best.mesh.position), bestRel, best.s > me.s);
    }
  }

  // ── #10 place history ──
  _recordPlace(me) {
    if (!me || this.demo) return;
    if (this._actAnnounced !== this._historyAct) {
      this._historyAct = this._actAnnounced;
      if (this._actAnnounced > 0) this._historyActs.push(this._history.length);
    }
    if (this.raceClock < this._historyNext) return;
    this._historyNext = this.raceClock + HISTORY_EVERY;
    const p = me.eliminated ? -1 : (me.place > 0 ? me.place : -1);
    if (p > 0) this._history.push(p);
  }

  /** Hand the page this race's place history (call before the result reaches it). */
  _sendHistory(finalPlace) {
    if (this.demo || !this._history) return;
    const h = this._history.slice();
    if (finalPlace > 0) h.push(finalPlace);
    this._invoke('OnPlaceHistory', h, this._historyActs.slice());
    this.hud.hideTower();
    this.hud.threats([]);
  }

  // ── #2 the line ──
  /** The winner just crossed: the iris closes onto them (when they are in shot) and opens again. */
  _irisOnWinner(w) {
    if (this.demo || !w) return;
    const sp = this.scene.screenOf(w.mesh.position);
    if (!sp || sp.x < 0.05 || sp.x > 0.95 || sp.y < 0.05 || sp.y > 0.95) return;
    this.hud.iris('blink', sp.x, sp.y, 'rgba(250, 204, 21, 0.95)');
  }

  // ── #16 shatter ──
  /** A marble leaves the race: it bursts into glass in its own colour, with a crack. */
  _shatter(m) {
    if (!m || !m.mesh) return;
    const pos = m.mesh.position;
    const d = pos.distanceTo(this.scene.camera.position);
    if (d > 240) return;
    this.scene.burstFx?.('shatter', pos, this._colorOf(m));
    if (d < 140) this.audio.playShatter?.(this.scene.audioCue(pos));
  }

  // ── #20 rumble ──
  _rumble(strong, weak, ms) {
    if (this.demo) return;
    rumble(strong, weak, ms);
  }
}
