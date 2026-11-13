// fighterTick.js — one fighter's turn in the sim: what the AI is told about the
// fight (_aiContext), the per-fighter state machine (_tickFighter: movement,
// energy, idle / charge / block / swing / hitstun / down / getup), and the two
// transitions into a strike (_enterCharge, _enterAttack).
//
// Mixed into BrawlGame's prototype like the other subsystems (see mixin.js), so
// `this` is the live game. The rules it applies are pure and live beside it:
// energy.js (the bar), knockdown.js (the canvas), combat.js (region damage and
// which hand throws). game.js keeps the match loop that calls into here.

import * as THREE from 'three';
import { RING_HALF } from './arena.js';
import { AiController } from './ai.js';
import { regionEffect, pickPunchArm } from './combat.js';
import { PERSONALITIES } from './personalities.js';
import { MAX_HP, ATTACKS, TIME_LIMIT, HITSTUN } from './constants.js';
import { tickEnergy, drainCharge, paySwing, canAttack, chargeMultiplier } from './energy.js';
import { KNOCKDOWN, decayDaze, shouldRise, getUpChoice, isFloored } from './knockdown.js';

// Lateral orbit speed for the circle keys, in the same units as the 2.4 / 1.9
// forward / backward walk. Slightly under the advance so that closing distance
// is still the faster way to cross the ring and circling reads as positioning
// rather than a second, better run.
const CIRCLE_SPEED = 2.0;

class FighterTickMethods {
  _aiContext(f, opp, dt) {
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const oppAttack = (opp.state === 'punch' || opp.state === 'kick') ? opp.attack : null;
    // A charging opponent reads as windup — the coil is the tell to block.
    const oppInWindup = opp.state === 'charge'
      || (!!oppAttack && opp.stateT < oppAttack.windup);
    const oppInActive = !!oppAttack && opp.stateT >= oppAttack.windup
      && opp.stateT <= oppAttack.windup + oppAttack.active;
    const oppInRecover = !!oppAttack && opp.stateT > oppAttack.windup + oppAttack.active;
    // Seconds until the opponent's live swing stops being able to hurt us, with
    // the per-swing timing muls _tryHit uses (Eisenhower stretches his wind-up).
    const oppSwingLeft = oppAttack
      ? Math.max(0, oppAttack.windup * (opp.swingWindupMul ?? 1)
        + oppAttack.active * (opp.swingActiveMul ?? 1) - opp.stateT)
      : 0;
    // ── Ring sense ────────────────────────────────────────────────────
    // Metres of canvas ahead of us along a direction before the ring clamp.
    // Without it every retreat and every gassed back-off walked the CPU
    // straight into the ropes; with it the AI can tell "give ground" from
    // "slide out sideways". `side` +1 follows _circleAxis (see _tickFighter).
    const pos = f.rig.root.position;
    const room = (dx, dz) => {
      let t = Infinity;
      if (dx > 1e-4) t = Math.min(t, (RING_HALF - pos.x) / dx);
      else if (dx < -1e-4) t = Math.min(t, (-RING_HALF - pos.x) / dx);
      if (dz > 1e-4) t = Math.min(t, (RING_HALF - pos.z) / dz);
      else if (dz < -1e-4) t = Math.min(t, (-RING_HALF - pos.z) / dz);
      return Math.max(0, t === Infinity ? RING_HALF * 2 : t);
    };
    const tx = opp.rig.root.position.x - pos.x;
    const tz = opp.rig.root.position.z - pos.z;
    const tl = Math.hypot(tx, tz) || 1;
    const ux = tx / tl, uz = tz / tl;
    return {
      dt,
      distance: dist,
      // Ring and scoreboard, for the AI's footwork and risk (ai.js). Rooms are
      // metres to the ropes going backward / circling +side / circling −side.
      backRoom: room(-ux, -uz),
      sideRoomPos: room(-uz, ux),
      sideRoomNeg: room(uz, -ux),
      ropeDist: RING_HALF - Math.max(Math.abs(pos.x), Math.abs(pos.z)),
      selfHp: this._hp(f) / MAX_HP,
      opponentHp: this._hp(opp) / MAX_HP,
      clock: this.clock || 0,
      timeLimit: this.training ? Infinity : TIME_LIMIT,
      // Frame data the guard and the punish need: how long the opponent's
      // swing can still hurt, whether they are coiling (and for how long), and
      // how long a blocked or stunned opponent stays unable to answer.
      opponentSwingLeft: oppSwingLeft,
      opponentCharging: opp.state === 'charge',
      opponentChargeT: opp.state === 'charge' ? opp.stateT : 0,
      opponentBlockStun: opp.blockStunT || 0,
      opponentHitstunLeft: opp.state === 'hitstun'
        ? Math.max(0, HITSTUN + (opp.hitstunBonus || 0) - opp.stateT) : 0,
      selfState: f.state,
      // The canvas (knockdown.js). A floored opponent cannot be hit; `opponentRiseIn`
      // is how long until they are standing if they rise as early as they can —
      // the number a strike timed on the get-up is aimed at. `selfDownT` is how
      // long we have been lying there ourselves, for the AI's own get-up timing.
      opponentFloored: isFloored(opp.state),
      opponentRiseIn: opp.state === 'getup' ? Math.max(0, (opp.getupTime || KNOCKDOWN.getup) - opp.stateT)
        : opp.state === 'down' ? Math.max(0, KNOCKDOWN.downMin - opp.stateT) + KNOCKDOWN.getup
        : 0,
      selfDownT: f.state === 'down' ? f.stateT : 0,
      // How full our own coil is (0..1): ai.js lets go at its rung's maxCharge.
      selfCharge: f.state === 'charge' ? f.chargeAmt : 0,
      // The super fires only from idle (the 'idle' case of _tickFighter), so
      // the AI asks only when it will actually go off — a request from the
      // guard was dropped on the floor while ai.js still spent its cooldown.
      canSuper: f.state === 'idle' && !(f.blockStunT > 0)
        && (f.personality?.superMeter || 0) >= 1.0 && !!PERSONALITIES[f.charId]?.onSuper,
      // Sign of (opponent.x − self.x): +1 when the opponent is to our right,
      // −1 when to our left. The keyboard controller uses this to keep the
      // left/right keys screen-relative regardless of which side we're on.
      towardX: Math.sign(opp.rig.root.position.x - f.rig.root.position.x) || 1,
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppInWindup,
      opponentActive: oppInActive,
      opponentRecover: oppInRecover,
      opponentState: opp.state,
      ownAttacks: ATTACKS,
      // Super meter full? Only the AI reads this; players fire on the key.
      superMeterFull: (f.personality?.superMeter || 0) >= 1.0,
      // Energy gate. The engine enforces this regardless — a
      // gassed fighter's punch/kick intent is simply dropped in _tickFighter —
      // but the AI needs to KNOW, or it spends the whole recovery mashing
      // attack inputs into a closed gate and standing there wide open. Reading
      // it lets the CPU do what a player should do here: put the guard up and
      // earn the bar back.
      selfExhausted: !!f.gassed,
      selfEnergy: f.energy,
      // The same gate read from the other side. A gassed opponent cannot throw
      // anything until the bar recovers, and the guard is the fastest way back
      // up it — so this is the AI's cue to load a full coil (ai.js `punishGas`)
      // and ask the player whether they have learned to block yet.
      opponentExhausted: !!opp.gassed,
    };
  }

  _tickFighter(f, opp, intent, dt) {
    f.stateT += dt;

    // ── Energy regen ──────────────────────────────────────────────────
    // See energy.js: guarding refills fast, standing refills slowly, swinging refills
    // nothing, and the charge state is exempt because it is actively DRAINING
    // the pool into the strike — regenerating there would refund the wind-up.
    //
    // No hudDirty here on purpose: _pushHud already flushes every 0.25 s, so a
    // continuous change reaches the HUD four times a second without flagging a
    // push on every single frame.
    //
    // Biden's "THE BIG GUY" super is exempt for its lock window: its payload
    // is a *guaranteed* max-power strike, so neither regen nor the gassed
    // bookkeeping may touch the bar before he throws it.
    const bigGuyLocked = !!(f.personality?._bigGuyLockUntil
      && this.t < f.personality._bigGuyLockUntil);
    const effect = regionEffect(f.regionDmg);
    // Bruised ribs breathe slower: torso damage scales every regen (energy.js).
    if (tickEnergy(f, dt, { regenMul: effect.regenMul, locked: bigGuyLocked })) this.hudDirty = true;
    // Daze drains while nobody is hitting you (knockdown.js).
    if (f.daze > 0) f.daze = decayDaze(f.daze, dt);
    const pos = f.rig.root.position;
    const moveSpeed = intent.move > 0 ? 2.4 : 1.9;
    const moveAccel = f.rig.config.moveAccel * 0.5; // tune base accel

    f.speedAmt = 0;

    // ── Movement with momentum ────────────────────────────────────────
    // Compute a desired world velocity from intent, lerp `vel` toward it,
    // and integrate. Knockback is added directly and decays.
    const desired = new THREE.Vector3();
    // On the canvas or rising: no steering (a get-up roll is an impulse, see _getUp).
    const incapacitated = f.state === 'ko' || isFloored(f.state);
    // Charging roots the fighter — all the weight is loaded into the coil.
    const rooted = f.state === 'charge';
    const canSteer = !incapacitated && !rooted;

    // Unit vector toward the opponent. Hoisted out of the move branch below
    // because circling needs it too: an orbit is defined by the line between
    // the fighters, so both axes of movement derive from it.
    const toward = opp.rig.root.position.clone().sub(pos);
    toward.y = 0;
    if (toward.lengthSq() > 1e-6) toward.normalize();

    // Speed modifiers, hoisted for the same reason — a slowed or dashing
    // fighter should circle slowed or dashing too.
    // Biden "The Big Guy" slow-on-charge: halved moveMul while the slow
    // window is live. Defaults to 1.0 (no slowdown).
    // JFK "PT-109 Survivor" dash speed boost: +30% for 4 s when below 50%.
    // FDR "Four-Term Foundation" startup boost: +10% for first 3 s.
    const slow = f.slowMul || 1.0;
    let passiveMul = 1.0;
    const per = f.personality;
    if (per?.jfkDashUntil && this.t < per.jfkDashUntil) passiveMul *= 1.30;
    if (per?.fdrStartupUntil && this.t < per.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      passiveMul *= PERSONALITIES.fdr.startupBoost.speedMul || 1.10;
    }

    if (intent.move !== 0 && canSteer) {
      desired.add(toward.clone().multiplyScalar(
        intent.move * moveSpeed * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.min(1, Math.abs(intent.move));
    }

    // ── Circling (camera depth) ───────────────────────────────────────
    // `intent.side` is a HELD direction along the CAMERA's forward axis
    // (W/↑ = +1, into the screen; S/↓ = −1, out toward the viewer). Because the
    // fighters stand side-on to the camera, walking that axis carries you
    // around your opponent. Screen-relative, deliberately: an axis derived
    // from the fighters' line flips on screen whenever they swap sides.
    // It feeds `desired` (the same lerped velocity `move` uses), not an
    // impulse — a held impulse accumulates against its own decay.
    // The CPU has no screen: it circles on the axis perpendicular to the line
    // between the fighters (_circleAxis). On the camera axis its orbit turned
    // with every director cut, and near-parallel shots made it a lunge or a
    // retreat; its ring sense (_aiContext sideRoom*) is measured on this axis.
    if (intent.side !== 0 && canSteer) {
      const camFwd = f.controller instanceof AiController
        ? this._circleAxis(toward) : this._cameraForward();
      desired.add(camFwd.multiplyScalar(
        intent.side * CIRCLE_SPEED * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.max(f.speedAmt, Math.min(1, Math.abs(intent.side)));
    }
    // Move slowly even in hitstun/attack windup — the player is "shuffling".
    if (f.state === 'hitstun') desired.multiplyScalar(0.2);

    // Lerp velocity toward desired — mass-scaled accel; heavier fighters feel weightier.
    const a = moveAccel * (1 / f.rig.config.mass);
    const k = 1 - Math.exp(-dt * a);
    f.vel.lerp(desired, k);

    // Knockback impulse decays.
    f.knockback.multiplyScalar(Math.max(0, 1 - dt * 8));

    // Integrate position.
    pos.x += (f.vel.x + f.knockback.x) * dt;
    pos.z += (f.vel.z + f.knockback.z) * dt;

    // ── State machine ────────────────────────────────────────────────
    switch (f.state) {
      case 'idle': {
        // Energy regenerates slowly here and fast in the 'block' case; the
        // wind-up spends it and every release costs a flat toll on top. The
        // regen itself is applied once, above the state machine.
        // A punch needs the striking (right) arm — a fighter that lost it can
        // only kick. Kick input still works with no arms.
        // The energy gate sits ahead of both: a gassed fighter throws nothing.
        const hasEnergy = this._canAttack(f);
        const canPunch = intent.punch && hasEnergy && this._canPunch(f);
        if (canPunch || (intent.kick && hasEnergy)) {
          const name = canPunch ? 'punch' : 'kick';
          this._enterCharge(f, name);
          break;
        }
        // Signature super activation: only from idle so the pose read is clean
        // ("He lines up. He fires."). No-op if the meter isn't full or this
        // fighter has no onSuper config. A HUMAN fighter has no super key and
        // fires the instant the meter fills; the AI keeps its own gate (ai.js:
        // rung-scaled chance plus a cooldown) because that pacing is a
        // DIFFICULTY knob.
        if (intent.super || this._autoSuperReady(f)) this._fireSuper(f);
        if (intent.block) {
          f.state = 'block';
          // Stamp the moment the guard went up — this is what separates a read
          // from a camp when a strike lands on it. See PERFECT_GUARD_WINDOW.
          f.guardAt = this.t;
          f.animator.setBlocking(true);
        }
        break;
      }
      case 'charge': {
        // Winding up: charge accrues while the button is held (capped at
        // CHARGE_TIME; you can hold at max forever). Release throws the
        // attack scaled by the stored charge.
        const held = f.chargeName === 'punch' ? intent.punchHeld : intent.kickHeld;
        // Holding POURS the pool into the strike: the bar
        // drains at the same rate the coil loads, so a fighter watching their
        // own energy bar can see exactly what the swing is costing them, and a
        // full-power release is only available to someone who banked a full
        // bar by guarding for it. The drain is clamped to what is actually left,
        // so the coil simply stops growing on an empty bar rather than loading
        // power that was never paid for.
        // Biden's "THE BIG GUY" coil arrives pre-loaded (_enterCharge) and paid
        // for, so it pours nothing more out of the bar.
        drainCharge(f, dt, bigGuyLocked);
        f.animator.setCharge(f.chargeName, f.chargeAmt);
        // The coil in the hand: a pulse train that rises with it (haptics.js).
        this.haptics?.charge(f, f.chargeAmt);
        // Full-charge cue: one audible snap when the coil tops out.
        if (f.chargeAmt >= 1 && !f.chargeCued) {
          f.chargeCued = true;
          this.audio.whoosh();
        }
        // Spark motes at the loaded fist/foot once the charge means something.
        f.chargeSparkT -= dt;
        if (f.chargeAmt > 0.25 && f.chargeSparkT <= 0) {
          f.chargeSparkT = 0.16 - 0.08 * f.chargeAmt;
          const anchor = f.rig.joints[f.chargeName === 'punch' ? 'fistR' : 'footR'];
          if (anchor) {
            const p = new THREE.Vector3();
            anchor.getWorldPosition(p);
            this._spawnSparks(p, 0xffd257, 2, 0.4 + 0.5 * f.chargeAmt);
          }
        }
        if (!held) {
          const amt = f.chargeAmt;
          f.animator.setCharge(null, 0);
          this._enterAttack(f, f.chargeName, amt);
        }
        break;
      }
      case 'block': {
        if (!intent.block) {
          f.state = 'idle';
          f.animator.setBlocking(false);
        }
        break;
      }
      case 'punch':
      case 'kick': {
        const a = ATTACKS[f.state];
        const inActive = f.stateT >= a.windup && f.stateT <= a.windup + a.active;
        // Queued for the end of the tick when _tickFighting is collecting
        // (see _pendingHits there), so a same-frame trade is fair to both.
        if (inActive && !f.hasHit) {
          if (this._pendingHits) this._pendingHits.push([f, opp, a]);
          else this._tryHit(f, opp, a);
        }

        // Cancel windows: if the player input another action and we're past the
        // configured stateT threshold for that target, transition immediately.
        // Attack cancels re-enter the charge state so a held follow-up charges too.
        if (intent.punch && this._canAttack(f) && this._canPunch(f) && f.stateT >= a.cancelInto.punch) this._enterCharge(f, 'punch');
        else if (intent.kick && this._canAttack(f) && f.stateT >= a.cancelInto.kick) this._enterCharge(f, 'kick');
        else if (intent.block && f.stateT >= a.cancelInto.block) {
          f.state = 'block'; f.stateT = 0; f.guardAt = this.t;
          f.animator.setBlocking(true);
        } else if (f.stateT >= a.windup + a.active + a.recover) {
          f.state = 'idle'; f.stateT = 0; f.attack = null;
        }
        break;
      }
      case 'hitstun': {
        // hitstunBonus: a rattled head stuns longer (hitResolution.js _landHit).
        if (f.stateT >= HITSTUN + (f.hitstunBonus || 0)) f.state = 'idle';
        break;
      }
      case 'down': {
        // Online the sim decides when and how a fighter rises (netplay.js follows it).
        if (this.online) break;
        // Lying there is safe; getting up is the decision. Any input after
        // DOWN_MIN starts the rise, and what is held picks how (knockdown.js).
        const wants = intent.move !== 0 || intent.side !== 0
          || intent.punch || intent.kick || intent.block;
        if (shouldRise(f.stateT, wants)) this._getUp(f, opp, intent);
        break;
      }
      case 'getup': {
        if (this.online) break;
        // A strike pressed on the way up is remembered for the moment the feet land.
        if (intent.punch) f.wakeStrike = 'punch';
        else if (intent.kick) f.wakeStrike = 'kick';
        if (f.stateT < f.getupTime) break;
        f.state = 'idle';
        f.stateT = 0;
        f.daze = 0;
        f.dazeImmuneUntil = this.t + KNOCKDOWN.immunity;
        const strike = f.wakeStrike;
        f.wakeStrike = null;
        if (intent.block) {
          // Rising INTO the guard stamps it now, so a strike timed to meet the
          // rise lands inside the perfect-guard window: the answer to a meaty.
          f.state = 'block';
          f.guardAt = this.t;
          f.animator.setBlocking(true);
        } else if (strike && this._canAttack(f) && (strike === 'kick' || this._canPunch(f))) {
          this._enterCharge(f, strike);
        }
        break;
      }
    }
  }

  // Start winding an attack up. The fighter is rooted until the button is
  // released (see the 'charge' case in _tickFighter), then _enterAttack
  // throws the strike scaled by the stored charge.
  _enterCharge(f, name) {
    this.haptics?.chargeEnd(f);
    f.state = 'charge';
    f.stateT = 0;
    f.chargeName = name;
    // Coil starts EMPTY and is filled out of the energy bar while the button is
    // held (see the 'charge' case) — except inside Biden's "THE BIG GUY" lock,
    // whose whole payload is a guaranteed full-power strike: resetting it here
    // threw that charge away on the very swing the super armed.
    const bigGuy = f.personality?._bigGuyLockUntil && this.t < f.personality._bigGuyLockUntil;
    f.chargeAmt = bigGuy ? 1 : 0;
    f.chargeCued = false;
    f.chargeSparkT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(name, f.chargeAmt);
    this._show('chargeStart', { f, name });
  }

  _enterAttack(f, name, chargeAmt = 0) {
    // A punch needs the striking (right) arm; if it was torn off mid-charge,
    // drop back to idle rather than swinging a missing limb.
    if (name === 'punch' && !this._canPunch(f)) {
      f.state = 'idle';
      f.stateT = 0;
      f.chargeName = null;
      f.animator.setCharge(null, 0);
      return;
    }
    f.state = name;
    f.stateT = 0;
    f.hasHit = false;
    f.attack = ATTACKS[name];
    f.chargeName = null;
    f.chargeMul = chargeMultiplier(chargeAmt);
    // Which hand (combat.js pickPunchArm): taps go left-right-left, a coil is the
    // right. `strike` names the hitbox set and the animation track for the swing.
    // Online the sim picks the hand and prices it (rollbackSim.js); netplay.js hands it in.
    f.strike = name;
    f.armMul = 1;
    if (name === 'punch' && this.online) {
      if (f.netArm === 'L' && !f.armsLost?.has('L')) f.strike = 'punchL';
    } else if (name === 'punch') {
      const pickArm = pickPunchArm({
        armsLost: f.armsLost, chargeAmt,
        lastArm: f.lastPunchArm, sinceLast: this.t - (f.lastPunchT ?? -99),
      });
      if (pickArm) {
        f.strike = pickArm.arm === 'L' ? 'punchL' : 'punch';
        f.armMul = pickArm.dmgMul;
        f.lastPunchArm = pickArm.arm;
        f.lastPunchT = this.t;
      }
    }
    this._show('release', { f, name, chargeAmt });
    // Per-swing timing multipliers (Eisenhower "Operation Overlord": 1.5×
    // windup, 0.5× active; cleared at swing completion). Read by _tryHit
    // for the phase boundary check.
    f.swingWindupMul = 1.0;
    f.swingActiveMul = 1.0;
    if (f.personality?.id === 'eisenhower' && PERSONALITIES.eisenhower?.onSwingP) {
      f.swingWindupMul = PERSONALITIES.eisenhower.onSwingP.overWindupMul || 1.0;
      f.swingActiveMul = PERSONALITIES.eisenhower.onSwingP.overActiveMul || 1.0;
    }
    // The flat swing toll. The wind-up has already drained
    // whatever charge this strike carries; this is the additional per-swing cost
    // that makes tap-spam unsustainable, since a jab banks almost no charge but
    // still pays the toll. Scaled by the attack's own energyMul — a punch pays
    // half a kick's, which is what makes it the tempo move. Blocking and
    // standing are what refill the bar — see energy.js and the regen
    // in _tickFighter.
    paySwing(f, f.attack.energyMul ?? 1);
    this.hudDirty = true;
    f.animator.play(f.strike);

    // ── On-swing personality flags (consumed at hit landing) ─────────
    // Trump "THE WALL" haymaker: 18% of swings commit to a heavy right with
    // 1.5× damage and 1.3× knockback. We tag the swing here; the hit handler
    // multiplies base damage by the mul and clears the flag.
    const per = f.personality;
    if (per?.id === 'trump' && PERSONALITIES.trump?.onSwingP
        && !per._haymakerSuppressedThisSwing
        && this.rng.random() < PERSONALITIES.trump.onSwingP.haymakerChance) {
      f._trumpHaymaker = true;
    }
    // Nixon "Tricky Dick": 25% of swings carry a dirty tag — when the hit
    // is blocked, ~40% of the time the block lets the damage slip through.
    // SUPER override: when "I Am Not a Crook" is active, ALL swings in the
    // remaining counter carry the dirty tag (decays per swing via the
    // superDirtySwingsLeft counter).
    const nixonDirtyChance = per?.id === 'nixon'
      ? (per.superDirtySwingsLeft > 0
          ? 1.0
          : PERSONALITIES.nixon.onSwingP.dirtyChance)
      : 0;
    if (per?.id === 'nixon' && PERSONALITIES.nixon?.onSwingP
        && !f._dirtySwing
        && this.rng.random() < nixonDirtyChance) {
      f._dirtySwing = true;
      if (per.superDirtySwingsLeft > 0) {
        per.superDirtySwingsLeft = Math.max(0, per.superDirtySwingsLeft - 1);
      }
    }
    // Bush Sr. "VOODOO ECONOMICS": next 3 swings after a super each carry
    // 1.4× damage on top of whatever else is going on. The flag flips off
    // one swing at a time.
    if (per?.id === 'bushsr' && per.superPumpSwingsLeft > 0) {
      f._bushsrSuperPump = true;
      per.superPumpSwingsLeft = Math.max(0, per.superPumpSwingsLeft - 1);
    }
    // Ford "Ford Stumble": 15% of swings self-stun for 0.6 s — abort the
    // committed swing mid-air and route the fighter to 'idle' briefly.
    if (per?.id === 'ford' && PERSONALITIES.ford?.onSwingP) {
      const cfg = PERSONALITIES.ford.onSwingP;
      if (this.rng.random() < cfg.stumbleChance) {
        per.stumbleUntil = this.t + cfg.stumbleSelfStunSecs;
        f.state = 'idle';
        f.stateT = 0;
        f.attack = null;
        f.animator.play('stumble');
        return;
      }
    }
    // Trail color: cool steel normally, hot gold on a well-charged release, so
    // gold reads as earned bonus power rather than lighting up every tap.
    if (f.trail) f.trail.color.setHex(chargeAmt > 0.65 ? 0xffd257 : 0xcfe0ff);
    this.audio.whoosh();
    if (name === 'kick' || chargeAmt > 0.65) this.audio.effort(f.charId, chargeAmt);
    // Attack lunge: a real step into the strike, scaled by charge. This is
    // where the "reach" lives, since the hitboxes track the actual limb.
    const opp = this.fighters.find((o) => o !== f);
    if (opp) {
      const dir = new THREE.Vector3().subVectors(opp.rig.root.position, f.rig.root.position);
      dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        // FDR "Fireside Chat" reach bonus: his next swing's lunge is scaled
        // by the per-fighter fdrNextSwingReachMul (set during a chat iframe).
        // (Was `(x && x > 1) || 1`, which yields `true`, i.e. 1 — never the bonus.)
        const reachMul = Math.max(1.0, f.personality?.fdrNextSwingReachMul || 1.0);
        if (reachMul > 1.0) f.personality.fdrNextSwingReachMul = 1.0; // consumed
        const lunge = (name === 'kick' ? 2.2 : 1.8) * (1 + 1.4 * chargeAmt) * reachMul;
        f.knockback.add(dir.multiplyScalar(lunge));
      }
    }
  }

  // The CPU's circling axis: the line between the fighters turned 90° (left of
  // `toward`, a unit XZ vector). +1 on `intent.side` follows it.
  _circleAxis(toward) {
    return new THREE.Vector3(-toward.z, 0, toward.x);
  }

  // The camera's forward direction, flattened to the ground plane: the axis the
  // circle keys walk along. +1 on `intent.side` follows this vector (into the
  // screen, away from the viewer); −1 walks back against it, toward the viewer.
  // The fallback covers the first frames before the camera is aimed; a zero
  // vector would drop the input silently.
  _cameraForward() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }

  // Should this fighter's signature super fire on its own this frame? True
  // only for HUMAN-driven fighters with a full meter (there is no super key).
  // AI fighters fire through `intent.super`, keeping ai.js's rung-scaled
  // pacing. `_fireSuper` no-ops without an onSuper config (BOB has none).
  _autoSuperReady(f) {
    return f?.controller?.isHuman === true
      && (f.personality?.superMeter || 0) >= 1.0;
  }

  // Can this fighter still throw a punch? Either hand will do (combat.js
  // pickPunchArm): the left tears off first (see _severArm), which leaves the
  // right; once that is gone too the fighter can only kick.
  _canPunch(f) {
    return !f.armsLost || f.armsLost.size < 2;
  }

  /**
   * The energy gate. False means this fighter may not START a
   * punch or kick — not a weaker one, none at all — because they have gassed
   * themselves out. Blocking and movement are deliberately still allowed: the
   * guard is the way back up the bar, so the punishment is "you must defend
   * now", not "you are a statue".
   *
   * Checked on the three routes a fighter takes into a normal attack: the idle
   * branch and the two mid-swing cancel-into-punch/kick windows.
   *
   * Deliberately NOT checked in _enterAttack. Supers go straight there, and a
   * signature move is a rare earned payoff that should never be swallowed by
   * the stamina economy — Biden's "THE BIG GUY" in particular sets energy to
   * 1.0 and swings on the same frame, before the gassed flag has been
   * recomputed, so a flag check there would eat exactly the strike the super
   * exists to guarantee.
   */
  _canAttack(f) {
    return canAttack(f);
  }

  // ── The canvas ────────────────────────────────────────────────────────────
  // Rules and numbers are knockdown.js; these two apply them to a live fighter.

  /**
   * Put `f` on the canvas. Called by hitResolution.js when a landed, non-lethal
   * hit fills the daze pool. The fighter cannot be hit until they are back up.
   */
  _knockDown(f, attacker, knockDir) {
    this.haptics?.chargeEnd(f);
    f.state = 'down';
    f.stateT = 0;
    f.daze = 0;
    f.attack = null;
    f.chargeName = null;
    f.chargeAmt = 0;
    f.wakeStrike = null;
    f.blockStunT = 0;
    f.getupTime = KNOCKDOWN.getup + regionEffect(f.regionDmg).getupPenalty;
    f.animator.setCharge(null, 0);
    f.animator.setBlocking(false);
    f.animator.setDown(true);
    // Carried off their feet: a slide along the blow before the canvas takes them.
    const massRatio = (attacker?.rig.config.mass || 1) / (f.rig.config.mass || 1);
    f.knockback.add(knockDir.clone().multiplyScalar(KNOCKDOWN.slide * massRatio));
    if (attacker) attacker.stats.knockdowns = (attacker.stats.knockdowns || 0) + 1;
    f.controller.notifyKnockdown?.();
    const p = f.rig.root.position;
    this._spawnCallout(new THREE.Vector3(p.x, 1.5, p.z), 'KNOCKDOWN!');
    this._commentate('knockdown', attacker || f, f);
    this._jumboCaption('DOWN!', 1.4);
    this._ringRipple(p.x, p.z, 0.8);
    this.audio.impact({ power: 1.6, worldPos: p, kind: 'kick' });
    this.audio.crowdSwell(0.7);
    this.excited = Math.max(this.excited, 0.85);
    this._pressBurst(5);
    this._rumble(f, 1, 0.6, 320);
    this._show('knockdown', { f, attacker });
    this.hudDirty = true;
  }

  /** Start to rise, the way the intent asks (knockdown.js getUpChoice). */
  _getUp(f, opp, intent) {
    const choice = getUpChoice(intent);
    f.state = 'getup';
    f.stateT = 0;
    f.wakeStrike = choice.strike;
    f.animator.setDown(false);
    if (choice.roll) {
      // Same axes as walking: toward / away along the line between the fighters,
      // sideways on the camera's depth axis for a human and the orbit axis for the CPU.
      const toward = opp.rig.root.position.clone().sub(f.rig.root.position);
      toward.y = 0;
      if (toward.lengthSq() > 1e-6) toward.normalize(); else toward.set(1, 0, 0);
      const sideAxis = f.controller instanceof AiController
        ? this._circleAxis(toward) : this._cameraForward();
      const dir = toward.multiplyScalar(choice.roll.move).add(sideAxis.multiplyScalar(choice.roll.side));
      if (dir.lengthSq() > 1e-6) f.knockback.add(dir.normalize().multiplyScalar(KNOCKDOWN.rollImpulse));
    }
  }
}

export const FighterTick = FighterTickMethods.prototype;
