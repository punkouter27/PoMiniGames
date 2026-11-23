// pofighter/voice.js — each fighter's voice: 5 moods × 5 intensities, a real recording when one
// exists and a procedural stand-in when it does not (the shared platform/emotionVoice.js).
//
//   wwwroot/audio/pofighter/<fighterId>/<mood>-<1..5>.wav     e.g. kim/hurt-3.wav
//   wwwroot/audio/pofighter/manifest.json                     which of those files exist
//
// Drop WAVs into a fighter's folder and run scripts/pofighter/voices.ps1 to rewrite the
// manifest; every clip it lists replaces the procedural sound for that fighter, mood and
// intensity, and the rest stay procedural. Sound goes through the platform's sfx bus.

import { createEmotionVoice, MOODS, LEVELS, NEUTRAL_VOICE } from '../platform/emotionVoice.js';

export { MOODS, LEVELS };

// The procedural voice per fighter: a base pitch (Hz), a timbre and a level trim (a sawtooth or
// square wave is far louder than a triangle at the same gain, so each voice is evened out to peak
// around the same level). BYE slots and fighters not listed use the neutral voice.
const VOICES = {
    p1: { pitch: 150, wave: 'sawtooth', formant: 900, trim: 0.42 },    // Nick
    kim: { pitch: 255, wave: 'triangle', formant: 1400, trim: 1 },     // Kim
};

const voice = createEmotionVoice({ game: 'pofighter', voices: VOICES, neutral: NEUTRAL_VOICE });

export const loadManifest = voice.loadManifest;
export const hasRecording = voice.hasRecording;

/**
 * Speak a line. mood: one of MOODS; level 1 (mild) … 5 (all out). Returns false when it was
 * skipped (muted, audio locked, or the same fighter spoke a moment ago and this is not louder).
 */
export const say = (fighterId, mood, level = 3) => voice.say(fighterId, mood, level);

/** Schedules the procedural line; exported for the sound test page / tests. */
export const synth = (ctx, out, fighterId, mood, level) => voice.synth(ctx, out, fighterId, mood, level);
