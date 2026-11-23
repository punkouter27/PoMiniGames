// pofighter/index.js — the practice room the Blazor page drives (window.PoFighter).
//
//   PoFighter.start(root)  → loads the fighter, starts the loop. `root` is the page's room
//                            element; the engine finds its parts by data attribute:
//                              canvas[data-pf-canvas]      the stage
//                              [data-pf-hits]              hit counter text
//                              [data-pf-move="<move>"]     move-list rows (lit while playing)
//                              [data-pf-btn="<control>"]   touch buttons (left, kick, …)
//                              [data-pf-action]            reset / slow buttons
//                              [data-pf-moves]             the move-card strip; it folds
//                                                          (is-collapsed) after IDLE_FOLD_MS
//                                                          without input
//   PoFighter.startDemo(root, exitRef, eloRef) → the CPU-vs-CPU demo instead (demo.js); eloRef
//                          rates each completed match on the fighter Elo board (DemoBoutFinished)
//   PoFighter.startTournament(root, dotnetRef, ratings) → the 16-slot tournament (tournament.js)
//   PoFighter.startArcade(root, dotnetRef, fighterId, difficulty, ratings) → 1P vs CPU ladder (arcade.js)
//   PoFighter.startVersus(root, dotnetRef, p1Id, p2Id) → local 2-player match (arcade.js)
//   PoFighter.stop()       → cancels the loop and removes every listener
//   PoFighter.peek()       → a copy of the room state (browser tests)
//   PoFighter.hideSheet(id) / showDialog(el) / closeDialog(el) → the page's popover sheet and
//                            the Studio <dialog> (Blazor cannot call element methods itself)
//
// The page's markup is static, so the engine writes the counter and the highlights straight
// into it; there are no .NET callbacks. Nothing here is scored, saved or sent anywhere.

import { WORLD, ACTIONS, createState, reset, step, frameAt } from './sim.js';
import { BUTTONS, ButtonEdges, activePad, pressed, stick } from '../platform/gamepadBus.js';
import { createStage } from '../platform/stage/stage.js';
import { fitWorld } from '../platform/2d/camera2d.js';
import { hitstop, vibrate } from '../platform/impactBus.js';
import { listCustomFighters } from './studio.js';
import { loadFighter, drawWall, drawFloor, FighterPainter, setKeyLight } from './art.js';
import { createFightFx } from './fx.js';
import { createFightAudio, createFoley } from './sfx.js';
import { createPostPass } from './post.js';
import { startDemo as runDemo } from './demo.js';
import { startTournament as runTournament } from './tournament.js';
import { startArcade as runArcade, startVersus as runVersus2p } from './arcade.js';

const KEYS = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    KeyJ: 'punchMid', KeyL: 'kick',
    KeyV: 'victory', KeyX: 'ko',
};
// Gamepad face buttons and bumpers, read through the shared helpers in gamepadBus.js.
const PAD_ATTACKS = {
    [BUTTONS.west]: 'punchMid', [BUTTONS.south]: 'kick',
    [BUTTONS.lb]: 'victory', [BUTTONS.rb]: 'ko',
};
/** The move strip folds into its "?" pill after this long without input. */
const IDLE_FOLD_MS = 5000;
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let run = null;

async function start(root, fighterId = 'p1') {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;

    const fighter = await loadFighter(fighterId || 'p1');
    if (!fighter || session.stopped) return false;
    const { data, sheet } = fighter;

    const canvas = root.querySelector('[data-pf-canvas]');
    const hitsEl = root.querySelector('[data-pf-hits]');
    const rows = new Map([...root.querySelectorAll('[data-pf-move]')].map(el => [el.dataset.pfMove, el]));
    const state = createState();
    session.state = state;
    const painter = new FighterPainter();

    const keys = new Set(), touch = new Set(), pad = {};
    const tapped = new Set();     // controls pressed since the last step, so a quick tap between
                                  // two frames is not lost
    const presses = [];           // attack presses since the last step, in the order they came
    let slow = false;
    // The fight's effects and sound (fx.js, sfx.js, post.js), aimed at the bag.
    const fx = createFightFx({ ground: WORLD.ground });
    const sfx = createFightAudio({ width: WORLD.width });
    const foley = createFoley(sfx, fx);   // the room opts out of camera shake
    const t0 = performance.now();
    let cheered = false;
    const stage = createStage({
        canvas, maxDpr: 2, maxDt: 0.05, pauseOn: ['hidden', 'blur'], exclude: ['shake'],
        // Slow motion, times the shared hitstop (a landed hit freezes the room for a beat).
        timeScale: () => (slow ? 0.25 : 1) * (globalThis.PoImpact?.getTimeScale?.() ?? 1),
        onStep: dt => stepRoom(dt),
        onFrame: () => { stage.render(draw); post.present(performance.now() / 1000); syncHud(); },
    });
    const ctx = stage.ctx;
    const post = createPostPass(canvas);
    session.cleanup.push(() => stage.dispose(), () => post.dispose(), () => sfx.dispose());
    // Hidden tab or lost focus: the room holds still and forgets held controls.
    const forget = () => { keys.clear(); touch.clear(); presses.length = 0; tapped.clear(); };
    stage.on('pause', forget);
    stage.on('resume', forget);
    if (!document.hasFocus()) stage.setPaused(true, 'blur');
    const padEdges = new ButtonEdges();
    let shownHits = -1, shownMove = '';
    const strip = root.querySelector('[data-pf-moves]');
    let lastInput = performance.now();
    const woke = () => {
        lastInput = performance.now();
        if (strip?.classList.contains('is-collapsed')) strip.classList.remove('is-collapsed');
    };

    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        session.cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    const device = name => { if (root.dataset.pfDevice !== name) root.dataset.pfDevice = name; };
    const press = control => {
        woke();
        tapped.add(control);
        if (ACTIONS.includes(control)) presses.push(control);
    };
    const doReset = () => { reset(state); presses.length = 0; };
    const toggleSlow = () => {
        slow = !slow;
        root.querySelector('[data-pf-action="slow"]')?.setAttribute('aria-pressed', String(slow));
    };

    on(window, 'keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.target?.closest?.('input, textarea, select, dialog, [popover]')) return;
        const control = KEYS[e.code];
        if (control) {
            e.preventDefault();
            device('keys');
            if (!e.repeat) { keys.add(control); press(control); }
        } else if (e.code === 'KeyR' && !e.repeat) doReset();
        else if (e.code === 'KeyT' && !e.repeat) toggleSlow();
    });
    on(window, 'keyup', e => keys.delete(KEYS[e.code]));

    for (const btn of root.querySelectorAll('[data-pf-btn]')) {
        const control = btn.dataset.pfBtn;
        const release = () => touch.delete(control);
        on(btn, 'pointerdown', e => {
            e.preventDefault();
            // A mouse click on a move card plays it without switching to the touch layout.
            if (e.pointerType !== 'mouse') { device('touch'); vibrate([8]); }
            touch.add(control);
            press(control);
        });
        on(btn, 'pointerup', release);
        on(btn, 'pointercancel', release);
        on(btn, 'pointerleave', release);
        on(btn, 'contextmenu', e => e.preventDefault());
    }
    const toggle = root.querySelector('[data-pf-moves-toggle]');
    if (toggle) on(toggle, 'click', woke);
    for (const btn of root.querySelectorAll('[data-pf-action]')) {
        on(btn, 'click', () => (btn.dataset.pfAction === 'reset' ? doReset() : toggleSlow()));
    }

    function readPad() {
        const gp = activePad();
        pad.left = pad.right = pad.up = pad.down = false;
        const went = padEdges.update(gp);
        if (!gp) return;
        const axis = stick(gp, 0.35);
        pad.left = pressed(gp, BUTTONS.left) || axis.x < -0.5;
        pad.right = pressed(gp, BUTTONS.right) || axis.x > 0.5;
        pad.up = pressed(gp, BUTTONS.up) || axis.y < -0.6;
        pad.down = pressed(gp, BUTTONS.down) || axis.y > 0.6;
        for (const index of went) if (PAD_ATTACKS[index]) press(PAD_ATTACKS[index]);
        if (went.length || pad.left || pad.right || pad.up || pad.down) device('pad');
    }

    function drawStage(t) {
        const still = reducedMotion();
        if (!still) setKeyLight(-1 + 0.22 * Math.sin(t * 0.13), -0.8 + 0.08 * Math.sin(t * 0.29));
        drawWall(ctx, WORLD.width, WORLD.ground, still ? 0 : t);
        drawFloor(ctx, WORLD.width, WORLD.ground, WORLD.height);
        fx.drawBack(ctx, t);
    }

    function drawBag() {
        const top = 40, bagTop = 190, bagH = 300, w = WORLD.bagHalf * 2;
        ctx.save();
        ctx.translate(WORLD.bagX, top);
        // Reduced motion: the bag still flashes on a hit but does not swing.
        ctx.rotate(reducedMotion() ? 0 : -state.bagSwing * 0.12);
        ctx.strokeStyle = '#9aa0b4';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, bagTop - top);
        ctx.stroke();
        ctx.fillStyle = '#b3372f';
        ctx.beginPath();
        ctx.roundRect(-w / 2, bagTop - top, w, bagH, 26);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(-w / 2, bagTop - top + 46, w, 12);
        ctx.fillRect(-w / 2, bagTop - top + bagH - 58, w, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(-w / 2 + 12, bagTop - top + 20, 10, bagH - 40);
        if (state.bagFlash > 0) {
            ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, state.bagFlash * 5)})`;
            ctx.beginPath();
            ctx.roundRect(-w / 2, bagTop - top, w, bagH, 26);
            ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = '#6d7389';
        ctx.fillRect(WORLD.bagX - 60, top - 10, 120, 10);

        if (state.bagFlash > 0) {
            const grow = 1 - state.bagFlash / 0.18;
            ctx.strokeStyle = `rgba(255,214,90,${1 - grow})`;
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.arc(WORLD.bagX - WORLD.bagHalf, WORLD.ground - state.hitY, 14 + grow * 46, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    function drawFighter() {
        const def = data.moves[state.move];
        const f = def.frames[frameAt(def, state.t).index];
        // The filmed jump already rises in the pictures; the shadow only shrinks.
        const reflect = (document.documentElement.dataset.gfx ?? 'high') === 'low' ? 0 : 0.16;
        painter.paint(ctx, sheet, data, f, state.x, WORLD.ground,
            { move: state.move, glow: fx.glowFor(state.x, 1), reflect, trail: true });
    }

    function draw() {
        const { cssW, cssH } = stage.view;
        const cam = fitWorld(cssW, cssH, WORLD.width, WORLD.height, { alignY: 'bottom' });
        stage.setTransform(cam.scale, cam.x, cam.y);
        ctx.imageSmoothingQuality = 'high';
        drawStage((performance.now() - t0) / 1000);
        drawBag();
        drawFighter();
        fx.drawFront(ctx);
    }

    function syncHud() {
        if (state.hits !== shownHits) {
            const landed = shownHits >= 0 && state.hits > shownHits;
            shownHits = state.hits;
            if (hitsEl) {
                hitsEl.textContent = String(state.hits);
                if (landed && !reducedMotion()) {
                    hitsEl.animate([{ transform: 'scale(1.7)', color: '#ffffff' }, { transform: 'scale(1)' }],
                        { duration: 260, easing: 'cubic-bezier(.3,1.6,.5,1)' });
                }
            }
        }
        if (strip && performance.now() - lastInput > IDLE_FOLD_MS && !strip.classList.contains('is-collapsed')) {
            strip.classList.add('is-collapsed');
        }
        if (state.move !== shownMove) {
            rows.get(shownMove)?.classList.remove('is-active');
            rows.get(state.move)?.classList.add('is-active');
            shownMove = state.move;
        }
    }

    function stepRoom(dt) {
        readPad();
        const held = name => keys.has(name) || touch.has(name) || tapped.has(name) || !!pad[name];
        if (keys.size || touch.size || pad.left || pad.right || pad.up || pad.down) woke();
        const hitsBefore = state.hits;
        step(state, {
            left: held('left'), right: held('right'), up: held('up'), down: held('down'),
            attack: presses[0] ?? null,   // two pressed together: the first one plays
        }, dt, data);
        presses.length = 0;
        tapped.clear();
        if (state.hits > hitsBefore) {   // a landed hit: sparks, light and a thud off the bag, a short hitstop
            const kick = state.move === 'kick';
            const e = { type: 'hit', move: state.move, combo: 0, x: WORLD.bagX - WORLD.bagHalf, y: WORLD.ground - state.hitY };
            // Sparks bounce back off the bag toward the fighter, the way the old spray did.
            fx.hit(e, -1, false, { sweat: false });
            sfx.impact(e);
            if (kick) post.kick(0.35);
            hitstop(kick ? 70 : 45);
        }
        // Every tenth hit the fighter cheers, and so does the crowd.
        if (state.move === 'victory' && !cheered) sfx.cheer(0.8);
        cheered = state.move === 'victory';
        foley.step([state], dt);
        sfx.update(dt, { fighting: false });
        fx.step(dt);
    }
    stage.start();
    stage.render(draw);
    syncHud();
    return true;
}

async function startDemo(root, exitRef, eloRef = null) {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;
    return runDemo(root, exitRef, session, eloRef);
}

async function startTournament(root, dotnetRef, ratings) {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;
    return runTournament(root, dotnetRef, ratings, session);
}

async function startArcade(root, dotnetRef, fighterId, difficulty, ratings) {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;
    return runArcade(root, dotnetRef, { fighterId, difficulty, ratings }, session);
}

async function startVersus(root, dotnetRef, p1, p2) {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;
    return runVersus2p(root, dotnetRef, { p1, p2 }, session);
}

function stop() {
    if (!run) return;
    run.stopped = true;
    for (const undo of run.cleanup) undo();
    run = null;
}

window.PoFighter = {
    start,
    startDemo,
    startTournament,
    startArcade,
    startVersus,
    stop,
    listFighters: listCustomFighters,
    peek: () => (run?.state ? { ...run.state } : null),
    hideSheet: id => { const el = document.getElementById(id); if (el?.matches?.(':popover-open')) el.hidePopover(); },
    showDialog: el => { if (el && !el.open) el.showModal(); },
    closeDialog: el => { if (el?.open) el.close(); },
};
