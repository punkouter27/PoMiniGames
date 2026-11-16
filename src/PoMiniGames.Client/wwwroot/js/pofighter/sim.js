// pofighter/sim.js — the practice room's rules. Pure: no DOM, no clock, no randomness, so
// tests/pofighter-sim.test.mjs can drive it directly.
//
// Units are sprite-sheet pixels: the fighter data (data/pofighter/<id>.json, written by
// scripts/pofighter/pack.py) gives every picture an anchor on the ground line and `r`, how far
// its outline reaches in front of that anchor. An attack hits with `r`. A filmed jump or lunge
// leaves the floor in the pictures themselves (the anchor sits below the feet), so the rules
// only read how high the picture is, for the shadow.

export const WORLD = {
    width: 1100, height: 620, ground: 560,
    minX: 140, startX: 300,
    bagX: 800, bagHalf: 48,
    // The fighter stops where the raised guard just touches the bag; only an attack reaches it.
    standOff: 150,
    jumpLift: 120,   // the height the shadow is scaled against
};

export const ATTACKS = ['punchMid', 'punchHigh', 'kick', 'lunge'];
// Everything a single press asks for: the attacks, a cheer and a fall.
export const ACTIONS = [...ATTACKS, 'victory', 'ko'];
// These play to their end; nothing cancels them.
const LOCKED = new Set(['jump', 'getUp', ...ATTACKS]);
// Where on the bag each attack lands, as a height above the ground (for the spark).
const HIT_HEIGHT = { punchMid: 265, punchHigh: 310, kick: 245, lunge: 290 };
const BAG_PUSH = { kick: 3.2, lunge: 3.6 };

export const CHEER_EVERY = 10;        // every tenth hit, the fighter celebrates
export const VICTORY_SECONDS = 2.4;   // a cheer's length when nothing interrupts it
const VICTORY_LOCK = 0.5;             // ...and how long before input can interrupt it
const KO_LOCK = 0.8;                  // the fall always plays this long before a press gets up

export const maxX = () => WORLD.bagX - WORLD.bagHalf - WORLD.standOff;

export function createState() {
    return {
        move: 'idle', t: 0, x: WORLD.startX, lift: 0,
        hits: 0, hitDone: false, cheer: false,
        bagFlash: 0, bagSwing: 0, bagVel: 0, hitY: 0,
    };
}

export function reset(state) {
    return Object.assign(state, createState());
}

/** Which picture of `def` shows `t` seconds into the move, and whether a one-shot has ended. */
export function frameAt(def, t) {
    const n = def.frames.length;
    const i = Math.max(0, Math.floor(t * def.fps));
    switch (def.loop) {
        case 'loop': return { index: i % n, done: false };
        case 'pingpong': {
            const period = Math.max(1, 2 * n - 2);
            const j = i % period;
            return { index: j < n ? j : period - j, done: false };
        }
        case 'hold': return { index: Math.min(i, n - 1), done: false };
        default: return { index: Math.min(i, n - 1), done: i >= n };
    }
}

const anyInput = input => !!(input.left || input.right || input.up || input.down || input.attack);

// What the controls ask for when the fighter is free to act. Jump beats an action, an action
// beats crouch, and opposite directions cancel out.
function wanted(input) {
    if (input.up) return 'jump';
    if (input.attack) return input.attack;
    if (input.down) return 'crouch';
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    return dir > 0 ? 'walkF' : dir < 0 ? 'walkB' : 'idle';
}

function enter(state, move) {
    state.move = move;
    state.t = 0;
    state.hitDone = false;
}

function clampX(state) {
    state.x = Math.min(maxX(), Math.max(WORLD.minX, state.x));
}

/**
 * Advance the room by `dt` seconds.
 * input: { left, right, up, down, attack } where attack is null or one of ACTIONS, set only
 * on the step the control was pressed.
 */
export function step(state, input, dt, data) {
    const moves = data.moves;
    state.t += dt;

    const current = moves[state.move];
    if (LOCKED.has(state.move) && frameAt(current, state.t).done) {
        // A lunge ends where the body landed, not where it took off.
        if (current.advance) { state.x += current.advance; clampX(state); }
        const cheer = state.cheer && moves.victory;
        state.cheer = false;
        enter(state, cheer ? 'victory' : 'idle');
    } else if (state.move === 'victory' && state.t >= VICTORY_SECONDS) {
        enter(state, 'idle');
    }

    let free;
    switch (state.move) {
        case 'ko':
            // Down until a press after the fall; then the fall plays backwards to stand up.
            if (state.t >= KO_LOCK && anyInput(input)) enter(state, moves.getUp ? 'getUp' : 'idle');
            free = false;
            break;
        case 'victory': free = state.t >= VICTORY_LOCK && anyInput(input); break;
        default: free = !LOCKED.has(state.move);
    }
    if (free) {
        let want = wanted(input);
        if (!moves[want]) want = 'idle';   // a move the video did not have shows the stance
        if (want !== state.move) enter(state, want);
    }

    const def = moves[state.move];
    const { index } = frameAt(def, state.t);
    const f = def.frames[index];
    // How far the picture's feet are off the floor (its anchor sits below the outline).
    // The sheet may be baked at `res` pixels per world unit; anchors are already world units.
    state.lift = f.h !== undefined ? Math.max(0, f.ay - f.h / (data.res ?? 1)) : 0;

    // A walk carries its own speed, measured from the footage so the feet do not slide.
    if (def.speed) state.x += def.speed * dt;
    clampX(state);

    // One attack, at most one hit, and only while the limb is extended and reaches the bag.
    if (def.hitMin !== undefined && !state.hitDone) {
        const reach = f.r;
        if (reach >= def.hitMin && state.x + reach >= WORLD.bagX - WORLD.bagHalf) {
            state.hitDone = true;
            state.hits += 1;
            state.bagFlash = 0.18;
            state.bagVel += BAG_PUSH[state.move] ?? 2;
            state.hitY = HIT_HEIGHT[state.move] ?? 260;
            if (state.hits % CHEER_EVERY === 0) state.cheer = true;
        }
    }

    // The bag is a damped pendulum: it swings from a hit and settles; it never moves otherwise.
    state.bagVel += (-38 * state.bagSwing - 3.5 * state.bagVel) * dt;
    state.bagSwing += state.bagVel * dt;
    state.bagFlash = Math.max(0, state.bagFlash - dt);

    return state;
}
