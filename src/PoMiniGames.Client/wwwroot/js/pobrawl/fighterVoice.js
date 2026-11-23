// fighterVoice.js — every president's emotion voice: 5 emotions (angry, happy, hurt, insult,
// celebrate) × 5 intensities, through the shared platform/emotionVoice.js. Mixin (mixin.js),
// registered on the showtime bus (show.js) in both the Simple and the Full show.
//
//   wwwroot/audio/pobrawl/voices.json                       every fighter × emotion × level: its WAV
//                                                           path, `exists`, and the fighter's voice profile
//                                                           (pwsh scripts/pofighter/voices.ps1 -Game pobrawl)
//   wwwroot/audio/pobrawl/<charId>/<emotion>-<1..5>.wav     e.g. audio/pobrawl/nixon/hurt-4.wav
//
// A cell with no recording plays the advanced procedural imitation, voiced by the fighter's
// profile (its pitch and formants follow the grunt table in audioCore.js). Brawl's old pain
// grunt and effort "hup" were procedural too, so hurt and angry now use the new engine; the
// grunt stays for the FFA (not a BrawlGame, no voice set) and for crate knocks.
//
// When they speak:
//   hurt       a hit or a throw taken; the level follows the damage (5 on the knockout blow)
//   angry      the attacker landing a big hit
//   insult     a taunt (louder with a lead, loudest over a near-finished opponent)
//   happy      a round won at the bell (3), a match won on the cards (4)
//   celebrate  a knockout (3 when the match goes on, 4 when it ends it), the Cup belt (5)
//
// Presentation only: nothing here touches sim state or this.rng.
import { createEmotionVoice } from '../platform/emotionVoice.js';
import { MAX_HP, HEAVY_HIT_DMG } from './constants.js';

const voice = createEmotionVoice({ game: 'pobrawl' });

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

  /** One line from fighter `f`: its clip for the cell, or the procedural imitation. */
  _fighterSay(f, mood, level) {
    if (!f?.charId || this.disposed || this.audio?.muted) return;
    voice.say(f.charId, mood, level);
  }

  /** A hit or throw taken: hurt by damage. */
  _fighterHurt(defender, dmg) {
    this._fighterSay(defender, 'hurt', hurtLevel(dmg, this._hp(defender) <= 0));
  }

  _fighterVoiceOn(type, d) {
    const side = (w) => (w === 1 || w === 2 ? this.fighters?.[w - 1] : null);
    switch (type) {
      case 'countdown':
        // Synthesise both corners' lines in idle time before the bell.
        voice.loadManifest().then(() => voice.prewarm((this.fighters || []).map((f) => f.charId)));
        break;
      case 'hit':
        // Landing a big one: the attacker's anger.
        if (d.dmg >= HEAVY_HIT_DMG * 0.7) {
          this._fighterSay(d.attacker, 'angry', Math.min(5, hurtLevel(d.dmg) + (d.power > 0.8 ? 1 : 0)));
        }
        break;
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
