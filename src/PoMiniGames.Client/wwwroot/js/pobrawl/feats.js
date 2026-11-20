// feats.js — Brawl feats: what a fighter did in a round that is worth a badge. Pure rules over
// the round's scorecard (rounds.js blankStats), so they run headless.
//
// The engine asks at the end of every round (cinematics.js _roundOver) and reports the ids
// with the match result; the page stores them (PoBrawlProgressBook) and the achievement rules
// read them (AchievementService). The ids are the contract with both: keep them in step with
// PoBrawlFeats.cs.

export const FEATS = Object.freeze([
  'flawless', 'comeback', 'no-kicks', 'wakeup-ko', 'counter-ko', 'quick-ko',
  'perfect-3', 'combo-5', 'crate-crash', 'guard-breaker', 'showboat',
]);

/** A round one knockout this fast is 'quick-ko' (seconds on the round clock). */
export const QUICK_KO_SECS = 15;
/** Health at or under which a round still won is a 'comeback'. */
export const COMEBACK_HP = 10;
/** A 'no-kicks' round needs at least this many strikes thrown, so standing still is not one. */
const NO_KICKS_MIN_THROWN = 4;

/**
 * The feats one corner earned in one round.
 * @param r.won    this corner took the round
 * @param r.ko     the round ended in a knockout
 * @param r.secs   the round clock at the finish
 * @param r.hp     this corner's health at the finish
 * @param r.maxHp  full health
 * @param r.me     this corner's scorecard
 * @param r.opp    the other corner's scorecard
 * @returns {string[]} ids from FEATS, in FEATS order
 */
export function roundFeats({ won = false, ko = false, secs = 0, hp = 0, maxHp = 100, me, opp } = {}) {
  if (!me || !opp) return [];
  const got = new Set();
  if (won) {
    if (hp >= maxHp) got.add('flawless');
    if ((me.lowHp ?? maxHp) <= COMEBACK_HP) got.add('comeback');
    if (me.kicks === 0 && me.thrown >= NO_KICKS_MIN_THROWN) got.add('no-kicks');
    if (me.taunts > 0) got.add('showboat');
    if (ko) {
      if (me.finisher === 'wakeup') got.add('wakeup-ko');
      if (me.finisher === 'counter') got.add('counter-ko');
      if (secs > 0 && secs <= QUICK_KO_SECS) got.add('quick-ko');
    }
  }
  if (me.perfects >= 3) got.add('perfect-3');
  if (me.bestCombo >= 5) got.add('combo-5');
  if (opp.crateHits > 0) got.add('crate-crash');
  if (me.guardBreaks > 0) got.add('guard-breaker');
  return FEATS.filter((id) => got.has(id));
}
