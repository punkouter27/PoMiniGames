// ledBoards.js — showtime module (see show.js). Mixin, `this` is the live game.
//
// Two pieces of hall dressing that ride the crowd's beat clock:
//   • Truss pulse: the rig lenses (game.js _rigLenses) get a beat pulse on top of game.js's own
//     envelope chase, scaled by the beat energy — a nudge early, punchy late in the round.
//   • Stadium wave: a travelling band round the stands (crowd shader uWave in arena.js lifts the
//     seats; phones in the band go bright) on peaks, with a cooldown; phones sway on the beat.
//
// The apron and barrier LED ribbon boards — and the scrolling letter ticker they carried — were
// removed: behind the fighters it read as noise, not as hall dressing.
//
// Flicker rule: everything here is local emissive (eight lenses, phone sprites); no
// whole-frame brightness. Reduced motion: no beat pulse, no wave, no sway.
// Every material is built here at init so _warmupRender compiles it; nothing compiles mid-fight.

import * as THREE from 'three-eco/webgpu';
import { MAX_HP } from './constants.js';

const TIME_LIMIT = 60;         // game.js TIME_LIMIT

const WAVE_LAP = 5.2;          // seconds per lap of the stands
const WAVE_LAPS = 1.35;
const WAVE_RISE = 0.45;        // metres a seat lifts at the crest
const WAVE_W = 0.36;           // band half-width (radians)
const WAVE_CD = 13;            // seconds between waves

const reducedMotion = () => document.documentElement.getAttribute('data-motion') === 'reduce';

class LedBoardsMethods {
  _initLedBoards() {
    if (!this.scene || !this.arena) return;
    const group = new THREE.Group();
    group.userData.kind = 'ledBoards';
    this.scene.add(group);

    // Phones: a hot (HDR) twin of the shared phone material for the wave band, plus
    // per-phone seat angle. A hidden keeper sprite gets it compiled at warm-up.
    const phones = this.arena.phones;
    let hotMat = null, keeper = null;
    if (phones?.mat) {
      hotMat = phones.mat.clone();
      hotMat.color.setScalar(2.4);
      hotMat.opacity = 0.95;
      keeper = new THREE.Sprite(hotMat);
      keeper.visible = false;
      keeper.scale.setScalar(0.001);
      group.add(keeper);
      for (const s of phones.pool) {
        const b = s.userData.base;
        s.userData.ang = Math.atan2(b.x, b.z);
      }
    }

    this._led = {
      group, hotMat,
      reduce: reducedMotion(),
      deficit: [0, 0], comebackDone: [false, false], last10: false, upsetArmed: true,
      // Beat (fallback clock when the audio show has not published this.beat).
      fbT: 0, pulse: 0, energy: 0, phase: 0, beatN: 0,
      lensBase: [], lensSet: [],
      wave: { t: -1, a0: 0, dir: 1, env: 0 }, waveCd: 4, hiE: 0,
    };

    this._onShow((type, d) => this._ledOnShow(type, d));
    this._onShowUpdate((dt) => this._ledUpdate(dt));
    this._onShowDispose(() => this._ledDispose());
  }

  // ── Content ─────────────────────────────────────────────────────────
  // Only the moments that move the crowd survive here: a reset clears the round's book-keeping,
  // a big combo or a KO starts the wave, a finished bout starts the result wave.
  _ledOnShow(type, d) {
    const L = this._led;
    if (!L) return;
    switch (type) {
      case 'reset':
        this._ledWaveStop();
        L.waveCd = 4;
        // falls through
      case 'countdown':
        L.deficit[0] = L.deficit[1] = 0; L.comebackDone[0] = L.comebackDone[1] = false;
        L.last10 = false;
        break;
      case 'hit':
        if ((d.attacker?.comboN || 0) >= 5) this._ledWave('combo');
        break;
      case 'ko':
        this._ledWave('ko', true);
        break;
      case 'result':
        this._ledWave('result');
        break;
      default: break;
    }
  }

  // ── Beat ────────────────────────────────────────────────────────────
  // The audio show publishes this.beat; standalone, a 120 bpm clock with an energy read
  // off the excitement, the round clock and the lowest HP.
  _ledBeat(dt) {
    const L = this._led;
    const b = this.beat;
    let e;
    if (b && typeof b.pulse === 'number') {
      L.pulse = b.pulse; L.phase = b.phase || 0; L.beatN = b.beatN || 0;
      e = typeof b.energy === 'number' ? b.energy : null;
    } else {
      L.fbT += dt;
      const beats = L.fbT * 2;
      L.beatN = Math.floor(beats); L.phase = beats - L.beatN;
      L.pulse = Math.exp(-L.phase * 5);
      e = null;
    }
    if (e === null) {
      const fs = this.fighters;
      const lowest = fs && this._hp ? Math.min(this._hp(fs[0]), this._hp(fs[1])) / MAX_HP : 1;
      const late = Math.min(1, (this.clock || 0) / TIME_LIMIT);
      e = Math.min(1, 0.15 + (this.excited || 0) * 0.45 + late * 0.3 + (1 - lowest) * 0.25);
      if (this.phase !== 'fighting' && this.phase !== 'ko') e *= 0.6;
    }
    L.energy = Math.max(0, Math.min(1, e));
  }

  // ── Per frame ───────────────────────────────────────────────────────
  _ledUpdate(dt) {
    const L = this._led;
    if (!L) return;
    this._ledBeat(dt);

    // Slow bookkeeping: reduced motion and the round triggers, four times a second.
    L.tickT = (L.tickT || 0) + dt;
    if (L.tickT >= 0.3) {
      L.tickT = 0;
      L.reduce = reducedMotion();
      this._ledTick();
    }

    // Beat amount: a nudge at low energy, punchy late. Reduced motion: none.
    const e = L.energy;
    const amt = L.reduce ? 0 : L.pulse * (0.12 + 0.88 * e * e);

    this._ledTruss(amt);
    this._ledWaveUpdate(dt);
  }

  // The wave triggers: a comeback, the last ten seconds, the tournament upset, a hot stretch.
  _ledTick() {
    const L = this._led, fs = this.fighters;
    if (!fs || !this._hp) return;
    const hp0 = this._hp(fs[0]), hp1 = this._hp(fs[1]);

    if (this.phase !== 'fighting' || this.training) return;
    // Comeback: a fighter who trailed by 25+ HP this round now leads.
    for (let i = 0; i < 2; i++) {
      const mine = i === 0 ? hp0 : hp1, theirs = i === 0 ? hp1 : hp0;
      L.deficit[i] = Math.max(L.deficit[i], theirs - mine);
      if (!L.comebackDone[i] && L.deficit[i] >= 25 && mine > theirs) {
        L.comebackDone[i] = true;
        this._ledWave('comeback');
      }
    }
    if (!L.last10 && !this.online && TIME_LIMIT - (this.clock || 0) <= 10) {
      L.last10 = true;
      this._ledWave('last10');
    }
    const upset = this._cup ? this._cup.upset : 0;
    if (L.upsetArmed && upset > 0.5) {
      L.upsetArmed = false;
      this._ledWave('upset');
    } else if (!L.upsetArmed && upset < 0.3) L.upsetArmed = true;
    // A long hot stretch on the beat clock.
    L.hiE = L.energy > 0.85 ? L.hiE + 0.3 : 0;
    if (L.hiE >= 1.2) this._ledWave('energy');
  }

  // Rig lenses: game.js _updateReactiveArena writes their intensity every frame before the show
  // update; this multiplies on top. If nobody rewrote a lens since our last frame, our own base is
  // reused so the pulse never compounds.
  _ledTruss(amt) {
    const lenses = this._rigLenses, L = this._led;
    if (!lenses || !lenses.length) return;
    const e = L.energy;
    const off = L.reduce ? 0 : Math.exp(-(((L.phase + 0.5) % 1)) * 5) * Math.max(0, (e - 0.55) / 0.45);
    for (let i = 0; i < lenses.length; i++) {
      const m = lenses[i].material;
      const cur = m.emissiveIntensity;
      const base = (L.lensSet[i] !== undefined && Math.abs(cur - L.lensSet[i]) < 1e-6) ? L.lensBase[i] : cur;
      // Odd lamps take the off-beat once the hall is hot, so the truss chases.
      const p = (i & 1) && off > 0 ? Math.max(amt * 0.4, off * (0.12 + 0.88 * e * e)) : amt;
      const v = base * (1 + 0.9 * p);
      m.emissiveIntensity = v;
      L.lensBase[i] = base; L.lensSet[i] = v;
    }
  }

  // ── Stadium wave ────────────────────────────────────────────────────
  /** Start a wave unless one is running or cooling down (`force` skips the cooldown). */
  _ledWave(reason, force = false) {
    const L = this._led;
    if (!L || L.reduce || L.wave.t >= 0) return false;
    if (!force && L.waveCd > 0) return false;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    if (!u) return false;
    L.wave.t = 0;
    L.wave.a0 = Math.random() * Math.PI * 2;
    L.wave.dir = Math.random() < 0.5 ? -1 : 1;
    L.wave.reason = reason;
    return true;
  }

  _ledWaveStop() {
    const L = this._led;
    if (!L) return;
    L.wave.t = -1; L.wave.env = 0;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    if (u) u.value.y = 0;
    const ph = this.arena?.phones;
    if (ph) {
      for (const s of ph.pool) {
        s.userData.lift = 0; s.userData.dx = 0; s.userData.dz = 0;
        s.scale.set(0.06, 0.1, 1);
        if (s.material !== ph.mat) s.material = ph.mat;
      }
    }
  }

  _ledWaveUpdate(dt) {
    const L = this._led, W = L.wave;
    const u = this.arena?.crowd?.userData?.uniforms?.uWave;
    const ph = this.arena?.phones;
    if (L.waveCd > 0) L.waveCd -= dt;
    if (W.t >= 0 && L.reduce) this._ledWaveStop();

    let ang = 0, env = 0;
    if (W.t >= 0) {
      W.t += dt;
      const dur = WAVE_LAP * WAVE_LAPS;
      if (W.t >= dur) {
        this._ledWaveStop();
        L.waveCd = WAVE_CD;
      } else {
        env = Math.min(1, W.t / 0.7, (dur - W.t) / 0.9);
        env = env * env * (3 - 2 * env);
        ang = W.a0 + W.dir * (W.t / WAVE_LAP) * Math.PI * 2;
        W.env = env;
        if (u) u.value.set(ang, WAVE_RISE * env, WAVE_W, 0);
        // Phones come up for the wave (game.js eases _phoneLevel back down after).
        this._phoneLevel = Math.max(this._phoneLevel || 0, 0.8 * env);
      }
    }

    // Phones: the band's go bright and ride up with their seat; at high energy all sway on
    // the beat (one side-to-side per two beats), along the stand so it reads from the ring.
    if (!ph || !ph.group.visible && env <= 0) return;
    const swayAmp = L.reduce ? 0 : 0.09 * Math.max(0, Math.min(1, (L.energy - 0.55) / 0.3));
    const sway = swayAmp > 0 ? swayAmp * Math.sin((L.beatN + L.phase) * Math.PI) : 0;
    for (const s of ph.pool) {
      const ud = s.userData;
      let band = 0;
      if (env > 0) {
        let dA = ud.ang - ang + Math.PI;
        dA -= Math.floor(dA / (Math.PI * 2)) * Math.PI * 2;
        dA -= Math.PI;
        band = env * Math.exp(-(dA * dA) / (WAVE_W * WAVE_W));
      }
      ud.lift = band * WAVE_RISE;
      ud.dx = Math.cos(ud.ang) * sway;
      ud.dz = -Math.sin(ud.ang) * sway;
      const k = 1 + band * 0.9;
      s.scale.set(0.06 * k, 0.1 * k, 1);
      const want = band > 0.3 && L.hotMat ? L.hotMat : ph.mat;
      if (s.material !== want) s.material = want;
    }
  }

  /** Debug read-out for the headless harness. */
  _ledProbe() {
    const L = this._led;
    if (!L) return null;
    return {
      energy: +L.energy.toFixed(2), pulse: +L.pulse.toFixed(2), beatSrc: this.beat ? 'audio' : 'fallback',
      wave: L.wave.t >= 0 ? { t: +L.wave.t.toFixed(2), reason: L.wave.reason } : null, waveCd: +L.waveCd.toFixed(1),
      reduce: L.reduce,
      lens0: this._rigLenses?.[0]?.material.emissiveIntensity,
    };
  }

  _ledDispose() {
    const L = this._led;
    if (!L) return;
    this._ledWaveStop();
    L.group.parent?.remove(L.group);
    L.hotMat?.dispose();
    this._led = null;
  }
}

export const LedBoards = LedBoardsMethods.prototype;
