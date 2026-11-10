// PoCapitol's sound: every layer is synthesized here, nothing is downloaded or sampled.
//
// It plays through the platform's one AudioContext on its sfx bus (js/audioBus.js), so the
// app's mute, master volume and compressor all apply and nothing here owns a context.
//
// Layers, loudest first in a typical moment:
//   crowd bed   filtered noise that swells with how many people are pressing a line
//   friction    a second noise bed whose pitch and level follow how fast a packed crowd is
//               shearing past itself: shuffling is quiet, a surge is a hiss
//   chant       a three-beat rhythm on a rough vowel, when the crowd is confident
//   bullhorn    a garbled, band-limited voice from where the police actually are
//   alarm       a two-tone building alarm once the crowd is inside
//   radio       squelch-and-beep bursts from the nearest officer
//   impacts     modal synthesis: every blow is a handful of decaying resonances picked by the
//               material struck (body, baton, marble, metal, ground) and driven by the
//               collision's energy in joules and the mass of what was hit, so a hard shove
//               into a barricade rings and a bump in a crowd only thuds
//   footfalls   the nearest walkers, one at a time, each from its own position
//   one-shots   spray, gas, the flash-bang, a line giving way, and gunfire in the armed demo
//
// Space: every one-shot is placed in the world with an HRTF panner relative to the listener's
// position and heading, attenuated by distance, and muffled when walls stand between it and the
// listener. The reverb is built from the room the listener is in: its Sabine decay time from
// the room's volume, first reflections from the real distances to its walls, and outdoors a
// single slap-back from the building's facade at the right delay.
//
// Silent on kiosk routes, where the attract reel runs without anyone having asked for sound.
import { areas } from './world.js';

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
};

/** Which room the point is in: an index into world.js `areas`, or 0 (the grounds) outside all. */
function areaIndex(x, z) {
    for (let i = areas.length - 1; i >= 1; i--) {
        const a = areas[i];
        if (Math.abs(x - a.x) <= a.w / 2 && Math.abs(z - a.z) <= a.d / 2) return i;
    }
    return 0;
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

export function createAudio() {
    const bus = window.PoAudioBus;
    let out = null;
    try { out = quiet() || !bus ? null : bus.busSync?.('sfx') ?? null; } catch { out = null; }
    if (!out) return { update() {}, event() {}, dispose() {} };
    const ctx = out.context;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(out);

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
    function loop(type, frequency, q) {
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        source.buffer = noise; source.loop = true;
        source.playbackRate.value = 0.8 + running.length * 0.13;
        filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
        gain.gain.value = 0;
        source.connect(filter).connect(gain).connect(master);
        source.start();
        running.push(source);
        return { gain, filter };
    }
    const murmur = loop('bandpass', 420, 0.5).gain;
    const roar = loop('bandpass', 1150, 0.9).gain;
    const friction = loop('bandpass', 900, 1.4);
    // The chant's voice: three detuned saws through a vowel-ish band, gated by a rhythm.
    const chant = ctx.createGain(), vowel = ctx.createBiquadFilter();
    chant.gain.value = 0;
    vowel.type = 'bandpass'; vowel.frequency.value = 720; vowel.Q.value = 2.2;
    for (const frequency of [118, 149, 177, 236]) {
        const voice = ctx.createOscillator();
        voice.type = 'sawtooth'; voice.frequency.value = frequency;
        voice.detune.value = (frequency % 7 - 3) * 9;
        voice.connect(vowel); voice.start(); running.push(voice);
    }
    vowel.connect(chant).connect(master);
    const alarm = ctx.createGain(), siren = ctx.createOscillator(), alarmTone = ctx.createBiquadFilter();
    alarm.gain.value = 0; siren.type = 'square'; siren.frequency.value = 880;
    alarmTone.type = 'lowpass'; alarmTone.frequency.value = 1700;
    siren.connect(alarmTone).connect(alarm).connect(master); siren.start(); running.push(siren);

    const ease = (param, value, seconds = 0.4) => param.setTargetAtTime(value, ctx.currentTime, seconds);
    const listener = { x: 0, z: 100, yaw: 0 };

    // A sound placed in the world. Returns the node a voice should connect to; the whole chain is
    // torn down after `life` seconds. Walls between the source and the listener muffle it.
    function place(x, z, life = 4, height = 1.3) {
        const panner = ctx.createPanner(), muffle = ctx.createBiquadFilter(), level = ctx.createGain();
        panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
        panner.refDistance = 4; panner.rolloffFactor = 0.9; panner.maxDistance = 120;
        if (panner.positionX) {
            panner.positionX.value = x; panner.positionY.value = height; panner.positionZ.value = z;
        } else panner.setPosition(x, height, z);
        const walls = Math.abs(areaIndex(x, z) - areaIndex(listener.x, listener.z));
        muffle.type = 'lowpass';
        muffle.frequency.value = walls === 0 ? 18000 : walls === 1 ? 3500 : 900;
        level.gain.value = walls === 0 ? 1 : walls === 1 ? 0.75 : 0.4;
        muffle.connect(level).connect(panner).connect(master);
        setTimeout(() => { try { muffle.disconnect(); level.disconnect(); panner.disconnect(); } catch { /* gone */ } }, life * 1000 + 100);
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
    }

    let lastShove = 0, lastShot = 0, lastHit = 0, chantAt = 0, alarmAt = 0, radioAt = 3, hornAt = 6, stepAt = 0, coughAt = 0, footAt = 0, clock = 0, walker = 0;

    function event(e) {
        if (!e.human && farAway(e)) return;
        const dest = place(e.x, e.z, e.type === 'gas' ? 3 : e.type === 'break' ? 4 : 2);
        const energy = e.energy ?? 30;
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
            case 'gunshot':
                if (clock - lastShot < 0.06) return;
                lastShot = clock;
                burst({ type: 'highpass', frequency: 900, volume: 0.5, seconds: 0.09, dest });
                tone({ from: 180, to: 45, volume: 0.35, seconds: 0.12, dest });
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
            case 'break': {
                // Racks and barriers giving way: metal on metal, then stone, then the surge.
                for (let i = 0; i < 6; i++) {
                    const along = place(e.x + (Math.random() - 0.5) * 14, e.z + Math.random() * 2, 3);
                    strike({ material: 'metal', energy: 80 + Math.random() * 220, mass: 25, at: i * 0.07 + Math.random() * 0.04, dest: along });
                }
                strike({ material: 'marble', energy: 160, mass: 300, at: 0.2, dest });
                burst({ frequency: 900, q: 0.6, volume: 0.3, attack: 0.4, seconds: 3.2, dest });
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
                radio(0.16, dest);
                break;
        }
    }
    function radio(volume, dest = master) {
        burst({ frequency: 1900, q: 5, volume, attack: 0.01, seconds: 0.22, dest });
        for (let i = 0; i < 4; i++) {
            burst({ frequency: 1300 + Math.random() * 900, q: 7, volume: volume * 0.9, seconds: 0.11, at: 0.24 + i * 0.13, dest });
        }
        tone({ type: 'square', from: 1250, volume: volume * 0.35, seconds: 0.07, at: 0.8, dest });
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
        // "U! S! A!": three beats and a rest, only while the crowd has its nerve.
        if (clock >= chantAt) {
            chantAt = clock + 1.75;
            if (mix.morale > 0.55 && mix.crowd > 0.25) {
                const level = 0.05 * mix.crowd * (indoors ? 0.7 : 1);
                for (let beat = 0; beat < 3; beat++) {
                    chant.gain.setTargetAtTime(level, t + beat * 0.42, 0.03);
                    chant.gain.setTargetAtTime(0, t + beat * 0.42 + 0.24, 0.05);
                    vowel.frequency.setValueAtTime([560, 900, 760][beat], t + beat * 0.42);
                }
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
            strike({ material: 'ground', energy: indoors ? 14 : 9, mass: 80, gain: 0.8 });
        }
        // The nearest walkers, one footfall at a time, each from where its feet are.
        const walkers = mix.walkers;
        if (walkers?.length && clock >= footAt) {
            footAt = clock + 0.07 + Math.random() * 0.12;
            const w = walkers[walker++ % walkers.length];
            strike({ material: indoors ? 'marble' : 'ground', energy: indoors ? 3 : 6, mass: w.mass ?? 75, gain: 0.7, to: place(w.x, w.z, 1, 0.1) });
        }
        if (mix.gassed && clock >= coughAt) {
            coughAt = clock + 1.3 + Math.random();
            for (let i = 0; i < 2; i++) burst({ frequency: 650, q: 1.5, volume: 0.14, seconds: 0.12, at: i * 0.17 });
        }
    }

    function dispose() {
        for (const source of running) { try { source.stop(); } catch { /* already stopped */ } }
        try {
            master.disconnect(); wetSend.disconnect();
            for (const slot of slots) { slot.convolver.disconnect(); slot.level.disconnect(); }
        } catch { /* already disconnected */ }
        // Leave the listener where the rest of the app expects it: the origin, looking down -Z.
        listener.x = 0; listener.z = 0; listener.yaw = 0; aimListener();
    }
    return { update, event, dispose };
}
