// energy.js — the energy meter's rules, as pure functions over a fighter's
// { state, energy, gassed, chargeAmt }. No scene, no clock, no RNG: fighterTick.js
// calls these from the state machine and tests/pobrawl-core.test.mjs calls them alone.
//
// One 0..1 pool per fighter — the blue bar under the HP bar in the Blazor HUD.
// It is BOTH how hard this fighter's strikes land and whether they are allowed
// to throw one at all. Design goal: blocking is rewarded and pure offence is a
// losing strategy.
//
//   • winding up drains the pool into the strike (chargeAmt), so the coil is
//     paid for out of the bar and the bar visibly empties as you load up;
//   • releasing costs a further flat ATTACK_ENERGY_COST, which is what taxes
//     tap-spam — a jab banks almost no charge but still pays the toll;
//   • dropping under the floor GASSES the fighter: no punch, no kick, at all,
//     until they have recovered back up to ENERGY_RECOVER_TO (see canAttack);
//   • blocking refills it fast, idling refills it slowly, and swinging refills
//     it not at all.

// Fighters open with a full bar — roughly four spammed kicks, or one fully
// committed haymaker. Less would gas a fighter out after two jabs.
export const ENERGY_DEFAULT = 1.0;

// ── Hold-to-charge (Urban Champion style) ────────────────────────────────
// Press-and-hold punch/kick winds the attack up; release throws it. Charge
// scales damage/knockback from a quick tap (1x) to a full hold (CHARGE_MAX_MUL)
// over CHARGE_TIME seconds. Held attacks are intentionally a huge upgrade over
// quick taps, so committing to a full charge is worth the risk.
export const CHARGE_TIME = 1.0;
export const CHARGE_MAX_MUL = 4.0;

// Flat toll charged on every swing release, on top of whatever the wind-up
// already drained. This is the anti-spam term: at 0.22 a fighter who only ever
// taps gets roughly four KICKS from a full bar before gassing out, and the idle
// regen below cannot keep up with continuous mashing. Each attack scales it by
// its own `energyMul`, so a punch pays half (≈ eight jabs to a bar) — see the
// ATTACKS table (constants.js) for why the two buttons are priced apart.
export const ATTACK_ENERGY_COST = 0.22;

// Hysteresis band for the gate. Falling below ENERGY_ATTACK_FLOOR sets the
// gassed flag; clearing it needs ENERGY_RECOVER_TO, which is deliberately
// higher so an exhausted fighter cannot chip out one more jab the instant a
// single frame of regen lands. That gap is the punishment window.
export const ENERGY_ATTACK_FLOOR = 0.22;
export const ENERGY_RECOVER_TO = 0.40;

// Regen, as a fraction of a full bar per second, by state. Blocking is ~3.4x
// idle: guarding is the deliberate, rewarded way back into the fight. Swinging
// (the punch/kick states) regenerates nothing — you do not catch your breath
// mid-combination — and neither does the charge state, which is actively
// DRAINING the pool into the strike. The KO state is exempt entirely; a bar
// still moving behind the K.O. banner reads as a bug.
export const ENERGY_REGEN_PER_SEC = 0.16;
export const ENERGY_BLOCK_REGEN_PER_SEC = 0.55;
export const ENERGY_HITSTUN_REGEN_PER_SEC = 0.08;

/** Bar fraction per second a fighter in `state` gets back, before body-damage scaling. */
export function regenRate(state) {
  switch (state) {
    case 'block': return ENERGY_BLOCK_REGEN_PER_SEC;
    case 'hitstun': return ENERGY_HITSTUN_REGEN_PER_SEC;
    case 'punch': case 'kick': case 'charge': case 'ko': return 0;
    default: return ENERGY_REGEN_PER_SEC;   // idle, and the canvas (down / getup)
  }
}

/**
 * One tick of regen plus the gassed bookkeeping.
 * @param f         the fighter ({ state, energy, gassed })
 * @param dt        seconds
 * @param regenMul  body damage: bruised ribs breathe slower (combat.js regionEffect)
 * @param locked    true inside a window that must not touch the bar (Biden's "THE BIG GUY")
 * @returns true when the gassed flag flipped, so the caller can flag the HUD
 */
export function tickEnergy(f, dt, { regenMul = 1, locked = false } = {}) {
  if (!locked) {
    const regen = regenRate(f.state) * regenMul;
    if (regen > 0) f.energy = Math.min(1, f.energy + dt * regen);
  }
  // Outside the lock on purpose, so a fighter can never be left flagged gassed
  // while sitting on a full bar.
  if (f.gassed) {
    if (f.energy >= ENERGY_RECOVER_TO) { f.gassed = false; return true; }
  } else if (f.energy < ENERGY_ATTACK_FLOOR) {
    f.gassed = true;
    return true;
  }
  return false;
}

/**
 * One tick of a held coil: pour the pool into the strike. The drain is clamped to
 * what is actually left, so the coil stops growing on an empty bar rather than
 * loading power that was never paid for. `locked` (a pre-paid coil) pours nothing.
 */
export function drainCharge(f, dt, locked = false) {
  const drain = locked ? 0 : Math.min(dt / CHARGE_TIME, f.energy);
  f.energy -= drain;
  f.chargeAmt = Math.min(1, f.chargeAmt + drain);
  return drain;
}

/** The flat toll on a released swing. Sets the gassed flag if it empties the bar. */
export function paySwing(f, energyMul = 1) {
  f.energy = Math.max(0, f.energy - ATTACK_ENERGY_COST * energyMul);
  if (f.energy < ENERGY_ATTACK_FLOOR) f.gassed = true;
}

/**
 * The energy gate. False means this fighter may not START a punch or kick — not
 * a weaker one, none at all — because they have gassed themselves out. Blocking
 * and movement are deliberately still allowed: the guard is the way back up the
 * bar, so the punishment is "you must defend now", not "you are a statue".
 */
export function canAttack(f) {
  return !f.gassed;
}

/** Damage / knockback multiplier of a swing released at `chargeAmt` (0..1). */
export function chargeMultiplier(chargeAmt) {
  return 1 + (CHARGE_MAX_MUL - 1) * chargeAmt;
}
