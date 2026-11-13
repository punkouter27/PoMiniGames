// combat.js — health/armor/death/winner resolution for the match.
// Adapted from GameBlocks (github.com/xt4d/GameBlocks, MIT) gameplay/CombatPlay.js,
// trimmed to what a 1v1 brawler needs: two players, each its own team, armor
// absorption, a PLAYER_KILLED / COMBAT_FINISHED event queue, and winner resolution.
// The engine owns visuals/animation; this owns the numbers and the "who won" rule.

const COMBAT_STATES = Object.freeze({
  WAITING: 'WAITING',
  STARTED: 'STARTED',
  FINISHED: 'FINISHED',
});

export const COMBAT_EVENTS = Object.freeze({
  PLAYER_KILLED: 'combat.player.killed',
  COMBAT_FINISHED: 'combat.finished',
});

// Region ids used for per-region damage. The engine maps each to a rig region.
export const REGIONS = Object.freeze({
  HEAD: 'head', TORSO: 'torso', ARMS: 'arms', LEGS: 'legs',
});

export class CombatPlay {
  constructor({ maxHealth = 100, maxArmor = 100, armorAbsorption = 0.6 } = {}) {
    this.maxHealth = maxHealth;
    this.maxArmor = maxArmor;
    this.armorAbsorption = armorAbsorption;
    this.players = new Map();
    this.combatState = COMBAT_STATES.WAITING;
    this.winnerTeamId = null;
    this._events = [];
  }

  addPlayer({ playerId, teamId, health = this.maxHealth, armor = 0 }) {
    this.players.set(playerId, {
      playerId, teamId,
      maxHealth: this.maxHealth, health,
      maxArmor: this.maxArmor, armor,
      alive: health > 0,
    });
  }

  startGame() {
    this.winnerTeamId = null;
    this.combatState = COMBAT_STATES.STARTED;
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  damage({ playerId, amount, sourceId = null, bypassArmor = false }) {
    if (this.combatState !== COMBAT_STATES.STARTED) return 0;
    const p = this.players.get(playerId);
    if (!p || !p.alive) return 0;
    // A NaN or negative amount from an upstream multiplier must be a no-op:
    // NaN would poison health and read as dead (NaN > 0 is false), and a
    // negative amount would heal.
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const armorDamage = bypassArmor ? 0 : Math.min(p.armor, amount * this.armorAbsorption);
    const healthDamage = Math.min(p.health, amount - armorDamage);
    p.armor -= armorDamage;
    p.health -= healthDamage;
    p.alive = p.health > 0;

    if (!p.alive) {
      this._events.push({ type: COMBAT_EVENTS.PLAYER_KILLED, playerId, sourceId });
    }
    return healthDamage;
  }

  getAliveTeamIds() {
    return Array.from(new Set(
      Array.from(this.players.values()).filter((p) => p.alive).map((p) => p.teamId)
    ));
  }

  // Resolves the match when one team remains, then drains queued events.
  step() {
    if (this.combatState === COMBAT_STATES.STARTED) {
      const alive = this.getAliveTeamIds();
      if (alive.length <= 1) {
        this.combatState = COMBAT_STATES.FINISHED;
        this.winnerTeamId = alive[0] ?? null;
        this._events.push({ type: COMBAT_EVENTS.COMBAT_FINISHED, winnerTeamId: this.winnerTeamId });
      }
    }
    const events = this._events;
    this._events = [];
    return events;
  }
}

// Per-region damage state lives alongside the CombatPlay in the engine, but the
// rules for region-to-effect translation are shared here so tests and AI can
// reason about them. The engine calls `regionEffect(regionDmg)` to compute the
// combined status effect modifier for the current tick.
//
// Each region costs its owner something different, in two steps (0..100):
//   head  >= 40/70 → flinchBonus: seconds added to THIS fighter's hitstun
//                    dazeMul:     hits build daze faster — down sooner (knockdown.js)
//   torso >= 30/70 → regenMul:    energy comes back slower (energy.js) — body work
//                                 is how you take the legs out from under a turtle's bar
//   arms  >= 30/70 → atkMul:      scales the damage THIS fighter deals
//                    guardLeak:   share of a blocked strike that gets through an
//                                 ordinary guard (never a perfect one)
//   legs  >= 30/70 → moveMul:     slower on the feet
//                    getupPenalty: seconds added to the get-up
// Every field describes the fighter whose regionDmg was passed in — the
// attacker's own arms weaken the attacker's swings (hitResolution.js
// _tryHit), the defender's head lengthens the defender's stun (_landHit).
// The online fight never reads any of this for its numbers (the rollback sim has
// no regions); netplay.js only borrows the shape for the presentation.
export const REGION_TIERS = Object.freeze({
  head: [40, 70], torso: [30, 70], arms: [30, 70], legs: [30, 70],
});

/** 0 (fine), 1 (hurt) or 2 (wrecked) for a region's damage. */
export function regionTier(region, dmg) {
  const [lo, hi] = REGION_TIERS[region] || [Infinity, Infinity];
  return dmg >= hi ? 2 : dmg >= lo ? 1 : 0;
}

// What the ring calls a region the moment it crosses into a tier.
export const REGION_CALLOUTS = Object.freeze({
  head: ['RATTLED', 'SEEING STARS'],
  torso: ['WINDED', 'RIBS CRACKED'],
  arms: ['ARMS HURT', 'GUARD BROKEN'],
  legs: ['LEG HURT', 'HOBBLED'],
});

const pick = (tier, values) => values[tier];

export function regionEffect(regionDmg) {
  const head = regionTier('head', regionDmg.head ?? 0);
  const torso = regionTier('torso', regionDmg.torso ?? 0);
  const arms = regionTier('arms', regionDmg.arms ?? 0);
  const legs = regionTier('legs', regionDmg.legs ?? 0);
  return {
    flinchBonus: pick(head, [0, 0.06, 0.14]),
    dazeMul: pick(head, [1, 1.2, 1.45]),
    regenMul: pick(torso, [1, 0.8, 0.6]),
    atkMul: pick(arms, [1, 0.9, 0.75]),
    guardLeak: pick(arms, [0, 0.15, 0.35]),
    moveMul: pick(legs, [1, 0.85, 0.65]),
    getupPenalty: pick(legs, [0, 0.12, 0.3]),
  };
}

// ── Both hands ─────────────────────────────────────────────────────────────
// A tap leads with the LEFT (the jab); a second tap inside ONE_TWO_WINDOW throws
// the RIGHT behind it (the cross), and so on, left-right-left. Anything coiled
// past JAB_MAX_CHARGE is the right hand: the coil pose loads it and the power
// lives there. A fighter down to one arm punches with the one that is left.
export const ONE_TWO_WINDOW = 0.7;
export const JAB_MAX_CHARGE = 0.2;
// The jab trades a little bite for being the lead; the cross behind it earns it back.
export const JAB_DMG_MUL = 0.9;
export const CROSS_DMG_MUL = 1.2;

/**
 * Which arm throws this punch, and what it is worth.
 * @param o.armsLost   Set of 'L' / 'R' torn off
 * @param o.chargeAmt  0..1 coil at release
 * @param o.lastArm    the arm of this fighter's previous punch, or null
 * @param o.sinceLast  seconds since that punch was thrown
 * @returns {{ arm: 'L'|'R', dmgMul: number }} or null with no arm to punch with
 */
export function pickPunchArm({ armsLost = null, chargeAmt = 0, lastArm = null, sinceLast = Infinity } = {}) {
  const hasL = !armsLost || !armsLost.has('L');
  const hasR = !armsLost || !armsLost.has('R');
  if (!hasL && !hasR) return null;
  if (!hasL) return { arm: 'R', dmgMul: 1 };
  if (!hasR) return { arm: 'L', dmgMul: 1 };
  if (chargeAmt > JAB_MAX_CHARGE) return { arm: 'R', dmgMul: 1 };
  const oneTwo = lastArm === 'L' && sinceLast <= ONE_TWO_WINDOW;
  return oneTwo ? { arm: 'R', dmgMul: CROSS_DMG_MUL } : { arm: 'L', dmgMul: JAB_DMG_MUL };
}