// game.js — the Game: construction, the phase machine, the rAF loop and the per-frame step
// order, and the C# callback seam. Each system's methods live in a mixin module (ghost, input,
// director, course, results, online) and are copied onto Game.prototype at the bottom.
import * as THREE from 'three';
import { createScene } from './scene.js';
import { createWorld, stepWorld } from './physics.js';
import { mapById, DEFAULT_MAP_ID } from './maps.js';
import { createMarbles, MARBLE_COUNT, SKINS } from './marbles.js';
import { load as loadSave, update as updateSave, readBest } from './store.js';
import { createAudio } from './audio.js';
import { GhostMixin } from './ghost.js';
import { InputMixin } from './input.js';
import { DirectorMixin } from './director.js';
import { CourseMixin } from './course.js';
import { ResultsMixin } from './results.js';
import { OnlineMixin } from './online.js';
import { RivalsMixin } from './rivals.js';
import { PerfMixin } from './perf.js';
// Weather + glass: classic-style IIFE modules imported as modules, they self-register
// on window and run once.
import '../weather.js';
import '../glassFx.js';

import {
  RACE_TIMEOUT, TICK_INTERVAL, SLOWMO_DIST, SLOWMO_SCALE, GUEST_COLOR,
} from './tuning.js';


export class Game {
  /**
   * @param {string} containerId
   * @param {object|null} dotnetRef
   * @param {boolean} demo
   * @param {number} mapId which map to race (see maps.js). Falls back to the default.
   * @param {*} asset whatever that map's load() resolved to — a parsed glTF scene for the GLB
   *   course, null for the procedural one. Loading happens BEFORE the Game is constructed so the
   *   frame loop never has to run trackless; index.js owns that await.
   * @param {object|null} online null for a local game, else { role: 'host'|'guest', seed, guestIndex }.
   * @param {object|null} marble the player's { skin, weight } from the intro card, or null.
   */
  constructor(containerId, dotnetRef, demo, mapId, asset, online, marble) {
    this.container = document.getElementById(containerId);
    this.dotnet = dotnetRef || null;
    this.demo = !!demo;
    this.map = mapById(mapId === undefined ? DEFAULT_MAP_ID : mapId);
    this.mapAsset = asset;
    // Online role, or null for a local game.
    this.online = online || null;
    this.isGuest = !!online && online.role === 'guest';
    this.guestIndex = online ? online.guestIndex : -1;
    this._guestSteer = 0;      // host: the guest's held direction as last relayed, -1/0/+1
    this._sentSteer = 0;       // guest: last direction sent, so only changes cross the wire
    this._netAccum = 0;
    this._netTick = 0;
    this._netFinish = 0;       // guest: finish order, in the order the host's frames report it
    this._guestHud = null;
    this.scene = createScene(this.container);
    this.scene.setTheme(this.map.theme);
    const w = createWorld();
    this.world = w.world;
    this.materials = w.materials;
    this.audio = createAudio();

    this.phase = 'pick';
    this.score = 0;
    this.streak = 0;
    this.best = readBest();
    this.chosen = -1;
    // The races of the current scoring run, sent with each result so a board submission can be
    // recomputed server-side (MarbleRaceRunVerifier). A miss empties it along with the score.
    this.runRaces = [];
    // The player's marble. Demo and an online guest race the default (the guest's pick would
    // have to cross the wire to reach the host's physics). A skin the best run has not unlocked
    // falls back to the default rather than trusting whatever localStorage says.
    this.marbleOpts = { glass: this.scene.heavy };
    if (marble && !this.demo && !this.isGuest) {
      const sk = SKINS.find((k) => k.id === marble.skin);
      this.marbleOpts.skin = sk && sk.need <= this.best ? sk.id : 'swirl';
      this.marbleOpts.weight = marble.weight;
      updateSave((s) => { s.marble = { skin: marble.skin, weight: marble.weight }; });
    }
    this._leaders = [];        // this frame's top rivals, for the glass + trails (marbles.js sync)
    this._touch = new Set();   // marble bodies touching a static body this step (_markContacts)
    this._sector = 0;          // next checkpoint the player's marble has to pass
    this._sectorStart = 0;
    this._surface = 'surface'; // what the camera's marble is rolling on, for the audio bed
    this._airT = 0;
    this._ghostOn = loadSave().ghostOn;
    this._ghost = null;        // { best: {time, track}|null, mesh, times, vals, next } for the race in progress
    // Only procedural maps re-roll between races (map.regenerate). The authored course is fixed
    // content, so _nextTrack() resets the field on the SAME track rather than rebuilding it —
    // which also spares it rebuilding hundreds of trimesh colliders every race.
    // Date.parse(new Date().toString()) round-trips through a second-precision string, so two
    // loads in the same second raced the identical track. Use the raw epoch ms.
    this.seed = ((Date.now() & 0xffffff) ^ 0x9e3779) >>> 0;
    // Online: both browsers build the course from the seed the server dealt, not from the clock.
    if (this.online) this.seed = this.online.seed >>> 0;
    this.track = null;

    // Weather derives from the race seed, so every client of the same
    // seed computes the same sky with zero network traffic. It is an optional
    // module — a missing one costs atmosphere, never functionality. (Placed after
    // the seed assignment: the seed IS the weather input.)
    this._weatherType = window.PoWeather?.apply({ seed: String(this.seed), stage: this.container }) || 'clear';
    // Scene-composited glass behind the pick card and podium panels.
    // Deferred a beat — the renderer canvas exists by now, but its first frame
    // does not, and glassFx captures live so the panels update as the race runs.
    setTimeout(() => {
      const canvas = this.container.querySelector('canvas');
      if (canvas) this._glassStop = window.PoGlass?.attachHud(canvas, '.mr-pick-card, .mr-place, .mr-countdown');
    }, 1200);
    this.marbleSet = null;
    this.raceClock = 0;
    this.tickAccum = 0;
    this.resultTimer = 0;
    this.disposed = false;
    this._raf = 0;
    this._lastTs = 0;

    // player verb — lateral steering, held via keyboard or the on-screen pads
    this._steerLeft = false;
    this._steerRight = false;
    this._steerSparkAccum = 0;
    this._wasBoosting = false;

    // director
    this.slowmo = false;
    this._lastFocus = null;
    this._shotMarble = null;    // current subject; with _shotSince it drives the hysteresis above
    this._shotSince = 0;

    this._buildTrack();
    this._bindKeys();
  }

  // ── public API (called from index.js / interop) ──
  start() {
    this.audio.resume();
    this._lastTs = 0;
    this._paused = true; // 2026-07-19: gate the rAF loop on resume() so the
                         // engine can't run the pick countdown and racing
                         // phase while the intro modal is still up.
    const loop = (ts) => {
      if (this.disposed) return;
      const now = ts || performance.now();
      const dt = this._lastTs ? (now - this._lastTs) / 1000 : 0.016;
      this._lastTs = now;
      if (!this._paused) this._frame(Math.min(dt, 0.05));
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    // Demo mode is auto-cycled by the kiosk; it gets the same pause gate
    // (the intro card flashes for DemoDelayMs then calls resume()).
    if (this.demo) this._autoPickSoon();
  }

  // The constructor calls _setPhase('pick'), and an auto-pick would start a 3s
  // countdown, all while the intro modal is still on screen. resume() is the
  // explicit acknowledgment from the host that the intro is dismissed and the
  // engine may now run the pick phase (and the rAF tick).
  resume() {
    if (this._paused) {
      this._paused = false;
      this._lastTs = 0; // discard the dt we accumulated while paused
      // Re-emit the current phase so the host can sync its overlay state.
      this._invoke('OnPhase', this.phase, this.chosen, this.score, this.best, this.streak, this.seed | 0);
    }
  }

  pick(index) {
    if (this.phase !== 'pick') return;
    if (index < 0 || index >= MARBLE_COUNT) return;
    this.chosen = index;
    this._steerLeft = this._steerRight = false;
    this._sector = 0;
    this._sectorStart = 0;
    this._setPhase('racing');
    this.raceClock = 0;
    this.tickAccum = TICK_INTERVAL;
    for (const m of this.marbleSet.marbles) m.prevPlace = -1;
    this.scene.followTarget(this.marbleSet.marbles[index].mesh.position, 0, true);
    this.scene.punchFov();   // a quick FOV widen as the race kicks off
    this.audio.resume();
    this.audio.playGun();
    this._armGhost();
  }

  regenerate() {
    if (this.phase !== 'pick') return; // R re-rolls the course before the start, never after a race
    this._nextTrack();
  }

  setMuted(m) { this.audio.setMuted(m); }

  beep(final) { this.audio.playBeep(!!final); }

  dispose() {
    this.disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._unbindKeys();
    this._perfDispose();
    this._dropGhost();
    if (this.marbleSet) this.marbleSet.dispose();
    if (this.track) this.track.dispose();
    this.audio.dispose();
    this.scene.dispose();
    // Teardown: the glass capturer holds a capture interval and
    // the weather overlay a rAF loop — both must die with the game.
    if (this._glassStop) this._glassStop();
    window.PoWeather?.stop();
  }

  // ── internals ──
  // Builds the course through the active map. A map that says it can regenerate (the procedural
  // chute) gets a fresh track per race; one that cannot (an authored model) is built once and
  // reused, which also spares it rebuilding hundreds of trimesh colliders every race.
  _buildTrack() {
    this._podiumSent = false; // reset the top-3 podium for the new race
    this._dropGhost();
    if (this.track && this.track.regenerate) {
      this.scene.remove(this.track.group);
      this.track.dispose();
      this.track = null;
    }
    if (!this.track) {
      this.track = this.map.build(this.world, this.materials, MARBLE_COUNT, this.mapAsset, this.seed);
      this.scene.add(this.track.group);
    }
    // The map's acoustics (maps.js `reverb`); zones are measured against the course length.
    this.audio.setReverb(this.map.reverb, this.track.length);
    this.marbleSet = createMarbles(this.world, this.materials, this.track.startPositions, -1,
      (v, pos, color, material) => {
        // Impact sound by energy and by what was hit (audio.js playImpact). Soft taps are quiet
        // and short there, and its voice pool caps a pile-up, so the gate can sit low.
        // #9: placed in the stereo field by where the hit happened on screen.
        if (v > 3) this.audio.playImpact(v, material, this.scene.audioCue(pos));
        this.scene.burstSparks(pos, color, Math.min(14, 4 + Math.floor(v)), Math.min(1.6, 0.5 + v * 0.12));
        // GFX #5: a genuinely heavy hit lights the track around it for a beat. Gated harder than
        // the clink, or traffic would strobe.
        if (v > 14) this.scene.pulseLight(pos, 0xffd9a0, Math.min(1.5, 0.5 + v * 0.04));
        // The same heavy hit holds the frame for a beat. Local races only: online, the host's
        // clock is the guest's race, and one player's hit should not stall the other's view.
        if (v > 14 && !this.online) window.PoImpact?.hitstop?.(45);
      },
      // Marble-only specular environment (realism pass #3). Bound as `envMap` on the marble
      // materials alone — deliberately NOT scene.environment, so the track stays matte.
      this.scene.marbleEnv,
      // Online: the guest's marble is recoloured so both humans can find themselves in the pack.
      this.online ? { [this.guestIndex]: GUEST_COLOR } : null,
      this.marbleOpts);
    // One group, not 101 meshes: the pack is a single InstancedMesh now (marbles.js #1), and the
    // player's Mesh rides in the same group.
    this.scene.add(this.marbleSet.group);
    this.scene.add(this.marbleSet.decorations);
    this.chosen = -1;
    this.slowmo = false;
    this._guestSteer = 0;
    this._netFinish = 0;
    this._guestHud = null;
    this._gradeState = '';        // #3 — force the next _setGrade through even if the name repeats
    // Drop the director's references into the marble set we just disposed — a stale _shotMarble
    // would keep the hysteresis holding a shot on a marble that is no longer in the world.
    this._shotMarble = null;
    this._lastFocus = null;
    this._leaders = [];
    this._setPhase('pick');
    // frame the start gate from above, looking along the track rather than down world +Z
    this.scene.followTarget(this.track.overviewTarget, 0, true, this.track.dirAt(0));
  }

  // #3 — request a colour grade. Deduped because this is called from the frame loop: setGrade
  // itself is cheap, but re-arming the same target every frame would be noise in a profile and
  // makes the intent unreadable. scene.js eases toward whatever is set, so changes are always
  // transitions.
  _setGrade(name) {
    if (this._gradeState === name) return;
    this._gradeState = name;
    this.scene.setGrade(name);
  }

  _setPhase(p) {
    this.phase = p;
    // Grade follows the phase. 'result' deliberately doesn't set one — _resolve has already
    // chosen win/loss by then, and overwriting it here would wash that straight out.
    if (p === 'pick') this._setGrade('pick');
    else if (p === 'racing') this._setGrade('racing');
    // Skip phase notifications while the intro is up. The host can't react to OnPhase('pick') until resume()
    // fires anyway, and a notify during intro would race the host's
    // StartPickCountdown. The constructor's first _setPhase('pick') is
    // simply held until resume() flushes it.
    if (this._paused) return;
    // The seed rides along (appended — positional contract) so an online host can relay it and
    // the guest builds the same next course. Sent as int32; the receiver restores the uint32.
    this._invoke('OnPhase', p, this.chosen, this.score, this.best, this.streak, this.seed | 0);
  }

  _nextTrack(seed) {
    if (this.marbleSet) { this.scene.remove(this.marbleSet.group); this.scene.remove(this.marbleSet.decorations); this.marbleSet.dispose(); }
    // An online guest is handed the host's seed; everyone else rolls the LCG forward.
    this.seed = seed !== undefined ? (seed >>> 0) : (this.seed * 1664525 + 1013904223) >>> 0;
    // Whether that seed produces a NEW track depends on the map — see _buildTrack.
    this._buildTrack();
    if (this.demo) this._autoPickSoon();
  }

  _autoPickSoon() {
    // demo mode: assign the red marble after a short beat so the start gate is visible first
    // (the demo camera follows the leader regardless — chosen just needs to be valid).
    this._demoPickAt = performance.now() + 1200;
  }

  _frame(dt) {
    // demo auto-pick
    if (this.demo && this.phase === 'pick' && this._demoPickAt && performance.now() >= this._demoPickAt) {
      this._demoPickAt = 0;
      this.pick(Math.floor(Math.random() * MARBLE_COUNT));
    }

    if (this.phase === 'racing' && this.isGuest) {
      // Guest: no physics, the host's frames are the truth. Everything else below is host-only.
      this._guestRacingFrame(dt);
    } else if (this.phase === 'racing') {
      const lbPre = this.marbleSet.leaderboard();
      const leaderPre = lbPre[0];
      // Slow-motion as the leader runs at the line. sdt scales the simulation, so finish
      // times stay measured in simulation seconds and remain comparable across races.
      this.slowmo = !!leaderPre && !leaderPre.finished &&
        (this.track.finishS - leaderPre.s) < SLOWMO_DIST;
      // Hit-stop rides the same scale: impactBus holds time at 0.12 for a few dozen ms after a
      // heavy hit or the winner's finish (1 otherwise, and always 1 under reduced motion).
      const want = (this.slowmo ? dt * SLOWMO_SCALE : dt) * (window.PoImpact?.getTimeScale?.() ?? 1);

      this.track.driveMotors();
      this._applySteer(want);   // player's held steering, integrated by the step below
      this._steerRivals(want);  // the CPU field's personalities (rivals.js), same push, capped
      this._savePrev();
      // sdt is the time the physics actually advanced, which is less than `want` on any frame
      // where cannon-es gives up catching up (see stepWorld). Everything below runs on it: with
      // the race clock on `want`, a page at 15 fps ran the clock at twice the pace of the marbles
      // and the race ended at RACE_TIMEOUT with two thirds of the field still on the course.
      const stepT0 = performance.now();
      const sdt = stepWorld(this.world, want);
      this._stepMs = performance.now() - stepT0;   // perf.js overlay
      // Interlock, not tuning: cannon-es has no CCD and the course's collision shell is a single
      // surface with nothing behind it, so a marble must never carry a velocity that would step
      // it further than its own diameter. See MAX_SPEED in marbles.js.
      this.marbleSet.clampSpeeds();
      // Containment is single-sided; a fast head-on hit can carry a marble through it in one
      // step. Trace this frame's paths and put any crossing back inside (track.sweepGuard).
      this._guardContainment();
      // Re-project the field onto the centerline FIRST: `s` is the ranking key, the finish test
      // and the bounds test, and every one of those below would read last frame's positions
      // otherwise.
      this.marbleSet.updateProgress(this.track);
      // Both read each marble's `s`, so they run after the re-projection above. Their impulses
      // land on the next step, exactly as they did when this was keyed on world z.
      this._applyBoost(sdt);
      this._applyBrakes(sdt);
      this._applyKickers();
      this._markContacts();
      this._applyDrive(sdt);
      this._unstick(sdt);
      this._surface = this._surfaceOf(this._lastFocus, dt);
      this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
      for (const p of this.track.paddles) { p.mesh.position.copy(p.body.position); p.mesh.quaternion.copy(p.body.quaternion); }

      this.raceClock += sdt;
      // Finishes are resolved BEFORE the out-of-bounds sweep. Crossing the line is terminal:
      // a marble that has already finished is frozen and can't fall, and one that crosses and
      // drops in the same step has still finished. Sweeping first meant a marble past the
      // line could be scored as eliminated instead of a finisher.
      const { justFinished } = this.marbleSet.checkFinishes(this.track.finishS, this.raceClock);

      // Remove any marble that has genuinely left the course (course.js _sweepLost).
      this._sweepLost(sdt);

      // Recomputed after the sweep rather than taken from checkFinishes: a marble eliminated
      // just above is out of the race too, and the race ends once nothing is still running.
      const allDone = this.marbleSet.marbles.every((m) => m.finished || m.eliminated);

      for (const m of justFinished) {
        this.scene.burstConfetti(m.mesh.position);   // celebrate each ball crossing the line
        // #24 GPU fountain: big for the winner and for your own marble, a small one for the pack.
        this.scene.burstFx?.('finish', m.mesh.position, null, m.finishOrder === 0 || m.index === this.chosen);
        // #9 — spatialized, so a pack crossing ahead of you spreads across the stereo field
        // instead of stacking a hundred identical chimes dead centre.
        this.audio.playFinish(this.scene.audioCue(m.mesh.position));
        if (m.index === this.chosen) { this._celebrateOwnFinish(m, m.finishOrder + 1); this._keepGhost(m.finishTime); }
      }
      this._tickGhost();
      // Rack the focus for the WINNER only. Firing it per finisher
      // would re-trigger it a hundred times as the pack crosses, which reads as
      // the image pumping rather than as a photo finish.
      if (justFinished.length && justFinished.some((m) => m.finishOrder === 0)) {
        // Only when the shot is ON the winner: the focus plane is the chase distance, so with the
        // camera locked to your own marble back in the pack it blurred your view of the course.
        if (this._lastFocus && this._lastFocus.finishOrder === 0) {
          this.scene.photoFinish();
          this.scene.finishSwoop?.();   // #26 swing round the winner (off on Lite / reduced motion)
        }
        window.PoImpact?.impact('win', 1);
        // Photo-finish post preset + the finish-gate chime.
        window.PoImpactFx?.win(1);
        window.PoMaterialAudio?.hit('glass', 0.7);
      }
      // Photo finish: 2nd crossed within a hair of the winner (audio sting + announcer).
      const second = justFinished.find((m) => m.finishOrder === 1);
      if (second) {
        const first = this.marbleSet.marbles.find((m) => m.finishOrder === 0);
        if (first && second.finishTime - first.finishTime < 0.05) this.audio.playPhotoFinish();
      }
      // Podium: the moment the 3rd marble crosses, freeze the top-3 (winner + 2)
      // with their gaps behind the winner and push it to the HUD overlay.
      if (!this._podiumSent && this.marbleSet.marbles.filter((m) => m.finished).length >= 3) {
        this._podiumSent = true;
        this._sendPodium();
      }
      if (allDone || this.raceClock >= RACE_TIMEOUT) {
        if (!allDone) this.marbleSet.forceFinishRemaining(this.raceClock);
        this._resolve();
      }

      // One post-step ranking pass, taken after the finish/eliminate sweeps (and any
      // _resolve) above so it reflects this frame's settled standings. Shared by the
      // audio bed and the camera director below — nothing mutates positions or race
      // flags between here and the _pickShot call.
      const order = this.marbleSet.leaderboard();

      // Audio beds, colour grade, camera and sector splits: shared with the online guest's frame.
      this._presentRace(order, dt, this._surface);

      this.tickAccum += dt;
      if (this.tickAccum >= TICK_INTERVAL) { this.tickAccum = 0; this._sendTick(); }
      if (this.online && !this.isGuest) this._netSend(dt);
    } else if (this.phase === 'result') {
      // keep the paddles/marbles visually settled; advance after the banner
      this.marbleSet.sync(this.track, this.scene.camera.position, this._leaders);
      this.resultTimer -= dt;
      const winner = this.marbleSet.leaderboard()[0];
      if (winner) {
        const ws = winner.s;
        this.scene.followTarget(this.track.centerAt(ws), dt, false, this.track.dirAt(ws));
      }
      // The demo rolls on, and so does a solo run that is still alive (a top-10 finish keeps
      // the streak going, like Brawl's ladder). A miss ends here on the page's end-of-game modal.
      // Online, the host waits on the page: both players agree to a rematch (rematch() below).
      if (this.resultTimer <= 0 && (this.demo || (!this.online && this._runAlive))) this._nextTrack();
    } else {
      // pick phase: gentle overview of the start gate. The heading matters here too — without
      // it the camera sat straight back in world -Z while the track headed off at an angle,
      // which threw the road across one side of the frame before the race even started.
      const ov = this.track.overviewTarget;
      this.scene.followTarget(ov, dt, false, this.track.dirAt(0));
    }

    this._perfBeforeRender();
    const renderT0 = performance.now();
    this.scene.render();
    this._renderMs = performance.now() - renderT0;   // perf.js overlay
    this._perfFrame();
  }

  // C# is handed primitives and parallel arrays rather than JSON strings on the hot paths. Colours
  // and names are omitted; C# derives them from the marble index (0 = the red player, the rest
  // from PACK_PALETTE).
  _invoke(method, ...args) {
    if (!this.dotnet) return;
    // invokeMethodAsync rejects asynchronously, so a bare try/catch here would never see the
    // failure — it has to be caught on the promise.
    try {
      const p = this.dotnet.invokeMethodAsync(method, ...args);
      if (p && p.catch) p.catch(() => { });
    } catch { }
  }
}

// The Game class body is split by system; each mixin's methods land on Game.prototype, so
// `this` is the Game everywhere and call sites are unchanged.
for (const M of [GhostMixin, InputMixin, DirectorMixin, CourseMixin, ResultsMixin, OnlineMixin, RivalsMixin, PerfMixin]) {
  for (const k of Object.getOwnPropertyNames(M.prototype)) {
    if (k !== 'constructor') Object.defineProperty(Game.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
  }
}
