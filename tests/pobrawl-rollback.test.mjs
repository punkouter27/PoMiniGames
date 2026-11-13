// PoBrawl online rollback: the JS sim (rollbackSim.js) and the rollback session (rollbackSession.js).
//
// The cross-language determinism check: tests/pobrawl-rollback-golden.json is the contract both
// sims answer to — every rule constant and the golden script's final state. The C# twin
// (PoMiniGames.Shared PoBrawlRollbackSim) reads the same file in
// tests/PoMiniGames.Unit/Features/PoBrawl/PoBrawlMatchServiceTests.cs. Change a rule in one sim
// and you must change it in the other and update that file. CI runs this file (deploy.yml).
//
// Run: node --test tests/pobrawl-rollback.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const sim = await import(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/rollbackSim.js', import.meta.url));
const { RollbackSession, HISTORY } = await import(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/rollbackSession.js', import.meta.url));

const CONTRACT = JSON.parse(readFileSync(new URL('./pobrawl-rollback-golden.json', import.meta.url), 'utf8'));
const GOLDEN = CONTRACT.golden;

/** The golden input script: a scripted mulberry32 stream decides each corner's event per frame. */
function goldenEvent(script) {
  const r = sim.nextRandom(script);
  if (r % 11 !== 0) return 0;
  return sim.encodeInput(GOLDEN.heldPick[(r >>> 3) % 6], GOLDEN.pressPick[(r >>> 11) % 8]);
}

function runGolden() {
  const s = sim.createState(sim.seedFromMatchId(GOLDEN.matchId), GOLDEN.fightStart);
  const script = { rng: GOLDEN.scriptSeed };
  while (!s.over && s.frame < GOLDEN.fightStart + sim.ROUND_FRAMES + 10) {
    const e1 = goldenEvent(script);
    const e2 = goldenEvent(script);
    sim.step(s, e1, e2);
  }
  return s;
}

test('every rule constant matches the shared contract the C# sim also checks', () => {
  assert.deepEqual({ ...sim.TUNING }, CONTRACT.tuning);
});

test('golden script: the same final state as the C# sim', () => {
  assert.equal(sim.seedFromMatchId(GOLDEN.matchId), GOLDEN.seed);
  const s = runGolden();
  const got = { frame: s.frame, checksum: sim.checksum(s), p1Hp: s.p1.hp, p2Hp: s.p2.hp, reason: s.reason, winner: s.winner };
  assert.deepEqual(got, { frame: GOLDEN.frame, checksum: GOLDEN.checksum, p1Hp: GOLDEN.p1Hp, p2Hp: GOLDEN.p2Hp, reason: GOLDEN.reason, winner: GOLDEN.winner });
});

test('state round-trips through pack/unpack and clone, and the checksum sees every field', () => {
  const s = runGolden();
  const back = sim.unpack(sim.pack(s));
  assert.ok(sim.statesEqual(s, back));
  assert.equal(sim.checksum(back), sim.checksum(s));
  const c = sim.cloneState(s);
  c.p2.cooldown += 1;
  assert.notEqual(sim.checksum(c), sim.checksum(s));
  assert.equal(s.p2.cooldown, back.p2.cooldown, 'a clone is independent');
});

test('the rules: pre-roll holds, reach gates, a guard negates the punch, the special needs a full bar', () => {
  const s = sim.createState(1, 5);
  sim.step(s, sim.encodeInput(1, 4), 0);              // during the count: held remembered, press dropped
  assert.equal(s.p1.x, -sim.SPAWN_X_MM);
  assert.equal(s.p1.pending, 0);
  for (let i = 0; i < 4; i++) sim.step(s, 0, 0);
  sim.step(s, 0, 0);                                  // first live frame: walks on the bell
  assert.equal(s.p1.x, -sim.SPAWN_X_MM + sim.WALK_IN_MM);
  sim.step(s, sim.encodeInput(-1, 4), 0);             // a punch from 3 m whiffs
  assert.equal(s.p1.outcome, sim.OUTCOME_WHIFF);
  assert.equal(s.p2.hp, 100);
  while (s.p2.x - s.p1.x > sim.PUNCH_REACH_MM - 50) sim.step(s, 0, 0);
  sim.step(s, sim.encodeInput(0, 0), sim.encodeInput(3, 0));
  while (s.p1.cooldown > 0) sim.step(s, 0, 0);
  sim.step(s, sim.encodeInput(-1, 4), 0);
  assert.equal(s.p1.outcome, sim.OUTCOME_BLOCKED);
  assert.equal(s.p2.hp, 100, 'a guard negates a punch');
  while (s.p1.cooldown > 0) sim.step(s, 0, 0);
  sim.step(s, sim.encodeInput(-1, 6), 0);             // no full bar: refused, no swing
  assert.equal(s.p1.swing, sim.PRESS_PUNCH);
  assert.equal(s.p1.pending, 0);
});

// ── A tiny network: one referee and two rollback clients over lossless, ordered, delayed links ──

/** The server half of the protocol, as PoBrawlMatchService does it (same sim, same re-stamp rule). */
class Referee {
  constructor(seed, fightStart) {
    this.state = sim.createState(seed, fightStart);
    this.future = [new Map(), new Map()];
    this.lastFrame = [0, 0];
    this.history = new Map([[0, sim.cloneState(this.state)]]);
  }
  clockFrame(t) { return t / sim.FRAME_MS; }
  submit(side, frame, held, press) {
    const f = Math.max(frame, this.state.frame + 1, this.lastFrame[side]);
    this.lastFrame[side] = f;
    const m = this.future[side];
    m.set(f, sim.mergeInput(m.get(f) || 0, sim.encodeInput(held, press)));
    return f;
  }
  stepTo(t, onFrame) {
    while (this.state.frame < Math.floor(this.clockFrame(t))) {
      const f = this.state.frame + 1;
      sim.step(this.state, this.future[0].get(f) || 0, this.future[1].get(f) || 0);
      this.future[0].delete(f);
      this.future[1].delete(f);
      this.history.set(f, sim.cloneState(this.state));
      onFrame(f);
    }
  }
}

function runNetwork({ oneWay, scripts, spike = null, endMs = 9000, echoExtra = 0, firstPingMs = 0 }) {
  const seed = sim.seedFromMatchId('net-test');
  const ref = new Referee(seed, 60);
  const queue = []; // { at, fn }
  const deliver = (at, fn) => queue.push({ at, fn });
  const clients = [1, 2, 0].map((localSide, i) => {
    const latency = oneWay[i];
    const session = new RollbackSession({
      localSide,
      send: (frame, held, press, seq) => {
        const extra = spike && spike.side === localSide && spike.seq === seq ? spike.ms : 0;
        deliver(now + latency + extra, () => {
          const side = localSide - 1;
          const applied = ref.submit(side, frame, held, press);
          for (const c of clients) deliver(now + c.latency + echoExtra, () => c.session.onInput(side, applied, held, press, seq));
        });
      },
    });
    return { session, latency };
  });
  let now = 0;
  const scriptQueue = scripts.map((list, i) => ({ i, list: [...list] }));
  for (now = 0; now <= endMs; now += 4) {
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) queue.shift().fn();
    ref.stepTo(now, (f) => {
      if (f % 6 !== 0) return;
      const st = sim.cloneState(ref.state);
      for (const c of clients) deliver(now + c.latency, () => c.session.onSnapshot(sim.pack(st), st.frame, sim.checksum(st), now));
    });
    if (now % 500 === 0) {
      for (const c of clients) {
        // The first ping can sit behind a busy main thread (the engine boot): an absurd round trip.
        const stall = now === 0 ? firstPingMs : 0;
        const serverAt = now + c.latency;
        const rtt = 2 * c.latency + stall;
        deliver(now + rtt, () => c.session.onClock(ref.clockFrame(serverAt), rtt, now)); // `now` is read on delivery
      }
    }
    for (const sq of scriptQueue) {
      while (sq.list.length && sq.list[0].at <= now) {
        const ev = sq.list.shift();
        clients[sq.i].session.localInput(ev.held, ev.press);
      }
    }
    for (const c of clients) c.session.update(now);
  }
  // The players predict past the referee's last frame (they lead it); with every input delivered,
  // the referee's next frames are what those predictions must equal.
  const ahead = Math.max(...clients.map((c) => c.session.frame));
  ref.stepTo((ahead + 1) * sim.FRAME_MS, () => {});
  return { ref, clients, serverFrameAtEnd: Math.floor(ref.clockFrame(endMs)) };
}

/** A walk-in-and-trade script for one corner. */
function script(offset) {
  const out = [];
  out.push({ at: 1200 + offset, held: 1, press: 0 });
  out.push({ at: 1900 + offset, held: 0, press: 0 });
  for (let t = 2000; t < 6000; t += 230) out.push({ at: t + offset, held: t % 690 === 0 ? 3 : 0, press: t % 460 === 0 ? 5 : 4 });
  out.push({ at: 6100 + offset, held: 2, press: 0 });
  out.push({ at: 6500 + offset, held: 0, press: 0 });
  return out;
}

test('two players and a spectator converge on the referee timeline — rollback, no hard correction', () => {
  const { ref, clients, serverFrameAtEnd } = runNetwork({ oneWay: [35, 80, 60], scripts: [script(0), script(97), []] });
  for (const { session } of clients) {
    const s = session.state;
    assert.ok(s, 'the session synced from a snapshot');
    const truth = ref.history.get(s.frame);
    assert.ok(truth, `the referee has frame ${s.frame}`);
    assert.equal(sim.checksum(s), sim.checksum(truth), `side ${session.localSide} matches the referee at frame ${s.frame}`);
    assert.equal(session.stats.corrections, 0, `side ${session.localSide}: no snapshot ever disagreed`);
  }
  const [p1, p2, watcher] = clients.map((c) => c.session);
  assert.ok(p1.stats.rollbacks > 0 && p2.stats.rollbacks > 0, 'remote input arrived late and was rolled back in');
  assert.ok(p1.stats.maxDepth < HISTORY);
  assert.ok(ref.state.p1.hp < 100 && ref.state.p2.hp < 100, 'the script actually traded blows');
  // Clock: players lead the server, the spectator trails it.
  const serverNow = serverFrameAtEnd;
  assert.ok(p1.frame > serverNow && p2.frame > serverNow, `players lead (${p1.frame}, ${p2.frame} vs ${serverNow})`);
  assert.ok(watcher.frame < serverNow, `the spectator trails (${watcher.frame} vs ${serverNow})`);
});

test('an input the server re-stamps (it arrived late) is moved client-side to the frame the server used', () => {
  const { ref, clients } = runNetwork({ oneWay: [30, 30, 30], scripts: [script(0), script(50), []], spike: { side: 1, seq: 3, ms: 250 } });
  const [p1] = clients.map((c) => c.session);
  assert.ok(p1.stats.restamps >= 1, 'the late input came back with a later frame');
  assert.equal(sim.checksum(p1.state), sim.checksum(ref.history.get(p1.state.frame)));
});

test('snapshots that overtake input echoes, and a stalled first ping, still converge', () => {
  const { ref, clients } = runNetwork({ oneWay: [25, 45, 30], scripts: [script(0), script(31), []], echoExtra: 70, firstPingMs: 6000 });
  for (const { session } of clients) {
    assert.equal(sim.checksum(session.state), sim.checksum(ref.history.get(session.state.frame)), `side ${session.localSide} converged`);
    assert.ok(session.rtt < 1000, `side ${session.localSide}: the stalled ping was ignored (${session.rtt} ms)`);
  }
});

// ── Both hands and the canvas ────────────────────────────────────────────────

/** A live fight with the corners `gapMm` apart and P1 on a full bar. */
function closeFight(gapMm = 1200) {
  const s = sim.createState(7, 0);
  s.p1.x = -gapMm / 2;
  s.p2.x = gapMm / 2;
  s.p1.energy = sim.ENERGY_MAX;
  return s;
}
const press = (p) => sim.encodeInput(-1, p);
const idle = (s, n) => { for (let i = 0; i < n; i++) sim.step(s, 0, 0); };

test('both hands: jab, then the cross inside the window, then a stale punch is a jab again', () => {
  const T = sim.TUNING;
  const s = closeFight();
  s.p2.immune = 9999;                              // keep P2 on their feet: this test is about the hands
  sim.step(s, press(sim.PRESS_PUNCH), 0);
  assert.equal(s.p1.arm, sim.ARM_LEFT);
  const jab = s.p1.damage;
  idle(s, T.PUNCH_COOLDOWN);
  sim.step(s, press(sim.PRESS_PUNCH), 0);
  assert.equal(s.p1.arm, sim.ARM_RIGHT);
  const cross = s.p1.damage;
  // 90% and 120% of 6, each ±20%: the ranges do not overlap.
  assert.ok(jab >= 4 && jab <= 6, `jab ${jab}`);
  assert.ok(cross >= 6 && cross <= 8, `cross ${cross}`);
  idle(s, T.PUNCH_COOLDOWN);
  sim.step(s, press(sim.PRESS_PUNCH), 0);
  assert.equal(s.p1.arm, sim.ARM_LEFT, 'after a cross the next is a jab');
  idle(s, T.ONE_TWO_FRAMES + 1);
  sim.step(s, press(sim.PRESS_PUNCH), 0);
  assert.equal(s.p1.arm, sim.ARM_LEFT, 'a jab long after a jab is still a jab');
});

test('knockdown: the special drops a standing corner, which then cannot be hit', () => {
  const T = sim.TUNING;
  const s = closeFight();
  const x0 = s.p2.x;
  sim.step(s, press(sim.PRESS_SPECIAL), 0);
  assert.equal(s.p1.outcome, sim.OUTCOME_HIT);
  assert.equal(s.p2.floor, sim.FLOOR_DOWN);
  assert.ok(s.p2.x >= x0 + T.SPECIAL_KNOCKBACK_MM + T.KNOCKDOWN_SLIDE_MM - 1, 'carried off their feet');
  const hp = s.p2.hp;
  // Walk back into range and kick the body: a whiff, no damage, and the RNG does not move.
  while (s.p2.x - s.p1.x > T.KICK_REACH_MM - 100) sim.step(s, sim.encodeInput(sim.HELD_FORWARD, 0), 0);
  const rng = s.rng;
  sim.step(s, sim.encodeInput(sim.HELD_IDLE, sim.PRESS_KICK), 0);
  while (s.p1.swing !== sim.PRESS_KICK) sim.step(s, 0, 0);   // the press waits out the special's cooldown
  assert.equal(s.p2.floor, sim.FLOOR_DOWN, 'still down when the kick arrives');
  assert.equal(s.p1.outcome, sim.OUTCOME_WHIFF);
  assert.equal(s.p2.hp, hp);
  assert.equal(s.rng, rng);
});

test('knockdown: a jab a second never drops anyone; three quick ones in the head do', () => {
  const T = sim.TUNING;
  const slow = closeFight();
  for (let i = 0; i < 12; i++) {
    slow.p1.energy = sim.ENERGY_MAX; slow.p2.hp = 100;
    slow.p1.x = -600; slow.p2.x = 600;
    sim.step(slow, press(sim.PRESS_PUNCH), 0);
    assert.equal(slow.p2.floor, sim.FLOOR_NONE, `jab ${i}`);
    idle(slow, 60);
  }
  // Kicks on cooldown: the second or third puts them down.
  const fast = closeFight();
  let n = 0;
  while (fast.p2.floor === sim.FLOOR_NONE && n < 4) {
    fast.p1.energy = sim.ENERGY_MAX;
    fast.p1.x = -600; fast.p2.x = 600;
    sim.step(fast, press(sim.PRESS_KICK), 0);
    n++;
    if (fast.p2.floor === sim.FLOOR_NONE) idle(fast, T.KICK_COOLDOWN);
  }
  assert.ok(n >= 2 && n <= 3, `${n} kicks`);
  assert.equal(fast.p2.floor, sim.FLOOR_DOWN);
});

test('get-up: stood up at the maximum, sooner on an input, a roll with BACK, and no knockdown loop', () => {
  const T = sim.TUNING;
  const floored = () => { const s = closeFight(); sim.step(s, press(sim.PRESS_SPECIAL), 0); return s; };
  const framesToStand = (s, input2) => { let n = 0; while (s.p2.floor !== sim.FLOOR_NONE && n < 400) { sim.step(s, 0, n === 0 ? input2 : 0); n++; } return n; };

  // Nothing pressed: down for the maximum, then the rise.
  assert.equal(framesToStand(floored(), 0), T.DOWN_MAX_FRAMES - 1 + T.GETUP_FRAMES);
  // Guard held: up at the minimum, and guarding the moment they stand.
  const g = floored();
  assert.equal(framesToStand(g, sim.encodeInput(sim.HELD_BLOCK, 0)), T.DOWN_MIN_FRAMES - 1 + T.GETUP_FRAMES);
  assert.equal(g.p2.immune, T.DAZE_IMMUNE_FRAMES - 1, 'the immunity starts on the standing frame');
  // BACK held: the same timing, rolled away by the whole get-up.
  const r = floored();
  const x0 = r.p2.x;
  framesToStand(r, sim.encodeInput(sim.HELD_BACK, 0));
  assert.equal(r.p2.x - x0, Math.min(T.ROLL_STEP_MM * T.GETUP_FRAMES, T.RING_HALF_MM - x0));
  // A press on the canvas is kept and thrown on standing: the wake-up strike.
  const w = floored();
  framesToStand(w, press(sim.PRESS_KICK));
  assert.equal(w.p2.swingFrame, -1, 'not yet: standing this frame');
  sim.step(w, 0, 0);
  assert.equal(w.p2.swing, sim.PRESS_KICK);
  assert.equal(w.p2.swingFrame, w.frame);
  // Just up: a second special inside the immunity does not drop them again.
  const again = floored();
  framesToStand(again, sim.encodeInput(sim.HELD_BLOCK, 0));
  sim.step(again, 0, sim.encodeInput(sim.HELD_IDLE, 0));
  again.p1.energy = sim.ENERGY_MAX; again.p1.cooldown = 0;
  again.p1.x = -600; again.p2.x = 600;
  sim.step(again, press(sim.PRESS_SPECIAL), 0);
  assert.equal(again.p1.outcome, sim.OUTCOME_HIT);
  assert.equal(again.p2.floor, sim.FLOOR_NONE);
});

test('the killing blow is a KO, never a knockdown', () => {
  const s = closeFight();
  s.p2.hp = 3;
  sim.step(s, press(sim.PRESS_SPECIAL), 0);
  assert.equal(s.p2.hp, 0);
  assert.equal(s.p2.floor, sim.FLOOR_NONE);
  assert.equal(s.over, 1);
  assert.equal(s.reason, sim.REASON_KO);
});
