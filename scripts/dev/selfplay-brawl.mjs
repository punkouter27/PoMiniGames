// selfplay-brawl.mjs — CPU-vs-CPU PoBrawl fights, headless, to tune the 16 rungs.
//
//   node scripts/dev/selfplay-brawl.mjs                     adjacent rungs, 120 seeds each
//   node scripts/dev/selfplay-brawl.mjs --seeds 400 --pairs all
//   node scripts/dev/selfplay-brawl.mjs --chars             give both sides a president (signature layers on)
//   node scripts/dev/selfplay-brawl.mjs --masher            also: a button-masher against each rung
//   node scripts/dev/selfplay-brawl.mjs --tune --write      bisect a per-rung dial, write rungTuning.json (a proposal)
//   node scripts/dev/selfplay-brawl.mjs --tuning path.json  fight with a tuning file applied
//
// Goal: each rung beats the one below it ~60-70% of the time, and rung 1 loses to a masher.
//
// HOW IT FIGHTS. game.js needs WebGL and fighterTick.js imports three.js, so neither
// runs in Node. This is a minimal 1-D fight loop built from the same pure rules the game
// uses — ai.js (the real CPU), constants.js (ATTACKS, HITSTUN), energy.js (the bar, the
// coil, the gassed gate) — and the same ctx shape fighterTick.js `_aiContext` builds.
//
// LIMITS (so read the numbers as relative, not as the shipped game):
//   • one dimension: fighters stand on a line, `side` (orbiting) does nothing, ring
//     sense is distance to the two ends;
//   • no knockdown / get-up / count, no supers, no armour or region damage, no perfect
//     guard window, no hitbox polygons (a swing hits inside reach + 0.3 m at its
//     active frames; a held guard stops anything from the front, the attacker eats 0.5 s
//     of block stun);
//   • knockback is a flat 0.3 m, speeds are the engine's 2.4 forward / 1.9 back;
//   • one 60 s round, KO or a decision on health (a tie is half a win);
//   • the human profile is off (`profile: null`) so fights never touch storage.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const js = (name) => new URL(`../../src/PoMiniGames.Client/wwwroot/js/pobrawl/${name}`, import.meta.url);
const { AiController, applyRungTuning, rungParams } = await import(js('ai.js'));
const { PERSONALITIES } = await import(js('personalities.js'));
const { RandomGenerator } = await import(js('rng.js'));
const { ATTACKS, MAX_HP, HITSTUN, TIME_LIMIT, SIM_DT } = await import(js('constants.js'));
const { tickEnergy, drainCharge, paySwing, canAttack, chargeMultiplier } = await import(js('energy.js'));

const HALF = 5.2;          // ring half-length (arena.js RING_HALF)
const KICK_RANGE = ATTACKS.kick.reach + 0.3;
const LUNGE = 0.3;         // hit distance = reach + LUNGE
const WALK = 2.4, BACK = 1.9, KNOCK = 0.3, BLOCK_STUN = 0.5;
const CHARS = Object.keys(PERSONALITIES);

// ── a fighter and the rules that move it ─────────────────────────────────────
function makeFighter(x, ctrl) {
  return {
    x, ctrl, hp: MAX_HP, state: 'idle', stateT: 0, energy: 1, gassed: false, chargeAmt: 0,
    chargeName: null, atk: null, mul: 1, hit: false, blockStunT: 0, dealt: 0,
  };
}

const swinging = (f) => f.state === 'punch' || f.state === 'kick';

function makeCtx(f, o, clock, dt) {
  const dir = Math.sign(o.x - f.x) || 1;
  const back = dir > 0 ? f.x + HALF : HALF - f.x;
  const a = swinging(o) ? o.atk : null;
  return {
    dt, distance: Math.abs(o.x - f.x), kickRange: KICK_RANGE,
    backRoom: back, sideRoomPos: 5, sideRoomNeg: 5, ropeDist: HALF - Math.abs(f.x),
    selfHp: f.hp / MAX_HP, opponentHp: o.hp / MAX_HP, clock, timeLimit: TIME_LIMIT,
    opponentSwingLeft: a ? Math.max(0, a.windup + a.active - o.stateT) : 0,
    opponentCharging: o.state === 'charge', opponentChargeT: o.state === 'charge' ? o.stateT : 0,
    opponentBlockStun: o.blockStunT,
    opponentHitstunLeft: o.state === 'hitstun' ? Math.max(0, HITSTUN - o.stateT) : 0,
    selfState: f.state, selfCharge: f.state === 'charge' ? f.chargeAmt : 0,
    canSuper: false, superMeterFull: false, towardX: dir,
    opponentWindup: o.state === 'charge' || (!!a && o.stateT < a.windup),
    opponentActive: !!a && o.stateT >= a.windup && o.stateT <= a.windup + a.active,
    opponentRecover: !!a && o.stateT > a.windup + a.active,
    opponentState: o.state, ownAttacks: ATTACKS,
    selfExhausted: f.gassed, selfEnergy: f.energy, opponentExhausted: o.gassed,
    opponentFloored: false, opponentRiseIn: 0, selfDownT: 0,
  };
}

function startSwing(f, name, mul) {
  f.state = name; f.stateT = 0; f.atk = ATTACKS[name]; f.mul = mul; f.hit = false;
  paySwing(f, f.atk.energyMul);
}

function applyIntent(f, o, intent, dt) {
  f.stateT += dt;
  if (f.blockStunT > 0) f.blockStunT = Math.max(0, f.blockStunT - dt);
  const movable = f.state === 'idle' || f.state === 'block';
  if (f.state === 'hitstun') {
    if (f.stateT >= HITSTUN) { f.state = 'idle'; f.stateT = 0; }
  } else if (swinging(f)) {
    const a = f.atk, end = a.windup + a.active + a.recover;
    const t = f.stateT;
    // The cancel windows (ATTACKS.cancelInto) the AI's strings and baits use.
    if (f.state === 'punch' && intent.kick && canAttack(f) && t >= a.cancelInto.kick) startSwing(f, 'kick', 1);
    else if (intent.block && t >= a.cancelInto.block) { f.state = 'block'; f.stateT = 0; }
    else if (t >= end && f.blockStunT <= 0) { f.state = 'idle'; f.stateT = 0; }
  } else if (f.state === 'charge') {
    drainCharge(f, dt);
    if (!intent[f.chargeName + 'Held'] || f.chargeAmt >= 1 || f.energy <= 0) {
      const name = f.chargeName;
      const mul = chargeMultiplier(f.chargeAmt);
      f.chargeAmt = 0; f.chargeName = null;
      startSwing(f, name, mul);
    }
  } else if (f.blockStunT <= 0) {
    if ((intent.punch || intent.kick) && canAttack(f)) {
      const name = intent.punch ? 'punch' : 'kick';
      if (intent[name + 'Held']) { f.state = 'charge'; f.stateT = 0; f.chargeName = name; f.chargeAmt = 0; }
      else startSwing(f, name, 1);
    } else {
      const want = intent.block ? 'block' : 'idle';
      if (f.state !== want) { f.state = want; f.stateT = 0; }
    }
  }
  if (movable && f.state !== 'charge' && !swinging(f)) {
    const v = intent.move > 0 ? WALK : intent.move < 0 ? BACK : 0;
    const dir = Math.sign(o.x - f.x) || 1;
    f.x += dir * Math.sign(intent.move || 0) * v * dt * (f.state === 'block' ? 0.5 : 1);
  }
  f.x = Math.max(-HALF, Math.min(HALF, f.x));
  tickEnergy(f, dt);
}

// A swing connects once, on its first active tick inside reach.
function resolveHit(f, o) {
  if (!swinging(f) || f.hit) return;
  const a = f.atk;
  if (f.stateT < a.windup || f.stateT > a.windup + a.active) return;
  if (Math.abs(o.x - f.x) > a.reach + LUNGE) return;
  f.hit = true;
  if (o.state === 'block') {
    f.blockStunT = BLOCK_STUN;
    return;
  }
  const dmg = a.dmg * f.mul;
  o.hp = Math.max(0, o.hp - dmg);
  f.dealt += dmg;
  o.state = 'hitstun'; o.stateT = 0; o.chargeAmt = 0; o.chargeName = null;
  o.x += Math.sign(o.x - f.x || 1) * KNOCK;
  o.x = Math.max(-HALF, Math.min(HALF, o.x));
  o.ctrl.notifyHit?.();
}

/** One round. `ca` and `cb` are controllers; returns 1 (A), 0 (B) or 0.5. */
function fight(ca, cb, flip) {
  const A = makeFighter(flip ? 1.2 : -1.2, ca);
  const B = makeFighter(flip ? -1.2 : 1.2, cb);
  const dt = SIM_DT;
  let clock = 0;
  while (clock < TIME_LIMIT && A.hp > 0 && B.hp > 0) {
    const ia = A.ctrl.update(makeCtx(A, B, clock, dt));
    const ib = B.ctrl.update(makeCtx(B, A, clock, dt));
    applyIntent(A, B, ia, dt);
    applyIntent(B, A, ib, dt);
    resolveHit(A, B);
    resolveHit(B, A);
    clock += dt;
  }
  const res = A.hp > B.hp ? 1 : A.hp < B.hp ? 0 : 0.5;
  return { res, ko: A.hp <= 0 || B.hp <= 0, secs: clock };
}

// ── a button-masher: walks in, punches on a fixed beat, never guards ──────────
class Masher {
  constructor() { this.t = 0; this.next = 0; }
  update(ctx) {
    this.t += ctx.dt;
    const out = { move: 0, side: 0, punch: false, kick: false, block: false };
    if (ctx.distance > 1.35) out.move = 1;
    else if (ctx.selfState === 'idle' && this.t >= this.next) { out.punch = true; this.next = this.t + 0.2; }
    return out;
  }
  notifyHit() {}
}

// ── matches ──────────────────────────────────────────────────────────────────
function makeCpu(level, seed, char) {
  return new AiController(level, new RandomGenerator(seed), char, { profile: null });
}

/** A (rung or 'mash') vs B over `seeds` fights, sides alternating. */
function match(a, b, seeds, chars) {
  let a_pts = 0, kos = 0, secs = 0, n = 0;
  for (let s = 1; s <= seeds; s++) {
    const char = chars ? CHARS[s % CHARS.length] : null;
    const flip = s % 2 === 0;
    const ca = a === 'mash' ? new Masher() : makeCpu(a, s * 2 + 1, char);
    const cb = b === 'mash' ? new Masher() : makeCpu(b, s * 2 + 2, char);
    const r = fight(ca, cb, flip);
    a_pts += r.res; kos += r.ko ? 1 : 0; secs += r.secs; n++;
    ca.dispose?.(); cb.dispose?.();
  }
  return { win: a_pts / n, ko: kos / n, secs: secs / n, preds: 0 };
}

// ── tuning ───────────────────────────────────────────────────────────────────
// One dial per rung: a continuous position `x` along the ladder (rung 1 is x = 1, the
// original table's rung n is x = n). A rung's whole row of columns is the original
// table interpolated at x — extrapolated past rung 16 and clamped — so every column
// moves together and stays a smooth step. Rungs are tuned bottom-up: bisect x so rung
// n beats the (already tuned) rung n-1 about TARGET of the time. x never drops under
// the rung below, so the columns stay monotone by construction. A rung that cannot
// reach the band even at X_MAX has saturated the table; it is reported, not hidden.
const TARGET = 0.65, BAND = [0.60, 0.70], X_MAX = 21;
const COLS = ['reactionMs', 'blockP', 'baitP', 'punishP', 'aggro', 'comboP', 'chargeP', 'punishGas', 'maxCharge'];
const CLAMP = { reactionMs: [60, 700], blockP: [0, 0.99], baitP: [0, 0.5], punishP: [0, 0.99], aggro: [0.2, 1.5],
  comboP: [0, 0.95], chargeP: [0, 0.7], punishGas: [0, 0.99], maxCharge: [0, 1] };

function rowAt(x) {
  applyRungTuning({});
  const i = Math.max(1, Math.min(15, Math.floor(x)));
  const lo = rungParams(i), hi = rungParams(i + 1), f = x - i;   // f > 1 extrapolates
  const row = {};
  for (const c of COLS) {
    const v = lo[c] + (hi[c] - lo[c]) * f;
    row[c] = +Math.max(CLAMP[c][0], Math.min(CLAMP[c][1], v)).toFixed(3);
  }
  row.reactionMs = Math.round(row.reactionMs);
  return row;
}

function tune(seeds, chars) {
  const rungs = {};
  const xs = { 1: 1 };
  for (let n = 2; n <= 16; n++) {
    let lo = xs[n - 1] + 0.05, hi = X_MAX, best = null;
    for (let it = 0; it < 9; it++) {
      const x = it === 0 ? Math.min(hi, Math.max(lo, n)) : (lo + hi) / 2;
      applyRungTuning({ ...rungs, [n]: rowAt(x) });
      const { win } = match(n, n - 1, seeds, chars);
      if (!best || Math.abs(win - TARGET) < Math.abs(best.win - TARGET)) best = { x, win };
      if (win >= BAND[0] && win <= BAND[1]) break;
      if (win < BAND[0]) lo = x; else hi = x;
    }
    xs[n] = best.x;
    rungs[n] = rowAt(best.x);
    const flag = best.win < BAND[0] ? '  (below band: table saturated)' : best.win > BAND[1] ? '  (above band)' : '';
    console.error(`rung ${n}: x=${best.x.toFixed(2)} wins ${(best.win * 100).toFixed(0)}% vs ${n - 1}${flag}`);
  }
  return rungs;
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const seeds = +opt('seeds', 120);
const chars = flag('chars');
const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(4);

const tuningPath = opt('tuning', null);
if (tuningPath && existsSync(tuningPath)) applyRungTuning(JSON.parse(readFileSync(tuningPath, 'utf8')).rungs);

/** Adjacent (or all) pairs and the masher, printed; returns the numbers. */
function report(label) {
  console.log(`\n${label}: ${seeds} fights per pair, ${chars ? 'with presidents' : 'no signature (BOB)'}, 1-D headless loop\n`);
  console.log('pair        A wins   KO rate   avg secs');
  const pairs = [];
  for (let a = 2; a <= 16; a++) {
    if (opt('pairs', 'adjacent') === 'all') for (let b = 1; b < a; b++) pairs.push([a, b]);
    else pairs.push([a, a - 1]);
  }
  const rows = pairs.map(([a, b]) => {
    const m = match(a, b, seeds, chars);
    console.log(`${String(a).padStart(2)} v ${String(b).padEnd(2)}      ${pct(m.win)}      ${pct(m.ko)}     ${m.secs.toFixed(1)}`);
    return { pair: `${a}v${b}`, a, b, win: +m.win.toFixed(3), ko: +m.ko.toFixed(3) };
  });
  const masher = [];
  if (flag('masher') || flag('write')) {
    console.log('\nmasher (punches every 0.2 s, never guards) vs each rung: masher win %');
    for (const r of [1, 2, 4, 8, 12, 16]) {
      const m = match('mash', r, seeds, chars);
      masher.push({ rung: r, masherWin: +m.win.toFixed(3) });
      console.log(`  rung ${String(r).padStart(2)}   ${pct(m.win)}`);
    }
  }
  return { rows, masher };
}

const base = report(tuningPath ? 'Tuning file applied' : 'Shipped table');
let proposal = null, tunedReport = null;
if (flag('tune')) {
  console.log('\nTuning (bisecting one dial per rung, bottom-up)...');
  proposal = tune(Math.max(100, seeds), chars);
  applyRungTuning(proposal);
  tunedReport = report('Proposed tuning');
  applyRungTuning({});
}

if (flag('write')) {
  const file = fileURLToPath(js('rungTuning.json'));
  const slim = (r) => r.rows.filter((x) => x.a - x.b === 1).map(({ pair, win, ko }) => ({ pair, win, ko }));
  writeFileSync(file, JSON.stringify({
    note: 'Written by scripts/dev/selfplay-brawl.mjs --tune --write. ai.js LEVELS is the shipped table; applyRungTuning(rungs) overrides it. '
      + 'rungs is a PROPOSAL, not baked in: the 1-D sim saturates in the upper table, which compresses the whole ladder into the '
      + 'first few rows (a masher beats the proposed rung 4). See the harness header for the limits.',
    seeds, chars,
    shipped: { adjacent: slim(base), masher: base.masher },
    proposal: proposal ? { adjacent: slim(tunedReport), masher: tunedReport.masher } : null,
    rungs: proposal || {},
  }, null, 2) + '\n');
  console.log(`\nwrote ${file}`);
}
