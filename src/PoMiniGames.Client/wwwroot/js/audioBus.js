// audioBus.js — the platform's single AudioContext and mix graph.
//
// WHY THIS EXISTS
// Modules that each call `new AudioContext()` of their own (uiAudio.js,
// pobrawl/audio.js, pomarblerace/audio.js) cost three real things:
//   1. Browsers cap concurrent hardware AudioContexts (Chrome historically ~6).
//      Five is uncomfortably close, and each one holds a hardware output.
//   2. There was no global mix. Nothing could duck music under a cue, because
//      "music" and "cue" lived in different graphs that never met.
//   3. Mute would be enforced separately by each module
//      string-matching `localStorage['pomini_muted']` at the call site. Miss one
//      call path and a muted player still hears it.
//
// THE GRAPH
//
//     ui   ──┬─→ sfxVol ──┐
//     sfx  ──┘             ├─→ preMaster ─→ compressor ─→ masterGain ─→ analyser ─→ destination
//     music ───→ musicVol ─┘        │                                       │
//                                   └──→ reverbSend ─→ convolver ───┘       └→ getLevels()
//
// Two level stages sit between the buses and the mix: sfxVol (UI clicks and game
// effects — one "Effects" slider) and musicVol (the adaptive layers, musicLayers.js).
// They are separate nodes from the buses themselves because duck() automates the
// music bus's own gain; one owner per AudioParam.
//
// The compressor is a safety net: generative audio has no mastering engineer,
// and stacking a fanfare over an ambient bed over UI clicks can clip. The
// analyser sits last so #8's audio-reactive visuals see the true output.
//
// EVERY node here is created lazily on first use and the context starts
// suspended until a user gesture — mobile autoplay policy is not negotiable.

const MUTE_KEY = 'pomini_muted';
const VOLUME_KEY = 'pomini_volume';
// Per-category levels, integer percent like VOLUME_KEY. Music defaults to 0: background
// music is off app-wide unless the player turns it up, so a fresh install stays as quiet
// as it was before the music stage existed.
const BUS_VOLUME_KEYS = { sfx: 'pomini_sfx_volume', music: 'pomini_music_volume' };
const BUS_VOLUME_DEFAULTS = { sfx: 1, music: 0 };

let _ctx = null;
let _initPromise = null;
let _nodes = null;
let _muted = readMutedFromStorage();
let _volume = readVolumeFromStorage();
let _busVolume = {
    sfx: readPercent(BUS_VOLUME_KEYS.sfx, BUS_VOLUME_DEFAULTS.sfx),
    music: readPercent(BUS_VOLUME_KEYS.music, BUS_VOLUME_DEFAULTS.music),
};
let _analyserData = null;

function readMutedFromStorage() {
    try {
        return (localStorage.getItem(MUTE_KEY) || '').indexOf('1') !== -1;
    } catch {
        return false;
    }
}

/**
 * Master volume, 0..1, persisted as an integer percentage.
 * Read here rather than pushed in from C# so the very first sound of the
 * session is already at the right level: audio can fire from a game's own JS
 * engine before SettingsService has had a chance to run any interop.
 * Anything unparseable falls back to full volume rather than silence — a
 * corrupt key must never look like broken audio.
 */
function readVolumeFromStorage() {
    return readPercent(VOLUME_KEY, 1);
}

/** An integer-percent key as 0..1; missing or unparseable is `fallback`. */
function readPercent(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const pct = parseInt(raw, 10);
        if (!Number.isFinite(pct)) return fallback;
        return Math.max(0, Math.min(100, pct)) / 100;
    } catch {
        return fallback;
    }
}

/** Single AudioContext for the whole app. Resumed opportunistically. */
export async function context() {
    if (_ctx) return _ctx;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        _ctx = new Ctor();
        buildGraph(_ctx);
        if (_ctx.state === 'suspended') {
            // May reject if no gesture has happened yet; the gesture listeners
            // installed below will retry.
            try { await _ctx.resume(); } catch { /* retried on gesture */ }
        }
        return _ctx;
    })();
    return _initPromise;
}

/**
 * Synchronous context accessor for the non-module interop files
 * (pobrawl/audio.js, pomarblerace/audio.js). Those acquire their context inside synchronous
 * functions and cannot await.
 *
 * Constructing an AudioContext IS synchronous — only resume() is async — so
 * this is safe. The context still starts suspended until a gesture; the
 * listeners at the bottom of this file resume it.
 * @returns {AudioContext|null}
 */
export function contextSync() {
    if (_ctx) return _ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _ctx = new Ctor();
    buildGraph(_ctx);
    _initPromise = Promise.resolve(_ctx);
    try { _ctx.resume(); } catch { /* retried on gesture */ }
    return _ctx;
}

/**
 * Synchronous bus accessor. Returns null only when Web Audio is unavailable,
 * in which case callers should fall back to their previous behaviour.
 * @param {'music'|'sfx'|'ui'} name
 * @returns {GainNode|null}
 */
export function busSync(name) {
    const ctx = contextSync();
    if (!ctx || !_nodes) return null;
    return _nodes[name] || _nodes.sfx;
}

function buildGraph(ctx) {
    const masterGain = ctx.createGain();
    masterGain.gain.value = targetGain();

    // Analyser last in the chain so it observes exactly what the player hears.
    // fftSize 512 -> 256 bins; plenty of resolution for a 3-band visual read
    // and cheap enough to poll every frame.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    _analyserData = new Uint8Array(analyser.frequencyBinCount);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const preMaster = ctx.createGain();

    // Per-category buses. Games connect their own internal master here instead
    // of ctx.destination, which is what makes ducking and per-bus volume work.
    const music = ctx.createGain();
    const sfx = ctx.createGain();
    const ui = ctx.createGain();
    const sfxVol = ctx.createGain();
    sfxVol.gain.value = _busVolume.sfx;
    const musicVol = ctx.createGain();
    musicVol.gain.value = _busVolume.music;

    // Synthesized impulse response — a reverb with no asset to download.
    // Exponentially-decaying stereo noise is a crude but convincing small-room
    // tail, and it costs one buffer we generate at runtime.
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulseResponse(ctx, 1.9, 3.2);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.0; // opened per-game via setReverb()
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;

    // Background music is off app-wide by default: musicVol starts at the stored music
    // level, which is 0 until the player raises it.
    sfx.connect(sfxVol);
    ui.connect(sfxVol);
    sfxVol.connect(preMaster);
    music.connect(musicVol).connect(preMaster);

    preMaster.connect(reverbSend);
    reverbSend.connect(convolver).connect(reverbReturn).connect(compressor);

    preMaster.connect(compressor);
    compressor.connect(masterGain).connect(analyser).connect(ctx.destination);

    _nodes = {
        masterGain, analyser, compressor, preMaster, music, sfx, ui, sfxVol, musicVol,
        convolver, reverbSend, reverbReturn,
    };
}

/**
 * Build an exponentially-decaying noise impulse response.
 * @param {AudioContext} ctx
 * @param {number} seconds  tail length
 * @param {number} decay    higher = faster falloff
 */
function makeImpulseResponse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
    }
    return buf;
}

/**
 * Get a named mix bus to connect into. This replaces `ctx.destination` at
 * every call site in the app.
 * @param {'music'|'sfx'|'ui'} name
 * @returns {Promise<GainNode|null>}
 */
export async function bus(name) {
    const ctx = await context();
    if (!ctx || !_nodes) return null;
    return _nodes[name] || _nodes.sfx;
}

/** True when audio is globally muted. Call sites no longer need to read localStorage. */
export function isMuted() {
    return _muted;
}

/** Master volume as 0..1. */
export function getVolume() {
    return _volume;
}

/**
 * The gain the master node should sit at right now. Mute is a hard override
 * rather than a volume of 0, so that unmuting restores the level the player
 * chose instead of resurrecting silence.
 */
function targetGain() {
    return _muted ? 0 : _volume;
}

/** Ramp the master node to the current target. Shared by setMuted/setVolume. */
function applyGain() {
    if (!_nodes || !_ctx) return;
    const t = _ctx.currentTime;
    _nodes.masterGain.gain.cancelScheduledValues(t);
    _nodes.masterGain.gain.setTargetAtTime(targetGain(), t, 0.02);
    // For the two engines that keep their own AudioContext for world-space audio
    // (pocabinet, poecosystem) and so cannot sit under this gain node.
    try { window.dispatchEvent(new Event('po-audio-change')); } catch { /* no window */ }
}

/**
 * Global mute. Ramped rather than hard-set so toggling mid-tone doesn't click.
 * @param {boolean} muted
 */
export function setMuted(muted) {
    _muted = !!muted;
    try { localStorage.setItem(MUTE_KEY, _muted ? '1' : '0'); } catch { /* private mode */ }
    applyGain();
}

/**
 * Master volume, 0..1. Ramped for the same anti-click reason as mute, which
 * also makes it safe to call on every input event while a slider is dragged.
 * Persisted as an integer percent so the value stays readable in DevTools.
 * @param {number} volume
 */
export function setVolume(volume) {
    const v = Number(volume);
    _volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    try { localStorage.setItem(VOLUME_KEY, String(Math.round(_volume * 100))); } catch { /* private mode */ }
    applyGain();
}

/**
 * Level of one category, 0..1: 'sfx' (UI clicks and game effects share it) or 'music'.
 * Anything else reads as the sfx level.
 * @param {'sfx'|'ui'|'music'} name
 */
export function getBusVolume(name) {
    return name === 'music' ? _busVolume.music : _busVolume.sfx;
}

/**
 * Set one category's level, 0..1, ramped like setVolume. 'ui' is the same stage as
 * 'sfx': players think of clicks and hits as one kind of sound.
 * @param {'sfx'|'ui'|'music'} name
 * @param {number} volume
 */
export function setBusVolume(name, volume) {
    const key = name === 'music' ? 'music' : 'sfx';
    const v = Number(volume);
    _busVolume[key] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : BUS_VOLUME_DEFAULTS[key];
    try { localStorage.setItem(BUS_VOLUME_KEYS[key], String(Math.round(_busVolume[key] * 100))); } catch { /* private mode */ }
    if (_nodes && _ctx) {
        const g = (key === 'music' ? _nodes.musicVol : _nodes.sfxVol).gain;
        const t = _ctx.currentTime;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(_busVolume[key], t, 0.02);
    }
    try { window.dispatchEvent(new Event('po-audio-change')); } catch { /* no window */ }
}

/**
 * True when a category would reach the speakers at all — not muted and neither the
 * master nor that category at 0. Generators check this to skip scheduling silence.
 * @param {'sfx'|'ui'|'music'} name
 */
export function isAudible(name) {
    return !_muted && _volume > 0 && getBusVolume(name) > 0;
}

/**
 * Duck the music bus under a foreground cue, then restore.
 * @param {number} [amount=0.35] gain to dip to (0..1)
 * @param {number} [holdMs=400]  how long to stay dipped
 */
export async function duck(amount, holdMs) {
    const ctx = await context();
    if (!ctx || !_nodes) return;
    const a = amount == null ? 0.35 : amount;
    const hold = (holdMs == null ? 400 : holdMs) / 1000;
    const t = ctx.currentTime;
    const g = _nodes.music.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(a, t, 0.03);
    g.setTargetAtTime(1, t + hold, 0.25);
}

/**
 * Swap the convolver's impulse response — the app's "acoustic space".
 *
 * The default IR built above is a generic small room, which is the wrong answer
 * everywhere: PoBrawl happens in a hard-walled arena, PoRacer outdoors where
 * there are no reflective surfaces at all, ConnectFive on a plastic board a
 * foot from your face. acoustics.js generates the per-game buffers; this is
 * where they land.
 *
 * Assignment is instant and NOT crossfaded. A convolver keeps a tail of the
 * previous input, so swapping mid-tail truncates it with a click — always swap
 * on a scene change (route entry, round start), never during play.
 * @param {AudioBuffer|null} buffer null restores the default room
 */
export async function setSpaceBuffer(buffer) {
    const ctx = await context();
    if (!ctx || !_nodes) return;
    _nodes.convolver.buffer = buffer || makeImpulseResponse(ctx, 1.9, 3.2);
}

/**
 * Set the global reverb send level. 0 disables the tail entirely.
 * @param {number} amount 0..1
 */
export async function setReverb(amount) {
    const ctx = await context();
    if (!ctx || !_nodes) return;
    _nodes.reverbSend.gain.setTargetAtTime(
        Math.max(0, Math.min(1, amount)), ctx.currentTime, 0.15);
}

/** Convolver send node, for call sites that want a per-voice wet path. */
export async function reverbSend() {
    await context();
    return _nodes ? _nodes.reverbSend : null;
}

/**
 * Create a StereoPannerNode already connected to the given bus.
 * @param {'music'|'sfx'|'ui'} busName
 * @param {number} pan -1 (left) .. 1 (right)
 */
export async function panner(busName, pan) {
    const ctx = await context();
    const target = await bus(busName);
    if (!ctx || !target || !ctx.createStereoPanner) return null;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    p.connect(target);
    return p;
}

/**
 * Three-band level read for audio-reactive visuals (#8).
 * Returns normalised 0..1 values; safe to call every animation frame.
 * @returns {{bass:number, mid:number, treble:number, peak:number}}
 */
export function getLevels() {
    if (!_nodes || !_analyserData) return { bass: 0, mid: 0, treble: 0, peak: 0 };
    _nodes.analyser.getByteFrequencyData(_analyserData);
    const n = _analyserData.length;
    const bassEnd = Math.floor(n * 0.08);
    const midEnd = Math.floor(n * 0.35);
    let b = 0, m = 0, t = 0, peak = 0;
    for (let i = 0; i < n; i++) {
        const v = _analyserData[i];
        if (v > peak) peak = v;
        if (i < bassEnd) b += v;
        else if (i < midEnd) m += v;
        else t += v;
    }
    return {
        bass: b / Math.max(1, bassEnd) / 255,
        mid: m / Math.max(1, midEnd - bassEnd) / 255,
        treble: t / Math.max(1, n - midEnd) / 255,
        peak: peak / 255,
    };
}

/** Resume after a user gesture. Idempotent. */
export async function resume() {
    const ctx = await context();
    if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* still no gesture */ }
    }
    return ctx ? ctx.state : 'unavailable';
}

export function isAvailable() {
    return !!(window.AudioContext || window.webkitAudioContext);
}

/** True once the shared context exists. Never creates it (unlike context()/contextSync()). */
export function hasContext() {
    return !!_ctx;
}

// One-shot gesture listeners so the context is live the moment the player first
// interacts, rather than on the first sound (which would drop that sound).
if (typeof window !== 'undefined') {
    const kick = () => { resume(); };
    for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(evt, kick, { once: false, passive: true });
    }

    // Battery-saving visibility listener: suspend AudioContext when tab is backgrounded
    document.addEventListener('visibilitychange', () => {
        if (!_ctx) return;
        if (document.hidden && _ctx.state === 'running') {
            try { _ctx.suspend(); } catch {}
        } else if (!document.hidden && _ctx.state === 'suspended') {
            try { _ctx.resume(); } catch {}
        }
    }, { passive: true });

    // Listen for the po-audio-mute CustomEvent the kiosk control bar
    // fires. The bar is the only place this lives because audio is part of the
    // watch experience and the rest of the app already has its own SettingsService
    // toggle. Routing through this DOM event keeps the C# side free of a hard
    // reference to audioBus.js — any module can publish the same event later.
    document.addEventListener('po-audio-mute', (ev) => {
        try {
            const muted = !!(ev && ev.detail && ev.detail.muted);
            setMuted(muted);
        } catch { /* best-effort: storage write already happened */ }
    });

    // Cross-module access for the non-ESM interop files.
    // contextSync/busSync MUST be here: pobrawl/audio.js and
    // pomarblerace/audio.js both
    // call them through this object. If they are missing, every one of those
    // modules silently falls back to constructing its own AudioContext and the
    // shared graph quietly stops being shared.
    window.PoAudioBus = {
        context, contextSync, bus, busSync, isMuted, setMuted, getVolume, setVolume,
        getBusVolume, setBusVolume, isAudible,
        duck, setReverb, setSpaceBuffer, reverbSend, panner, getLevels, resume, isAvailable, hasContext,
    };
}
