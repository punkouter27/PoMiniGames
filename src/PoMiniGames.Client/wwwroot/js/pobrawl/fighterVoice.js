// fighterVoice.js — every president's emotion voice: 5 emotions (angry, happy, hurt, insult,
// celebrate) × 5 intensities, through the shared platform/emotionVoice.js. Mixin (mixin.js),
// registered on the showtime bus (show.js) in both the Simple and the Full show.
//
//   wwwroot/audio/pobrawl/<charId>/<emotion>-<1..5>.wav     e.g. audio/pobrawl/nixon/hurt-4.wav
//   wwwroot/audio/pobrawl/manifest.json                     which of those exist
//                                                           (pwsh scripts/pofighter/voices.ps1 -Game pobrawl)
//
// When a clip is missing the line is not silent. Brawl already had voiced sounds, so two
// emotions map onto them rather than replacing them:
//   hurt   → the pain grunt (audio.js grunt), as every landed hit always played
//   angry  → the effort "hup" (audio.js effort), louder with the level
// and the other three use the shared procedural voice, pitched and voiced from the same
// per-president table as the grunts (audioCore.js VOICES).
//
// When they speak:
//   hurt       a hit or a throw taken; the level follows the damage (5 on the knockout blow)
//   angry      the attacker landing a big hit
//   insult     a taunt (louder with a lead, loudest over a near-finished opponent)
//   happy      a round won at the bell (3), a match won on the cards (4)
//   celebrate  a knockout (3 when the match goes on, 4 when it ends it), the Cup belt (5)
//
// Presentation only: nothing here touches sim state or this.rng. The FFA engine is not a
// BrawlGame and has no voice set.
import { createEmotionVoice } from '../platform/emotionVoice.js';
import { VOICES, DEFAULT_VOICE } from './audioCore.js';
import { MAX_HP, HEAVY_HIT_DMG } from './constants.js';

// The grunt table's glottis and upper formant, as the shared procedural voice's parameters.
const fromGrunt = (v) => ({ pitch: v.f0 * 1.35, wave: 'sawtooth', formant: v.f2, trim: 0.36 + v.rasp * 0.1 });

const voice = createEmotionVoice({
  game: 'pobrawl',
  voiceOf: (charId) => fromGrunt(VOICES[charId] || DEFAULT_VOICE),
});

/** Pain level for `dmg` health lost: a jab is 1, a heavy hit 4, a knockout or a haymaker 5. */
export function hurtLevel(dmg, knockout = false) {
  if (knockout || dmg >= HEAVY_HIT_DMG * 1.4) return 5;
  if (dmg >= HEAVY_HIT_DMG) return 4;
  if (dmg >= HEAVY_HIT_DMG * 0.7) return 3;
  if (dmg >= HEAVY_HIT_DMG * 0.4) return 2;
  return 1;
}

class FighterVoiceMethods {
  _initFighterVoice() {
    voice.loadManifest();
    this._onShow((type, d) => this._fighterVoiceOn(type, d));
  }

  /**
   * One line from fighter `f`. `fallback` is the game's own sound for this emotion (hurt, angry):
   * it plays when there is no clip, and also when the voice declined (audio locked, or the same
   * fighter spoke a moment ago), so a mapped sound is never lost that was there before.
   */
  _fighterSay(f, mood, level, fallback = null) {
    if (!f?.charId || this.disposed) return;
    const spoke = voice.say(f.charId, mood, level, { fallback });
    if (!spoke && fallback && !voice.hasRecording(f.charId, mood, level)) fallback(mood, level);
  }

  /** A hit or throw taken: hurt by damage, through the pain grunt when there is no clip. */
  _fighterHurt(defender, dmg, gruntPower) {
    const ko = this._hp(defender) <= 0;
    this._fighterSay(defender, 'hurt', hurtLevel(dmg, ko),
      () => this.audio?.grunt({ power: gruntPower, charId: defender.charId }));
  }

  _fighterVoiceOn(type, d) {
    const side = (w) => (w === 1 || w === 2 ? this.fighters?.[w - 1] : null);
    switch (type) {
      case 'hit': {
        // Landing a big one: the attacker's anger, mapped onto the effort "hup".
        if (d.dmg >= HEAVY_HIT_DMG * 0.7) {
          const level = Math.min(5, hurtLevel(d.dmg) + (d.power > 0.8 ? 1 : 0));
          this._fighterSay(d.attacker, 'angry', level,
            (_, l) => this.audio?.effort(d.attacker.charId, 0.6 + l * 0.2));
        }
        break;
      }
      case 'taunt': {
        const opp = this.fighters?.find((x) => x !== d.f);
        const lead = opp ? this._hp(d.f) - this._hp(opp) : 0;
        const level = opp && this._hp(opp) <= MAX_HP * 0.2 ? 5 : lead >= 30 ? 4 : lead > 0 ? 3 : 2;
        this._fighterSay(d.f, 'insult', level);
        break;
      }
      case 'ko': {
        const f = side(d.winner);
        if (f) this._fighterSay(f, 'celebrate', this._roundDecides?.(d.winner) === false ? 3 : 4);
        break;
      }
      case 'round': {
        // A best-of-three round won at the bell (a knockout round already celebrated).
        const f = side(d.winner);
        if (f && !d.ko) this._fighterSay(f, 'happy', 3);
        break;
      }
      case 'result': {
        const f = side(d.winner);
        if (f && !d.ko) this._fighterSay(f, 'happy', 4);
        break;
      }
      case 'champion': {
        const f = this.fighters?.find((x) => x.charId === d.charId) || side(this.winner);
        if (f) this._fighterSay(f, 'celebrate', 5);
        break;
      }
      default:
        break;
    }
  }
}

export const FighterVoice = FighterVoiceMethods.prototype;
