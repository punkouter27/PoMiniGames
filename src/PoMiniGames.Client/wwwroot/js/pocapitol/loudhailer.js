// The police loudhailer: a few spoken orders, heard from the officer nearest the listener.
//
// Everything else in PoCapitol's sound is synthesized (audio.js). These lines are recordings:
// voiced once, offline, by scripts/pocapitol/voices.mjs (Kokoro-82M through Transformers.js and
// ONNX Runtime, on the developer's machine), band-limited and driven like a megaphone by ffmpeg,
// and shipped as small MP3s with a manifest. Nothing is generated while the game runs.
//
// They are played through Howler (with its spatial plugin), loaded from the CDN the first time a
// line is due: each line is a 3D source at the officer's position with an HRTF panner, so an
// order shouted from the line to your left is heard from the left and from as far away as it is.
// Howler keeps its own AudioContext; the app's mute and volume are copied onto it every update,
// so the master mute still silences it.
//
// LINES is plain data so the voicing script can import this file in node.
import { isMuted, getVolume, getBusVolume } from '../platform/audioBus.js';

/** The orders, by cue. The voices are stock Kokoro voices and imitate nobody. */
export const LINES = {
    disperse: { text: 'This is the police. This is an unlawful assembly. Leave the area now.', voice: 'am_michael' },
    back: { text: 'Move back! Move back now!', voice: 'am_onyx' },
    chemical: { text: 'Chemical munitions will be used if you do not disperse.', voice: 'am_michael' },
    gas: { text: 'Gas! Gas! Masks on!', voice: 'am_onyx' },
    hold: { text: 'Hold the line! Shields up!', voice: 'am_fenrir' },
    fallback: { text: 'Fall back! Fall back to the doors!', voice: 'am_fenrir' },
    shelter: { text: 'Members and staff, shelter in place. Stay away from the doors.', voice: 'af_bella' },
    evacuate: { text: 'Evacuate the chamber. Move to the exits now.', voice: 'af_bella' },
    curfew: { text: 'A curfew is now in effect. Leave the grounds.', voice: 'am_michael' },
};

const HOWLER_URL = 'https://cdn.jsdelivr.net/npm/howler@2.2.4/dist/howler.min.js';
const MANIFEST_URL = 'audio/pocapitol/hailer.json';
/** No order within this many seconds of the last, so the loudhailer never talks over itself. */
const GAP = 6;

/**
 * @param onCaption  (text) => void: every line is captioned, spoken or not
 */
export function createLoudhailer({ onCaption } = {}) {
    let Howler = null, Howl = null, manifest = null, loading = null, disposed = false;
    const sounds = new Map();
    let lastAt = -Infinity, nagAt = 40, said = new Set(), horn = null, enabled = true;

    function begin() {
        loading ??= (async () => {
            try {
                const [{ loadLibrary }, response] = await Promise.all([
                    import('../platform/engineLoader.js'),
                    fetch(MANIFEST_URL),
                ]);
                manifest = response.ok ? await response.json() : null;
                if (!manifest) return;
                await loadLibrary(HOWLER_URL);
                if (disposed) return;
                ({ Howler, Howl } = window);
            } catch (error) {
                console.warn('[PoCapitol] loudhailer unavailable; orders are captioned only.', error);
            }
        })();
        return loading;
    }

    function sound(cue) {
        const file = manifest?.lines?.[cue];
        if (!Howl || !file) return null;
        let howl = sounds.get(cue);
        if (!howl) {
            howl = new Howl({ src: [`audio/pocapitol/${file}`], html5: false, preload: true });
            sounds.set(cue, howl);
        }
        return howl;
    }

    /** Say one line now, from where the nearest officer stands, if nothing was said just before. */
    function say(cue, elapsed, { once = false } = {}) {
        if (!enabled || elapsed - lastAt < GAP) return;
        if (once && said.has(cue)) return;
        said.add(cue); lastAt = elapsed;
        const line = LINES[cue];
        onCaption?.(line.text);
        begin().then(() => {
            const howl = sound(cue);
            if (!howl || disposed) return;
            const id = howl.play();
            const at = horn ?? { x: 0, z: 0 };
            howl.pos(at.x, 2.2, at.z, id);
            howl.pannerAttr({ panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 7, rolloffFactor: 0.9, maxDistance: 160 }, id);
        });
    }

    return {
        /** A world.js event: the ones the police would answer out loud. */
        event(event, state) {
            const t = state.elapsed;
            switch (event.type) {
                case 'gas': say('gas', t); break;
                case 'break': if (event.line !== undefined) say(state.milestone >= 3 ? 'fallback' : 'hold', t); break;
                case 'milestone': say('hold', t); break;
                case 'evacuation': say(state.milestone >= 4 ? 'evacuate' : 'shelter', t, { once: true }); break;
                default: break;
            }
        },
        /**
         * Every frame, with the listener and the mix audio.js gets: who is nearest, how hard the
         * line is being pressed, and the scenario clock.
         */
        update({ x, z, yaw, horn: nearest, pressure = 0, elapsed = 0, active = false, curfew = Infinity }) {
            horn = nearest;
            if (active) {
                if (elapsed > 10) say('disperse', elapsed, { once: true });
                if (elapsed > curfew) say('curfew', elapsed, { once: true });
                // While the line is being leaned on, an order every half-minute or so.
                if (pressure > 0.35 && elapsed > nagAt) { nagAt = elapsed + 28 + Math.random() * 20; say(Math.random() < 0.6 ? 'back' : 'chemical', elapsed); }
            }
            if (!Howler) return;
            Howler.mute(isMuted());
            Howler.volume(getVolume() * getBusVolume('sfx'));
            Howler.pos(x, 1.6, z);
            // Howler's listener faces -z at yaw 0, as the game camera does.
            Howler.orientation(-Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0);
        },
        /** Off: no orders at all (the synthesized horn in audio.js stays). */
        setEnabled(value) { enabled = Boolean(value); if (enabled) begin(); },
        /** A new attempt: every once-only order can be given again. */
        reset() { said = new Set(); lastAt = -Infinity; nagAt = 40; },
        dispose() {
            disposed = true;
            for (const howl of sounds.values()) howl.unload();
            sounds.clear();
        },
    };
}
