// audioShow.js — showtime module (see show.js): the fight's sound design hung off the show
// bus. Mixin, `this` is the live game. The synthesis lives on the AudioBus (audio.js, the
// "Showtime" section); this file decides WHEN, from the events and one per-frame update.
//
//   The conductor  — a silent clock (there is NO music bed, app-wide rule). Its tempo, 118-128
//                    bpm, leans on the fight's energy; it locks to 120 for the countdown so the
//                    PA's "3, 2, 1, Fight!" falls on every other beat. Published every frame as
//                    `this.beat` (ledBoards.js pulses to it — keep the shape):
//                      { bpm, t, phase, beatN, bar, pulse, energy }
//                    t = seconds on the clock, phase = 0..1 within the beat, beatN/bar = integer
//                    counts, pulse = 1 on the beat decaying ~exp to 0, energy = 0..1 intensity.
//                    The AudioBus asks it for the next 8th/16th (setConductor) to land the combo
//                    mallet and the momentum stab in time, never more than ~120 ms late.
//   Leitmotifs     — each president's 4-7 note figure: traded corner to corner in the gaps of
//                    the countdown, the owner's as the super's brass stinger, the winner's
//                    resolved into a fanfare at the result, a brass stab when a big hit flips
//                    the HP lead, and Ruffles and Flourishes for the tournament champion's belt.
//   Charge risers  — one per charging fighter, pitch and brightness following f.chargeAmt,
//                    panned to the fighter, a glint at full charge, snapped shut on release (or
//                    whenever the fighter leaves 'charge' some other way). CPU corners quieter.
//   Perspective    — the mix follows the camera. Director mode (tournament): each cut
//                    picks tight / mid / wide; super and KO cinematics override. Player modes:
//                    the AudioListener rides the camera and one-shots get a PannerNode (HRTF on
//                    the high tier, equal-power below).
//   Crowd rhythm   — stomp-stomp-CLAP on the conductor when the energy is high, in the last ten
//                    seconds and during a comeback; the "U-S-A!" chant joins at the top end.
//   Music layers   — musicLayers.js, locked to the conductor's grid on the app's music bus
//                    (its own slider, 0 by default, so the no-music-bed rule holds unless the
//                    player opts in). Intensity is the conductor's energy floored by how much of
//                    the round clock has run, so the arrangement builds toward the bell.
//
// Presentation only: Math.random (inside the AudioBus), never `this.rng`.
// No per-frame allocation: every per-frame value lives in `this._as` / `this.beat`.

import * as Quality from './quality.js';
import { createMusicLayers } from '../musicLayers.js';

const TIME_LIMIT = 60;          // game.js's round length (not exported there)
const COUNTDOWN_BPM = 120;      // the PA calls once a second: every other beat
const BPM_FLOOR = 118;
const BPM_SPAN = 10;            // + energy · span
const LOOKAHEAD = 0.1;          // s: crowd beats are queued this far ahead on the audio clock
const GRID_MAX = 0.12;          // s: the longest a quantized layer may wait for the grid
const RISER_HZ = 30;            // riser parameter updates per second
const COMEBACK_DEFICIT = 30;    // HP behind, at worst, to count as a comeback...
const COMEBACK_CLOSE = 5;       // ...once hauled back to within this
const COMEBACK_SEC = 8;         // how long the hall stomps for it
const MOMENTUM_POWER = 0.45;    // the hit (0..1) that flips the lead must be at least this big
const FLOURISH_AT = 4.3;        // s into the belt ceremony: after the PA has called the champion
const CHANT = ['U', 'S', 'A'];

// Director shot → mix perspective (director.js POOL + its event shots).
const SHOT_PERSPECTIVE = {
  two: 'tight', ots: 'tight', pushin: 'tight', reaction: 'tight',
  main: 'mid', ringside: 'mid', crane: 'mid',
  wide: 'wide',
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class AudioShowMethods {
  _initAudioShow() {
    const mode = this.options?.mode;
    const director = mode === 'tournament';
    this.beat = { bpm: COUNTDOWN_BPM, t: 0, phase: 0, beatN: 0, bar: 0, pulse: 0, energy: 0 };
    this._as = {
      director,
      pos: 0,                    // conductor position in beats
      stamp: performance.now(),  // when pos was last advanced (grid extrapolation)
      lockBpm: false,
      risers: [null, null],
      rpos: [{ x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.2, z: 0 }],
      cued: [false, false],
      riserT: 0,
      shot: 'mid',
      lead: 0,                   // last non-zero HP lead (P1 − P2)
      deficit: [0, 0],           // worst deficit each corner has been in this match
      comebackDone: [false, false],
      comebackT: 0,
      lastSched: -1,             // last conductor beat handed to the crowd
      rhythm: 0,                 // shadow of the rhythm level, to know when to stop queueing
      chant: 0,                  // chant fade 0..1
      cer: null, cerDone: false,
      listen: new Float32Array(9).fill(NaN),
    };
    const audio = this.audio;
    if (!audio) return;
    audio.setConductor(() => this._asGridDelay());
    if (!director) audio.setListenerMode(Quality.tier() === 'high' ? 'HRTF' : 'equalpower');
    this._music = createMusicLayers({ root: 55 });
    this._onShow((type, d) => this._asEvent(type, d));
    this._onShowUpdate((dt) => this._asUpdate(dt));
    this._onShowDispose(() => {
      audio.stopRisers();
      audio.setCrowdRhythm(0);
      audio.setConductor(null);
      this._music?.stop();
      this._music = null;
      this._as.risers[0] = this._as.risers[1] = null;
    });
  }

  // Seconds from now to the conductor's next 8th, or 16th when the 8th is too far off.
  _asGridDelay() {
    const A = this._as;
    const bps = this.beat.bpm / 60;
    const pos = A.pos + Math.min(0.05, (performance.now() - A.stamp) / 1000) * bps;
    for (const div of [2, 4]) {
      const u = pos * div;
      const rem = (Math.ceil(u) - u) / (bps * div);
      if (rem <= GRID_MAX) return rem < 0.004 ? 0 : rem;
    }
    return 0;
  }

  _asEvent(type, d) {
    const A = this._as;
    const audio = this.audio;
    const fs = this.fighters;
    switch (type) {
      case 'countdown':
        // Beat 0 is the PA's "3": the count and the motifs share the grid.
        A.lockBpm = true;
        A.pos = 0;
        A.lastSched = -1;
        if (fs?.[1]) audio.countdownMotifs(fs[0].charId, fs[1].charId);
        break;
      case 'fight':
        A.lockBpm = false;
        break;
      case 'chargeStart': {
        const i = fs ? fs.indexOf(d.f) : -1;
        if (i < 0) break;
        A.risers[i]?.stop(0);
        const human = d.f.controller?.isHuman === true;
        this._asFighterPos(i);
        A.risers[i] = audio.chargeRiser(A.rpos[i], human ? 1 : A.director ? 0.4 : 0.6);
        A.cued[i] = false;
        break;
      }
      case 'release': {
        const i = fs ? fs.indexOf(d.f) : -1;
        if (i >= 0 && A.risers[i]) { A.risers[i].stop(d.chargeAmt || 0); A.risers[i] = null; }
        break;
      }
      case 'hit':
        this._asOnHit(d);
        break;
      case 'super':
        // First in: the owner's motif. personalityEffects' own call lands inside the dedupe.
        audio.superStinger(d.f?.charId || null);
        break;
      case 'ko':
        audio.stopRisers();
        A.risers[0] = A.risers[1] = null;
        break;
      case 'result':
        if (d.winner && fs?.[d.winner - 1]) audio.fanfare(fs[d.winner - 1].charId);
        break;
      case 'cut':
        A.shot = SHOT_PERSPECTIVE[d.shot] || 'mid';
        break;
      case 'reset':
        audio.stopRisers();
        A.risers[0] = A.risers[1] = null;
        A.shot = 'mid';
        A.lead = 0;
        A.deficit[0] = A.deficit[1] = 0;
        A.comebackDone[0] = A.comebackDone[1] = false;
        A.comebackT = 0;
        A.chant = 0;
        audio.setCrowdRhythm(0);
        break;
      default:
        break;
    }
  }

  // Momentum and comebacks, read off the HP after the hit has landed.
  _asOnHit(d) {
    const A = this._as;
    const fs = this.fighters;
    if (!fs || !this.combat) return;
    const h0 = this._hp(fs[0]), h1 = this._hp(fs[1]);
    const lead = h0 - h1;
    const ai = fs.indexOf(d.attacker);
    if (ai >= 0) {
      // The lead changed hands on a big hit: a brass stab in the new leader's key.
      if (A.lead !== 0 && lead !== 0 && Math.sign(A.lead) !== Math.sign(lead) && (d.power || 0) >= MOMENTUM_POWER) {
        this.audio.brassStab(d.attacker.charId, d.power, d.point);
      }
      const behind = ai === 0 ? -lead : lead;
      if (!A.comebackDone[ai] && A.deficit[ai] >= COMEBACK_DEFICIT && behind <= COMEBACK_CLOSE) {
        A.comebackDone[ai] = true;
        A.comebackT = COMEBACK_SEC;
      }
    }
    A.deficit[0] = Math.max(A.deficit[0], -lead);
    A.deficit[1] = Math.max(A.deficit[1], lead);
    if (lead !== 0) A.lead = lead;
  }

  // A fighter's chest, written into the reusable rpos slot the riser holds on to.
  _asFighterPos(i) {
    const p = this.fighters[i].rig.root.position;
    const r = this._as.rpos[i];
    r.x = p.x; r.y = p.y + 1.2; r.z = p.z;
    return r;
  }

  _asLate() {
    if (this.phase !== 'fighting' || this.training) return 0;
    return clamp01((10 - (TIME_LIMIT - (this.clock || 0))) / 10);
  }

  _asUpdate(dt) {
    const A = this._as;
    const audio = this.audio;
    const b = this.beat;
    const late = this._asLate();
    if (A.comebackT > 0) A.comebackT -= dt;

    // ── The conductor ──────────────────────────────────────────────────
    // Energy: the crowd's own level (excitement, desperation and the round's age already
    // folded in by _updateCrowd), the danger lowpass, the last ten seconds, a comeback.
    let target;
    switch (this.phase) {
      case 'fighting':
        target = Math.max(this._crowdPushed > 0 ? this._crowdPushed : 0,
          Math.min(1, this.excited || 0) * 0.9,
          (this._dangerPushed > 0 ? this._dangerPushed : 0) * 0.85,
          late > 0 ? 0.7 + 0.3 * late : 0,
          A.comebackT > 0 ? 0.8 : 0);
        break;
      case 'ko': target = 1; break;
      case 'result': target = 0.6; break;
      case 'countdown': target = 0.35; break;
      default: target = 0.2;
    }
    b.energy += (clamp01(target) - b.energy) * (1 - Math.exp(-dt * 2));
    if (A.lockBpm) b.bpm = COUNTDOWN_BPM;
    else b.bpm += (BPM_FLOOR + BPM_SPAN * b.energy - b.bpm) * (1 - Math.exp(-dt * 0.6));
    A.pos += dt * b.bpm / 60;
    A.stamp = performance.now();
    b.t += dt;
    b.beatN = Math.floor(A.pos);
    b.phase = A.pos - b.beatN;
    b.bar = Math.floor(b.beatN / 4);
    b.pulse = Math.exp(-b.phase * 5);

    const music = this._music;
    if (music) {
      const live = this.phase === 'countdown' || this.phase === 'fighting' || this.phase === 'ko';
      if (live && !this.training) {
        // The round clock alone takes it from the bassline to the kick by the bell; the
        // energy (hits, danger, comebacks, the last ten seconds) can only push it further.
        const aged = this.phase === 'fighting' ? clamp01((this.clock || 0) / TIME_LIMIT) * 0.65 : 0;
        music.setIntensity(this.phase === 'countdown' ? 0 : Math.max(b.energy * 0.95, aged, late > 0 ? 0.85 : 0));
        music.setGain(A.director ? 0.7 : 1);
        music.setBeat(A.pos, b.bpm);
        music.start();
      } else if (music.isRunning()) {
        music.stop();
      }
    }

    if (!audio) return;

    // ── Charge risers ──────────────────────────────────────────────────
    A.riserT += dt;
    const push = A.riserT >= 1 / RISER_HZ;
    if (push) A.riserT = 0;
    for (let i = 0; i < 2; i++) {
      const h = A.risers[i];
      if (!h) continue;
      const f = this.fighters?.[i];
      if (!h.alive) { A.risers[i] = null; continue; }
      // Left the coil any way but a release (a torn arm, a stagger, a KO): snap it shut.
      if (!f || f.state !== 'charge') { h.stop(f?.chargeAmt || h.amt); A.risers[i] = null; continue; }
      if (push) h.set(f.chargeAmt, this._asFighterPos(i));
      if (!A.cued[i] && f.chargeAmt >= 0.999) { A.cued[i] = true; h.ping(); }
    }

    // ── Perspective ────────────────────────────────────────────────────
    // Cinematics win; the director's shot otherwise; the house angle outside the fight.
    const mode = this.cameraMode;
    audio.setPerspective(mode === 'ko' ? 'ko' : mode === 'super' ? 'tight'
      : A.director && this.phase === 'fighting' ? A.shot : 'mid');
    if (!A.director && audio.ctx && this.camera) this._asListener();

    // ── The champion's honours ─────────────────────────────────────────
    this._asCeremony();

    // ── Crowd rhythm ───────────────────────────────────────────────────
    const ctx = audio.ctx;
    const fighting = this.phase === 'fighting' && !this.training;
    const rhythmOn = fighting && (b.energy > 0.72 || late > 0 || A.comebackT > 0);
    const chantOn = fighting && (b.energy > 0.85 || late > 0.3 || A.comebackT > 0);
    A.rhythm += ((rhythmOn ? 1 : 0) - A.rhythm) * (1 - Math.exp(-dt * 1.2));
    A.chant += ((chantOn ? 1 : 0) - A.chant) * (1 - Math.exp(-dt * 0.8));
    // Stepped to 0.05 so a slowly drifting energy doesn't re-ramp the bus every frame.
    audio.setCrowdRhythm(rhythmOn ? Math.round((0.4 + 0.4 * b.energy) * 20) / 20 : 0);
    if (!ctx || ctx.state !== 'running' || audio.muted || A.rhythm < 0.02) return;
    const next = b.beatN + 1;
    const until = (next - A.pos) * 60 / b.bpm;
    if (next <= A.lastSched || until > LOOKAHEAD) return;
    A.lastSched = next;
    const at = ctx.currentTime + until;
    const step = next % 4;                         // stomp, stomp, CLAP, rest
    const amt = 0.6 + 0.4 * b.energy;
    if (step < 2) audio.crowdStomp(at, amt);
    else if (step === 2) audio.crowdClap(at, amt);
    // "U-S-A!" on the first two bars of every four, riding the same three beats.
    if (step < 3 && A.chant > 0.05 && Math.floor(next / 4) % 4 < 2) {
      audio.crowdChant(CHANT[step], at, A.chant * amt, Quality.tier() === 'low' ? 4 : 6);
    }
  }

  // Ruffles and Flourishes once the belt ceremony's PA call is through (ceremony.js `_cer`).
  _asCeremony() {
    const A = this._as;
    const cer = this._cer;
    if (!cer) return;
    if (cer !== A.cer) { A.cer = cer; A.cerDone = false; }
    if (!A.cerDone && cer.t >= FLOURISH_AT) { A.cerDone = true; this.audio.flourish(); }
  }

  // The AudioListener on the camera: forward = −Z and up = +Y of its quaternion (no parent,
  // so local is world). Pushed only when it moved, so a held shot costs nothing.
  _asListener() {
    const c = this.camera;
    const p = c.position, q = c.quaternion;
    const L = this._as.listen;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fy = -2 * (q.y * q.z - q.w * q.x);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const ux = 2 * (q.x * q.y - q.w * q.z);
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const uz = 2 * (q.y * q.z + q.w * q.x);
    if (Math.abs(L[0] - p.x) + Math.abs(L[1] - p.y) + Math.abs(L[2] - p.z)
      + Math.abs(L[3] - fx) + Math.abs(L[4] - fy) + Math.abs(L[5] - fz) < 1e-3) return;
    L[0] = p.x; L[1] = p.y; L[2] = p.z; L[3] = fx; L[4] = fy; L[5] = fz;
    this.audio.setListener(p.x, p.y, p.z, fx, fy, fz, ux, uy, uz);
  }
}

export const AudioShow = AudioShowMethods.prototype;
