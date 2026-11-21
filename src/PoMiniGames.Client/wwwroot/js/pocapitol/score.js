// An adaptive score under the afternoon, written with Tone.js.
//
// audio.js is the sound of the place: crowd, friction, footfalls, blasts. This is the music a
// film of it would carry, and it follows the same two clocks the picture does. The scenario
// clock (12:50 pm to 6:00 pm) sets the harmony and the colour: open fifths in the early
// afternoon, the minor progression from the first breach, low brass once the light goes. The
// pressure on the police line sets the energy: the tempo, how far the pad's filter is open, a
// drum cadence that comes in as the line is leaned on and turns into a snare roll when it is
// about to break. When the shooting starts in the demo, everything but the drone stops.
//
// Tone is a UMD build loaded from the CDN the first time the score is wanted. It is given the
// app's one AudioContext (js/platform/audioBus.js) and plays into the app's music bus, so the
// music slider, mute and ducking all apply; if Tone cannot share the context, it keeps its own
// and copies the app's mute and music level onto its output instead.
import { context, bus, isMuted, getVolume, getBusVolume } from '../platform/audioBus.js';

const TONE_URL = 'https://cdn.jsdelivr.net/npm/tone@15.1.22/build/Tone.js';

/** The progression by stage of the afternoon: one chord a bar, looped. */
const HARMONY = {
    calm: [['D3', 'A3', 'E4'], ['Bb2', 'F3', 'C4'], ['F3', 'C4', 'G4'], ['C3', 'G3', 'D4']],
    breach: [['D3', 'F3', 'A3', 'E4'], ['Bb2', 'D3', 'F3', 'A3'], ['G2', 'Bb2', 'D3', 'F3'], ['A2', 'C#3', 'E3', 'G3']],
    dusk: [['D2', 'A2', 'F3', 'C4'], ['Eb2', 'Bb2', 'G3', 'D4'], ['C2', 'G2', 'Eb3', 'Bb3'], ['A1', 'E2', 'C#3', 'G3']],
};
const ARP = { calm: ['A4', 'E4', 'D4', 'E4'], breach: ['D5', 'A4', 'F4', 'E4', 'F4', 'A4'], dusk: ['F4', 'E4', 'D4', 'C#4'] };

export function createScore() {
    let T = null, loading = null, disposed = false, enabled = false, shared = false;
    let out = null, pad = null, padFilter = null, arp = null, drum = null, snare = null, brass = null, verb = null;
    let stage = 'calm', bar = 0, step = 0, tension = 0, silenced = false;
    const level = { pad: 0, arp: 0, drum: 0, roll: 0, brass: 0 };

    function begin() {
        loading ??= (async () => {
            try {
                const { loadLibrary } = await import('../platform/engineLoader.js');
                await loadLibrary(TONE_URL);
                if (disposed) return;
                T = window.Tone;
                const ctx = await context();
                const musicBus = await bus('music');
                if (ctx && musicBus) {
                    try { T.setContext(ctx); shared = true; } catch { shared = false; }
                }
                build(shared ? musicBus : null);
            } catch (error) {
                console.warn('[PoCapitol] score unavailable.', error);
                T = null;
            }
        })();
        return loading;
    }

    function build(musicBus) {
        out = new T.Gain(T.dbToGain(-15));
        if (musicBus) {
            try { T.connect(out, musicBus); } catch { out.toDestination(); shared = false; }
        } else out.toDestination();
        verb = new T.Reverb({ decay: 6, wet: 0.35 }).connect(out);
        padFilter = new T.Filter({ type: 'lowpass', frequency: 500, Q: 0.6 }).connect(verb);
        pad = new T.PolySynth(T.Synth, {
            oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
            envelope: { attack: 2.5, decay: 1, sustain: 0.8, release: 4 },
        }).connect(padFilter);
        pad.volume.value = -14;
        arp = new T.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.6 } })
            .connect(new T.FeedbackDelay({ delayTime: '8n.', feedback: 0.3, wet: 0.25 }).connect(verb));
        arp.volume.value = -60;
        drum = new T.MembraneSynth({ pitchDecay: 0.04, octaves: 3, envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.4 } }).connect(verb);
        drum.volume.value = -60;
        snare = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.09, sustain: 0 } })
            .connect(new T.Filter({ type: 'bandpass', frequency: 2200, Q: 0.8 }).connect(verb));
        snare.volume.value = -60;
        brass = new T.PolySynth(T.Synth, { oscillator: { type: 'square8' }, envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 } })
            .connect(new T.Filter({ type: 'lowpass', frequency: 700 }).connect(verb));
        brass.volume.value = -60;

        T.getTransport().bpm.value = 66;
        // One chord a bar for the pad (and the brass once it is dusk); the drums and the arpeggio
        // on a sixteenth grid, each only as loud as the moment asks for.
        T.getTransport().scheduleRepeat(time => {
            const chords = HARMONY[stage];
            const chord = chords[bar % chords.length];
            pad.triggerAttackRelease(chord, '1m', time);
            if (level.brass > 0.05) brass.triggerAttackRelease(chord.slice(0, 2), '2n', time);
            bar++;
        }, '1m');
        T.getTransport().scheduleRepeat(time => {
            const s = step++ % 16;
            if (silenced) return;
            const notes = ARP[stage];
            if (level.arp > 0.05 && s % 2 === 0) arp.triggerAttackRelease(notes[(s / 2) % notes.length], '16n', time);
            // A march cadence: the downbeats, and the "and" of four as the pressure rises.
            if (level.drum > 0.05 && (s === 0 || s === 8 || (tension > 0.6 && (s === 6 || s === 14)))) drum.triggerAttackRelease(s === 0 ? 'D1' : 'A1', '8n', time);
            if (level.roll > 0.05) snare.triggerAttackRelease('32n', time);
            else if (level.drum > 0.3 && (s === 4 || s === 12)) snare.triggerAttackRelease('16n', time);
        }, '16n');
    }

    const db = x => (x <= 0.001 ? -60 : T.gainToDb(x));

    return {
        setEnabled(value) {
            enabled = Boolean(value);
            if (enabled) begin().then(() => { if (T && enabled && !disposed) T.getTransport().start(); });
            else if (T) T.getTransport().pause();
        },
        /**
         * Every frame with the sound mix index.js already builds (pressure, police, crowd) and
         * the scenario state.
         */
        update({ pressure = 0, police = 0, crowd = 0, elapsed = 0, milestone = 0, active = false, openfire = false }, dt) {
            if (!T || !out) return;
            const target = active ? Math.min(1, Math.max(pressure, police * 0.6) + crowd * 0.15) : 0.1;
            tension += (target - tension) * Math.min(1, dt * 0.6);
            silenced = openfire;
            stage = elapsed > 250 ? 'dusk' : milestone >= 2 ? 'breach' : 'calm';
            level.pad = active ? 1 : 0.6;
            level.arp = silenced ? 0 : Math.max(0, Math.min(1, (tension - 0.25) * 2)) * (stage === 'calm' ? 0.6 : 1);
            level.drum = silenced ? 0 : Math.max(0, Math.min(1, (tension - 0.3) * 2.2));
            level.roll = silenced ? 0 : tension > 0.85 ? 1 : 0;
            level.brass = silenced ? 0 : stage === 'dusk' ? 0.7 : 0;
            const ramp = 1.5;
            arp.volume.rampTo(level.arp ? -22 + db(level.arp) : -60, ramp);
            drum.volume.rampTo(level.drum ? -12 + db(level.drum) : -60, ramp);
            snare.volume.rampTo(level.roll || level.drum > 0.3 ? -26 : -60, 0.5);
            brass.volume.rampTo(level.brass ? -24 : -60, 4);
            padFilter.frequency.rampTo(380 + tension * 2600, 2);
            T.getTransport().bpm.rampTo(64 + tension * 30, 4);
            // With its own context the app's mute and music level are copied on here.
            if (!shared) {
                const gain = isMuted() ? 0 : getVolume() * getBusVolume('music');
                T.getDestination().volume.rampTo(db(gain), 0.2);
            }
        },
        reset() { bar = 0; step = 0; tension = 0; },
        dispose() {
            disposed = true;
            if (!T) return;
            T.getTransport().stop();
            T.getTransport().cancel();
            for (const node of [pad, arp, drum, snare, brass, padFilter, verb, out]) node?.dispose();
        },
    };
}
