// corner.js — one line from the corner between rounds: what the round just showed, and what to
// do about it. Pure rules over the round's two scorecards (rounds.js blankStats) and the
// opponent's signature phrases (personalities.js aiPatterns), so they run headless.
//
// Scripted, like the commentary: a list of rules, worst problem first, the first that applies
// wins. A phrase is described FROM ITS STEPS, never from a hand-written note, so the advice
// cannot drift away from the pattern it is about.
//
// cinematics.js _roundOver asks once per round break in the 1P ladder and shows the answer
// until the next bell. No key names here: the same line serves keyboard, pad and touch.

/** How a phrase step reads aloud. A coil (`charge`) is the beat worth guarding. */
function stepWord(step) {
  const kick = step.attack === 'kick';
  switch (step.act) {
    case 'punch': return 'a jab';
    case 'kick': return 'a kick';
    case 'charge': return kick ? 'a wound-up kick' : 'a wound-up punch';
    case 'block': return 'a guard';
    case 'advance': return 'a step in';
    case 'retreat': return 'a step back';
    case 'sidestep': return 'a sidestep';
    default: return 'a pause';
  }
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

/**
 * A signature phrase as a sentence: its beats in order, then which one to guard.
 * "A jab, a jab, then a wound-up punch. Guard the third beat."
 * @returns {string} '' when the phrase has no steps
 */
export function describePhrase(phrase) {
  const steps = phrase?.steps || [];
  if (!steps.length) return '';
  const words = steps.map(stepWord);
  const beats = words.length === 1 ? words[0]
    : `${words.slice(0, -1).join(', ')}, then ${words[words.length - 1]}`;
  // The heaviest beat is the last coil; a phrase with none ends on its last strike.
  let key = -1;
  steps.forEach((s, i) => { if (s.act === 'charge') key = i; });
  if (key < 0) steps.forEach((s, i) => { if (s.act === 'punch' || s.act === 'kick') key = i; });
  const sentence = beats.charAt(0).toUpperCase() + beats.slice(1);
  if (key < 0) return `${sentence}.`;
  const which = key === steps.length - 1 ? 'last' : (ORDINALS[key] || 'big');
  return `${sentence}. Guard the ${which} beat.`;
}

const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (b || 0), 0);

/**
 * The corner's line for the round that just ended, or '' when there is nothing to say.
 * @param r.me       the player's round scorecard
 * @param r.opp      the opponent's round scorecard
 * @param r.won      the player took the round
 * @param r.oppName  the opponent's name
 * @param r.phrases  the opponent's signature phrases (personalities.js aiPatterns), if any
 */
export function cornerAdvice({ me, opp, won = false, oppName = '', phrases = null } = {}) {
  if (!me || !opp) return '';
  const who = oppName || 'Your opponent';

  // 1. One of the opponent's phrases did the damage: name its beats.
  const byPhrase = Object.entries(opp.phraseHits || {}).sort((a, b) => b[1] - a[1])[0];
  if (byPhrase && byPhrase[1] >= 2 && phrases?.[byPhrase[0]]) {
    const read = describePhrase(phrases[byPhrase[0]]);
    if (read) return `${who} keeps catching you with the same string. ${read}`;
  }
  // 2. Ran the bar dry.
  if (me.gassed >= 2) {
    return `You ran out of energy ${me.gassed} times. Hold your guard to refill before you swing.`;
  }
  // 3. Took a beating without ever guarding.
  if (opp.hits >= 4 && me.blocks === 0) {
    return `You did not block once. Put the guard up when ${who} winds up.`;
  }
  // 4. The opponent hid behind the guard.
  if (opp.blocks >= 4 && me.grabs === 0) {
    return `${who} is hiding behind the guard. Grab: punch and kick together goes straight through it.`;
  }
  // 5. Most of the damage went to one place.
  const taken = me.taken || {};
  const total = sum(taken);
  if (total >= 30) {
    if (taken.head >= total * 0.5) return 'Most of that landed on your head, and a hurt head goes down sooner. Keep the guard high.';
    if (taken.legs >= total * 0.4) return 'Your legs are taking the kicks. Step out of range or guard when the knee comes up.';
    if (taken.torso >= total * 0.6) return 'Body shots are slowing your energy. Guard more, swing less, and let the bar come back.';
  }
  // 6. Swinging at air.
  if (me.thrown >= 6 && me.hits / me.thrown < 0.4) {
    return `Only ${me.hits} of ${me.thrown} landed. Step in closer before you throw.`;
  }
  // 7. Went down.
  if (opp.knockdowns >= 1) {
    return 'On the canvas, hold the guard as you rise. It stops the strike timed on your get-up.';
  }
  // 8. Never charged a strike.
  if (me.thrown >= 6 && me.coils === 0) {
    return 'Hold the button to wind a strike up. A full one hits four times as hard as a tap.';
  }
  // 9. Guards, but never on the wind-up.
  if (me.blocks >= 3 && me.perfects === 0) {
    return `You are guarding early. Put it up as ${who} winds up: a timed guard freezes them for a free hit.`;
  }
  if (won) return 'Good round. Same again.';
  return `${who} took that one. Guard the wind-up, then answer.`;
}
