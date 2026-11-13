// PoBrawl 1v1 core rules, headless: the numbers a fight is decided by, with no scene.
//
//   combat.js     health / armor / winner, region damage effects, which hand punches
//   energy.js     the energy bar: regen, the coil, the swing toll, the gassed gate
//   knockdown.js  daze, the knockdown, the get-up choices
//   rounds.js     best of three
//   ai.js         the CPU's intents against a scripted context (rng.js seeds it)
//
// These modules import nothing from three.js, which is what lets Node load them.
// CI runs this file (deploy.yml).
//
// Run: node --test tests/pobrawl-core.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const at = (name) => new URL(`../src/PoMiniGames.Client/wwwroot/js/pobrawl/${name}`, import.meta.url);
const combat = await import(at('combat.js'));
const energy = await import(at('energy.js'));
const kd = await import(at('knockdown.js'));
const rounds = await import(at('rounds.js'));
const { ATTACKS, MAX_HP, HITSTUN } = await import(at('constants.js'));
const { AiController } = await import(at('ai.js'));
const { RandomGenerator } = await import(at('rng.js'));

const DT = 1 / 60;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ── combat.js: CombatPlay ────────────────────────────────────────────────────

function twoPlayers() {
  const c = new combat.CombatPlay({ maxHealth: MAX_HP });
  c.addPlayer({ playerId: 'p1', teamId: '1' });
  c.addPlayer({ playerId: 'p2', teamId: '2' });
  return c;
}

test('combat: no damage lands before the bell', () => {
  const c = twoPlayers();
  assert.equal(c.damage({ playerId: 'p2', amount: 10 }), 0);
  assert.equal(c.getPlayer('p2').health, MAX_HP);
});

test('combat: damage takes health, and bad amounts are a no-op', () => {
  const c = twoPlayers();
  c.startGame();
  assert.equal(c.damage({ playerId: 'p2', amount: 30 }), 30);
  assert.equal(c.getPlayer('p2').health, 70);
  for (const amount of [NaN, -5, 0, Infinity]) {
    assert.equal(c.damage({ playerId: 'p2', amount }), 0, `amount ${amount}`);
  }
  assert.equal(c.getPlayer('p2').health, 70);
  assert.equal(c.damage({ playerId: 'nobody', amount: 5 }), 0);
});

test('combat: the killing blow queues the kill, then the finish, and names the winner', () => {
  const c = twoPlayers();
  c.startGame();
  assert.deepEqual(c.step(), []);
  // Overkill is clamped to the health that was left.
  assert.equal(c.damage({ playerId: 'p2', amount: 250, sourceId: 'p1' }), MAX_HP);
  const events = c.step();
  assert.deepEqual(events.map((e) => e.type),
    [combat.COMBAT_EVENTS.PLAYER_KILLED, combat.COMBAT_EVENTS.COMBAT_FINISHED]);
  assert.equal(events[0].playerId, 'p2');
  assert.equal(events[0].sourceId, 'p1');
  assert.equal(events[1].winnerTeamId, '1');
  // A finished fight takes no more damage and reports nothing twice.
  assert.equal(c.damage({ playerId: 'p1', amount: 10 }), 0);
  assert.deepEqual(c.step(), []);
});

test('combat: armor soaks its share until it is gone', () => {
  const c = new combat.CombatPlay({ maxHealth: 100, armorAbsorption: 0.6 });
  c.addPlayer({ playerId: 'a', teamId: '1', armor: 6 });
  c.addPlayer({ playerId: 'b', teamId: '2' });
  c.startGame();
  // 10 in: 6 to armor (all of it), 4 to health.
  assert.equal(c.damage({ playerId: 'a', amount: 10 }), 4);
  assert.equal(c.getPlayer('a').armor, 0);
  assert.equal(c.damage({ playerId: 'a', amount: 10 }), 10);
});

// ── combat.js: region damage ────────────────────────────────────────────────

test('regions: an unhurt body has no penalties', () => {
  assert.deepEqual(combat.regionEffect({ head: 0, torso: 0, arms: 0, legs: 0 }), {
    flinchBonus: 0, dazeMul: 1, regenMul: 1, atkMul: 1, guardLeak: 0, moveMul: 1, getupPenalty: 0,
  });
  // Missing regions read as unhurt, not NaN.
  assert.deepEqual(combat.regionEffect({}), combat.regionEffect({ head: 0, torso: 0, arms: 0, legs: 0 }));
});

test('regions: every region costs its owner something, and more at the second step', () => {
  const fx = (r) => combat.regionEffect({ head: 0, torso: 0, arms: 0, legs: 0, ...r });
  const steps = {
    head: ['flinchBonus', 'dazeMul'],
    torso: ['regenMul'],
    arms: ['atkMul', 'guardLeak'],
    legs: ['moveMul', 'getupPenalty'],
  };
  const clean = fx({});
  for (const [region, fields] of Object.entries(steps)) {
    const [lo, hi] = combat.REGION_TIERS[region];
    const hurt = fx({ [region]: lo }), wrecked = fx({ [region]: hi });
    assert.deepEqual(fx({ [region]: lo - 1 }), clean, `${region} under its first step`);
    for (const f of fields) {
      const worse = (a, b) => Math.abs(a - clean[f]) > Math.abs(b - clean[f]);
      assert.ok(worse(hurt[f], clean[f]), `${region}.${f} at ${lo}`);
      assert.ok(worse(wrecked[f], hurt[f]), `${region}.${f} at ${hi}`);
    }
    // And nothing outside its own fields moves.
    for (const f of Object.keys(clean)) {
      if (!fields.includes(f)) assert.equal(wrecked[f], clean[f], `${region} must not touch ${f}`);
    }
  }
});

test('regions: tiers and their ring calls line up', () => {
  for (const region of Object.keys(combat.REGION_TIERS)) {
    const [lo, hi] = combat.REGION_TIERS[region];
    assert.equal(combat.regionTier(region, lo - 1), 0);
    assert.equal(combat.regionTier(region, lo), 1);
    assert.equal(combat.regionTier(region, hi), 2);
    assert.equal(combat.REGION_CALLOUTS[region].length, 2);
  }
  assert.equal(combat.regionTier('tail', 100), 0);
});

// ── combat.js: which hand ───────────────────────────────────────────────────

test('hands: taps go jab, cross, jab; a coil is the right; a stale jab starts over', () => {
  const pick = combat.pickPunchArm;
  const jab = pick({});
  assert.deepEqual(jab, { arm: 'L', dmgMul: combat.JAB_DMG_MUL });
  const cross = pick({ lastArm: 'L', sinceLast: 0.3 });
  assert.deepEqual(cross, { arm: 'R', dmgMul: combat.CROSS_DMG_MUL });
  assert.equal(pick({ lastArm: 'R', sinceLast: 0.3 }).arm, 'L');
  assert.equal(pick({ lastArm: 'L', sinceLast: combat.ONE_TWO_WINDOW + 0.01 }).arm, 'L');
  assert.deepEqual(pick({ chargeAmt: 0.6, lastArm: 'R', sinceLast: 0.1 }), { arm: 'R', dmgMul: 1 });
  // The one-two is worth more than two jabs, and no hand is free damage.
  assert.ok(combat.JAB_DMG_MUL + combat.CROSS_DMG_MUL > 2 * combat.JAB_DMG_MUL);
  assert.ok(combat.JAB_DMG_MUL < 1 && combat.CROSS_DMG_MUL > 1);
});

test('hands: a fighter punches with whatever arm is left', () => {
  const pick = combat.pickPunchArm;
  assert.deepEqual(pick({ armsLost: new Set(['L']) }), { arm: 'R', dmgMul: 1 });
  assert.deepEqual(pick({ armsLost: new Set(['R']), chargeAmt: 1 }), { arm: 'L', dmgMul: 1 });
  assert.equal(pick({ armsLost: new Set(['L', 'R']) }), null);
});

// ── energy.js ───────────────────────────────────────────────────────────────

const fighter = (o = {}) => ({ state: 'idle', energy: energy.ENERGY_DEFAULT, gassed: false, chargeAmt: 0, ...o });
const run = (f, secs, opts) => { for (let t = 0; t < secs - 1e-9; t += DT) energy.tickEnergy(f, DT, opts); };

test('energy: the guard refills fastest, standing slowly, swinging and coiling not at all', () => {
  assert.ok(energy.regenRate('block') > 3 * energy.regenRate('idle'));
  assert.ok(energy.regenRate('idle') > energy.regenRate('hitstun'));
  assert.ok(energy.regenRate('hitstun') > 0);
  for (const s of ['punch', 'kick', 'charge', 'ko']) assert.equal(energy.regenRate(s), 0, s);
  // The canvas breathes like standing.
  assert.equal(energy.regenRate('down'), energy.regenRate('idle'));
  assert.equal(energy.regenRate('getup'), energy.regenRate('idle'));

  const blocker = fighter({ state: 'block', energy: 0 }), idler = fighter({ energy: 0 });
  run(blocker, 1); run(idler, 1);
  near(blocker.energy, energy.ENERGY_BLOCK_REGEN_PER_SEC, 1e-6);
  near(idler.energy, energy.ENERGY_REGEN_PER_SEC, 1e-6);
  run(blocker, 5);
  assert.equal(blocker.energy, 1, 'the bar never overfills');
});

test('energy: tap-spam gasses a fighter out — four kicks or eight punches to a bar', () => {
  const swingsToGas = (name) => {
    const f = fighter();
    let n = 0;
    while (energy.canAttack(f) && n < 50) { energy.paySwing(f, ATTACKS[name].energyMul); n++; }
    return n;
  };
  assert.equal(swingsToGas('kick'), 4);
  assert.equal(swingsToGas('punch'), 8);
});

test('energy: gassed is a band, not a line — recovery needs more than the floor', () => {
  const f = fighter({ energy: energy.ENERGY_ATTACK_FLOOR - 0.01 });
  assert.equal(energy.tickEnergy(f, DT), true, 'the flag flip is reported');
  assert.equal(f.gassed, true);
  assert.equal(energy.canAttack(f), false);
  // Back over the floor is not enough.
  f.energy = (energy.ENERGY_ATTACK_FLOOR + energy.ENERGY_RECOVER_TO) / 2;
  assert.equal(energy.tickEnergy(f, DT), false);
  assert.equal(f.gassed, true);
  f.energy = energy.ENERGY_RECOVER_TO;
  assert.equal(energy.tickEnergy(f, DT), true);
  assert.equal(energy.canAttack(f), true);
  // Guarding is the quick way back: under a second from empty.
  const g = fighter({ state: 'block', energy: 0, gassed: true });
  run(g, 0.8);
  assert.equal(g.gassed, false);
});

test('energy: the coil is paid for out of the bar and cannot outgrow it', () => {
  const f = fighter({ state: 'charge' });
  for (let t = 0; t < energy.CHARGE_TIME / 2 - 1e-9; t += DT) energy.drainCharge(f, DT);
  near(f.chargeAmt, 0.5, 1e-6);
  near(f.energy, 0.5, 1e-6);
  near(energy.chargeMultiplier(f.chargeAmt), 1 + (energy.CHARGE_MAX_MUL - 1) / 2, 1e-6);
  // A third of a bar loads a third of a coil, however long it is held.
  const poor = fighter({ state: 'charge', energy: 1 / 3 });
  for (let i = 0; i < 300; i++) energy.drainCharge(poor, DT);
  near(poor.chargeAmt, 1 / 3, 1e-6);
  near(poor.energy, 0, 1e-9);
  assert.equal(energy.chargeMultiplier(0), 1);
  assert.equal(energy.chargeMultiplier(1), energy.CHARGE_MAX_MUL);
  // A pre-paid coil (the lock) pours nothing.
  const locked = fighter({ state: 'charge', chargeAmt: 1 });
  energy.drainCharge(locked, DT, true);
  assert.equal(locked.energy, 1);
});

test('energy: bruised ribs slow the bar, and a lock freezes it', () => {
  const clean = fighter({ energy: 0 }), winded = fighter({ energy: 0 });
  run(clean, 2);
  run(winded, 2, { regenMul: combat.regionEffect({ torso: 70 }).regenMul });
  near(winded.energy / clean.energy, 0.6, 1e-6);
  const locked = fighter({ state: 'block', energy: 0.5 });
  run(locked, 1, { locked: true });
  assert.equal(locked.energy, 0.5);
});

// ── knockdown.js ────────────────────────────────────────────────────────────

test('knockdown: one heavy shot drops a fighter, a jab every second never does', () => {
  const K = kd.KNOCKDOWN;
  const halfChargedKick = ATTACKS.kick.dmg * energy.chargeMultiplier(0.5);
  assert.ok(kd.isKnockdown(kd.addDaze(0, halfChargedKick), 0), 'a half-charged kick');
  assert.ok(!kd.isKnockdown(kd.addDaze(0, ATTACKS.kick.dmg), 0), 'one tapped kick does not');

  let daze = 0;
  for (let n = 0; n < 60; n++) {
    daze = kd.addDaze(daze, ATTACKS.punch.dmg);
    assert.ok(!kd.isKnockdown(daze, n), `jab ${n}`);
    for (let t = 0; t < 1 - 1e-9; t += DT) daze = kd.decayDaze(daze, DT);
  }
  assert.equal(daze, 0);
  assert.ok(K.decayPerSec > ATTACKS.punch.dmg, 'the drain outpaces a jab a second');
});

test('knockdown: a tight string does what its hits alone cannot', () => {
  // Three tapped kicks as fast as the cancel window allows.
  const gap = ATTACKS.kick.cancelInto.kick;
  let daze = 0, down = false;
  for (let n = 0; n < 3 && !down; n++) {
    daze = kd.addDaze(daze, ATTACKS.kick.dmg);
    down = kd.isKnockdown(daze, 0);
    for (let t = 0; t < gap - 1e-9; t += DT) daze = kd.decayDaze(daze, DT);
  }
  assert.ok(down);
  // The same three a second apart: on their feet.
  daze = 0;
  for (let n = 0; n < 3; n++) {
    daze = kd.addDaze(daze, ATTACKS.kick.dmg);
    assert.ok(!kd.isKnockdown(daze, 0));
    for (let t = 0; t < 1.5; t += DT) daze = kd.decayDaze(daze, DT);
  }
});

test('knockdown: a rattled head goes down sooner, and nobody is looped', () => {
  const dmg = 22;
  assert.ok(!kd.isKnockdown(kd.addDaze(0, dmg), 0));
  assert.ok(kd.isKnockdown(kd.addDaze(0, dmg, combat.regionEffect({ head: 70 }).dazeMul), 0));
  // Inside the immunity window a full pool still does not drop them.
  assert.ok(!kd.isKnockdown(999, 5, 5 + kd.KNOCKDOWN.immunity));
  assert.ok(kd.isKnockdown(999, 5 + kd.KNOCKDOWN.immunity, 5 + kd.KNOCKDOWN.immunity));
  // Garbage in is ignored.
  for (const bad of [NaN, -3, 0]) assert.equal(kd.addDaze(7, bad), 7);
  assert.equal(kd.decayDaze(0.01, 1), 0);
});

test('get-up: not before the minimum, on any input after it, and regardless at the maximum', () => {
  const K = kd.KNOCKDOWN;
  assert.equal(kd.shouldRise(K.downMin - 0.01, true), false);
  assert.equal(kd.shouldRise(K.downMin, true), true);
  assert.equal(kd.shouldRise(K.downMax - 0.01, false), false);
  assert.equal(kd.shouldRise(K.downMax, false), true);
  assert.ok(K.downMin < K.downMax);
  for (const s of ['down', 'getup']) assert.equal(kd.isFloored(s), true);
  for (const s of ['idle', 'block', 'hitstun', 'ko', 'punch']) assert.equal(kd.isFloored(s), false);
});

test('get-up: what is held picks how', () => {
  assert.deepEqual(kd.getUpChoice({ move: 0, side: 0, block: true }), { roll: null, strike: null });
  assert.deepEqual(kd.getUpChoice({ move: -1, side: 0 }), { roll: { move: -1, side: 0 }, strike: null });
  assert.deepEqual(kd.getUpChoice({ move: 0, side: 1, kick: true }), { roll: { move: 0, side: 1 }, strike: 'kick' });
  assert.equal(kd.getUpChoice({ punch: true, kick: true }).strike, 'punch');
  assert.deepEqual(kd.getUpChoice(undefined), { roll: null, strike: null });
});

// ── rounds.js ───────────────────────────────────────────────────────────────

function play(...winners) {
  const m = rounds.newMatch();
  const verdicts = winners.map((w) => { rounds.recordRound(m, w); return rounds.matchVerdict(m); });
  return { m, verdicts, last: verdicts[verdicts.length - 1] };
}

test('rounds: first to two takes it, and stops there', () => {
  assert.deepEqual(play(1, 1).verdicts, [null, { winner: 1 }]);
  assert.deepEqual(play(2, 2).last, { winner: 2 });
  assert.deepEqual(play(1, 2, 2).verdicts, [null, null, { winner: 2 }]);
  assert.deepEqual(play(2, 1, 1).last, { winner: 1 });
});

test('rounds: a drawn round is nobody\'s point, and three rounds is the limit', () => {
  assert.deepEqual(play(0, 1, 1).last, { winner: 1 });
  assert.deepEqual(play(1, 0, 0).last, { winner: 1 }, 'ahead on rounds after three');
  assert.deepEqual(play(0, 0, 2).last, { winner: 2 });
  assert.deepEqual(play(1, 0, 2).last, { winner: 0 }, 'level on rounds is a drawn match');
  assert.deepEqual(play(0, 0, 0).last, { winner: 0 });
  const { m } = play(0, 2, 1);
  assert.deepEqual(m.wins, [1, 1]);
  assert.deepEqual(m.log, [0, 2, 1]);
  assert.equal(m.played, rounds.MAX_ROUNDS);
});

test('rounds: wouldDecide agrees with the verdict and does not touch the match', () => {
  for (const script of [[1], [0], [1, 2], [0, 0], [2, 0], []]) {
    for (const next of [0, 1, 2]) {
      const { m } = play(...script);
      if (script.length && rounds.matchVerdict(m)) continue;
      const before = JSON.stringify(m);
      const predicted = rounds.wouldDecide(m, next);
      assert.equal(JSON.stringify(m), before);
      rounds.recordRound(m, next);
      assert.equal(predicted, rounds.matchVerdict(m) !== null, `${script} then ${next}`);
    }
  }
});

test('rounds: the scorecard adds counts and keeps bests', () => {
  const m = rounds.newMatch();
  rounds.recordRound(m, 1, [
    { hits: 5, blocks: 2, biggestHit: 30, bestCombo: 3, knockdowns: 1 },
    { hits: 4, blocks: 1, biggestHit: 12, bestCombo: 2, knockdowns: 0 },
  ]);
  rounds.recordRound(m, 2, [
    { hits: 2, blocks: 4, biggestHit: 18, bestCombo: 5, knockdowns: 0 },
    { hits: 7, blocks: 0, biggestHit: 44, bestCombo: 2 },
  ]);
  assert.deepEqual(m.stats[0], { hits: 7, blocks: 6, biggestHit: 30, bestCombo: 5, knockdowns: 1 });
  assert.deepEqual(m.stats[1], { hits: 11, blocks: 1, biggestHit: 44, bestCombo: 2, knockdowns: 0 });
});

test('rounds: only a round-one knockout by that corner is a fastest-KO time', () => {
  const m = rounds.newMatch();
  assert.equal(rounds.firstRoundKo(m, 1), 0, 'nothing played yet');
  rounds.recordRound(m, 1, null, { ko: true, secs: 12.5 });
  rounds.recordRound(m, 1, null, { ko: true, secs: 4.2 });
  assert.equal(rounds.firstRoundKo(m, 1), 12.5, 'the faster KO in round two does not count');
  assert.equal(rounds.firstRoundKo(m, 2), 0);
  // Round one on points, round two by KO: no time.
  const d = rounds.newMatch();
  rounds.recordRound(d, 1, null, { ko: false, secs: 60 });
  rounds.recordRound(d, 1, null, { ko: true, secs: 9 });
  assert.equal(rounds.firstRoundKo(d, 1), 0);
  // Lost round one by KO, then won the match: no time either.
  const c = rounds.newMatch();
  rounds.recordRound(c, 2, null, { ko: true, secs: 8 });
  rounds.recordRound(c, 1, null, { ko: true, secs: 5 });
  rounds.recordRound(c, 1, null, { ko: true, secs: 6 });
  assert.equal(rounds.firstRoundKo(c, 1), 0);
  assert.equal(rounds.firstRoundKo(c, 2), 8);
});

test('rounds: the splash names the round', () => {
  const m = rounds.newMatch();
  assert.equal(rounds.roundLabel(m), 'ROUND 1');
  rounds.recordRound(m, 0);
  assert.equal(rounds.roundLabel(m), 'ROUND 2');
  const n = rounds.newMatch();
  rounds.recordRound(n, 2);
  assert.equal(rounds.roundLabel(n), 'ROUND 2 · MATCH POINT');
  rounds.recordRound(n, 1);
  assert.equal(rounds.roundLabel(n), 'FINAL ROUND');
});

// ── ai.js ───────────────────────────────────────────────────────────────────

// The context fighterTick.js _aiContext builds, for a fighter standing in range of an idle opponent.
const ctx = (o = {}) => ({
  dt: DT, distance: 1.2, kickRange: 1.75,
  backRoom: 5, sideRoomPos: 5, sideRoomNeg: 5, ropeDist: 4,
  selfHp: 1, opponentHp: 1, clock: 10, timeLimit: 60,
  opponentSwingLeft: 0, opponentCharging: false, opponentChargeT: 0,
  opponentBlockStun: 0, opponentHitstunLeft: 0,
  selfState: 'idle', selfCharge: 0, canSuper: false, towardX: 1,
  opponentWindup: false, opponentActive: false, opponentRecover: false, opponentState: 'idle',
  ownAttacks: ATTACKS, superMeterFull: false,
  selfExhausted: false, selfEnergy: 1, opponentExhausted: false,
  opponentFloored: false, opponentRiseIn: 0, selfDownT: 0,
  ...o,
});
const ai = (level, seed = 7, charId = null) => new AiController(level, new RandomGenerator(seed), charId);
const pressed = (i) => !!(i.punch || i.kick);

/** Run `secs` of ticks; `c` may be a function of elapsed time. Returns every intent. */
function drive(bot, secs, c) {
  const out = [];
  for (let t = 0; t < secs; t += DT) out.push(bot.update(typeof c === 'function' ? c(t) : c));
  return out;
}

test('ai: every intent has the shape the engine reads', () => {
  for (const level of [1, 8, 16, 'easy', 'hard']) {
    for (const i of drive(ai(level), 6, ctx())) {
      assert.ok([-1, 0, 1].includes(i.move) && [-1, 0, 1].includes(i.side), JSON.stringify(i));
      assert.equal(typeof i.block, 'boolean');
      assert.ok(!(i.punch && i.kick), 'never both buttons on one tick');
    }
  }
});

test('ai: the same seed fights the same fight', () => {
  const a = drive(ai(9, 42, 'nixon'), 8, ctx()), b = drive(ai(9, 42, 'nixon'), 8, ctx());
  assert.deepEqual(a, b);
});

test('ai: the top rung attacks far more than the bottom one', () => {
  const presses = (level) => {
    let n = 0;
    for (let seed = 1; seed <= 6; seed++) n += drive(ai(level, seed), 20, ctx()).filter(pressed).length;
    return n;
  };
  const low = presses(1), high = presses(16);
  assert.ok(low > 0, 'rung 1 still swings');
  assert.ok(high > low * 2, `rung 16 pressed ${high}, rung 1 pressed ${low}`);
});

test('ai: gassed, it guards and never presses', () => {
  for (const level of [1, 16]) {
    const out = drive(ai(level), 3, ctx({ selfExhausted: true }));
    assert.ok(out.every((i) => i.block && !pressed(i) && !i.punchHeld && !i.kickHeld));
  }
});

test('ai: it does not back into the ropes', () => {
  for (const level of [1, 8, 16]) {
    const out = drive(ai(level, 3), 10, ctx({ backRoom: 0.3, ropeDist: 0.3, selfExhausted: true, distance: 1 }));
    assert.ok(out.every((i) => i.move >= 0), `rung ${level} walked back with no room`);
    assert.ok(out.some((i) => i.side !== 0), 'it slides out sideways instead');
  }
});

test('ai: it never swings at an opponent on the canvas', () => {
  for (const level of [1, 8, 16]) {
    for (let seed = 1; seed <= 8; seed++) {
      const out = drive(ai(level, seed), 1.5, ctx({ opponentFloored: true, opponentState: 'down' }));
      assert.ok(out.every((i) => !pressed(i)), `rung ${level} seed ${seed}`);
    }
  }
});

test('ai: some top-rung knockdowns are met with a coil timed on the rise', () => {
  let coils = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const bot = ai(16, seed);
    drive(bot, 0.8, ctx({ opponentFloored: true, opponentState: 'down' }));
    const out = drive(bot, 0.4, ctx({ opponentFloored: true, opponentState: 'getup', opponentRiseIn: 0.3 }));
    if (out.some((i) => (i.punch && i.punchHeld) || (i.kick && i.kickHeld))) coils++;
  }
  assert.ok(coils > 5 && coils < 40, `${coils} of 40`);
});

test('ai: knocked down, rung 1 waits to be stood up and the top rung rises on its own', () => {
  const riseAt = (level, seed) => {
    const bot = ai(level, seed);
    bot.notifyKnockdown();
    const out = drive(bot, 2.0, (t) => ctx({ selfState: 'down', selfDownT: t }));
    const i = out.findIndex((x) => x.move || x.side || x.block || pressed(x));
    return i < 0 ? Infinity : i * DT;
  };
  const top = [];
  for (let seed = 1; seed <= 30; seed++) {
    assert.equal(riseAt(1, seed), Infinity, `rung 1 seed ${seed}`);
    top.push(riseAt(16, seed));
  }
  assert.ok(top.every((t) => t >= kd.KNOCKDOWN.downMin - DT && t < kd.KNOCKDOWN.downMax), `${top}`);
  assert.ok(new Set(top.map((t) => t.toFixed(1))).size > 1, 'and not always at the same moment');
});

test('ai: the top rung does not always get up the same way', () => {
  const ways = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const bot = ai(16, seed);
    bot.notifyKnockdown();
    const first = drive(bot, 2.0, (t) => ctx({ selfState: 'down', selfDownT: t }))
      .find((x) => x.move || x.side || x.block || pressed(x));
    ways.add(first.move || first.side ? 'roll' : pressed(first) ? 'strike' : 'guard');
  }
  assert.ok(ways.has('roll') && ways.has('guard'), [...ways].join());
});

// ── The table the rules are tuned against ───────────────────────────────────

test('frame data: the numbers the rules above assume', () => {
  assert.equal(MAX_HP, 100);
  assert.equal(HITSTUN, 0.35);
  for (const a of Object.values(ATTACKS)) {
    const total = a.windup + a.active + a.recover;
    // Every cancel opens after the strike is out and before the swing ends.
    for (const [into, at] of Object.entries(a.cancelInto)) {
      assert.ok(at >= a.windup + a.active && at <= total + 1e-9, `${a.name} → ${into} at ${at}`);
    }
  }
  // Punch buys tempo, kick takes the bite.
  assert.ok(ATTACKS.punch.windup < ATTACKS.kick.windup);
  assert.ok(ATTACKS.kick.dmg > ATTACKS.punch.dmg && ATTACKS.kick.reach > ATTACKS.punch.reach);
  assert.ok(ATTACKS.punch.energyMul < ATTACKS.kick.energyMul);
});
