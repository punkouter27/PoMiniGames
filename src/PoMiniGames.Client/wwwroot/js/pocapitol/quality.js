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

/**
 * A tier for hosts that do not already supply one, from what the browser actually reports.
 * Core count alone is a bad guess (many throttled laptops report eight), so the texture limit
 * and an explicit WebGL 2 check gate the top rung.
 */
export function detectTier({ webgl2 = true, maxTexture = 4096, memory = 4, cores = 4 } = {}) {
    if (!webgl2 || maxTexture < 4096 || cores < 4) return 'low';
    return maxTexture >= 8192 && memory >= 8 && cores >= 8 ? 'high' : 'medium';
}

/** The stored graphics mode, kept only if it is one this build knows. */
export function preferredMode(stored, fallback = 'auto') {
    return MODES.includes(stored) ? stored : fallback;
}

export function createGovernor({ tier = 'high', mode = 'auto' } = {}) {
    let ceiling = CEILING[tier] ?? 0, current = mode, rung = 0, best = 0;
    let time = 0, frames = 0, fastWindows = 0, hitches = 0, suspended = false, average = 0;
    const failures = RUNGS.map(() => 0);
    const settle = () => {
        best = current === 'auto' ? ceiling : 0;
        rung = current === 'low' ? 3 : best;
        time = 0; frames = 0; fastWindows = 0; average = 0;
        failures.fill(0);
    };
    if (!MODES.includes(current)) current = 'auto';
    settle();
    return {
        /** Feed one frame's duration in seconds. Returns the new settings when they change, else null. */
        sample(seconds) {
            // A hidden or backgrounded tab is throttled to a few frames a second; those frames say
            // nothing about the scene's cost, so they are dropped rather than counted as slow.
            if (suspended || current !== 'auto' || !Number.isFinite(seconds) || seconds <= 0) return null;
            // One long frame is a hitch (tab switch, shader compile, GC) and says nothing about
            // steady cost. Several in a row are the steady cost, and the worst case to ignore.
            if (seconds > 0.25) {
                if (++hitches < 3) return null;
                seconds = 0.25;
            } else hitches = 0;
            time += seconds; frames++;
            if (time < WINDOW) return null;
            const measured = time / frames * 1000;
            average = measured;
            time = 0; frames = 0;
            if (measured > SLOW_MS && rung < RUNGS.length - 1) {
                // One slow spell may be a busy moment; a second marks the rung as too heavy.
                if (++failures[rung] >= 2) best = Math.max(best, rung + 1);
                rung++; fastWindows = 0;
                return RUNGS[rung];
            }
            fastWindows = measured < FAST_MS ? fastWindows + 1 : 0;
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
        /** Stops sampling while the page is hidden, so a throttled tab cannot force a downgrade. */
        suspend(hidden) { suspended = hidden === true; if (suspended) { time = 0; frames = 0; hitches = 0; } },
        settings: () => RUNGS[rung],
        mode: () => current,
        label: () => `${current === 'auto' ? 'Auto' : current === 'low' ? 'Low' : 'High'} · ${Math.round(RUNGS[rung].scale * 100)}%`,
        /** Why the governor is where it is, for the diagnostics panel. */
        why: () => current !== 'auto'
            ? `${current} mode is fixed`
            : rung === best ? `steady at ${Math.round(average)} ms` : `eased down from ${Math.round(average)} ms frames`,
    };
}
