// framePacing.js — frame-time measurement for the graphics preview and the
// post-change stutter watchdog (deck idea #20, "perceptual quality preview and rollback").
//
// qualityTiers.js (PoQuality) owns the tier; this module only MEASURES what a tier
// costs on this device and judges it. Two users:
//
//   • The Settings preview: while a tier is previewed for ten seconds, sample every
//     frame, then summarise as p95 frame time + jank ratio and recommend a tier.
//   • The rollback watchdog: after the player keeps a heavier tier, watch for a
//     minute of visible time; if two consecutive windows stutter, put back the last
//     tier that ran smoothly and say so.
//
// The success metric from the deck is a stable 95th-percentile frame time, so p95 —
// not mean fps — is what every decision here reads. The pure functions are exported
// for node tests; the samplers need requestAnimationFrame.

export const TIERS = Object.freeze(['low', 'medium', 'high']);

/** p95 at or under this (≈ 50 fps) reads as smooth. */
export const SMOOTH_P95_MS = 20;
/** p95 over this (≈ 30 fps) reads as stutter. */
export const STUTTER_P95_MS = 34;
/** A frame this many times the median is a visible hitch. */
const JANK_FACTOR = 1.8;
/** More than this share of hitching frames is unstable even when p95 looks fine. */
const JANK_RATIO_MAX = 0.06;

/**
 * The q-quantile (0..1) of a sample array, nearest-rank. Pure; does not mutate.
 * @param {number[]} samples
 * @param {number} [q=0.95]
 */
export function percentile(samples, q = 0.95) {
    if (!samples || samples.length === 0) return 0;
    const sorted = Array.from(samples).sort((a, b) => a - b);
    const rank = Math.ceil(Math.min(1, Math.max(0, q)) * sorted.length);
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

/**
 * Summarise frame times (ms). Pure.
 * @param {number[]} frames
 * @returns {{samples:number, p50:number, p95:number, fps:number, jank:number, verdict:'smooth'|'ok'|'stutter'|'unknown'}}
 */
export function summarize(frames) {
    const n = frames ? frames.length : 0;
    if (n < 20) return { samples: n, p50: 0, p95: 0, fps: 0, jank: 0, verdict: 'unknown' };
    const p50 = percentile(frames, 0.5);
    const p95 = percentile(frames, 0.95);
    let total = 0, hitches = 0;
    for (const f of frames) {
        total += f;
        if (f > p50 * JANK_FACTOR && f > 20) hitches++;
    }
    const jank = hitches / n;
    const fps = total > 0 ? (n * 1000) / total : 0;
    let verdict = 'ok';
    if (p95 > STUTTER_P95_MS) verdict = 'stutter';
    else if (p95 <= SMOOTH_P95_MS && jank <= JANK_RATIO_MAX) verdict = 'smooth';
    return { samples: n, p50: round1(p50), p95: round1(p95), fps: round1(fps), jank: Math.round(jank * 1000) / 1000, verdict };
}

function round1(x) { return Math.round(x * 10) / 10; }

/**
 * What to recommend after previewing `tier` and measuring `summary`. Pure.
 * Smooth with headroom → try one higher; stutter → one lower; otherwise keep.
 * @param {'low'|'medium'|'high'} tier
 * @param {{verdict:string, p95:number}} summary
 * @returns {{tier:'low'|'medium'|'high', reason:string}}
 */
export function recommend(tier, summary) {
    const i = Math.max(0, TIERS.indexOf(tier));
    if (!summary || summary.verdict === 'unknown') return { tier: TIERS[i], reason: 'Not enough frames to judge.' };
    if (summary.verdict === 'stutter') {
        return i > 0
            ? { tier: TIERS[i - 1], reason: `${cap(tier)} stuttered (95% of frames under ${Math.round(summary.p95)} ms).` }
            : { tier: 'low', reason: 'Low is the lightest setting.' };
    }
    if (summary.verdict === 'smooth' && summary.p95 <= SMOOTH_P95_MS * 0.8 && i < TIERS.length - 1) {
        return { tier: TIERS[i + 1], reason: `${cap(tier)} ran with room to spare; ${TIERS[i + 1]} may too.` };
    }
    return { tier: TIERS[i], reason: `${cap(tier)} ran ${summary.verdict === 'smooth' ? 'smoothly' : 'well enough'}.` };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/**
 * The watchdog's decision over its recent windows (newest last). Pure.
 * Rolls back only on two consecutive stuttering windows, and never to a tier that is
 * not lighter than the current one.
 * @param {Array<{verdict:string}>} windows
 * @param {string} current
 * @param {string|null} lastStable
 */
export function shouldRollback(windows, current, lastStable) {
    if (!lastStable || TIERS.indexOf(lastStable) < 0) return false;
    if (TIERS.indexOf(lastStable) >= TIERS.indexOf(current)) return false;
    if (!windows || windows.length < 2) return false;
    const a = windows[windows.length - 1], b = windows[windows.length - 2];
    return a.verdict === 'stutter' && b.verdict === 'stutter';
}

// ── samplers (browser only) ────────────────────────────────────────────────

/**
 * Sample frame deltas until stopped. Skips the first `warmupMs` (the tier switch itself
 * hitches while shaders recompile) and anything while the tab is hidden.
 * @param {{warmupMs?:number, maxSamples?:number}} [opts]
 */
export function createSampler(opts = {}) {
    const warmupMs = opts.warmupMs ?? 1000;
    const maxSamples = opts.maxSamples ?? 1200;
    const frames = [];
    let raf = 0, last = 0, started = 0, running = false;
    function step(now) {
        if (!running) return;
        if (!started) started = now;
        if (last && !document.hidden && now - started >= warmupMs) {
            const dt = now - last;
            // A gap this long is a backgrounded tab or a breakpoint, not a frame.
            if (dt < 500) { frames.push(dt); if (frames.length > maxSamples) frames.shift(); }
        }
        last = now;
        raf = requestAnimationFrame(step);
    }
    return {
        start() { if (running) return; running = true; last = 0; started = 0; raf = requestAnimationFrame(step); },
        stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; return frames.slice(); },
        drain() { const out = frames.splice(0, frames.length); return out; },
        frames,
    };
}

const STORE_STABLE = 'pominigames:fx-last-stable';
const WATCH_MS = 60000;      // visible time watched after a change
const WINDOW_MS = 2500;

let _watch = null;

/** The last tier that ran without stutter (persisted), or null. */
export function lastStable() {
    try { const t = localStorage.getItem(STORE_STABLE); return TIERS.includes(t) ? t : null; } catch { return null; }
}

export function rememberStable(tier) {
    if (!TIERS.includes(tier)) return;
    try { localStorage.setItem(STORE_STABLE, tier); } catch { /* private mode */ }
}

/**
 * Watch the newly applied `tier` for stutter. `previous` is the tier it replaced; it
 * becomes the rollback target when it was lighter. `onRollback(from, to)` is called
 * after PoQuality has been put back. A smooth full watch promotes `tier` to stable.
 */
export function watchForStutter(tier, previous, onRollback) {
    stopWatch();
    if (!TIERS.includes(tier)) return;
    if (TIERS.includes(previous) && TIERS.indexOf(previous) < TIERS.indexOf(tier)) rememberStable(previous);
    const stable = lastStable();
    if (!stable || TIERS.indexOf(stable) >= TIERS.indexOf(tier)) { rememberStable(tier); return; }

    const sampler = createSampler({ warmupMs: 1500 });
    const windows = [];
    let watched = 0;
    sampler.start();
    const timer = setInterval(() => {
        if (document.hidden) return;
        watched += WINDOW_MS;
        const s = summarize(sampler.drain());
        if (s.verdict !== 'unknown') windows.push(s);
        if (shouldRollback(windows, tier, stable)) {
            stopWatch();
            try { window.PoQuality?.setOverride(stable); } catch { /* quality module gone */ }
            try {
                window.dispatchEvent(new CustomEvent('po-gfx-rollback', { detail: { from: tier, to: stable, p95: s.p95 } }));
            } catch { /* CustomEvent unavailable */ }
            try { onRollback?.(tier, stable); } catch { /* listener bug */ }
            return;
        }
        if (watched >= WATCH_MS) { stopWatch(); rememberStable(tier); }
    }, WINDOW_MS);
    _watch = { sampler, timer };
}

export function stopWatch() {
    if (!_watch) return;
    clearInterval(_watch.timer);
    _watch.sampler.stop();
    _watch = null;
}
