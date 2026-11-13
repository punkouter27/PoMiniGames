// pofighter/sim.js — the practice room's rules. Pure: no DOM, no clock, no randomness, so
// tests/pofighter-sim.test.mjs can drive it directly.
//
// Units are sprite-sheet pixels: the fighter data (data/pofighter/<id>.json, written by
// scripts/pofighter/pack.py) gives every picture an anchor on the ground line and `r`, how far
// its outline reaches in front of that anchor. An attack hits with `r`.

export const WORLD = {
    width: 1100, height: 620, ground: 560,
    minX: 140, startX: 300,
    bagX: 800, bagHalf: 48,
    // The fighter stops where the raised guard just touches the bag; only an attack reaches it.
    standOff: 150,
    jumpLift: 120,
};

export const ATTACKS = ['punchMid', 'punchHigh', 'kick'];
const BUSY = new Set(['jump', ...ATTACKS]);
// Where on the bag each attack lands, as a height above the ground (for the spark).
const HIT_HEIGHT = { punchMid: 265, punchHigh: 310, kick: 215 };

export const maxX = () => WORLD.bagX - WORLD.bagHalf - WORLD.standOff;

export function createState() {
    return {
        move: 'idle', t: 0, x: WORLD.startX, lift: 0,
        hits: 0, hitDone: false,
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

// What the controls ask for when the fighter is free to act. Jump beats an attack, an attack
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
    state.lift = 0;
}

/**
 * Advance the room by `dt` seconds.
 * input: { left, right, up, down, attack } where attack is null or one of ATTACKS, set only
 * on the step the control was pressed.
 */
export function step(state, input, dt, data) {
    const moves = data.moves;
    state.t += dt;

    // A jump or an attack always plays to its end; nothing cancels it.
    if (BUSY.has(state.move) && frameAt(moves[state.move], state.t).done) enter(state, 'idle');

    if (!BUSY.has(state.move)) {
        let want = wanted(input);
        if (!moves[want]) want = 'idle';   // a move the video did not have shows the stance
        if (want !== state.move) enter(state, want);
    }

    const def = moves[state.move];
    const { index } = frameAt(def, state.t);

    // A walk carries its own speed, measured from the footage so the feet do not slide.
    if (def.speed) state.x += def.speed * dt;
    state.x = Math.min(maxX(), Math.max(WORLD.minX, state.x));

    if (state.move === 'jump') {
        // The first pictures are the wind-up on the ground.
        const p = Math.min(1, (state.t * def.fps) / def.frames.length);
        const a = Math.min(1, Math.max(0, (p - 0.15) / 0.75));
        state.lift = WORLD.jumpLift * 4 * a * (1 - a);
    }

    // One attack, at most one hit, and only while the limb is extended and reaches the bag.
    if (def.hitMin !== undefined && !state.hitDone) {
        const reach = def.frames[index].r;
        if (reach >= def.hitMin && state.x + reach >= WORLD.bagX - WORLD.bagHalf) {
            state.hitDone = true;
            state.hits += 1;
            state.bagFlash = 0.18;
            state.bagVel += state.move === 'kick' ? 3.2 : 2;
            state.hitY = HIT_HEIGHT[state.move] ?? 260;
        }
    }

    // The bag is a damped pendulum: it swings from a hit and settles; it never moves otherwise.
    state.bagVel += (-38 * state.bagSwing - 3.5 * state.bagVel) * dt;
    state.bagSwing += state.bagVel * dt;
    state.bagFlash = Math.max(0, state.bagFlash - dt);

    return state;
}
