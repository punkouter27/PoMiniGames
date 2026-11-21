// contactLoop.js — continuous contact sound for moving bodies (rolling, scraping, skidding).
//
// WHAT WAS MISSING
// impactSynth.js answers "something hit something" — one short voice per collision. A
// marble rolling down a chute, a crate sliding along a floor and a tyre breaking away on
// tarmac are not events: they are a sound that lasts exactly as long as the contact does,
// and whose pitch/level are continuous functions of how fast the surface moves under the
// body. pobrawl and pocabinet each had a private scrape; pomarblerace and poracer each a
// private noise-bed. This is the shared one.
//
//     const v = createContactVoice('stone', { spatial: true, radius: 0.3 });
//     // every frame (or physics step), for each moving body:
//     v.update({ rollSpeed, slipSpeed, load, position });
//     // when the body dies / leaves the scene:
//     v.stop();
//
//   rollSpeed   m/s the surface passes under the contact patch with NO slip (|ω|·r). Drives the
//               rumble pitch/level and the wheel-rate ridging.
//   slipSpeed   m/s of relative sliding at the contact (|v_tangent − ω×r|). Drives the friction
//               noise, its stick-slip rate and — for 'tyre' — the squeal.
//   load        0..1 how hard the surfaces are pressed (0 airborne → silence; 1 resting weight).
//   position    {x,y,z} world position; with `spatial` it is panned and attenuated against the
//               AudioContext listener (the engine already parks that on its camera).
//   occlusion   0..1 optional (acousticProbe.occlusionFor) — lowpass toward 900 Hz.
//
// TAGS: impactMaterials tags map onto 8 friction colours — 'tyre' and 'ice' are extra.
//
// ONE NODE, A POOL: every voice lives inside a single AudioWorkletNode (worklets/contactVoice.js)
// with 8 slots; the worklet smooths every number per sample so a stepped update never clicks.
// The pool is tier-capped (high 8, medium 5, low 3). When it is full the QUIETEST voice is
// stolen for a louder newcomer — a body that is barely touching never keeps a slot against
// one that is thundering. A voice that has no slot is a safe no-op (update() just remembers).
//
// Never creates an AudioContext of its own: before the first gesture nothing sounds. Mute and
// the Effects slider apply because the node feeds the shared 'sfx' bus (or `destination`).

import * as AudioBus from './audioBus.js';

const WORKLET_URL = '/js/worklets/contactVoice.js';
const SLOTS = 8;
const SEND_INTERVAL_S = 1 / 40;   // param messages per voice per second cap
const REUSE_GAP_S = 0.15;         // a freed slot rests this long (its tail is still fading)
const CAPS = Object.freeze({ high: 8, medium: 5, low: 3 });

export const MATERIAL_INDEX = Object.freeze({
    stone: 0, metal: 1, wood: 2, glass: 3, rubber: 4, dirt: 5, tyre: 6, ice: 7,
    // impactMaterials tags without their own friction colour
    paint: 1, flesh: 4, water: 5,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function tier() {
    try { return document.documentElement.getAttribute('data-gfx') || 'high'; } catch { return 'high'; }
}

/**
 * The engine: one AudioWorkletNode plus the slot table. Exported so a test can drive it on an
 * OfflineAudioContext; games use createContactVoice() which owns a shared one.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @returns {Promise<object|null>} null when worklets are unavailable (callers keep their old bed)
 */
export async function createContactEngine(ctx, destination) {
    if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
    try { await ctx.audioWorklet.addModule(WORKLET_URL); } catch { return null; }
    const node = new AudioWorkletNode(ctx, 'po-contact', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(destination);

    /** @type {({slot:number, level:number}|null)[]} the voice holding each slot */
    const slots = new Array(SLOTS).fill(null);
    const freeAt = new Array(SLOTS).fill(-1);

    function cap() { return Math.min(SLOTS, CAPS[tier()] || CAPS.high); }

    /** Give `voice` a slot, stealing the quietest one if the loudness warrants it. */
    function claim(voice, level) {
        const now = ctx.currentTime;
        const limit = cap();
        let free = -1, quiet = -1;
        let used = 0;
        for (let i = 0; i < SLOTS; i++) {
            const s = slots[i];
            if (s) { used++; if (quiet < 0 || s.level < slots[quiet].level) quiet = i; }
            else if (free < 0 && now >= freeAt[i]) free = i;
        }
        if (free >= 0 && used < limit) return free;
        if (quiet >= 0 && slots[quiet].level < level * 0.8) {
            release(quiet);
            // the stolen slot is fading; use a different free one if there is, else wait
            return free;
        }
        return -1;
    }

    function release(i) {
        const s = slots[i];
        if (!s) return;
        s.slot = -1;                 // slots[] holds the voice itself
        slots[i] = null;
        freeAt[i] = ctx.currentTime + REUSE_GAP_S;
        node.port.postMessage({ type: 'free', slot: i });
    }

    return {
        node,
        ctx,
        activeCount() { return slots.reduce((n, s) => n + (s ? 1 : 0), 0); },
        /** @private */ _claim: claim, _release: release, _slots: slots,
        voice(tag, opts = {}) {
            const mat = MATERIAL_INDEX[tag] ?? MATERIAL_INDEX.stone;
            const spatial = !!opts.spatial;
            const self = {
                slot: -1, lastSent: -1, lastAt: 0, level: 0, dead: false,
                update(p = {}) {
                    if (self.dead) return;
                    const roll = Math.max(0, Number(p.rollSpeed) || 0);
                    const slip = Math.max(0, Number(p.slipSpeed) || 0);
                    const load = clamp(p.load == null ? 1 : Number(p.load), 0, 1);
                    // Loudness estimate for the pool (before distance).
                    let place = { pan: 0, gain: 1 };
                    if (spatial && p.position) place = placement(ctx, p.position, opts);
                    const level = (Math.min(1, roll / 12) * 0.6 + Math.min(1, slip / 8)) * load * place.gain;
                    self.level = level;
                    const audible = level > 0.004;
                    const now = ctx.currentTime;
                    if (!audible) {
                        if (self.slot >= 0) {
                            // Silent contact: ramp down in the worklet but keep the slot a moment
                            // so a bouncing body doesn't churn the pool.
                            node.port.postMessage({ type: 'set', slot: self.slot, roll: 0, slip: 0, load: 0, gain: 0, pan: place.pan, occ: 0 });
                            self.silentSince = self.silentSince ?? now;
                            if (now - self.silentSince > 0.8) release(self.slot);
                        }
                        return;
                    }
                    self.silentSince = null;
                    if (self.slot < 0) {
                        const s = claim(self, level);
                        if (s < 0) return;
                        self.slot = s;
                        slots[s] = self;
                        node.port.postMessage({ type: 'open', slot: s, mat, radius: opts.radius || 0.3 });
                        self.lastAt = -1;
                    }
                    if (now - self.lastAt < SEND_INTERVAL_S) return;
                    self.lastAt = now;
                    node.port.postMessage({
                        type: 'set', slot: self.slot, roll, slip, load,
                        gain: (opts.gain == null ? 1 : opts.gain) * place.gain,
                        pan: place.pan, occ: clamp(Number(p.occlusion) || 0, 0, 1),
                    });
                },
                stop() {
                    self.dead = true;
                    if (self.slot >= 0) release(self.slot);
                },
                get active() { return self.slot >= 0; },
            };
            return self;
        },
    };
}

/** Pan and distance gain of `pos` against the context listener (inverse-distance, ref 4 m). */
function placement(ctx, pos, opts) {
    const L = ctx.listener;
    if (!L || !L.positionX) return { pan: 0, gain: 1 };
    const dx = pos.x - L.positionX.value, dy = (pos.y || 0) - L.positionY.value, dz = pos.z - L.positionZ.value;
    const dist = Math.hypot(dx, dy, dz);
    const ref = opts.refDistance || 4;
    const gain = ref / (ref + Math.max(0, dist - ref) * (opts.rolloff || 1));
    // right = forward × up
    const fx = L.forwardX.value, fy = L.forwardY.value, fz = L.forwardZ.value;
    const ux = L.upX.value, uy = L.upY.value, uz = L.upZ.value;
    let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const pan = dist > 1e-4 ? clamp((dx * rx + dy * ry + dz * rz) / Math.max(dist, 1) * 0.9, -1, 1) : 0;
    return { pan, gain: clamp(gain, 0, 1) };
}

// ── Shared engine on the app bus ──────────────────────────────────────────

let _engine = null;
let _loading = null;

function ensureShared() {
    if (_engine || _loading) return;
    if (!AudioBus.hasContext()) return;          // never create the context here
    const ctx = AudioBus.contextSync();
    const dest = AudioBus.busSync('sfx');
    if (!ctx || !dest) return;
    _loading = createContactEngine(ctx, dest).then((e) => { _engine = e; if (!e) _loading = null; });
}

/**
 * A contact voice on the shared engine. Safe before the first gesture and before the worklet
 * module has loaded (update() is then a no-op that retries on the next call).
 *
 * @param {string} tag impactMaterials tag, or 'tyre' / 'ice'
 * @param {object} [opts]
 * @param {boolean} [opts.spatial]   pan/attenuate by `update({position})` against ctx.listener
 * @param {number}  [opts.radius]    wheel/ball radius in metres (ridge rate)
 * @param {number}  [opts.gain=1]
 * @param {number}  [opts.refDistance=4]
 */
export function createContactVoice(tag, opts = {}) {
    let inner = null;
    let stopped = false;
    return {
        update(p) {
            if (stopped) return;
            if (!_engine) { ensureShared(); return; }
            if (!inner) inner = _engine.voice(tag, opts);
            if (!AudioBus.isAudible('sfx')) { inner.update({ ...p, rollSpeed: 0, slipSpeed: 0, load: 0 }); return; }
            inner.update(p);
        },
        stop() { stopped = true; inner?.stop(); inner = null; },
        get active() { return !!inner && inner.active; },
    };
}

/** Voices currently holding a slot (debug overlays, tests). */
export function activeContactVoices() { return _engine ? _engine.activeCount() : 0; }

if (typeof window !== 'undefined') {
    window.PoContactLoop = { createContactVoice, createContactEngine, activeContactVoices, MATERIAL_INDEX };
}
