// visualRuntime.js — one rAF loop that owns two jobs:
//
//   REACTIVE VISUALS (the --audio-* bands)
//      Publishes four normalised bands as CSS custom properties on <html>:
//          --audio-bass  --audio-mid  --audio-treble  --audio-peak   (0..1)
//      Any stylesheet can then react without touching JS, e.g.
//          box-shadow: 0 0 calc(var(--audio-bass) * 40px) var(--accent);
//      They used to be the analyser's read of the soundtrack. With background music
//      off app-wide that read was flat except for a twitch on each click, so the
//      bands are now driven by what the player DOES: every cue (gameCues.js calls
//      kick() with the cue's weight) is a hit on the low band, and pointer speed
//      feeds the high band. The names stay, so no stylesheet had to change.
//
//   ADAPTIVE QUALITY
//      Measures real frame cadence and degrades effects before the player feels
//      a stutter. Publishes a tier on <html data-gfx="high|medium|low"> plus
//          --gfx-blur       px value for backdrop-filter
//          --gfx-particles  0..1 multiplier for particle systems
//
// WHY ONE LOOP: two independent requestAnimationFrame loops would double the
// per-frame wakeups on the main thread, which in Blazor WASM is the same thread
// the .NET runtime uses. One loop, both jobs, ~40µs of work per frame.
//
// The loop parks itself entirely when the tab is hidden and when neither job has
// a consumer — an idle page should cost nothing.

const TIERS = {
    high:   { blur: 14, particles: 1.00, shadows: 1 },
    medium: { blur: 7,  particles: 0.55, shadows: 1 },
    low:    { blur: 0,  particles: 0.20, shadows: 0 },
};

// Hysteresis bounds. Deliberately asymmetric: drop fast (the player is already
// suffering), recover slowly (so we don't oscillate on a borderline machine).
//
// The home route sits at ~31 FPS on the dev box at the high tier, so a 50 FPS
// drop floor would never engage and the player would watch a static menu render
// 60 identical frames per second at full cost. Floors of 44 drop / 56 raise
// catch that case within the first measurement window while staying clear of
// normal fluctuation.
const DROP_BELOW_FPS = 44;
const RAISE_ABOVE_FPS = 56;
const DROP_AFTER_MS = 600;
const RAISE_AFTER_MS = 6000;

// Grace period before the tier may drop. Blazor WASM boot — runtime download,
// IL load, first render — starves the frame loop for a second or two on any
// machine. Without this, the very first measurement window sees <50 fps and
// permanently downgrades a perfectly capable GPU because the *app* was booting,
// not because the *graphics* were too heavy. Recovery would then take 12s.
//
// Kept short (2.5s, not 4s): 4s of dead frames at boot would leave a borderline
// machine running the shader at high tier for the entire welcome animation
// before any recovery could begin. 2.5s is still longer than the Blazor WASM
// cold-start on any device we target.
const WARMUP_MS = 2500;

let _running = false;
let _rafId = 0;
let _audioReactive = false;
let _adaptive = true;

let _tier = 'high';
let _frames = 0;
let _windowStart = 0;
let _fps = 60;
let _belowSince = 0;
let _aboveSince = 0;
let _warmedAt = 0;   // set on the first measurement window; see WARMUP_MS

// Reused so the loop allocates nothing per frame.
const _root = typeof document !== 'undefined' ? document.documentElement : null;

// ── Reactive bands ─────────────────────────────────────────────────────
// Two envelopes, both 0..1 and both decaying every frame:
//   _hit    — cue events. kick() adds; it falls back with a ~140 ms half-life,
//             so a tap reads as a blink and a flurry of hits as a held glow.
//   _motion — pointer speed, smoothed. Capped low in the bass band so sweeping the
//             mouse across the catalog breathes the chrome, never pumps it.
const HIT_HALF_LIFE_MS = 140;
const MOTION_HALF_LIFE_MS = 260;
const POINTER_FULL_PX_PER_MS = 2.6;   // a brisk flick across a laptop screen
let _hit = 0;
let _motion = 0;
let _lastStep = 0;
let _px = 0, _py = 0, _pt = 0;
let _pointerBound = false;
// Last value written per band, in hundredths: write only on change, so an idle page
// costs no style recalculation at all.
const _written = [-1, -1, -1, -1];
const BAND_VARS = ['--audio-bass', '--audio-mid', '--audio-treble', '--audio-peak'];
// Reused by getLevels() — the particle field polls it.
const _levels = { bass: 0, mid: 0, treble: 0, peak: 0 };

function onPointerMove(e) {
    const t = e.timeStamp || performance.now();
    const dt = t - _pt;
    if (_pt && dt > 0 && dt < 120) {
        const speed = Math.hypot(e.clientX - _px, e.clientY - _py) / dt;
        const v = Math.min(1, speed / POINTER_FULL_PX_PER_MS);
        if (v > _motion) _motion += (v - _motion) * 0.35;
    }
    _px = e.clientX; _py = e.clientY; _pt = t;
}

function bindPointer(on) {
    if (typeof window === 'undefined' || on === _pointerBound) return;
    _pointerBound = on;
    if (on) window.addEventListener('pointermove', onPointerMove, { passive: true });
    else window.removeEventListener('pointermove', onPointerMove);
}

function writeBand(i, v) {
    const q = Math.round(v * 100);
    if (q === _written[i]) return;
    _written[i] = q;
    _root.style.setProperty(BAND_VARS[i], String(q / 100));
}

function stepBands(now) {
    const dt = _lastStep ? Math.min(100, now - _lastStep) : 16;
    _lastStep = now;
    _hit *= Math.pow(0.5, dt / HIT_HALF_LIFE_MS);
    _motion *= Math.pow(0.5, dt / MOTION_HALF_LIFE_MS);
    if (_hit < 0.004) _hit = 0;
    if (_motion < 0.004) _motion = 0;
    // The low tier is the machine that cannot spare the repaint; fx.css already hides
    // the readers there, so publish rest values rather than recalculating styles.
    const live = _tier !== 'low';
    _levels.bass = live ? Math.min(1, _hit + _motion * 0.3) : 0;
    _levels.mid = live ? Math.min(1, _hit * 0.6 + _motion * 0.6) : 0;
    _levels.treble = live ? _motion : 0;
    _levels.peak = live ? Math.max(_hit, _motion) : 0;
    writeBand(0, _levels.bass);
    writeBand(1, _levels.mid);
    writeBand(2, _levels.treble);
    writeBand(3, _levels.peak);
}

/**
 * A cue fired: light the bands. `weight` 0..1 (gameCues.js maps a cue's impact kind
 * onto it). Cheap and safe to call at any rate — it only raises a number.
 * @param {number} [weight=0.5]
 */
export function kick(weight) {
    const w = weight == null ? 0.5 : Math.max(0, Math.min(1, weight));
    _hit = Math.min(1, _hit + w * (1 - _hit * 0.5));
}

/** The current bands (one reused object — read it, do not keep it). */
export function getLevels() { return _levels; }

// qualityTiers.js (PoQuality) owns the ceiling: the device read, the battery cap and the
// player's own choice in Settings. This loop only moves BELOW that ceiling, and stands
// down entirely when the player picked a tier by hand.
const ORDER = ['low', 'medium', 'high'];
function ceiling() {
    const q = typeof window !== 'undefined' ? window.PoQuality : null;
    return (q && q.tier && q.tier()) || 'high';
}
function capped(name) {
    return ORDER.indexOf(name) > ORDER.indexOf(ceiling()) ? ceiling() : name;
}

/** Called by qualityTiers.js whenever it (re)decides the tier. */
export function syncWithQuality() {
    const q = typeof window !== 'undefined' ? window.PoQuality : null;
    if (!q) return;
    const manual = q.source() !== 'computed';
    const target = manual ? q.tier() : capped(_tier || 'medium');
    _adaptive = !manual;
    // PoQuality has just written data-gfx itself, so re-apply even when the name is unchanged.
    _tier = null;
    applyTier(target);
    if (_adaptive) ensureRunning();
}

function applyTier(name) {
    if (!_root || name === _tier) return;
    _tier = name;
    const t = TIERS[name];
    _root.setAttribute('data-gfx', name);
    _root.style.setProperty('--gfx-blur', t.blur + 'px');
    _root.style.setProperty('--gfx-particles', String(t.particles));
    _root.style.setProperty('--gfx-shadows', String(t.shadows));
    try {
        window.dispatchEvent(new CustomEvent('po-gfx-tier', { detail: { tier: name, fps: Math.round(_fps) } }));
    } catch { /* CustomEvent unavailable */ }
}

function step(now) {
    if (!_running) return;

    // ── frame cadence ──────────────────────────────────────────────────
    if (_adaptive) {
        _frames++;
        if (!_windowStart) _windowStart = now;
        const elapsed = now - _windowStart;
        if (elapsed >= 500) {
            _fps = (_frames * 1000) / elapsed;
            _frames = 0;
            _windowStart = now;

            // Ignore everything until the app has settled — see WARMUP_MS.
            if (!_warmedAt) _warmedAt = now + WARMUP_MS;
            if (now < _warmedAt) {
                _belowSince = 0;
                _aboveSince = 0;
            } else if (_fps < DROP_BELOW_FPS) {
                _aboveSince = 0;
                if (!_belowSince) _belowSince = now;
                else if (now - _belowSince > DROP_AFTER_MS) {
                    if (_tier === 'high') applyTier('medium');
                    else if (_tier === 'medium') applyTier('low');
                    _belowSince = now;
                }
            } else if (_fps > RAISE_ABOVE_FPS) {
                _belowSince = 0;
                if (!_aboveSince) _aboveSince = now;
                else if (now - _aboveSince > RAISE_AFTER_MS) {
                    if (_tier === 'low') applyTier(capped('medium'));
                    else if (_tier === 'medium') applyTier(capped('high'));
                    _aboveSince = now;
                }
            } else {
                _belowSince = 0;
                _aboveSince = 0;
            }
        }
    }

    // ── cue + pointer envelopes → CSS variables ─────────────────────
    if (_audioReactive && _root) stepBands(now);

    _rafId = requestAnimationFrame(step);
}

function ensureRunning() {
    if (_running || typeof requestAnimationFrame !== 'function') return;
    if (!_audioReactive && !_adaptive) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    _running = true;
    _windowStart = 0;
    _frames = 0;
    _rafId = requestAnimationFrame(step);
}

function stopLoop() {
    _running = false;
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = 0;
}

/** Turn on the cue/pointer → CSS-variable pump. Pages that read the bands ask for it. */
export function enableAudioReactive(on) {
    _audioReactive = on !== false;
    bindPointer(_audioReactive);
    if (!_audioReactive && _root) {
        _hit = 0; _motion = 0; _lastStep = 0;
        for (let i = 0; i < BAND_VARS.length; i++) {
            _written[i] = 0;
            _root.style.setProperty(BAND_VARS[i], '0');
        }
        _levels.bass = _levels.mid = _levels.treble = _levels.peak = 0;
    }
    if (_audioReactive) ensureRunning(); else if (!_adaptive) stopLoop();
}

/** Turn adaptive quality on/off. */
export function enableAdaptiveQuality(on) {
    _adaptive = on !== false;
    if (_adaptive) ensureRunning(); else if (!_audioReactive) stopLoop();
}

/** Force a tier and stop auto-adjusting — for a manual quality setting. */
export function setQualityTier(name) {
    if (!TIERS[name]) return;
    _adaptive = false;
    applyTier(name);
}

export function getTier() { return _tier; }
export function getFps() { return Math.round(_fps); }

if (typeof document !== 'undefined') {
    // Park the loop with the tab. Nothing here matters while hidden, and rAF is
    // throttled anyway — but the FPS window would record garbage on return.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopLoop();
        else { _belowSince = 0; _aboveSince = 0; _warmedAt = 0; ensureRunning(); }
    });

    // Seed the tier variables immediately so CSS has real values on first paint
    // rather than falling back mid-render.
    //
    // Seed at `medium`, not `high`. The first thing every player sees is the
    // home page, which has nothing changing on screen — the ambient background
    // is the only thing the GPU is busy with. Starting at `high` guarantees the
    // worst-case first paint and forces the adaptive loop to walk the tier down
    // on a borderline machine; starting at `medium` keeps the visual intact on
    // capable machines (the loop will raise it on the first 6 s above 56 fps)
    // and avoids the worst case on machines that can't.
    applyTier(capped('medium'));
    ensureRunning();
    syncWithQuality();
}

if (typeof window !== 'undefined') {
    window.PoVisualRuntime = {
        enableAudioReactive, enableAdaptiveQuality, setQualityTier, getTier, getFps, syncWithQuality,
        kick, getLevels,
    };
}
