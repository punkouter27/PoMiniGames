// knockdown.js — the knockdown and the get-up game, as pure rules. fighterTick.js
// and hitResolution.js apply them to the live fighters; tests/pobrawl-core.test.mjs
// runs them alone.
//
// DAZE is a short-lived pool of "how hard have you just been hit". Every landed
// hit adds its damage; it drains quickly. Fill it and the fighter goes down — so
// one well-charged shot does it, and so does a tight string, but pecking away
// with a jab every second never will.
//
// On the canvas the fighter cannot be hit. After DOWN_MIN they may rise whenever
// they like, up to DOWN_MAX, and HOW they rise is the game:
//   • plain rise     — any button; back on the feet, guard down
//   • roll           — a direction held as they rise: the body rolls that way
//   • rise guarding  — block held as the rise ends: the guard goes up that
//                      instant, so a strike timed to meet it is a PERFECT guard
//   • wake-up strike — punch or kick pressed on the way up: it swings as soon
//                      as the feet are under them
// The fighter standing over them picks a timing; the one on the floor picks an
// answer. Neither is safe: a coil timed on the rise eats a perfect guard or a
// roll, and a wake-up strike eats a waiting guard.

export const KNOCKDOWN = Object.freeze({
  /** Daze at which a fighter drops (before body-damage scaling). */
  dazeAt: 30,
  /** Daze drained per second. */
  decayPerSec: 8,
  /** Earliest a downed fighter may rise, and when they are stood up regardless. */
  downMin: 0.7,
  downMax: 2.0,
  /** Seconds from starting to rise to standing. Hurt legs add to it (regionEffect). */
  getup: 0.45,
  /** After standing, daze cannot build for this long: no knockdown loops. */
  immunity: 1.6,
  /** Impulse of a get-up roll (m/s; knockback decays it, so about 1.2 m). */
  rollImpulse: 9.5,
  /** Extra slide the knockdown blow itself adds, scaled by mass ratio. */
  slide: 3.5,
});

/**
 * Daze after `dt` seconds of nobody hitting you.
 */
export function decayDaze(daze, dt) {
  return Math.max(0, daze - KNOCKDOWN.decayPerSec * dt);
}

/**
 * Daze after a landed hit. `dazeMul` is the defender's own head damage
 * (combat.js regionEffect): a rattled head goes down sooner.
 */
export function addDaze(daze, dmg, dazeMul = 1) {
  if (!Number.isFinite(dmg) || dmg <= 0) return daze;
  return daze + dmg * dazeMul;
}

/** Does this much daze put the fighter on the canvas? Never inside the immunity window. */
export function isKnockdown(daze, now, immuneUntil = -Infinity) {
  return now >= immuneUntil && daze >= KNOCKDOWN.dazeAt;
}

/** May a downed fighter start to rise? `wants` = any input; DOWN_MAX stands them up anyway. */
export function shouldRise(downT, wants) {
  return downT >= KNOCKDOWN.downMax || (wants && downT >= KNOCKDOWN.downMin);
}

/**
 * The get-up option an intent asks for, read on the tick the fighter starts to rise.
 * @returns {{ roll: {move:number, side:number}|null, strike: 'punch'|'kick'|null }}
 */
export function getUpChoice(intent) {
  const move = Math.sign(intent?.move || 0);
  const side = Math.sign(intent?.side || 0);
  return {
    roll: move || side ? { move, side } : null,
    strike: intent?.punch ? 'punch' : intent?.kick ? 'kick' : null,
  };
}

/** True while a fighter is on the canvas or rising: they cannot be hit or steer. */
export function isFloored(state) {
  return state === 'down' || state === 'getup';
}

// ── The referee's count ──────────────────────────────────────────────────
// A CPU fight has nobody to mash a button, so a knockdown is counted over like a real bout:
// one number a second, and the fighter on the canvas beats the count on a roll against the
// energy left in the tank. A full tank on the first number is close to a certainty; a gassed
// fighter late in the count is nearly gone. The roll is what gives every count its own story.
export const COUNT = Object.freeze({
  /** Seconds between numbers. */
  step: 1.0,
  /** The number that ends it. */
  max: 10,
  /** Below this the tank has nothing to give: no odds at all. */
  energyFloor: 0.2,
  /** Odds at a full tank on the first number. */
  best: 0.92,
});

/**
 * Odds the downed fighter beats the count on this number: the tank squared (a little energy
 * is not much help) times how much count is left, out of `COUNT.best`.
 */
export function riseOdds(count, energy) {
  const e = Math.max(0, Math.min(1, Number(energy) || 0));
  if (e <= COUNT.energyFloor) return 0;
  const tank = (e - COUNT.energyFloor) / (1 - COUNT.energyFloor);
  const left = Math.max(0, Math.min(1, 1 - (count - 1) / COUNT.max));
  return COUNT.best * tank * tank * left;
}

/** One number of the count. `roll` is Math.random unless a test or a replay supplies one. */
export function beatsCount(count, energy, roll = Math.random()) {
  return roll < riseOdds(count, energy);
}
