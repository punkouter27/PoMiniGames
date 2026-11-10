// PoCapitol's sound: every layer is synthesized here, nothing is downloaded or sampled.
//
// It plays through the platform's one AudioContext on its sfx bus (js/audioBus.js), so the
// app's mute, master volume and compressor all apply and nothing here owns a context.
//
// Layers, loudest first in a typical moment:
//   crowd bed   filtered noise that swells with how many people are pressing a line
//   chant       a three-beat rhythm on a rough vowel, when the crowd is confident
//   bullhorn    a garbled, band-limited voice outdoors, every so often
//   alarm       a two-tone building alarm once the crowd is inside
//   radio       squelch-and-beep bursts when police are close
//   one-shots   shoves, batons, spray, gas, the flash-bang, a line giving way, and gunfire
//               in the armed spectator demo
// Indoors, everything also feeds a feedback delay: marble halls ring, the lawn does not.
//
// Silent on kiosk routes, where the attract reel runs without anyone having asked for sound.

const quiet = () => /[?&]kiosk=/.test(location.search);

export function createAudio() {
    const bus = window.PoAudioBus;
    let out = null;
    try { out = quiet() || !bus ? null : bus.busSync?.('sfx') ?? null; } catch { out = null; }
    if (!out) return { update() {}, event() {}, dispose() {} };
    const ctx = out.context;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(out);
    const echo = ctx.createDelay(0.5), echoFeedback = ctx.createGain(), echoSend = ctx.createGain();
    echo.delayTime.value = 0.19; echoFeedback.gain.value = 0.42; echoSend.gain.value = 0;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass'; echoTone.frequency.value = 2200;
    master.connect(echoSend).connect(echo).connect(echoTone).connect(echoFeedback).connect(echo);
    echoTone.connect(out);

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
        return gain;
    }
    const murmur = loop('bandpass', 420, 0.5);
    const roar = loop('bandpass', 1150, 0.9);
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
    function burst({ type = 'bandpass', frequency = 1000, q = 1, volume = 0.2, attack = 0.005, seconds = 0.2, at = 0, sweep = null }) {
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        const t = ctx.currentTime + at;
        source.buffer = noise; source.loop = true;
        filter.type = type; filter.frequency.setValueAtTime(frequency, t); filter.Q.value = q;
        if (sweep) filter.frequency.exponentialRampToValueAtTime(sweep, t + seconds);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
        source.connect(filter).connect(gain).connect(master);
        source.start(t, Math.random()); source.stop(t + seconds + 0.05);
    }
    function tone({ type = 'sine', from = 440, to = from, volume = 0.2, seconds = 0.15, at = 0 }) {
        const voice = ctx.createOscillator(), gain = ctx.createGain();
        const t = ctx.currentTime + at;
        voice.type = type;
        voice.frequency.setValueAtTime(from, t);
        voice.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + seconds);
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
        voice.connect(gain).connect(master);
        voice.start(t); voice.stop(t + seconds + 0.05);
    }
    // Nearer is louder; anything past 45 m is part of the bed, not a sound of its own.
    const listener = { x: 0, z: 100 };
    const near = e => {
        const distance = Math.hypot(e.x - listener.x, e.z - listener.z);
        return distance > 45 ? 0 : 1 / (1 + distance / 7);
    };
    let lastShove = 0, lastShot = 0, chantAt = 0, alarmAt = 0, radioAt = 3, hornAt = 6, stepAt = 0, coughAt = 0, clock = 0;

    function event(e) {
        const level = e.human ? 1 : near(e);
        if (level <= 0.02) return;
        switch (e.type) {
            case 'shove':
                if (clock - lastShove < 0.09 && !e.human) return;
                lastShove = clock;
                tone({ from: 95, to: 48, volume: 0.22 * level, seconds: 0.13 });
                burst({ type: 'lowpass', frequency: 700, volume: 0.1 * level, seconds: 0.08 });
                break;
            case 'gunshot':
                if (clock - lastShot < 0.06) return;
                lastShot = clock;
                burst({ type: 'highpass', frequency: 900, volume: 0.5 * level, seconds: 0.09 });
                tone({ from: 180, to: 45, volume: 0.35 * level, seconds: 0.12 });
                break;
            case 'baton':
                burst({ type: 'highpass', frequency: 1800, volume: 0.2 * level, seconds: 0.05 });
                tone({ from: 150, to: 70, volume: 0.2 * level, seconds: 0.1 });
                break;
            case 'spray':
                burst({ type: 'highpass', frequency: 5200, volume: 0.16 * level, attack: 0.03, seconds: 0.42 });
                break;
            case 'gas':
                tone({ from: 190, to: 60, volume: 0.3 * level, seconds: 0.16 });
                burst({ type: 'bandpass', frequency: 3200, q: 0.7, volume: 0.15 * level, attack: 0.2, seconds: 2.4, sweep: 900 });
                break;
            case 'flash':
                burst({ type: 'lowpass', frequency: 9000, volume: 0.75 * level, seconds: 0.32, sweep: 300 });
                tone({ from: 70, to: 30, volume: 0.6 * level, seconds: 0.5 });
                // The ringing afterwards, and everything else ducked under it.
                tone({ from: 3800, to: 3700, volume: 0.05 * level, seconds: 1.6, at: 0.1 });
                Promise.resolve().then(() => bus.duck?.(0.5 * level, 900)).catch(() => { /* a duck is a nicety */ });
                break;
            case 'break':
                for (let i = 0; i < 7; i++) {
                    burst({ frequency: 1700 + i * 380, q: 9, volume: 0.2 * level, seconds: 0.2, at: i * 0.07 + Math.random() * 0.03 });
                }
                burst({ frequency: 900, q: 0.6, volume: 0.3 * level, attack: 0.4, seconds: 3.2 });
                break;
            case 'milestone':
                tone({ type: 'triangle', from: 523, volume: 0.1, seconds: 0.18 });
                tone({ type: 'triangle', from: 784, volume: 0.1, seconds: 0.3, at: 0.14 });
                break;
            case 'down':
                tone({ from: 140, to: 60, volume: 0.1 * level, seconds: 0.3 });
                break;
            case 'reinforce':
                radio(0.16 * Math.max(0.3, level));
                break;
        }
    }
    function radio(volume) {
        burst({ frequency: 1900, q: 5, volume, attack: 0.01, seconds: 0.22 });
        for (let i = 0; i < 4; i++) {
            burst({ frequency: 1300 + Math.random() * 900, q: 7, volume: volume * 0.9, seconds: 0.11, at: 0.24 + i * 0.13 });
        }
        tone({ type: 'square', from: 1250, volume: volume * 0.35, seconds: 0.07, at: 0.8 });
    }
    function bullhorn(volume) {
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
            voice.connect(filter).connect(gain).connect(master);
            voice.start(t); voice.stop(t + 0.25);
        }
    }

    /**
     * Once a frame while the scenario runs. `mix` is what the listener is in the middle of:
     * `{ x, z, pressure (0..1), morale (0..1), police (0..1 nearness), walking, gassed, active }`.
     */
    function update(mix, dt) {
        clock += dt;
        listener.x = mix.x; listener.z = mix.z;
        const indoors = mix.z < 14.5, live = mix.active && !bus.isMuted?.();
        ease(master.gain, live ? 0.9 : 0, 0.25);
        ease(echoSend.gain, indoors ? 0.5 : 0.04);
        ease(murmur.gain, live ? 0.07 + mix.crowd * 0.1 : 0);
        ease(roar.gain, live ? mix.pressure * 0.2 : 0);
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
            if (mix.police > 0.15) radio(0.1 * mix.police);
        }
        if (!indoors && clock >= hornAt) {
            hornAt = clock + 11 + Math.random() * 9;
            bullhorn(0.05);
        }
        if (mix.walking && clock >= stepAt) {
            stepAt = clock + 0.36;
            burst({ type: 'lowpass', frequency: indoors ? 900 : 420, volume: 0.05, seconds: 0.06 });
        }
        if (mix.gassed && clock >= coughAt) {
            coughAt = clock + 1.3 + Math.random();
            for (let i = 0; i < 2; i++) burst({ frequency: 650, q: 1.5, volume: 0.14, seconds: 0.12, at: i * 0.17 });
        }
    }

    function dispose() {
        for (const source of running) { try { source.stop(); } catch { /* already stopped */ } }
        try { master.disconnect(); echoTone.disconnect(); } catch { /* already disconnected */ }
    }
    return { update, event, dispose };
}
