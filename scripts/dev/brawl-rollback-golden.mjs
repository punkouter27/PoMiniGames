// brawl-rollback-golden.mjs — the JavaScript half of the online Brawl sim's parity check.
//
//   node scripts/dev/brawl-rollback-golden.mjs
//
// The online fight's rules are written twice and must agree bit for bit:
// src/PoMiniGames.Client/wwwroot/js/pobrawl/rollbackSim.js (each browser) and
// src/PoMiniGames.Shared/Games/PoBrawlRollbackSim.cs (the server). This script
//
//   1. asserts the rules themselves on the JavaScript copy (the same cases the C# test
//      PoBrawlRollbackSimTests asserts on its copy), and
//   2. plays a few long pseudo-random fights and prints their checksums. Those numbers are
//      pasted into PoBrawlRollbackSimTests.Golden, which plays the same fights on the C# copy.
//      Equal checksums on every sampled frame mean the two copies agree.
//
// Change a rule in one copy, change it in the other, run this, and update the test's numbers.
// The input stream comes from the sim's own mulberry32, so both languages draw the same script.

import assert from 'node:assert/strict';

const sim = await import(new URL('../../src/PoMiniGames.Client/wwwroot/js/pobrawl/rollbackSim.js', import.meta.url));
const {
  createState, step, checksum, encodeInput, nextRandom, pack, unpack, statesEqual, TUNING,
  HELD_IDLE, HELD_FORWARD, HELD_BACK, HELD_BLOCK,
  PRESS_NONE, PRESS_PUNCH, PRESS_KICK, PRESS_SPECIAL, PRESS_GRAB, PRESS_TAUNT,
  OUTCOME_HIT, OUTCOME_WHIFF, OUTCOME_BREAK, FLOOR_NONE, ENERGY_MAX, TAUNT_FRAMES,
} = sim;

// ── Helpers shared by the cases ────────────────────────────────────────────────
const FIGHT_START = 5;
/** A fight past its pre-roll, the corners `gap` mm apart around the centre. */
function fightAt(gap) {
  const s = createState(12345, FIGHT_START);
  for (let i = 0; i < FIGHT_START; i++) step(s, 0, 0);
  s.p1.x = -(gap >> 1);
  s.p2.x = gap - (gap >> 1);
  return s;
}
const idle = (s, frames) => { for (let i = 0; i < frames; i++) step(s, 0, 0); };
const press = (p) => encodeInput(-1, p);
const hold = (h) => encodeInput(h, PRESS_NONE);

// ── 1. The rules, on this copy ─────────────────────────────────────────────────
{
  // A grab goes through a held guard, throws, and rolls no dice.
  const s = fightAt(1200);
  step(s, 0, hold(HELD_BLOCK));
  const rng = s.rng, x2 = s.p2.x;
  step(s, press(PRESS_GRAB), 0);
  assert.equal(s.p1.outcome, OUTCOME_HIT);
  assert.equal(s.p1.swing, PRESS_GRAB);
  assert.equal(s.p2.hp, 100 - TUNING.GRAB_DAMAGE);
  assert.equal(s.p2.x, x2 + TUNING.GRAB_THROW_MM);
  assert.equal(s.rng, rng, 'a grab does not move the RNG');
  assert.equal(s.p1.cooldown, TUNING.GRAB_HIT_COOLDOWN - 1);
}
{
  // Any strike beats it: the corner that swings on the same frame cannot be grabbed.
  const s = fightAt(1200);
  step(s, press(PRESS_GRAB), press(PRESS_PUNCH));
  assert.equal(s.p1.outcome, OUTCOME_WHIFF);
  assert.equal(s.p2.outcome, OUTCOME_HIT);
  assert.ok(s.p1.hp < 100 && s.p2.hp === 100);
  assert.equal(s.p1.cooldown, TUNING.GRAB_COOLDOWN - 1, 'grabbing air costs the long cooldown');
}
{
  // ...and neither can one still recovering from a swing.
  const s = fightAt(1200);
  step(s, 0, press(PRESS_KICK));
  step(s, press(PRESS_GRAB), 0);
  assert.equal(s.p1.outcome, OUTCOME_WHIFF);
}
{
  // Out of reach it whiffs; two at once break apart unhurt.
  const far = fightAt(TUNING.GRAB_REACH_MM + 1);
  step(far, press(PRESS_GRAB), 0);
  assert.equal(far.p1.outcome, OUTCOME_WHIFF);
  const both = fightAt(1200);
  step(both, press(PRESS_GRAB), press(PRESS_GRAB));
  assert.equal(both.p1.outcome, OUTCOME_BREAK);
  assert.equal(both.p2.outcome, OUTCOME_BREAK);
  assert.equal(both.p1.hp + both.p2.hp, 200);
  assert.equal(both.p2.x - both.p1.x, 1200 + 2 * TUNING.GRAB_BREAK_MM);
}
{
  // Never the knockout: a throw leaves one point.
  const s = fightAt(1200);
  s.p2.hp = 3;
  step(s, press(PRESS_GRAB), 0);
  assert.equal(s.p2.hp, 1);
  assert.equal(s.over, 0);
}
{
  // A taunt is refused in range, taken out of range, and pays on its last frame.
  const near = fightAt(TUNING.KICK_REACH_MM + TUNING.TAUNT_CLEAR_MM);
  step(near, press(PRESS_TAUNT), 0);
  assert.equal(near.p1.taunt, 0, 'in range: the press is spent');
  assert.equal(near.p1.pending, PRESS_NONE);

  const s = fightAt(4000);
  s.p1.energy = 0;
  step(s, press(PRESS_TAUNT), 0);
  assert.equal(s.p1.taunt, TAUNT_FRAMES - 1);
  assert.equal(s.p1.swing, PRESS_TAUNT);
  const x1 = s.p1.x;
  step(s, hold(HELD_FORWARD), 0);
  assert.equal(s.p1.x, x1, 'a taunting corner does not walk');
  const before = s.p1.energy;
  idle(s, TAUNT_FRAMES - 3);
  assert.equal(s.p1.taunt, 1);
  step(s, 0, 0);
  assert.equal(s.p1.taunt, 0);
  assert.ok(s.p1.energy >= before + TUNING.TAUNT_ENERGY, 'the bar jumps as it ends');
  step(s, press(PRESS_TAUNT), 0);
  assert.equal(s.p1.taunt, 0, 'on cooldown: the press is spent');
}
{
  // Caught showing off: the blow does 125% and the taunt is over, with nothing gained.
  const s = fightAt(4000);
  step(s, press(PRESS_TAUNT), 0);
  s.p2.x = s.p1.x + 1400;                        // the other corner is suddenly in kick range
  const twin = unpack(pack(s));
  twin.p1.taunt = 0;                             // the same kick on a corner that is not taunting
  step(s, 0, press(PRESS_KICK));
  step(twin, 0, press(PRESS_KICK));
  assert.equal(s.p1.taunt, 0);
  assert.equal(s.p2.damage, ((twin.p2.damage * TUNING.TAUNT_PUNISH_PCT + 50) / 100) | 0);
  assert.ok(s.p2.damage > twin.p2.damage);
  // A taunting corner can be grabbed even though it is not "recovering".
  const g = fightAt(4000);
  step(g, press(PRESS_TAUNT), 0);
  g.p2.x = g.p1.x + 1200;
  step(g, 0, press(PRESS_GRAB));
  assert.equal(g.p2.outcome, OUTCOME_HIT);
  assert.equal(g.p1.hp, 100 - (((TUNING.GRAB_DAMAGE * TUNING.TAUNT_PUNISH_PCT + 50) / 100) | 0));
}
{
  // The wire layout round-trips, with the two new ints per corner.
  const s = fightAt(4000);
  step(s, press(PRESS_TAUNT), 0);
  assert.equal(pack(s).length, TUNING.PACKED_LENGTH);
  assert.equal(TUNING.PACKED_LENGTH, 42);
  assert.ok(statesEqual(s, unpack(pack(s))));
  assert.equal(FLOOR_NONE, 0);
  assert.ok(ENERGY_MAX > 0 && HELD_IDLE === 0 && HELD_BACK === 2 && PRESS_SPECIAL === 6);
}
console.log('rules: ok');

// ── 2. The golden fights ───────────────────────────────────────────────────────
// Each frame, each corner has a 12% chance of an input event: a held state, and three times
// in eight a press (every kind, grabs and taunts included). Drawn from mulberry32 with its own
// seed, so PoBrawlRollbackSimTests.Golden draws the identical stream.
const PRESSES = [PRESS_NONE, PRESS_NONE, PRESS_PUNCH, PRESS_KICK, PRESS_SPECIAL, PRESS_GRAB, PRESS_TAUNT, PRESS_PUNCH,
  PRESS_NONE, PRESS_NONE, PRESS_NONE, PRESS_GRAB, PRESS_NONE, PRESS_KICK, PRESS_NONE, PRESS_TAUNT];
const SAMPLE_EVERY = 400;
const FRAMES = 4000;

function drawInput(holder) {
  if (nextRandom(holder) % 100 >= 12) return 0;
  const held = nextRandom(holder) % 4;
  const p = PRESSES[nextRandom(holder) % PRESSES.length];
  return encodeInput(held, p);
}

function golden(seed) {
  const s = createState(seed, 30);
  const script = { rng: (seed ^ 0x5bd1e995) | 0 };
  const sums = [];
  const seen = { grab: 0, taunt: 0 };
  let lastSwing = [-1, -1];
  for (let f = 1; f <= FRAMES; f++) {
    const i1 = drawInput(script);
    const i2 = drawInput(script);
    step(s, i1, i2);
    [s.p1, s.p2].forEach((c, i) => {
      if (c.swingFrame === lastSwing[i]) return;
      lastSwing[i] = c.swingFrame;
      if (c.swing === PRESS_GRAB && c.outcome === OUTCOME_HIT) seen.grab++;
      if (c.swing === PRESS_TAUNT) seen.taunt++;
    });
    if (f % SAMPLE_EVERY === 0) sums.push(checksum(s));
  }
  return { seed, sums, hp: [s.p1.hp, s.p2.hp], over: s.over, winner: s.winner, seen };
}

console.log('\n// Paste into PoBrawlRollbackSimTests.Golden (from scripts/dev/brawl-rollback-golden.mjs):');
for (const seed of [1, 2026, 48879, 777]) {
  const g = golden(seed);
  // A golden fight that never grabs or taunts would not be checking the new rules.
  assert.ok(g.seen.grab > 0 && g.seen.taunt > 0, `seed ${seed}: grabs landed ${g.seen.grab}, taunts ${g.seen.taunt}`);
  console.log(`        [${seed}u, ${g.hp[0]}, ${g.hp[1]}, ${g.winner}, ${g.sums.map((x) => `${x}u`).join(', ')}],`
    + `   // grabs landed ${g.seen.grab}, taunts ${g.seen.taunt}`);
}
