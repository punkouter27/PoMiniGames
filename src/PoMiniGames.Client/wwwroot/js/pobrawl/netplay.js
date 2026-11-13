// netplay.js — the online 1v1 in the arena: the PRESENTER of a rollback fight.
//
// The fight itself is rollbackSim.js — a 60 Hz integer sim, bit-identical to the server's
// PoBrawlRollbackSim — run by a RollbackSession (rollbackSession.js) that applies the local
// keys at once (two frames ahead), predicts the remote corner, and re-simulates whenever the
// server's confirmed inputs or snapshots disagree. The server (PoBrawlMatchService) referees:
// it decides which frame every input landed on and is the only source of the result.
//
// This file shows `session.state` every render frame:
//
//   • Both fighters are driven by a NetController that walks its fighter to the sim's X. A
//     rollback that moves a fighter is smoothed by the same steering (no teleport).
//   • A swing is thrown when the SIM fires it, carrying the sim's verdict (hit / blocked / whiff,
//     damage). Each (corner, frame) is thrown once, so a re-simulation never re-throws it; a
//     rollback that changes what an airborne swing did corrects its verdict, and one that erased
//     the swing turns it into a whiff. The verdict lands when the limb actually connects (the
//     ordinary hit pipeline, with the sim's damage in place of the engine's roll), or at the end
//     of the active window if the two rigs never quite touch.
//   • HP and energy on the HUD are the sim's. A predicted KO waits for the server's word: until
//     the server says "ko" nobody drops below 1 HP, so a misprediction never plays a KO it must
//     take back. The KO, the ragdoll, the result flow — all the presentation — is the same code
//     the local modes run, and the fight ends only when the server's snapshot says so.
//   • Personalities, supers and prop chip damage are off: each would move HP the sim never moved.
//
// Rollback-aware presentation (never touches the sim or the protocol):
//   • A correction that moves a fighter more than SMEAR_MIN_MM is not slid out over a quarter
//     second: the fighter closes the gap in ~3 frames under a directional chromatic smear (the
//     post pass's uNetSmear), so a re-simulated position reads as a dash, not a pop.
//   • A swing the server has not confirmed yet (its frame is past session.confirmedFrame, the
//     newest snapshot) carries a faint cyan ghost trail; it burns off once confirmed.
//   • The page's signal meter: RTT and rollbacks per second, pushed at 2 Hz (OnNetSignal).
//
// Keys (local corner only): A/D walk (held), R or S guard (held), F punch, G kick, H special.
// The touch pad and gamepads dispatch the same codes, so they need nothing of their own.

import * as THREE from 'three';
import { ATTACKS } from './constants.js';
import { testAttackHit, regionForHurtBone } from './hitboxes.js';
import { regionEffect } from './combat.js';
import { RollbackSession, HISTORY } from './rollbackSession.js';
import {
  HZ, ENERGY_MAX, HELD_IDLE, HELD_FORWARD, HELD_BACK, HELD_BLOCK,
  FLOOR_NONE, FLOOR_DOWN, ARM_LEFT,
  PRESS_PUNCH, PRESS_KICK, PRESS_SPECIAL, PRESS_NONE,
} from './rollbackSim.js';

// The engine's countdown ends ("FIGHT!") at phaseT 3.7 — see game.js _tick.
const COUNTDOWN_END = 3.7;
// A swing a rollback reveals more than this many frames late is not thrown (the HUD still shows what it did).
const SWING_STALE_FRAMES = 30;

// A correction that moves a corner further than this (sim mm) gets the smear and the quick catch-up.
const SMEAR_MIN_MM = 120;
// Rendered frames the smear lasts (it fades over them), and the catch-up's steering per tick.
const SMEAR_FRAMES = 3;
const WARP_K = 0.55;
// The signal meter's push interval (≤ 2 Hz) and its rollback-rate smoothing.
const SIGNAL_MS = 500;
// The ghost ribbon: the striking limb's last positions in translucent cyan. Normal blending, not the
// swing trail's additive: added light washes out on the lit mat, a tint reads on any background.
const GHOST_POINTS = 10;
const GHOST_COLOR = new THREE.Color(0x22d3ee);
const GHOST_OPACITY = 0.5;
const _gp = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

const HELD = ['idle', 'forward', 'back', 'block']; // PoBrawlMatchAction 0..3
const SWING = { [PRESS_PUNCH]: 'punch', [PRESS_KICK]: 'kick', [PRESS_SPECIAL]: 'special' };
const OUTCOME = { 1: 'hit', 2: 'blocked', 3: 'whiff' };

/** Drives one fighter toward the sim's view of it. */
export class NetController {
  isHuman = false;

  constructor(isLocal) {
    this.isLocal = isLocal;
    this.fighter = null;   // bound after spawn
    this.simX = null;      // metres, from the sim every render frame
    this.held = 'idle';    // the sim's held state for this corner
    this.localBlock = false; // local corner only: the guard key is down right now
  }

  /** Where this fighter should stand now, or null before the sim has a state. */
  targetX() { return this.simX; }

  update(ctx) {
    const f = this.fighter;
    const intent = { move: 0, side: 0, punch: false, kick: false, punchHeld: false, kickHeld: false, block: false, super: false };
    if (!f) return intent;
    const tx = this.targetX();
    if (tx !== null) {
      const err = tx - f.rig.root.position.x;
      // `move` is opponent-relative (+1 = toward them). The deadband stops a fighter standing on
      // its mark from shuffling.
      if (Math.abs(err) > 0.04) intent.move = Math.sign(err) * ((ctx && ctx.towardX) || 1);
    }
    // The local guard shows the instant the key goes down; the sim's guard follows two frames later.
    intent.block = this.isLocal ? (this.localBlock || this.held === 'block') : this.held === 'block';
    return intent;
  }

  dispose() {}
}

/**
 * The local corner's keys → the sim's input: the HELD state (corner-relative: idle, forward,
 * back, block — sent on every change, down AND up) and attack PRESSES (once per key-down).
 * `onInput(held, press)` hands each to the rollback session.
 */
class NetInput {
  constructor(controller, inwardDir, onInput) {
    this.controller = controller;
    this.inwardDir = inwardDir; // the screen direction (+1 = right) that walks this corner in
    this.onInput = onInput;
    this.down = new Set();
    this.lastWalk = null;
    this.held = HELD_IDLE;
    this._onDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const code = e.code;
      if (code === 'KeyA' || code === 'KeyD' || code === 'KeyR' || code === 'KeyS') {
        e.preventDefault?.();
        if (e.repeat) return;
        this.down.add(code);
        if (code === 'KeyA' || code === 'KeyD') this.lastWalk = code;
        this._sync();
      } else if (code === 'KeyF' || code === 'KeyG' || code === 'KeyH') {
        e.preventDefault?.();
        if (e.repeat) return;
        this.onInput(this.held, code === 'KeyF' ? PRESS_PUNCH : code === 'KeyG' ? PRESS_KICK : PRESS_SPECIAL);
      }
    };
    this._onUp = (e) => {
      if (this.down.delete(e.code)) this._sync();
    };
    // A window that loses focus never sees the key-ups: release everything, or the fighter
    // marches into the ropes.
    this._onBlur = () => {
      if (!this.down.size) return;
      this.down.clear();
      this._sync();
    };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
  }

  _sync() {
    const block = this.down.has('KeyR') || this.down.has('KeyS');
    const l = this.down.has('KeyA'), r = this.down.has('KeyD');
    const dir = l && r ? (this.lastWalk === 'KeyA' ? -1 : 1) : l ? -1 : r ? 1 : 0;
    this.controller.localBlock = block;
    const held = block ? HELD_BLOCK : dir === 0 ? HELD_IDLE : dir === this.inwardDir ? HELD_FORWARD : HELD_BACK;
    if (held === this.held) return;
    this.held = held;
    this.onInput(held, PRESS_NONE);
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

// A stand-in contact for a verdict whose limb never touched: the defender's chest.
function chestHit(defender) {
  const point = new THREE.Vector3();
  (defender.rig.joints.torso || defender.rig.root).getWorldPosition(point);
  point.y += 0.15;
  return { point, capsule: 'torso' };
}

class NetplayMethods {
  /** Online setup, from start(): the rollback session, who is local, the input bridge, the present loop. */
  _initNet() {
    const o = this.options;
    const localSide = o.localSide || 0;
    const session = new RollbackSession({
      localSide,
      send: (frame, held, press, seq) => {
        this.dotnet?.invokeMethodAsync('OnNetInput', frame, held, press, seq).catch(() => {});
      },
      onCorrection: (c) => this._netCorrection(c),
    });
    this.online = {
      localSide, session, final: null, finalAt: 0, thrown: new Map(), raf: 0,
      smear: null,                     // { side, frames, amp, dir } — the live rollback smear
      warpUntil: [0, 0],               // per corner: wall-clock ms the quick catch-up runs until
      ghosts: [null, null],            // per corner: the predicted-swing ghost ribbon
      signal: { at: 0, count: 0, rate: 0 },
    };
    const local = localSide ? this.fighters[localSide - 1] : null;
    for (const f of this.fighters) {
      f.controller.fighter = f;
      // +1 = the screen direction that walks this corner toward the other (P1 stands left).
      f.controller.inwardDir = f.index === 1 ? 1 : -1;
    }
    if (local && this.dotnet) {
      this.netInput = new NetInput(local.controller, local.controller.inwardDir, (held, press) => session.localInput(held, press, performance.now()));
    }
    // Its own loop, so the sim keeps time through the splash and the countdown too (the engine's
    // fighting tick only runs once the bell has gone).
    const loop = () => {
      if (this.disposed || !this.online) return;
      this._netFrame();
      this.online.raf = requestAnimationFrame(loop);
    };
    this.online.raf = requestAnimationFrame(loop);
  }

  /** One server snapshot (PoBrawlMatchState, camelCase): a desync check and sync point, plus the server's verdict on the end. */
  applyNet(s) {
    if (!this.online || !s) return;
    if (s.sim && s.sim.length) this.online.session.onSnapshot(s.sim, s.frame, s.checksum, performance.now());
    if (s.finished && !this.online.final) {
      this.online.final = { winner: s.winner === 0 ? 1 : s.winner === 1 ? 2 : 0, event: s.lastEvent || '' };
      this.online.finalAt = performance.now() / 1000;
    }
  }

  /** One confirmed input (PoBrawlMatchInputEvent, camelCase). */
  applyNetInput(ev) {
    if (!this.online || !ev) return;
    this.online.session.onInput(ev.side, ev.frame, ev.held, ev.press, ev.sequence);
  }

  /** One clock-sync sample. */
  applyNetClock(clockFrame, rttMs) {
    if (!this.online) return;
    this.online.session.onClock(clockFrame, rttMs, performance.now());
  }

  /**
   * The session re-simulated to the present (a rollback or a hard correction). A corner it moved
   * further than SMEAR_MIN_MM catches up in a few frames under a chromatic smear instead of
   * sliding there; the larger move wins when several land together.
   */
  _netCorrection({ dx }) {
    const o = this.online;
    if (!o || this.phase !== 'fighting') return;
    for (let side = 0; side < 2; side++) {
      const d = dx[side] || 0;
      if (Math.abs(d) <= SMEAR_MIN_MM) continue;
      o.warpUntil[side] = performance.now() + 70;
      if (this._calm()) continue;   // reduced motion: the catch-up, without the smear
      const amp = Math.min(1, Math.abs(d) / 500);
      if (!o.smear || amp >= o.smear.amp * (o.smear.frames / SMEAR_FRAMES)) {
        o.smear = { side, frames: SMEAR_FRAMES, amp, dir: Math.sign(d) };
      }
    }
  }

  /** Per render frame: the smear's uniforms — centred on its fighter, along the move, fading. */
  _netSmearFrame() {
    const u = this.fxPass?.uniforms;
    if (!u || !u.uNetSmear) return;
    const sm = this.online.smear;
    const f = sm && this.fighters[sm.side];
    if (!sm || !f || !this.camera) { u.uNetSmear.value = 0; return; }
    const torso = f.rig.joints.torso || f.rig.root;
    torso.getWorldPosition(_sa);
    _sb.copy(_sa).setX(_sa.x + sm.dir * 0.5);
    const hy = _sa.y;
    _sa.project(this.camera);
    _sb.project(this.camera);
    let dxu = _sb.x - _sa.x, dyu = _sb.y - _sa.y;
    const len = Math.hypot(dxu, dyu) || 1;
    dxu /= len; dyu /= len;
    // Blob radius: about the body's projected height (torso to a metre above it).
    _sb.set(f.rig.root.position.x, hy + 0.9, f.rig.root.position.z).project(this.camera);
    const r = Math.max(0.08, Math.min(0.4, Math.abs(_sb.y - _sa.y) * 0.5 * 1.2));
    u.uNetSmear.value = sm.amp * (sm.frames / SMEAR_FRAMES);
    u.uNetSmearC.value[0] = (_sa.x + 1) * 0.5;
    u.uNetSmearC.value[1] = (_sa.y + 1) * 0.5;
    u.uNetSmearR.value = r;
    u.uNetSmearDir.value[0] = dxu;
    u.uNetSmearDir.value[1] = dyu;
    if (--sm.frames <= 0) this.online.smear = null;
  }

  /**
   * Per render frame: a corner whose last swing is still a prediction (its frame is past the
   * server's newest snapshot) trails a faint ghost ribbon off the striking limb; once the server
   * has confirmed it, the ribbon burns off.
   */
  _netGhostFrame(side) {
    const o = this.online;
    const f = this.fighters[side];
    const swinging = f && f.attack && (f.state === 'punch' || f.state === 'kick');
    const predicted = swinging && (f.netSwingFrame ?? -1) > o.session.confirmedFrame;
    let g = o.ghosts[side];
    if (!g) {
      if (!predicted) return;
      g = o.ghosts[side] = this._makeTrail();
      g.color.copy(GHOST_COLOR);
      g.mesh.material.blending = THREE.NormalBlending;
      g.mesh.material.opacity = GHOST_OPACITY;
      g.mesh.material.needsUpdate = true;
    }
    const joint = predicted ? f.rig.joints[f.state === 'kick' ? 'footR' : 'fistR'] : null;
    if (joint) {
      joint.getWorldPosition(_gp);
      g.points.push({ x: _gp.x, y: _gp.y, z: _gp.z });
      if (g.points.length > GHOST_POINTS) g.points.shift();
    } else if (g.points.length) {
      g.points.shift();
      if (g.points.length) g.points.shift();
    }
    const n = g.points.length;
    if (n < 2) { g.mesh.visible = false; g.mesh.geometry.setDrawRange(0, 0); return; }
    const pos = g.mesh.geometry.attributes.position.array;
    const col = g.mesh.geometry.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const p = g.points[i];
      const a = i / (n - 1);
      const w = 0.03 + 0.08 * a;
      const k = i * 6;
      pos[k] = p.x; pos[k + 1] = p.y - w; pos[k + 2] = p.z;
      pos[k + 3] = p.x; pos[k + 4] = p.y + w; pos[k + 5] = p.z;
      const br = 0.45 + 0.55 * a;       // the head brightest, the tail never black
      col[k] = col[k + 3] = g.color.r * br;
      col[k + 1] = col[k + 4] = g.color.g * br;
      col[k + 2] = col[k + 5] = g.color.b * br;
    }
    g.mesh.geometry.attributes.position.needsUpdate = true;
    g.mesh.geometry.attributes.color.needsUpdate = true;
    g.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    g.mesh.visible = true;
  }

  /** At ≤ 2 Hz: the signal meter's numbers to the page (RTT ms, rollbacks/s, deepest rollback). */
  _netSignal(now) {
    const o = this.online;
    const sg = o.signal;
    if (now - sg.at < SIGNAL_MS) return;
    const st = o.session.stats;
    const count = st.rollbacks + st.corrections;
    if (sg.at) {
      const inst = (count - sg.count) / ((now - sg.at) / 1000);
      sg.rate = sg.rate * 0.5 + inst * 0.5;
    }
    sg.at = now;
    sg.count = count;
    if (!this.dotnet || o.session.clockSource === 'none') return;
    this.dotnet.invokeMethodAsync('OnNetSignal', Math.round(o.session.rtt), Math.round(sg.rate * 10) / 10, st.maxDepth | 0)
      .catch(() => {});
  }

  /** Every render frame: advance the rollback sim to the clock, then present its state. */
  _netFrame() {
    const o = this.online;
    const now = performance.now();
    o.session.update(now);
    this._netSignal(now);
    const s = o.session.state;
    if (!s || !this.fighters) return;
    this._netSmearFrame();
    if (this.phase === 'fighting') { this._netGhostFrame(0); this._netGhostFrame(1); }

    // ── Clock and phase: the sim's pre-roll drives the engine's countdown ──
    const elapsed = (s.frame - s.fightStart) / HZ;
    if (elapsed < 0 && !o.final) {
      if (this.phase === 'intro') {
        clearTimeout(this._splashTimer);
        this._hideSplash();
        this._startCountdown();
      }
      if (this.phase === 'countdown') {
        const want = COUNTDOWN_END + elapsed;
        if (Math.abs(this.phaseT - want) > 0.25) this.phaseT = want;
      }
    } else if (this.phase === 'intro' || this.phase === 'countdown') {
      // Joined after the bell (a reconnect, a spectator): straight into the fight.
      clearTimeout(this._splashTimer);
      this._hideSplash();
      this._snapCameraToFraming();
      this.phase = 'fighting';
      this._show('fight');
      this.phaseT = 0;
      this.combat.startGame();
      this._setBanner('');
    }
    if (this.phase === 'fighting') this.clock = Math.max(0, elapsed);

    const corners = [[this.fighters[0], s.p1, 0], [this.fighters[1], s.p2, 1]];
    for (const [f, c] of corners) {
      f.controller.simX = c.x / 1000;
      f.controller.held = HELD[c.held] || 'idle';
      f.energy = Math.max(0, Math.min(1, c.energy / ENERGY_MAX));
      f.gassed = false;
    }
    if (this.phase !== 'fighting') return;

    // ── Swings: each (corner, frame) the sim fired, thrown once ──
    // Scan the recent history, not just the present state: on a slow render several swings can
    // fire between two frames on screen, and a rollback can reveal one a few frames back.
    const history = o.session.history;
    for (let fr = Math.max(s.frame - SWING_STALE_FRAMES, s.fightStart + 1); fr <= s.frame; fr++) {
      const st = history[fr % HISTORY];
      if (!st || st.frame !== fr) continue;
      for (const [f, , side] of corners) {
        const c = side === 0 ? st.p1 : st.p2;
        if (c.swingFrame !== fr || !SWING[c.swing]) continue;
        const key = `${side}:${fr}`;
        const outcome = OUTCOME[c.outcome] || 'whiff';
        if (o.thrown.has(key)) {
          // Already thrown: a rollback may have changed what it did — correct the verdict still in the air.
          if (f.netVerdict && f.netVerdict.key === key) { f.netVerdict.outcome = outcome; f.netVerdict.damage = c.damage; }
          continue;
        }
        o.thrown.set(key, fr);
        this._netSwing(f, SWING[c.swing], {
          key, frame: fr, outcome, damage: c.damage, special: c.swing === PRESS_SPECIAL,
          // The hand the sim threw (rollbackSim.js: jab left, cross right).
          arm: c.swing === PRESS_PUNCH && c.arm === ARM_LEFT ? 'L' : 'R',
        });
      }
    }
    for (const [f, c] of corners) {
      // A verdict whose swing a rollback erased (the sim's latest swing is now older) never happened.
      if (f.netVerdict && f.netVerdict.frame > c.swingFrame) { f.netVerdict.outcome = 'whiff'; f.netVerdict.damage = 0; }
    }
    if (o.thrown.size > 64) {
      for (const [key, frame] of o.thrown) if (frame < s.frame - 2 * HISTORY) o.thrown.delete(key);
    }

    // ── HP: the sim's, plus whatever it already took that this screen has not shown landing ──
    // Never below 1 here: the KO only ever comes through the hit pipeline (a landed verdict, or
    // _tickNet's finishing blow once the server has said "ko"), so a predicted KO cannot play early.
    for (const [f, c] of corners) {
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      const pending = opp.netVerdict && opp.netVerdict.outcome !== 'whiff' ? opp.netVerdict.damage : 0;
      const player = this.combat.getPlayer(f.playerId);
      if (player && player.alive && f.state !== 'ko') {
        const want = Math.max(1, Math.min(player.maxHealth, c.hp + pending));
        if (Math.abs(player.health - want) > 0.01) { player.health = want; this.hudDirty = true; }
      }
    }

    // ── The canvas: the sim says who is down, rising or standing ──
    // Idempotent, so a rollback that changes its mind is simply followed. The knockdown waits
    // for the blow that caused it to land on screen (the attacker's verdict still in the air).
    for (const [f, c] of corners) {
      if (f.state === 'ko') continue;
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      if (c.floor === FLOOR_DOWN) {
        if (f.state === 'down') continue;
        if (f.state === 'getup') { f.state = 'down'; f.stateT = 0; f.animator.setDown(true); continue; }
        if (opp.netVerdict && opp.netVerdict.outcome !== 'whiff') continue;
        const dx = f.rig.root.position.x - opp.rig.root.position.x;
        this._knockDown(f, opp, new THREE.Vector3(dx >= 0 ? 1 : -1, 0, 0));
        f.knockback.set(0, 0, 0);   // the sim's X already carries the slide
      } else if (c.floor !== FLOOR_NONE) {
        if (f.state === 'down') { f.state = 'getup'; f.stateT = 0; f.animator.setDown(false); }
      } else if (f.state === 'down' || f.state === 'getup') {
        f.state = 'idle';
        f.stateT = 0;
        f.animator.setDown(false);
      }
    }
  }

  /** Throw the swing the sim fired. Any verdict still in the air lands first. */
  _netSwing(f, name, verdict) {
    const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
    if (f.netVerdict) this._presentNetVerdict(f, opp, f.attack || ATTACKS.punch, f.netVerdict, chestHit(opp));
    if (f.state === 'ko') return;
    const attackName = name === 'special' ? 'kick' : name;
    f.blockStunT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(null, 0);
    // On screen the fighter may still be finishing a rise the sim already ended.
    if (f.state === 'down' || f.state === 'getup') f.animator.setDown(false);
    f.netArm = verdict.arm;   // _enterAttack swings this hand
    // A special is the kick at full charge: the gold trail, the big lunge, the heavy whoosh.
    this._enterAttack(f, attackName, verdict.special ? 1 : 0);
    if (verdict.special) {
      const p = f.rig.root.position;
      this._spawnCallout(new THREE.Vector3(p.x, 2.1, p.z), 'SPECIAL!');
    }
    f.netVerdict = verdict;
    f.netSwingFrame = verdict.frame;   // predicted until the server's snapshot reaches it (ghost trail)
    // No limb to swing (a torn-off punching arm): land it now rather than never.
    if (f.state !== attackName) this._presentNetVerdict(f, opp, ATTACKS[attackName], verdict, chestHit(opp));
  }

  /** The hit pipeline's online door (from _tryHit): the limb touched — land the sim's verdict. */
  _tryHitNet(attacker, defender, attack) {
    const v = attacker.netVerdict;
    if (!v) { attacker.hasHit = true; return; }
    if (v.outcome === 'whiff') return; // the sim says it missed: let the limb sail through
    const wMul = attacker.swingWindupMul ?? 1.0;
    const aMul = attacker.swingActiveMul ?? 1.0;
    const phase = attacker.stateT > attack.windup * wMul + attack.active * aMul ? 'recover' : 'active';
    const hit = testAttackHit(attacker.rig, attacker.strike || attack.name, phase, defender.rig);
    if (!hit) return;
    this._presentNetVerdict(attacker, defender, attack, v, hit);
  }

  /** After each fighter's tick: a verdict whose swing ended (or was interrupted) without contact lands now. */
  _netDeadline(f, opp) {
    const v = f.netVerdict;
    if (!v) return;
    const a = f.attack;
    const swinging = a && (f.state === 'punch' || f.state === 'kick');
    if (swinging && f.stateT <= a.windup + a.active + 0.02) return;
    this._presentNetVerdict(f, opp, a || ATTACKS.punch, v, chestHit(opp));
  }

  /** Land one verdict with the ordinary presentation: the engine's own block and hit code paths. */
  _presentNetVerdict(attacker, defender, attack, v, hit) {
    attacker.netVerdict = null;
    attacker.hasHit = true;
    if (v.outcome === 'whiff' || defender.state === 'ko') return;
    // Until the server confirms a KO, a predicted killing blow leaves the defender on 1 HP.
    let amount = v.damage;
    const dp = this.combat.getPlayer(defender.playerId);
    if (dp && !(this.online.final && this.online.final.event === 'ko') && amount >= dp.health) amount = Math.max(0, dp.health - 1);
    const dpos = defender.rig.root.position;
    const apos = attacker.rig.root.position;
    const knockDir = new THREE.Vector3(dpos.x - apos.x, 0, dpos.z - apos.z);
    if (knockDir.lengthSq() > 1e-6) knockDir.normalize(); else knockDir.set(1, 0, 0);
    const impulseDir = knockDir.clone();
    const atkMass = attacker.rig.config.mass;
    const defMass = defender.rig.config.mass;
    const region = regionForHurtBone(hit.capsule);
    const s = {
      attacker, defender, attack, hit, phase: 'active', region, regionMod: 1,
      effect: regionEffect(defender.regionDmg), knockDir, impulseDir,
      chargeMul: v.special ? 2.5 : 1, atkMass, defMass,
      powerScale: attacker.rig.config.attackPower * (atkMass / defMass), dpos,
      baseDmg: amount, torqueY: 0,
    };

    if (v.outcome === 'blocked') {
      // The guard held: the block's sparks, sound and absorb, plus any chip the sim took.
      this._spawnSparks(hit.point, 0x9ad0ff, 6, 1.0);
      this._flashImpactLight(hit.point, 3, 0x9ad0ff, 0.1);
      this.audio.block(hit.point);
      this._show('block', { point: hit.point });
      attacker.animator.applyReaction('shoulderR', 4, 0, -3);
      attacker.animator.applyReaction('elbowR', -6, 0, 0);
      defender.animator.applyReaction('elbowL', -3.5, 0, 0);
      defender.animator.applyReaction('elbowR', -3.5, 0, 0);
      defender.animator.applyReaction('torso', -1.5, 0, 0);
      defender.knockback.add(knockDir.clone().multiplyScalar(2.0 / defMass));
      defender.stats.blocks += 1;
      this._hitFeedback(attack, false);
      // The guard's short high buzz — the local corner's pad only (haptics.js).
      this._rumble(defender, 0, 0.35, 45);
      if (amount > 0) {
        this.combat.damage({ playerId: defender.playerId, amount, sourceId: attacker.playerId });
        this.hudDirty = true;
        this._resolveCombatEvents(s);
      }
      return;
    }
    this._landHit(s);
    this._resolveCombatEvents(s);
    this._heavyHitStagger(s);
  }

  /**
   * Per sim tick while fighting: pull each fighter onto its mark (the controller's steering
   * does the walking; this removes the residue — lunges, knockback, a rollback's correction),
   * and end the fight when the server has.
   */
  _tickNet(dt) {
    const now = performance.now() / 1000;
    // Wall-clock, not engine time: on a slow device the render loop caps dt (MAX_FRAME_DT), so
    // the engine runs slower than real time — and a fighter steered on engine time would trail
    // the sim's X further every second. The sim's ring is real time; so is this.
    const realDt = Math.min(0.25, Math.max(dt, now - (this.online.steerAt || now)));
    this.online.steerAt = now;
    const k = 1 - Math.exp(-realDt * 10);
    const nowMs = now * 1000;
    for (const f of this.fighters) {
      if (f.state === 'ko') continue;
      const tx = f.controller.targetX();
      const pos = f.rig.root.position;
      // A big rollback correction closes in ~3 frames (under the smear) rather than sliding.
      const kx = nowMs < this.online.warpUntil[f.index - 1] ? Math.max(k, WARP_K) : k;
      if (tx !== null) pos.x += (tx - pos.x) * kx;
      // The sim's ring is a line; circling and knockback drift come back to it.
      pos.z *= 1 - k;
    }
    const fin = this.online.final;
    if (!fin || this.phase !== 'fighting') return;
    if (fin.event === 'ko' && fin.winner) {
      const winner = this.fighters[fin.winner - 1];
      const loser = this.fighters[2 - fin.winner];
      // The killing blow is usually still in the air: let it land on the chin (1.5 s at most).
      const inAir = winner.netVerdict && winner.netVerdict.outcome !== 'whiff';
      if (inAir && now - this.online.finalAt < 1.5) return;
      if (loser.state !== 'ko') {
        // It already landed (on the 1 HP a predicted KO leaves) or never will: finish it now.
        const hp = this.combat.getPlayer(loser.playerId)?.health ?? 1;
        winner.netVerdict = null;
        this._presentNetVerdict(winner, loser, winner.attack || ATTACKS.punch,
          { outcome: 'hit', damage: Math.max(1, Math.ceil(hp)), special: false }, chestHit(loser));
      }
      if (this.phase !== 'fighting') return; // that was the KO
    }
    for (const f of this.fighters) {
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      if (f.netVerdict) this._presentNetVerdict(f, opp, f.attack || ATTACKS.punch, f.netVerdict, chestHit(opp));
    }
    if (this.phase !== 'fighting') return; // that verdict was the KO
    const label = fin.event === 'forfeit' ? 'FORFEIT!' : fin.event === 'abandoned' ? 'NO CONTEST' : fin.event === 'ko' ? 'K.O.!' : 'TIME!';
    this._endMatch(fin.winner, label);
  }

  _disposeNet() {
    if (this.netInput) { this.netInput.dispose(); this.netInput = null; }
    if (this.online?.raf) cancelAnimationFrame(this.online.raf);
    for (const g of this.online?.ghosts || []) {
      if (!g) continue;
      this.scene?.remove(g.mesh);
      g.mesh.geometry.dispose();
      g.mesh.material.dispose();
    }
    if (this.online) this.online.ghosts = [null, null];
    const u = this.fxPass?.uniforms;
    if (u?.uNetSmear) u.uNetSmear.value = 0;
  }
}

export const Netplay = NetplayMethods.prototype;
