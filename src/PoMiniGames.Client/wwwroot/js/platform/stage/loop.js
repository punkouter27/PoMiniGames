// loop.js — the one requestAnimationFrame loop every game stage runs on.
//
// Every engine used to hand-roll the same thing: read the rAF timestamp, clamp dt so a
// background tab does not come back with a ten-second step, optionally run a fixed physics
// step through an accumulator, skip work while paused, and reset the clock on resume so the
// first frame back is not one giant step. This is that, once.
//
// Pure apart from the injected clock: tests drive `tick(ts)` by hand.

/**
 * @param {object} o
 * @param {(dt:number)=>void}               [o.step]       simulation step (fixed or variable dt, seconds)
 * @param {(dt:number, alpha:number)=>void} [o.frame]      render; alpha = leftover fixed-step fraction (1 when variable)
 * @param {number}  [o.maxDt=0.1]           clamp on a frame's real dt, seconds
 * @param {number}  [o.fixedStep=0]         > 0 runs `step` at this fixed dt through an accumulator
 * @param {number}  [o.maxSteps=5]          cap on fixed steps per frame (spiral-of-death guard)
 * @param {()=>number} [o.timeScale]        multiplier on dt (hitstop / slow motion)
 * @param {boolean} [o.renderWhilePaused=false] keep calling `frame(0, alpha)` while paused
 * @param {(cb:FrameRequestCallback)=>number} [o.raf]
 * @param {(id:number)=>void}               [o.caf]
 */
export function createLoop(o = {}) {
    const raf = o.raf ?? ((cb) => requestAnimationFrame(cb));
    const caf = o.caf ?? ((id) => cancelAnimationFrame(id));
    const maxDt = o.maxDt ?? 0.1;
    const fixedStep = o.fixedStep ?? 0;
    const maxSteps = o.maxSteps ?? 5;
    const timeScale = o.timeScale ?? (() => 1);

    let id = 0;
    let running = false;
    let paused = false;
    let prev = null;
    let acc = 0;
    let alpha = 1;
    let frames = 0;
    let lastTs = 0;

    function tick(ts) {
        if (!running) return;   // a frame source that cannot cancel (PiP window) must not tick a stopped loop
        id = raf(tick);
        lastTs = ts;
        if (prev === null || ts < prev) prev = ts;   // first frame, or a clock that stepped back
        const real = Math.min(maxDt, (ts - prev) / 1000);
        prev = ts;
        frames++;

        if (paused) {
            if (o.renderWhilePaused) o.frame?.(0, alpha);
            return;
        }

        const scale = Math.max(0, Number(timeScale()) || 0);
        const dt = real * (Number.isFinite(scale) ? scale : 1);

        if (fixedStep > 0) {
            acc += dt;
            let n = 0;
            while (acc >= fixedStep && n < maxSteps) {
                o.step?.(fixedStep);
                acc -= fixedStep;
                n++;
            }
            if (n === maxSteps && acc >= fixedStep) acc %= fixedStep;   // drop the backlog, keep the phase
            alpha = acc / fixedStep;
        } else {
            if (dt > 0) o.step?.(dt);
            alpha = 1;
        }
        o.frame?.(dt, alpha);
    }

    return {
        tick,
        start() {
            if (running) return;
            running = true;
            prev = null;
            id = raf(tick);
        },
        stop() {
            running = false;
            if (id) caf(id);
            id = 0;
        },
        setPaused(on) {
            on = !!on;
            if (on === paused) return;
            paused = on;
            if (!on) { prev = null; acc = 0; }   // the first frame back is not one giant step
        },
        get paused() { return paused; },
        get running() { return running; },
        get alpha() { return alpha; },
        get frames() { return frames; },
        /** The rAF timestamp (ms) of the frame being processed. */
        get now() { return lastTs; },
    };
}
