// PoRacer's continuous sound and the one-shot cues that depend on what a car is doing.
//
// Nothing here owns an AudioContext, a mute or a volume: voices feed the shared sfx bus
// (window.PoAudioBus), so the app's own mute and level apply and stop() only has to disconnect
// what it made. It must never close the shared context.
//
//   • engine  — the car the camera follows: two detuned saws through a soft clipper, a lowpass
//     and an exhaust formant, pitched by a virtual six-speed gearbox (the sim has none), with a
//     shift transient and overrun pops. Louder and brighter under power.
//   • rivals  — the nearest other cars, one voice each, placed with a real HRTF panner and the
//     listener turned to face the player's heading, so a pass goes round your head. Pitch is
//     still shifted by closing speed (the Web Audio velocity attributes are deprecated).
//   • beds    — tyre scrub (band-passed noise, driven by the slip angle) and wind (low-passed
//     noise, driven by speed). Continuous, not cues: a drift is a sound, not an event.
//   • events  — crash, skid, sand, turbo and pass cues, read off consecutive server snapshots
//     at 20 Hz. The voices live in gameCues.js. Each also rumbles a gamepad.
//   • music   — musicLayers.js on the shared music bus.
import { rumble } from './input.js';
import { createMusicLayers } from '../platform/musicLayers.js';
import { createTensionMixer } from '../platform/tensionMixer.js';
import { createContactVoice } from '../platform/contactLoop.js';

const GEAR_TOP = [70, 130, 195, 265, 345];   // sim units/s at the top of each gear
const HEAR = 620;
const AUDIO_UNITS = 1 / 45;                  // sim units per audio unit
// platform/contactLoop.js voices: the player's tyres (roll + skid squeal) and the loudest sliding
// rival, placed in the world. Slip speed (m/s of the contact patch) = sin(slip angle) · speed in
// audio units · SLIP_MS; SLIP_MS makes a full-lock drift at top speed land near the squeal's knee.
const SLIP_MS = 3;
let tyreMe = null, tyreRival = null;

let ctx = null, engine = null, rivals = [], beds = null, noiseBuffer = null;
let gear = 0, lastV = 0, lastThrottle = 0;
const last = { skid: 0, pass: 0, turbo: 0, crash: 0 };
let litWas = 0;
let music = null, tension = null, totalLaps = 3;
let rivalCount = 3;

const tierOf = () => {
    try { return document.documentElement.getAttribute('data-gfx') || 'high'; }
    catch { return 'high'; }
};
const rivalBudget = () => (tierOf() === 'low' ? 2 : tierOf() === 'medium' ? 4 : 5);

const cue = (name, opts) => { try { window.PoCue?.fire('poracer', name, opts); } catch { /* audio is never fatal */ } };

/** Park the shared listener at the player's car, facing the way it points. */
function placeListener(me) {
    if (!ctx || !me) return;
    const l = ctx.listener;
    const cx = Math.cos(me.h), sy = Math.sin(me.h);
    try {
        if (l.forwardX) {
            l.forwardX.value = cx; l.forwardY.value = 0; l.forwardZ.value = -sy;
            l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
            l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0;
        } else if (l.setOrientation) {
            l.setOrientation(cx, 0, -sy, 0, 1, 0);
            l.setPosition(0, 0, 0);
        }
    } catch { /* older listener API: the default orientation still pans */ }
}

function noise(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    const len = Math.max(1, Math.floor(ctx.sampleRate * 1.2));
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    noiseBuffer = b;
    return b;
}

/** One car's voice. HRTF where the engine has it, a plain panner where it does not. */
function voice(pan) {
    const out = window.PoAudioBus.busSync('sfx');
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600;
    const gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(filter); filter.connect(gain);
    let panner = null;
    if (pan) {
        try {
            panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 1.4;
            panner.maxDistance = 16;
            panner.rolloffFactor = 1.1;
            gain.connect(panner); panner.connect(out);
        } catch {
            panner = null;
        }
        if (!panner && ctx.createStereoPanner) {
            panner = ctx.createStereoPanner();
            gain.connect(panner); panner.connect(out);
        }
    }
    if (!panner) gain.connect(out);
    osc.start();
    return { osc, filter, gain, panner, out, extra: [] };
}

/** A looping noise source through a filter and a gain — the beds. */
function bed(filterType, freq, q) {
    const out = window.PoAudioBus.busSync('sfx');
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx); src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType; filter.frequency.value = freq; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter); filter.connect(gain); gain.connect(out);
    src.start();
    return { src, filter, gain, out };
}

/**
 * Build the voices. Safe to call repeatedly and before a user gesture (the context just stays
 * suspended). `laps` is the race length, which scales the music's build.
 */
export function start(laps) {
    stop();
    totalLaps = laps > 0 ? laps : 3;
    music = createMusicLayers({ root: 49, bpmLow: 108, bpmHigh: 152 });
    tension = createTensionMixer(music);
    ctx = window.PoAudioBus?.contextSync?.() || null;
    if (!ctx || !window.PoAudioBus.busSync('sfx')) { ctx = null; return; }
    engine = voice(false);
    // The second saw an octave down, a few cents off, is what makes one oscillator an engine;
    // the third is a fifth above at a whisper, the exhaust's first harmonic.
    const sub = ctx.createOscillator(); sub.type = 'sawtooth'; sub.detune.value = -1207;
    sub.connect(engine.filter); sub.start();
    const bright = ctx.createOscillator(); bright.type = 'square'; bright.detune.value = 702;
    const brightGain = ctx.createGain(); brightGain.gain.value = 0.16;
    bright.connect(brightGain); brightGain.connect(engine.filter); bright.start();
    engine.extra.push(sub, bright);
    engine.bright = brightGain;
    // A soft clipper gives the saws the harmonics a real engine has and a bare saw does not.
    try {
        const shaper = ctx.createWaveShaper();
        const n = 1024, curve = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.2) * 0.9; }
        shaper.curve = curve;
        engine.filter.disconnect();
        engine.filter.connect(shaper);
        shaper.connect(engine.gain);
        engine.shaper = shaper;
    } catch { /* no WaveShaper: the raw saws still work */ }
    // The exhaust formant: a broad peak that opens with revs.
    try {
        const peak = ctx.createBiquadFilter();
        peak.type = 'peaking'; peak.frequency.value = 900; peak.Q.value = 1.1; peak.gain.value = 7;
        engine.gain.disconnect();
        engine.gain.connect(peak);
        peak.connect(engine.out);
        engine.peak = peak;
    } catch { /* optional */ }

    rivalCount = rivalBudget();
    rivals = Array.from({ length: rivalCount }, () => voice(true));

    // Beds: tyre scrub and wind. Both are filtered noise, both fade to nothing at rest.
    try {
        beds = { scrub: bed('bandpass', 1750, 2.2), wind: bed('lowpass', 620, 0.7) };
        beds.scrub.gain.gain.value = 0;
        beds.wind.gain.gain.value = 0;
    } catch { beds = null; }

    // Continuous tyre contact (worklet): road roar + skid squeal. Until its module loads
    // (or where worklets don't exist) update() is a no-op and the scrub bed above carries the sound.
    try {
        tyreMe = createContactVoice('tyre', { radius: 0.33, gain: 0.8 });
        tyreRival = createContactVoice('tyre', { spatial: true, radius: 0.33, refDistance: 6, gain: 0.7 });
    } catch { tyreMe = null; tyreRival = null; }

    gear = 0; lastV = 0; lastThrottle = 0; litWas = 0;
}

export function stop() {
    music?.stop(); music = null; tension = null;
    for (const v of [engine, ...rivals]) {
        if (!v) continue;
        for (const node of [v.osc, ...v.extra]) { try { node.stop(); node.disconnect(); } catch { /* already stopped */ } }
        for (const node of [v.filter, v.gain, v.panner, v.shaper, v.peak, v.bright]) { try { node?.disconnect(); } catch { /* not connected */ } }
    }
    if (beds) {
        for (const b of [beds.scrub, beds.wind]) {
            try { b.src.stop(); } catch { /* already stopped */ }
            for (const node of [b.src, b.filter, b.gain]) { try { node.disconnect(); } catch { /* not connected */ } }
        }
    }
    try { tyreMe?.stop(); tyreRival?.stop(); } catch { /* best effort */ }
    tyreMe = null; tyreRival = null;
    engine = null; rivals = []; beds = null; ctx = null;
}

/** Speed → engine note, with a gearbox's hysteresis. */
function note(v) {
    const speed = Math.abs(v);
    let next = 0;
    while (next < GEAR_TOP.length - 1 && speed > GEAR_TOP[next]) next++;
    while (next > 0 && speed < GEAR_TOP[next - 1] * 0.82) next--;
    const lo = next === 0 ? 0 : GEAR_TOP[next - 1] * 0.62;
    const rev = Math.max(0, Math.min(1, (speed - lo) / (GEAR_TOP[next] - lo)));
    return { gear: next, hz: 52 + rev * 118, rev };
}

/** A short filtered click plus a gain dip: a gear change you can hear. */
function shiftTransient(t) {
    if (!ctx || !engine) return;
    try {
        const src = ctx.createBufferSource(); src.buffer = noise(ctx);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 3.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.09, t);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
        src.connect(bp).connect(g).connect(window.PoAudioBus.busSync('sfx'));
        src.start(t); src.stop(t + 0.08);
    } catch { /* a click is never worth throwing for */ }
}

/**
 * Per rendered frame. `cars` are the interpolated cars, `me` the one the camera follows
 * (the local car, or the leader when spectating), `quiet` halves it for a demo.
 */
export function frame(cars, me, quiet) {
    if (!ctx || !engine || !me) return;
    const t = ctx.currentTime;
    const throttle = me.v > lastV + 0.05 ? 1 : 0.35;   // accelerating vs. coasting or braking
    const lifted = lastThrottle > 0.8 && throttle < 0.5;
    lastV = me.v; lastThrottle = throttle;

    const n = note(me.v);
    if (n.gear !== gear) {
        if (n.gear > gear) shiftTransient(t);
        else engine.filter.frequency.setTargetAtTime(300, t, 0.05);
        gear = n.gear;
    }
    const f = n.hz;
    engine.osc.frequency.setTargetAtTime(f, t, 0.03);
    engine.extra[0].frequency.setTargetAtTime(f, t, 0.03);
    engine.extra[1]?.frequency.setTargetAtTime(f * 1.5, t, 0.03);
    if (engine.bright) engine.bright.gain.setTargetAtTime(0.08 + n.rev * 0.22, t, 0.08);
    // Brighter and louder under power, and the filter opens as the revs climb.
    engine.filter.frequency.setTargetAtTime(360 + f * (3.6 + throttle * 7) + n.rev * 500, t, 0.06);
    engine.gain.gain.setTargetAtTime((quiet ? 0.03 : 0.065) * (0.55 + throttle * 0.45), t, 0.08);
    if (engine.peak) engine.peak.frequency.setTargetAtTime(760 + n.rev * 520, t, 0.1);

    // Overrun: lift off at high revs and the exhaust pops.
    if (lifted && n.rev > 0.6 && Math.random() < 0.5) cue('turbo', { gain: 0.25, pitch: 0.7 });

    placeListener(me);

    const near = [];
    for (const car of cars) {
        if (car === me) continue;
        const dx = car.x - me.x, dy = car.y - me.y, distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= HEAR * HEAR) continue;
        const entry = { c: car, d: Math.sqrt(distanceSquared) };
        let i = near.length;
        while (i > 0 && near[i - 1].d > entry.d) i--;
        if (i >= rivalCount) continue;
        near.splice(i, 0, entry);
        if (near.length > rivalCount) near.pop();
    }
    for (let i = 0; i < rivals.length; i++) {
        const r = rivals[i], close = near[i];
        if (!close) { r.gain.gain.setTargetAtTime(0, t, 0.12); continue; }
        const dx = close.c.x - me.x, dy = close.c.y - me.y, d = Math.max(1, close.d);
        // Closing speed along the line between the two cars: positive = approaching = pitched up.
        const closing = ((Math.cos(me.h) * me.v - Math.cos(close.c.h) * close.c.v) * dx
            + (Math.sin(me.h) * me.v - Math.sin(close.c.h) * close.c.v) * dy) / d;
        const doppler = 1 + Math.max(-0.2, Math.min(0.2, closing / 1500));
        r.osc.frequency.setTargetAtTime((58 + Math.abs(close.c.v) * 0.34) * doppler, t, 0.05);
        const k = 1 - d / HEAR;
        r.gain.gain.setTargetAtTime((quiet ? 0.02 : 0.05) * k * k, t, 0.08);
        // HRTF takes a position; a plain panner takes a pan. Both get the same cone of space.
        try {
            if (r.panner?.positionX) {
                r.panner.positionX.setTargetAtTime(dx * AUDIO_UNITS, t, 0.05);
                r.panner.positionZ.setTargetAtTime(-dy * AUDIO_UNITS, t, 0.05);
                r.panner.positionY.setTargetAtTime(0, t, 0.05);
            } else if (r.panner?.pan) {
                r.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, dx / 420)), t, 0.08);
            }
        } catch { /* a panner bug must not silence the field */ }
    }

    if (tyreMe) {
        const v = Math.abs(me.v) * AUDIO_UNITS;
        tyreMe.update({ rollSpeed: Math.min(9, v * 1.2), slipSpeed: Math.abs(Math.sin(me.slip || 0)) * v * SLIP_MS, load: quiet ? 0.5 : 1 });
        // The rival that is sliding the hardest, placed relative to the listener (which sits at the origin).
        let best = null, bestS = 0.3;
        for (let i = 0; i < cars.length; i++) {
            const c = cars[i];
            if (c === me) continue;
            const dx = c.x - me.x, dy = c.y - me.y;
            if (dx * dx + dy * dy > 260 * 260) continue;
            const sp = Math.abs(Math.sin(c.slip || 0)) * Math.abs(c.v) * AUDIO_UNITS * SLIP_MS;
            if (sp > bestS) { bestS = sp; best = { c, dx, dy }; }
        }
        if (best) tyreRival.update({ rollSpeed: Math.min(9, Math.abs(best.c.v) * AUDIO_UNITS * 1.2), slipSpeed: bestS, load: 1,
            position: { x: best.dx * AUDIO_UNITS, y: 0, z: -best.dy * AUDIO_UNITS } });
        else tyreRival.update({ rollSpeed: 0, slipSpeed: 0, load: 0 });
    }

    // Tyre scrub: the loudest slip on the frame, not just the player's. A car sliding past is
    // the sound that makes a pass feel close.
    if (beds) {
        let slip = Math.abs(me.slip || 0);
        for (let i = 0; i < cars.length; i++) {
            const c = cars[i];
            if (c === me) continue;
            const dx = c.x - me.x, dy = c.y - me.y, d2 = dx * dx + dy * dy;
            if (d2 > 260 * 260) continue;
            slip = Math.max(slip, Math.abs(c.slip || 0) * (1 - Math.sqrt(d2) / 260));
        }
        // The worklet tyre voices take over the scrub once they are sounding; the bed stays as the fallback.
        const scrub = Math.min(1, Math.max(0, (slip - 0.1) * 2.4)) * (tyreMe?.active ? 0.25 : 1);
        beds.scrub.gain.gain.setTargetAtTime(scrub * 0.075, t, 0.06);
        beds.scrub.filter.frequency.setTargetAtTime(1500 + scrub * 1600, t, 0.08);
        const speed = Math.min(1, Math.abs(me.v) / 345);
        beds.wind.gain.gain.setTargetAtTime(speed * speed * 0.05, t, 0.15);
        beds.wind.filter.frequency.setTargetAtTime(420 + speed * 900, t, 0.15);
    }
}

/**
 * Per server snapshot (20 Hz). `prev` / `cur` are consecutive car arrays in roster order;
 * `me` is the local car's index (-1 when spectating: no cues, the engine bed is enough).
 */
export function events(prev, cur, me) {
    tune(cur, me);
    const a = prev?.[me], b = cur?.[me];
    if (!a || !b) return;
    const now = performance.now();

    const hit = b.damage - a.damage;
    if (hit >= 0.025 && now - last.crash > 250) {
        last.crash = now;
        const s = Math.min(1, hit / 0.1);
        cue('crash', { gain: 0.45 + s * 0.55, scale: 0.4 + s * 0.6 });
        rumble(0.4 + s * 0.6);
    }
    if (b.sand && !a.sand) { cue('sandDrift'); rumble(0.3); }
    if (b.skid >= 0.6 && a.skid < 0.6 && Math.abs(b.v) > 110 && now - last.skid > 700) {
        last.skid = now;
        cue('skid', { gain: 0.8 });
        rumble(0.2);
    }
    // A boost starting: a pad, or a drift let go with enough charge.
    if (b.boostT > 0 && !(a.boostT > 0)) { cue('boostPad', { gain: 0.8 }); rumble(0.35); }
    // The sim raises the glow once the car is flat out near top speed: the turbo coming on song.
    if (b.boost >= 0.6 && a.boost < 0.6 && !(b.boostT > 0) && now - last.turbo > 5000) { last.turbo = now; cue('turbo'); }

    // A pass: a rival alongside (within 70 units) that was closing and is now pulling away,
    // placed across the player's own axis so the whoosh arrives on the side it happened.
    for (let i = 0; i < cur.length; i++) {
        if (i === me || !prev[i]) continue;
        const d1 = Math.hypot(cur[i].x - b.x, cur[i].y - b.y), d0 = Math.hypot(prev[i].x - a.x, prev[i].y - a.y);
        if (d1 < 70 && d1 > d0 && Math.abs(cur[i].v - b.v) > 35 && now - last.pass > 1500) {
            last.pass = now;
            const lateral = (cur[i].x - b.x) * Math.sin(b.h) - (cur[i].y - b.y) * Math.cos(b.h);
            cue('dopplerPass', {
                pan: Math.max(-1, Math.min(1, lateral / 70)),
                pitch: cur[i].v > b.v ? 1.15 : 0.9,
                gain: 0.9,
            });
        }
    }
}

/**
 * Music from the race state of the followed car (the leader when spectating), through the
 * platform tension mixer (deck #15): the lap is the clock, the place the position, the nearest
 * rival the proximity. Stems swell in and thin out as those move; the last lap is the clock
 * at full. Laps run 1..laps; past that the car is home and the mix settles.
 */
const PROXIMITY_NEAR = 60;     // sim units: a rival this close is right on you
const PROXIMITY_FAR = 260;     // and from here on, no pressure at all
function tune(cur, me) {
    if (!music || !cur?.length) return;
    const car = cur[me] || cur.reduce((x, c) => (c.position < x.position ? c : x), cur[0]);
    if (car.finished || car.lap > totalLaps) { tension?.update({}); music.setIntensity(0); return; }
    const lap = Math.max(1, car.lap);
    const byLap = totalLaps > 1 ? (lap - 1) / (totalLaps - 1) : 0.5;
    let nearest = Infinity;
    for (const c of cur) if (c !== car) nearest = Math.min(nearest, Math.hypot(c.x - car.x, c.y - car.y));
    tension?.update({
        clock: lap === totalLaps ? 1 : byLap * 0.7,
        position: cur.length > 1 ? (car.position - 1) / (cur.length - 1) : 0,
        proximity: Math.max(0, Math.min(1, (PROXIMITY_FAR - nearest) / (PROXIMITY_FAR - PROXIMITY_NEAR))),
    });
    music.setGain(me < 0 ? 0.5 : 1);
    music.start();
}

/** Start lights: one beep per lamp as it comes on. `lit` is 0-5. */
export function lights(lit) {
    if (lit > litWas) cue('light');
    litWas = lit;
}
