// qualityTiers.js — the app's single quality authority.
//
// Every GFX module asks "how heavy may I be?" — postFx reads the `data-gfx`
// attribute this module writes on <html>, gpuFx/weather/glass read the exports
// below. This module is the only owner of the tier.
//
// Selection order: URL `?fx=high|medium|low` > localStorage `pominigames:fx-tier` >
// computed from the device. `prefers-reduced-motion` caps the tier at medium
// AND enables the flashing guard; a battery-saving state drops one tier for
// the session. A frame-time watchdog demotes high → medium after 12 s of
// sustained ~<25 fps (one-way, per session — flapping looks worse than lag).
//
// Exposed as window.PoQuality and as ES module exports.
(function () {
    'use strict';

    const STORE_TIER = 'pominigames:fx-tier';
    const STORE_FLASH = 'pominigames:fx-reduce-flashing';
    const WATCHDOG_MS = 12000;
    const WATCHDOG_FPS = 25;

    let _tier = null;            // 'high' | 'medium' | 'low'
    let _reduceFlashing = false;
    let _source = 'computed';    // computed | storage | query
    let _watchdog = null;
    const _listeners = [];
    let _preview = null;
    let _previewTimer = 0;

    function clampTier(t) {
        return t === 'high' || t === 'medium' || t === 'low' ? t : null;
    }

    function fromQuery() {
        try {
            const m = new URLSearchParams(location.search).get('fx');
            return clampTier(m && m.toLowerCase());
        } catch { return null; }
    }

    function fromStorage() {
        try { return clampTier(localStorage.getItem(STORE_TIER)); }
        catch { return null; }
    }

    function isSoftwareRenderer() {
        try {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return false;
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
            return /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|mesa offscreen/i.test(name);
        } catch { return false; }
    }

    function computeTier() {
        // Conservative device read: memory and core count are the two signals
        // that correlate with sustained GPU/CPU headroom for this app's loads.
        if (isSoftwareRenderer()) return 'low';
        const mem = navigator.deviceMemory || 8;   // Chrome-only; assume healthy
        const cores = navigator.hardwareConcurrency || 4;
        if (mem <= 2 || cores <= 2) return 'low';
        if (mem <= 4 || cores <= 4) return 'medium';
        return 'high';
    }

    function apply(tier) {
        _tier = tier;
        // postFx.tier() reads exactly this attribute — the single handoff point.
        document.documentElement.setAttribute('data-gfx', tier);
        document.documentElement.toggleAttribute('data-reduce-flashing', _reduceFlashing);
        for (const cb of _listeners) { try { cb(_tier); } catch { /* listener bug must not break the rest */ } }
        // The adaptive frame-rate loop works under this tier, never over it.
        try { window.PoVisualRuntime?.syncWithQuality?.(); } catch { /* not loaded yet: it syncs itself on load */ }
    }

    function cancelPreview() {
        if (!_preview) return false;
        const previousTier = _preview.previousTier;
        const previousSource = _preview.previousSource;
        window.clearTimeout(_previewTimer);
        _previewTimer = 0;
        _preview = null;
        _source = previousSource;
        apply(previousTier);
        return true;
    }

    function resolve() {
        let tier = fromQuery();
        if (tier) { _source = 'query'; }
        else {
            tier = fromStorage();
            if (tier) _source = 'storage';
            else { tier = computeTier(); _source = 'computed'; }
        }

        const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        _reduceFlashing = motionQuery?.matches === true
            || (function () { try { return localStorage.getItem(STORE_FLASH) === '1'; } catch { return false; } })();

        // Battery saving drops one tier for the session (never below low).
        if (navigator.getBattery) {
            navigator.getBattery().then(function (b) {
                if ((b.saving === true || b.level < 0.2) && !b.charging) {
                    if (tier === 'high') tier = 'medium';
                    else if (tier === 'medium') tier = 'low';
                    apply(tier);
                }
            }).catch(function () { /* battery API is best-effort */ });
        }

        // Reduced motion never gets the heavy pipeline: the flash/vibration
        // effects it exists to damp all live there.
        if (_reduceFlashing && tier === 'high') tier = 'medium';

        apply(tier);
        startWatchdog();
    }

    // One-way demotion on sustained low fps. Deliberately NOT one-way upward:
    // recovering mid-session causes visible quality pops; the next page load
    // recomputes cleanly.
    function startWatchdog() {
        if (_watchdog || _tier !== 'high' || _source === 'query') return;
        let frames = 0;
        const startedAt = performance.now();
        function loop(now) {
            frames++;
            if (now - startedAt >= WATCHDOG_MS) {
                const fps = frames / ((now - startedAt) / 1000);
                // Re-check the tier: it may have changed during the window (a choice in
                // Settings, the battery cap), and "demote to medium" must never raise a low.
                if (fps < WATCHDOG_FPS && _tier === 'high' && _source === 'computed') { _tier = 'medium'; apply(_tier); }
                return; // watchdog done either way
            }
            _watchdog = requestAnimationFrame(loop);
        }
        _watchdog = requestAnimationFrame(loop);
    }

    resolve();

    window.PoQuality = {
        tier: function () { return _tier; },
        allowHeavy: function () { return _tier === 'high'; },
        reduceFlashing: function () { return _reduceFlashing; },
        source: function () { return _source; },
        // What Auto would pick on this device, without applying it — the Settings
        // preview offers Auto alongside the fixed tiers and measures this one.
        deviceTier: function () { return computeTier(); },
        previewStatus: function () {
            return _preview
                ? { active: true, tier: _preview.tier, remainingMs: Math.max(0, _preview.endsAt - performance.now()) }
                : { active: false, tier: null, remainingMs: 0 };
        },
        startPreview: function (t, durationMs = 10000) {
            const tier = clampTier(t);
            if (!tier) return false;
            if (_preview) cancelPreview();

            const previousTier = _tier;
            const previousSource = _source;
            const duration = Math.max(3000, Math.min(15000, Number(durationMs) || 10000));
            _preview = { tier, previousTier, previousSource, endsAt: performance.now() + duration };
            _source = 'preview';
            apply(tier);
            _previewTimer = window.setTimeout(cancelPreview, duration);
            return true;
        },
        commitPreview: function () {
            if (!_preview) return false;
            const tier = _preview.tier;
            window.clearTimeout(_previewTimer);
            _previewTimer = 0;
            _preview = null;
            try { localStorage.setItem(STORE_TIER, tier); } catch { /* private mode: session-only */ }
            _source = 'storage';
            apply(tier);
            return true;
        },
        cancelPreview: cancelPreview,
        setSessionTier: function (t) {
            const tier = clampTier(t);
            if (!tier) return false;
            _source = 'session';
            apply(tier);
            return true;
        },
        setOverride: function (t) {
            try {
                if (t) localStorage.setItem(STORE_TIER, clampTier(t) || '');
                else localStorage.removeItem(STORE_TIER);
            } catch { /* private mode: session-only */ }
            if (clampTier(t)) { _source = 'storage'; apply(clampTier(t)); }
            else resolve();
        },
        setReduceFlashing: function (on) {
            _reduceFlashing = !!on;
            try { localStorage.setItem(STORE_FLASH, on ? '1' : '0'); } catch { }
            apply(_tier);
        },
        onChange: function (cb) { _listeners.push(cb); }
    };

    // ES-module consumers (three.js games import via importmap-relative paths).
    window.PoQuality.__esModule = true;
})();
