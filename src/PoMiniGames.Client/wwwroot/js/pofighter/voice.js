// pofighter/voice.js — each fighter's voice: 5 moods × 5 intensities, a real recording when one
// exists and the advanced procedural imitation when it does not (the shared
// platform/emotionVoice.js).
//
//   wwwroot/audio/pofighter/voices.json                       every fighter × mood × level: its WAV
//                                                             path, `exists`, and the fighter's voice profile
//   wwwroot/audio/pofighter/<fighterId>/<mood>-<1..5>.wav     e.g. kim/hurt-3.wav
//
// Drop WAVs into a fighter's folder and run scripts/pofighter/voices.ps1 to refresh voices.json;
// every clip it marks `exists` replaces the procedural line for that fighter, mood and intensity.
// A fighter's procedural voice (pitch, formants, breath, rasp, vibrato, tempo) is its `voice`
// profile in voices.json. Sound goes through the platform's sfx bus.

import { createEmotionVoice, MOODS, LEVELS } from '../platform/emotionVoice.js';

export { MOODS, LEVELS };

const voice = createEmotionVoice({ game: 'pofighter' });

export const loadManifest = voice.loadManifest;
export const hasRecording = voice.hasRecording;

/**
 * Speak a line. mood: one of MOODS; level 1 (mild) … 5 (all out). Returns false when it was
 * skipped (muted, audio locked, or the same fighter spoke a moment ago and this is not louder).
 */
export const say = (fighterId, mood, level = 3) => voice.say(fighterId, mood, level);

/** Schedules the procedural line; exported for the sound test page / tests. */
export const synth = (ctx, out, fighterId, mood, level) => voice.synth(ctx, out, fighterId, mood, level);
