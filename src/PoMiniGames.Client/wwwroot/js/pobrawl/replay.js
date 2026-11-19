// replay.js — the instant replay between the KO fall and the result. Showtime module (see
// show.js); mixin, `this` is the live game.
//
// Recording: every render frame of the fight (and the KO fall) samples each fighter's rig into a
// preallocated ring — root position + quaternion, every joint's local position + quaternion, the
// hips' squash scale — at most REC_HZ times per sim second, keyed on the sim clock `this.t`.
// 'hit' events keep the last few impact points.
//
// Playback ('ko' → 'replay' → 'result'): game.js hands the end of the KO fall to _replayBegin
// instead of the result — but only on the occasional knockout (REPLAY_CHANCE), so the package
// stays a highlight rather than wallpaper in a Cup that plays fifteen bouts. The sim holds still (_tick returns while phase is 'replay', so no
// physics step, no animator, no ragdoll drive) and this module poses the rigs and the camera
// from the ring each frame: a presidential-seal wipe, a wide side angle at 1x, a hard cut to a
// tight angle on the killing blow at SLOW x with a freeze while the telestrator rings it, and a
// seal wipe back. Under the out-wipe the live state is put back exactly (rig transforms, the
// camera, the fighters' velocities) and _koResult reports the result, so OnMatchEnd, the modal,
// and the shatter all come after the replay. Any key / click / tap / pad button skips.
//
// Not online (lockstep), not training (no KO), not on a decision at the bell (no 'ko'), not
// under the tournament's fast-forward. Reduced motion: no seal spin, straight cuts, one angle.
// Presentation only: Math.random never this.rng, and every sim field touched is restored.

import * as THREE from 'three-eco/webgpu';
import { RING_HALF } from './arena.js';

const CAP = 300;               // ring frames: 5 s at REC_HZ
const REC_DT = 1 / 60;
const PRE = 2.0;               // wide pass: sim seconds before the KO …
const POST = 0.35;             // … and after it
const TIGHT_PRE = 0.42;        // tight pass around the impact
const TIGHT_POST = 0.32;
const SLOW = 0.3;
const HOLD = 0.85;             // freeze on the impact while the telestrator draws
const WIPE = 0.6;              // seal wipe, s (covered around the half)
const GRACE = 0.35;            // s of input ignored at the start (a mashed punch is not a skip)
// How often a knockout gets the replay treatment at all. The Cup plays fifteen bouts in a row,
// so a replay on every one of them turns a highlight into wallpaper.
const REPLAY_CHANCE = 0.25;
const HITS = 8;

// Fixed joint order; a fighter missing one (or one torn off later) just skips the slot.
const JOINTS = ['hips', 'torso', 'head', 'shoulderL', 'elbowL', 'fistL', 'shoulderR', 'elbowR',
  'fistR', 'hipL', 'kneeL', 'footL', 'hipR', 'kneeR', 'footR'];
const STRIDE = 7 + JOINTS.length * 7 + 3;

const _q = new Float32Array(4);
const _mid = new THREE.Vector3();
const _camT = new THREE.Vector3();
const _look = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _perp = new THREE.Vector3();

const calm = () => document.documentElement.getAttribute('data-motion') === 'reduce';

function sealSvg(id) {
  // Thirteen stars round a navy disc, gold rings, the network's mark in the middle.
  let stars = '';
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2 - Math.PI / 2;
    stars += `<use href="#${id}-s" transform="translate(${(Math.cos(a) * 74).toFixed(1)} ${(Math.sin(a) * 74).toFixed(1)}) scale(0.55)"/>`;
  }
  return `<svg viewBox="-100 -100 200 200" aria-hidden="true">
    <defs>
      <radialGradient id="${id}-g" cx="0" cy="-20" r="120" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#1d3f86"/><stop offset="1" stop-color="#0a1534"/>
      </radialGradient>
      <path id="${id}-s" d="M0-10 2.9-3.1 9.5-3.1 4.2 1.2 6.2 8 0 4 -6.2 8 -4.2 1.2 -9.5-3.1 -2.9-3.1Z" fill="#e8c35a"/>
      <path id="${id}-arc" d="M-58 0A58 58 0 1 1 58 0A58 58 0 1 1 -58 0"/>
    </defs>
    <circle r="98" fill="url(#${id}-g)" stroke="#d4a937" stroke-width="4"/>
    <circle r="88" fill="none" stroke="#e8c35a" stroke-width="1.4"/>
    <circle r="62" fill="none" stroke="#e8c35a" stroke-width="1"/>
    ${stars}
    <text font-size="11" font-weight="900" letter-spacing="2.4" fill="#f4e3b0" font-family="Impact, 'Arial Black', sans-serif">
      <textPath href="#${id}-arc" startOffset="0">INSTANT REPLAY ★ PRESIDENTIAL BRAWL NETWORK ★</textPath>
    </text>
    <use href="#${id}-s" transform="translate(0 -14) scale(2.6)"/>
    <text y="34" text-anchor="middle" font-size="22" font-weight="900" fill="#f4e3b0" font-family="Impact, 'Arial Black', sans-serif">PBN</text>
  </svg>`;
}

// A hand-drawn loop (a touch over one turn, slightly tilted) and an arrow into it, in px
// around the impact point. Built once.
function telestratorPaths() {
  let ring = '';
  const turns = 1.12, n = 48, a0 = -2.4;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + t * turns * Math.PI * 2;
    const r = 1 + 0.07 * Math.sin(t * 9.0) + 0.05 * t;
    const x = Math.cos(a) * 66 * r, y = Math.sin(a) * 46 * r;
    const c = Math.cos(-0.18), s = Math.sin(-0.18);
    ring += `${i ? 'L' : 'M'}${(x * c - y * s).toFixed(1)} ${(x * s + y * c).toFixed(1)}`;
  }
  const ex = 64, ey = -48, cx = 132, cy = -74;
  const arrow = `M178 -150Q${cx} ${cy} ${ex} ${ey}`;
  const dx = ex - cx, dy = ey - cy, d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d, L = 20, sp = 0.5;
  const h1x = ex - L * (ux * Math.cos(sp) - uy * Math.sin(sp));
  const h1y = ey - L * (ux * Math.sin(sp) + uy * Math.cos(sp));
  const h2x = ex - L * (ux * Math.cos(-sp) - uy * Math.sin(-sp));
  const h2y = ey - L * (ux * Math.sin(-sp) + uy * Math.cos(-sp));
  const head = `M${h1x.toFixed(1)} ${h1y.toFixed(1)}L${ex} ${ey}L${h2x.toFixed(1)} ${h2y.toFixed(1)}`;
  return { ring, arrow, head };
}

class ReplayMethods {
  _initReplay() {
    const hits = [];
    for (let i = 0; i < HITS; i++) hits.push({ t: -1, p: new THREE.Vector3(), ax: 0, az: 0, dx: 0, dz: 0, power: 0 });
    this._rp = {
      rec: false,            // recording this match
      ch: [],                // per fighter: { f, objs, buf, live, vel, kb }
      times: new Float64Array(CAP),
      head: 0, count: 0, lastT: -1,
      hits, hitHead: 0,
      tKo: -1, tImp: -1,
      imp: new THREE.Vector3(), impAx: 1, impAz: 0,
      fallback: new THREE.Vector3(),
      // playback
      active: false, stage: '', st: 0, total: 0, calm: false, covered: false,
      A0: 0, A1: 0, B0: 0, B1: 0, prevSim: 0, teleOn: false,
      camPos: new THREE.Vector3(), camQuat: new THREE.Quaternion(), camFov: 55,
      camMode: 'ko', camModeT: 0, rackOn: false,
      hidden: [], dom: null, wipeLeft: 0, teleX: -1e4, teleY: -1e4, pads: 0,
    };
    this._rpKey = (e) => { if (!e.repeat) this._replaySkip(); };
    this._rpPointer = () => this._replaySkip();
    this._onShow((type, d) => this._replayEvent(type, d));
    this._onShowUpdate((dt) => this._replayUpdate(dt));
    this._onShowDispose(() => {
      this._replayStop();
      this._rp.dom?.root.remove();
      this._rp.dom = null;
    });
  }

  _replayEvent(type, d) {
    const rp = this._rp;
    if (type === 'countdown') {
      this._replayBind();
    } else if (type === 'fight') {
      rp.rec = this.options?.mode !== 'online' && !this.training && rp.ch.length === 2;
      rp.head = 0; rp.count = 0; rp.lastT = -1;
    } else if (type === 'reset') {
      if (rp.active) this._replayStop(true);
      rp.rec = false; rp.count = 0; rp.tKo = -1;
      for (const h of rp.hits) h.t = -1;
    } else if (type === 'hit' && rp.rec && d.point) {
      const h = rp.hits[rp.hitHead];
      rp.hitHead = (rp.hitHead + 1) % HITS;
      h.t = this.t;
      h.p.copy(d.point);
      h.power = d.power || 0;
      const a = d.attacker?.rig?.root.position, b = d.defender?.rig?.root.position;
      h.ax = a ? a.x : 0; h.az = a ? a.z : 0;
      h.dx = b ? b.x : 1; h.dz = b ? b.z : 0;
    } else if (type === 'ko' && rp.rec) {
      rp.tKo = this.t;
      const loser = this.fighters?.find((f, i) => i + 1 !== d.winner) || null;
      const head = loser?.rig?.joints?.head;
      if (head) head.getWorldPosition(rp.fallback); else rp.fallback.set(0, 1.5, 0);
    }
  }

  // New fighters (every countdown): point the channels at their joints. Buffers are reused.
  _replayBind() {
    const rp = this._rp;
    rp.count = 0; rp.head = 0; rp.lastT = -1; rp.tKo = -1;
    if (!this.fighters || this.fighters.length !== 2) { rp.ch.length = 0; return; }
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const c = rp.ch[i] || (rp.ch[i] = {
        f: null, objs: new Array(JOINTS.length),
        buf: new Float32Array(CAP * STRIDE), live: new Float32Array(STRIDE),
        vel: new THREE.Vector3(), kb: new THREE.Vector3(),
      });
      c.f = f;
      for (let j = 0; j < JOINTS.length; j++) c.objs[j] = f.rig?.joints?.[JOINTS[j]] || null;
    }
  }

  // ── ring ──────────────────────────────────────────────────────────────
  _replayWrite(c, buf, o) {
    const r = c.f.rig.root;
    buf[o] = r.position.x; buf[o + 1] = r.position.y; buf[o + 2] = r.position.z;
    buf[o + 3] = r.quaternion.x; buf[o + 4] = r.quaternion.y; buf[o + 5] = r.quaternion.z; buf[o + 6] = r.quaternion.w;
    const joints = c.f.rig.joints;
    for (let j = 0; j < JOINTS.length; j++) {
      const obj = c.objs[j];
      if (!obj || joints[JOINTS[j]] !== obj) continue;   // torn off: not posed any more
      const k = o + 7 + j * 7;
      buf[k] = obj.position.x; buf[k + 1] = obj.position.y; buf[k + 2] = obj.position.z;
      buf[k + 3] = obj.quaternion.x; buf[k + 4] = obj.quaternion.y;
      buf[k + 5] = obj.quaternion.z; buf[k + 6] = obj.quaternion.w;
    }
    const hips = c.objs[0];
    const k = o + STRIDE - 3;
    if (hips) { buf[k] = hips.scale.x; buf[k + 1] = hips.scale.y; buf[k + 2] = hips.scale.z; }
  }

  // Pose a fighter from frame offsets oa/ob of `buf`, `a` of the way from one to the other.
  _replayPose(c, buf, oa, ob, a) {
    const r = c.f.rig.root;
    r.position.set(
      buf[oa] + (buf[ob] - buf[oa]) * a,
      buf[oa + 1] + (buf[ob + 1] - buf[oa + 1]) * a,
      buf[oa + 2] + (buf[ob + 2] - buf[oa + 2]) * a);
    THREE.Quaternion.slerpFlat(_q, 0, buf, oa + 3, buf, ob + 3, a);
    r.quaternion.fromArray(_q);
    const joints = c.f.rig.joints;
    for (let j = 0; j < JOINTS.length; j++) {
      const obj = c.objs[j];
      if (!obj || joints[JOINTS[j]] !== obj) continue;
      const ka = oa + 7 + j * 7, kb = ob + 7 + j * 7;
      obj.position.set(
        buf[ka] + (buf[kb] - buf[ka]) * a,
        buf[ka + 1] + (buf[kb + 1] - buf[ka + 1]) * a,
        buf[ka + 2] + (buf[kb + 2] - buf[ka + 2]) * a);
      THREE.Quaternion.slerpFlat(_q, 0, buf, ka + 3, buf, kb + 3, a);
      obj.quaternion.fromArray(_q);
    }
    const hips = c.objs[0];
    if (hips) {
      const ka = oa + STRIDE - 3, kb = ob + STRIDE - 3;
      hips.scale.set(
        buf[ka] + (buf[kb] - buf[ka]) * a,
        buf[ka + 1] + (buf[kb + 1] - buf[ka + 1]) * a,
        buf[ka + 2] + (buf[kb + 2] - buf[ka + 2]) * a);
    }
  }

  _replaySlot(i) { const rp = this._rp; return (rp.head - rp.count + i + CAP) % CAP; }

  _replayRecord() {
    const rp = this._rp;
    if (this.t < rp.lastT) { rp.count = 0; rp.head = 0; }
    else if (rp.lastT >= 0 && this.t - rp.lastT < REC_DT * 0.98) return;
    rp.lastT = this.t;
    const slot = rp.head;
    rp.times[slot] = this.t;
    for (const c of rp.ch) this._replayWrite(c, c.buf, slot * STRIDE);
    rp.head = (rp.head + 1) % CAP;
    if (rp.count < CAP) rp.count++;
  }

  // Pose every fighter at sim time `ts` (clamped into the ring).
  _replaySeek(ts) {
    const rp = this._rp;
    let lo = 0, hi = rp.count - 1;
    if (ts <= rp.times[this._replaySlot(0)]) hi = 0;
    else {
      while (lo < hi) {                       // last frame with time <= ts
        const m = (lo + hi + 1) >> 1;
        if (rp.times[this._replaySlot(m)] <= ts) lo = m; else hi = m - 1;
      }
    }
    const i = Math.max(0, hi);
    const sa = this._replaySlot(i);
    const sb = this._replaySlot(Math.min(rp.count - 1, i + 1));
    const ta = rp.times[sa], tb = rp.times[sb];
    const a = tb > ta ? THREE.MathUtils.clamp((ts - ta) / (tb - ta), 0, 1) : 0;
    for (const c of rp.ch) this._replayPose(c, c.buf, sa * STRIDE, sb * STRIDE, a);
  }

  // ── flow ──────────────────────────────────────────────────────────────
  /** End of the KO fall (game.js). True when the replay took over; it reports the result itself. */
  _replayBegin() {
    const rp = this._rp;
    if (!rp || !rp.rec || rp.tKo < 0 || rp.count < 30 || rp.ch.length !== 2) return false;
    // A highlight, not a routine: most knockouts go straight to the result, and the replay
    // package is saved for the occasional knockout worth watching twice.
    if (Math.random() > REPLAY_CHANCE) return false;
    if (this.options?.mode === 'online' || this.training || (this.speed || 1) > 1) return false;
    if (!this.fighters.some((f) => f.state === 'ko') || !this.container) return false;
    const tFirst = rp.times[this._replaySlot(0)];
    const tLast = rp.times[this._replaySlot(rp.count - 1)];
    rp.A0 = Math.max(tFirst, rp.tKo - PRE);
    rp.A1 = Math.min(tLast, rp.tKo + POST);
    if (rp.A1 - rp.A0 < 0.8) return false;

    // The killing blow: the last landed hit at (or just before) the KO.
    let best = null;
    for (const h of rp.hits) {
      if (h.t < 0 || h.t > rp.tKo + 0.05 || h.t < rp.tKo - 0.6) continue;
      if (!best || h.t > best.t) best = h;
    }
    if (best) {
      rp.tImp = best.t;
      rp.imp.copy(best.p);
      rp.impAx = best.dx - best.ax; rp.impAz = best.dz - best.az;
    } else {
      rp.tImp = rp.tKo;
      rp.imp.copy(rp.fallback);
      rp.impAx = 1; rp.impAz = 0;
    }
    rp.B0 = Math.max(tFirst, rp.tImp - TIGHT_PRE);
    rp.B1 = Math.min(tLast, rp.tImp + TIGHT_POST);

    // Snapshot the live state the result has to come back to.
    for (const c of rp.ch) {
      this._replayWrite(c, c.live, 0);
      c.vel.copy(c.f.vel || _mid.set(0, 0, 0));
      c.kb.copy(c.f.knockback || _mid.set(0, 0, 0));
      // Frozen sim, moving rigs: a stale velocity would have the props shove crates.
      c.f.vel?.set(0, 0, 0);
      c.f.knockback?.set(0, 0, 0);
    }
    rp.camPos.copy(this.camera.position);
    rp.camQuat.copy(this.camera.quaternion);
    rp.camFov = this.camera.fov;
    rp.camMode = this.cameraMode;
    rp.camModeT = this.cameraModeT;
    rp.rackOn = !!this.rackFocus?.pass.enabled;
    if (this.rackFocus) this.rackFocus.pass.enabled = false;
    // Torn-off limbs lie where they landed; they cannot be put back, so they sit it out.
    rp.hidden.length = 0;
    for (const l of this._severedLimbs || []) {
      for (const o of [l.shoulder, l.elbow]) if (o && o.visible) { o.visible = false; rp.hidden.push(o); }
    }

    this.phase = 'replay';
    this.phaseT = 0;
    rp.active = true;
    rp.calm = calm();
    rp.st = 0;
    rp.total = 0;
    rp.covered = false;
    rp.teleOn = false;
    rp.prevSim = -1;
    this._replayDom();
    const dom = rp.dom;
    dom.root.classList.toggle('pb-rp--calm', rp.calm);
    dom.root.hidden = false;
    this._setBanner('');
    window.addEventListener('keydown', this._rpKey, true);
    window.addEventListener('pointerdown', this._rpPointer, true);
    rp.pads = this._replayPadMask();
    this._show('replay', { on: true });
    if (rp.calm) this._replayStage('wide');
    else {
      this._replayStage('in');
      this.audio?.rewind?.(0.5);
    }
    return true;
  }

  _replayStage(stage) {
    const rp = this._rp;
    const dom = rp.dom;
    rp.stage = stage;
    rp.st = 0;
    rp.covered = false;
    if (stage === 'in' || stage === 'out') {
      dom.root.classList.remove('pb-rp--wipe');
      void dom.root.offsetWidth;           // restart the seal animation
      dom.root.classList.add('pb-rp--wipe');
      rp.wipeLeft = WIPE;
      if (stage === 'out') this.audio?.whoosh?.();
    } else if (stage === 'wide') {
      this._replayChrome(true);
      this._replaySeek(rp.A0);
      this._replayCamWide(0, true);
    } else if (stage === 'tight') {
      dom.root.classList.add('pb-rp--slow');
      this.audio?.whoosh?.();
      this._replaySeek(rp.B0);
      this._replayCamTight(0);
    }
  }

  _replayChrome(on) {
    const dom = this._rp.dom;
    dom.root.classList.toggle('pb-rp--on', on);
    if (!on) dom.root.classList.remove('pb-rp--slow', 'pb-rp--tele');
    this._rp.teleOn = false;
  }

  _replaySkip() {
    const rp = this._rp;
    if (!rp.active || rp.total < GRACE || rp.stage === 'out') return;
    if (rp.calm) { this._replayFinish(); return; }
    // Already under the seal on the way in: the out-wipe picks up from there.
    this._replayStage('out');
  }

  _replayPadMask() {
    let mask = 0;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : null;
      if (!pads) return 0;
      for (const p of pads) {
        if (!p) continue;
        for (let b = 0; b < p.buttons.length && b < 16; b++) if (p.buttons[b].pressed) mask |= 1 << b;
      }
    } catch { /* no pads */ }
    return mask;
  }

  _replayUpdate(dt) {
    const rp = this._rp;
    if (!rp) return;
    if (!rp.active) {
      if (rp.rec && (this.phase === 'fighting' || this.phase === 'ko')) this._replayRecord();
      return;
    }
    rp.st += dt;
    rp.total += dt;
    if (rp.wipeLeft > 0 && (rp.wipeLeft -= dt) <= 0) rp.dom.root.classList.remove('pb-rp--wipe');
    // A pad button pressed since the replay began skips it too.
    const mask = this._replayPadMask();
    if (mask & ~rp.pads) this._replaySkip();
    rp.pads = mask;
    if (!rp.active) return;

    switch (rp.stage) {
      case 'in':
        if (!rp.covered && rp.st >= WIPE * 0.5) {
          rp.covered = true;
          this._replayChrome(true);
          this._replaySeek(rp.A0);
          this._replayCamWide(0, true);
          rp.stage = 'wide';
          rp.st = 0;
        }
        break;
      case 'wide': {
        const ts = rp.A0 + rp.st;
        this._replayPlay(ts, dt);
        this._replayCamWide(dt, false);
        if (rp.calm && ts >= rp.tImp - 0.05 && !rp.teleOn) this._replayTele(true);
        if (ts >= rp.A1) {
          if (rp.calm) { this._replayFinish(); return; }
          this._replayStage('tight');
        }
        break;
      }
      case 'tight': {
        const pre = (rp.tImp - rp.B0) / SLOW;
        let ts;
        if (rp.st < pre) ts = rp.B0 + rp.st * SLOW;
        else if (rp.st < pre + HOLD) ts = rp.tImp;
        else ts = rp.tImp + (rp.st - pre - HOLD) * SLOW;
        if (!rp.teleOn && rp.st >= pre - 0.12) this._replayTele(true);
        this._replayCamTight(dt);
        this._replayPlay(ts, dt);
        if (ts >= rp.B1) this._replayStage('out');
        break;
      }
      case 'out':
        if (!rp.covered && rp.st >= WIPE * 0.5) {
          rp.covered = true;
          this._replayRestore();
          this._replayChrome(false);
        }
        if (rp.st >= WIPE) { this._replayFinish(); return; }
        break;
      default: break;
    }
    this._replayGrade();
    if (rp.teleOn) this._replayTeleTrack();
  }

  _replayPlay(ts, dt) {
    const rp = this._rp;
    this._replaySeek(ts);
    // The blow lands again: the thud and the ring of air, once per pass.
    if (rp.prevSim < rp.tImp && ts >= rp.tImp && dt > 0) {
      this.audio?.impact?.({ power: 1.6, worldPos: rp.imp, kind: 'punch' });
      if (!rp.calm) this._shockwave?.(rp.imp, 0.7);
    }
    rp.prevSim = ts;
  }

  // Broadcast hard-cam: off the apron on the audience side, wide enough for the whole exchange.
  _replayCamWide(dt, snap) {
    const [a, b] = this._rp.ch;
    const pa = a.f.rig.root.position, pb = b.f.rig.root.position;
    _mid.copy(pa).add(pb).multiplyScalar(0.5);
    const sep = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    const dist = THREE.MathUtils.clamp(4.6 + sep * 0.45, 4.8, 7.2);
    _camT.set(THREE.MathUtils.clamp(_mid.x * 0.75, -RING_HALF, RING_HALF), 1.85, _mid.z + dist);
    _look.set(_mid.x, 0.95, _mid.z);
    const cam = this.camera;
    if (snap) {
      cam.position.copy(_camT);
      this._rpLook = (this._rpLook || new THREE.Vector3()).copy(_look);
    } else {
      const k = 1 - Math.exp(-dt * 3.5);
      cam.position.lerp(_camT, k);
      this._rpLook.lerp(_look, k);
    }
    cam.lookAt(this._rpLook);
    cam.fov = (this.fovBase || 55) - 4;
    cam.updateProjectionMatrix();
  }

  // Tight on the impact, over the striker's shoulder, pushing in through the slow-mo.
  _replayCamTight(dt) {
    const rp = this._rp;
    _axis.set(rp.impAx, 0, rp.impAz);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    _perp.set(_axis.z, 0, -_axis.x);
    if (_perp.z < 0) _perp.negate();
    // Near profile, 15° round toward the striker, so the fist and the face both read.
    const c = Math.cos(0.26), s = Math.sin(0.26);
    _perp.multiplyScalar(c).addScaledVector(_axis, -s).normalize();
    const total = (rp.tImp - rp.B0) / SLOW + HOLD + (rp.B1 - rp.tImp) / SLOW;
    const k = THREE.MathUtils.clamp(rp.st / Math.max(0.1, total), 0, 1);
    const dist = 2.75 - 0.55 * k * (2 - k);
    const cam = this.camera;
    cam.position.copy(rp.imp).addScaledVector(_perp, dist);
    cam.position.y = rp.imp.y + 0.3;
    cam.position.x = THREE.MathUtils.clamp(cam.position.x, -(RING_HALF + 1), RING_HALF + 1);
    cam.position.z = THREE.MathUtils.clamp(cam.position.z, -(RING_HALF + 1), RING_HALF + 1.5);
    cam.lookAt(rp.imp.x, rp.imp.y - 0.05, rp.imp.z);
    cam.fov = 38;
    cam.updateProjectionMatrix();
    void dt;
  }

  _replayTele(on) {
    const rp = this._rp;
    rp.teleOn = on;
    rp.dom.root.classList.toggle('pb-rp--tele', on);
    rp.teleX = rp.teleY = -1e4;
    if (on) this._replayTeleTrack();
  }

  // Keep the telestrator ring on the impact point (screen space).
  _replayTeleTrack() {
    const rp = this._rp;
    const host = this.container;
    const w = host.clientWidth, h = host.clientHeight;
    this.camera.updateMatrixWorld();
    _proj.copy(rp.imp).project(this.camera);
    const x = (_proj.x + 1) * 0.5 * w, y = (1 - _proj.y) * 0.5 * h;
    if (Math.abs(x - rp.teleX) < 0.5 && Math.abs(y - rp.teleY) < 0.5) return;
    rp.teleX = x; rp.teleY = y;
    // The ring scales with the shot: bigger on the tight angle.
    const sc = rp.stage === 'tight' ? 1.25 : 0.8;
    rp.dom.tele.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${sc})`);
  }

  // Replay grade: drained colour and a little fringe; the scanlines are DOM (.pb-rp__grade).
  _replayGrade() {
    const rp = this._rp;
    const u = this.fxPass?.uniforms;
    if (!u) return;
    const on = rp.stage === 'wide' || rp.stage === 'tight' || (rp.stage === 'out' && !rp.covered);
    if (!on) return;
    u.uDesat.value = Math.max(u.uDesat.value, 0.34);
    u.uCA.value += rp.calm ? 0.1 : 0.28;
    u.uVignette.value += 0.12;
  }

  _replayRestore() {
    const rp = this._rp;
    for (const c of rp.ch) {
      this._replayPose(c, c.live, 0, 0, 0);
      c.f.vel?.copy(c.vel);
      c.f.knockback?.copy(c.kb);
    }
    this.camera.position.copy(rp.camPos);
    this.camera.quaternion.copy(rp.camQuat);
    this.camera.fov = rp.camFov;
    this.camera.updateProjectionMatrix();
    this.cameraMode = rp.camMode;
    this.cameraModeT = rp.camModeT;
    for (const o of rp.hidden) o.visible = true;
    rp.hidden.length = 0;
  }

  _replayFinish() {
    const rp = this._rp;
    if (!rp.active) return;
    if (!rp.covered || rp.stage !== 'out') this._replayRestore();
    this._replayStop();
    // The result proper: OnMatchEnd, the modal, the shatter.
    if (this.phase === 'replay') this._koResult();
  }

  /** Tear down the playback; `restore` puts the live state back first (reset mid-replay). */
  _replayStop(restore = false) {
    const rp = this._rp;
    if (!rp) return;
    if (rp.active && restore) this._replayRestore();
    const was = rp.active;
    rp.active = false;
    rp.stage = '';
    rp.teleOn = false;
    window.removeEventListener('keydown', this._rpKey, true);
    window.removeEventListener('pointerdown', this._rpPointer, true);
    if (rp.dom) {
      rp.dom.root.hidden = true;
      rp.dom.root.classList.remove('pb-rp--on', 'pb-rp--wipe', 'pb-rp--slow', 'pb-rp--tele');
    }
    if (was) this._show('replay', { on: false });
  }

  // Built once per engine, on the first replay; hidden between them.
  _replayDom() {
    const rp = this._rp;
    if (rp.dom) return;
    const id = `pbrp${Math.floor(Math.random() * 1e9).toString(36)}`;
    const p = telestratorPaths();
    const root = document.createElement('div');
    root.className = 'pb-rp';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="pb-rp__grade"></div>
      <svg class="pb-rp__tele-svg"><g class="pb-rp__tele">
        <path class="pb-rp__ink pb-rp__ring" pathLength="1" d="${p.ring}"/>
        <path class="pb-rp__ink pb-rp__arrow" pathLength="1" d="${p.arrow}"/>
        <path class="pb-rp__ink pb-rp__head" pathLength="1" d="${p.head}"/>
        <path class="pb-rp__pen pb-rp__ring" pathLength="1" d="${p.ring}"/>
        <path class="pb-rp__pen pb-rp__arrow" pathLength="1" d="${p.arrow}"/>
        <path class="pb-rp__pen pb-rp__head" pathLength="1" d="${p.head}"/>
      </g></svg>
      <div class="pb-rp__bug">
        <span class="pb-rp__bug-seal">${sealSvg(id + 'b')}</span>
        <span class="pb-rp__bug-text"><b>INSTANT REPLAY</b><small class="pb-rp__speed">SLOW MOTION ×${SLOW}</small></span>
      </div>
      <div class="pb-rp__skip">Press any key to skip</div>
      <div class="pb-rp__wipe"><div class="pb-rp__seal">${sealSvg(id)}</div></div>`;
    this.container.appendChild(root);
    rp.dom = { root, tele: root.querySelector('.pb-rp__tele') };
  }
}

export const Replay = ReplayMethods.prototype;
