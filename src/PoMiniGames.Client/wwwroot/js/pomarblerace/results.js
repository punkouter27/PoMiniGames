// results.js — Game mixin: sector splits, finishing, scoring, per-track stats and the HUD
// callbacks (podium, place tick). Mixed into Game.prototype by game.js.
import {
  RESULT_MS, SCORE_TOP, DOMINANT_GAP, DOMINANT_BONUS, MAX_STREAK_STEPS,
} from './tuning.js';
import { update as updateSave, readSectorBests } from './store.js';

/**
 * The scoring rule, pure. `place` is your finish (-1 = did not finish), `lead` your margin over
 * 2nd when you won (0 otherwise), `streak` the streak BEFORE this race.
 * MIRRORED IN C#: MarbleRaceRunVerifier re-adds a run's races with the same arithmetic, so a
 * change here must land there too.
 * @returns {{ won: boolean, gained: number, streak: number }}
 */
export function scoreRace(place, lead, streak) {
  const won = place >= 1 && place <= SCORE_TOP;
  if (!won) return { won: false, gained: 0, streak: 0 };
  // Higher place = more points: 1st is worth SCORE_TOP, SCORE_TOP-th is worth 1. A dominant win
  // (1st and DOMINANT_GAP clear of 2nd) is worth more again: that is where finish TIME scores.
  const base = SCORE_TOP - place + 1 + (place === 1 && lead >= DOMINANT_GAP ? DOMINANT_BONUS : 0);
  const next = streak + 1;
  const mult = 1 + Math.min(next - 1, MAX_STREAK_STEPS) * 0.5;
  return { won: true, gained: Math.round(base * mult), streak: next };
}

export class ResultsMixin {
  // Sector splits (map checkpoints): as your own marble passes each checkpoint, and at the line,
  // report the time since the last one against this map's best for that sector.
  _checkSectors() {
    const cps = this.track.checkpoints;
    if (this.demo || !cps) return;
    const me = this.marbleSet.marbles[this.isGuest ? this.guestIndex : this.chosen];
    if (!me || me.eliminated) return;
    while (this._sector < cps.length && me.s >= cps[this._sector]) this._splitSector(this.raceClock, cps.length + 1);
    if (me.finished && this._sector === cps.length) this._splitSector(me.finishTime, cps.length + 1);
  }

  _splitSector(at, count) {
    const idx = this._sector;
    const time = Math.round((at - this._sectorStart) * 100) / 100;
    this._sector++;
    this._sectorStart = at;
    const best = readSectorBests(this.map.id)[idx] || 0;
    if (!best || time < best) {
      updateSave((s) => { (s.sectors[this.map.id] ||= [])[idx] = time; });
    }
    this._invoke('OnSector', idx + 1, count, time, best);
  }

  // GFX #6 — your own top-10 crossing: a big confetti burst, a gold flash, a crowd roar and a kick
  // of camera shake. Every other finisher still gets the small per-marble confetti and chime.
  _celebrateOwnFinish(m, place) {
    if (this.demo || place < 1 || place > SCORE_TOP) return;
    this.scene.burstConfetti(m.mesh.position, 120);
    this.scene.pulseLight(m.mesh.position, 0xfde047, 2);
    this.audio.playRoar();
    window.PoImpact?.impact('win', 0.8);
  }

  // Per-track record for the intro card's track buttons (F7). Local only; demo never counts.
  _recordTrackStat(place, time) {
    updateSave((s) => {
      const st = s.trackStats[this.map.id] ||= { races: 0, top10: 0, wins: 0, bestPlace: 0, bestTime: 0 };
      st.races++;
      if (place >= 1) {
        if (place <= SCORE_TOP) st.top10++;
        if (place === 1) st.wins++;
        if (!st.bestPlace || place < st.bestPlace) st.bestPlace = place;
        if (!st.bestTime || time < st.bestTime) st.bestTime = Math.round(time * 100) / 100;
      }
    });
  }

  _resolve() {
    this.audio.silenceBeds();
    if (this._ghost?.mesh) this._ghost.mesh.visible = false;
    const order = this.marbleSet.leaderboard();   // final standings — assigns place to every marble
    const me = this.marbleSet.marbles[this.chosen];
    // A marble that fell off the track has no placing: it neither finished nor holds a rank.
    // Reporting its last-known place scored the player a point for being eliminated, and an
    // elimination before the first standings pass left place at -1, which `place <= 3` also
    // counted as a win.
    const finished = !!me && me.finished && !me.eliminated;
    const place = finished ? me.place : -1;
    const lead = finished && place === 1 && order.length > 1 && order[1].finished ? order[1].finishTime - me.finishTime : 0;
    // Score for finishing anywhere in the top SCORE_TOP of the 101-marble field (scoreRace above).
    const { won, gained, streak } = scoreRace(place, lead, this.streak);
    if (won) {
      this.streak = streak;
      this.score += gained;
      this.runRaces.push({ place, time: Math.round(me.finishTime * 1000) / 1000, lead: Math.round(lead * 1000) / 1000 });
    } else {
      // The run ends. A miss (finishing outside the top SCORE_TOP, or falling off) costs the
      // whole run — that's the stake that makes a streak worth watching.
      this.streak = 0;
      this.score = 0;
      this.runRaces = [];
    }
    if (this.score > this.best) { this.best = this.score; updateSave((s) => { s.best = this.best; }); }
    if (!this.demo) this._recordTrackStat(place, finished ? me.finishTime : 0);

    this._runAlive = won;
    this.resultTimer = RESULT_MS / 1000;
    this._setPhase('result');
    // #3 — the result grade, set AFTER _setPhase so it isn't overwritten by a phase grade.
    this._setGrade(won ? 'win' : 'loss');
    this.audio.playSting(won);
    if (!this.demo) this.audio.say(place === 1 ? 'You win it!' : won ? `P${place}. Top ten finish!` : finished ? 'Outside the top ten.' : 'Off the track!');
    this._leaderIdx = -1;   // the next race's first leader is not a "change"
    this._sendTick(); // final standings
    // The run's races ride along (appended — positional contract) for the board submission.
    // Your own finish time rides along too (0 when you did not finish), offered as the map's
    // world record by the page.
    this._invoke('OnRaceResult', won, place, this.score, gained, this.streak, this.best, this.map.id,
      this.runRaces.map((r) => r.place), this.runRaces.map((r) => r.time), this.runRaces.map((r) => r.lead),
      finished ? Math.round(me.finishTime * 100) / 100 : 0);
    // Online host: the guest's standing, for the page to relay. Same top-SCORE_TOP rule, no
    // streak — the run/score system belongs to the host's own session.
    if (this.online && !this.isGuest) {
      const g = this.marbleSet.marbles[this.guestIndex];
      const gFinished = !!g && g.finished && !g.eliminated;
      const gPlace = gFinished ? g.place : -1;
      this._invoke('OnGuestResult', gFinished && gPlace >= 1 && gPlace <= SCORE_TOP, gPlace);
    }
  }

  // Race stings (audio.js), from the HUD tick on the host and the guest alike: a new leader
  // (debounced in audio.js), and your marble moving into the top 10 or the top 3. `prev`/`now`
  // are your place last tick and this one (-1 = none). Demo has nobody to cheer for milestones.
  _raceStings(order, me, prev, now) {
    if (this.phase !== 'racing') return;
    const leader = order[0];
    const leaderIdx = leader ? leader.index : -1;
    if (this._leaderIdx !== undefined && this._leaderIdx >= 0 && leaderIdx >= 0 && leaderIdx !== this._leaderIdx) {
      this.audio.playLeadChange(!!me && leader === me, this.scene.audioCue(leader.mesh.position));
    }
    this._leaderIdx = leaderIdx;
    if (this.demo || prev <= 0 || now <= 0) return;
    if (now <= 3 && prev > 3) this.audio.playMilestone(3);
    else if (now <= SCORE_TOP && prev > SCORE_TOP) this.audio.playMilestone(SCORE_TOP);
  }

  _sendPodium() {
    if (!this.dotnet) return;
    const top3 = this.marbleSet.marbles
      .filter((m) => m.finished)
      .sort((a, b) => a.finishOrder - b.finishOrder)
      .slice(0, 3);
    const winTime = top3.length ? top3[0].finishTime : 0;
    const round2 = (v) => Math.round(v * 100) / 100;
    this._invoke('OnPodium',
      top3.map((m) => m.index),
      top3.map((m) => round2(m.finishTime)),
      top3.map((m) => round2(m.finishTime - winTime)));
  }

  // The HUD tick: the player's place and the field size are all the page draws mid-race.
  _sendTick() {
    if (!this.dotnet) return;
    const order = this.marbleSet.leaderboard();
    const me = this.chosen >= 0 ? this.marbleSet.marbles[this.chosen] : null;

    // Overtake cue (GFX #10): compare the player's place against the last tick's before the
    // snapshot below overwrites it, and pan it to the marble that took part — the one just
    // behind you after a gain, the one just ahead after a loss.
    if (me && !me.eliminated && this.phase === 'racing' && me.prevPlace > 0 && me.place !== me.prevPlace) {
      const gained = me.place < me.prevPlace;
      const other = order[gained ? me.place : me.place - 2];
      this.audio.playOvertake(gained, other ? this.scene.audioCue(other.mesh.position) : null);
    }
    this._raceStings(order, me, me ? me.prevPlace : -1, me && !me.eliminated ? me.place : -1);
    for (const m of order) m.prevPlace = m.place;

    const myPlace = me && !me.eliminated ? me.place : -1;
    this._invoke('OnRaceTick', myPlace, order.length);
  }
}
