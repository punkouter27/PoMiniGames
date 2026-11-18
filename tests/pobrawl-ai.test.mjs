// PoBrawl CPU memory and tactics, headless: the cross-session profile, the n-gram
// predictor, the utility scorer, the archetype trees and the rung table.
//
//   playerProfile.js  the human's habits in localStorage (`pomini_` key), decayed, bounded
//   predictor.js      order-3/2/1 n-gram over the human's recent actions
//   tactics.js        behaviour-tree archetypes + utility scoring of the neutral tactics
//   ai.js             seeds from the profile, pre-empts predicted swings, rung table
//
// None of them import three.js, so Node loads them. CI runs this file (deploy.yml).
//
// Run: node --test tests/pobrawl-ai.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const at = (name) => new URL(`../src/PoMiniGames.Client/wwwroot/js/pobrawl/${name}`, import.meta.url);
const { PlayerProfile, PROFILE_KEY } = await import(at('playerProfile.js'));
const { NGramPredictor, ActionReader } = await import(at('predictor.js'));
const tactics = await import(at('tactics.js'));
const { AiController, rungParams } = await import(at('ai.js'));
const { PERSONALITIES } = await import(at('personalities.js'));
const { RandomGenerator } = await import(at('rng.js'));
const { ATTACKS } = await import(at('constants.js'));

const DT = 1 / 60;
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

/** A storage that holds a string, or throws on demand. */
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
};
const throwingStorage = () => ({
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('quota'); },
});

// ── playerProfile.js ────────────────────────────────────────────────────────

test('profile: a throwing, missing or junk-filled storage still yields a working profile', () => {
  for (const storage of [throwingStorage(), null, undefined]) {
    const p = PlayerProfile.load(storage);
    p.record(ctx({ opponentState: 'punch' }));
    assert.equal(p.save(), false, 'save reports failure instead of throwing');
    assert.equal(p.seed(1), null, 'no evidence, no seed');
  }
  const s = memoryStorage();
  for (const junk of ['{', 'null', '[]', '{"v":99}', '{"v":1,"strikes":{"punch":"x"},"range":"no"}']) {
    s.m.set(PROFILE_KEY, junk);
    const p = PlayerProfile.load(s);
    assert.equal(p.strikeMix().punch, 0);
    assert.ok(Number.isFinite(p.data.totalT));
  }
  assert.ok(PROFILE_KEY.startsWith('pomini_'));
});

test('profile: habits round-trip through storage, decay on each load, and stay bounded', () => {
  const s = memoryStorage();
  const p = PlayerProfile.load(s);
  // A human who guards through every fight and throws only kicks.
  for (let i = 0; i < 60 * 20; i++) {
    p.record(ctx({ opponentState: i % 90 === 0 ? 'kick' : 'block' }));
  }
  assert.ok(p.save());
  const q = PlayerProfile.load(s);
  assert.ok(q.guardRate() > 0.8, `guard rate ${q.guardRate()}`);
  assert.ok(q.strikeMix().kick > 0.99);
  assert.ok(q.data.inRangeT < p.data.inRangeT, 'older play weighs less after a load');
  assert.ok(q.data.fights >= 2);
  // Hammering it can never blow the size past the fixed shape or the cap.
  for (let i = 0; i < 20000; i++) p.record(ctx({ opponentState: i % 2 ? 'punch' : 'idle', dt: 5 }));
  p.save();
  assert.ok(s.m.get(PROFILE_KEY).length < 600, `${s.m.get(PROFILE_KEY).length} chars`);
  assert.ok(Object.values(p.data.strikes).every((n) => n <= 5000));
});

test('profile: the CPU seeds its habit window from it, scaled by rung (low rungs ignore it)', () => {
  const s = memoryStorage();
  const p = PlayerProfile.load(s);
  for (let i = 0; i < 60 * 12; i++) p.record(ctx({ opponentState: 'block' }));
  p.save();
  const bot = (level) => new AiController(level, new RandomGenerator(3), null, { profile: PlayerProfile.load(s) });
  for (const level of [1, 2, 3]) assert.equal(bot(level).obsT, 0, `rung ${level}`);
  const mid = bot(8), top = bot(16);
  assert.ok(mid.oppBlockT > 0 && top.oppBlockT > mid.oppBlockT);
  assert.ok(top._turtleRead() > 0, 'a remembered turtle reads as a turtle from the first tick');
  // And an explicit null profile is a clean slate.
  assert.equal(new AiController(16, new RandomGenerator(3), null, { profile: null }).obsT, 0);
});

// ── predictor.js ────────────────────────────────────────────────────────────

test('predictor: a repeated pattern is predicted with growing confidence', () => {
  const g = new NGramPredictor();
  for (let i = 0; i < 12; i++) for (const sym of 'IPB') g.push(sym);   // in, punch, guard, ...
  g.push('I');
  const p = g.predict();
  assert.equal(p.sym, 'P');
  assert.ok(p.conf > 0.7, `conf ${p.conf}`);
  assert.ok(g.swingProb() > 0.7);
  // Nothing learned yet: no read at all.
  assert.equal(new NGramPredictor().predict(), null);
});

test('predictor: a mixed player starves it of confidence', () => {
  const g = new NGramPredictor();
  const rng = new RandomGenerator(5);
  for (let i = 0; i < 200; i++) g.push('PKCBIO'[Math.floor(rng.random() * 6)]);
  const p = g.predict();
  assert.ok(!p || p.conf < 0.5, `random play read at ${p?.conf}`);
});

test('predictor: the reader turns state edges into symbols', () => {
  const r = new ActionReader();
  const syms = [];
  const feed = (state, n = 1, o = {}) => { for (let i = 0; i < n; i++) { const s = r.read(ctx({ opponentState: state, ...o })); if (s) syms.push(s); } };
  feed('idle', 5); feed('punch', 5); feed('idle', 5); feed('block', 5); feed('kick', 3); feed('charge', 3);
  assert.deepEqual(syms, ['P', 'B', 'K', 'C']);
});

test('ai: a predictable human is pre-empted, but never more than the cap, and rung 1 never', () => {
  // Human loop: stand 0.6 s, punch (0.15 s), 0.5 s idle, guard 0.3 s, repeat.
  const loop = (t) => {
    const u = t % 1.55;
    return u < 0.6 ? 'idle' : u < 0.75 ? 'punch' : u < 1.25 ? 'idle' : 'block';
  };
  const run = (level) => {
    const bot = new AiController(level, new RandomGenerator(11), null, { profile: null });
    for (let t = 0; t < 60; t += DT) {
      const s = loop(t);
      bot.update(ctx({ opponentState: s, opponentWindup: s === 'punch' && (t % 1.55) < 0.66 }));
    }
    return bot;
  };
  const top = run(16);
  assert.ok(top.stats.predActs > 0, 'the top rung acts on a clear pattern');
  // 60 s in 10 s windows: at most cap acts per window (+1 window of slack at the edges).
  assert.ok(top.stats.predActs <= top._predCap * 7, `${top.stats.predActs} acts, cap ${top._predCap}`);
  assert.equal(run(1).stats.predActs, 0);
  assert.equal(run(3).stats.predActs, 0);
  assert.ok(run(10)._predThr > top._predThr, 'a lower rung needs a surer read');
});

// ── tactics.js ──────────────────────────────────────────────────────────────

// The rung's own base weights for a mid ladder CPU, as ai.js builds them.
const base = { attack: 0.4, guard: 0.1, bait: 0.02, space: 0.4, charge: 0.05, punish: 0.1 };
const stanceFor = (archetype, c, predSwing) => {
  const mood = { aggro: 1, guard: 0, protect: false };
  const f = tactics.facts(c, mood, predSwing, 0);
  return { f, st: tactics.chooseStance(archetype, f) };
};

test('utility: low on health against a swinging opponent, guard wins', () => {
  const c = ctx({ selfHp: 0.15, opponentState: 'idle' });
  for (const archetype of Object.keys(tactics.ARCHETYPES)) {
    const { f, st } = stanceFor(archetype, c, 0.9);
    const sc = tactics.scoreTactics(base, c, f, st);
    const best = Object.entries(sc).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(best, 'guard', `${archetype}: ${JSON.stringify(sc)}`);
  }
  // Healthy with no swing coming, attacking beats guarding for an aggressor.
  const calm = ctx();
  const { f, st } = stanceFor('aggressor', calm, 0);
  const sc = tactics.scoreTactics(base, calm, f, st);
  assert.ok(sc.attack > sc.guard);
});

test('utility: no ropes behind means stepping out, the ropes mean circling instead', () => {
  const open = ctx();
  const roped = ctx({ backRoom: 0.4, ropeDist: 0.5 });
  const a = stanceFor('counter', open, 0.8), b = stanceFor('counter', roped, 0.8);
  const sa = tactics.scoreTactics(base, open, a.f, a.st), sb = tactics.scoreTactics(base, roped, b.f, b.st);
  assert.ok(sb.retreat < sa.retreat * 0.3);
  assert.ok(sb.circle > sa.circle);
  // Punish only exists when the opponent is open.
  assert.equal(sa.punish, 0);
  const o = ctx({ opponentRecover: true });
  const p = stanceFor('aggressor', o, 0);
  assert.ok(tactics.scoreTactics(base, o, p.f, p.st).punish > 0);
});

test('utility: weighted choice follows the scores and handles all-zero', () => {
  assert.equal(tactics.pickWeighted({ attack: 1 }, 0.99), 'attack');
  assert.equal(tactics.pickWeighted({ attack: 0, guard: 0 }, 0.5), null);
  const n = { attack: 0, guard: 3, retreat: 1 };
  const picks = [0.1, 0.5, 0.74, 0.76, 0.99].map((r) => tactics.pickWeighted(n, r));
  assert.deepEqual(picks, ['guard', 'guard', 'guard', 'retreat', 'retreat']);
});

test('archetypes: every personality maps to a real archetype tree, and all three are used', () => {
  const used = new Set();
  for (const id of Object.keys(PERSONALITIES)) {
    assert.ok(id in tactics.ARCHETYPE_OF, `${id} has no archetype`);
    const a = tactics.archetypeFor(id);
    assert.ok(a in tactics.ARCHETYPES, `${id} -> ${a}`);
    used.add(a);
    // The tree answers for any facts, never null.
    const { st } = stanceFor(a, ctx(), 0.5);
    assert.ok(st.bias && typeof st.name === 'string');
  }
  assert.deepEqual([...used].sort(), ['aggressor', 'counter', 'turtle']);
  assert.equal(tactics.archetypeFor(null), 'aggressor');
  assert.equal(tactics.archetypeFor('nobody'), 'aggressor');
  for (const id of Object.keys(tactics.ARCHETYPE_OF)) assert.ok(id in PERSONALITIES, `${id} is not a personality`);
});

test('archetypes: the trees pick their own stances', () => {
  const mood = { aggro: 1, guard: 0, protect: false };
  const name = (arch, c, pred = 0) => tactics.chooseStance(arch, tactics.facts(c, mood, pred, 0)).name;
  assert.equal(name('aggressor', ctx({ selfHp: 0.2 })), 'survive');
  assert.equal(name('aggressor', ctx({ opponentExhausted: true })), 'press');
  assert.equal(name('counter', ctx(), 0.9), 'read');
  assert.equal(name('counter', ctx({ opponentRecover: true })), 'answer');
  assert.equal(name('turtle', ctx({ selfHp: 0.9, opponentHp: 0.3, clock: 50 })), 'protect');
  assert.equal(name('turtle', ctx()), 'shell');
});

// ── the rung table ──────────────────────────────────────────────────────────

test('rungs: every column is monotone up the ladder and rung 1 is the gentle one', () => {
  const cols = ['blockP', 'baitP', 'punishP', 'aggro', 'comboP', 'chargeP', 'punishGas', 'maxCharge'];
  for (let n = 2; n <= 16; n++) {
    const lo = rungParams(n - 1), hi = rungParams(n);
    assert.ok(hi.reactionMs < lo.reactionMs, `reactionMs at rung ${n}`);
    for (const c of cols) assert.ok(hi[c] >= lo[c], `${c} dips at rung ${n}`);
  }
  assert.equal(rungParams(1).comboP, 0);
  assert.ok(rungParams(1).maxCharge <= 0.2);
  // The memory scales with the rung too: a higher rung acts on a weaker read, more often.
  const thr = (n) => new AiController(n, new RandomGenerator(1), null, { profile: null })._predThr;
  for (let n = 5; n <= 16; n++) assert.ok(thr(n) <= thr(n - 1), `threshold at rung ${n}`);
});

test('ai: with profile, predictor and utility in, the intent shape is unchanged and seeds still replay', () => {
  const play = (seed) => {
    const bot = new AiController(14, new RandomGenerator(seed), 'obama', { profile: null });
    const out = [];
    for (let t = 0; t < 20; t += DT) {
      const u = t % 1.2;
      const s = u < 0.7 ? 'idle' : u < 0.85 ? 'punch' : 'block';
      out.push(bot.update(ctx({ opponentState: s, opponentWindup: s === 'punch' && u < 0.76 })));
    }
    return out;
  };
  const a = play(9), b = play(9);
  assert.deepEqual(a, b);
  for (const i of a) {
    assert.ok([-1, 0, 1].includes(i.move) && [-1, 0, 1].includes(i.side), JSON.stringify(i));
    assert.ok(!(i.punch && i.kick));
  }
});
