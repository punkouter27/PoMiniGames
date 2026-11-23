// pofighter/sfx.js — everything a fight sounds like apart from the voices and the announcer.
//
//   impacts     a landed hit is a body thud (impactSynth 'flesh') plus a short slap crack whose
//               brightness and level grow with the move and the combo; a blocked hit is a dull
//               'rubber' pap. A knockout blow also rings through a feedback echo (the gym's tail).
//   placement   every sound is panned from its x in the arena (spatialAudio's panX rule), so with
//               headphones a fight in the left corner is heard on the left.
//   room        the gym reverb itself is acoustics.js's 'court' space (GAME_SPACES.pofighter).
//   whooshes    a swing is a band-passed noise sweep whose pitch rises with the move's speed, so
//               a whiff still sounds like something happened.
//   foley       footsteps on the walk cadence, a cloth rustle on a crouch or a jump, a thump on
//               landing and on a body hitting the canvas.
//   crowd       a procedural murmur (two band-passed noise beds, slowly breathing) that swells on
//               combos and roars on a knockout.
//   music       musicLayers + tensionMixer, driven by health, the clock and the round; at a
//               knockout it drops away under a heartbeat and comes back for the next round.
//   stingers    a low "whomp" under the ROUND / FIGHT / K.O. banners.
//
// All of it rides the shared buses (audioBus.js): the sfx bus for effects and crowd, the music
// bus for the score, so mute and the sliders apply, and nothing plays before the first gesture.

import * as AudioBus from '../platform/audioBus.js';
import * as ImpactSynth from '../platform/impactSynth.js';
import { createMusicLayers } from '../platform/musicLayers.js';
import { createTensionMixer } from '../platform/tensionMixer.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** -1..1 stereo place for x in an arena `width` wide (kept off the hard edges). Pure. */
export function panFor(x, width) {
    if (!width) return 0;
    return clamp((x / width) * 2 - 1, -1, 1) * 0.8;
}

/** The swing sweep for a move: { from, to, dur, gain } (Hz, seconds). Pure. */
export function whooshShape(move) {
    return move === 'kick'
        ? { from: 320, to: 1500, dur: 0.24, gain: 0.22 }
        : { from: 520, to: 2600, dur: 0.15, gain: 0.16 };
}

/** The impact for a hit event: { tag, impulse, crack (0..1) }. Pure. */
export function impactShape(e) {
    if (e.type === 'block') return { tag: 'rubber', impulse: 7, crack: 0 };
    const heavy = e.heavy ?? e.move === 'kick';
    const combo = Math.min(4, Math.max(0, (e.combo ?? 0) - 1));
    return { tag: 'flesh', impulse: (heavy ? 17 : 12) + combo * 1.5, crack: clamp((heavy ? 0.75 : 0.55) + combo * 0.08, 0, 1) };
}

/**
 * Foley from what each body's move did since the last step, shared by the fight and the practice
 * room: a whoosh as a swing starts, cloth on a crouch or a jump, a thump and a puff on landing,
 * footsteps on the walk cadence, and the body meeting the floor a moment into a knockdown.
 * audio: createFightAudio(); fx: createFightFx(); onFall(x): extra feel for a knockdown (a shake).
 * step(bodies, dt) takes [{ move, x }] in a fixed order (one slot per body).
 */
const AIR_MOVES = new Set(['jump']);
const ATTACK_MOVES = new Set(['punchMid', 'kick']);

export function createFoley(audio, fx, onFall = () => { }) {
    const tracks = [];
    return {
        step(bodies, dt) {
            bodies.forEach((b, i) => {
                const tr = tracks[i] ??= { move: b.move, walk: 0, fallIn: 0 };
                if (b.move !== tr.move) {
                    if (ATTACK_MOVES.has(b.move)) audio.whoosh(b.x, b.move);
                    else if (b.move === 'crouch' || b.move === 'jump') audio.cloth(b.x);
                    if (AIR_MOVES.has(tr.move) && b.move !== 'down' && b.move !== 'ko') { audio.land(b.x); fx.puff(b.x, 0.4); }
                    if (b.move === 'ko' || b.move === 'down') tr.fallIn = 0.45;
                    tr.move = b.move;
                    tr.walk = 0.2;
                }
                if ((b.move === 'walkF' || b.move === 'walkB') && (tr.walk += dt) >= 0.3) { tr.walk = 0; audio.step(b.x); }
                if (tr.fallIn > 0 && (tr.fallIn -= dt) <= 0) { audio.land(b.x, true); fx.puff(b.x, 1); onFall(b.x); }
            });
        },
    };
}

let noiseCache = null;   // { ctx, buf } — two seconds of white noise, made once per context
function noise(ctx) {
    if (noiseCache?.ctx === ctx) return noiseCache.buf;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache = { ctx, buf };
    return buf;
}

/**
 * The fight's sound. width: the arena width (for panning). Call update() every step with the
 * fight's drivers and dispose() when the fight ends.
 */
export function createFightAudio({ width }) {
    let music = null, tension = null;
    let crowd = null;          // { srcs, gain, filters }
    let echo = null;           // { input, nodes } — the knockout tail
    let musicHold = 0;         // seconds the music stays down after a knockout
    let crowdLevel = 0.05;     // the murmur's resting level
    let crowdBoost = 0;        // a swell on top, decaying
    let disposed = false;

    const live = () => {
        if (disposed || !AudioBus.hasContext() || !AudioBus.isAudible('sfx')) return null;
        const ctx = AudioBus.contextSync();
        const out = AudioBus.busSync('sfx');
        return ctx && out && ctx.state === 'running' ? { ctx, out } : null;
    };

    // One panned output for a voice; returns the node to connect into.
    function placed(ctx, out, x, gain = 1) {
        const g = ctx.createGain();
        g.gain.value = gain;
        if (ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = panFor(x, width);
            g.connect(p).connect(out);
        } else g.connect(out);
        return g;
    }

    // A burst of filtered noise: type/freq/q set the colour, env the shape.
    function noiseHit(ctx, dest, { type = 'bandpass', freq = 1000, freqEnd = freq, q = 1, dur = 0.1, gain = 0.2, attack = 0.004, at = 0 }) {
        const t = ctx.currentTime + at;
        const src = ctx.createBufferSource();
        src.buffer = noise(ctx);
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.Q.value = q;
        f.frequency.setValueAtTime(freq, t);
        if (freqEnd !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(dest);
        src.start(t, Math.random() * 1.5);
        src.stop(t + dur + 0.05);
    }

    // A sine drop: the body of a thump, a heartbeat or a banner whomp.
    function drop(ctx, dest, { from, to, dur, gain, at = 0 }) {
        const t = ctx.currentTime + at;
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(from, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(dest);
        o.start(t);
        o.stop(t + dur + 0.05);
    }

    // The knockout tail: a darkening feedback echo into the sfx bus, built on first use.
    function echoInput(ctx, out) {
        if (echo?.ctx === ctx) return echo.input;
        const input = ctx.createGain();
        const delay = ctx.createDelay(1);
        delay.delayTime.value = 0.17;
        const fb = ctx.createGain();
        fb.gain.value = 0.42;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1800;
        const wet = ctx.createGain();
        wet.gain.value = 0.55;
        input.connect(delay).connect(lp).connect(fb).connect(delay);
        lp.connect(wet).connect(out);
        echo = { ctx, input, nodes: [input, delay, fb, lp, wet] };
        return input;
    }

    function startCrowd(ctx, out) {
        if (crowd) return;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(out);
        const srcs = [], filters = [];
        for (const [freq, q, pan] of [[520, 0.7, -0.5], [1150, 0.9, 0.5]]) {
            const src = ctx.createBufferSource();
            src.buffer = noise(ctx);
            src.loop = true;
            src.playbackRate.value = 0.5;      // halved: a softer, rounder hiss
            const f = ctx.createBiquadFilter();
            f.type = 'bandpass';
            f.frequency.value = freq;
            f.Q.value = q;
            const breathe = ctx.createGain();  // each bed breathes on its own slow cycle
            breathe.gain.value = 0.6;
            const lfo = ctx.createOscillator();
            lfo.frequency.value = 0.11 + Math.random() * 0.09;
            const depth = ctx.createGain();
            depth.gain.value = 0.35;
            lfo.connect(depth).connect(breathe.gain);
            let node = src.connect(f).connect(breathe);
            if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
            node.connect(gain);
            src.start(0, Math.random() * 1.5);
            lfo.start();
            srcs.push(src, lfo);
            filters.push(f);
        }
        crowd = { srcs, gain, filters };
    }

    const api = {
        /** A landed or blocked hit (a versus.js 'hit' / 'block' event). final: the round's last blow. */
        impact(e, final = false) {
            const a = live();
            if (!a) return;
            const { ctx, out } = a;
            const s = impactShape(e);
            ImpactSynth.play(s.tag, s.impulse, { pan: panFor(e.x, width), scale: (e.heavy ?? e.move === 'kick') ? 1.4 : 1 });
            const dest = placed(ctx, out, e.x);
            if (s.crack > 0) {
                // The slap: bright, very short, the part that reads as skin and glove.
                noiseHit(ctx, dest, { type: 'bandpass', freq: 2600 + s.crack * 1400, q: 0.9, dur: 0.05 + s.crack * 0.03, gain: 0.28 * s.crack });
                drop(ctx, dest, { from: 140, to: 55, dur: 0.16, gain: 0.32 * s.crack });
            } else {
                noiseHit(ctx, dest, { type: 'lowpass', freq: 900, dur: 0.07, gain: 0.12 });
            }
            if (final) {
                const tail = echoInput(ctx, out);
                noiseHit(ctx, tail, { type: 'bandpass', freq: 3000, q: 0.8, dur: 0.09, gain: 0.35 });
                drop(ctx, tail, { from: 120, to: 40, dur: 0.4, gain: 0.45 });
            }
        },

        /** A swing starting at x. */
        whoosh(x, move) {
            const a = live();
            if (!a) return;
            const w = whooshShape(move);
            noiseHit(a.ctx, placed(a.ctx, a.out, x), { type: 'bandpass', freq: w.from, freqEnd: w.to, q: 1.6, dur: w.dur, gain: w.gain, attack: w.dur * 0.55 });
        },

        /** One footstep at x (soft, heel on a wooden floor). */
        step(x) {
            const a = live();
            if (!a) return;
            const dest = placed(a.ctx, a.out, x, 0.8);
            noiseHit(a.ctx, dest, { type: 'lowpass', freq: 380, dur: 0.06, gain: 0.07 });
            drop(a.ctx, dest, { from: 95, to: 60, dur: 0.07, gain: 0.05 });
        },

        /** Cloth moving at x (a crouch, a jump). */
        cloth(x) {
            const a = live();
            if (!a) return;
            noiseHit(a.ctx, placed(a.ctx, a.out, x), { type: 'highpass', freq: 2200, dur: 0.16, gain: 0.05, attack: 0.05 });
        },

        /** Feet or a body meeting the floor at x; heavy for a knockdown. */
        land(x, heavy = false) {
            const a = live();
            if (!a) return;
            const dest = placed(a.ctx, a.out, x);
            noiseHit(a.ctx, dest, { type: 'lowpass', freq: heavy ? 500 : 320, dur: heavy ? 0.22 : 0.1, gain: heavy ? 0.3 : 0.12 });
            drop(a.ctx, dest, { from: heavy ? 110 : 90, to: 42, dur: heavy ? 0.3 : 0.12, gain: heavy ? 0.4 : 0.14 });
        },

        /** The low hit under a banner: 'round' | 'fight' | 'ko' | 'win'. */
        stinger(kind) {
            const a = live();
            if (!a) return;
            const big = kind === 'ko' || kind === 'win';
            drop(a.ctx, a.out, { from: big ? 180 : 150, to: 38, dur: big ? 0.6 : 0.35, gain: big ? 0.42 : 0.28 });
            noiseHit(a.ctx, a.out, { type: 'lowpass', freq: kind === 'fight' ? 2400 : 1200, freqEnd: 200, dur: big ? 0.5 : 0.3, gain: 0.12, attack: 0.02 });
        },

        /** The crowd reacting: amount 0..1 (a combo ~0.3, a knockout 1). */
        cheer(amount) {
            crowdBoost = Math.max(crowdBoost, clamp(amount, 0, 1));
            const a = live();
            if (!a || amount < 0.6) return;
            // A roar has a bright top the murmur lacks: a short wide burst over it.
            noiseHit(a.ctx, a.out, { type: 'bandpass', freq: 1600, q: 0.5, dur: 1.6, gain: 0.08 * amount, attack: 0.25 });
        },

        /** A knockout: the music drops to a heartbeat for a moment, the crowd roars. */
        knockout() {
            musicHold = 2.4;
            music?.setIntensity(0);
            tension?.reset();
            api.cheer(1);
            const a = live();
            if (!a) return;
            for (let i = 0; i < 3; i++) {
                drop(a.ctx, a.out, { from: 70, to: 45, dur: 0.16, gain: 0.3, at: 0.25 + i * 0.75 });
                drop(a.ctx, a.out, { from: 62, to: 40, dur: 0.18, gain: 0.22, at: 0.47 + i * 0.75 });
            }
        },

        /**
         * Every step: drivers { fighting (bool), clock (0..1, 1 = time almost up), danger (0..1, the
         * lower health's loss), round (1..3) }. Starts the music and crowd on the first audible step.
         */
        update(dt, d) {
            if (disposed) return;
            crowdBoost = Math.max(0, crowdBoost - dt * 0.45);
            musicHold = Math.max(0, musicHold - dt);
            const a = live();
            if (!a) return;
            startCrowd(a.ctx, a.out);
            const t = a.ctx.currentTime;
            crowd.gain.gain.setTargetAtTime(crowdLevel + crowdBoost * 0.3 + (d.danger ?? 0) * 0.03, t, 0.12);
            for (const f of crowd.filters) f.frequency.setTargetAtTime(f.frequency.value < 800 ? 520 + crowdBoost * 200 : 1150 + crowdBoost * 500, t, 0.2);
            if (!music) {
                music = createMusicLayers({ root: 55, bpmLow: 96, bpmHigh: 146, gain: 0.8 });
                tension = createTensionMixer(music);
            }
            if (!d.fighting || musicHold > 0) {
                tension.update({ clock: 0, health: 1 }, dt);
                music.setGain(d.fighting ? 0.3 : 0.45);
            } else {
                tension.update({ clock: d.clock, health: 1 - (d.danger ?? 0), scoreDiff: d.round === 3 ? 0 : null }, dt);
                music.setGain(0.8);
            }
            music.start();
        },

        dispose() {
            disposed = true;
            music?.stop();
            music = null;
            if (crowd) {
                const ctx = AudioBus.hasContext() ? AudioBus.contextSync() : null;
                if (ctx) crowd.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
                const c = crowd;
                setTimeout(() => { for (const s of c.srcs) { try { s.stop(); } catch { /* already stopped */ } } c.gain.disconnect(); }, 700);
                crowd = null;
            }
            if (echo) { const e = echo; setTimeout(() => { for (const n of e.nodes) n.disconnect(); }, 3000); echo = null; }
        },
    };
    return api;
}
