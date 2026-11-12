// show.js — the showtime bus: one event stream the presentation modules hang off, so none of
// them has to patch the fight code. Mixin (mixin.js), `this` is the live game.
//
// Modules (each its own file, each a mixin with an `_init*` that registers here):
//   audioShow.js   — charge riser, beat-locked stingers, camera-aware mix, crowd rhythm
//   chargeAura.js  — the fist/shoe aura while an attack is held
//   balloons.js    — convention balloon drop + bunting cloth
//   ledBoards.js   — apron LED ribbon boards, beat-pulsed truss, phone-light wave
//   replay.js      — the instant replay between the KO and the result
//   resultGlass.js — the frozen-frame glass behind the result
//
// A module registers in its `_init*`:
//   this._onShow(fn)          fn(type, data) for every event below
//   this._onShowUpdate(fn)    fn(dt) every render frame (wall-clock dt, after _updateFx)
//   this._onShowRender(fn)    fn(now) right after composer.render(), same task (frame readable)
//   this._onShowDispose(fn)   fn() at engine teardown, before the scene traverse
//
// Events (`data` fields):
//   'countdown'   {}                                   a round's countdown begins
//   'fight'       {}                                   the bell: phase → fighting
//   'chargeStart' { f, name }                          an attack starts coiling (f.chargeAmt fills 0..1)
//   'release'     { f, name, chargeAmt }               the swing is thrown
//   'hit'         { attacker, defender, dmg, point, region, power }   a landed hit (power 0..1)
//   'block'       { point }                            a blocked strike
//   'super'       { f }                                a signature move fires
//   'ko'          { winner }                           the final blow (phase → ko)
//   'result'      { winner, ko }                       the result is reported (after the KO / bell)
//   'cut'         { shot, whip }                       director camera cut (CPU-only modes)
//   'reset'       {}                                   a new match is being set up
//
// Presentation only: handlers use Math.random, never `this.rng` (seeded replays, online lockstep).
// A throwing handler is logged and skipped, never allowed to take the fight down.
//
// Simple vs Full show (the settings sheet's "Brawl show" row, PoBrawlShowPrefs.razor). Simple, the
// default, registers only the modules that carry fight information — the sound design and the
// charge aura. Full adds the dressing: balloons, LED boards, the instant replay and the result
// glass (plus, elsewhere, the KO shatter and pyro, the comic KO words, the crowd's camera flashes,
// the belt ceremony and the director's TV cuts — each gated on _fullShow()). A module that never
// registered costs nothing: the bus only calls what registered, and _replayBegin is absent or
// answers false.
//
// The four Full-only modules (~2,300 lines) are not even fetched under Simple: _initShow
// import()s them the first time an engine boots with Full on (switching it on in the settings
// sheet mid-session lands on the next fight, like every show setting), mixes them into the
// game's prototype and runs their inits. The returned promise is part of the engine's warm-up
// (game.js start), so their geometry and shaders compile under the VS splash, exactly as before.

import { AudioShow } from './audioShow.js';
import { ChargeAura } from './chargeAura.js';
import { mixin } from './mixin.js';

export const SHOW_MODULES = [AudioShow, ChargeAura];

// One fetch per page session, shared by every engine after it. Cleared on failure so a flaky
// network gets another try at the next fight.
let fullModules = null;
function loadFullShow() {
  fullModules ||= Promise.all([
    import('./balloons.js'), import('./ledBoards.js'), import('./replay.js'), import('./resultGlass.js'),
  ]).then(([b, l, r, g]) => [b.Balloons, l.LedBoards, r.Replay, g.ResultGlass])
    .catch((e) => { fullModules = null; throw e; });
  return fullModules;
}

/** True when the player chose the Full show in the settings sheet; Simple otherwise (and by default). */
export function fullShow() {
  try { return localStorage.getItem('pominigames:pobrawl-show') === 'full'; } catch { return false; }
}

function guard(label, fn, ...args) {
  try { return fn(...args); } catch (e) { console.warn(`[PoBrawl] show ${label} failed`, e); return undefined; }
}

class ShowMethods {
  /**
   * Register the show modules. Returns a promise when the Full layers are still loading (the
   * engine's warm-up waits on it), null when there is nothing to wait for.
   */
  _initShow() {
    this._showFns = { ev: [], up: [], render: [], dispose: [] };
    // Read once per engine: a fight keeps the show it started with.
    this._showFull = fullShow();
    this._runShowInits([this._initAudioShow, this._initChargeAura]);
    if (!this._showFull) return null;
    return loadFullShow().then((mods) => {
      if (this.disposed || !this._showFns) return;
      mixin(Object.getPrototypeOf(this), ...mods);
      this._runShowInits([this._initBalloons, this._initLedBoards, this._initReplay, this._initResultGlass]);
    }).catch((e) => {
      // The fight goes on as Simple: nothing registered, so nothing is called.
      console.warn('[PoBrawl] Full show failed to load', e);
    });
  }

  _runShowInits(inits) {
    for (const init of inits) {
      if (typeof init === 'function') guard('init', () => init.call(this));
    }
  }

  /** The Full show is on for this engine (see the header). */
  _fullShow() {
    return this._showFull ?? fullShow();
  }

  _onShow(fn) { this._showFns?.ev.push(fn); }
  _onShowUpdate(fn) { this._showFns?.up.push(fn); }
  _onShowRender(fn) { this._showFns?.render.push(fn); }
  _onShowDispose(fn) { this._showFns?.dispose.push(fn); }

  _show(type, data = {}) {
    const fns = this._showFns?.ev;
    if (!fns) return;
    for (const fn of fns) guard(type, fn, type, data);
  }

  _updateShow(dt) {
    const fns = this._showFns?.up;
    if (!fns) return;
    for (const fn of fns) guard('update', fn, dt);
  }

  _renderShow(now) {
    const fns = this._showFns?.render;
    if (!fns) return;
    for (const fn of fns) guard('render', fn, now);
  }

  _disposeShow() {
    const fns = this._showFns?.dispose;
    if (!fns) return;
    for (const fn of fns) guard('dispose', fn);
    this._showFns = null;
  }
}

export const Show = ShowMethods.prototype;
