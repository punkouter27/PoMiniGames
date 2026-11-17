// feelPresets.js — named screen-shake and hit-stop presets for engines that shake
// their own camera.
//
// impactBus.js already owns the DOM side of game feel (trauma-squared shake of the
// registered stage, the global hitstop time scale, flash, haptics) and its PRESETS are
// the tick/light/medium/heavy/win/lose scale every game shares. What it cannot do is
// move a three.js camera, so the 3D engines kept their own numbers inline: PoBrawl set
// `shakeT = 0.14; shakeAmp = 0.09` straight from its hit code. This is where those
// numbers live now, named by what happened, so a second 3D engine reads the same
// scale instead of inventing another.
//
// GATES
//   • Shake is presentation: off under reduced motion (the OS setting or the app's
//     Profile toggle, data-motion on <html>) and scaled down by the quality tier
//     (data-gfx), with the same factors impactBus uses for the DOM shake.
//   • Hit-stop FRAMES are returned raw. In PoBrawl the freeze is part of the fixed-step
//     simulation that replays and rollback netplay re-run; a local preference must not
//     change what the simulation does, or two peers disagree. A DOM/JS game with no such
//     sim calls hitstop(name), which goes through impactBus and is gated there.

/** Camera shake, in seconds of decay (`t`) and world units at full strength (`amp`). */
export const SHAKE = Object.freeze({
    whiff: Object.freeze({ t: 0.08, amp: 0.05 }),
    jab:   Object.freeze({ t: 0.14, amp: 0.06 }),
    kick:  Object.freeze({ t: 0.14, amp: 0.09 }),
    clash: Object.freeze({ t: 0.16, amp: 0.10 }),
    ko:    Object.freeze({ t: 0.18, amp: 0.14 }),
});

/** Hit-stop, in 60 Hz sim frames. Engines cap charged values themselves. */
export const HITSTOP_FRAMES = Object.freeze({ jab: 3, kick: 5, clash: 6, ko: 8 });

/** The same freeze in ms, for loops without a fixed step (impactBus.hitstop). */
const HITSTOP_MS = Object.freeze({ jab: 50, kick: 83, clash: 100, ko: 133 });

export function motionReduced() {
    try {
        const root = document.documentElement;
        if (root.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** Shake amplitude scale for the quality tier — impactBus's tierScale(), kept in step. */
export function tierScale() {
    try {
        switch (document.documentElement.getAttribute('data-gfx')) {
            case 'low': return 0.35;
            case 'medium': return 0.7;
            default: return 1;
        }
    } catch {
        return 1;
    }
}

/**
 * Arm a camera shake on `target` (any object with shakeT/shakeAmp fields, which the
 * engine's camera code decays). Under reduced motion it clears instead.
 * @param {{shakeT:number, shakeAmp:number}} target
 * @param {keyof SHAKE} name
 * @param {number} [scale=1] attack weight, charge, …
 */
export function shake(target, name, scale = 1) {
    if (!target) return;
    const p = SHAKE[name] || SHAKE.jab;
    if (motionReduced()) { target.shakeT = 0; target.shakeAmp = 0; return; }
    target.shakeT = p.t;
    target.shakeAmp = p.amp * Math.max(0, scale) * tierScale();
}

/** Sim frames of hit-stop for a preset. Deliberately ungated — see GATES above. */
export function hitstopFrames(name) {
    return HITSTOP_FRAMES[name] ?? HITSTOP_FRAMES.jab;
}

/** Wall-clock hit-stop for engines without a fixed-step sim, via impactBus (gated there). */
export function hitstop(name, scale = 1) {
    const ms = (HITSTOP_MS[name] ?? HITSTOP_MS.jab) * Math.max(0, Math.min(1.5, scale));
    window.PoImpact?.hitstop?.(ms);
}

if (typeof window !== 'undefined') {
    window.PoFeel = { SHAKE, HITSTOP_FRAMES, shake, hitstopFrames, hitstop, motionReduced, tierScale };
}
