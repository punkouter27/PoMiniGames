// index.js — public interop surface for PoBrawl. The Blazor page calls these.
import { BrawlGame } from './game.js';
import * as SelectStage from './selectStage.js';

let game = null;

window.PoBrawl = {
  /**
   * 2P fighter select: live portraits in the tiles and side cards (selectStage.js), one
   * shared WebGL context. Ids are fighters.js CHARACTERS keys; primitives only, so the
   * trimmed WASM client needs no interop DTO.
   *   mount(hostId, p1, p2, p1Locked, p2Locked) → false when this device gets plain tiles
   *   update(p1, p2, p1Locked, p2Locked)        cursor/lock changes (cues, poses)
   *   versus(hostId) → Promise                  both locked: sting + slash, then fight
   *   unmount()                                 dispose + force the context loss
   */
  select: {
    mount: (hostId, p1, p2, p1Locked, p2Locked) => SelectStage.mount(hostId, { p1, p2, p1Locked, p2Locked }),
    update: (p1, p2, p1Locked, p2Locked) => SelectStage.update({ p1, p2, p1Locked, p2Locked }),
    versus: (hostId) => SelectStage.versus(hostId),
    unmount: () => SelectStage.unmount(),
    stats: () => SelectStage.stats(),
  },
  /**
   * options: { mode: '1p'|'2p'|'tournament'|'online', p1Character, p2Character, difficulty,
   *            training?: boolean (1P only),
   *            localSide?: 1|2 (online; 0 or absent = spectating), seed?,
   *            roundLabel? (tournament: the first bout's splash heading),
   *            round?: 0|1|2, p1Expected?: 0..1 (tournament: see matchup's `opts`),
   *            director?: boolean, isoCam?: boolean (tournament camera; default = the Full show) }
   * The /pobrawl/demo route is the Cup: mode 'tournament'.
   */
  init(containerId, dotnetRef, options) {
    // The select screen's context must be gone before the arena takes its own.
    SelectStage.unmount();
    if (game) { game.dispose(); game = null; }
    const el = document.getElementById(containerId);
    if (!el) { console.error('[PoBrawl] container not found:', containerId); return; }
    game = new BrawlGame(el, dotnetRef, { ...options });
    game.start();
    // Headless harnesses: ?debug (or localStorage pobrawl.debug) exposes the live engine as
    // window.__pobrawl(). The sign-in redirect can drop the query, hence the storage flag.
    let debug = /[?&]debug/.test(location.search);
    try { debug ||= !!localStorage.getItem('pobrawl.debug'); } catch { /* storage blocked */ }
    if (debug) window.__pobrawl = () => game;
  },
  /**
   * 1P ladder: roll into the next round without a re-init (splash → countdown,
   * no end-of-game modal).
   * @param {string|null} p2Character  new opponent, or null to keep the current one
   * @param {number|string|null} difficulty  new CPU level, or null to keep it
   * @param {string|null} introLine  the PA's ring introduction, read under the splash
   */
  next(p2Character, difficulty, introLine) {
    if (!game) return;
    if (p2Character) game.options.p2Character = p2Character;
    if (difficulty !== undefined && difficulty !== null) game.options.difficulty = difficulty;
    game._introLine = introLine || null;
    game.resetMatch();
  },
  /**
   * Pause menu (1P, training and 2P only; the engine ignores it anywhere else, and outside the
   * countdown and the fight). Every change, from here, Escape/P or the window losing focus,
   * is reported back through the page's [JSInvokable] OnPauseChanged(bool paused).
   */
  setPaused(paused) { if (game) game.setPaused(!!paused); },
  /**
   * Pause menu: run the current bout back from the countdown, same fighters and CPU rung, no
   * re-init and no VS splash. Training: both fighters back on their marks. Unpauses.
   */
  restart() { if (game) game.restart(); },
  /**
   * Tournament: the next bout, both corners chosen by the page. Same re-use path as `next`
   * (no re-init), with the splash heading naming the round.
   * @param {string} p1Character  left corner
   * @param {string} p2Character  right corner
   * @param {string|null} roundLabel  splash heading, e.g. 'SEMIFINAL 1 OF 2'
   * @param {string|null} introLine  the PA's ring introduction
   * @param {{round?: 0|1|2, p1Expected?: number}} [opts]  the bout's round (quarterfinal 0,
   *   semifinal 1, final 2: the arena's time of day and crowd) and the left corner's Elo
   *   expectation (the crowd's upset storyline). Optional; absent = round 0, an even bout.
   */
  matchup(p1Character, p2Character, roundLabel, introLine, opts) {
    if (!game) return;
    game.options.p1Character = p1Character;
    game.options.p2Character = p2Character;
    game._roundLabel = roundLabel || null;
    game._introLine = introLine || null;
    game.cupBout(opts || {});
    game.resetMatch();
  },
  /**
   * Tournament, between bouts: the bracket on the arena's jumbotrons until the next count
   * starts (cup.js cupBoard has the shape: { bouts: [{ p1, p2, w }] ×7, fresh, next, champ, title }).
   */
  jumbotronBracket(data) { if (game) game.cupBoard(data); },
  /** Tournament, after the final: the belt ceremony for the champion (ceremony.js). */
  ceremony(championCharId) { if (game) game.ceremony(championCharId); },
  /** Tournament fast-forward: 1, 2 or 4 fixed sim ticks per real one. */
  setSpeed(multiplier) {
    if (!game) return;
    const m = Number(multiplier);
    game.speed = m === 2 || m === 4 ? m : 1;
  },
  setMuted(muted) { if (game) game.setMuted(muted); },
  /** Tournament: the broadcast director camera (director.js). Player modes ignore it. */
  setDirector(on) { if (game) game.setDirector(!!on); },
  /** Tournament: the picture-in-picture iso cam (medium/high tier, not on phones). */
  setIsoCam(on) { if (game) game.setIsoCam(!!on); },
  /** Diagnostics: the director's live shot and iso state, or null. `force` (a rig name) cuts to it — test hook. */
  director(force) { return game ? game.directorState(force) : null; },
  /**
   * Engine phase ('intro' | 'countdown' | 'fighting' | 'ko' | 'result') or null. The ladder
   * waits on this because the KO cinematic runs on the render clock, which freezes in a
   * hidden tab, while the page's hold delay is wall-clock.
   */
  phase() { return game ? game.phase : null; },
  /** Online: one server snapshot (PoBrawlMatchState, ~10 Hz) — desync check and sync point (netplay.js). */
  net(state) { if (game) game.applyNet(state); },
  /** Online: one confirmed input (PoBrawlMatchInputEvent) — may roll the fight back (netplay.js). */
  netInput(ev) { if (game) game.applyNetInput(ev); },
  /** Online: one clock-sync sample (the server's frame clock, the round trip in ms). */
  netClock(clockFrame, rttMs) { if (game) game.applyNetClock(clockFrame, rttMs); },
  /** Online diagnostics: the rollback session's frame, clock, HP and counters, or null. */
  netStats() {
    const s = game?.online?.session;
    if (!s) return null;
    const st = s.state;
    return { frame: s.frame, anchor: s.anchor?.frame ?? -1, rtt: s.rtt, clock: s.clockSource,
      hp: st ? [st.p1.hp, st.p2.hp] : null, x: st ? [st.p1.x, st.p2.x] : null, ...s.stats };
  },
  /** Training-room controls (training.js). key: 'reset'. No-op outside a training session. */
  training(key) { if (game && key === 'reset') game.resetTraining(); },
  destroy() {
    SelectStage.unmount();
    if (game) { game.dispose(); game = null; }
  },
};
