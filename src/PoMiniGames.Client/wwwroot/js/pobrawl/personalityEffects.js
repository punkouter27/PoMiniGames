// personalityEffects.js — per-president behaviour: the personality tick, the
// super meter, the super cinematic and its effects, and the on-hit quirks.
// Mixed into BrawlGame's prototype, so `this` is the live game (see mixin.js).

import * as THREE from 'three-eco/webgpu';
import { PERSONALITIES } from './personalities.js';
import { MAX_HP, ATTACKS } from './constants.js';
import { guardCovers } from './hitboxes.js';
import * as Quality from './quality.js';

// Super ink (see _startSuperInk): seconds in / held / out, full and calm (reduced motion).
const INK_FULL = { in: 0.18, hold: 0.5, out: 0.32, peak: 1 };
const INK_CALM = { in: 0.25, hold: 0.18, out: 0.3, peak: 0.45 };
const INK_CUT_KO = 0.07;       // a KO takes the page away at once: the fall must be seen
const INK_CUT = 0.2;           // an interrupted shift (a KO, a reset) still fades, never snaps
const _inkProj = new THREE.Vector3();
const _black = new THREE.Color(0x000000);
const _paper = new THREE.Color(0xfff4dc);

class PersonalityEffectsMethods {
  // Per fighter tick: trigger-once HP thresholds, timed modes, and expiry.
  _tickPersonalities(f, dt) {
    if (!f.personality) return;
    const per = f.personality;
    const hpFrac = f.hpCur / MAX_HP;
    const now = this.t;

    // FDR "Four-Term Foundation": armed once on the first tick.
    if (f.charId === 'fdr' && PERSONALITIES.fdr?.startupBoost
        && !per._fdrStartupArmed) {
      per._fdrStartupArmed = true;
      per.fdrStartupUntil = now + (PERSONALITIES.fdr.startupBoost.durationSecs || 3.0);
      per.activeMode = 'fourTerm';
    }

    if (per.activeMode && per.modeExpiresAt && now >= per.modeExpiresAt) {
      per.activeMode = null;
      per.modeExpiresAt = 0;
    }

    const prof = per.profile;
    if (!per.triggerFired) {
      if (prof?.triggerOnce && prof.checkHpBelow != null && hpFrac <= prof.checkHpBelow) {
        per.triggerFired = true;
        if (prof.onTrigger === 'decider') {
          per.activeMode = 'decider';
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 30);
          // The freeze: pause his controller.
          if (f.controller && f.controller.__proto__?.constructor?.name === 'AiController') {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          } else if (f.controller) {
            f.controller.__freezeUntil = now + (prof.onTriggerParams?.freezeSecs || 1.5);
          }
          f.animator.play('salute'); // visual cue — decider "stops to think"
        } else if (prof.onTrigger === 'morningInAmerica') {
          per.activeMode = 'morningInAmerica';
          per.modeExpiresAt = now + (prof.onTriggerParams?.durationSecs || 6);
        } else if (prof.onTrigger === 'malaiseSpeech') {
          per.iframesUntil = now + (prof.onTriggerParams?.iframesSecs || 1.5);
          per.activeMode = 'malaiseSpeech';
          per.modeExpiresAt = now + (prof.onTriggerParams?.iframesSecs || 1.5);
        }
      }
    }

    if (per.slowUntil && now >= per.slowUntil) {
      per.slowUntil = 0;
      f.slowMul = 1.0;
    }

    if (per.fdrStartupUntil) {
      if (now >= per.fdrStartupUntil) {
        per.fdrStartupUntil = 0;
        per.activeMode = null;
      } else if (!per.activeMode) {
        per.activeMode = 'fourTerm';
      }
    }
    if (per.jfkDashUntil && now >= per.jfkDashUntil) per.jfkDashUntil = 0;

    if (per.eisenhowerIframesUntil && now >= per.eisenhowerIframesUntil) {
      per.eisenhowerIframesUntil = 0;
    }
    if (per.jfkProfileIframesUntil && now >= per.jfkProfileIframesUntil) {
      per.jfkProfileIframesUntil = 0;
    }
    if (per.fdrIframesUntil && now >= per.fdrIframesUntil) {
      per.fdrIframesUntil = 0;
    }
    // FDR "Fireside Chat" periodic iframes schedule.
    if (PERSONALITIES.fdr?.periodicIframes && !per.fdrIframesUntil
        && per.fdrPeriodicReady === undefined) {
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6) - 1.5;
    }
    if (per.fdrPeriodicReady !== undefined && now >= per.fdrPeriodicReady
        && PERSONALITIES.fdr?.periodicIframes && f.charId === 'fdr') {
      per.fdrIframesUntil = now + (PERSONALITIES.fdr.periodicIframes.iframesSecs || 0.4);
      per.fdrNextSwingReachMul = PERSONALITIES.fdr.periodicIframes.nextSwingReachMul || 1.25;
      per.fdrPeriodicReady = now + (PERSONALITIES.fdr.periodicIframes.everySecs || 6);
    }

    // Truman stack decay (linear, decayPerSec).
    if (PERSONALITIES.truman?.stacksOnHit && per.trumanBuckStacks > 0) {
      const cur = per.trumanBuckStacks;
      per.trumanBuckStacks = Math.max(0,
        cur - (PERSONALITIES.truman.stacksOnHit.decayPerSec || 0.5) * dt);
    }

    // HP-gated modes (PT-109 / Atoms for Peace / Day of Infamy).
    if (prof?.triggerHpGated && !per._hpTriggeredByKey) per._hpTriggeredByKey = {};
    if (prof?.triggerHpGated) {
      const tg = prof.triggerHpGated;
      const opp = this.fighters.find((o) => o !== f);
      const oppHp = opp?.hpCur ?? 100;
      const myHpFrac = f.hpCur / MAX_HP;
      if (!per._hpTriggeredByKey[tg.modeName]) {
        let fire = false;
        if (tg.checkHpBelow != null && myHpFrac <= tg.checkHpBelow) fire = true;
        if (tg.checkHpAboveOpp != null
            && (myHpFrac - oppHp / MAX_HP) >= tg.checkHpAboveOpp) fire = true;
        if (fire) {
          per._hpTriggeredByKey[tg.modeName] = true;
          if (tg.modeName === 'pt109Dash') {
            per.jfkDashUntil = now + (tg.durationSecs || 4.0);
            per.jfkDashCooldownUntil = now + (tg.cooldownSecs || 6.0);
          } else if (tg.modeName === 'atomsForPeace') {
            per.eisenhowerIframesUntil = now + (tg.iframesSecs || 1.0);
            per.eisenhowerNextSwingAtkMul = tg.nextSwingAtkMul || 1.20;
          } else if (tg.modeName === 'dayOfInfamy') {
            per.activeMode = tg.modeName;
            per.modeExpiresAt = now + (tg.durationSecs || 5.0);
          }
        }
      }
    }
    // Time-gated single fire at triggerT seconds (JFK "Profiles in Courage").
    if (prof?.triggerT !== undefined && !per._timeTriggered
        && this.t >= prof.triggerT) {
      per._timeTriggered = true;
      if (prof.onTrigger === 'profilesInCourage') {
        const params = prof.onTriggerParams || {};
        per.jfkProfileIframesUntil = now + (params.iframesSecs || 0.45);
        per.jfkNextSwingAtkMul = params.nextSwingAtkMul || 1.25;
      }
    }
  }

  // ── SUPER METER ────────────────────────────────────────────────────────
  // 0..1 per fighter, filled only by TAKING damage (a comeback mechanic). At
  // 1.0 it fires automatically for a human (game.js `_autoSuperReady`) and via
  // `intent.super` for the AI. It never ticks down; firing consumes it.
  _tickSuperMeter(f, opp, dt) {
    const per = f.personality;
    if (!per) return;
    if (per.superMeter > 1.0) per.superMeter = 1.0;
    // No onSuper config (e.g. BOB) must never accumulate a meter, or it would
    // auto-fire an undefined super.
    if (!PERSONALITIES[f.charId]?.onSuper) per.superMeter = 0;
  }

  // No-op unless the meter is full.
  _fireSuper(f) {
    const per = f.personality;
    const cfg = PERSONALITIES[f.charId]?.onSuper;
    if (!per || !cfg || per.superMeter < 1.0) return;
    per.superMeter = 0;
    this._show('super', { f });
    per.superActiveMode = cfg.mode;
    per.superFiredAt = this.t;
    this._applySuperEffect(f, cfg);
    // One-frame kick that opens the cinematic.
    this.exposurePulse = Math.max(this.exposurePulse || 0, 0.55);
    this.hitstopT = Math.max(this.hitstopT || 0, 0.18);
    if (this.flash) {
      this.flash.style.transition = 'opacity 0.05s linear';
      this.flash.style.background = 'rgba(255, 240, 200, 0.55)';
      this.flash.style.opacity = '1';
      setTimeout(() => {
        if (this.flash) {
          this.flash.style.transition = 'opacity 0.45s ease-out';
          this.flash.style.opacity = '0';
        }
      }, 60);
    }
    this._startSuperCinematic(f);
  }

  // ══ Signature-super cinematic ════════════════════════════════════════
  // A ~1.3 s beat on wall-clock rather than sim time, so its own time dilation
  // cannot slow its timeline.
  //
  //   TIME     the sim drops to ~0.22× and eases back to 1×
  //   CAMERA   cuts to a low hero angle on the firing fighter and pushes in
  //   EDGE     the ink line spikes to the character's accent colour
  //   SMEAR    the afterimage pass is held on for the whole beat
  //   LINES    speedlines are re-armed every frame so they stay up
  //   INK      for ~1 s the world prints as a two-tone comic page (_startSuperInk)
  //   SOUND    a dedicated stinger, and the PA calls the move
  _startSuperCinematic(f) {
    this._startSuperInk(f);
    this._superDur = 1.3;
    this._superT = this._superDur;
    this._superFighter = f;
    // Super escalation from normal always lands; super→super on a re-fire
    // (same priority) is also allowed, which re-seeds the orbit.
    this._setCameraMode('super');
    this.cameraModeT = 0;
    // Re-seed the orbit from where the boom is now, not the previous super's arc.
    this._superAngle = undefined;
    this._camVel.set(0, 0, 0);
    const rp = f.rig.root.position;
    this._shockwave(new THREE.Vector3(rp.x, rp.y + 1.2, rp.z), 0.9);
    this._pressBurst(5);
    this.audio?.superStinger();
    this._caption(`${f.rig.config.name}! ${this._superMoveName(f)}!`);
    const accent = f.rig.baseColors?.tie || f.rig.baseColors?.suit;
    for (const u of f.inkUniforms || []) {
      if (accent) u.uInkColor.value.copy(accent).lerp(new THREE.Color(0xffffff), 0.35);
    }
  }

  // Spoken move name derived from `mode` ('droneStrike' → "Drone Strike") so the
  // announcer can't drift from the mechanic; an explicit `label` wins.
  _superMoveName(f) {
    const cfg = PERSONALITIES[f.charId]?.onSuper;
    if (!cfg) return 'Super';
    if (cfg.label) return cfg.label;
    return String(cfg.mode || 'super')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (ch) => ch.toUpperCase())
      .trim();
  }

  // ── Super ink: the comic-page world shift ────────────────────────────
  // While the super fires, the post pass (postShader.js uSuperInk) blends in a comic print:
  // halftone dots, paper grain, thick ink edges, radial speed lines out of the firing fighter,
  // and a two-tone palette from that president's suit (the shadow plate) and tie (the highlight
  // plate). Presentation only — wall clock, no RNG, no sim state.
  //
  // Flicker rule (spectacle.js): the shader keeps each pixel's brightness, and the blend eases in
  // over INK_FULL.in (>= 150 ms) and out over INK_FULL.out; an interrupted one fades over INK_CUT.
  // Reduced motion: INK_CALM — weaker, shorter, lines and grain held still. Low tier: the cheap
  // variant (no ink-edge taps, no grain) at three-quarter strength.
  _startSuperInk(f) {
    const calm = this._calm();
    const low = Quality.tier() === 'low';
    const env = calm ? INK_CALM : INK_FULL;
    const suit = f.rig.baseColors?.suit;
    const tie = f.rig.baseColors?.tie;
    this._superInk = {
      f, t: 0, cutAt: -1, cutFrom: 0,
      in: env.in, hold: env.hold, out: env.out,
      peak: env.peak * (low && !calm ? 0.75 : 1),
      cheap: low ? 1 : 0, motion: calm ? 0 : 1,
      a: (suit ? suit.clone() : new THREE.Color(0x1a2340)).lerp(_black, 0.55),
      b: (tie ? tie.clone() : new THREE.Color(0xd04030)).lerp(_paper, 0.4),
    };
  }

  /** Per frame (wall clock, from _tickSuperCinematic): the ink envelope into the post pass. */
  _tickSuperInk(dt) {
    const s = this._superInk;
    const u = this.fxPass?.uniforms;
    if (!s || !u || !u.uSuperInk) return;
    s.t += dt;
    const ease = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
    let k;
    if (s.t < s.in) k = ease(s.t / s.in);
    else if (s.t < s.in + s.hold) k = 1;
    else k = 1 - ease((s.t - s.in - s.hold) / s.out);
    // A KO, a reset or a new round took the beat away: fade from where it is, never cut.
    if (s.cutAt < 0 && (this._superFighter !== s.f || this.phase === 'ko' || this.phase === 'result')) {
      s.cutAt = s.t;
      s.cutFrom = k;
    }
    const cut = this.phase === 'ko' || this.phase === 'result' ? INK_CUT_KO : INK_CUT;
    if (s.cutAt >= 0) k = Math.min(k, s.cutFrom * (1 - ease((s.t - s.cutAt) / cut)));
    const done = s.t >= s.in + s.hold + s.out || (s.cutAt >= 0 && s.t - s.cutAt >= cut);
    u.uSuperInk.value = done ? 0 : k * s.peak;
    u.uInkCheap.value = s.cheap;
    u.uInkMotion.value = s.motion;
    s.a.toArray(u.uInkA.value);
    s.b.toArray(u.uInkB.value);
    const torso = s.f.rig?.joints?.torso || s.f.rig?.root;
    if (torso && this.camera) {
      torso.getWorldPosition(_inkProj).project(this.camera);
      if (_inkProj.z < 1) {
        u.uInkC.value[0] = THREE.MathUtils.clamp((_inkProj.x + 1) * 0.5, 0, 1);
        u.uInkC.value[1] = THREE.MathUtils.clamp((_inkProj.y + 1) * 0.5, 0, 1);
      }
    }
    if (done) this._superInk = null;
  }

  _tickSuperCinematic(dt) {
    this._tickSuperInk(dt);
    if (!this._superT) return;
    // A KO outranks a super: the KO path owns timeScale and the camera.
    if (this.phase === 'ko' || this.phase === 'result') { this._endSuperCinematic(); return; }

    this._superT = Math.max(0, this._superT - dt);
    const k = 1 - this._superT / this._superDur;    // 0 → 1 across the beat

    // Cubic ease-out so the hit lands at full speed.
    this.timeScale = 0.22 + 0.78 * (k * k * k);
    // Math.max arming, so an impact during the super can still push higher.
    this._speedPulse = Math.max(this._speedPulse || 0, 0.22 + 0.34 * (1 - k));
    this._smear(0.1, 0.70);
    this.exposurePulse = Math.max(this.exposurePulse || 0, 0.22 * (1 - k));

    if (this._superT <= 0) this._endSuperCinematic();
  }

  _endSuperCinematic() {
    if (!this._superT && !this._superFighter) return;
    this._superT = 0;
    // Don't reclaim time/camera from the KO branch, which runs first on the same frame.
    if (this.phase !== 'ko' && this.phase !== 'result') {
      this.timeScale = 1;
      // Step DOWN to normal — debounced by CAMERA_MIN_DWELL so a fresh super
      // that fires immediately after this one can't strobe the camera. The
      // super branch in _updateCamera gates on `_superFighter` (cleared below)
      // so the view still reads as "normal" even while the mode string is held.
      if (this.cameraMode === 'super') { this._setCameraMode('normal'); this.cameraModeT = 0; }
    } else if (this.cameraMode === 'super') {
      this._setCameraMode('normal');
    }
    for (const u of this._superFighter?.inkUniforms || []) {
      u.uInkColor.value.setHex(0x05070f);
    }
    this._superFighter = null;
  }

  // Writes the runtime fields each onSuper mode needs. A new super is one arm
  // here + one onSuper block in personalities.js.
  _applySuperEffect(f, cfg) {
    const per = f.personality;
    const opp = this.fighters.find((o) => o !== f);
    if (!per) return;
    switch (cfg.mode) {
      case 'theWall': {
        // Trump: damage ramp comes from the existing koStacks path.
        per.activeMode = 'theWallSuper';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 3.0);
        break;
      }
      case 'bigGuy': {
        // Biden: full charge + auto-arm next swing for lockSecs.
        f.energy = 1.0;
        f.chargeAmt = 1.0;
        per._bigGuyLockUntil = this.t + (cfg.lockSecs || 1.5);
        break;
      }
      case 'droneStrike': {
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.5;
        break;
      }
      case 'deciderManual': {
        // Bush: no freeze on the manual path.
        per.activeMode = 'decider';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 30);
        break;
      }
      case 'saxSolo': {
        // Clinton: the chain itself arms via the onHitChain handler.
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 1.6;
        per._saxSoloUntil = this.t + 1.2;
        break;
      }
      case 'voodoo': {
        // Bush Sr.: decremented per swing in _enterAttack.
        per.superPumpSwingsLeft = cfg.swingCount || 3;
        break;
      }
      case 'morningInAmerica': {
        per.activeMode = 'morningInAmerica';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 6);
        break;
      }
      case 'malaiseSpeech': {
        // Carter: the slow is applied in _applyOnHitPersonalities.
        per.iframesUntil = this.t + (cfg.iframesSecs || 1.5);
        break;
      }
      case 'pardonMe': {
        // Ford: input-blind on the opponent fighter.
        if (opp) {
          opp._inputBlindUntil = this.t + (cfg.blindSecs || 1.0);
          opp._inputBlindMissRate = cfg.blindMissRate || 0.60;
        }
        break;
      }
      case 'notACrook': {
        per.superDirtySwingsLeft = cfg.dirtySwings || 3;
        per._notACrookFirst = true;
        break;
      }
      case 'treatmentManual': {
        per.lbjMissKBUntil = this.t + (cfg.windowSecs || 8.0);
        break;
      }
      case 'profilesInCourage': {
        per.jfkProfileIframesUntil = this.t + (cfg.iframesSecs || 0.6);
        per.jfkNextSwingAtkMul = cfg.nextSwingAtkMul || 1.5;
        break;
      }
      case 'overlord': {
        per.superSwingAtkMul = cfg.nextSwingAtkMul || 2.2;
        per.eisenhowerIframesUntil = this.t + (cfg.iframesSecs || 1.0);
        break;
      }
      case 'buckStopsHere': {
        // Truman: stacks are spent so they can't double-dip.
        const mul = cfg.stackMul || 3.0;
        per.superSwingAtkMul = 1.0 + (per.trumanBuckStacks || 0) * 0.02 * mul;
        per.trumanBuckStacks = 0;
        break;
      }
      case 'dayOfInfamy': {
        per.activeMode = 'dayOfInfamy';
        per.modeExpiresAt = this.t + (cfg.durationSecs || 8.0);
        break;
      }
      default:
        break;
    }
  }

  // Per-hit personality effects. Returns a damage multiplier the caller applies
  // to baseDmg before the damage roll.
  _applyOnHitPersonalities(attacker, defender, region, baseDmg, hit, attack) {
    const att = attacker.personality;
    const def = defender.personality;
    const now = this.t;
    let personalityDmgMul = 1.0;

    // Biden: a charged hit (chargeMul > 1) slows the defender.
    if (att?.id === 'biden' && PERSONALITIES.biden?.onChargeHitEffect
        && attacker.chargeMul > 1.0) {
      const params = PERSONALITIES.biden.onHitEffectParams;
      defender.slowUntil = now + (params?.slowSecs || 1.0);
      defender.slowMul = params?.slowMul || 0.5;
    }

    // Bush Sr. voodoo super: flag set per swing at commit.
    if (attacker._bushsrSuperPump && att?.id === 'bushsr') {
      const cfg = PERSONALITIES.bushsr?.onSuper;
      personalityDmgMul *= (cfg?.swingAtkMul || 1.4);
      attacker._bushsrSuperPump = false;
    }
    // Carter malaise super: a landed hit inside the window slows the defender.
    if (att?.superActiveMode === 'malaiseSpeech' && att?.superFiredAt
        && now - att.superFiredAt < (PERSONALITIES.carter.onSuper.slowSecs || 0.5)) {
      defender.slowUntil = now + (PERSONALITIES.carter.onSuper.slowSecs || 0.5);
      defender.slowMul = PERSONALITIES.carter.onSuper.slowMul || 0.55;
    }

    // Clinton: a landed punch queues a follow-up elbow.
    if (att?.id === 'clinton' && attack.name === 'punch' && PERSONALITIES.clinton?.onHitChain) {
      this._scheduleClintonFlourish(attacker, defender);
    }

    // Carter "Habitat for Humanity" combo ladder.
    if (att?.id === 'carter' && PERSONALITIES.carter?.passive
        && PERSONALITIES.carter.passive.name === 'habitatForHumanity') {
      att.habitatComboN = Math.min(
        PERSONALITIES.carter.passive.comboLadderMax,
        att.habitatComboN + 1);
      att.habitatComboT = now;
    }

    // Ford: hit during his stumble opens the retaliate window.
    if (def?.id === 'ford' && now < def.stumbleUntil) {
      def.retaliateUntil = now + (PERSONALITIES.ford?.onStumbleHit?.retaliateSecs || 1.5);
    }

    // Nixon once-per-round eye-gouge roll on a landed hit.
    if (att?.id === 'nixon' && PERSONALITIES.nixon?.oncePerRound
        && !att.usedThisRound
        && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.nixon.oncePerRound;
      if (this.rng.random() < cfg.procChance) {
        this._scheduleNixonBlind(defender, cfg.blindSecs);
      }
    }

    // LBJ Treatment is armed in _enterAttack; only expire it here.
    if (att?.lbjMissKBUntil && now >= att.lbjMissKBUntil) att.lbjMissKBUntil = 0;

    // LBJ "All the Way": first landed hit per round arms the pump swings.
    if (att?.id === 'lbj' && PERSONALITIES.lbj?.oncePerRound
        && !att.usedThisRound && baseDmg > 0) {
      att.usedThisRound = true;
      const cfg = PERSONALITIES.lbj.oncePerRound;
      att.lbjPumpSwingsLeft = cfg.pumpSwingCount || 3;
    }
    if (att?.id === 'lbj' && att.lbjPumpSwingsLeft > 0 && baseDmg > 0) {
      att.lbjPumpSwingsLeft -= 1;
      personalityDmgMul *= PERSONALITIES.lbj.oncePerRound.pumpAtkMul || 1.20;
    }

    // JFK "Camelot Glint": every Nth landed swing.
    if (att?.id === 'jfk' && PERSONALITIES.jfk?.everyNthHit && baseDmg > 0) {
      att.jfkDashboardCount = (att.jfkDashboardCount || 0) + 1;
      if (att.jfkDashboardCount
          >= (PERSONALITIES.jfk.everyNthHit.n || 4)) {
        att.jfkDashboardCount = 0;
        personalityDmgMul *= PERSONALITIES.jfk.everyNthHit.mul || 1.4;
      }
    }
    // Next-swing bonuses are spent on the first landed hit.
    if (att?.id === 'jfk' && att.jfkNextSwingAtkMul > 1.0 && baseDmg > 0) {
      personalityDmgMul *= att.jfkNextSwingAtkMul;
      att.jfkNextSwingAtkMul = 1.0;
    }
    if (att?.id === 'eisenhower' && att.eisenhowerNextSwingAtkMul > 1.0
        && baseDmg > 0) {
      personalityDmgMul *= att.eisenhowerNextSwingAtkMul;
      att.eisenhowerNextSwingAtkMul = 1.0;
    }

    // Truman: stacks scale his landed swings, and each hit taken adds one.
    if (att?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      const cfg = PERSONALITIES.truman.stacksOnHit;
      const stacks = att.trumanBuckStacks || 0;
      const incMul = 1 + stacks * (cfg.dmgPerStack || 0.02);
      personalityDmgMul *= incMul;
    }
    if (def?.id === 'truman' && PERSONALITIES.truman?.stacksOnHit
        && baseDmg > 0) {
      def.trumanBuckStacks = Math.min(
        PERSONALITIES.truman.stacksOnHit.cap || 30,
        (def.trumanBuckStacks || 0) + 1);
    }

    // FDR startup boost and Day of Infamy.
    if (att?.id === 'fdr' && att.fdrStartupUntil && now < att.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      personalityDmgMul *= PERSONALITIES.fdr.startupBoost.atkMul || 1.10;
    }
    if (att?.activeMode === 'dayOfInfamy'
        && PERSONALITIES.fdr?.triggerHpGated?.atkMul) {
      personalityDmgMul *= PERSONALITIES.fdr.triggerHpGated.atkMul;
    }

    return personalityDmgMul;
  }

  // Queues one of Clinton's elbow follow-ups on the attacker (capped at 6 pending).
  _scheduleClintonFlourish(attacker, defender) {
    if (!attacker._clintonFlourish) attacker._clintonFlourish = [];
    if (attacker._clintonFlourish.length >= 6) return;
    attacker._clintonFlourish.push({
      target: defender.playerId,
      damage: PERSONALITIES.clinton.onHitChain.elbowDmg || 3,
      at: this.t + 0.18 * (attacker._clintonFlourish.length + 1),
    });
  }

  // Nixon eye-gouge: input-blind flag on the defender, read in game.js _tickFighting.
  _scheduleNixonBlind(fighter, secs = 0.30) {
    if (!fighter) return;
    fighter._inputBlindUntil = this.t + secs;
  }

  // Lands due Clinton follow-ups while both fighters are upright and in range.
  // An elbow is a strike like any other: a held guard facing Clinton stops it,
  // and one that empties the bar goes through the normal KO hand-off
  // (_resolveCombatEvents) rather than leaving a fighter standing on 0 HP.
  _tickClintonFlourish(f, dt) {
    if (!f._clintonFlourish || !f._clintonFlourish.length) return;
    const now = this.t;
    const opp = this.fighters.find((o) => o !== f);
    for (let i = f._clintonFlourish.length - 1; i >= 0; i--) {
      const p = f._clintonFlourish[i];
      if (now < p.at) continue;
      f._clintonFlourish.splice(i, 1);
      if (!opp || opp.playerId !== p.target || opp.state === 'ko' || f.state === 'ko'
          || this.phase !== 'fighting') continue;
      const fpos = f.rig.root.position;
      const dpos = opp.rig.root.position;
      if (fpos.distanceTo(dpos) >= 2.5) continue;
      const point = new THREE.Vector3(dpos.x, dpos.y + 1.3, dpos.z);
      if (opp.state === 'block' && guardCovers(opp.rig, fpos)) {
        // Stopped on the guard: the blue spark of an ordinary block, nothing else.
        this._spawnSparks(point, 0x9ad0ff, 4, 0.8);
        this.audio?.block(point);
        continue;
      }
      this.combat.damage({ playerId: p.target, amount: p.damage, sourceId: f.playerId });
      this.hudDirty = true;
      const knockDir = new THREE.Vector3(dpos.x - fpos.x, 0, dpos.z - fpos.z);
      if (knockDir.lengthSq() > 1e-6) knockDir.normalize(); else knockDir.set(1, 0, 0);
      this._resolveCombatEvents({
        attack: ATTACKS.punch, hit: { point }, region: 'torso', knockDir, torqueY: 0, dpos,
      });
    }
  }
}

export const PersonalityEffects = PersonalityEffectsMethods.prototype;
