// acousticProbe.js — listen to the geometry: ray-cast reflections and occlusion.
//
// THE PROBLEM
// acoustics.js picks a canned space per game (arena, outdoor, island…) and crossfades named
// zones by hand-authored regions. That is right for a menu and wrong for a world: walk from a
// canyon floor to the ridge above it and nothing about the sound changes, and a hit behind a
// rock sounds exactly like one in plain view. The geometry that decides both is already in the
// game — it just never reached the audio.
//
// WHAT THIS DOES
//   REFLECTIONS  Every frame the probe casts a few of its ~28 rays (a Fibonacci sphere, so the
//                directions are evenly spread and a few per frame still cover the sphere every
//                ~10 frames). A sweep gives, per direction, a hit distance or a miss. From the
//                full sweep it derives:
//                  • taps      the early reflections — a wall d metres away returns your own
//                              sound after 2d/343 s, so each hit is a delayed copy, quieter
//                              with distance and darker for the ground than for a wall; taps
//                              closer than 4 ms are merged (power-summed), panned by which side
//                              of the listener they are on, and the loudest 10 are kept
//                  • roomSize  mean free path in metres (misses count as maxDist)
//                  • openness  0 = boxed in, 1 = nothing in range (sky/field); `sky` is the same
//                              for the upper hemisphere only — a cave and a clearing differ there
//                  • wetScale / decayScale   hints for the reverb send: enclosed → wetter,
//                              bigger → longer
//                They are handed to `apply(estimate)` — acoustics.js `setEarlyTaps` for the app
//                bus, or a game's own `createEarlyTaps` bank — which crossfades between two tap
//                banks so a changing room never zippers.
//   OCCLUSION    occlusionFor(source) casts listener → source (plus two rays offset to either
//                side of the source, so a pillar half-covering it is partial, not binary) and
//                returns 0..1: exactly what impactSynth's `occlusion` option wants (a lowpass
//                toward 900 Hz). Cached for 120 ms per key — a rockslide of 40 chunks asks 40
//                times a frame and must not cast 120 rays.
//
// The raycaster is the game's: (origin, dir, maxDist) → distance | null. For a heightfield
// (PoEcosystem terrain) `heightfieldRaycaster` marches and bisects; a game with a physics
// world or a BVH passes its own.
//
// Pure maths + the supplied callbacks: no AudioContext, no DOM, node-testable.

const SPEED_OF_SOUND = 343;
const MAX_TAPS = 10;
const MERGE_S = 0.004;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** N evenly spread unit vectors (golden-angle spiral). */
export function fibonacciSphere(n) {
    const out = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const a = i * golden;
        out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r });
    }
    return out;
}

/**
 * A raycaster for a heightfield. Marches in growing steps until the ray goes under the
 * surface, then bisects to the crossing.
 *
 * @param {(x:number, z:number) => number} heightAt ground (or water) height
 * @param {{minHeight?:number, step?:number}} [o] minHeight clamps the surface up (sea level)
 * @returns {(origin:{x:number,y:number,z:number}, dir:{x:number,y:number,z:number}, maxDist:number) => number|null}
 */
export function heightfieldRaycaster(heightAt, o = {}) {
    const floor = o.minHeight ?? -Infinity;
    const step0 = o.step || 1.2;
    const surf = (x, z) => Math.max(floor, heightAt(x, z));
    return (origin, dir, maxDist) => {
        let prev = 0;
        let t = step0 * 0.5;
        if (origin.y < surf(origin.x, origin.z)) return 0.05;     // inside the ground
        let step = step0;
        while (t <= maxDist) {
            const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
            if (y < surf(x, z)) {
                let lo = prev, hi = t;
                for (let i = 0; i < 6; i++) {
                    const m = (lo + hi) * 0.5;
                    if (origin.y + dir.y * m < surf(origin.x + dir.x * m, origin.z + dir.z * m)) hi = m; else lo = m;
                }
                return (lo + hi) * 0.5;
            }
            // A ray heading up can never hit a heightfield whose top is below it: stop early.
            if (dir.y > 0 && o.maxHeight != null && y > o.maxHeight) return null;
            prev = t;
            t += step;
            step = Math.min(step * 1.12, 6);
        }
        return null;
    };
}

/**
 * @param {object} cfg
 * @param {(origin:object, dir:object, maxDist:number) => number|null} cfg.raycast
 * @param {number} [cfg.rays=28]       24..32 sensible
 * @param {number} [cfg.perFrame=3]    rays cast per update()
 * @param {number} [cfg.maxDist=70]    metres; a miss counts as this far
 * @param {(estimate:object) => void} [cfg.apply]  called after every completed sweep
 */
export function createAcousticProbe(cfg) {
    const raycast = cfg.raycast;
    const N = clamp(cfg.rays || 28, 8, 64);
    const perFrame = Math.max(1, cfg.perFrame || 3);
    const maxDist = cfg.maxDist || 70;
    const dirs = fibonacciSphere(N);
    /** @type {(number|null)[]} */
    const hits = new Array(N).fill(null);
    let cursor = 0;
    let sweepDone = 0;
    let estimate = null;
    let right = { x: 1, z: 0 };
    const occCache = new Map();

    function derive(listener) {
        // openness / roomSize ignore the downward cone: the floor is always there and says nothing
        // about whether the SPACE is closed.
        let hitN = 0, sum = 0, skyN = 0, skyHit = 0, sideN = 0;
        const cand = [];
        for (let i = 0; i < N; i++) {
            const d = hits[i];
            const up = dirs[i].y > 0.35;
            if (up) skyN++;
            const side = dirs[i].y > -0.2;
            if (side) sideN++;
            if (d == null) { if (side) sum += maxDist; continue; }
            if (side) { hitN++; sum += d; }
            if (up) skyHit++;
            const delay = (2 * d) / SPEED_OF_SOUND;
            if (delay > 0.45) continue;
            const refl = dirs[i].y < -0.5 ? 0.35 : 0.6;                 // grass/sand/dirt eat more than a wall
            const g = refl / (1 + d / 3);
            const pan = clamp(dirs[i].x * right.x + dirs[i].z * right.z, -1, 1);
            cand.push({ delay, g, pan });
        }
        cand.sort((a, b) => a.delay - b.delay);
        // Merge taps closer than MERGE_S (power sum, gain-weighted pan).
        const merged = [];
        for (const c of cand) {
            const last = merged[merged.length - 1];
            if (last && c.delay - last.start < MERGE_S) {
                last.p += c.g * c.g; last.pan += c.pan * c.g; last.w += c.g;
                last.delay = (last.delay * last.n + c.delay) / (last.n + 1); last.n++;
            } else merged.push({ delay: c.delay, start: c.delay, p: c.g * c.g, pan: c.pan * c.g, w: c.g, n: 1 });
        }
        const taps = merged
            .map((m) => ({ delay: m.delay, gain: Math.min(0.7, Math.sqrt(m.p) * 0.9), pan: m.w ? m.pan / m.w : 0 }))
            .sort((a, b) => b.gain - a.gain)
            .slice(0, MAX_TAPS)
            .sort((a, b) => a.delay - b.delay);
        const openness = sideN ? 1 - hitN / sideN : 1;
        const roomSize = sideN ? sum / sideN : maxDist;
        const sky = skyN ? 1 - skyHit / skyN : 1;
        const next = {
            taps, roomSize, openness, sky, meanDistance: roomSize,
            // Enclosed = wetter, big = longer. 1 is "as the canned space".
            wetScale: clamp(1.25 - openness * 0.85 - sky * 0.15, 0.25, 1.4),
            decayScale: clamp(roomSize / 14, 0.35, 2.4),
            listener: listener ? { x: listener.x, y: listener.y, z: listener.z } : null,
        };
        estimate = next;
        sweepDone++;
        if (cfg.apply) { try { cfg.apply(next); } catch { /* audio must not throw into a frame */ } }
        return next;
    }

    return {
        /**
         * Call once per frame. Casts `perFrame` rays from `listener`; returns the latest estimate
         * (or null before the first sweep completes).
         * @param {{x:number,y:number,z:number}} listener
         * @param {{rightX?:number, rightZ?:number}} [o] listener's right vector (for panning taps)
         */
        update(listener, o = {}) {
            if (!listener) return estimate;
            if (o.rightX != null || o.rightZ != null) {
                const rx = o.rightX || 0, rz = o.rightZ || 0, l = Math.hypot(rx, rz) || 1;
                right = { x: rx / l, z: rz / l };
            }
            for (let k = 0; k < perFrame; k++) {
                const i = cursor;
                hits[i] = raycast(listener, dirs[i], maxDist);
                cursor = (cursor + 1) % N;
                if (cursor === 0) derive(listener);
            }
            return estimate;
        },
        /** Force a full sweep now (a teleport, a scene load). */
        sweep(listener) {
            for (let i = 0; i < N; i++) hits[i] = raycast(listener, dirs[i], maxDist);
            cursor = 0;
            return derive(listener);
        },
        /**
         * 0..1: how much of `source` is hidden from `listener`. 0 = plain view; ~1 = fully behind
         * geometry. Three rays (centre + ±0.5 m either side of the source) so an edge is partial.
         * @param {{x:number,y:number,z:number}} source
         * @param {{x:number,y:number,z:number}} [listener]
         * @param {{key?:string|number, ttl?:number}} [o]
         */
        occlusionFor(source, listener, o = {}) {
            const L = listener || estimate?.listener;
            if (!L || !source) return 0;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const key = o.key;
            if (key != null) {
                const c = occCache.get(key);
                if (c && now - c.at < (o.ttl ?? 120)) return c.v;
            }
            const dx = source.x - L.x, dy = source.y - L.y, dz = source.z - L.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist < 0.5) return 0;
            // A perpendicular in the horizontal plane.
            let px = -dz, pz = dx;
            const pl = Math.hypot(px, pz) || 1;
            px = (px / pl) * 0.5; pz = (pz / pl) * 0.5;
            let blocked = 0;
            for (const s of [0, 1, -1]) {
                const tx = dx + px * s, ty = dy, tz = dz + pz * s;
                const tl = Math.hypot(tx, ty, tz);
                const d = raycast(L, { x: tx / tl, y: ty / tl, z: tz / tl }, tl);
                if (d != null && d < tl - 0.6) blocked++;
            }
            const v = [0, 0.35, 0.7, 0.95][blocked];
            if (key != null) {
                occCache.set(key, { at: now, v });
                if (occCache.size > 256) occCache.delete(occCache.keys().next().value);
            }
            return v;
        },
        get estimate() { return estimate; },
        get sweeps() { return sweepDone; },
        get rayCount() { return N; },
    };
}

if (typeof window !== 'undefined') {
    window.PoAcousticProbe = { createAcousticProbe, heightfieldRaycaster, fibonacciSphere };
}
