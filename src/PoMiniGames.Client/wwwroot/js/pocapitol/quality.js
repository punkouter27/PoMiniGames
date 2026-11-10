// Adaptive graphics for PoCapitol.
//
// The app's quality tier (qualityTiers.js, window.PoQuality) is a guess made from the device
// before anything is drawn. This governor works under that ceiling from what the scene
// actually costs: it watches frame time and walks a ladder of settings down when frames run
// long, and back up when there is clear headroom. A rung that proved too heavy twice is not
// tried again, because quality that flaps looks worse than quality that is slightly low.
//
// Pure logic with no DOM or three.js, so it can be tested with made-up frame times.

/**
 * Best first. `scale` multiplies render resolution; `distant` is the share of the far crowd
 * drawn; `post` is post.js's level (3 AO, bloom and depth of field; 2 bloom; 1 MSAA; 0 grade
 * only); `detail` is the strength of the world-space surface detail on buildings and ground.
 */
export const RUNGS = [
    { scale: 1, shadows: 2048, distant: 1, extras: true, post: 3, detail: 1 },
    { scale: 0.85, shadows: 1024, distant: 0.7, extras: true, post: 2, detail: 1 },
    { scale: 0.7, shadows: 1024, distant: 0.45, extras: true, post: 1, detail: 1 },
    { scale: 0.6, shadows: 0, distant: 0.25, extras: false, post: 0, detail: 0.6 },
    { scale: 0.5, shadows: 0, distant: 0.1, extras: false, post: 0, detail: 0 },
];
export const MODES = ['auto', 'low', 'high'];
const CEILING = { high: 0, medium: 1, low: 3 };
const WINDOW = 1.5, SLOW_MS = 24, FAST_MS = 13, FAST_WINDOWS = 3;

export function createGovernor({ tier = 'high', mode = 'auto' } = {}) {
    let ceiling = CEILING[tier] ?? 0, current = mode, rung = 0, best = 0;
    let time = 0, frames = 0, fastWindows = 0, hitches = 0, failures = RUNGS.map(() => 0);
    const settle = () => {
        best = current === 'auto' ? ceiling : 0;
        rung = current === 'low' ? 3 : best;
        time = 0; frames = 0; fastWindows = 0; failures = RUNGS.map(() => 0);
    };
    if (!MODES.includes(current)) current = 'auto';
    settle();
    return {
        /** Feed one frame's duration in seconds. Returns the new settings when they change, else null. */
        sample(seconds) {
            if (current !== 'auto' || !Number.isFinite(seconds) || seconds <= 0) return null;
            // One long frame is a hitch (tab switch, shader compile, GC) and says nothing about
            // steady cost. Several in a row are the steady cost, and the worst case to ignore.
            if (seconds > 0.25) {
                if (++hitches < 3) return null;
                seconds = 0.25;
            } else hitches = 0;
            time += seconds; frames++;
            if (time < WINDOW) return null;
            const average = time / frames * 1000;
            time = 0; frames = 0;
            if (average > SLOW_MS && rung < RUNGS.length - 1) {
                // One slow spell may be a busy moment; a second marks the rung as too heavy.
                if (++failures[rung] >= 2) best = Math.max(best, rung + 1);
                rung++; fastWindows = 0;
                return RUNGS[rung];
            }
            fastWindows = average < FAST_MS ? fastWindows + 1 : 0;
            if (fastWindows >= FAST_WINDOWS && rung > best) {
                rung--; fastWindows = 0;
                return RUNGS[rung];
            }
            return null;
        },
        setMode(next) {
            if (!MODES.includes(next)) throw new RangeError('Unknown graphics mode.');
            current = next; settle();
            return RUNGS[rung];
        },
        setTier(next) {
            ceiling = CEILING[next] ?? ceiling;
            if (current === 'auto') { best = Math.max(best, ceiling); rung = Math.max(rung, best); }
            return RUNGS[rung];
        },
        settings: () => RUNGS[rung],
        mode: () => current,
        label: () => `${current === 'auto' ? 'Auto' : current === 'low' ? 'Low' : 'High'} · ${Math.round(RUNGS[rung].scale * 100)}%`,
    };
}
