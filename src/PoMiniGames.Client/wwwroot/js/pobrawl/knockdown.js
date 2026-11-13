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
