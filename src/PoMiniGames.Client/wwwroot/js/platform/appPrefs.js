// appPrefs.js — applies the user's display/feedback preferences to the document.
//
// The single interop surface behind SettingsService. Everything here is a
// write-through: SettingsService owns the persisted value, this module owns
// the DOM/audio-graph consequence of it.
//
// Theme deliberately lives on `<html data-theme>` rather than a media query —
// see the long comment above the light palette in css/app.css for why. The
// first stamp happens in the inline script in index.html (before first paint);
// this module takes over once Blazor has booted, and is what makes the
// Auto/Light/Dark switch take effect without a reload.

import * as AudioBus from './audioBus.js';
import * as Pacing from './framePacing.js';

const THEME_KEY = 'pominigames:theme';

let _mediaQuery = null;
let _mediaListener = null;
let _motionQuery = null;
let _motionListener = null;

/** Resolve "auto" against the OS; pass "light"/"dark" through unchanged. */
function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
        return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

/**
 * Stamp the effective theme on <html>.
 *
 * In "auto" we also subscribe to the OS preference so the page re-themes live
 * when the system flips (macOS/Windows sunset schedules do this mid-session).
 * The listener is torn down whenever the mode is no longer auto — leaving it
 * attached would let the OS silently override an explicit user choice.
 *
 * @param {'auto'|'light'|'dark'} mode
 */
export function applyTheme(mode) {
    try {
        document.documentElement.setAttribute('data-theme', resolve(mode));

        if (_mediaQuery && _mediaListener) {
            _mediaQuery.removeEventListener('change', _mediaListener);
            _mediaQuery = null;
            _mediaListener = null;
        }

        if (mode === 'auto') {
            _mediaQuery = matchMedia('(prefers-color-scheme: light)');
            _mediaListener = (e) => {
                document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
            };
            _mediaQuery.addEventListener('change', _mediaListener);
        }
    } catch { /* no matchMedia — the dark default stands */ }
}

/**
 * Toggle the manual reduced-motion opt-in.
 *
 * `data-motion` is the single source of truth the stylesheet reads — app.css no
 * longer carries a parallel `@media (prefers-reduced-motion)` universal rule, so
 * the OS preference has to be folded in HERE or an OS-reduced-motion user would
 * lose their guard the moment this runs. Effective value is therefore
 * `userChoice || osPreference`: turning the app toggle off does NOT re-enable
 * motion for someone whose system asked for less, which is the behaviour the two
 * separate rules used to produce.
 *
 * Mirrors applyTheme: the OS listener stays attached only while the user has not
 * overridden, so a live system change re-resolves but never beats an explicit
 * opt-in.
 *
 * @param {boolean} reduce
 */
export function applyReducedMotion(reduce) {
    try {
        stampMotion(reduce);

        if (_motionQuery && _motionListener) {
            _motionQuery.removeEventListener('change', _motionListener);
            _motionQuery = null;
            _motionListener = null;
        }

        // Only worth listening when the user has NOT opted in: once they have,
        // the attribute is already set and no OS change can alter the outcome.
        if (!reduce) {
            _motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
            _motionListener = () => stampMotion(false);
            _motionQuery.addEventListener('change', _motionListener);
        }
    } catch { /* best-effort */ }
}

/** Apply `userChoice || osPreference` to <html data-motion>. */
function stampMotion(reduce) {
    if (reduce || prefersReducedMotion()) {
        document.documentElement.setAttribute('data-motion', 'reduce');
    } else {
        document.documentElement.removeAttribute('data-motion');
    }
}

/**
 * Colour-blind-safe palettes. Like motion, the answer lives on <html> so game
 * engines can read it without an interop round-trip: PoEcosystem's charts and
 * PoCabinet's minimap switch to their Okabe–Ito sets when `data-colorsafe` is
 * present, on top of each game's own setting. The first stamp is the pre-paint
 * script in index.html.
 * @param {boolean} on
 */
export function applyColorSafe(on) {
    try {
        if (on) document.documentElement.setAttribute('data-colorsafe', '1');
        else document.documentElement.removeAttribute('data-colorsafe');
    } catch { /* best-effort */ }
}

/**
 * Haptics (controller rumble and phone vibration), on by default. SettingsService owns the
 * `pominigames:haptics` key; this hands the change to impactBus's live gate, which every rumble in
 * the app goes through, so switching it off also stops a motor that is already running.
 * @param {boolean} on
 */
export function applyHaptics(on) {
    try {
        window.PoImpact?.setHaptics?.(!!on);
    } catch { /* impactBus not loaded: it reads the key itself when it loads */ }
}

/**
 * Master volume, 0..1. Delegates to the shared bus, which owns the gain node
 * and the persisted key — duplicating that here is exactly the five-modules
 * problem audioBus.js was created to end.
 * @param {number} volume
 */
export function applyVolume(volume) {
    try {
        AudioBus.setVolume(volume);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/**
 * Effects volume, 0..1: UI clicks and every game's sound effects, under the master.
 * The bus persists it as `pominigames:sfx-volume` (integer percent, default 100).
 * @param {number} volume
 */
export function applySfxVolume(volume) {
    try {
        AudioBus.setBusVolume('sfx', volume);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/**
 * Music volume, 0..1: the adaptive layers PoRacer and PoBrawl build up as a race or round
 * heats up (musicLayers.js). Persisted as `pominigames:music-volume`, default 0 — music is
 * opt-in, so nothing plays until the player raises it.
 * @param {number} volume
 */
export function applyMusicVolume(volume) {
    try {
        AudioBus.setBusVolume('music', volume);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/** Current effects and music levels (0..1), for a settings sheet to seed its sliders. */
export function getBusVolumes() {
    try {
        return { sfx: AudioBus.getBusVolume('sfx'), music: AudioBus.getBusVolume('music') };
    } catch {
        return { sfx: 1, music: 0 };
    }
}

/**
 * Master mute. Goes through the bus so the change lands on the live gain node,
 * not just on the storage key: every already-running game engine is connected
 * to that node, so writing storage alone would leave the current session
 * audible until the next reload.
 * @param {boolean} muted
 */
export function applyMuted(muted) {
    try {
        AudioBus.setMuted(muted);
    } catch { /* Web Audio unavailable — nothing to set */ }
}

/**
 * Graphics quality for every game. 'auto' hands the choice back to the device
 * read in qualityTiers.js, which owns the tier and its storage key.
 * @param {'auto'|'low'|'medium'|'high'} tier
 */
export function applyGraphicsTier(tier) {
    const value = tier === 'auto' ? null : tier;
    if (window.PoQuality) {
        const before = window.PoQuality.tier();
        window.PoQuality.setOverride(value);
        // A heavier tier picked by hand gets the same stutter watch a kept preview does.
        Pacing.watchForStutter(window.PoQuality.tier(), before, notifyRollback);
        return;
    }
    // qualityTiers.js not loaded yet: leave the choice where it will find it.
    try {
        if (value) localStorage.setItem('pominigames:fx-tier', value);
        else localStorage.removeItem('pominigames:fx-tier');
    } catch { /* private mode: nothing to persist */ }
}

// ── Graphics preview + rollback (deck idea #20) ─────────────────────────────
// The preview applies a tier for ten seconds and MEASURES it (framePacing.js): p95
// frame time, jank share, a verdict and a recommended tier. Keeping a tier (or picking
// a heavier one by hand) starts a stutter watch that puts the last smooth tier back.
let _preview = null;        // { requested, tier, previous, sampler, endsAt, timer }
let _lastResult = null;     // the finished preview's measurement, kept for the sheet
let _rollbackRef = null;    // DotNetObjectReference to SettingsService

function finishPreviewMeasurement() {
    if (!_preview) return _lastResult;
    clearTimeout(_preview.timer);
    const summary = Pacing.summarize(_preview.sampler.stop());
    const rec = Pacing.recommend(_preview.tier, summary);
    _lastResult = { requested: _preview.requested, tier: _preview.tier, ...summary, recommend: rec.tier, reason: rec.reason };
    _preview = null;
    return _lastResult;
}

function notifyRollback(from, to) {
    try { _rollbackRef?.invokeMethodAsync('OnGraphicsRolledBack', from, to); } catch { /* circuit gone */ }
}

/** SettingsService registers itself so a rollback can update the sheet and toast. */
export function registerGraphicsRollback(dotnetRef) {
    _rollbackRef = dotnetRef || null;
}

/**
 * Preview a graphics tier temporarily, without changing the saved choice.
 * 'auto' previews what the device read would pick.
 */
export async function startGraphicsPreview(tier) {
    const q = window.PoQuality;
    if (!q) return false;
    if (_preview) { finishPreviewMeasurement(); q.cancelPreview(); }
    const applied = tier === 'auto' ? (q.deviceTier?.() || 'medium') : tier;
    const previous = q.tier();
    if (!q.startPreview(applied)) return false;
    const sampler = Pacing.createSampler({ warmupMs: 1000 });
    sampler.start();
    const durationMs = 10000;
    _preview = {
        requested: tier, tier: applied, previous, sampler, endsAt: performance.now() + durationMs,
        // qualityTiers restores the old tier on its own timer; stop measuring with it.
        timer: setTimeout(finishPreviewMeasurement, durationMs),
    };
    _lastResult = null;
    return true;
}

/** Keep the currently previewed tier as the saved player choice, and watch it. */
export async function commitGraphicsPreview() {
    const q = window.PoQuality;
    if (!q) return false;
    const pending = _preview;
    finishPreviewMeasurement();
    let ok;
    if (pending && pending.requested === 'auto') {
        q.cancelPreview();
        q.setOverride(null);
        ok = true;
    } else {
        ok = q.commitPreview();
    }
    if (ok && pending) Pacing.watchForStutter(q.tier(), pending.previous, notifyRollback);
    return ok;
}

/** Restore the tier that was active before a preview began. */
export async function cancelGraphicsPreview() {
    if (!window.PoQuality) return false;
    finishPreviewMeasurement();
    return window.PoQuality.cancelPreview();
}

/**
 * Whether a preview is active, plus its live (or last finished) measurement:
 * { active, tier, remainingMs, result: { p95, fps, jank, verdict, recommend, reason } | null }.
 */
export async function graphicsPreviewStatus() {
    if (!window.PoQuality) return { active: false, tier: null, remainingMs: 0, result: null };
    const s = window.PoQuality.previewStatus();
    let result = _lastResult;
    if (_preview) {
        const live = Pacing.summarize(_preview.sampler.frames);
        const rec = Pacing.recommend(_preview.tier, live);
        result = { requested: _preview.requested, tier: _preview.tier, ...live, recommend: rec.tier, reason: rec.reason };
    }
    return { active: s.active, tier: s.tier, remainingMs: Math.round(s.remainingMs), result };
}

/**
 * Read the OS reduced-motion preference, so the settings UI can tell the user
 * their system is already asking for less motion regardless of this toggle.
 * @returns {boolean}
 */
export function prefersReducedMotion() {
    try {
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/**
 * Opt-in Rich Audio Layer (Tone.js / FM polyphonic synths + hall reverb).
 * @param {boolean} on
 */
export function applyRichAudio(on) {
    try {
        window.PoRichAudio?.setRichAudio?.(!!on);
        const ctx = AudioBus.hasContext() ? AudioBus.contextSync() : null;
        if (ctx && window.PoRichAudio) {
            AudioBus.setSpaceBuffer(on ? window.PoRichAudio.buildHallImpulse(ctx) : null);
            if (on) AudioBus.setReverb(0.14);
        }
    } catch { /* best-effort */ }
}

/**
 * Opt-in Web Speech API voice announcer.
 * @param {boolean} on
 */
export function applyVoiceAnnouncer(on) {
    try {
        window.PoSpeech?.setEnabled?.(!!on);
    } catch { /* best-effort */ }
}
