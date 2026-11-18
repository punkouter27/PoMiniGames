// pofighter/index.js — the practice room the Blazor page drives (window.PoFighter).
//
//   PoFighter.start(root)  → loads the fighter, starts the loop. `root` is the page's room
//                            element; the engine finds its parts by data attribute:
//                              canvas[data-pf-canvas]      the stage
//                              [data-pf-hits]              hit counter text
//                              [data-pf-move="<move>"]     move-list rows (lit while playing)
//                              [data-pf-btn="<control>"]   touch buttons (left, kick, …)
//                              [data-pf-action]            reset / slow buttons
//   PoFighter.stop()       → cancels the loop and removes every listener
//   PoFighter.peek()       → a copy of the room state (browser tests)
//
// The page's markup is static, so the engine writes the counter and the highlights straight
// into it; there are no .NET callbacks. Nothing here is scored, saved or sent anywhere.

import { WORLD, ACTIONS, createState, reset, step, frameAt } from './sim.js';
import { BUTTONS, ButtonEdges, activePad, pressed, stick } from '../platform/gamepadBus.js';
import { createStage } from '../platform/stage/stage.js';
import { fitWorld } from '../platform/2d/camera2d.js';
import { listCustomFighters, getCustomFighter } from './studio.js';

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
const reducedMotion = () => document.documentElement.dataset.motion === 'reduce'
    || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let run = null;

function assetUrl(path) {
    return new URL(path, document.baseURI).href;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`PoFighter: could not load ${src}`));
        img.src = src;
    });
}

async function start(root, fighterId = 'p1') {
    stop();
    const session = { stopped: false, cleanup: [] };
    run = session;

    let data, sheet;
    if (fighterId && fighterId !== 'p1') {
        const custom = await getCustomFighter(fighterId);
        if (!custom) return false;
        data = custom.data;
        sheet = await loadImage(custom.sheetDataUrl);
    } else {
        const base = `data/pofighter/${fighterId || 'p1'}`;
        data = await (await fetch(assetUrl(`${base}.json`))).json();
        sheet = await loadImage(assetUrl(`data/pofighter/${data.sheet}`));
    }
    if (session.stopped) return false;

    const canvas = root.querySelector('[data-pf-canvas]');
    const hitsEl = root.querySelector('[data-pf-hits]');
    const rows = new Map([...root.querySelectorAll('[data-pf-move]')].map(el => [el.dataset.pfMove, el]));
    const state = createState();
    session.state = state;

    const keys = new Set(), touch = new Set(), pad = {};
    const tapped = new Set();     // controls pressed since the last step, so a quick tap between
                                  // two frames is not lost
    const presses = [];           // attack presses since the last step, in the order they came
    let slow = false;
    const stage = createStage({
        canvas, maxDpr: 2, maxDt: 0.05, pauseOn: ['hidden', 'blur'], exclude: ['shake'],
        timeScale: () => (slow ? 0.25 : 1),
        onStep: dt => stepRoom(dt),
        onFrame: () => { stage.render(draw); syncHud(); },
    });
    const ctx = stage.ctx;
    session.cleanup.push(() => stage.dispose());
    // Hidden tab or lost focus: the room holds still and forgets held controls.
    const forget = () => { keys.clear(); touch.clear(); presses.length = 0; tapped.clear(); };
    stage.on('pause', forget);
    stage.on('resume', forget);
    if (!document.hasFocus()) stage.setPaused(true, 'blur');
    const padEdges = new ButtonEdges();
    let shownHits = -1, shownMove = '';

    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        session.cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    const device = name => { if (root.dataset.pfDevice !== name) root.dataset.pfDevice = name; };
    const press = control => {
        tapped.add(control);
        if (ACTIONS.includes(control)) presses.push(control);
    };
    const doReset = () => { reset(state); presses.length = 0; };
    const toggleSlow = () => {
        slow = !slow;
        root.querySelector('[data-pf-action="slow"]')?.setAttribute('aria-pressed', String(slow));
    };

    on(window, 'keydown', e => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.target?.closest?.('input, textarea, select, dialog')) return;
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
            device('touch');
            touch.add(control);
            press(control);
        });
        on(btn, 'pointerup', release);
        on(btn, 'pointercancel', release);
        on(btn, 'pointerleave', release);
        on(btn, 'contextmenu', e => e.preventDefault());
    }
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

    function drawStage() {
        const far = 4000;   // the wall and floor run past the world so wide screens have no bars
        const wall = ctx.createLinearGradient(0, 0, 0, WORLD.ground);
        wall.addColorStop(0, '#232a45');
        wall.addColorStop(1, '#4a5580');
        ctx.fillStyle = wall;
        ctx.fillRect(-far, -far, far * 2 + WORLD.width, far + WORLD.ground);
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        for (let x = -1320; x < WORLD.width + 1400; x += 220) ctx.fillRect(x, 0, 6, WORLD.ground - 70);
        ctx.fillStyle = '#2d3558';
        ctx.fillRect(-far, WORLD.ground - 70, far * 2 + WORLD.width, 70);
        const floor = ctx.createLinearGradient(0, WORLD.ground - 34, 0, WORLD.height);
        floor.addColorStop(0, '#8a6a4c');
        floor.addColorStop(1, '#4f3a29');
        ctx.fillStyle = floor;
        ctx.fillRect(-far, WORLD.ground - 34, far * 2 + WORLD.width, far);
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(-far, WORLD.ground - 34, far * 2 + WORLD.width, 3);
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
        const squash = Math.max(0.35, 1 - state.lift / (WORLD.jumpLift * 2.2));
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(state.x, WORLD.ground - 4, 78 * squash, 13 * squash, 0, 0, Math.PI * 2);
        ctx.fill();
        const res = data.res ?? 1;   // sheet pixels per world unit
        ctx.drawImage(sheet, f.x, f.y, f.w, f.h, state.x - f.ax, WORLD.ground - f.ay, f.w / res, f.h / res);
    }

    function draw() {
        const { cssW, cssH } = stage.view;
        const cam = fitWorld(cssW, cssH, WORLD.width, WORLD.height, { alignY: 'bottom' });
        stage.setTransform(cam.scale, cam.x, cam.y);
        ctx.imageSmoothingQuality = 'high';
        drawStage();
        drawBag();
        drawFighter();
    }

    function syncHud() {
        if (state.hits !== shownHits) {
            shownHits = state.hits;
            if (hitsEl) hitsEl.textContent = String(state.hits);
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
        step(state, {
            left: held('left'), right: held('right'), up: held('up'), down: held('down'),
            attack: presses[0] ?? null,   // two pressed together: the first one plays
        }, dt, data);
        presses.length = 0;
        tapped.clear();
    }
    stage.start();
    stage.render(draw);
    syncHud();
    return true;
}

function stop() {
    if (!run) return;
    run.stopped = true;
    for (const undo of run.cleanup) undo();
    run = null;
}

window.PoFighter = {
    start,
    stop,
    listFighters: listCustomFighters,
    peek: () => (run?.state ? { ...run.state } : null),
};
