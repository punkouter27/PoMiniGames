// PoCapitol's sound: every layer is synthesized here, nothing is downloaded or sampled.
//
// It plays through the platform's one AudioContext on its sfx bus (js/audioBus.js), so the
// app's mute, master volume and compressor all apply and nothing here owns a context.
//
// Layers, loudest first in a typical moment:
//   crowd bed   filtered noise that swells with how many people are pressing a line
//   friction    a second noise bed whose pitch and level follow how fast a packed crowd is
//               shearing past itself: shuffling is quiet, a surge is a hiss
//   chant       a choir of ten detuned throats through three formant bands, so the three beats
//               are vowels ("U! S! A!", "Stop the steal!") and not a tone; the back of the crowd
//               answers a beat late, and the same choir roars when a line gives way
//   air horn    hand-held horns somewhere in the crowd, outdoors
//   helicopter  one circling high over the grounds all afternoon: rotor chop under everything
//   sirens      a far wail from the avenues now and then
//   bullhorn    a garbled, band-limited voice from where the police actually are
//   alarm       a two-tone building alarm once the crowd is inside
//   radio       squelch-and-beep bursts from the nearest officer
//   impacts     modal synthesis: every blow is a handful of decaying resonances picked by the
//               material struck (body, baton, marble, metal, ground) and driven by the
//               collision's energy in joules and the mass of what was hit, so a hard shove
//               into a barricade rings and a bump in a crowd only thuds
//   footfalls   the nearest walkers, one at a time, each from its own position
//   one-shots   spray, gas, the flash-bang, a line giving way, and gunfire in the armed demo
//   doors       glass going at the first doors, an extinguisher let off in the doorway, fists and
//               boots on whichever door the crowd is held at
//   alert       the curfew alert, on every phone at once and none of them in time
//   footage     optional: the whole mix through a phone's microphone (wind buffeting the capsule,
//               a hard limiter that pumps after every bang, no low end)
//
// Space: every one-shot is placed in the world with an HRTF panner relative to the listener's
// position and heading, attenuated by distance, and muffled when walls stand between it and the
// listener. The reverb is built from the room the listener is in: its Sabine decay time from
// the room's volume, first reflections from the real distances to its walls, and outdoors a
// single slap-back from the building's facade at the right delay.
//
// Silent on kiosk routes, where the attract reel runs without anyone having asked for sound.
import { areas, groundHeight, CLOCK_START } from './world.js';

const quiet = () => /[?&]kiosk=/.test(location.search);
const SPEED_OF_SOUND = 343;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Surfaces: [frequency Hz, decay seconds, relative loudness] per resonant mode, the noise band of
 * the strike's initial click, and how hard each higher mode is driven by a hard blow.
 */
export const MATERIALS = {
    body: { modes: [[92, 0.08, 1], [168, 0.055, 0.55], [262, 0.035, 0.3]], click: 750, thud: 105 },
    baton: { modes: [[390, 0.11, 1], [1090, 0.075, 0.6], [2140, 0.05, 0.35], [3310, 0.03, 0.2]], click: 2800, thud: 0 },
    marble: { modes: [[1450, 0.45, 1], [2620, 0.32, 0.7], [3980, 0.22, 0.5], [5510, 0.15, 0.35]], click: 5200, thud: 0 },
    metal: { modes: [[640, 0.9, 1], [1450, 0.65, 0.8], [2250, 0.55, 0.6], [3720, 0.4, 0.4]], click: 6500, thud: 0 },
    ground: { modes: [[140, 0.05, 1], [310, 0.03, 0.4]], click: 480, thud: 80 },
    glass: { modes: [[2150, 0.09, 1], [3380, 0.07, 0.8], [4720, 0.05, 0.6], [6450, 0.04, 0.4]], click: 7200, thud: 0 },
    wood: { modes: [[112, 0.17, 1], [208, 0.11, 0.6], [345, 0.07, 0.3]], click: 900, thud: 72 },
};

/** The first three formants of the vowels a chanting crowd uses, Hz (adult averages). */
export const VOWELS = {
    ee: [270, 2290, 3010], eh: [530, 1840, 2480], ah: [730, 1090, 2440],
    oh: [570, 840, 2410], oo: [300, 870, 2240], uh: [640, 1190, 2390],
};

/**
 * Chants as beats: the vowel a beat opens on, the vowel it glides to, and whether it starts or
 * ends on a sibilant. Three beats and a rest each, as they were shouted.
 */
export const CHANTS = [
    [{ from: 'ee', to: 'oo' }, { from: 'eh', to: 'eh', hiss: 'end' }, { from: 'eh', to: 'ee' }],
    [{ from: 'ah', to: 'ah', hiss: 'start' }, { from: 'uh', to: 'uh' }, { from: 'ee', to: 'ee', hiss: 'start' }],
];

/**
 * Scenario minutes at which the city's 6 pm curfew, ordered that afternoon, reaches the phones in
 * the crowd. The order is history; the minute it is heard here is approximate.
 */
export const CURFEW_ALERT_ELAPSED = 14 * 60 + 31 - CLOCK_START;

/** Where the helicopter is `t` seconds in: a slow, slightly uneven circuit high over the lawn. */
export function helicopterAt(t) {
    const angle = t * (Math.PI * 2 / 85);
    return { x: Math.sin(angle) * 95, y: 110 + Math.sin(t * 0.07) * 15, z: 35 + Math.cos(angle) * 80 };
}

/** How hard the wind buffets a phone's microphone, 0..1, from wind speed (m/s) and the clock. */
export function micBuffet(windSpeed, t) {
    const gust = Math.max(0, Math.sin(t * 0.9) * Math.sin(t * 2.3 + 1));
    return clamp(windSpeed / 9, 0, 1) * (0.25 + 0.75 * gust);
}

/** Which room the point is in: an index into world.js `areas`, or 0 (the grounds) outside all. */
function areaIndex(x, z) {
    for (let i = areas.length - 1; i >= 1; i--) {
        const a = areas[i];
        if (Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2) return i;
    }
    return 0;
}

/**
 * What a foot lands on, from where it lands. It reads the same `groundHeight()` the renderer
 * uses, so a footfall cannot disagree with the surface under the feet: anything raised (the
 * portico, the terrace treads, the paved approach) is stone, and the lawn is turf.
 */
export function footstepMaterial(x, z) {
    if (z < 15) return 'marble';
    return groundHeight(x, z) >= 0.019 ? 'marble' : 'ground';
}

/** Air soaks up the highs: the further away a source is, the duller its low-pass cutoff. */
export function airAbsorption(distance) {
    return Math.max(2200, 18000 - Math.max(0, distance) * 190);
}

/**
 * How a blow is voiced. Energy wakes a bright crack; a heavy target adds a sub layer under the
 * material's own resonances, so a rammed barricade and a shoved person never sound alike even
 * when they cost the same joules.
 */
export function impactLayers(energy, mass) {
    const e = Math.max(0, energy), m = Math.max(20, mass);
    return {
        sub: m >= 120 ? Math.min(0.5, 0.16 + (m - 120) / 500) : 0,
        crack: e >= 150 ? Math.min(0.5, 0.2 + (e - 150) / 1200) : 0,
    };
}
/** Ceiling heights, meters: the crypt is low, the rotunda a dome, the statuary hall tall. */
const CEILING = [0, 9, 24, 4, 14, 5];

/**
 * An impulse response for the room around `listener`, built from its geometry. Indoors: the six
 * first-order reflections at their true path lengths over a decaying diffuse tail whose length is
 * Sabine's 0.161 V / (S a). Outdoors: a short ground bounce and the facade's slap-back.
 */
export function roomImpulse(listener, rate = 44100, random = Math.random) {
    const index = areaIndex(listener.x, listener.z);
    const length = Math.ceil(rate * (index === 0 ? 0.9 : 3.2));
    const taps = [];
    let rt = 0.25, tail = 0.18;
    if (index === 0) {
        const facade = Math.max(8, listener.z - 15);
        taps.push([0.006, 0.5], [2 * facade / SPEED_OF_SOUND, facade > 70 ? 0.07 : 0.2]);
        if (facade < 70) taps.push([2 * facade / SPEED_OF_SOUND + 0.07, 0.07]);
        tail = 0.04;
    } else {
        const room = areas[index], height = CEILING[index];
        const volume = room.w * room.d * height;
        const surface = 2 * (room.w * room.d + room.w * height + room.d * height);
        // Polished stone with people in it absorbs about 8% on each bounce.
        rt = clamp(0.161 * volume / (surface * 0.08), 0.3, 3);
        const walls = [listener.x - (room.x - room.w / 2), room.x + room.w / 2 - listener.x,
            listener.z - (room.z - room.d / 2), room.z + room.d / 2 - listener.z, height - 1.7, 1.7];
        for (const wall of walls) taps.push([2 * Math.max(0.5, wall) / SPEED_OF_SOUND, 0.45]);
    }
    const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: rate });
    for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        const start = Math.floor(rate * 0.012);
        for (let i = start; i < length; i++) {
            const t = i / rate;
            // The tail starts as the room fills and decays 60 dB over rt.
            data[i] = (random() * 2 - 1) * tail * Math.exp(-6.9 * t / rt) * Math.min(1, (i - start) / (rate * 0.02));
        }
        for (const [time, gain] of taps) {
            const at = Math.floor((time + ch * 0.0007) * rate);
            if (at < length) data[at] += gain * (ch ? -1 : 1) * 0.9;
        }
    }
    return { buffer, rt, index };
}

export function createAudio({ onCaption } = {}) {
    const caption = text => { try { onCaption?.(String(text)); } catch { /* captions are decoration */ } };
    const bus = window.PoAudioBus;
    let out = null;
    try { out = quiet() || !bus ? null : bus.busSync?.('sfx') ?? null; } catch { out = null; }
    if (!out) return { update() {}, event() {}, dispose() {}, setFootage() {}, caption };
    const ctx = out.context;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    // Two ways out: straight to the bus, or through a phone's microphone. Only one is open at a
    // time, cross-faded, so turning the footage sound on never clicks.
    const nodes = [];
    const dry = ctx.createGain(), mic = ctx.createGain();
    mic.gain.value = 0;
    const micTone = ctx.createBiquadFilter(), micPeak = ctx.createBiquadFilter(), micLimit = ctx.createDynamicsCompressor();
    micTone.type = 'highpass'; micTone.frequency.value = 190;
    micPeak.type = 'peaking'; micPeak.frequency.value = 2800; micPeak.Q.value = 0.8; micPeak.gain.value = 5;
    micLimit.threshold.value = -34; micLimit.knee.value = 4; micLimit.ratio.value = 14;
    micLimit.attack.value = 0.002; micLimit.release.value = 0.38;
    master.connect(dry).connect(out);
    master.connect(micTone).connect(micPeak).connect(micLimit).connect(mic).connect(out);
    nodes.push(dry, mic, micTone, micPeak, micLimit);
    let footage = false;

    // Reverb: two convolvers that cross-fade, so moving between rooms never clicks.
    const wetSend = ctx.createGain();
    wetSend.gain.value = 0;
    const slots = [0, 1].map(() => {
        const convolver = ctx.createConvolver(), level = ctx.createGain();
        level.gain.value = 0;
        wetSend.connect(convolver).connect(level).connect(out);
        return { convolver, level };
    });
    master.connect(wetSend);
    let activeSlot = -1, roomKey = '';
    function tuneRoom(listenerPoint) {
        const index = areaIndex(listenerPoint.x, listenerPoint.z);
        // Outdoors the slap-back delay moves with the listener, quantized so it rebuilds rarely.
        const key = index === 0 ? `0:${Math.round(listenerPoint.z / 10)}` : String(index);
        if (key === roomKey) return;
        roomKey = key;
        const { buffer } = roomImpulse(listenerPoint, ctx.sampleRate);
        const next = (activeSlot + 1) % 2;
        slots[next].convolver.buffer = buffer;
        const t = ctx.currentTime;
        slots[next].level.gain.cancelScheduledValues(t);
        slots[next].level.gain.setTargetAtTime(1, t, 0.12);
        if (activeSlot >= 0) {
            slots[activeSlot].level.gain.cancelScheduledValues(t);
            slots[activeSlot].level.gain.setTargetAtTime(0, t, 0.12);
        }
        activeSlot = next;
    }

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const running = [];
    function loop(type, frequency, q, dest = master) {
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        source.buffer = noise; source.loop = true;
        source.playbackRate.value = 0.8 + running.length * 0.13;
        filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
        gain.gain.value = 0;
        source.connect(filter).connect(gain).connect(dest);
        source.start();
        running.push(source);
        nodes.push(gain);
        return { gain, filter };
    }
    const murmur = loop('bandpass', 420, 0.5).gain;
    const roar = loop('bandpass', 1150, 0.9).gain;
    const friction = loop('bandpass', 900, 1.4);
    // Wind on the phone's capsule: it goes in after the microphone's own filter, because it is
    // the capsule moving, not a sound in the air.
    const buffet = loop('lowpass', 120, 0.7, micLimit).gain;
    // The crowd's voice: ten throats at unrelated pitches, each wandering a little, so together
    // they are a crowd and not a chord. Vowels are made after them, by the formant banks.
    const choir = ctx.createGain();
    choir.gain.value = 0.16;
    [97, 109, 118, 127, 139, 151, 166, 183, 204, 229].forEach((frequency, i) => {
        const voice = ctx.createOscillator(), drift = ctx.createOscillator(), depth = ctx.createGain();
        voice.type = 'sawtooth'; voice.frequency.value = frequency;
        drift.frequency.value = 3.1 + i * 0.37; depth.gain.value = 5 + (i % 3) * 4;
        drift.connect(depth).connect(voice.detune);
        voice.connect(choir);
        voice.start(); drift.start(); running.push(voice, drift);
    });
    /** Three band-passes at a vowel's formants over the choir. `shape` moves them to another vowel. */
    function formantBank() {
        const level = ctx.createGain();
        level.gain.value = 0;
        const bands = [[5, 1], [8, 0.55], [9, 0.22]].map(([q, gain], i) => {
            const band = ctx.createBiquadFilter(), share = ctx.createGain();
            band.type = 'bandpass'; band.Q.value = q; band.frequency.value = VOWELS.ah[i];
            share.gain.value = gain;
            choir.connect(band).connect(share).connect(level);
            return band;
        });
        nodes.push(level);
        return {
            level,
            shape(vowel, at, glide = 0.03) {
                (VOWELS[vowel] ?? VOWELS.ah).forEach((hz, i) => bands[i].frequency.setTargetAtTime(hz, at, glide));
            },
        };
    }
    // The chant up close, and the same chant from the back of the crowd: late, duller, quieter.
    const chant = formantBank(), cheer = formantBank();
    const echo = ctx.createDelay(0.5), echoTone = ctx.createBiquadFilter(), echoLevel = ctx.createGain();
    echo.delayTime.value = 0.23; echoTone.type = 'lowpass'; echoTone.frequency.value = 1400; echoLevel.gain.value = 0.5;
    chant.level.connect(master);
    chant.level.connect(echo).connect(echoTone).connect(echoLevel).connect(master);
    cheer.level.connect(master);
    nodes.push(choir, echo, echoLevel);
    // The helicopter: rotor wash chopped at the blade rate, placed high overhead and moved a
    // little every frame. It is there from the start and simply gets louder outdoors.
    const heli = ctx.createGain(), heliPan = ctx.createPanner(), chop = ctx.createGain();
    const blades = ctx.createOscillator(), bladeDepth = ctx.createGain();
    heli.gain.value = 0; chop.gain.value = 0.5;
    blades.type = 'sawtooth'; blades.frequency.value = 13; bladeDepth.gain.value = 0.5;
    blades.connect(bladeDepth).connect(chop.gain);
    blades.start(); running.push(blades);
    try { heliPan.panningModel = 'HRTF'; } catch { heliPan.panningModel = 'equalpower'; }
    heliPan.distanceModel = 'inverse'; heliPan.refDistance = 40; heliPan.rolloffFactor = 1; heliPan.maxDistance = 400;
    chop.connect(heli).connect(heliPan).connect(master);
    for (const [type, frequency, q, share] of [['lowpass', 420, 0.7, 1], ['bandpass', 900, 0.8, 0.35]]) {
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        source.buffer = noise; source.loop = true; source.playbackRate.value = 0.7 + share * 0.2;
        filter.type = type; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = share;
        source.connect(filter).connect(gain).connect(chop);
        source.start(); running.push(source);
    }
    nodes.push(heli, heliPan, chop);
    const alarm = ctx.createGain(), siren = ctx.createOscillator(), alarmTone = ctx.createBiquadFilter();
    alarm.gain.value = 0; siren.type = 'square'; siren.frequency.value = 880;
    alarmTone.type = 'lowpass'; alarmTone.frequency.value = 1700;
    siren.connect(alarmTone).connect(alarm).connect(master); siren.start(); running.push(siren);

    const ease = (param, value, seconds = 0.4) => param.setTargetAtTime(value, ctx.currentTime, seconds);
    const listener = { x: 0, z: 100, yaw: 0 };

    // A sound placed in the world. Returns the node a voice should connect to; the whole chain is
    // torn down after `life` seconds. Walls between the source and the listener muffle it, and
    // the wave takes time to arrive: at 343 m/s a shout from the far end of the hall lands about
    // a sixth of a second late, which is most of what makes a big room feel big.
    function place(x, z, life = 4, height = 1.3) {
        const panner = ctx.createPanner(), muffle = ctx.createBiquadFilter(), level = ctx.createGain();
        const flight = ctx.createDelay(0.5);
        try { panner.panningModel = 'HRTF'; } catch { panner.panningModel = 'equalpower'; }
        panner.distanceModel = 'inverse';
        panner.refDistance = 4; panner.rolloffFactor = 0.9; panner.maxDistance = 120;
        if (panner.positionX) {
            panner.positionX.value = x; panner.positionY.value = height; panner.positionZ.value = z;
        } else panner.setPosition(x, height, z);
        const walls = Math.abs(areaIndex(x, z) - areaIndex(listener.x, listener.z));
        // Sound gets out through a doorway far better than through a wall: the connecting aisle
        // is 9 m wide, so a source lined up with one is only partly screened.
        const doorway = walls === 1 && Math.abs(x) < 4.5 && Math.abs(listener.x) < 8;
        muffle.type = 'lowpass';
        const away = Math.hypot(x - listener.x, z - listener.z);
        // Stone between the pair dulls the sound far more than distance does; take the lower of
        // the wall cutoff and the air's own absorption at this range.
        muffle.frequency.value = Math.min(airAbsorption(away), walls === 0 ? 18000 : doorway ? 9000 : walls === 1 ? 3500 : 900);
        level.gain.value = walls === 0 ? 1 : doorway ? 0.9 : walls === 1 ? 0.75 : 0.4;
        flight.delayTime.value = Math.min(0.4, Math.hypot(x - listener.x, z - listener.z) / SPEED_OF_SOUND);
        muffle.connect(level).connect(flight).connect(panner).connect(master);
        setTimeout(() => {
            try { muffle.disconnect(); level.disconnect(); flight.disconnect(); panner.disconnect(); } catch { /* gone */ }
        }, life * 1000 + 100 + flight.delayTime.value * 1000);
        return muffle;
    }
    function aimListener() {
        const l = ctx.listener, t = ctx.currentTime, fx = -Math.sin(listener.yaw), fz = -Math.cos(listener.yaw);
        if (l.positionX) {
            l.positionX.setValueAtTime(listener.x, t); l.positionY.setValueAtTime(1.7, t); l.positionZ.setValueAtTime(listener.z, t);
            l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(0, t); l.forwardZ.setValueAtTime(fz, t);
            l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
        } else { l.setPosition(listener.x, 1.7, listener.z); l.setOrientation(fx, 0, fz, 0, 1, 0); }
    }
    function farAway(e) { return Math.hypot(e.x - listener.x, e.z - listener.z) > 70; }

    function burst({ type = 'bandpass', frequency = 1000, q = 1, volume = 0.2, attack = 0.005, seconds = 0.2, at = 0, sweep = null, dest = master }) {
        if (volume <= 0.0005) return;
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        const t = ctx.currentTime + at, dur = Math.max(0.02, seconds);
        source.buffer = noise; source.loop = true;
        filter.type = type; filter.frequency.setValueAtTime(Math.max(20, frequency), t); filter.Q.value = q;
        if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t + dur);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(volume, t + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        source.connect(filter).connect(gain).connect(dest);
        source.start(t, Math.random()); source.stop(t + dur + 0.05);
    }
    function tone({ type = 'sine', from = 440, to = from, volume = 0.2, seconds = 0.15, at = 0, dest = master }) {
        if (volume <= 0.0005) return;
        const voice = ctx.createOscillator(), gain = ctx.createGain();
        const t = ctx.currentTime + at, dur = Math.max(0.02, seconds);
        voice.type = type;
        voice.frequency.setValueAtTime(Math.max(20, from), t);
        voice.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        voice.connect(gain).connect(dest);
        voice.start(t); voice.stop(t + dur + 0.05);
    }

    /**
     * One physically driven strike. The material fixes which resonances ring and for how long; the
     * energy (joules) sets how hard they are driven and how many of the higher ones wake up; the
     * mass of the thing struck shifts every resonance down as it gets heavier.
     */
    function strike({ material = 'body', energy = 30, mass = 75, at = 0, dest = master, gain = 1 }) {
        const surface = MATERIALS[material] ?? MATERIALS.body;
        const drive = clamp(Math.sqrt(energy / 60), 0.06, 1.8) * gain;
        const size = Math.pow(75 / clamp(mass, 20, 400), 0.18);
        const t = ctx.currentTime + at;
        surface.modes.forEach(([frequency, decay, loudness], i) => {
            // A soft touch excites only the lowest modes; a hard one excites them all.
            const wake = clamp(drive * 1.5 - i * 0.28, 0, 1);
            if (wake <= 0.02) return;
            const voice = ctx.createOscillator(), env = ctx.createGain();
            voice.type = 'sine';
            voice.frequency.value = frequency * size * (1 + (Math.random() - 0.5) * 0.03);
            const seconds = Math.max(0.02, decay * (0.55 + 0.45 * Math.min(1, drive)));
            const peak = Math.max(0.0002, 0.26 * drive * loudness * wake / (1 + i * 0.25));
            env.gain.setValueAtTime(0.0001, t);
            env.gain.linearRampToValueAtTime(peak, t + 0.002);
            env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
            voice.connect(env).connect(dest);
            voice.start(t); voice.stop(t + seconds + 0.05);
        });
        // The contact click: brighter and longer the harder it lands.
        burst({ type: 'bandpass', frequency: surface.click * (0.7 + 0.5 * Math.min(1, drive)), q: 0.9, volume: 0.16 * drive, attack: 0.001, seconds: 0.012 + 0.03 * Math.min(1, drive), at, dest });
        if (surface.thud) tone({ from: surface.thud * size * 1.6, to: surface.thud * size * 0.5, volume: 0.3 * drive, seconds: 0.07 + 0.08 * Math.min(1, drive), at, dest });
        const layers = impactLayers(energy, mass);
        // A heavy target (a barrier, a body in gear) puts a low thump under the material.
        if (layers.sub > 0) tone({ from: 74 * size, to: 38 * size, volume: layers.sub * drive, seconds: 0.16 + 0.12 * Math.min(1, drive), at, dest });
        // A hard blow cracks before it rings.
        if (layers.crack > 0) burst({ type: 'highpass', frequency: 2600, q: 0.6, volume: layers.crack * drive, attack: 0.001, seconds: 0.03, at, dest });
    }

    /** The crowd's roar as a line goes: the choir on an open vowel, swelling and sagging. */
    function roarUp(volume, seconds = 3.2) {
        const t = ctx.currentTime;
        cheer.shape('ah', t, 0.05);
        cheer.shape('oh', t + seconds * 0.45, 0.6);
        cheer.level.gain.cancelScheduledValues(t);
        cheer.level.gain.setTargetAtTime(volume, t, 0.18);
        cheer.level.gain.setTargetAtTime(0, t + seconds * 0.4, seconds * 0.3);
    }
    /** A hand-held air horn: one harsh reed, a touch flat as it starts, cut off dead. */
    function airhorn(dest, seconds = 0.6, at = 0) {
        const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        const t = ctx.currentTime + at, pitch = 395 + Math.random() * 60;
        filter.type = 'bandpass'; filter.frequency.value = 1400; filter.Q.value = 0.7;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.085, t + 0.025);
        gain.gain.setValueAtTime(0.085, t + seconds);
        gain.gain.linearRampToValueAtTime(0, t + seconds + 0.07);
        for (const [type, ratio] of [['sawtooth', 1], ['square', 1.008]]) {
            const reed = ctx.createOscillator();
            reed.type = type;
            reed.frequency.setValueAtTime(pitch * ratio * 0.94, t);
            reed.frequency.linearRampToValueAtTime(pitch * ratio, t + 0.06);
            reed.connect(filter);
            reed.start(t); reed.stop(t + seconds + 0.1);
        }
        filter.connect(gain).connect(dest);
    }
    /** A siren on an avenue well off the grounds: two slow sweeps, already dull with distance. */
    function wail(dest, volume = 0.5) {
        const voice = ctx.createOscillator(), tone = ctx.createBiquadFilter(), gain = ctx.createGain();
        const t = ctx.currentTime;
        voice.type = 'triangle';
        voice.frequency.setValueAtTime(700, t);
        for (let i = 0; i < 4; i++) voice.frequency.linearRampToValueAtTime(i % 2 ? 700 : 1250, t + (i + 1) * 1.6);
        tone.type = 'lowpass'; tone.frequency.value = 1100;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 1.2);
        gain.gain.setValueAtTime(volume, t + 5);
        gain.gain.linearRampToValueAtTime(0, t + 6.4);
        voice.connect(tone).connect(gain).connect(dest);
        voice.start(t); voice.stop(t + 6.5);
    }
    /** A pane going: the crack, the sheet ringing as it breaks up, then the pieces landing. */
    function glass(dest, at = 0) {
        burst({ type: 'highpass', frequency: 4500, volume: 0.34, attack: 0.001, seconds: 0.08, at, dest });
        for (let i = 0; i < 5; i++) {
            strike({ material: 'glass', energy: 60 + Math.random() * 160, mass: 20 + Math.random() * 30, at: at + 0.02 + Math.random() * 0.45, dest, gain: 0.5 });
        }
        burst({ type: 'bandpass', frequency: 6200, q: 3, volume: 0.06, attack: 0.05, seconds: 0.6, at: at + 0.15, dest });
    }
    /** Fists and boots on a heavy door: three or four blows, never quite even. */
    function pound(dest) {
        const blows = 3 + (Math.random() < 0.4 ? 1 : 0);
        for (let i = 0; i < blows; i++) {
            strike({ material: 'wood', energy: 150 + Math.random() * 120, mass: 320, at: i * 0.21 + Math.random() * 0.05, dest });
        }
    }
    /** The attention signal of a wireless emergency alert: 853 and 960 Hz together, in bursts. */
    function alertTone(dest, at = 0) {
        const tone = ctx.createBiquadFilter(), gain = ctx.createGain(), t = ctx.currentTime + at;
        tone.type = 'highpass'; tone.frequency.value = 600;
        gain.gain.setValueAtTime(0, t);
        for (let i = 0; i < 4; i++) {
            gain.gain.setValueAtTime(0.06, t + i * 0.62);
            gain.gain.setValueAtTime(0, t + i * 0.62 + 0.5);
        }
        for (const frequency of [853, 960]) {
            const voice = ctx.createOscillator();
            voice.type = 'square'; voice.frequency.value = frequency;
            voice.connect(tone);
            voice.start(t); voice.stop(t + 2.6);
        }
        tone.connect(gain).connect(dest);
    }

    let lastShove = 0, lastShot = 0, lastHit = 0, chantAt = 0, alarmAt = 0, radioAt = 3, hornAt = 6, stepAt = 0, coughAt = 0, footAt = 0, clock = 0, walker = 0;
    let chantCount = 0, airhornAt = 9, wailAt = 20, poundAt = 0, alerted = false;

    function event(e) {
        if (!e.human && farAway(e)) return;
        const dest = place(e.x, e.z, e.type === 'gas' ? 3 : e.type === 'break' ? 4 : 2);
        const energy = e.energy ?? 30;
        const isIndoors = (e.z ?? listener.z) < 14.5;
        switch (e.type) {
            case 'shove':
                if (clock - lastShove < 0.09 && !e.human) return;
                lastShove = clock;
                strike({ material: 'body', energy, dest });
                burst({ type: 'lowpass', frequency: 1600, volume: 0.07, seconds: 0.14, attack: 0.03, dest });
                break;
            case 'impact':
                if (clock - lastHit < 0.03 && energy < 60) return;
                lastHit = clock;
                strike({ material: e.material ?? 'body', energy, mass: e.material === 'marble' ? 200 : 75, dest });
                if (e.round) tone({ from: 4200, to: 900, volume: 0.04, seconds: 0.18, at: 0.01, dest });
                break;
            case 'whiz':
                // Supersonic bullet crack followed by Doppler pitch drop past listener
                burst({ type: 'highpass', frequency: 4200, volume: 0.15, seconds: 0.03, dest });
                tone({ from: 4800, to: 920, volume: 0.09, seconds: 0.08, dest });
                break;
            case 'ricochet':
                // High-velocity metallic/stone deflection whine
                tone({ type: 'sawtooth', from: 2400, to: 3600, volume: 0.08, seconds: 0.14, dest });
                burst({ type: 'bandpass', frequency: 3800, q: 2.5, volume: 0.07, seconds: 0.07, dest });
                break;
            case 'armor_hit':
                // Dull kinetic thud into tactical Kevlar ballistic plate carrier
                strike({ material: 'body', energy: 110, mass: 95, dest });
                burst({ type: 'lowpass', frequency: 750, volume: 0.16, seconds: 0.06, dest });
                break;
            case 'gunshot':
                if (clock - lastShot < 0.06) return;
                lastShot = clock;
                burst({ type: 'highpass', frequency: 900, volume: 0.5, seconds: 0.09, dest });
                tone({ from: 180, to: 45, volume: 0.35, seconds: 0.12, dest });
                // Outdoor Capitol plaza facade slap-back reflection
                if (!isIndoors) strike({ material: 'marble', energy: 160, mass: 120, at: 0.07, gain: 0.32, dest });
                break;
            case 'baton':
                // The swing, then the blow on a body, then the stick itself ringing.
                burst({ type: 'bandpass', frequency: 2400, q: 1.5, volume: 0.06, attack: 0.04, seconds: 0.07, dest });
                strike({ material: 'body', energy: Math.max(energy, 40), at: 0.06, dest });
                strike({ material: 'baton', energy: Math.max(energy * 0.6, 25), at: 0.06, dest });
                break;
            case 'spray':
                burst({ type: 'highpass', frequency: 5200, volume: 0.16, attack: 0.03, seconds: 0.42, dest });
                break;
            case 'gas':
                tone({ from: 190, to: 60, volume: 0.3, seconds: 0.16, dest });
                burst({ type: 'bandpass', frequency: 3200, q: 0.7, volume: 0.15, attack: 0.2, seconds: 2.4, sweep: 900, dest });
                break;
            case 'flash':
                burst({ type: 'lowpass', frequency: 9000, volume: 0.75, seconds: 0.32, sweep: 300, dest });
                tone({ from: 70, to: 30, volume: 0.6, seconds: 0.5, dest });
                // The ringing afterwards, and everything else ducked under it.
                tone({ from: 3800, to: 3700, volume: 0.05, seconds: 1.6, at: 0.1, dest: master });
                Promise.resolve().then(() => bus.duck?.(0.5 * Math.min(1, 1 / (1 + Math.hypot(e.x - listener.x, e.z - listener.z) / 7)), 900)).catch(() => { /* a duck is a nicety */ });
                break;
            case 'openfire': {
                // The opening volley, then the crowd's roar under it.
                for (let i = 0; i < 5; i++) {
                    const at = place(e.x + (Math.random() - 0.5) * 14, e.z + (Math.random() - 0.5) * 4, 2);
                    burst({ type: 'highpass', frequency: 900, volume: 0.3, seconds: 0.09, at: i * 0.07, dest: at });
                    tone({ from: 180, to: 50, volume: 0.2, seconds: 0.1, at: i * 0.07, dest: at });
                }
                burst({ type: 'bandpass', frequency: 900, q: 0.7, volume: 0.16, attack: 0.3, seconds: 2.4, dest: master });
                break;
            }
            case 'smoke':
                // A long, dry hiss as the canister vents and the cloud builds.
                burst({ type: 'bandpass', frequency: 2400, q: 0.5, volume: 0.3, attack: 0.05, seconds: 1.8, sweep: 650, dest });
                tone({ from: 150, to: 60, volume: 0.22, seconds: 0.18, dest });
                break;
            case 'grenade':
                // Concussion, not fragmentation: a hard slap and a long, low pressure wave.
                burst({ type: 'lowpass', frequency: 320, volume: 0.9, attack: 0.002, seconds: 0.45, sweep: 70, dest });
                tone({ from: 92, to: 26, volume: 0.75, seconds: 0.7, dest });
                burst({ type: 'highpass', frequency: 3600, volume: 0.12, seconds: 0.05, dest });
                strike({ material: 'ground', energy: 320, mass: 260, at: 0.02, dest });
                // The ringing that follows a blast close by, and a duck under it.
                if (Math.hypot(e.x - listener.x, e.z - listener.z) < 22) {
                    tone({ from: 3700, to: 3600, volume: 0.04, seconds: 1.8, at: 0.12, dest: master });
                    Promise.resolve().then(() => bus.duck?.(0.6, 1100)).catch(() => { /* a duck is a nicety */ });
                }
                break;
            case 'break': {
                // Racks and barriers giving way: metal on metal, then stone, then the surge.
                for (let i = 0; i < 6; i++) {
                    const along = place(e.x + (Math.random() - 0.5) * 14, e.z + Math.random() * 2, 3);
                    strike({ material: 'metal', energy: 80 + Math.random() * 220, mass: 25, at: i * 0.07 + Math.random() * 0.04, dest: along });
                }
                strike({ material: 'marble', energy: 160, mass: 300, at: 0.2, dest });
                burst({ frequency: 900, q: 0.6, volume: 0.3, attack: 0.4, seconds: 3.2, dest });
                // A whole line going (not one shield) is what the crowd roars at. At a doorway
                // someone lets off an extinguisher; at the first doors the panes go as well.
                if (Number.isInteger(e.line)) {
                    roarUp(0.34);
                    if (e.line === 1) for (const x of [-12, 12]) glass(place(x, e.z, 3, 3), 0.15 + Math.random() * 0.5);
                    if (e.line >= 1) burst({ type: 'highpass', frequency: 2600, q: 0.4, volume: 0.26, attack: 0.04, seconds: 1.5, at: 0.9, sweep: 1700, dest });
                }
                dispatchCallout("Perimeter line breach! All units fall back!");
                break;
            }
            case 'milestone':
                tone({ type: 'triangle', from: 523, volume: 0.1, seconds: 0.18, dest: master });
                tone({ type: 'triangle', from: 784, volume: 0.1, seconds: 0.3, at: 0.14, dest: master });
                break;
            case 'down':
                strike({ material: 'ground', energy: 70, mass: 80, dest });
                tone({ from: 140, to: 60, volume: 0.07, seconds: 0.3, dest });
                break;
            case 'reinforce':
                radio(0.16, dest, true);
                break;
        }
    }

    const DISPATCH_CALLOUTS = [
        "Command, perimeter line taking heavy pressure.",
        "All units, hold the Crypt entrance. Defensive wedge.",
        "Line breach reported. Staggered fallback in effect.",
        "Deploying crowd dispersal fogger.",
        "Reinforcements en route to east corridor.",
        "Maintain shield formation, watch flanks."
    ];
    let lastDispatchAt = 0;

    function dispatchCallout(text = null) {
        if (typeof window === 'undefined') return;
        const now = performance.now();
        if (now - lastDispatchAt < 12000) return;
        lastDispatchAt = now;
        const msg = text || DISPATCH_CALLOUTS[Math.floor(Math.random() * DISPATCH_CALLOUTS.length)];
        caption(msg);
        if (quiet()) return;
        if (window.speechSynthesis && !window.speechSynthesis.speaking) {
            try {
                const utterance = new SpeechSynthesisUtterance(msg);
                utterance.rate = 1.15;
                utterance.pitch = 0.9;
                utterance.volume = Math.min(1, Math.max(0.2, (master.gain.value || 0.8) * 0.85));
                window.speechSynthesis.speak(utterance);
            } catch { /* graceful fallback */ }
        }
    }

    function radio(volume, dest = master, callout = false) {
        tone({ type: 'sine', from: 1350, to: 950, volume: volume * 0.8, seconds: 0.04, dest });
        burst({ frequency: 1900, q: 5, volume, attack: 0.01, seconds: 0.18, dest });
        for (let i = 0; i < 4; i++) {
            burst({ frequency: 1300 + Math.random() * 900, q: 7, volume: volume * 0.9, seconds: 0.11, at: 0.2 + i * 0.12, dest });
        }
        tone({ type: 'square', from: 1250, volume: volume * 0.35, seconds: 0.07, at: 0.72, dest });
        if (callout) dispatchCallout();
    }
    function bullhorn(volume, dest = master) {
        // Five syllables of a sliding sawtooth through a narrow band: speech-shaped, wordless.
        for (let i = 0; i < 5; i++) {
            const voice = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
            const t = ctx.currentTime + i * 0.27, pitch = 165 + Math.random() * 60;
            voice.type = 'sawtooth';
            voice.frequency.setValueAtTime(pitch, t);
            voice.frequency.linearRampToValueAtTime(pitch * (0.8 + Math.random() * 0.5), t + 0.2);
            filter.type = 'bandpass'; filter.frequency.value = 1100 + Math.random() * 500; filter.Q.value = 4;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(volume, t + 0.03);
            gain.gain.linearRampToValueAtTime(0, t + 0.22);
            voice.connect(filter).connect(gain).connect(dest);
            voice.start(t); voice.stop(t + 0.25);
        }
    }

    /**
     * Once a frame while the scenario runs. `mix` is what the listener is in the middle of:
     * `{ x, z, yaw, pressure (0..1), morale (0..1), police (0..1 nearness), shear (0..1),
     *    walkers: [{ x, z, mass }], horn: { x, z } | null, walking, gassed, active }`.
     */
    function update(mix, dt) {
        clock += dt;
        listener.x = mix.x; listener.z = mix.z; listener.yaw = mix.yaw ?? 0;
        aimListener();
        const indoors = mix.z < 14.5, live = mix.active && !bus.isMuted?.();
        ease(master.gain, live ? 0.9 : 0, 0.25);
        // Overhead all afternoon. Through the roof it is a faint thud; outdoors it is the floor
        // under every other sound.
        const overhead = helicopterAt(clock);
        if (heliPan.positionX) {
            heliPan.positionX.value = overhead.x; heliPan.positionY.value = overhead.y; heliPan.positionZ.value = overhead.z;
        } else heliPan.setPosition(overhead.x, overhead.y, overhead.z);
        ease(heli.gain, live ? (indoors ? 0.08 : 1.4) : 0, 0.8);
        ease(buffet.gain, live && footage && !indoors ? micBuffet(mix.wind ?? 6.7, clock) * 0.5 : 0, 0.08);
        tuneRoom(listener);
        ease(wetSend.gain, indoors ? 0.55 : 0.12);
        ease(murmur.gain, live ? 0.07 + mix.crowd * 0.1 : 0);
        ease(roar.gain, live ? mix.pressure * 0.2 : 0);
        // Shearing cloth, straps and shoes: a hiss that brightens and swells with relative speed.
        const shear = live ? clamp(mix.shear ?? 0, 0, 1) : 0;
        ease(friction.gain.gain, shear * shear * 0.11, 0.12);
        ease(friction.filter.frequency, 520 + shear * 2600, 0.12);
        if (!live) return;
        const t = ctx.currentTime;
        // Three beats and a rest, only while the crowd has its nerve. Four rounds of one chant,
        // then the other takes over.
        if (clock >= chantAt) {
            chantAt = clock + 1.75;
            if (mix.morale > 0.55 && mix.crowd > 0.25) {
                const level = 0.32 * mix.crowd * (indoors ? 0.7 : 1);
                const beats = CHANTS[Math.floor(chantCount++ / 4) % CHANTS.length];
                beats.forEach((beat, i) => {
                    const at = t + i * 0.42;
                    chant.shape(beat.from, at, 0.012);
                    if (beat.to !== beat.from) chant.shape(beat.to, at + 0.07, 0.05);
                    chant.level.gain.setTargetAtTime(level, at, 0.03);
                    chant.level.gain.setTargetAtTime(0, at + 0.24, 0.05);
                    if (beat.hiss) {
                        burst({ type: 'highpass', frequency: 5200, volume: level * 0.09, attack: 0.02, seconds: 0.11, at: i * 0.42 + (beat.hiss === 'end' ? 0.2 : 0) });
                    }
                });
            }
        }
        if (!indoors && clock >= airhornAt) {
            airhornAt = clock + 14 + Math.random() * 16;
            if (mix.crowd > 0.3 && mix.morale > 0.4) {
                // Somewhere back in the crowd, never right at the ear.
                const angle = Math.random() * Math.PI * 2, reach = 7 + Math.random() * 12;
                const dest = place(mix.x + Math.sin(angle) * reach, mix.z + Math.abs(Math.cos(angle)) * reach, 3, 2);
                airhorn(dest, 0.35 + Math.random() * 0.7);
                if (Math.random() < 0.4) airhorn(dest, 0.3, 1.1);
            }
        }
        if (!indoors && clock >= wailAt) {
            wailAt = clock + 28 + Math.random() * 30;
            wail(place(Math.random() < 0.5 ? -115 : 115, 40 + Math.random() * 50, 7, 1.5));
        }
        // Whichever door the crowd is held at takes a beating for as long as it is held.
        if (mix.door && clock >= poundAt) {
            poundAt = clock + 1.5 + Math.random() * 1.8;
            pound(place(mix.door.x + (Math.random() - 0.5) * 3, mix.door.z, 2, 1.4));
        }
        // The curfew alert: every phone near you, each a fraction of a second out from the next.
        const elapsed = mix.elapsed ?? 0;
        if (elapsed < CURFEW_ALERT_ELAPSED) alerted = false;
        else if (!alerted) {
            alerted = true;
            // Joining late (a restored or fast-forwarded attempt) does not replay it.
            if (elapsed < CURFEW_ALERT_ELAPSED + 5) {
                for (let i = 0; i < 4; i++) {
                    alertTone(place(mix.x + (Math.random() - 0.5) * 9, mix.z + (Math.random() - 0.5) * 9, 4, 1.2), i ? Math.random() * 0.7 : 0);
                }
                caption('Emergency alert: citywide curfew from 6:00 PM.');
            }
        }
        if (indoors && clock >= alarmAt) {
            alarmAt = clock + 1;
            siren.frequency.setValueAtTime(880, t); siren.frequency.setValueAtTime(660, t + 0.5);
        }
        ease(alarm.gain, indoors ? 0.018 : 0, 0.8);
        if (clock >= radioAt) {
            radioAt = clock + 5 + Math.random() * 7;
            if (mix.police > 0.15 && mix.horn) radio(0.1 * mix.police, place(mix.horn.x, mix.horn.z, 2, 1.4));
        }
        if (!indoors && clock >= hornAt) {
            hornAt = clock + 11 + Math.random() * 9;
            const at = mix.horn ?? { x: mix.x - Math.sin(mix.yaw ?? 0) * 18, z: mix.z - Math.cos(mix.yaw ?? 0) * 18 };
            bullhorn(0.05, place(at.x, at.z, 2, 2.2));
        }
        if (mix.walking && clock >= stepAt) {
            stepAt = clock + 0.36;
            strike({ material: footstepMaterial(mix.x, mix.z), energy: indoors ? 14 : 9, mass: 80, gain: 0.8 });
        }
        // The nearest walkers, one footfall at a time, each from where its feet are.
        const walkers = mix.walkers;
        if (walkers?.length && clock >= footAt) {
            footAt = clock + 0.07 + Math.random() * 0.12;
            const w = walkers[walker++ % walkers.length];
            strike({ material: footstepMaterial(w.x, w.z), energy: indoors ? 3 : 6, mass: w.mass ?? 75, gain: 0.7, dest: place(w.x, w.z, 1, 0.1) });
        }
        if (mix.gassed && clock >= coughAt) {
            coughAt = clock + 1.3 + Math.random();
            for (let i = 0; i < 2; i++) burst({ frequency: 650, q: 1.5, volume: 0.14, seconds: 0.12, at: i * 0.17 });
        }
    }

    function dispose() {
        for (const source of running) { try { source.stop(); } catch { /* already stopped */ } }
        try {
            for (const node of nodes) node.disconnect();
            master.disconnect(); wetSend.disconnect();
            for (const slot of slots) { slot.convolver.disconnect(); slot.level.disconnect(); }
        } catch { /* already disconnected */ }
        // Leave the listener where the rest of the app expects it: the origin, looking down -Z.
        listener.x = 0; listener.z = 0; listener.yaw = 0; aimListener();
    }
    /** Routes the whole mix through a phone's microphone (or back out of it). */
    function setFootage(on) {
        footage = on === true;
        ease(dry.gain, footage ? 0 : 1, 0.15);
        ease(mic.gain, footage ? 1.5 : 0, 0.15);
    }
    return { update, event, dispose, setFootage };
}
