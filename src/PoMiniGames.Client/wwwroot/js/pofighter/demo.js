// pofighter/demo.js — two CPU fighters on the canvas with the arcade HUD (versus.js holds the
// rules). runVersus() plays either the endless attract-mode demo or one tournament bout;
// startDemo() is the demo: Kim vs Nick, best of three, forever. Every completed match (never one
// left early) is rated on the live fighter Elo board through eloRef.DemoBoutFinished, once per
// match, and the win card shows both fighters' new Elo and its change.
//
// Any key, tap or gamepad button leaves the demo through exitRef.invokeMethodAsync('ExitDemo')
// (the page navigates home). The page passes no exitRef while the kiosk reel is running, since
// the kiosk bar owns leaving there.
//
// Voices: fight events speak through voice.js (5 moods × 5 intensities per fighter, real clips
// when present, procedural otherwise). Audio only plays once a user gesture has unlocked it.

import { createStage } from '../platform/stage/stage.js';
import { addTrauma, claimHaptics, vibrate, hitstop, getTimeScale } from '../platform/impactBus.js';
import { fitWorld } from '../platform/2d/camera2d.js';
import { ButtonEdges, activePad } from '../platform/gamepadBus.js';
import { ROSTER, loadFighter, drawPicture, FighterPainter, setKeyLight } from './art.js';
import { ARENA, MAX_HP, ROUND_SECONDS, WINS_NEEDED, PHASE_SECONDS, QUOTE_AT, createMatch, stepMatch, pictureOf, poseOf,
    setInput } from './versus.js';
import { specOf, isAttack } from './moves.js';
import { STAGES, stageFor, drawStageWall, drawStageFloor, cheer as crowdCheer } from './stages.js';
import { loadQuotes, pickQuote } from './quotes.js';
import { say, loadManifest } from './voice.js';
import { createAnnouncer } from './announcer.js';
import { createFightFx } from './fx.js';
import { createFightAudio, createFoley } from './sfx.js';
import { createPostPass } from './post.js';

const VIEW = { width: ARENA.width, height: 620 };
const FONT = "'Arial Black', Impact, system-ui, sans-serif";
const P1_COLOR = '#ffd23f', P2_COLOR = '#4fc3ff';
const easeOut = k => 1 - (1 - k) ** 3;
// The K.O. finish, in real seconds from the knockout: slow motion until KO_SLOW_END, and a
// camera push toward the last hit that eases out by KO_ZOOM_END.
const KO_SLOW_END = 0.9, KO_ZOOM_END = 1.4, KO_ZOOM = 0.2;
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Loads the built-in fighters: [{ id, name, data, sheet }], or null if one failed. */
export async function loadRoster() {
    const loaded = await Promise.all(ROSTER.map(f => loadFighter(f.id)));
    return loaded.some(f => !f) ? null : ROSTER.map((f, i) => ({ ...f, ...loaded[i] }));
}

/**
 * Plays a match on root's canvas. fighters: two loaded fighters (the first starts left), each
 * optionally with { palette, input } — an input (input.js createInput) makes that corner human.
 * opts: { loop (rematch forever), exitRef, label (a caption under the timer, e.g. "FINAL"),
 *         final (louder celebration), difficulty (the CPU's: easy | normal | hard),
 *         onMatch (result, matchNo) → Promise<[winnerElo, winnerDelta, loserElo, loserDelta] | null>:
 *         called once per completed match; its numbers go on the win card }.
 * Resolves with { winnerId, loserId, isDraw, winnerIndex } when a single match ends (never when
 * looping), or null when the session is stopped first. winnerIndex is the fighters[] index
 * (−1 for a draw), which tells a mirror match's two corners apart.
 */
export function runVersus(root, session, fighters, opts = {}) {
    const { loop = false, exitRef = null, label = '', final = false, difficulty = 'normal', onMatch = null } = opts;
    const rated = new Set();         // match numbers already reported: a match counts once
    let elo = null;                  // { [fighterId]: [elo, delta] } for the current win card
    loadManifest();
    loadQuotes();
    const sheets = new Map(fighters.map(f => [f.data, f.sheet]));
    const inputs = fighters.map(f => f.input ?? null);
    const humans = inputs.some(Boolean);
    const match = createMatch(fighters.map(f => ({ id: f.id, name: f.name, data: f.data,
        palette: f.palette ?? 0, control: f.input ? 'human' : 'cpu' })),
        (Math.random() * 2 ** 31) | 0, { rematch: loop, difficulty });
    session.state = match;

    const canvas = root.querySelector('[data-pf-canvas]');
    // Hit effects: the world fx (fx.js: hit lights, sparks per blow, droplets, dust), slash
    // streaks and a ring; the fight's sound (sfx.js) and the finishing pass (post.js).
    const fx = createFightFx({ ground: ARENA.ground });
    const sfx = createFightAudio({ width: ARENA.width });
    const foley = createFoley(sfx, fx, () => addTrauma(0.25));
    const bars = [0, 1].map(() => ({ from: 0, to: 0, t: 9, shake: 0 }));          // the HUD's hit chunk
    let pan = 0;          // the camera's drift toward the fighters' midpoint (world units)
    const streaks = [];   // { x, y, a, len, life, max, color }
    const rings = [];     // { x, y, life, max, color }
    let lastHit = { x: ARENA.width / 2, y: ARENA.ground - 200 };
    let koAt = 0;         // performance.now() of the last knockout, 0 when none is playing
    const koAge = () => (koAt ? (performance.now() - koAt) / 1000 : Infinity);
    // The portraits at the outer end of each health bar (built-in fighters ship one).
    const portraits = fighters.map(f => {
        const src = f.portrait || (ROSTER.some(r => r.id === f.id) ? `data/pofighter/${f.id}-portrait.webp` : '');
        if (!src) return null;
        const img = new Image();
        img.src = src;
        return img;
    });
    const callouts = [null, null];   // per corner: { count, t } — the "3 HIT COMBO" under the bar
    const firsts = [null, null];     // per corner: seconds since its FIRST ATTACK tag appeared
    const shouts = [];               // a special's name over the fighter: { text, x, y, t, color }
    let arena = stageFor(match.fighters[1].id);   // the right-hand corner's home stage
    let quote = null;                // the winner's line on the win screen: { text, winner, loser, said }
    let perfect = false;             // the round just won was untouched
    let room = 0;                    // empty screen above the world (tall screens), for the caption
    let lastSecs = ROUND_SECONDS, secsPop = 9;   // the clock's digit pop in the last ten seconds
    const painters = [new FighterPainter(), new FighterPainter()];
    const angered = new Set();   // fighters who already growled at low health this round
    let finish = null;
    const done = new Promise(resolve => { finish = resolve; });
    const cleanup = [];
    // With a human playing, hits rumble that player's own pad (not just the last one used).
    if (humans) cleanup.push(claimHaptics());
    const stage = createStage({
        canvas, maxDpr: 2, maxDt: 0.05, pauseOn: humans ? ['hidden', 'blur'] : ['hidden'],
        // The shared hitstop freezes a landed hit for a beat; a knockout plays in slow motion.
        timeScale: () => getTimeScale() * (koAge() < KO_SLOW_END && !reducedMotion() ? 0.35 : 1),
        onStep: dt => step(dt),
        onFrame: () => { stage.render(draw); post.present(performance.now() / 1000); },
    });
    const post = createPostPass(canvas);
    cleanup.push(() => post.dispose(), () => sfx.dispose());
    if (humans && !document.hasFocus()) stage.setPaused(true, 'blur');
    const ctx = stage.ctx;
    let ended = false;
    const end = result => {
        if (ended) return;
        ended = true;
        for (const undo of cleanup.splice(0)) undo();
        stage.dispose();
        finish(result);
    };
    session.cleanup.push(() => end(null));
    // The announcer calls the two fighters on every VS screen (a rematch in the demo too).
    const announcer = createAnnouncer();
    cleanup.push(() => announcer.stop());
    const ANNOUNCE_HOLD = 2.5;   // the VS screen waits this long at most for the line to end
    let shownPhase = '', held = 0;

    // Leaving the demo: the first key, tap or pad button.
    let leaving = false;
    const leave = () => {
        if (leaving || !exitRef) return;
        leaving = true;
        exitRef.invokeMethodAsync('ExitDemo').catch(() => { });
    };
    const on = (target, type, handler) => {
        target.addEventListener(type, handler);
        cleanup.push(() => target.removeEventListener(type, handler));
    };
    if (exitRef) {
        on(window, 'keydown', e => {
            if (e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.key === 'Tab') return;
            e.preventDefault();
            leave();
        });
        on(root, 'pointerdown', leave);
    }
    const padEdges = new ButtonEdges();

    function voice(e) {
        const [a, b] = match.fighters;
        const by = i => match.fighters[i], other = i => match.fighters[1 - i];
        switch (e.type) {
            case 'round':
                angered.clear();
                say(a.id, 'insult', e.round === 3 ? 3 : 1);
                setTimeout(() => say(b.id, 'insult', e.round === 3 ? 3 : 1), 450);
                break;
            case 'hit': {
                const d = other(e.by);
                const level = (e.move === 'kick' ? 3 : 2) + (d.hp < 50 ? 1 : 0) + (d.hp < 25 ? 1 : 0);
                say(d.id, 'hurt', level);
                if (Math.random() < 0.25) say(by(e.by).id, 'happy', 1 + Math.floor(Math.random() * 2));
                if (d.hp > 0 && d.hp < 25 && !angered.has(d.id)) { angered.add(d.id); setTimeout(() => say(d.id, 'angry', 4), 350); }
                break;
            }
            case 'block':
                if (Math.random() < 0.5) say(by(e.by).id, 'angry', 2);
                else say(other(e.by).id, 'insult', 2);
                break;
            case 'ko':
                if (e.winner === -1) { say(a.id, 'angry', 3); say(b.id, 'angry', 3); break; }
                say(other(e.winner).id, 'hurt', 5);
                setTimeout(() => say(by(e.winner).id, 'happy', 3), 900);
                break;
            case 'time':
                if (e.winner >= 0) { say(by(e.winner).id, 'happy', 2); say(other(e.winner).id, 'angry', 3); }
                break;
            case 'match':
                if (e.winner >= 0) {
                    say(by(e.winner).id, 'celebrate', final ? 5 : 4);
                    setTimeout(() => say(other(e.winner).id, 'angry', final ? 5 : 3), 1400);
                }
                break;
        }
    }

    // The announcer's calls: the round, FIGHT!, first attack, big combos, the K.O., a perfect, the winner.
    function call(e) {
        const name = i => match.fighters[i].name;
        switch (e.type) {
            case 'round': announcer.announce(e.round === 3 ? 'Final round!' : `Round ${e.round}!`, 1.05); break;
            case 'first': announcer.announce('First attack!', 1.15); break;
            case 'combo': if (e.count >= 3) announcer.announce(`${e.count} hit combo!`, 1.15); break;
            case 'ko': announcer.announce(e.double ? 'Double K.O.!' : e.perfect ? 'K.O.! Perfect!' : 'K.O.!', 1); break;
            case 'time': announcer.announce(e.perfect ? 'Time over! Perfect!' : 'Time over!', 1.05); break;
            case 'match': announcer.announce(e.winner === -1 ? 'Draw game!' : `${name(e.winner)} wins!`, 1); break;
        }
    }

    // Haptics for the human corners: a thump on your pad when you are hit, a tick when you land
    // one, a long one for a K.O.; a phone played by touch buzzes instead.
    function feel(e) {
        if (!humans) return;
        const buzz = (i, strong, weak, ms, phone, opts) => {
            const input = inputs[i];
            if (!input) return;
            if (input.device === 'touch') vibrate(phone, { ...opts, pad: false });
            else input.rumble(strong, weak, ms, opts);
        };
        if (e.type === 'hit') {
            const heavy = !!e.heavy;
            buzz(1 - e.by, heavy ? 0.85 : 0.6, 0.5, heavy ? 140 : 100, [heavy ? 45 : 30]);
            buzz(e.by, 0.15, 0.45, 50, [12]);
        } else if (e.type === 'block') {
            buzz(1 - e.by, 0.1, 0.35, 45, [10]);
        } else if (e.type === 'ko') {
            for (const i of [0, 1]) buzz(i, i === e.winner ? 0.3 : 1, i === e.winner ? 0.5 : 0.8, i === e.winner ? 120 : 380,
                i === e.winner ? [25] : [90, 50, 120], { priority: true });
        }
    }

    function step(dt) {
        if (exitRef && padEdges.update(activePad()).length) leave();
        inputs.forEach((input, i) => { if (input) setInput(match, i, input.sample()); });
        for (const c of callouts) if (c) c.t += dt;
        for (let i = 0; i < 2; i++) if (firsts[i] !== null) firsts[i] += dt;
        for (const sh of shouts) sh.t += dt;
        for (let i = shouts.length - 1; i >= 0; i--) if (shouts[i].t > 1.2) shouts.splice(i, 1);
        secsPop += dt;
        if (match.phase === 'vs' && shownPhase !== 'vs') {
            const [a, b] = match.fighters;
            arena = stageFor(b.id);
            quote = null;
            announcer.announce(`${a.name}! Versus... ${b.name}!`);
            held = 0;
        }
        shownPhase = match.phase;
        // Hold the VS screen while the announcer is still talking.
        const holding = match.phase === 'vs' && match.phaseT >= PHASE_SECONDS.vs - 0.05
            && announcer.busy && held < ANNOUNCE_HOLD;
        if (holding) held += dt;
        const phaseBefore = match.phase, tBefore = match.phaseT;
        for (const e of holding ? [] : stepMatch(match, dt)) {
            voice(e);
            feel(e);
            call(e);
            if (e.type === 'combo') {
                callouts[e.by] = { count: e.count, t: 0 };
                if (e.count >= 3) say(match.fighters[e.by].id, 'happy', Math.min(5, e.count));
                sfx.cheer(Math.min(0.55, 0.15 + 0.1 * e.count));
                if (e.count >= 3) crowdCheer(Math.min(1, e.count / 5));
            } else if (e.type === 'round' || e.type === 'ko' || e.type === 'time') { callouts.fill(null); firsts.fill(null); }
            if (e.type === 'first') firsts[e.by] = 0;
            if (e.type === 'special') {
                const f = match.fighters[e.by];
                shouts.push({ text: `${e.name}!`, x: f.x, y: ARENA.ground - 390, t: 0, color: e.by === 0 ? P1_COLOR : P2_COLOR });
                say(f.id, 'angry', 3);
            } else if (e.type === 'projectile') {
                sfx.whoosh(e.x, 'kick');
                fx.puff(match.fighters[e.by].x, 0.3, -match.fighters[e.by].dir);
            } else if (e.type === 'clash') {
                fx.hit({ type: 'block', x: e.x, y: e.y }, 1);
                sfx.impact({ type: 'block', x: e.x }, false);
                burst(e.x, e.y, true, false, 1);
                burst(e.x, e.y, true, false, -1);
                addTrauma(0.2);
            } else if (e.type === 'knockdown') {
                addTrauma(0.3);
                crowdCheer(0.6);
            } else if (e.type === 'match' && e.winner >= 0) {
                const w = match.fighters[e.winner], l = match.fighters[1 - e.winner];
                quote = { text: pickQuote(w.id, l.name, Math.random()), winner: w, loser: l, said: false };
            }
            if (e.type === 'match' && onMatch && !rated.has(match.matchNo)) {
                rated.add(match.matchNo);
                elo = null;
                const [a, b] = match.fighters;
                const r = e.winner === -1 ? { winnerId: a.id, loserId: b.id, isDraw: true }
                    : { winnerId: match.fighters[e.winner].id, loserId: match.fighters[1 - e.winner].id, isDraw: false };
                Promise.resolve(onMatch(r, match.matchNo)).then(n => {
                    if (!session.stopped && Array.isArray(n) && n.length === 4) elo = { [r.winnerId]: [n[0], n[1]], [r.loserId]: [n[2], n[3]] };
                }).catch(() => { });
            }
            if (e.type === 'ko' || e.type === 'time') perfect = !!e.perfect;
            // The shared camera shake and hitstop (impactBus turns both off for reduced motion).
            if (e.type === 'hit' || e.type === 'block') {
                const att = match.fighters[e.by], def = match.fighters[1 - e.by];
                const heavy = !!e.heavy, blocked = e.type === 'block';
                const final = !blocked && def.hp <= 0;
                fx.hit(e, att.dir, final);
                sfx.impact(e, final);
                fx.puff(def.x, blocked ? 0.25 : heavy ? 0.7 : 0.45, -def.dir);   // feet skid back
                bars[def.index] = { from: def.hp + e.damage, to: def.hp, t: 0,
                    shake: blocked ? 0 : heavy || (e.combo ?? 0) >= 3 ? 1 : 0.5 };
                if (!blocked) {
                    addTrauma(heavy ? 0.32 : 0.22);
                    hitstop(heavy ? 55 : 35);   // on top of the sim's own freeze, so kept short
                    lastHit = { x: e.x, y: e.y };
                    post.kick(final ? 1 : heavy ? 0.45 : 0);
                }
                burst(e.x, e.y, heavy, blocked, att.dir);
            } else if (e.type === 'ko') {
                crowdCheer(1);
                addTrauma(0.5);
                hitstop(170);
                koAt = performance.now();
                sfx.knockout();
                sfx.stinger('ko');
            } else if (e.type === 'time') {
                sfx.stinger('ko');
            } else if (e.type === 'round') {
                sfx.stinger('round');
            } else if (e.type === 'match') {
                sfx.stinger('win');
                sfx.cheer(1);
            }
        }
        // FIGHT! is called when the round banner hands over, not by an event.
        if (match.phase === 'round' && phaseBefore === 'round' && tBefore < PHASE_SECONDS.round && match.phaseT >= PHASE_SECONDS.round) {
            sfx.stinger('fight');
            announcer.announce('Fight!', 1.15);
        }
        // The winner says their line as the quote card comes up.
        if (quote && !quote.said && match.phase === 'winner' && match.phaseT >= QUOTE_AT) {
            quote.said = true;
            say(quote.winner.id, 'insult', 3);
        }
        const secs = Math.ceil(match.clock);
        if (match.phase === 'fight' && secs !== lastSecs && secs <= 10) secsPop = 0;
        lastSecs = secs;
        foley.step(match.fighters, dt);
        const low = Math.min(...match.fighters.map(f => f.hp)) / MAX_HP;
        sfx.update(dt, { fighting: match.phase === 'fight', clock: (1 - match.clock / ROUND_SECONDS) ** 2,
            danger: 1 - low, round: match.round });
        fx.step(dt);
        for (const b of bars) { b.t += dt; b.shake = Math.max(0, b.shake - dt * 4); }
        const mid = (match.fighters[0].x + match.fighters[1].x) / 2;
        pan += (Math.max(-40, Math.min(40, (mid - ARENA.width / 2) * 0.15)) - pan) * Math.min(1, dt * 2.5);
        for (const list of [streaks, rings]) {
            for (const s of list) s.life -= dt;
            for (let i = list.length - 1; i >= 0; i--) if (list[i].life <= 0) list.splice(i, 1);
        }
        if (match.phase === 'done') {
            const w = match.winner;
            const [a, b] = match.fighters;
            end(w === -1 ? { winnerId: a.id, loserId: b.id, isDraw: true, winnerIndex: -1 }
                : { winnerId: match.fighters[w].id, loserId: match.fighters[1 - w].id, isDraw: false, winnerIndex: w });
        }
    }

    function burst(x, y, heavy, blocked, dir) {
        if (!blocked) {
            // Streaks fan out the way the blow went, not in a full ring.
            const base = dir > 0 ? 0 : Math.PI;
            for (let i = 0; i < (heavy ? 6 : 4); i++) {
                const max = 0.16 + Math.random() * 0.06;
                streaks.push({ x, y, a: base + (Math.random() - 0.5) * 2.2, len: (heavy ? 120 : 85) * (0.6 + Math.random() * 0.4),
                    life: max, max, color: i % 2 ? '#ffffff' : '#ffd65a' });
            }
        }
        rings.push({ x, y, life: 0.28, max: 0.28, color: blocked ? '#9fd8ff' : '#ffe9a0' });
    }

    // ---- drawing (world units: VIEW.width × VIEW.height, ground at ARENA.ground) ----

    function text(str, x, y, size, color, align = 'center', stroke = 8) {
        ctx.font = `${size}px ${FONT}`;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = stroke;
        ctx.strokeStyle = 'rgba(10,12,30,0.92)';
        ctx.strokeText(str, x, y);
        ctx.fillStyle = color;
        ctx.fillText(str, x, y);
    }

    function drawFighters() {
        const swinging = f => isAttack(f.move);
        const order = [...match.fighters].sort((a, b) => swinging(a) - swinging(b));   // the swinger in front
        const now = performance.now() / 1000;
        const reflect = (document.documentElement.dataset.gfx ?? 'high') === 'low' ? 0 : 0.16;
        for (const f of order) {
            const pose = poseOf(f);
            painters[f.index].paint(ctx, sheets.get(f.data), f.data, pictureOf(f), f.x, ARENA.ground,
                { move: f.move, dir: f.dir, flash: f.flash > 0 ? f.flash * 4 : 0, now, palette: f.palette,
                    glow: fx.glowFor(f.x, f.dir), reflect, trail: true, attacking: swinging(f),
                    lift: pose.lift });
        }
        drawProjectiles(now);
        // A blow that would end the round builds a warm glow around its target as it winds up.
        for (const f of match.fighters) {
            const foe = match.fighters[1 - f.index];
            const lethal = match.phase === 'fight' && isAttack(f.move) && !specOf(f.data, f.move).projectile
                && foe.hp <= specOf(f.data, f.move).damage && !reducedMotion();
            if (!lethal) continue;
            const k = Math.min(1, f.t / 0.2);
            const g = ctx.createRadialGradient(foe.x, ARENA.ground - 220, 20, foe.x, ARENA.ground - 220, 300);
            g.addColorStop(0, `rgba(255,170,90,${0.22 * k})`);
            g.addColorStop(1, 'rgba(255,170,90,0)');
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = g;
            ctx.fillRect(foe.x - 300, ARENA.ground - 520, 600, 600);
            ctx.restore();
        }
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const r of rings) {
            const k = 1 - r.life / r.max;
            ctx.globalAlpha = 1 - k;
            ctx.strokeStyle = r.color;
            ctx.lineWidth = 8 * (1 - k) + 1;
            ctx.beginPath();
            ctx.arc(r.x, r.y, 16 + easeOut(k) * 70, 0, Math.PI * 2);
            ctx.stroke();
        }
        for (const s of streaks) {
            const k = s.life / s.max;   // 1 to 0: the streak shoots out and thins away
            const from = s.len * (1 - k) * 0.6, to = from + s.len * k;
            ctx.globalAlpha = k;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 6 * k + 1;
            ctx.beginPath();
            ctx.moveTo(s.x + Math.cos(s.a) * from, s.y + Math.sin(s.a) * from);
            ctx.lineTo(s.x + Math.cos(s.a) * to, s.y + Math.sin(s.a) * to);
            ctx.stroke();
        }
        ctx.restore();
        fx.drawFront(ctx);
        // A special's name pops over the fighter who threw it and floats up.
        for (const sh of shouts) {
            const k = reducedMotion() ? 1 : Math.min(1, 0.4 + sh.t * 5);
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, (1.2 - sh.t) * 3));
            ctx.translate(sh.x, sh.y - (reducedMotion() ? 0 : sh.t * 15));
            ctx.scale(k, k);
            text(sh.text, 0, 0, 34, sh.color, 'center', 7);
            ctx.restore();
        }
    }

    // A Po Blast: a hot core in the thrower's colour, a ring that spins and a tail behind it.
    function drawProjectiles(now) {
        if (!match.projectiles.length) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const p of match.projectiles) {
            const color = p.owner === 0 ? '255,210,63' : '79,195,255';
            const back = -Math.sign(p.vx);
            for (let i = 6; i >= 1; i--) {   // the tail
                ctx.fillStyle = `rgba(${color},${0.08 * (7 - i) / 6})`;
                ctx.beginPath();
                ctx.arc(p.x + back * i * 16, p.y, 30 - i * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 48);
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.35, `rgba(${color},0.9)`);
            g.addColorStop(1, `rgba(${color},0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 48, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, 26, 16, reducedMotion() ? 0 : now * 14, 0.3, Math.PI * 1.5);
            ctx.stroke();
        }
        ctx.restore();
    }

    // The HUD: an angled bar per corner that drains toward the middle, a portrait at its outer
    // end, the name and round pips under it. A hit flashes the bar white; under a quarter of
    // health it pulses. The damage trail (shownHp) lags behind in red.
    const BAR = { w: 400, h: 26, y: 30, inset: 104, slant: 14 };
    function healthBar(f, side, t) {
        const { w, h, y, slant } = BAR;
        const x = side === 0 ? BAR.inset : VIEW.width - BAR.inset - w;
        // A parallelogram leaning away from the middle.
        const shape = (x0, x1) => {
            const lean = side === 0 ? -slant : slant;
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
            ctx.lineTo(x1 + lean, y + h);
            ctx.lineTo(x0 + lean, y + h);
            ctx.closePath();
        };
        const span = v => {   // the filled part, anchored at the middle end
            const pw = w * Math.max(0, Math.min(MAX_HP, v)) / MAX_HP;
            return side === 0 ? [x + w - pw, x + w] : [x, x + pw];
        };
        ctx.save();
        ctx.lineJoin = 'round';
        shape(x - 6, x + w + 6);
        ctx.fillStyle = 'rgba(10,12,30,0.88)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
        shape(x, x + w);
        ctx.fillStyle = '#4a0c18';
        ctx.fill();
        if (f.shownHp > f.hp) {
            shape(...span(f.shownHp));
            ctx.fillStyle = '#ff5a3c';
            ctx.fill();
        }
        const chunk = bars[side];   // the slice just lost flashes white, then hands over to the red trail
        if (chunk.t < 0.22 && chunk.from > chunk.to) {
            shape(...span(chunk.from));
            ctx.fillStyle = `rgba(255,255,255,${0.95 * (1 - chunk.t / 0.22)})`;
            ctx.fill();
        }
        const low = f.hp > 0 && f.hp <= MAX_HP / 4;
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        if (low) { grad.addColorStop(0, '#ff7a6a'); grad.addColorStop(0.5, '#ff3b2f'); grad.addColorStop(1, '#b3121b'); }
        else { grad.addColorStop(0, '#fff3a0'); grad.addColorStop(0.5, '#ffd23f'); grad.addColorStop(1, '#e8a412'); }
        const [h0, h1] = span(f.hp);
        shape(h0, h1);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';   // a gloss line along the top
        ctx.fillRect(h0, y + 3, Math.max(0, h1 - h0), 3);
        if (f.flash > 0) {
            shape(x, x + w);
            ctx.fillStyle = `rgba(255,255,255,${Math.min(0.7, f.flash * 4)})`;
            ctx.fill();
        }
        if (low && !reducedMotion()) {
            shape(x, x + w);
            ctx.strokeStyle = `rgba(255,90,60,${0.45 + 0.45 * Math.sin(t * 9)})`;
            ctx.lineWidth = 4;
            ctx.stroke();
        }
        ctx.restore();

        // The portrait, in a frame at the bar's outer end; both face the middle.
        const ps = 68, px = side === 0 ? 24 : VIEW.width - 24 - ps, py = 18;
        ctx.save();
        ctx.fillStyle = 'rgba(10,12,30,0.9)';
        ctx.fillRect(px - 3, py - 3, ps + 6, ps + 6);
        const img = portraits[f.index];
        if (img?.complete && img.naturalWidth) {
            const k = Math.max(ps / img.naturalWidth, ps / img.naturalHeight);
            ctx.beginPath();
            ctx.rect(px, py, ps, ps);
            ctx.clip();
            if (side === 1) { ctx.translate(px * 2 + ps, 0); ctx.scale(-1, 1); }
            ctx.drawImage(img, px + (ps - img.naturalWidth * k) / 2, py, img.naturalWidth * k, img.naturalHeight * k);
        } else {
            text(f.name.slice(0, 1).toUpperCase(), px + ps / 2, py + ps / 2, 40, '#ffffff', 'center', 6);
        }
        ctx.restore();
        ctx.lineWidth = 3;
        ctx.strokeStyle = side === 0 ? P1_COLOR : P2_COLOR;
        ctx.strokeRect(px - 1.5, py - 1.5, ps + 3, ps + 3);
        if (f.flash > 0) {
            ctx.fillStyle = `rgba(255,60,60,${Math.min(0.5, f.flash * 3)})`;
            ctx.fillRect(px, py, ps, ps);
        }

        const nameX = side === 0 ? x - 4 : x + w + 4;
        text(f.name.toUpperCase(), nameX, y + h + 22, 24, side === 0 ? P1_COLOR : P2_COLOR,
            side === 0 ? 'left' : 'right', 6);
        for (let i = 0; i < WINS_NEEDED; i++) {   // one diamond per round won, at the middle end
            const cx = side === 0 ? x + w - 12 - i * 28 : x + 12 + i * 28, cy = y + h + 20;
            ctx.beginPath();
            ctx.moveTo(cx, cy - 10); ctx.lineTo(cx + 10, cy); ctx.lineTo(cx, cy + 10); ctx.lineTo(cx - 10, cy);
            ctx.closePath();
            ctx.fillStyle = i < f.wins ? '#ffd23f' : 'rgba(10,12,30,0.75)';
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = i < f.wins ? '#ffffff' : 'rgba(255,255,255,0.45)';
            ctx.stroke();
        }
        if (inputs[side] && match.fighters[side] === f) {   // who is who in a 2P fight
            text(inputs.filter(Boolean).length > 1 ? `P${side + 1}` : 'YOU', px + ps / 2, py + ps + 16, 18, '#ffffff', 'center', 5);
        }
        // The combo callout: "3 HITS", popping in under the bar, gone a second after the last hit.
        const c = callouts[side];
        if (c && c.t < 1.1) {
            const k = reducedMotion() ? 1 : Math.min(1, 0.5 + c.t * 6);
            ctx.save();
            ctx.globalAlpha = Math.min(1, (1.1 - c.t) * 4);
            ctx.translate(side === 0 ? x + 80 : x + w - 80, y + h + 72);
            ctx.scale(k, k);
            text(`${c.count} HIT COMBO`, 0, 0, 30 + Math.min(5, c.count) * 4, c.count >= 4 ? '#ff5a3c' : '#ffd23f', 'center', 7);
            ctx.restore();
        }
        // FIRST ATTACK: a tag under the bar of whoever landed the round's first hit.
        const ft = firsts[side];
        if (ft !== null && ft < 1.6 && !(c && c.t < 1.1)) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, (1.6 - ft) * 3);
            text('FIRST ATTACK', side === 0 ? x + 110 : x + w - 110, y + h + 64, 26, '#ffffff', 'center', 6);
            ctx.restore();
        }
    }

    function drawHud(t) {
        const [a, b] = match.fighters;
        for (const [f, side] of [[a, 0], [b, 1]]) {
            // A heavy hit knocks the bar about for a beat.
            const s = reducedMotion() ? 0 : bars[side].shake;
            ctx.save();
            if (s > 0) ctx.translate(Math.sin(t * 90) * 7 * s, Math.cos(t * 70) * 4 * s);
            healthBar(f, side, t);
            ctx.restore();
        }
        const secs = match.phase === 'fight' || match.phase === 'ko' ? Math.ceil(match.clock) : ROUND_SECONDS;
        // The clock, in a hexagon badge between the bars; the last ten seconds glow red.
        const cx = VIEW.width / 2, cy = 50, r = 40;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const ang = Math.PI / 6 + i * Math.PI / 3;
            ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(10,12,30,0.9)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = secs <= 10 ? `rgba(255,107,90,${0.6 + 0.4 * Math.sin(t * 10)})` : 'rgba(255,210,63,0.85)';
        ctx.stroke();
        // In the last ten seconds each new second pops in big and settles.
        const pop = secs <= 10 && !reducedMotion() && secsPop < 0.25 ? 1 + 0.45 * (1 - easeOut(secsPop / 0.25)) : 1;
        ctx.save();
        ctx.translate(cx, cy + 2);
        ctx.scale(pop, pop);
        text(String(secs).padStart(2, '0'), 0, 0, 40, secs <= 10 ? '#ff6b5a' : '#ffffff', 'center', 6);
        ctx.restore();
        // The caption (STAGE 1, FINAL…) sits in the empty band above the bars when the screen has
        // one, so it never covers the fighters; otherwise just under the clock.
        if (label) {
            if (room >= 40) text(label, VIEW.width / 2, -Math.min(room, 110) / 2, 26, '#ffd23f', 'center', 6);
            else text(label, VIEW.width / 2, 108, 20, '#ffd23f', 'center', 5);
        }
        if (loop && match.phase !== 'ko' && (reducedMotion() || Math.floor(t * 1.6) % 2 === 0)) {
            text('DEMO', VIEW.width / 2, VIEW.height - 28, 26, '#ffffff', 'center', 6);   // the arcade's flashing tag
        }
    }

    // A banner slams in: it drops from 2.4x to a slight undershoot and settles, over a dark
    // band that wipes across behind it. s = seconds since it appeared.
    // Banners sit above the fighters' heads (a standing body reaches ~190 under the floor line).
    const BANNER_Y = 135;
    function banner(str, color, size = 96, s = 1) {
        const still = reducedMotion();
        const k = still ? 1 : Math.min(1, s / 0.22);
        const grow = still ? 1 : k < 1 ? 2.4 - 1.5 * easeOut(k) : 0.9 + 0.1 * easeOut(Math.min(1, (s - 0.22) / 0.18));
        const band = still ? 1 : easeOut(Math.min(1, s / 0.3));
        ctx.save();
        ctx.fillStyle = 'rgba(8,10,28,0.55)';
        // On a tall screen the banner rises into the empty band above the bars, clear of the fighters.
        const bh = size * 1.05, bw = VIEW.width * band, by = BANNER_Y - Math.min(70, room * 0.6);
        ctx.beginPath();
        ctx.moveTo(0, by - bh / 2); ctx.lineTo(bw + 40, by - bh / 2); ctx.lineTo(bw, by + bh / 2); ctx.lineTo(0, by + bh / 2);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.translate(VIEW.width / 2, by);
        ctx.scale(grow, grow);
        text(str, 0, 0, size, color, 'center', 14);
        ctx.restore();
    }

    // The round wipe: a two-tone diagonal sweeps across the stage as a round starts.
    function drawWipe(t) {
        if (reducedMotion() || t > 0.45) return;
        const k = t / 0.45, H = VIEW.height;
        const x = -VIEW.width * 0.7 + easeOut(k) * VIEW.width * 2.4;
        ctx.save();
        for (const [off, color] of [[0, 'rgba(255,210,63,0.9)'], [70, 'rgba(23,28,56,0.95)']]) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(x - off, -40); ctx.lineTo(x - off + 260, -40); ctx.lineTo(x - off + 60, H + 40); ctx.lineTo(x - off - 200, H + 40);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    function drawBanners() {
        const p = match.phase, t = match.phaseT, P = PHASE_SECONDS;
        const pop = s => s;
        if (p === 'round') drawWipe(t);
        if (p === 'round') {
            if (t < P.round) banner(match.round === 3 ? 'FINAL ROUND' : `ROUND ${match.round}`, '#ffffff', 84, pop(t));
            else banner('FIGHT!', '#ff5a3c', 120, pop(t - P.round));
        } else if (p === 'ko') {
            const [a, b] = match.fighters;
            const called = match.endReason === 'time' ? 'TIME OVER' : a.hp <= 0 && b.hp <= 0 ? 'DOUBLE K.O.' : 'K.O.';
            // A perfect round: the banner turns into a colour-cycling PERFECT after a beat.
            if (perfect && t > 1.2) banner('PERFECT', `hsl(${reducedMotion() ? 48 : Math.round(t * 360) % 360}, 100%, 65%)`, 110, pop(t - 1.2));
            else banner(called, '#ff3b3b', called === 'K.O.' ? 130 : 100, pop(t));
            if (t > 1.2) {   // on the floor, under the fighters' feet
                const w = match.roundWinner;
                text(w === -1 ? 'DRAW' : `${match.fighters[w].name.toUpperCase()} WINS THE ROUND`, VIEW.width / 2, VIEW.height - 30, 34, '#ffffff');
            }
        } else if (p === 'winner' || p === 'done') {
            const w = match.winner;
            if (p === 'winner' && quote && t >= QUOTE_AT) { drawQuote(t - QUOTE_AT); return; }
            banner(w === -1 ? 'DRAW GAME' : `${match.fighters[w].name.toUpperCase()} WINS!`,
                w === 0 ? P1_COLOR : w === 1 ? P2_COLOR : '#ffffff', 92, pop(t));
        }
    }

    // The win screen: the winner's portrait large, the loser's beaten and grey, and the winner's
    // line typed out under them.
    function portraitBox(img, f, x, y, size, beaten) {
        ctx.save();
        ctx.fillStyle = 'rgba(10,12,30,0.95)';
        ctx.fillRect(x - 5, y - 5, size + 10, size + 10);
        ctx.beginPath();
        ctx.rect(x, y, size, size);
        ctx.clip();
        if (img?.complete && img.naturalWidth) {
            const k = Math.max(size / img.naturalWidth, size / img.naturalHeight);
            if (beaten) ctx.filter = 'grayscale(1) brightness(0.55) contrast(1.2)';
            ctx.drawImage(img, x + (size - img.naturalWidth * k) / 2, y, img.naturalWidth * k, img.naturalHeight * k);
            ctx.filter = 'none';
        } else {
            text(f.name.slice(0, 1).toUpperCase(), x + size / 2, y + size / 2, size * 0.5, beaten ? '#777777' : '#ffffff', 'center', 8);
        }
        if (beaten) {   // a crack across the beaten face
            ctx.strokeStyle = 'rgba(255,255,255,0.75)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x + size * 0.15, y); ctx.lineTo(x + size * 0.45, y + size * 0.4);
            ctx.lineTo(x + size * 0.35, y + size * 0.55); ctx.lineTo(x + size * 0.7, y + size);
            ctx.stroke();
        }
        ctx.restore();
    }

    function wrapLines(str, width, size) {
        ctx.font = `${size}px ${FONT}`;
        const lines = [];
        let line = '';
        for (const word of str.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; } else line = next;
        }
        if (line) lines.push(line);
        return lines;
    }

    function drawQuote(s) {
        const fade = reducedMotion() ? 1 : Math.min(1, s / 0.3);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = 'rgba(6,8,22,0.94)';
        ctx.fillRect(-4000, -4000, 8000 + VIEW.width, 8000);
        const wi = quote.winner.index, li = quote.loser.index;
        const color = wi === 0 ? P1_COLOR : P2_COLOR;
        const slide = reducedMotion() ? 0 : (1 - easeOut(Math.min(1, s / 0.35))) * 300;
        portraitBox(portraits[wi], quote.winner, 120 - slide, 70, 250, false);
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.strokeRect(117 - slide, 67, 256, 256);
        portraitBox(portraits[li], quote.loser, VIEW.width - 300 + slide, 150, 170, true);
        text(quote.winner.name.toUpperCase(), 420 - slide * 0.5, 120, 54, color, 'left', 9);
        text('WINS', 420 - slide * 0.5, 180, 34, '#ffffff', 'left', 7);
        // The fighter Elo board after this match (demo): new rating and its change.
        const eloText = id => elo?.[id] ? `ELO ${elo[id][0]} (${elo[id][1] >= 0 ? '+' : ''}${elo[id][1]})` : null;
        if (eloText(quote.winner.id)) text(eloText(quote.winner.id), 420 - slide * 0.5, 230, 26, color, 'left', 5);
        if (eloText(quote.loser.id)) text(eloText(quote.loser.id), VIEW.width - 215 + slide, 350, 22, '#bbbbbb', 'center', 4);
        // The line, typed out.
        const shown = reducedMotion() ? quote.text : quote.text.slice(0, Math.floor(Math.max(0, s - 0.3) * 45));
        const box = { x: 100, y: 370, w: VIEW.width - 200, h: 170 };
        ctx.fillStyle = 'rgba(23,28,56,0.95)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 3;
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        wrapLines(`"${shown}`, box.w - 60, 30).forEach((l, i) => text(l, box.x + 30, box.y + 45 + i * 42, 30, '#ffffff', 'left', 5));
        ctx.restore();
    }

    function drawVs() {
        const t = match.phaseT;
        ctx.fillStyle = 'rgba(8,10,28,0.88)';
        ctx.fillRect(-4000, -4000, 8000 + VIEW.width, 8000);
        const slide = reducedMotion() ? 0 : Math.max(0, 1 - t * 2.5) * 500;
        // Two diagonal panels in the corner colours slide in from each side and meet at the VS.
        const mid = VIEW.width / 2, H = VIEW.height;
        for (const [side, color] of [[0, 'rgba(255,210,63,0.16)'], [1, 'rgba(79,195,255,0.16)']]) {
            const sx = side === 0 ? -slide * 1.4 : slide * 1.4;
            ctx.fillStyle = color;
            ctx.beginPath();
            if (side === 0) { ctx.moveTo(sx - 4000, -40); ctx.lineTo(sx + mid + 70, -40); ctx.lineTo(sx + mid - 70, H + 40); ctx.lineTo(sx - 4000, H + 40); }
            else { ctx.moveTo(sx + mid + 78, -40); ctx.lineTo(sx + 4000 + VIEW.width, -40); ctx.lineTo(sx + 4000 + VIEW.width, H + 40); ctx.lineTo(sx + mid - 62, H + 40); }
            ctx.closePath();
            ctx.fill();
        }
        match.fighters.forEach((f, i) => {
            const idle = f.data.moves.idle.frames[0];
            const x = i === 0 ? 290 - slide : VIEW.width - 290 + slide;
            ctx.save();
            ctx.translate(x, 520);
            ctx.scale(1.25, 1.25);
            drawPicture(ctx, sheets.get(f.data), f.data, idle, 0, 0, i === 0 ? 1 : -1, 0, f.palette);
            ctx.restore();
            text(f.name.toUpperCase(), x, 568, 48, i === 0 ? P1_COLOR : P2_COLOR);
        });
        // The announcer between the fighters, the VS mark under him.
        announcer.draw(ctx, VIEW.width / 2, 430, 300, reducedMotion());
        const vs = reducedMotion() ? 1 : Math.min(1, Math.max(0, (t - 0.35) * 4));
        if (vs > 0) {
            ctx.save();
            ctx.translate(VIEW.width / 2, 470);
            ctx.scale(0.5 + vs * 0.5, 0.5 + vs * 0.5);
            text('VS', 0, 0, 100, '#ff5a3c', 'center', 14);
            ctx.restore();
        }
        if (label) text(label, VIEW.width / 2, 100, 40, '#ffd23f', 'center', 8);
        text('BEST OF THREE', VIEW.width / 2, 528, 24, '#ffffff', 'center', 6);
        text(`STAGE · ${STAGES[arena].name.toUpperCase()}`, VIEW.width / 2, 600, 20, '#ffd23f', 'center', 5);
    }

    const t0 = performance.now();
    function draw() {
        const { cssW, cssH } = stage.view;
        const cam = fitWorld(cssW, cssH, VIEW.width, VIEW.height, { alignY: 'bottom' });
        room = Math.max(0, cam.y / cam.scale);   // world units of empty screen above the world
        // The K.O. push: the world zooms toward the last hit and eases back; the HUD stays put.
        const age = koAge();
        let z = 1;
        if (age < KO_ZOOM_END && !reducedMotion()) {
            z = 1 + KO_ZOOM * (age < 0.15 ? easeOut(age / 0.15) : age < KO_SLOW_END ? 1
                : 1 - easeOut((age - KO_SLOW_END) / (KO_ZOOM_END - KO_SLOW_END)));
        }
        const hx = lastHit.x, hy = Math.min(lastHit.y, ARENA.ground - 120);
        const still = reducedMotion();
        const shift = still ? 0 : pan;
        // The world on a camera zoomed by zz and drifted by `by` world units.
        const world = (zz, by) => stage.setTransform(cam.scale * zz,
            cam.x + hx * cam.scale * (1 - zz) - by * cam.scale * zz, cam.y + hy * cam.scale * (1 - zz));
        const t = (performance.now() - t0) / 1000;
        // The key light drifts a little, as if the windows' light moved with clouds.
        if (!still) setKeyLight(-1 + 0.22 * Math.sin(t * 0.13), -0.8 + 0.08 * Math.sin(t * 0.29));
        ctx.imageSmoothingQuality = 'high';
        if (match.phase === 'vs') {
            world(z, 0);
            drawStageWall(ctx, arena, VIEW.width, ARENA.ground, t);
            drawStageFloor(ctx, arena, VIEW.width, ARENA.ground, VIEW.height);
            stage.setTransform(cam.scale, cam.x, cam.y);
            drawVs();
            drawVignette(0);
            drawIris(match.phaseT);
            return;
        }
        // Depth: the wall sits farther back, so it moves less than the floor and the fighters.
        world(1 + (z - 1) * 0.45, shift * 0.4);
        drawStageWall(ctx, arena, VIEW.width, ARENA.ground, still ? 0 : t);
        world(z, shift);
        drawStageFloor(ctx, arena, VIEW.width, ARENA.ground, VIEW.height);
        fx.drawBack(ctx, t);
        drawFighters();
        stage.setTransform(cam.scale, cam.x, cam.y);
        drawVignette(age < KO_ZOOM_END ? 1 - age / KO_ZOOM_END : 0);
        drawHud(t);
        drawBanners();
        if (age < 0.4) {   // the K.O. flash
            ctx.fillStyle = `rgba(255,255,255,${(still ? 0.25 : 0.75) * (1 - age / 0.4)})`;
            ctx.fillRect(-4000, -4000, 8000 + VIEW.width, 8000);
        }
        drawDip();
    }

    // The match opens with an iris: a circle of picture growing out of black.
    function drawIris(s) {
        if (reducedMotion() || s > 0.45) return;
        const r = easeOut(s / 0.45) * VIEW.width * 0.8;
        ctx.save();
        ctx.fillStyle = '#05060f';
        ctx.beginPath();
        ctx.rect(-4000, -4000, 8000 + VIEW.width, 8000);
        ctx.arc(VIEW.width / 2, VIEW.height / 2, Math.max(1, r), 0, Math.PI * 2, true);
        ctx.fill('evenodd');
        ctx.restore();
    }

    // Dips to dark: briefly between rounds (the end of the K.O. hold), and fully at the end of a
    // single match, so the end card rises out of black instead of cutting in.
    function drawDip() {
        const p = match.phase, s = match.phaseT, P = PHASE_SECONDS;
        let k = 0;
        const decided = match.fighters.some(f => f.wins >= WINS_NEEDED);   // the winner card follows instead
        if (p === 'ko' && !decided) k = Math.max(0, (s - (P.ko - 0.3)) / 0.3) * 0.85;
        else if (p === 'round' && s < 0.15) k = 0.85 * (1 - s / 0.15);
        else if (p === 'winner' && !loop) k = Math.max(0, (s - (P.winner - 0.6)) / 0.6);
        else if (p === 'done') k = 1;
        if (k <= 0) return;
        ctx.fillStyle = `rgba(5,6,15,${Math.min(1, k)})`;
        ctx.fillRect(-4000, -4000, 8000 + VIEW.width, 8000);
    }

    // A soft vignette frames the stage; it closes in during a knockout.
    function drawVignette(ko) {
        const cx = VIEW.width / 2, cy = VIEW.height * 0.55;
        const g = ctx.createRadialGradient(cx, cy, VIEW.height * (0.45 - 0.15 * ko), cx, cy, VIEW.width * 0.75);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, `rgba(0,0,12,${0.42 + 0.3 * ko})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, VIEW.width, VIEW.height);
    }

    stage.start();
    stage.render(draw);
    return done;
}

/** The attract-mode demo: Kim (left) vs Nick, best of three, rematches forever. */
export async function startDemo(root, exitRef, session, eloRef = null) {
    const roster = await loadRoster();
    if (session.stopped || !roster) return false;
    const kim = roster.find(f => f.id === 'kim'), nick = roster.find(f => f.id === 'p1');
    const onMatch = eloRef
        ? (r, matchNo) => eloRef.invokeMethodAsync('DemoBoutFinished', matchNo, r.winnerId, r.loserId, r.isDraw)
        : null;
    runVersus(root, session, [kim, nick], { loop: true, exitRef, onMatch });
    return true;
}
