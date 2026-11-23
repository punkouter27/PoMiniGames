// pofighter/versus.js — the fight rules: two fighters, best of three rounds. Each corner is a CPU
// or a human (roster entry { control: 'human' }, fed by setInput each step). Pure: no DOM, no
// clock, and its randomness comes from a seed, so tests/pofighter-versus.test.mjs can drive it.
//
// It reuses the practice room's fighter data and frameAt (sim.js), and the attack table and
// motions in moves.js. Each fighter keeps x as its anchor on the floor and `dir` (+1 facing
// right, −1 facing left); data is always filmed (or packed) facing right, so forward travel and
// reach are multiplied by dir.
//
// A match runs through phases: vs (the two names) → round (ROUND n, then FIGHT!) → fight →
// ko (the loser falls, the winner cheers) → the next round, or → winner (the match card, then
// the winner's quote). Then a new match starts with the corners swapped — or, with
// { rematch: false } (a tournament bout), the match ends in the 'done' phase.
//
// Fighting:
//   - The only attacks are the punch and the kick (moves.js MOVES), each with its own frame data:
//     a hit lands only in the attack's active window, and an attack that hits nothing adds its
//     `whiff` recovery. Down plus a button gives the same standing attack.
//   - Holding back guards (walking back, or crouching back); crouching ducks the punch. A hit
//     on a guard costs chip damage only.
//   - Up jumps (up-forward and up-back travel); no attacks in the air. A fighter with no filmed
//     jump jumps in its crouch pose on a computed arc. A hit in the air knocks the defender down
//     (the K.O. fall, then the get-up); they get up invulnerable.
//   - Unblocked hits within COMBO_WINDOW of each other chain into a combo (a 'combo' event from
//     the second hit on), each extra hit doing a little less.
// CPU difficulty ('easy' | 'normal' | 'hard') changes how fast the CPU reacts, how often it
// blocks and attacks; 'normal' is the demo's original CPU.
//
// Events (stepMatch's return): round, hit, block, combo, first (first hit of a round),
// knockdown, ko / time (with perfect, double), match.

import { frameAt } from './sim.js';
import { MOVES, isAttack, attackOf, clipFor, frameData } from './moves.js';

export const ARENA = { width: 1100, ground: 560, minX: 90, maxX: 1010, startGap: 420, minGap: 120 };
export const MAX_HP = 100;
export const ROUND_SECONDS = 99;
export const WINS_NEEDED = 2;
// winner: the "X WINS!" banner for QUOTE_AT seconds, then the winner's quote.
export const PHASE_SECONDS = { vs: 3, round: 1.4, fightCall: 0.7, ko: 3, winner: 7 };
export const QUOTE_AT = 1.8;
const CHIP = 1;                 // what a blocked attack still costs
const KNOCKBACK = 340;          // starting slide speed of a hit (units/second), damped
const BLOCK_KNOCKBACK = 190;
// Hit-stop: the whole fight holds still for a moment when a blow lands, so it reads as weight.
export const HIT_STOP = 0.07, BLOCK_STOP = 0.03;
export const COMBO_WINDOW = 0.9;   // seconds after a landed hit in which the next one chains
const COMBO_DECAY = 0.12, COMBO_FLOOR = 0.5;   // damage × max(floor, 1 − decay × (hits − 1))
export const JUMP = { T: 0.72, h: 130, vx: 210 };   // the computed jump (and the travel of any jump)
const LANDING_LAG = 0.06;
export const KNOCKDOWN = { fall: 0.5, floor: 0.45 };   // a knocked-down fighter's fall, then time on the floor
export const DIFFICULTY = {
    easy: { think: 1.8, block: 0.3, attack: 0.6 },
    normal: { think: 1, block: 1, attack: 1 },
    hard: { think: 0.6, block: 1.9, attack: 1 },
};

/** Mulberry32: a small seeded generator, so a match replays the same from the same seed. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The farthest an attack reaches in front of the anchor, over its pictures. */
export function reachOf(data, move) {
    const def = clipFor(data, move).def;
    return def ? Math.max(...def.frames.map(f => f.r)) : 0;
}

/** How high a filmed jump lifts the feet at its top (world units). */
const peaks = new WeakMap();
function filmedPeak(data) {
    if (!peaks.has(data)) {
        const res = data.res ?? 1;
        peaks.set(data, Math.max(0, ...data.moves.jump.frames.map(f => (f.h !== undefined ? f.ay - f.h / res : 0))));
    }
    return peaks.get(data);
}

function fighter(index, entry, x, dir) {
    const { id, data, name } = entry;
    return {
        index, id, name, data, x, dir,
        control: entry.control === 'human' ? 'human' : 'cpu', palette: entry.palette ?? 0,
        input: { left: false, right: false, up: false, down: false }, buffered: null, bufferT: 0,
        combo: 0, comboT: 0,
        move: 'idle', t: 0, hp: MAX_HP, shownHp: MAX_HP, wins: 0,
        hitDone: false, stun: 0, slide: 0, flash: 0, blocked: false,
        air: null, lag: 0, invuln: 0, guard: null, crouchBack: false,
        think: 0, plan: 'idle', planLeft: 0,
        reach: { punchMid: reachOf(data, 'punchMid'), kick: reachOf(data, 'kick') },
    };
}

/**
 * A new match. roster: [{ id, name, data, control?, palette? }, …] — the first starts in the left
 * corner. Every match after the first swaps the corners; { rematch: false } plays one match.
 * Two entries with the same fighter and palette (a mirror match) get the second one's palette
 * switched to an alternate, so the two can be told apart.
 */
export function createMatch(roster, seed = 1, { rematch = true, difficulty = 'normal' } = {}) {
    if (roster[0].id === roster[1].id && (roster[0].palette ?? 0) === (roster[1].palette ?? 0)) {
        roster = [roster[0], { ...roster[1], palette: (roster[0].palette ?? 0) === 1 ? 2 : 1 }];
    }
    const cpu = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    const m = { roster, seed, rematch, cpu, random: rng(seed), matchNo: 0, fighters: null, time: 0 };
    startMatch(m);
    return m;
}

function startMatch(m) {
    const [a, b] = m.matchNo % 2 === 0 ? m.roster : [m.roster[1], m.roster[0]];
    m.fighters = [fighter(0, a, 0, 1), fighter(1, b, 0, -1)];
    m.round = 1;
    m.winner = null;       // the match winner's index, or -1 for a draw game
    m.roundWinner = null;  // the round winner's index, -1 for a double KO / draw
    m.events = [];
    resetRound(m);
    m.phase = 'vs';
    m.phaseT = 0;
}

function resetRound(m) {
    const mid = ARENA.width / 2;
    m.fighters.forEach((f, i) => {
        Object.assign(f, {
            x: mid + (i === 0 ? -1 : 1) * ARENA.startGap / 2, dir: i === 0 ? 1 : -1,
            move: 'idle', t: 0, hp: MAX_HP, shownHp: MAX_HP, hitDone: false, stun: 0, slide: 0, flash: 0,
            blocked: false, think: 0.2 + 0.3 * m.random(), plan: 'idle', planLeft: 0,
            combo: 0, comboT: 0, buffered: null, bufferT: 0,
            air: null, lag: 0, invuln: 0, guard: null, crouchBack: false,
        });
    });
    m.firstHit = false;
    m.clock = ROUND_SECONDS;
    m.roundWinner = null;
}

// Moves that are not in the fighter's data but are drawn anyway (moves.js clipFor, animOf).
const SYNTHETIC = new Set(['jump', 'down']);

function enter(f, move) {
    if (!f.data.moves[move] && !isAttack(move) && !SYNTHETIC.has(move)) move = 'idle';   // a move the video did not have shows the stance
    if (f.move === move) return;
    f.move = move;
    f.t = 0;
    f.hitDone = false;
}

const gap = m => Math.abs(m.fighters[1].x - m.fighters[0].x);
const isAttacking = f => isAttack(f.move);
/** Busy: the fighter cannot start anything new until this ends. */
const busy = f => isAttacking(f) || f.move === 'jump' || f.move === 'getUp' || f.move === 'down' || f.move === 'ko';
const crouching = f => f.move === 'crouch' || f.move === 'down';
const invulnerable = f => f.move === 'ko' || f.move === 'down' || f.move === 'getUp' || f.invuln > 0;

/**
 * The clip a fighter shows now and how: { def, rate }. An attack without its own clip
 * shows the stance (moves.js); a computed jump shows the crouch; a knockdown plays the K.O. fall fast.
 */
export function animOf(f) {
    const moves = f.data.moves;
    if (isAttack(f.move)) return clipFor(f.data, f.move);
    if (moves[f.move]) return { def: moves[f.move], rate: 1, own: true };
    if (f.move === 'jump') return { def: moves.crouch ?? moves.idle, rate: 1, own: false };
    if (f.move === 'down' && moves.ko) {
        const n = moves.ko.frames.length / moves.ko.fps;
        return { def: moves.ko, rate: Math.max(1, n / KNOCKDOWN.fall), own: false };
    }
    return { def: moves.idle, rate: 1, own: false };
}

// A filmed jump already leaves the floor in the footage (its anchor sits below the feet): the
// picture is not raised again.
const filmedJump = f => f.move === 'jump' && !!f.data.moves.jump;
const arc = air => air.h * Math.sin(Math.PI * Math.min(1, Math.max(0, air.t / air.T)));

/** How far to raise the picture when drawing it (a filmed jump already rises in the footage). */
export const drawLiftOf = f => (f.air && !filmedJump(f) ? arc(f.air) : 0);

function startJump(f, h) {
    const filmed = f.data.moves.jump;
    enter(f, 'jump');
    f.air = { t: 0, T: filmed ? filmed.frames.length / filmed.fps : JUMP.T, h: filmed ? filmedPeak(f.data) : JUMP.h,
        vx: h * f.dir * JUMP.vx };
}

function startAttack(f, move) {
    enter(f, move);
    f.hitDone = false;
    f.crouchBack = false;
}

// The CPU: every few tenths of a second it reads the distance and picks a plan.
function think(m, f, foe) {
    const d = gap(m);
    const r = m.random();
    const kickReach = f.reach.kick + 20, punchReach = f.reach.punchMid + 20;
    const lowHp = f.hp < 35;
    const cpu = m.cpu;
    if (isAttack(foe.move) && d < reachOf(foe.data, foe.move) + 60 && r < (lowHp ? 0.35 : 0.2) * cpu.block) {
        f.plan = m.random() < 0.5 ? 'block' : 'blockLow';   // either guard stops both attacks
        f.planLeft = 0.45;
    } else if (d <= punchReach && r < 0.8 * cpu.attack) {
        f.plan = m.random() < 0.55 ? 'punchMid' : 'kick';
    } else if (d <= kickReach && r < 0.75 * cpu.attack) {
        f.plan = 'kick';
    } else if (d > kickReach && r < 0.9) {
        if (m.random() < 0.1 * cpu.attack && d < 460) f.plan = 'jumpIn';
        else {
            f.plan = 'approach';
            f.planLeft = 0.3 + 0.5 * m.random();
        }
    } else if (r < 0.88) {
        f.plan = 'idle';
        f.planLeft = 0.2 + 0.4 * m.random();
    } else if (r < 0.95) {
        f.plan = 'back';
        f.planLeft = 0.25 + 0.3 * m.random();
    } else {
        f.plan = 'crouch';
        f.planLeft = 0.3 + 0.4 * m.random();
    }
    f.think = (0.08 + 0.2 * m.random()) * cpu.think;
}

/**
 * A human corner's controls for the next step: { left, right, up, down, attack } where attack is
 * a press ('punchMid' or 'kick', as input.js names them).
 */
export function setInput(m, index, input) {
    const f = m.fighters[index];
    if (!f || f.control !== 'human') return;
    f.input = { left: !!input.left, right: !!input.right, up: !!input.up, down: !!input.down };
    const move = attackOf(input.attack);
    if (!move) return;
    // A press is held for a moment, so one made in the last frames of a swing still comes out.
    f.buffered = move;
    f.bufferT = 0.2;
}

// A human: the buffered attack first, then jump, crouch, and walking (back is the block).
function actHuman(m, f) {
    const i = f.input;
    const fwd = f.dir > 0 ? i.right : i.left, back = f.dir > 0 ? i.left : i.right;
    if (f.buffered && f.bufferT > 0) {
        const move = f.buffered;
        f.buffered = null;
        f.bufferT = 0;
        startAttack(f, move);
        return;
    }
    if (i.up) { startJump(f, fwd && !back ? 1 : back && !fwd ? -1 : 0); return; }
    if (i.down) { enter(f, 'crouch'); f.crouchBack = back && !fwd; return; }
    enter(f, fwd && !back ? 'walkF' : back && !fwd ? 'walkB' : 'idle');
}

function act(m, f) {
    switch (f.plan) {
        case 'approach': enter(f, 'walkF'); break;
        case 'back': case 'block': enter(f, 'walkB'); break;
        case 'blockLow': enter(f, 'crouch'); f.crouchBack = true; break;
        case 'crouch': enter(f, 'crouch'); f.crouchBack = false; break;
        case 'jumpIn': startJump(f, 1); f.plan = 'idle'; break;
        default:
            if (isAttack(f.plan)) { startAttack(f, f.plan); f.plan = 'idle'; }
            else enter(f, 'idle');
    }
}

function clampPair(m) {
    const [a, b] = m.fighters;
    for (const f of m.fighters) f.x = Math.min(ARENA.maxX, Math.max(ARENA.minX, f.x));
    // Bodies never pass through each other: push both apart evenly, then off a wall.
    const d = b.x - a.x;
    const want = ARENA.minGap * Math.sign(d || a.dir);
    if (Math.abs(d) < ARENA.minGap) {
        const fix = (want - d) / 2;
        a.x -= fix; b.x += fix;
        for (const [f, o] of [[a, b], [b, a]]) {
            if (f.x < ARENA.minX) { o.x += ARENA.minX - f.x; f.x = ARENA.minX; }
            if (f.x > ARENA.maxX) { o.x -= f.x - ARENA.maxX; f.x = ARENA.maxX; }
        }
    }
}

function land(f) {
    f.air = null;
    if (f.move === 'ko' || f.move === 'down') return;
    enter(f, 'idle');
    f.lag = Math.max(f.lag, LANDING_LAG);   // a jump lands with a short stagger
}

function stepFighter(m, f, foe, dt, free) {
    f.t += dt;
    f.flash = Math.max(0, f.flash - dt);
    f.bufferT = Math.max(0, f.bufferT - dt);
    f.invuln = Math.max(0, f.invuln - dt);
    f.comboT = Math.max(0, f.comboT - dt);
    if (f.comboT <= 0) f.combo = 0;
    f.shownHp += (f.hp - f.shownHp) * Math.min(1, dt * 4);   // the red trail behind the bar

    // Ends: a landing ends a jump; an attack ends with its clip.
    const mv = MOVES[f.move];
    if (f.air) {
        f.air.t += dt;
        f.x += f.air.vx * dt;
        if (f.air.t >= f.air.T) land(f);
    } else if (mv) {
        const a = animOf(f);
        if (frameAt(a.def, f.t * a.rate).done) {
            if (a.def.advance) f.x += f.dir * a.def.advance;
            const whiffed = !f.hitDone;
            enter(f, 'idle');
            if (whiffed) f.lag = Math.max(f.lag, mv.whiff ?? 0);
        }
    } else if (f.move === 'jump') {
        enter(f, 'idle');
    } else if (f.move === 'down' && f.t >= KNOCKDOWN.fall + KNOCKDOWN.floor) {
        enter(f, f.data.moves.getUp ? 'getUp' : 'idle');
        f.invuln = 0.15;
    } else if (f.move === 'getUp' && frameAt(f.data.moves.getUp, f.t).done) {
        enter(f, 'idle');
    }

    if (f.stun > 0) {
        f.stun -= dt;
        if (!busy(f)) enter(f, f.blocked ? (f.guard === 'low' ? 'crouch' : 'walkB') : 'idle');
    } else if (f.lag > 0) {
        f.lag -= dt;
    } else if (free && !busy(f) && f.control === 'human') {
        actHuman(m, f);
    } else if (free && !busy(f)) {
        f.planLeft -= dt;
        f.think -= dt;
        if (f.think <= 0) think(m, f, foe);
        else if (f.planLeft <= 0 && !isAttack(f.plan)) f.plan = 'idle';
        act(m, f);
    }
    // The guard: walking back or crouching back (kept through block stun).
    if (f.stun <= 0) f.guard = f.move === 'walkB' ? 'high' : f.move === 'crouch' && f.crouchBack ? 'low' : null;

    // Slide from a hit, damped to a stop.
    if (f.slide) {
        f.x += f.slide * dt;
        f.slide *= Math.exp(-9 * dt);
        if (Math.abs(f.slide) < 5) f.slide = 0;
    }
    const walk = f.data.moves[f.move];
    if (walk?.speed && f.stun <= 0) f.x += f.dir * walk.speed * dt;

}

/** Whether `def` guards right now (either guard stops both attacks). */
function guards(def) {
    if (def.stun > 0 && !def.blocked) return false;   // in hit stun
    if (def.air || def.lag > 0 || busy(def)) return false;
    return !!def.guard;
}

function knockDown(def, dir) {
    def.air = null;
    def.stun = 0;
    def.lag = 0;
    def.plan = 'idle';
    enter(def, 'down');
    def.slide = dir * KNOCKBACK * 1.15;
}

/** A blow meets `def`. spec: the move's table entry. */
function applyHit(m, att, def, move, spec, at) {
    const blocked = guards(def);
    if (blocked) { att.combo = 0; att.comboT = 0; }
    else {
        att.combo = att.comboT > 0 ? att.combo + 1 : 1;
        att.comboT = COMBO_WINDOW;
        def.combo = 0; def.comboT = 0;
    }
    const scale = Math.max(COMBO_FLOOR, 1 - COMBO_DECAY * (att.combo - 1));
    const damage = blocked ? (spec.chip ?? CHIP) : Math.max(1, Math.round(spec.damage * scale));
    def.hp = Math.max(0, def.hp - damage);
    def.blocked = blocked;
    def.flash = blocked ? 0.08 : 0.18;
    m.freeze = Math.max(m.freeze ?? 0, blocked ? BLOCK_STOP : HIT_STOP);
    const heavy = !!spec.heavy;
    const knock = !blocked && !!def.air && def.hp > 0;
    if (knock) {
        knockDown(def, att.dir);
        m.events.push({ type: 'knockdown', by: att.index, x: def.x });
    } else {
        def.stun = blocked ? spec.blockStun : spec.hitStun;
        def.slide = att.dir * (blocked ? BLOCK_KNOCKBACK : KNOCKBACK);
        if (!blocked && busy(def) && def.move !== 'getUp' && def.move !== 'down') { def.air = null; enter(def, 'idle'); }   // a hit cancels a swing
    }
    m.events.push({ type: blocked ? 'block' : 'hit', by: att.index, move, damage, heavy,
        combo: blocked ? 0 : att.combo, x: at.x, y: at.y });
    if (!blocked && !m.firstHit) { m.firstHit = true; m.events.push({ type: 'first', by: att.index }); }
    if (!blocked && att.combo >= 2) m.events.push({ type: 'combo', by: att.index, count: att.combo });
}

// One attack lands at most once, and only in its active window, while the limb reaches.
function resolveHit(m, att, def) {
    const mv = MOVES[att.move];
    if (!mv || att.hitDone || invulnerable(def)) return;
    const fd = frameData(att.data, att.move);
    const tt = att.t * animOf(att).rate;
    if (tt < fd.startup || tt >= fd.startup + fd.active) return;
    if ((def.x - att.x) * att.dir < -10) return;   // the foe is behind
    const f = pictureOf(att);
    if (f.r + 30 < gap(m)) return;
    if (mv.level === 'high' && crouching(def)) return;   // ducked: the punch sails over
    att.hitDone = true;
    applyHit(m, att, def, att.move, mv, { x: def.x - def.dir * 20, y: ARENA.ground - mv.hitY });
}

function endRound(m, reason) {
    const [a, b] = m.fighters;
    m.endReason = reason;   // 'ko' or 'time', for the banner
    m.roundWinner = a.hp === b.hp ? -1 : a.hp > b.hp ? 0 : 1;
    if (m.roundWinner === -1) { a.wins++; b.wins++; } else m.fighters[m.roundWinner].wins++;
    for (const f of m.fighters) {
        f.stun = 0; f.plan = 'idle'; f.air = null; f.lag = 0;
        if (f.hp <= 0) enter(f, 'ko');
        else if (reason === 'time' || f.move === 'jump' || f.move === 'down') enter(f, 'idle');
    }
    const w = m.roundWinner >= 0 ? m.fighters[m.roundWinner] : null;
    m.events.push({ type: reason === 'time' ? 'time' : 'ko', winner: m.roundWinner,
        perfect: !!w && w.hp === MAX_HP, double: a.hp <= 0 && b.hp <= 0 });
    m.phase = 'ko';
    m.phaseT = 0;
}

/** Advance the match by `dt` seconds. Returns the events of this step ({type: hit|block|ko|…}). */
export function stepMatch(m, dt) {
    m.events = [];
    m.time += dt;
    if (m.phase === 'fight' && m.freeze > 0) {   // hit-stop: nothing moves, the clock included
        m.freeze = Math.max(0, m.freeze - dt);
        return m.events;
    }
    m.phaseT += dt;
    const [a, b] = m.fighters;
    const P = PHASE_SECONDS;

    switch (m.phase) {
        case 'vs':
            if (m.phaseT >= P.vs) { m.phase = 'round'; m.phaseT = 0; m.events.push({ type: 'round', round: m.round }); }
            break;
        case 'round':
            if (m.phaseT >= P.round + P.fightCall) { m.phase = 'fight'; m.phaseT = 0; }
            break;
        case 'fight':
            m.clock = Math.max(0, m.clock - dt);
            break;
        case 'ko': {
            // The winner cheers once the loser is down; a draw just holds.
            const w = m.roundWinner >= 0 ? m.fighters[m.roundWinner] : null;
            if (w && m.phaseT >= 1 && w.move !== 'victory' && w.data.moves.victory) enter(w, 'victory');
            if (m.phaseT >= P.ko) {
                const champ = m.fighters.findIndex(f => f.wins >= WINS_NEEDED);
                if (a.wins >= WINS_NEEDED && b.wins >= WINS_NEEDED) m.winner = -1;
                else if (champ >= 0) m.winner = champ;
                if (m.winner !== null) {
                    m.phase = 'winner'; m.phaseT = 0;
                    m.events.push({ type: 'match', winner: m.winner });
                }
                else {
                    m.round += 1;
                    resetRound(m);
                    m.phase = 'round'; m.phaseT = 0;
                    m.events.push({ type: 'round', round: m.round });
                }
            }
            break;
        }
        case 'winner':
            if (m.phaseT < P.winner) break;
            if (m.rematch) { m.matchNo += 1; startMatch(m); }
            else { m.phase = 'done'; m.phaseT = 0; }
            break;
        case 'done':
            break;
    }

    const fighting = m.phase === 'fight';
    stepFighter(m, a, b, dt, fighting);
    stepFighter(m, b, a, dt, fighting);
    // Facing: always toward the other fighter (only on the ground and between swings).
    if (!isAttacking(a) && !isAttacking(b) && !a.air && !b.air) {
        a.dir = b.x >= a.x ? 1 : -1;
        b.dir = -a.dir;
    }
    clampPair(m);

    if (fighting) {
        resolveHit(m, a, b);
        resolveHit(m, b, a);
        if (a.hp <= 0 || b.hp <= 0) endRound(m, 'ko');
        else if (m.clock <= 0) endRound(m, 'time');
    }
    return m.events;
}

/** The picture a fighter shows now (for drawing). */
export function pictureOf(f) {
    const a = animOf(f);
    return a.def.frames[frameAt(a.def, f.t * a.rate).index];
}

/** How to draw a fighter now: { lift (raise the picture off the floor) }. Never scaled. */
export function poseOf(f) {
    return { lift: drawLiftOf(f) };
}
