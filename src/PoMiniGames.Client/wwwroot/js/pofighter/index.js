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

import { WORLD, ATTACKS, createState, reset, step, frameAt } from './sim.js';
import { BUTTONS, ButtonEdges, activePad, pressed, stick } from '../gamepadBus.js';

const KEYS = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    KeyJ: 'punchMid', KeyK: 'punchHigh', KeyL: 'kick',
};
// Gamepad face buttons, read through the shared helpers in gamepadBus.js.
const PAD_ATTACKS = { [BUTTONS.west]: 'punchMid', [BUTTONS.north]: 'punchHigh', [BUTTONS.south]: 'kick' };
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

    const base = `data/pofighter/${fighterId}`;
    const data = await (await fetch(assetUrl(`${base}.json`))).json();
    const sheet = await loadImage(assetUrl(`data/pofighter/${data.sheet}`));
    if (session.stopped) return false;

    const canvas = root.querySelector('[data-pf-canvas]');
    const ctx = canvas.getContext('2d');
    const hitsEl = root.querySelector('[data-pf-hits]');
    const rows = new Map([...root.querySelectorAll('[data-pf-move]')].map(el => [el.dataset.pfMove, el]));
    const state = createState();
    session.state = state;

    const keys = new Set(), touch = new Set(), pad = {};
    const tapped = new Set();     // controls pressed since the last step, so a quick tap between
                                  // two frames is not lost
    const presses = [];           // attack presses since the last step, in the order they came
    let slow = false;
    const padEdges = new ButtonEdges();
    let shownHits = -1, shownMove = '';

    const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        session.cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    const device = name => { if (root.dataset.pfDevice !== name) root.dataset.pfDevice = name; };
    const press = control => {
        tapped.add(control);
        if (ATTACKS.includes(control)) presses.push(control);
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
    on(window, 'blur', () => { keys.clear(); touch.clear(); });

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

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    session.cleanup.push(() => observer.disconnect());
    resize();

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
        const squash = 1 - state.lift / (WORLD.jumpLift * 2.2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(state.x, WORLD.ground - 4, 78 * squash, 13 * squash, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(sheet, f.x, f.y, f.w, f.h, state.x - f.ax, WORLD.ground - state.lift - f.ay, f.w, f.h);
    }

    function render() {
        const scale = Math.min(canvas.width / WORLD.width, canvas.height / WORLD.height);
        ctx.setTransform(scale, 0, 0, scale,
            (canvas.width - WORLD.width * scale) / 2, canvas.height - WORLD.height * scale);
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

    let prev = performance.now();
    function tick(now) {
        if (session.stopped) return;
        session.raf = requestAnimationFrame(tick);
        // The first frame's timestamp can be earlier than the clock read above; never step backwards.
        const dt = Math.min(0.05, Math.max(0, (now - prev) / 1000)) * (slow ? 0.25 : 1);
        prev = now;
        // Hidden tab or lost focus: the room holds still and forgets held controls.
        if (document.hidden || !document.hasFocus()) { presses.length = 0; tapped.clear(); return; }
        readPad();
        const held = name => keys.has(name) || touch.has(name) || tapped.has(name) || !!pad[name];
        step(state, {
            left: held('left'), right: held('right'), up: held('up'), down: held('down'),
            attack: presses[0] ?? null,   // two pressed together: the first one plays
        }, dt, data);
        presses.length = 0;
        tapped.clear();
        render();
        syncHud();
    }
    session.raf = requestAnimationFrame(tick);
    render();
    syncHud();
    return true;
}

function stop() {
    if (!run) return;
    run.stopped = true;
    cancelAnimationFrame(run.raf);
    for (const undo of run.cleanup) undo();
    run = null;
}

window.PoFighter = { start, stop, peek: () => (run?.state ? { ...run.state } : null) };
