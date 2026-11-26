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
import { context as getAudioContext, bus as getAudioBus, isMuted, duck } from '../platform/audioBus.js';

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

const MANIFEST_URL = 'audio/pocapitol/hailer.json';
/** No order within this many seconds of the last, so the loudhailer never talks over itself. */
const GAP = 6;

/**
 * Unified on audioBus.js's single AudioContext + HRTF PannerNode (replaces Howler's second context
 * so master mute, sfx volume, ducking, and the mastering compressor all apply uniformly).
 * @param onCaption  (text) => void: every line is captioned, spoken or not
 */
export function createLoudhailer({ onCaption } = {}) {
    let manifest = null, loading = null, disposed = false, audioCtx = null;
    const buffers = new Map();
    const activeSources = new Set();
    let lastAt = -Infinity, nagAt = 40, said = new Set(), horn = null, enabled = true;

    function begin() {
        loading ??= (async () => {
            try {
                const [ctx, response] = await Promise.all([getAudioContext(), fetch(MANIFEST_URL)]);
                audioCtx = ctx;
                manifest = response.ok ? await response.json() : null;
            } catch (error) {
                console.warn('[PoCapitol] loudhailer unavailable; orders are captioned only.', error);
            }
        })();
        return loading;
    }

    async function loadBuffer(cue) {
        const file = manifest?.lines?.[cue];
        if (!audioCtx || !file) return null;
        if (buffers.has(cue)) return buffers.get(cue);
        const res = await fetch(`audio/pocapitol/${file}`);
        if (!res.ok) return null;
        const decoded = await audioCtx.decodeAudioData(await res.arrayBuffer());
        buffers.set(cue, decoded);
        return decoded;
    }

    /** Say one line now, from where the nearest officer stands, if nothing was said just before. */
    function say(cue, elapsed, { once = false } = {}) {
        if (!enabled || elapsed - lastAt < GAP) return;
        if (once && said.has(cue)) return;
        said.add(cue); lastAt = elapsed;
        const line = LINES[cue];
        onCaption?.(line.text);
        if (isMuted()) return;
        begin().then(async () => {
            const buf = await loadBuffer(cue);
            const sfxBus = getAudioBus('sfx');
            if (!buf || !audioCtx || !sfxBus || disposed) return;
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            const panner = audioCtx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 7;
            panner.rolloffFactor = 0.9;
            panner.maxDistance = 160;
            const at = horn ?? { x: 0, z: 0 };
            panner.positionX.value = at.x;
            panner.positionY.value = 2.2;
            panner.positionZ.value = at.z;
            src.connect(panner).connect(sfxBus);
            activeSources.add(src);
            src.onended = () => activeSources.delete(src);
            duck?.(0.35, Math.min(4, buf.duration));
            src.start();
        }).catch(() => { /* captioned fallback */ });
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
                if (pressure > 0.35 && elapsed > nagAt) { nagAt = elapsed + 28 + Math.random() * 20; say(Math.random() < 0.6 ? 'back' : 'chemical', elapsed); }
            }
            const listener = audioCtx?.listener;
            if (!listener) return;
            if (listener.positionX) {
                listener.positionX.value = x; listener.positionY.value = 1.6; listener.positionZ.value = z;
                listener.forwardX.value = -Math.sin(yaw); listener.forwardY.value = 0; listener.forwardZ.value = -Math.cos(yaw);
                listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
            }
        },
        /** Off: no orders at all (the synthesized horn in audio.js stays). */
        setEnabled(value) { enabled = Boolean(value); if (enabled) begin(); },
        /** A new attempt: every once-only order can be given again. */
        reset() { said = new Set(); lastAt = -Infinity; nagAt = 40; },
        dispose() {
            disposed = true;
            for (const src of activeSources) { try { src.stop(); } catch { /* ok */ } }
            activeSources.clear();
            buffers.clear();
        },
    };
}
