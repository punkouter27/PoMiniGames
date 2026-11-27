// ffaMode.js — the free-for-all on the 1v1 engine. BrawlGame runs mode 'ffa' with the same
// fighters, renderer, post chain, blood, sweat, limb loss, charge strikes, daze, crowd, PA and
// camera director as a 1v1 bout; this mixin adds what a crowded ring needs on top:
//
//   • FFA_FIELD fighters (including Bob when a human plays), spawned on a ring
//   • every fighter picks a TARGET (the 1v1 "opp"); the AI controllers fight that target
//   • a swing can land on whoever its limb touches, not only the target
//   • NO count in the free-for-all: a fighter who goes down is out for good. A knockdown
//     and an empty health bar both eliminate; the last one standing is champion
//   • the FFA page's interop (OnFfa*): standings, feed, broadcast, seasons, facts, agent lab
//
// The benchmark and the agent lab still play thousands of rounds with no renderer; that
// headless simulation lives in ffaSim.js and only feeds the dashboard.
import * as THREE from 'three-eco/webgpu';
import * as CANNON from '../platform/physics/cannonCompat.js';
import { RING_HALF, twangRope } from './arena.js';
import { MAX_HP, TIME_LIMIT } from './constants.js';
import { CHARACTERS } from './fighters.js';
import { createRetiredBody } from './physics.js';
import { FfaSeason, FFA_PROFILES } from './ffaSeason.js';
import { getFfaAgentStrategy, getFfaAgentPresets } from './ffaAgents.js';
import { createWikimediaFacts } from './ffaFacts.js';
import { FfaSim } from './ffaSim.js';

export const FFA_FIELD = 8;
/** Seconds the champion holds the ring before the next round. */
const RESULT_HOLD = 5;
/** Spawn ring radius (RING_HALF is 5.2). */
const SPAWN_RADIUS = 4.0;
/** A swing is tested against every standing body this close to the swinger. */
const HIT_REACH = 2.2;
/** After the clock runs out every blow lands harder, so a round always ends. */
const OVERTIME_DMG = 1.5;
/** Seconds a fallen body stays in the physics solver before it is frozen in place. */
const RETIRE_AFTER = 4;
/** Overtime: the closing ring's radius shrinks this fast (m/s) down to RING_MIN. */
const RING_CLOSE_RATE = 0.2;
const RING_MIN = 1.4;
/** Seconds between broadcast snapshots to the page. */
const BROADCAST_EVERY = 0.5;
/** Canvas surface height (matches physics.js floorBody). */
const MAT_FLOOR_Y = 0.04;
/** Horizontal foot/shin radius used when shoving downed bodies out of the way. */
const FOOT_PUSH_RADIUS = 0.32;
/** Maximum height a standing fighter can climb onto a pile of downed bodies. */
const MAX_STEP_HEIGHT = 1.6;
/** Keep shoved retired bodies inside the ropes. */
const CORPSE_RING_LIMIT = RING_HALF - 0.15;
/** Body parts sampled for downed-body pushing and stacking: [ragdollPart, rigJoint, radius]. */
const DOWNED_PARTS = [
  ['pelvis', 'hips', 0.20],
  ['chest', 'torso', 0.24],
  ['head', 'head', 0.16],
  ['thighL', 'hipL', 0.14],
  ['thighR', 'hipR', 0.14],
];
const _partPos = new THREE.Vector3();
const _yAxis = new CANNON.Vec3(0, 1, 0);
/** Damage bonus while standing atop a pile of downed bodies ("King of the Pile"). */
const PILE_HIGH_GROUND_DMG = 1.15;

class FfaModeMethods {
  /** Free-for-all bookkeeping. Called from start() before the first spawn. */
  _ffaInit() {
    const o = this.options;
    const cpuCount = FFA_FIELD - (o.human ? 1 : 0);
    if (!Array.isArray(o.fighters) || o.fighters.length !== cpuCount
        || new Set(o.fighters.map((fighter) => fighter.id)).size !== cpuCount
        || o.fighters.some((fighter) => fighter.id === 'bob')) {
      throw new Error(`Brawl FFA needs ${cpuCount} distinct CPU fighters${o.human ? ' plus Bob' : ''}.`);
    }
    this.ffaHuman = !!o.human;
    this.ffaRoster = this.ffaHuman ? [...o.fighters, { id: 'bob', name: 'Bob' }] : [...o.fighters];
    this.ffaFeed = [];
    this.ffaRoundId = 0;
    this.ffaBroadcastT = 0;
    this.ffaResultPending = false;
    this.ffaFocus = null;
    this.ffaFocusHold = 0;
    this.benchmark = null;
    this.benchmarkRunning = false;
    this.agentEvaluation = null;
    this.presentation = {};
    this.seasons = new FfaSeason(this.ffaRoster, {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    }, (message) => this._ffaNotify('OnFfaError', message),
    this.ffaHuman ? 'pobrawl.ffa.player.eight.seasons.v1' : 'pobrawl.ffa.eight.seasons.v1');
    this.ffaRound = this.seasons.state.totalRounds;
    this.factsEnabled = this.seasons.state.factsEnabled === true;
    this.facts = createWikimediaFacts({ onPresentation: (p) => this._ffaPresent(p) });
    if (this.factsEnabled) this._ffaWaitingForFact();
    if (o.muted) this.setMuted(true);
  }

  _ffaNotify(method, ...args) {
    if (!this.dotnet || this.disposed) return;
    this.dotnet.invokeMethodAsync(method, ...args).catch((error) => {
      if (!this.disposed) console.error(`[PoBrawl FFA] ${method} callback failed`, error);
    });
  }

  _ffaPresent(partial) {
    this.presentation = { ...this.presentation, ...partial };
    this._ffaNotify('OnFfaPresentation', JSON.stringify(this.presentation));
  }

  /** The character ids to spawn, in roster order. */
  _ffaCharIds() {
    return this.ffaRoster.map((e) => e.id);
  }

  /** Where fighter `i` of `n` starts: a shuffled place on the spawn ring, facing the centre. */
  _ffaSpawnSlots(n) {
    const slots = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rng.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    return slots.map((s, i) => {
      const a = (2 * Math.PI * s) / n;
      const r = SPAWN_RADIUS + (i % 2) * 0.35;
      return { x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: a + Math.PI };
    });
  }

  /** Fresh per-round FFA fields on a just-spawned fighter. */
  _ffaDecorate(f, entry) {
    f.id = entry.id;
    f.ffaName = entry.name;
    f.human = this.ffaHuman && entry.id === 'bob';
    f.target = null;
    f.retargetIn = this.rng.random() * 0.4;
    f.alive = true;
    f.place = 0;
    f.dealt = 0;
    f.knockouts = 0;
    f.rearHitsTaken = 0;
    f.lastAttacker = null;
    f.ffaKoAt = 0;
    f.ffaRetired = false;
    f.ffaBody = null;
    f.ffaCorpseBody = null;
    f.ffaLiftVy = 0;
    f.ffaOnPile = false;
    f._wasOnPile = false;
    f._pileCalloutCd = 0;
    f._tripCd = 0;
    // The meshes that cast a real shadow; only the camera's pair keep theirs (_ffaShadows).
    f.ffaCasters = [];
    f.rig.root.traverse((o) => { if (o.isMesh && o.castShadow) f.ffaCasters.push(o); });
  }

  /**
   * Full rigs casting into the key light's shadow map increase draw calls. The two
   * fighters the camera frames cast real shadows; the rest keep their contact blobs.
   */
  _ffaShadows() {
    const duo = this._duo();
    for (const f of this.fighters) {
      const on = duo.includes(f);
      if (f.ffaShadowOn === on) continue;
      f.ffaShadowOn = on;
      for (const m of f.ffaCasters || []) m.castShadow = on;
    }
  }

  /** A new round has spawned: tell the page, reset the feed and the camera's subject. */
  _ffaRoundStarted() {
    this.ffaRound += 1;
    this.ffaRoundId += 1;
    this.ffaFeed = [];
    this.ffaFocus = null;
    this.ffaFocusHold = 0;
    this.ffaResultPending = false;
    this.ffaRingCalled = false;
    this._ffaNotify('OnFfaPaused', false);
    this._ffaNotify('OnFfaRoundStarted', this.ffaRound, this.ffaRoundId);
    this._ffaPublishDashboard();
  }

  // ── Targets ────────────────────────────────────────────────────────────

  /** This round's style for a fighter (ffaAgents.js preset × the season profile). */
  _ffaStrategy(f) {
    const global = FFA_PROFILES[this.seasons?.state.profile] || FFA_PROFILES.balanced;
    if (f.id === 'bob') return { ...global, aggression: 1, move: 1, retarget: 1 };
    const style = getFfaAgentStrategy(f.id, this.seasons?.getAgentPreset(f.id) || 'native');
    return { ...style, weak: style.weak * global.weak / FFA_PROFILES.balanced.weak };
  }

  _ffaStanding() {
    return this.fighters.filter((f) => f.alive);
  }

  /** Nearest standing rival, weighted toward the hurt ones by the fighter's style. */
  _ffaPickTarget(f) {
    const weak = this._ffaStrategy(f).weak;
    let best = null, score = Infinity;
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      const q = o.rig.root.position;
      const s = Math.hypot(q.x - p.x, q.z - p.z) * (0.85 + (this._hp(o) / MAX_HP) * weak);
      if (s < score) { score = s; best = o; }
    }
    return best;
  }

  /** Re-aim everybody whose target fell or whose re-think timer ran out. Once per tick. */
  _ffaRetarget(dt) {
    for (const f of this.fighters) {
      if (!f.alive) continue;
      f.retargetIn -= dt;
      if (f.target?.alive && f.retargetIn > 0) continue;
      // Whoever just hit you is a strong candidate: a free-for-all is full of grudges.
      const grudge = f.lastAttacker && this.fighters.find((o) => o.id === f.lastAttacker && o.alive);
      f.target = grudge && this.rng.random() < 0.45 ? grudge : this._ffaPickTarget(f);
      f.retargetIn = (0.9 + this.rng.random() * 0.8) * this._ffaStrategy(f).retarget;
    }
  }

  /**
   * The fighter `f` is squared up to: the other corner in a 1v1, the chosen target in the
   * free-for-all. Never null while two are standing.
   */
  _opponentOf(f) {
    if (!this.ffa) return f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
    if (f.target && f.target !== f && f.target.alive) return f.target;
    f.target = this._ffaPickTarget(f) || f.target || this.fighters.find((o) => o !== f);
    return f.target;
  }

  /** Who a live swing by `f` may land on this tick: its target first, then anyone in reach. */
  _hitCandidates(f, opp) {
    if (!this.ffa) return [opp];
    const out = opp?.alive ? [opp] : [];
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || o === opp || !o.alive) continue;
      const q = o.rig.root.position;
      if (Math.hypot(q.x - p.x, q.z - p.z) <= HIT_REACH) out.push(o);
    }
    return out;
  }

  /** Overtime + high-ground pile bonus in the free-for-all. */
  _ffaDamageMul(attacker = null) {
    if (!this.ffa) return 1;
    let mul = (this.clock || 0) > TIME_LIMIT ? OVERTIME_DMG : 1;
    if (attacker?.ffaOnPile) mul *= PILE_HIGH_GROUND_DMG;
    return mul;
  }

  /** A blow landed: credit it and tell the standings. */
  _ffaOnDamage(attacker, defender, dmg) {
    if (!this.ffa || !(dmg > 0)) return;
    attacker.dealt += Math.min(dmg, this._hp(defender) + dmg);
    defender.lastAttacker = attacker.id;
    // Hit from behind (outside the defender's facing): the agent lab scores these.
    const yaw = defender.rig.root.rotation.y;
    const a = attacker.rig.root.position, d = defender.rig.root.position;
    const dx = a.x - d.x, dz = a.z - d.z, len = Math.hypot(dx, dz) || 1;
    if ((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / len < 0) defender.rearHitsTaken += 1;
    // The struck fighter turns on whoever is hitting them.
    if (defender.target !== attacker && this.rng.random() < 0.6) defender.target = attacker;
    this._ffaNotify('OnFfaHit', defender.id, this._hp(defender));
  }

  /**
   * In the free-for-all a knockdown is the end: no count. Empty the health bar through
   * CombatPlay so the usual KO path (ragdoll, feed, champion) runs.
   */
  _ffaKnockout(f, attacker, knockDir) {
    const hp = this._hp(f);
    if (hp > 0) {
      this.combat.damage({ playerId: f.playerId, amount: hp + 1, sourceId: attacker?.playerId ?? f.playerId, bypassArmor: true });
    }
    this._resolveCombatEvents({
      attacker: attacker || f, defender: f, attack: { name: 'punch' },
      hit: { point: f.rig.root.position.clone().setY(1.2) }, region: 'head',
      knockDir: knockDir || new THREE.Vector3(0, 0, -1), torqueY: 0, counter: false,
    });
  }

  /** Called from the PLAYER_KILLED event: the fighter is out of the free-for-all. */
  _ffaEliminated(downed, attacker) {
    if (!downed.alive) return;
    downed.alive = false;
    downed.target = null;
    downed.controller?.releaseAll?.();
    if (attacker && attacker !== downed) attacker.knockouts += 1;
    const remaining = this.fighters.filter((f) => f.alive).length;
    downed.place = remaining + 1;
    downed.ffaKoAt = this.t;
    this.ffaFeed.unshift({ id: downed.id, attacker: downed.lastAttacker || '', place: downed.place });
    this.ffaFeed = this.ffaFeed.slice(0, 4);
    // Shadows and the swing ribbon go with them; the ragdoll stays on the canvas.
    if (downed.trail) downed.trail.mesh.visible = false;
    for (const f of this.fighters) if (f.target === downed) f.retargetIn = 0;
    if (this.ffaFocus === downed) this.ffaFocusHold = 1.4;
    const p = downed.rig.root.position;
    this._spawnCallout?.(new THREE.Vector3(p.x, 1.6, p.z), `#${downed.place}`);
    if (remaining > 1) {
      this._jumboCaption?.(`${remaining} LEFT`, 1.2);
      this.audio?.crowdSwell?.(0.8);
    }
    this._ffaNotify('OnFfaEliminated', downed.id, downed.place, remaining);
  }

  // ── The camera's pair ──────────────────────────────────────────────────

  /**
   * The two fighters the camera, the director, the spotlight and the danger cues frame:
   * both corners in a 1v1; in the free-for-all Bob (or the featured fighter) and whoever
   * they are squared up to.
   */
  _duo() {
    if (!this.ffa) return this.fighters;
    const focus = this._ffaFocusFighter();
    const other = focus.alive ? this._opponentOf(focus) : this._ffaNearest(focus);
    return [focus, other || focus];
  }

  _ffaNearest(f) {
    let best = null, d = Infinity;
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      const q = o.rig.root.position;
      const s = Math.hypot(q.x - p.x, q.z - p.z);
      if (s < d) { d = s; best = o; }
    }
    return best;
  }

  /** Always Bob in 1P FFA; otherwise the most endangered fighter, held a moment after a KO. */
  _ffaFocusFighter() {
    const bob = this.fighters.find((f) => f.human);
    if (bob) return (this.ffaFocus = bob);
    if (this.phase === 'result' || this.phase === 'ko') {
      const champ = this.winner ? this.fighters[this.winner - 1] : null;
      if (champ) return (this.ffaFocus = champ);
    }
    if (this.ffaFocus && (this.ffaFocusHold > 0 || this.ffaFocus.alive)) {
      if (this.ffaFocus.alive && this._hp(this.ffaFocus) > 30) return this.ffaFocus;
      if (this.ffaFocusHold > 0) return this.ffaFocus;
    }
    let pick = null;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (!pick || this._hp(f) < this._hp(pick)) pick = f;
    }
    this.ffaFocus = pick || this.fighters[0];
    return this.ffaFocus;
  }

  // ── The tick ───────────────────────────────────────────────────────────

  /** Per tick, before the fighters move. */
  _ffaTick(dt) {
    this.ffaFocusHold = Math.max(0, this.ffaFocusHold - dt);
    if (this.phase === 'fighting') {
      this._ffaRetarget(dt);
      this._ffaCloseRing(dt);
    }
    this._ffaRetireBodies();
    this.ffaBroadcastT += dt;
    if (this.ffaBroadcastT >= BROADCAST_EVERY) {
      this.ffaBroadcastT = 0;
      this._ffaBroadcast();
      this._ffaShadows();
    }
    if (this.phase === 'result' && !this.ffaResultPending && this.phaseT >= RESULT_HOLD) {
      if (this.paused) this.ffaResultPending = true;
      else this._ffaNextRound();
    }
  }

  /** Snapshot a fallen fighter's resting body parts relative to its root for pushing & stacking. */
  _ffaSnapshotBody(f) {
    const root = f.rig.root.position;
    const ragBodies = f.koRagdoll?.active ? f.koRagdoll.bodies : null;
    if (!ragBodies) f.rig.root.updateMatrixWorld(true);
    const parts = [];
    let minBottomOff = Infinity;
    for (const [partName, jointName, radius] of DOWNED_PARTS) {
      let px, py, pz;
      const rb = ragBodies?.[partName];
      if (rb) {
        px = rb.position.x; py = rb.position.y; pz = rb.position.z;
      } else {
        const joint = f.rig.joints?.[jointName];
        if (!joint) continue;
        joint.getWorldPosition(_partPos);
        px = _partPos.x; py = _partPos.y; pz = _partPos.z;
      }
      const oy = py - root.y;
      const ox = px - root.x, oz = pz - root.z;
      parts.push({ ox, oy, oz, ox0: ox, oz0: oz, radius });
      minBottomOff = Math.min(minBottomOff, oy - radius);
    }
    if (!parts.length) {
      parts.push({ ox: 0, oy: 0.20, oz: 0, ox0: 0, oz0: 0, radius: 0.24 });
      minBottomOff = -0.04;
    }
    return {
      parts, minBottomOff, vx: 0, vz: 0, vy: 0,
      angVel: 0, yawOffset: 0, baseYaw: f.rig.root.rotation.y,
      skidFrom: null, dustCd: 0, ropeCd: 0, wasAirborne: false,
      mass: f.rig.config.mass || 1,
    };
  }

  /** World-space collision spheres for a downed fighter (live ragdoll or retired body). */
  _ffaDownedParts(f) {
    if (f.koRagdoll?.active && f.koRagdoll.bodies) {
      const out = [];
      for (const [partName, , radius] of DOWNED_PARTS) {
        const b = f.koRagdoll.bodies[partName];
        if (!b) continue;
        out.push({ x: b.position.x, y: b.position.y, z: b.position.z, radius, topY: b.position.y + radius, body: b });
      }
      if (out.length) return out;
    }
    const root = f.rig.root.position;
    if (f.ffaBody) {
      const c = Math.cos(f.ffaBody.yawOffset), s = Math.sin(f.ffaBody.yawOffset);
      return f.ffaBody.parts.map((pt) => {
        const rx = pt.ox0 * c + pt.oz0 * s;
        const rz = -pt.ox0 * s + pt.oz0 * c;
        const y = root.y + pt.oy;
        return { x: root.x + rx, y, z: root.z + rz, radius: pt.radius, topY: y + pt.radius, body: null };
      });
    }
    return [{ x: root.x, y: root.y + 0.20, z: root.z, radius: 0.24, topY: root.y + 0.44, body: null }];
  }

  /**
   * Personality-driven AI steering around downed bodies: heavyweights bulldoze straight through,
   * while lighter or cautious CPUs gently steer around dense piles ahead of them.
   */
  _ffaBodySteer(f, desired) {
    if (!f.alive || f.human || desired.lengthSq() < 0.04) return;
    const mass = f.rig.config.mass || 1;
    const st = this._ffaStrategy(f);
    const cautious = st.guard < 0.75;
    if (mass >= 1.12 && !cautious) return;
    const avoidWeight = (cautious ? 0.95 : 0.65) * Math.max(0.25, 1.15 - mass);
    const sp = f.rig.root.position;
    const speed = desired.length();
    const fx = desired.x / speed, fz = desired.z / speed;
    let sx = 0, sz = 0;
    for (const d of this.fighters) {
      if (d === f || d.alive || d.state !== 'ko') continue;
      const dp = d.rig.root.position;
      const dx = dp.x - sp.x, dz = dp.z - sp.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.1 || dist > 1.25) continue;
      const ahead = (dx * fx + dz * fz) / dist;
      if (ahead < 0.25) continue;
      // Lateral push away from the body's side of our forward line.
      const side = dx * -fz + dz * fx;
      const dir = side >= 0 ? -1 : 1;
      const w = ((1.25 - dist) / 1.15) * ahead;
      sx += -fz * dir * w;
      sz += fx * dir * w;
    }
    const sl = Math.hypot(sx, sz);
    if (sl > 1e-4) {
      desired.x += (sx / sl) * speed * Math.min(0.65, sl * avoidWeight);
      desired.z += (sz / sl) * speed * Math.min(0.65, sl * avoidWeight);
    }
  }

  /**
   * A fallen body leaves the dynamic ragdoll solver once it has had RETIRE_AFTER seconds to land,
   * keeping its pose plus a lightweight kinematic proxy so later knockouts stack on top of it and
   * standing fighters still push it aside or climb over it instead of walking through it.
   */
  _ffaRetireBodies() {
    for (const f of this.fighters) {
      if (f.alive || f.ffaRetired || !f.ffaKoAt || this.t - f.ffaKoAt < RETIRE_AFTER) continue;
      if (f.pendingKO) continue; // not built yet
      if (f.koRagdoll?.active) f.koRagdoll.drive();
      f.ffaBody = this._ffaSnapshotBody(f);
      f.koRagdoll?.dispose();
      if (this._physics) {
        f.ffaCorpseBody = createRetiredBody(
          this._physics.world, this._physics.materials, f.rig.root.position, f.ffaBody.parts);
      }
      f.ffaRetired = true;
    }
  }

  /**
   * Prevent standing fighters from walking through downed bodies on the mat:
   * - Walking forward into a body shoves & spins it out of the way (with dust, scuffs & rope twang).
   * - High-speed knockback into a body trips the fighter over it.
   * - Walking onto a body or pile lifts the survivor on top ("King of the Pile" high ground).
   */
  _ffaResolveDownedBodies(dt) {
    const downed = this.fighters.filter((f) => !f.alive && f.state === 'ko');
    if (!downed.length) {
      for (const s of this.fighters) {
        if (!s.alive || s.state === 'ko') continue;
        s.ffaOnPile = false;
        s._wasOnPile = false;
        const sp = s.rig.root.position;
        if (sp.y > 0) {
          s.ffaLiftVy = Math.max(-6, (s.ffaLiftVy || 0) - 18 * dt);
          sp.y = Math.max(0, sp.y + s.ffaLiftVy * dt);
          if (sp.y === 0) s.ffaLiftVy = 0;
          if (s.rigBody) s.rigBody.position.y = sp.y + 0.9;
        }
      }
      return;
    }

    const partsByFighter = new Map();
    for (const d of downed) partsByFighter.set(d, this._ffaDownedParts(d));

    // 1. Standing fighters walking forward (or knocked back) into downed bodies shove & spin them.
    for (const s of this.fighters) {
      if (!s.alive || s.state === 'ko') continue;
      const sp = s.rig.root.position;
      const svx = s.vel.x + s.knockback.x;
      const svz = s.vel.z + s.knockback.z;
      const kbSpeed = Math.hypot(s.knockback.x, s.knockback.z);
      const sMass = s.rig.config.mass || 1;
      const bulldoze = sMass >= 1.12 ? 1.12 : 1.0;
      for (const d of downed) {
        const parts = partsByFighter.get(d);
        const dRoot = d.rig.root.position;
        let pushedRetired = false;
        let hitBody = false;
        for (const part of parts) {
          if (part.y - part.radius > sp.y + 0.9) continue;
          const dx = part.x - sp.x, dz = part.z - sp.z;
          const dist = Math.hypot(dx, dz);
          const reach = part.radius + FOOT_PUSH_RADIUS;
          if (dist >= reach) continue;
          hitBody = true;
          let nx, nz;
          if (dist > 1e-4) {
            nx = dx / dist; nz = dz / dist;
          } else {
            const vLen = Math.hypot(svx, svz);
            if (vLen > 1e-4) { nx = svx / vLen; nz = svz / vLen; }
            else { nx = Math.sin(s.rig.root.rotation.y); nz = Math.cos(s.rig.root.rotation.y); }
          }
          const into = svx * nx + svz * nz;
          if (into <= 0.12) continue;
          if (d.koRagdoll?.active && part.body) {
            const massRatio = Math.min(1.6, sMass / (d.rig.config.mass || 1));
            const shove = Math.min(3.8, into * 1.1 * massRatio * bulldoze);
            const blend = Math.min(1, dt * 14);
            for (const b of [part.body, d.koRagdoll.bodies.pelvis, d.koRagdoll.bodies.chest]) {
              if (!b) continue;
              const w = b === part.body ? blend : blend * 0.45;
              b.velocity.x += (nx * shove - b.velocity.x) * w;
              b.velocity.z += (nz * shove - b.velocity.z) * w;
            }
          } else if (d.ffaBody) {
            const massRatio = Math.min(1.6, sMass / d.ffaBody.mass);
            const shove = Math.min(3.4, into * 1.15 * massRatio * bulldoze);
            const blend = Math.min(1, dt * 16);
            d.ffaBody.vx += (nx * shove - d.ffaBody.vx) * blend;
            d.ffaBody.vz += (nz * shove - d.ffaBody.vz) * blend;
            // Off-center push creates yaw torque so the body pivots naturally out of the way.
            const rx = part.x - dRoot.x, rz = part.z - dRoot.z;
            const torque = rz * (nx * shove) - rx * (nz * shove);
            d.ffaBody.angVel += THREE.MathUtils.clamp(torque * 4.5, -5, 5) * blend;
            pushedRetired = true;
          }
        }
        if (pushedRetired) {
          const drag = 1 - Math.min(0.18, dt * 3);
          s.vel.x *= drag;
          s.vel.z *= drag;
        }
        // Knocked backward at high speed into a body on the canvas: trip over it!
        if (hitBody && kbSpeed > 2.6 && this.t >= (s._tripCd || 0)) {
          s._tripCd = this.t + 1.4;
          s.knockback.multiplyScalar(1.18);
          s.animator?.applyLean?.(-0.32, 0);
          if (s.state === 'idle' || s.state === 'block') s.animator?.play?.('stumble');
          this._spawnDust?.(sp.x, sp.z, 0.55);
          this._spawnCallout?.(new THREE.Vector3(sp.x, sp.y + 1.8, sp.z), 'TRIPPED!');
        }
      }
    }

    // 2. Retired-vs-retired momentum transfer so a shoved body pushes or piles against neighbors.
    const retired = downed.filter((d) => d.ffaBody);
    for (let i = 0; i < retired.length; i++) {
      const a = retired[i], aRoot = a.rig.root.position;
      for (let j = i + 1; j < retired.length; j++) {
        const b = retired[j], bRoot = b.rig.root.position;
        if (Math.abs(aRoot.y - bRoot.y) > 0.28) continue;
        const dx = bRoot.x - aRoot.x, dz = bRoot.z - aRoot.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= 0.72 || dist < 1e-4) continue;
        const nx = dx / dist, nz = dz / dist;
        const closing = (a.ffaBody.vx - b.ffaBody.vx) * nx + (a.ffaBody.vz - b.ffaBody.vz) * nz;
        if (closing > 0.05) {
          const transfer = closing * 0.45;
          a.ffaBody.vx -= nx * transfer; a.ffaBody.vz -= nz * transfer;
          b.ffaBody.vx += nx * transfer; b.ffaBody.vz += nz * transfer;
          const spinKick = (nx * a.ffaBody.vz - nz * a.ffaBody.vx) * 0.6;
          b.ffaBody.angVel += THREE.MathUtils.clamp(spinKick, -2, 2) * dt * 8;
        }
      }
    }

    // 3. Integrate sliding/spinning retired bodies, scuffs/dust, rope twang, gravity & proxy sync.
    const friction = Math.exp(-dt * 7.5);
    const angFriction = Math.exp(-dt * 6.5);
    for (const d of retired) {
      const b = d.ffaBody;
      const root = d.rig.root.position;
      b.dustCd = Math.max(0, b.dustCd - dt);
      b.ropeCd = Math.max(0, b.ropeCd - dt);
      b.vx *= friction;
      b.vz *= friction;
      b.angVel *= angFriction;
      const speed = Math.hypot(b.vx, b.vz);
      if (speed < 0.01) { b.vx = 0; b.vz = 0; }
      if (Math.abs(b.angVel) < 0.01) b.angVel = 0;

      const rawX = root.x + b.vx * dt;
      const rawZ = root.z + b.vz * dt;
      root.x = THREE.MathUtils.clamp(rawX, -CORPSE_RING_LIMIT, CORPSE_RING_LIMIT);
      root.z = THREE.MathUtils.clamp(rawZ, -CORPSE_RING_LIMIT, CORPSE_RING_LIMIT);
      if (root.x !== rawX) {
        if (Math.abs(b.vx) > 0.7 && b.ropeCd <= 0) {
          b.ropeCd = 0.35;
          const pwr = Math.min(1.6, Math.abs(b.vx) * 0.45);
          twangRope(this.arena, 'x', rawX > 0 ? 1 : -1, pwr);
          this.audio?.prop?.({ material: 'rope', power: pwr * 0.75, worldPos: root });
        }
        b.vx *= -0.2;
      }
      if (root.z !== rawZ) {
        if (Math.abs(b.vz) > 0.7 && b.ropeCd <= 0) {
          b.ropeCd = 0.35;
          const pwr = Math.min(1.6, Math.abs(b.vz) * 0.45);
          twangRope(this.arena, 'z', rawZ > 0 ? 1 : -1, pwr);
          this.audio?.prop?.({ material: 'rope', power: pwr * 0.75, worldPos: root });
        }
        b.vz *= -0.2;
      }

      if (b.angVel !== 0) {
        b.yawOffset += b.angVel * dt;
        d.rig.root.rotation.y = b.baseYaw + b.yawOffset;
      }

      // Mat drag scuffs & canvas dust when a shoved body slides fast across the floor.
      if (speed > 0.85 && root.y < 0.25) {
        if (b.skidFrom) {
          this.matWear?.skid(b.skidFrom.x, b.skidFrom.z, root.x, root.z, Math.min(0.75, speed / 3.5));
        }
        b.skidFrom = { x: root.x, z: root.z };
        if (b.dustCd <= 0) {
          b.dustCd = 0.18;
          this._spawnDust?.(root.x, root.z, Math.min(0.7, speed * 0.22));
        }
      } else {
        b.skidFrom = null;
      }

      const cosY = Math.cos(b.yawOffset), sinY = Math.sin(b.yawOffset);
      let supportY = MAT_FLOOR_Y;
      for (const other of downed) {
        if (other === d) continue;
        const oParts = partsByFighter.get(other);
        for (const pt of b.parts) {
          const rx = pt.ox0 * cosY + pt.oz0 * sinY;
          const rz = -pt.ox0 * sinY + pt.oz0 * cosY;
          const px = root.x + rx, py = root.y + pt.oy, pz = root.z + rz;
          for (const opt of oParts) {
            if (opt.topY > py + 0.16) continue;
            if (Math.hypot(px - opt.x, pz - opt.z) < pt.radius + opt.radius) {
              supportY = Math.max(supportY, opt.topY);
            }
          }
        }
      }
      const targetRootY = Math.min(MAX_STEP_HEIGHT, supportY - b.minBottomOff);
      if (root.y > targetRootY + 0.06) b.wasAirborne = true;
      if (root.y > targetRootY + 0.004) {
        b.vy = Math.max(-12, b.vy - 20 * dt);
        root.y = Math.max(targetRootY, root.y + b.vy * dt);
        if (b.wasAirborne && root.y <= targetRootY + 0.005) {
          b.wasAirborne = false;
          this._spawnDust?.(root.x, root.z, 0.55);
          this.audio?.impact?.({ power: 0.45, worldPos: root });
        }
      } else if (root.y < targetRootY) {
        root.y = Math.min(targetRootY, root.y + 4.0 * dt);
        b.vy = 0;
        b.wasAirborne = false;
      } else {
        b.vy = 0;
        b.wasAirborne = false;
      }

      if (d.ffaCorpseBody) {
        d.ffaCorpseBody.position.set(root.x, root.y, root.z);
        d.ffaCorpseBody.quaternion.setFromAxisAngle(_yAxis, b.yawOffset);
      }
      partsByFighter.set(d, this._ffaDownedParts(d));
    }

    // 4. Standing fighters step/stack up onto any downed body or pile beneath their feet.
    for (const s of this.fighters) {
      if (!s.alive || s.state === 'ko') continue;
      const sp = s.rig.root.position;
      const prevY = sp.y;
      let supportY = 0;
      let pileCount = 0;
      for (const d of downed) {
        let onThisBody = false;
        for (const part of partsByFighter.get(d)) {
          const dist = Math.hypot(sp.x - part.x, sp.z - part.z);
          const innerR = part.radius + 0.08;
          const outerR = part.radius + 0.34;
          if (dist >= outerR) continue;
          const partTop = Math.min(MAX_STEP_HEIGHT, Math.max(0, part.topY - MAT_FLOOR_Y));
          if (partTop > sp.y + 0.85) continue;
          const t = dist <= innerR ? 1 : (outerR - dist) / (outerR - innerR);
          const w = t * t * (3 - 2 * t);
          supportY = Math.max(supportY, partTop * w);
          if (w > 0.35) onThisBody = true;
        }
        if (onThisBody) pileCount += 1;
      }
      if (supportY > sp.y) {
        sp.y = Math.min(supportY, sp.y + Math.max(3.5, (supportY - sp.y) * 18) * dt);
        s.ffaLiftVy = 0;
        if (sp.y - prevY > 0.008) {
          s.animator?.applyLean?.(THREE.MathUtils.clamp((sp.y - prevY) * 3.5, -0.18, 0.18), 0);
        }
      } else if (sp.y > supportY) {
        s.ffaLiftVy = Math.max(-6, (s.ffaLiftVy || 0) - 18 * dt);
        sp.y = Math.max(supportY, sp.y + s.ffaLiftVy * dt);
        if (sp.y <= supportY + 1e-4) {
          sp.y = supportY;
          s.ffaLiftVy = 0;
          if (prevY - sp.y > 0.025) s.squashT = Math.max(s.squashT || 0, 0.07);
        }
      }
      // "King of the Pile": standing atop 2+ bodies or a high stack gives high-ground power.
      s.ffaOnPile = pileCount >= 2 || sp.y >= 0.45;
      if (s.ffaOnPile && !s._wasOnPile && this.t >= (s._pileCalloutCd || 0)) {
        s._pileCalloutCd = this.t + 6;
        this._spawnCallout?.(new THREE.Vector3(sp.x, sp.y + 2.0, sp.z), 'KING OF THE PILE!');
      }
      s._wasOnPile = s.ffaOnPile;
      if (s.rigBody) s.rigBody.position.y = sp.y + 0.9;
    }
  }

  /**
   * Overtime: the ring closes. Past the clock every standing fighter is herded inside a
   * shrinking circle, so the last few cannot keep to their own corners and the round ends.
   */
  _ffaCloseRing(dt) {
    const over = (this.clock || 0) - TIME_LIMIT;
    if (over < 0) { this.ffaRingCalled = false; return; }
    if (!this.ffaRingCalled) {
      this.ffaRingCalled = true;
      this._jumboCaption?.('OVERTIME', 1.6);
      this._caption?.('Overtime: the ring is closing.');
      this.audio?.crowdSwell?.(0.9);
    }
    const r = Math.max(RING_MIN, SPAWN_RADIUS + 1 - over * RING_CLOSE_RATE);
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const p = f.rig.root.position;
      const d = Math.hypot(p.x, p.z);
      if (d <= r || d < 1e-3) continue;
      const push = Math.min(4, (d - r) * 6) * dt;
      f.knockback.x -= (p.x / d) * push;
      f.knockback.z -= (p.z / d) * push;
    }
    // Everybody squares up to the nearest survivor: no more stalking across the ring.
    for (const f of this.fighters) if (f.alive && f.retargetIn > 0.5) f.retargetIn = 0.5;
  }

  _ffaNextRound() {
    this.ffaResultPending = false;
    this.resetMatch({ splash: false });
  }

  _ffaBroadcast() {
    const focus = this.ffaFocus;
    const standing = this.fighters.filter((f) => f.alive).length;
    const bob = this.fighters.find((f) => f.human);
    this._ffaNotify('OnFfaBroadcast', JSON.stringify({
      focus: focus?.id || '', health: focus ? this._hp(focus) : 0,
      attacker: focus?.lastAttacker || '',
      shot: this.ffaHuman ? 'Bob follow cam'
        : this._dir?.shot ? String(this._dir.shot) : 'Ringside',
      paused: !!this.paused, replay: this.phase === 'replay',
      finalDuel: standing === 2,
      overtime: (this.clock || 0) > TIME_LIMIT,
      feed: this.ffaFeed,
    }));
  }

  /** The last one standing: record the season, show the champion, queue the next round. */
  _ffaReportResult() {
    const champ = this.winner ? this.fighters[this.winner - 1] : this.fighters.find((f) => f.alive);
    if (!champ) return;
    champ.place = 1;
    this._setBanner(`${(champ.ffaName || champ.rig.config.name).toUpperCase()} WINS!`);
    this._setCameraMode('normal', { force: true });
    this._ffaNotify('OnFfaReplay', false);
    this._ffaNotify('OnFfaChampion', champ.id, this.ffaRoundId);
    if (this.factsEnabled) void this.facts?.loadFighter(champ.id, champ.ffaName || champ.rig.config.name);
    this.seasons?.record(this._ffaResults());
    this._ffaPublishDashboard();
    this._show('result', { winner: this.winner, ko: true });
    this._presentResult();
  }

  _ffaResults() {
    return this.fighters.map((f) => ({
      id: f.id, place: f.place || 1, damage: Math.round(f.dealt), knockouts: f.knockouts,
      rearHitsTaken: f.rearHitsTaken,
    }));
  }

  _ffaPublishDashboard() {
    if (!this.seasons) return;
    this._ffaNotify('OnFfaDashboard', JSON.stringify({
      ...this.seasons.snapshot(), activeProfile: this.seasons.state.profile || 'balanced',
      benchmark: this.benchmark || this.seasons.state.benchmark,
      benchmarkRunning: this.benchmarkRunning,
      agentEvaluation: this.agentEvaluation || this.seasons.state.agentLab?.report,
      agents: this.options.fighters.map(({ id, name }) => ({
        id, name, preset: this.seasons.getAgentPreset(id),
        style: getFfaAgentStrategy(id, this.seasons.getAgentPreset(id)),
        presets: getFfaAgentPresets(id).map((p) => p.id),
      })),
    }));
  }

  _ffaWaitingForFact() {
    this.presentation.fact = {
      status: 'waiting', text: 'Facts enabled. Champion facts appear between rounds.', sourceUrl: null, name: '',
    };
    this._ffaNotify('OnFfaPresentation', JSON.stringify(this.presentation));
  }

  // ── The FFA page's API (index.js ffa*) ─────────────────────────────────

  setProfile(profile) {
    this.seasons?.setProfile(profile);
    this._ffaPublishDashboard();
  }

  setFacts(enabled) {
    if (!this.seasons) return;
    this.factsEnabled = !!enabled;
    this.seasons.state.factsEnabled = this.factsEnabled;
    this.seasons.save();
    this._ffaPublishDashboard();
    this.facts?.dispose();
    this.facts = createWikimediaFacts({ onPresentation: (p) => this._ffaPresent(p) });
    if (enabled) this._ffaWaitingForFact();
    if (enabled && this.phase === 'result') {
      const champ = this.winner ? this.fighters[this.winner - 1] : null;
      if (champ) void this.facts.loadFighter(champ.id, champ.ffaName || champ.rig.config.name);
    }
  }

  resetSeasons() {
    if (this.benchmarkRunning) throw new Error('Wait for the benchmark to finish before resetting local seasons.');
    this.benchmark = null;
    this.seasons.reset();
    this.setFacts(false);
    this.ffaRound = 0;
    this._ffaNextRound();
  }

  /** Headless rounds through ffaSim.js; the live ring keeps fighting meanwhile. */
  async _ffaSimulate(opts) {
    const sim = new FfaSim({ fighters: this.ffaRoster, ...opts });
    let frame = 0;
    while (sim.phase === 'fighting' && frame < 60 * 180) {
      for (let batch = 0; batch < 60 && sim.phase === 'fighting'; batch++, frame++) sim.step(1 / 60);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (this.disposed) return null;
    }
    if (sim.phase !== 'result') throw new Error(`Seed ${opts.seed} exceeded 180 simulated seconds.`);
    return sim.results();
  }

  async runBenchmark() {
    if (this.benchmarkRunning || this.disposed || !this.seasons) return;
    this.benchmarkRunning = true;
    this.benchmark = { completed: 0, total: 48, physicsVersion: 5, rows: [] };
    this._ffaPublishDashboard();
    const totals = Object.keys(FFA_PROFILES).map((profile) =>
      ({ profile, rounds: 0, wins: 0, place: 0, damage: 0, knockouts: 0 }));
    const presets = Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons.getAgentPreset(id)]));
    try {
      for (let seed = 1; seed <= 16 && !this.disposed; seed++) {
        for (const row of totals) {
          const candidate = this.options.fighters[(seed - 1) % this.options.fighters.length].id;
          const results = await this._ffaSimulate({ seed, profile: row.profile, candidate, agentPresets: presets });
          if (!results) return;
          const result = results.find((r) => r.id === candidate);
          row.rounds++;
          row.wins += result.place === 1 ? 1 : 0;
          row.place += result.place;
          row.damage += result.damage;
          row.knockouts += result.knockouts;
          this.benchmark.completed++;
          this.benchmark.rows = totals.filter((r) => r.rounds).map((r) => ({
            profile: r.profile, rounds: r.rounds, wins: r.wins, averagePlace: r.place / r.rounds,
            averageDamage: r.damage / r.rounds, knockouts: r.knockouts,
            placementGain: totals[0].place / totals[0].rounds - r.place / r.rounds,
          }));
          this._ffaPublishDashboard();
        }
      }
      if (!this.disposed) {
        this.seasons.state.benchmark = this.benchmark;
        this.seasons.save();
      }
    } catch (error) {
      this._ffaNotify('OnFfaError', `Strategy benchmark failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._ffaPublishDashboard();
    }
  }

  async evaluateAgent(characterId, preset) {
    if (this.benchmarkRunning || this.disposed || !this.seasons) return;
    this.benchmarkRunning = true;
    this.agentEvaluation = null;
    this._ffaPublishDashboard();
    try {
      const evaluation = this.seasons.createAgentEvaluation(characterId, preset);
      const incumbents = Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons.getAgentPreset(id)]));
      const profile = this.seasons.state.profile;
      const run = async (seed, candidatePreset) => {
        const results = await this._ffaSimulate({
          seed, profile, agentPresets: { ...incumbents, [characterId]: candidatePreset },
        });
        return results && results.find((r) => r.id === characterId);
      };
      const pairs = [];
      for (const seed of evaluation.seeds) {
        const incumbent = await run(seed, evaluation.incumbentPreset);
        if (this.disposed || !incumbent) return;
        const candidate = await run(seed, evaluation.candidatePreset);
        if (this.disposed || !candidate) return;
        pairs.push({ seed, incumbent, candidate });
        this.agentEvaluation = { characterId, candidatePreset: preset, rounds: pairs.length,
          status: `Evaluated ${pairs.length} / ${evaluation.seeds.length} paired seeds` };
        this._ffaPublishDashboard();
      }
      this.agentEvaluation = { ...this.seasons.evaluateAgentCandidate(evaluation, pairs),
        status: 'Complete. Better average placement promotes the preset next round; ties retain the incumbent.' };
    } catch (error) {
      this._ffaNotify('OnFfaError', `Agent evaluation failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._ffaPublishDashboard();
    }
  }

  /** The page's buttons click through the arena's audio bus. */
  uiClick() {
    this.audio?.uiClick?.();
  }

  _ffaDispose() {
    this.facts?.dispose();
    this.facts = null;
  }
}

/** Character name for an FFA roster id (Bob included). */
export function ffaName(id) {
  return CHARACTERS[id]?.name ?? id;
}

export const FfaMode = FfaModeMethods.prototype;
