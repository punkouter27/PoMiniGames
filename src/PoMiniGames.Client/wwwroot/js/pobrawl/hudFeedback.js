// hudFeedback.js — the fight's readouts: the banner, landed-hit bookkeeping, combo badges,
// callouts, damage numbers and floaters, and the 4 Hz HUD pump to the page. Mixin (mixin.js),
// `this` is the live game; moved out of game.js unchanged.

import * as THREE from 'three-eco/webgpu';
import { REGIONS } from './combat.js';
import { HEAVY_HIT_DMG, TIME_LIMIT, COMBO_MIN_SHOWN } from './constants.js';

// ── Hit feedback (damage numbers + combo readout) ────────────────────────
// A combo is a run of landed hits with no more than COMBO_WINDOW between
// them. It is deliberately longer than HITSTUN (0.35 s): hitstun is how long
// the defender is *locked*, and requiring the next hit inside that window
// would only ever count true frame-traps, which this engine's charge-and-
// release rhythm essentially never produces. 1.1 s reads as "kept the
// pressure up", which is the thing worth showing the player.
const COMBO_WINDOW = 1.1;
// Hard ceiling on live damage-number nodes. A full-charge flurry can land
// several hits inside one animation lifetime, and on a phone the compositor
// cost of unbounded absolutely-positioned text is real. Oldest is evicted.
const MAX_DAMAGE_NUMBERS = 14;

const _dmgProj = new THREE.Vector3();

class HudFeedbackMethods {
  _setBanner(text) {
    if (this.banner && this.banner.textContent !== text) {
      this.banner.textContent = text;
      // One surface per call: the caption bar steps aside for the same words (commentary.js).
      if (text) this._captionYieldTo?.(text);
    }
  }

  // ── Hit feedback: damage numbers + combo readout ─────────────────────
  // One call per landed (unblocked) hit. Owns the three things that all key off
  // that single event: the per-round scorecard the end-of-fight recap reads, the
  // combo run length, and the floating number at the contact point. Blocked
  // hits deliberately don't come through here — they bump the DEFENDER's block
  // count at the call site instead, and a blocked blow neither extends a combo
  // nor deserves a damage number.
  _registerLandedHit(attacker, defender, dmg, point, region) {
    const s = attacker.stats;
    s.hits += 1;
    if (dmg > s.biggestHit) s.biggestHit = dmg;

    // The combo run continues while the gap since this attacker's last landed
    // hit is under COMBO_WINDOW. Measured on the sim clock (`this.t`), not
    // wall-clock, so hitstop pauses the window instead of eating into it.
    attacker.comboN = (this.t - attacker.comboT) <= COMBO_WINDOW ? attacker.comboN + 1 : 1;
    attacker.comboT = this.t;
    if (attacker.comboN > s.bestCombo) s.bestCombo = attacker.comboN;
    // Taking a hit ends YOUR run. Without this, two fighters trading blows both
    // show a climbing counter, which reads as a combo when it is the opposite.
    defender.comboN = 0;
    defender.comboT = -99;

    this._showCombo(attacker);
    this._showCombo(defender);
    this._spawnDamageNumber(point, dmg, region);
    // The run rings up the scale in the music's key.
    if (attacker.comboN >= 2) this.audio?.comboNote(attacker.comboN, point);
    this._commentOnHit(attacker, defender, dmg);

    // ── Reaction layer ───────────────────────────────────────────────
    // The mix, the crowd and the visual stamp all hang off this one call site
    // so they can never disagree about what counted as a hit.
    //
    // `power` normalises damage against twice the heavy threshold, so a jab is
    // ~0.35 and a fully-charged head kick saturates at 1.
    const power = Math.min(1, dmg / (HEAVY_HIT_DMG * 2));
    if (this.audio) {
      this.audio.duckMusic(power);
      this.audio.crowdSwell(power);
      // The concussion is reserved for a heavy blow to the HEAD. On a torso hit
      // it makes no sense, and on every hit it would be a permanent lowpass.
      if (region === REGIONS.HEAD && dmg >= HEAVY_HIT_DMG) {
        this.audio.concussion(0.55 + 0.45 * power);
      }
    }
    // A near-KO makes the hall inhale.
    if (this.audio && this._hp(defender) <= 18 && this._hp(defender) > 0 && dmg >= HEAVY_HIT_DMG) {
      this.audio.crowdGasp();
    }
    if (dmg >= HEAVY_HIT_DMG) this._impactFrame(point, power);
    // Tournament: the crowd reads it against the Elo story (cup.js).
    this._upsetOnHit(attacker, defender, dmg);
    // Rumble: the one hit carries the full motor, the one landing it a
    // light buzz in the hand.
    this._rumble(defender, 0.3 + 0.6 * power, 0.5, 80 + 140 * power);
    this._rumble(attacker, 0.08, 0.2 + 0.35 * power, 55);
    this._show('hit', { attacker, defender, dmg, point, region, power });
  }

  /**
   * Dual-rumble on the pad (or phone) of the person driving `f`, if a person is — online only the
   * local corner. haptics.js routes it; impactBus gates it. opts: { priority, phone }.
   */
  _rumble(f, strong, weak, ms, opts) {
    this.haptics?.rumble(f, strong, weak, ms, opts);
  }

  _showCombo(f) {
    const el = this._comboEls?.[this.fighters.indexOf(f)];
    if (!el) return;
    if (f.comboN < COMBO_MIN_SHOWN) { el.classList.remove('pb-combo--on'); return; }
    el.querySelector('.pb-combo__n').textContent = String(f.comboN);
    // Replay the pop on every increment. Dropping the class and reading
    // offsetWidth to force a synchronous reflow before re-adding it is the only
    // reliable way to restart a CSS animation — re-adding it in the same frame
    // without the reflow is coalesced into no change at all.
    el.classList.remove('pb-combo--on');
    void el.offsetWidth;
    el.classList.add('pb-combo--on');
  }

  // Expires stale combo runs so the badge disappears when the pressure stops,
  // rather than hanging until the next hit lands.
  _tickCombos() {
    for (const f of this.fighters) {
      if (f.comboN > 0 && (this.t - f.comboT) > COMBO_WINDOW) {
        // A run of 4+ that ends on its own terms gets its resolving chord.
        // (One broken by a counter-hit is zeroed in _registerLandedHit instead,
        // so it never gets here with a count — no reward for being interrupted.)
        if (f.comboN >= 4) this.audio?.comboFinisher(f.comboN);
        f.comboN = 0;
        this._showCombo(f);
      }
    }
  }

  // A short word at a contact point, on the same lifecycle as a damage number
  // (same layer, same rise animation, same eviction cap) — it is a damage
  // number whose text happens to be a word. Used by the perfect guard and the
  // counter it arms, which are the two events in the game that have to TEACH
  // something: a block that pays double is worthless as a lesson if nothing on
  // screen says it happened.
  _spawnCallout(point, text) {
    this._spawnFloater(point, text, 'pb-dmg--callout');
  }

  _spawnDamageNumber(point, dmg, region) {
    this._spawnFloater(point, String(Math.max(1, Math.round(dmg))),
      (region === REGIONS.HEAD ? ' pb-dmg--head' : '')
      + (dmg >= HEAVY_HIT_DMG ? ' pb-dmg--heavy' : ''));
  }

  // Project a world point to screen and float a DOM node up from it. Owns the
  // projection guard, the jitter, the node cap and the animationend cleanup —
  // all of which damage numbers and callouts have to get right identically, and
  // only one of which is obvious enough to be re-derived correctly by hand.
  _spawnFloater(point, text, extraClass) {
    if (!this.fx) return;
    const w = this._hostW, h = this._hostH;
    if (!w || !h) return;
    _dmgProj.copy(point).project(this.camera);
    // A point behind the near plane projects to a mirrored on-screen position,
    // so it would draw a number somewhere the hit did not happen. Skip it.
    if (_dmgProj.z > 1) return;
    const el = document.createElement('span');
    el.className = 'pb-dmg' + (extraClass ? ' ' + extraClass.trim() : '');
    el.textContent = text;
    // Horizontal jitter so a flurry into one capsule doesn't overprint into an
    // unreadable smear. Seeded RNG, so a seeded replay jitters identically.
    el.style.left = `${(_dmgProj.x * 0.5 + 0.5) * w + (this.rng.random() - 0.5) * 26}px`;
    el.style.top = `${(-_dmgProj.y * 0.5 + 0.5) * h}px`;
    this.fx.appendChild(el);
    this._dmgNodes.push(el);
    // Cap the live node count. This is also the safety net for the case where
    // `animationend` never fires (animations disabled at the OS/browser level):
    // eviction, not the listener, is what guarantees the list stays bounded.
    while (this._dmgNodes.length > MAX_DAMAGE_NUMBERS) this._dmgNodes.shift()?.remove();
    el.addEventListener('animationend', () => {
      const i = this._dmgNodes.indexOf(el);
      if (i >= 0) this._dmgNodes.splice(i, 1);
      el.remove();
    }, { once: true });
  }

  // Wipes floating feedback between rounds so a new round never opens with the
  // previous one's numbers still drifting up the screen.
  _clearFx() {
    for (const el of this._dmgNodes || []) el.remove();
    if (this._dmgNodes) this._dmgNodes.length = 0;
    for (const f of this.fighters || []) { f.comboN = 0; f.comboT = -99; }
    for (const el of this._comboEls || []) el?.classList.remove('pb-combo--on');
  }

  _pushHud(dt) {
    this.hudTimer += dt;
    if (!this.hudDirty && this.hudTimer < 0.25) return;
    this.hudTimer = 0;
    this.hudDirty = false;
    if (this.dotnet) {
      // Region damage rides along as [head, torso, arms, legs] per fighter so
      // the Blazor HUD can render the body-diagram damage readout.
      const regions = (f) => [
        Math.round(f.regionDmg.head), Math.round(f.regionDmg.torso),
        Math.round(f.regionDmg.arms), Math.round(f.regionDmg.legs),
      ];
      // ARITY CONTRACT with PoBrawlPage.OnHud — seven arguments, and both sides
      // move together or the HUD dies silently. invokeMethodAsync rejects on an
      // argument-count mismatch and this call swallows it in .catch(() => {}),
      // so a mismatch produces no console error: just a HUD frozen at its C#
      // field initializers. Change OnHud in the same commit.
      // The training room has no clock; the page renders its own ∞ there, and a
      // pinned full value keeps the HUD from counting down to a limit that never fires.
      const timeLeft = this.training ? TIME_LIMIT : Math.max(0, TIME_LIMIT - (this.clock || 0));
      this.dotnet.invokeMethodAsync('OnHud',
        this._hp(this.fighters[0]), this._hp(this.fighters[1]), Math.round(timeLeft * 10) / 10,
        regions(this.fighters[0]), regions(this.fighters[1]),
        Math.round(this.fighters[0].energy * 100), Math.round(this.fighters[1].energy * 100))
        .catch(() => {});
    }
  }

}

export const HudFeedback = HudFeedbackMethods.prototype;
