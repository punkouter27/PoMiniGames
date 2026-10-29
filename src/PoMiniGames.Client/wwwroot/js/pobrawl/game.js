// game.js — PoBrawl match orchestrator.
// Owns: scene, camera, fixed-timestep sim, per-fighter state machine, momentum +
// per-region damage + hit-pause + screen shake + cinematic camera,
// audio bus, and the Blazor interop callbacks.
import * as THREE from 'three';
import { buildArena, animateCrowd, updateAtmosphere, updateRopes, updateBanners, twangRope, damagePost, disposeArenaReflector, RING_HALF } from './arena.js';
import { buildProps, resetProps, updateProps, disposeProps } from './props.js';
import { buildFighter, updateJiggles, setExpression, CHARACTERS, CHARACTER_IDS } from './fighters.js';
import { Animator } from './animation.js';
import { KeyboardController, buildTouchControls, LAYOUTS, padCodes } from './input.js';
import { AiController } from './ai.js';
import { RandomGenerator } from './rng.js';
import { CombatPlay, regionEffect } from './combat.js';
import { PERSONALITIES, makePersonalityState } from './personalities.js';
import * as PostFx from '../postFx.js';
import * as VisualRuntime from '../visualRuntime.js';
import * as Quality from './quality.js';
import { AudioBus } from './audio.js';
import { CannonRagdoll } from './ragdollPhysics.js';
import {
  createPhysicsWorld, stepWorld, buildArenaColliders, createRootBody, syncRigRoot,
} from './physics.js';
// ── Subsystem mixins ────────────────────────────────────────────────────────
// Personality/supers, VFX, KO sequence + camera and hit resolution are mixed
// into BrawlGame's prototype below, so `this` is the live game in each.
// mixin.js explains why prototypes rather than free functions or Object.assign.
import { mixin } from './mixin.js';
import { PersonalityEffects } from './personalityEffects.js';
import { Vfx } from './vfx.js';
import { Blood } from './blood.js';
import { Cinematics, BASE_FOV } from './cinematics.js';
import { HitResolution } from './hitResolution.js';
import { Training } from './training.js';
import { SIM_DT, MAX_HP, ATTACKS, TIME_LIMIT, MAT_HALF } from './constants.js';
import { SceneSetup, ENV_INTENSITY } from './sceneSetup.js';
import { KeyBridge } from '../gamepadBus.js';
import { BrawlHaptics } from './haptics.js';
import { NetController, Netplay } from './netplay.js';
import { Commentary } from './commentary.js';
import { Spectacle, REWIND_SEC } from './spectacle.js';
import { Cup } from './cup.js';
import { Ceremony } from './ceremony.js';
import { Director } from './director.js';
import { Show, SHOW_MODULES } from './show.js';
import { ReactiveArena } from './reactiveArena.js';
import { Lighting } from './lighting.js';
import { HudFeedback } from './hudFeedback.js';

const MAX_FRAME_DT = 0.05;

// KO shot readability caps (_updateFx): afterimage feedback, speedline strength, and the share
// of the rack focus's blur radius kept while the KO camera runs.
const KO_SMEAR_MAX = 0.45;
const KO_SPEED_MAX = 0.25;
const KO_DOF_MUL = 0.6;

// The app-wide reduced-motion flag (user toggle OR OS preference), stamped by
// appPrefs.js on <html data-motion="reduce">. The only comfort switch: gore is
// always on and the calm presentation follows this alone.
function motionReduced() {
  try {
    return document.documentElement.getAttribute('data-motion') === 'reduce';
  } catch {
    return false;
  }
}


// Lateral orbit speed for the circle keys, in the same units as the 2.4 / 1.9
// forward / backward walk. Slightly under the advance so that closing distance
// is still the faster way to cross the ring and circling reads as positioning
// rather than a second, better run.
const CIRCLE_SPEED = 2.0;

// How close the two health bars have to be at TIME! for the decision to be a
// draw rather than a win, in HP points out of MAX_HP (100) — so this reads as
// "within a tenth of a bar". A band, not an exact tie: exact ties are
// unreachable, and ten points (about one clean hit) is the smallest margin a
// player can actually see on the bars.
const DRAW_HP_BAND = 10;

// ── Spawn X by HUD side ────────────────────────────────────────────────────
// Each fighter spawns at the X that lines up with the side their energy bar
// is drawn on by the Blazor HUD:
//   • index 1 → HUD `.pb-hp-side` (no right class) → renders on the LEFT
//   • index 2 → HUD `.pb-hp-side.pb-hp-right`     → renders on the RIGHT
// Negative X projects to the left of the camera (which sits at +Z looking
// toward −Z). Change here, not in `_spawnFighters`, so spawn and HUD agree.
const SPAWN_X_BY_SIDE = { left: -1.6, right: 1.6 };

// ── Overhead house light swing ────────────────────────────────────────────

const MIN_SEPARATION = 0.95;
// Side-view modes (cinematics.js _sideView): the camera never orbits, so the pair is held
// within ~30° of side-on — the circle keys sidestep in depth but can never stack the two
// fighters one behind the other. tan(30°).
const SIDE_VIEW_DEPTH_RATIO = 0.577;

const HITSTUN = 0.35;

// ── Hold-to-charge (Urban Champion style) ────────────────────────────────
// Press-and-hold punch/kick winds the attack up; release throws it. Charge
// scales damage/knockback from a quick tap (1x) to a full hold (CHARGE_MAX_MUL)
// over CHARGE_TIME seconds. Held attacks are intentionally a huge upgrade over
// quick taps, so committing to a full charge is worth the risk.
const CHARGE_TIME = 1.0;
const CHARGE_MAX_MUL = 4.0;


// ── Energy meter ─────────────────────────────────────────────────────────
// One 0..1 pool per fighter — the blue bar under the HP bar in the Blazor HUD.
// It is BOTH how hard this fighter's strikes land and whether they are allowed
// to throw one at all. Design goal: blocking is rewarded and pure offence is a
// losing strategy.
//
//   • winding up drains the pool into the strike (chargeAmt), so the coil is
//     paid for out of the bar and the bar visibly empties as you load up;
//   • releasing costs a further flat ATTACK_ENERGY_COST, which is what taxes
//     tap-spam — a jab banks almost no charge but still pays the toll;
//   • dropping under the floor GASSES the fighter: no punch, no kick, at all,
//     until they have recovered back up to ENERGY_RECOVER_TO (see _canAttack);
//   • blocking refills it fast, idling refills it slowly, and swinging refills
//     it not at all.
//
// Fighters open with a full bar — roughly four spammed punches, or one fully
// committed haymaker. Less would gas a fighter out after two jabs.
const ENERGY_DEFAULT = 1.0;

// Flat toll charged on every swing release, on top of whatever the wind-up
// already drained. This is the anti-spam term: at 0.22 a fighter who only ever
// taps gets roughly four KICKS from a full bar before gassing out, and the idle
// regen below cannot keep up with continuous mashing. Each attack scales it by
// its own `energyMul`, so a punch pays half (≈ eight jabs to a bar) — see the
// ATTACKS table for why the two buttons are priced apart.
const ATTACK_ENERGY_COST = 0.22;

// Hysteresis band for the gate. Falling below ENERGY_ATTACK_FLOOR sets the
// gassed flag; clearing it needs ENERGY_RECOVER_TO, which is deliberately
// higher so an exhausted fighter cannot chip out one more jab the instant a
// single frame of regen lands. That gap is the punishment window.
const ENERGY_ATTACK_FLOOR = 0.22;
const ENERGY_RECOVER_TO = 0.40;

// Regen, as a fraction of a full bar per second, by state. Blocking is ~3.4x
// idle: guarding is the deliberate, rewarded way back into the fight. Swinging
// (the punch/kick states) regenerates
// nothing — you do not catch your breath mid-combination. The KO state is
// exempt entirely; a bar still moving behind the K.O. banner reads as a bug.
const ENERGY_REGEN_PER_SEC = 0.16;
const ENERGY_BLOCK_REGEN_PER_SEC = 0.55;
const ENERGY_HITSTUN_REGEN_PER_SEC = 0.08;




// VS splash hold, shared by the first match and resetMatch.
const SPLASH_HOLD_MS = 1300;

// Mirror match (2P, both players on one president): player 2 wears the alternate kit, the
// suit and tie turned round the colour wheel (and the suit lifted a touch, since most are near
// black), so the two read apart at a glance. Colour only: same materials, no shader recompile.
function altKit(rig) {
  const { suitMat, tieMat } = rig.materials;
  const turn = (mat, base, h, l) => {
    if (!mat) return;
    mat.color.offsetHSL(h, 0.15, l);
    mat.sheenColor?.offsetHSL(h, 0.15, l);
    base?.offsetHSL(h, 0.15, l);
  };
  turn(suitMat, rig.baseColors?.suit, 0.42, 0.1);
  turn(tieMat, rig.baseColors?.tie, 0.5, 0);
}


// Danger state: below this share of max HP a fighter is "in the red"; the
// effect is full strength DANGER_RAMP below it.
const DANGER_HP = 0.25;
const DANGER_RAMP = 0.2;

// The view-transition pseudo-elements live on the document root, which a
// Blazor-scoped stylesheet cannot reach, so the timing for the name flight is
// injected once, globally. Namespaced to pb-name-* and harmless when unused.
function ensureViewTransitionStyle() {
  if (document.getElementById('pb-vt-style')) return;
  const st = document.createElement('style');
  st.id = 'pb-vt-style';
  st.textContent = `
    ::view-transition-group(pb-name-1),
    ::view-transition-group(pb-name-2) {
      animation-duration: 0.62s;
      animation-timing-function: cubic-bezier(.2, .9, .2, 1);
    }
    ::view-transition-old(pb-name-1), ::view-transition-new(pb-name-1),
    ::view-transition-old(pb-name-2), ::view-transition-new(pb-name-2) {
      height: 100%;
      animation-duration: 0.62s;
    }`;
  document.head.appendChild(st);
}


// Scratch vectors.
const _blobPos = new THREE.Vector3();
const _dmgProj = new THREE.Vector3();
const _spotTarget = new THREE.Vector3();
const _blDir = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
const _animVel = new THREE.Vector3();
const _lookA = new THREE.Vector3();
const _lookB = new THREE.Vector3();

export class BrawlGame {
  constructor(container, dotnetRef, options) {
    this.container = container;
    this.dotnet = dotnetRef;
    this.options = options;
    this.muted = false;
    this.disposed = false;
    this.raf = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.timeScale = 1;
    // Fast-forward multiplier (tournament only, see PoBrawl.setSpeed); 1 everywhere else.
    this.speed = 1;
    // Pause menu (setPaused): 1P/2P only, countdown or fight only. Freezes the sim and the loop.
    this.paused = false;
    // Splash heading override for the rounds after the first (tournament bouts).
    this._roundLabel = null;
    // Effects list — sparks, debris, post chunks. Updated each render tick.
    this.effects = [];
    // Renderer-level feedback: hit-pause, screen shake, FOV punch.
    this.hitstopT = 0;
    this.shakeT = 0;
    this.shakeAmp = 0;
    this.fovPunch = 0;
    this.fovBase = BASE_FOV; // _fitFov re-derives it from the container's aspect
    // Post-FX pulses: bloom strength, chromatic aberration, radial blur and
    // exposure spike on hits and KO, then decay exponentially in _updateFx.
    this.caPulse = 0;
    this.bloomPulse = 0;
    this.exposurePulse = 0;
    this.radialPulse = 0;
    // Clash (striker-vs-striker) debounce.
    this._clashCooldown = 0;
    // Spring-damper camera state (see _updateCamera).
    this._camVel = new THREE.Vector3();
    // KO "lights down" blend (0 = house lights, 1 = spotlight-only).
    this.lightsDim = 0;
    // Atmosphere clock — always advances (this.clock only runs while fighting).
    // Driven by the RENDER loop, so it is wall-clock seconds, not sim seconds.
    this.atmoT = 0;
    // ── Simulation clock ────────────────────────────────────────────────
    // Monotonic seconds accumulated in _tick, the fixed-step sim tick. This is
    // the "now" that every timed personality effect is written against
    // (`this.t + cfg.durationSecs`, `this.t < per.iframesUntil`, …).
    // Deliberately NOT reset between rounds: it only has to be monotonic, and
    // per-round state is rebuilt by makePersonalityState on respawn anyway.
    // Advancing on the sim tick rather than alongside atmoT keeps effect
    // durations in step with the simulation that consumes them — hitstop pauses
    // both together instead of letting buffs bleed out during a frozen frame.
    this.t = 0;
    // The PA's ring introduction for the next splash (PoBrawlPage fetches it; PoBrawl.next
    // hands in the next rung's). One-shot: _introHold speaks it and clears it.
    this._introLine = (options && options.introLine) || null;
    // Cinematic state: KO zoom.
    this._setCameraMode('normal', { force: true }); // 'normal' | 'ko' | 'super'
    this.cameraModeT = 0;
    this.koShot = 'side'; // per-KO camera variant: 'side' | 'overhead'
    this.excited = 0; // crowd excitement
    this.audio = new AudioBus();
    // Seeded RNG: pass options.seed to reproduce a match; otherwise a random seed
    // so headlines, KO shots and demo pairings differ per visit.
    this.rng = new RandomGenerator((options && options.seed) || (1 + Math.floor(Math.random() * 0x7ffffffe)));
    // The training room (training.js), 1-player only.
    this.training = options && options.training && options.mode === '1p'
      ? this._makeTraining()
      : null;
  }

  start() {
    // Once per engine: a second call would build a second renderer, scene and rAF loop on top
    // of the first, and dispose() only knows about the latest of each.
    if (this._started || this.disposed) return;
    this._started = true;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 540;
    // Cached host size (kept by _onResize). Per-frame code reads these, never
    // clientWidth: that read forces a synchronous layout of the whole page.
    this._hostW = w;
    this._hostH = h;

    // ── Audio-reactive HUD ──────────────────────────────────────────────
    // Publishes --audio-bass/mid/treble/peak (visualRuntime.js). Off by default
    // there; switched on here and off in dispose so only this page pays for it.
    try { VisualRuntime.enableAudioReactive(true); } catch { /* never block the game on chrome */ }

    // antialias:false is deliberate. Every frame is rendered into the
    // composer's own MSAA target (see _buildComposer) and reaches the canvas
    // as a fullscreen quad in OutputPass — a quad has no interior edges, so a
    // multisampled default framebuffer would be allocated and never resolved
    // against any geometry. The `samples` on composerRT is the real AA.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    // Tier-aware DPR through the SHARED pixel budget (quality.js → PoCanvasDpr.resolve).
    this.renderer.setPixelRatio(Quality.pixelRatio(w, h));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft: percentage-closer soft edges — the fighters' shadows get a
    // real penumbra instead of the stepped PCF look.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // KNOWN WARNING, not ours: on Windows/ANGLE the first program compile logs
    //   THREE.WebGLProgram: Program Info Log: warning X4000: use of potentially
    //   uninitialized variable (dyn_index_vec4_float4_int)
    // The `dyn_index_*` temporaries are emitted by ANGLE's D3D backend when it lowers a
    // dynamic array index, and the vec4 array it trips over is in three's own chunks (the
    // light/shadow arrays in lights_fragment_begin / shadowmap_pars_fragment — this scene's
    // shadow-casting key + spot is what pulls them in). None of this game's GLSL (the
    // particle ShaderMaterial in vfx.js, the onBeforeCompile hooks in arena.js/sceneSetup.js/
    // game.js/matWear.js) indexes an array with a variable — checked. The program still links
    // and renders; the warning is upstream noise, so don't go hunting for a shader bug here.
    // AgX handles saturated bright lights (bloom pulses, colored corner
    // accents) far more gracefully than ACES, which skews hot colors.
    // Measured against ACES/Neutral/Reinhard on a live frame: AgX keeps ~15%
    // of pixels in the midtones where the others crush 95-98% into shadow.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    // Contrast comes from the lighting ratio (key vs hemisphere fill), NOT from
    // exposure — exposure lifts shadows and highlights together, so pushing it
    // just makes a flat image a brighter flat image. Measured: at 1.9 the frame
    // went 99.8% midtones with 0% shadows, visibly worse than 1.15. The real
    // lever is the hemisphere cut + hotter key in arena.js; exposure only takes
    // the small step needed to keep overall level after that cut. Tied to
    // ENV_INTENSITY: without the env fill the rig carries the ambient level alone
    // and needs 1.5; with it, 1.5 would re-flatten the contrast.
    this.exposureBase = ENV_INTENSITY > 0 ? 1.36 : 1.5;
    this.renderer.toneMappingExposure = this.exposureBase;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // ── IBL ─────────────────────────────────────────────────────────────
    // An environment built FROM this arena's own palette (see
    // _buildEnvironment), not a generic studio: RoomEnvironment's white
    // softboxes washed the hall out. Held well under 1 so it fills rather than
    // lights; ENV_INTENSITY 0 disables it with nothing else to change.
    this._buildEnvironment();
    // Light COUNT is fixed at boot from the tier — it is a shader #define, so it
    // cannot track live tier changes without recompiling every material. Shadow map
    // sizes and the post chain are retuned live in _applyQuality below.
    this.arena = buildArena(this.scene, { rectAreaLights: Quality.settings().rectAreaLights });
    // Before _applyTextureAnisotropy, so the jumbotron canvas texture it
    // installs gets filtered along with everything else.
    this._initReactiveArena();

    this.camera = new THREE.PerspectiveCamera(BASE_FOV, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);

    // Post chain: render → GTAO → bloom → CA/vignette → tone-map/sRGB
    // output (see _buildComposer).
    this._buildComposer(w, h);

    // GPU particle pool: one THREE.Points draw call for every spark, sweat
    // droplet and confetti fleck. Additive blending means "fade" is just
    // color → black, so no per-particle alpha attribute is needed.
    this._initParticles();
    // Pooled blood + sweat droplets, stains and wound caps (blood.js).
    this._initBlood();

    // Pooled shock rings + the flat-silhouette / speedline / smear timers.
    this._initShaderKeepers();
    this._initImpactFrames();
    // Shockwave, comic KO, pyro, light kick, rewind, shatter (spectacle.js).
    this._initSpectacle();
    // Tournament only: round looks, crowd fill, Elo storyline, the belt (cup.js, ceremony.js).
    this._initCup();
    // The showtime layer: charge aura, audio show, and under the Full show the balloons, LED
    // boards, replay and result glass, which load on demand (show.js). The warm-up waits for them.
    const showLoad = this._initShow();

    // Impact light pool: reused PointLights flashed at hit points. A fixed
    // pool keeps the scene's light count constant (adding/removing lights at
    // runtime forces shader recompiles).
    this._impactLights = Array.from({ length: 3 }, () => {
      const light = new THREE.PointLight(0xffa050, 0, 5, 2);
      this.scene.add(light);
      return { light, life: 0, dur: 0.15, peak: 0 };
    });
    this._impactCursor = 0;

    // Per-fighter backlights: cool kicker spots behind each fighter, opposite
    // the camera — constant halo separation from the dark background.
    // Repositioned every frame in _updateLighting.
    this._backlights = [0, 1].map(() => {
      const s = new THREE.SpotLight(0x7d95ff, 3.0, 14, Math.PI / 5, 0.85, 1.6);
      s.castShadow = false;
      this.scene.add(s);
      this.scene.add(s.target);
      return s;
    });

    // ── KO Limelight: tight, narrow SpotLight that tracks the ragdoll ──
    // Used during the KO cinematic to follow the falling body and offer
    // that "single bright slash of light over the loser" feel. Intensity
    // starts at 0; spikes to ~6.0 on a KO event and tracks the loser's
    // torso each frame while d > 0.
    this._limelight = new THREE.SpotLight(0xfff0d0, 0, 9, Math.PI / 9, 0.7, 1.0);
    this._limelight.castShadow = false;
    this.scene.add(this._limelight);
    this.scene.add(this._limelight.target);
    this._limelightActive = 0; // 0 = idle, >0 = active timeleft
    this._limelightTarget = new THREE.Vector3();

    // Companion cool "victor halo" — opposite-side kicker that follows the
    // WINNER while the loser has the warm limelight. Together they light
    // both fighters from different angles during the KO cinematic.
    this._victorHalo = new THREE.SpotLight(0xa0c4ff, 0, 12, Math.PI / 6, 0.7, 1.2);
    this._victorHalo.castShadow = false;
    this.scene.add(this._victorHalo);
    this.scene.add(this._victorHalo.target);

    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner';
    this.container.appendChild(this.banner);

    // CSS overlay for chromatic aberration / vignette flash on KO.
    this.flash = document.createElement('div');
    this.flash.className = 'pb-flash';
    this.container.appendChild(this.flash);

    // Floating hit feedback: damage numbers rising off the contact point and a
    // per-fighter combo readout. DOM rather than sprites on purpose — these are
    // screen-space text that must stay crisp and theme-independent, and routing
    // them through three.js would mean a texture atlas and a draw call per
    // number for something the compositor already does for free.
    this.fx = document.createElement('div');
    this.fx.className = 'pb-fx';
    this.fx.innerHTML = `
      <div class="pb-combo pb-combo--p1"><span class="pb-combo__n"></span><span class="pb-combo__label">HIT</span></div>
      <div class="pb-combo pb-combo--p2"><span class="pb-combo__n"></span><span class="pb-combo__label">HIT</span></div>`;
    this.container.appendChild(this.fx);
    this._comboEls = [
      this.fx.querySelector('.pb-combo--p1'),
      this.fx.querySelector('.pb-combo--p2'),
    ];
    this._dmgNodes = [];
    // Ringside commentary + the caption bar every spoken line goes through (commentary.js).
    this._initCommentary();

    // Virtual touch controls for coarse-pointer / portrait-mobile layouts
    // (CSS decides visibility). Buttons dispatch synthetic KeyboardEvents,
    // so the P1 KeyboardController — including hold-to-charge and the
    // tap-vs-hold block key — works unchanged.
    const spectating = this.options.mode === 'online' && !this.options.localSide;
    // The tournament is CPU vs CPU: nobody to hand a pad or touch controls to.
    const cpuOnly = this.options.mode === 'tournament';
    if (!cpuOnly && !spectating) {
      this.touchEl = buildTouchControls(this.container, this.options.mode === 'online');
    }

    // Controllers drive the same key codes as the keyboard (gamepadBus.js KeyBridge + padCodes).
    // 1P: the first pad is player 1. 2P: first pad P1, second P2, and each keeps its slot
    // until it is unplugged. Tournament: none.
    if (!cpuOnly) {
      this.gamepads = new KeyBridge(this.options.mode === '2p' ? [1, 2] : [1], (pad, layout) => padCodes(pad, LAYOUTS[layout]));
    }
    // Rumble and phone buzz for the humans only (haptics.js); CPU-only and spectated fights get
    // an inert router that still claims the platform haptics, so nothing buzzes on their behalf.
    this.haptics = new BrawlHaptics(this, { active: !cpuOnly && !spectating });

    // Inter-round splash. Created once; reused via _showSplash() so the
    // browser doesn't pay the cost of mounting a new DOM node every match.
    this.splash = document.createElement('div');
    this.splash.className = 'pb-splash';
    // Fight-card layout: two name cards slam in and meet at a spinning seal.
    // The name spans are what the View Transition in _hideSplash flies up
    // into the HUD.
    this.splash.innerHTML = `
      <div class="pb-splash__inner">
        <div class="pb-splash__round"></div>
        <div class="pb-splash__cards">
          <div class="pb-splash__card pb-splash__card--p1"><span class="pb-splash__p1"></span></div>
          <div class="pb-splash__seal" aria-hidden="true"><span class="pb-splash__versus">VS</span></div>
          <div class="pb-splash__card pb-splash__card--p2"><span class="pb-splash__p2"></span></div>
        </div>
      </div>`;
    this.container.appendChild(this.splash);
    this._splashHide = 0; // wall-clock at which the splash should fade out

    this._onResize = () => {
      const cw = this.container.clientWidth, ch = this.container.clientHeight;
      if (!cw || !ch) return;
      this._hostW = cw;
      this._hostH = ch;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      // The pixel budget is a function of the CSS size, so a resize can change the
      // resolved DPR even though the tier has not moved — a window dragged from a
      // quarter of the screen to fullscreen is exactly the case the budget exists
      // for, and re-resolving here is what keeps it enforced after boot.
      this.renderer.setPixelRatio(Quality.pixelRatio(cw, ch));
      this.composer.setPixelRatio(Quality.pixelRatio(cw, ch));
      this.renderer.setSize(cw, ch);
      this.composer.setSize(cw, ch);
      // BokehPass owns render targets sized independently of the composer's;
      // without this its depth buffer keeps the old aspect and the blur skews.
      if (this.rackFocus) this.rackFocus.setSize(cw, ch);
      // Portrait frames widen the lens (cinematics.js _fitFov).
      this._fitFov();
      // setSize cleared the canvas; a paused loop draws nothing on its own, so ask for one frame.
      this._pauseRedraw = true;
    };
    // The container, not the window: the host changes size without a window
    // resize too (the touch pad's row appearing, the shell's chrome), and a
    // window listener left the drawing buffer stretched to the old aspect.
    this._resizeObs = new ResizeObserver(this._onResize);
    this._resizeObs.observe(this.container);

    // Track the measured tier for the rest of the match (visualRuntime's
    // monitor self-starts on import, so this is a live signal).
    // Mid-match only the pixel ratio follows the tier; the rest recompiles shaders,
    // so it waits for the next warm-up (resetMatch).
    this._offTierChange = Quality.onTierChange(() => {
      if (this.disposed) return;
      this._applyQuality(true);
    });
    // Seed from the boot tier. Shadow sizes and post-pass enables built above use
    // the same settings object, so this is normally a no-op — it matters when the
    // tier has ALREADY dropped during Blazor boot, before the engine started.
    this._applyQuality();

    // Build the physics world before spawning fighters — each fighter's
    // kinematic rig root is created in _spawnFighters.
    this._physics = createPhysicsWorld();
    // Static post/rope colliders — only the KO ragdoll interacts with them.
    buildArenaColliders(this._physics.world, this._physics.materials);
    // Destructible corner crates + debris (props.js). The hooks let the module
    // deal chip damage / spawn impact FX back through the engine.
    this._propHooks = this._makePropHooks();
    this.props = buildProps(this._physics.world, this._physics.materials, this.scene);
    this._spawnFighters(this.options.p1Character, this.options.p2Character);
    this._initTraining();
    if (this.options.mode === 'online') this._initNet();
    // Textures are built by arena.js/fighters.js as module-level cached
    // singletons with no renderer handle, so they cannot set anisotropy
    // themselves. Apply it once here, after the first arena+fighter build;
    // later rounds reuse the same cached textures and stay filtered.
    this._applyTextureAnisotropy();
    // The first match opens on the VS splash too; training skips it. Either way the
    // count waits for the shader warm-up. Under the Full show the warm-up first waits for its
    // layers to load (show.js), so their shaders compile with the rest; nothing draws meanwhile.
    let ready;
    if (showLoad) {
      this._compiling = true;
      ready = this._ready = showLoad.then(() => {
        if (this.disposed) return undefined;
        this._applyTextureAnisotropy(); // their textures were not in the scene for the pass above
        return this._warmupRender();
      });
    } else {
      ready = this._warmupRender();
    }
    if (this.training) {
      ready.then(() => { if (!this.disposed) this._startCountdown(); });
    } else {
      this._beginWithSplash(this.fighters[0].charId, this.fighters[1].charId,
        this.options.mode === '2p' ? 'ONE ROUND · 60 SECONDS'
          : this.options.mode === 'tournament' ? (this.options.roundLabel || 'TOURNAMENT')
          : this.options.mode === 'online' ? (spectating ? 'LIVE · SPECTATING' : 'ONLINE · 60 SECONDS')
          : 'MAIN EVENT');
    }

    // Kick the audio context the first time the user interacts with the page —
    // .razor lifecycle alone doesn't always satisfy autoplay policy.
    // An instance field so dispose() can drop it: a Cup nobody touches
    // never fires it, and a leftover listener would resume a closed AudioContext.
    // Not while paused (the context is suspended on purpose): it waits for the resume,
    // which calls it (setPaused).
    this._resumeAudio = () => {
      if (this.paused) return;
      this._audioKicked = true;
      this.audio.resume();
      // No startMusic(): background music is off in every game.
      // The hall bed can only start once the context is unsuspended;
      // starting looping sources on a suspended context leaves them silently
      // stalled and they never recover on resume.
      this.audio.startCrowd();
      this._dropResumeAudio();
    };
    this._dropResumeAudio = () => {
      window.removeEventListener('pointerdown', this._resumeAudio);
      window.removeEventListener('keydown', this._resumeAudio);
    };
    window.addEventListener('pointerdown', this._resumeAudio);
    window.addEventListener('keydown', this._resumeAudio);
    // M mutes the fight. No binding in any layout uses M, and a focused text field keeps it.
    this._onMuteKey = (e) => {
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      this.setMuted(!this.muted);
      this._caption(this.muted ? '🔇 Muted (M)' : '🔊 Sound on (M)');
    };
    window.addEventListener('keydown', this._onMuteKey);
    // Escape or P pauses and resumes (1P, training and 2P; see setPaused). A text field keeps
    // its keys, and a modal the page has open over the arena owns Escape — except the pause
    // menu itself, which the page marks data-pb-pause so the same key closes it.
    this._onPauseKey = (e) => {
      if ((e.code !== 'Escape' && e.code !== 'KeyP') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if (document.querySelector('dialog[open]:not([data-pb-pause]), [aria-modal="true"]:not([data-pb-pause])')) return;
      if (!this.paused && !this._canPause()) return;
      e.preventDefault();
      this.setPaused(!this.paused);
    };
    // Losing the window never leaves a key held down (input.js does the same per controller,
    // the pads and the online corner are released here), and in the pausable modes it pauses.
    this._onFocusLost = () => {
      if (this._canPause()) this.setPaused(true); // releases the held input too
      else this._releaseHeldInput();
    };
    this._onVisibility = () => { if (document.hidden) this._onFocusLost(); };
    window.addEventListener('keydown', this._onPauseKey);
    window.addEventListener('blur', this._onFocusLost);
    document.addEventListener('visibilitychange', this._onVisibility);

    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.paused) {
        // Frozen: no pads, no sim ticks, no clock, no render-time animation. The canvas keeps
        // its last frame; only a resize (which clears it) draws one more. lastFrame tracks the
        // wall clock so the first frame after the resume carries no catch-up dt.
        this.lastFrame = now;
        if (this._pauseRedraw && !this._compiling) {
          this._pauseRedraw = false;
          this.composer.render();
        }
        return;
      }
      this._pauseRedraw = false;
      const rawDt = (now - this.lastFrame) / 1000;
      // Floored at 0: a rAF timestamp can predate `lastFrame` when _warmupRender stamped it from
      // performance.now() after a long shader compile (or a background tab delivers a stale frame
      // time). A negative dt drives the accumulator below zero and freezes the sim until it climbs back.
      let dt = Math.max(0, Math.min(rawDt, MAX_FRAME_DT));
      this.lastFrame = now;

      // Sample the pads before the sim so a press lands on this frame's tick.
      if (this.gamepads) this.gamepads.poll();
      // `speed` is the tournament's fast-forward (PoBrawl.setSpeed): more fixed ticks per frame,
      // never a longer tick, so the fight resolves exactly as it would at 1x.
      this.accumulator += dt * this.timeScale * this.speed;
      while (this.accumulator >= SIM_DT) {
        this.accumulator -= SIM_DT;
        this._tick(SIM_DT);
      }
      this._updateCamera(dt);
      this._updateEffects(dt);
      this._updateCrowd(dt);
      this._updateFx(dt);
      this._updateShow(dt);
      this._updateLighting(dt);
      this.atmoT += dt;
      updateAtmosphere(this.arena, dt, this.atmoT, this.excited, this._phoneLevel);
      updateRopes(this.arena, dt, this.fighters, this.atmoT);
      updateBanners(this.arena.backdrop, this.atmoT);
      if (this.props) updateProps(this.props, dt, this.fighters, this._propHooks);
      this._updateBlobShadows();
      this._updateMatWear(dt);
      if (this.fighters) {
        for (const f of this.fighters) {
          updateJiggles(f.rig, dt);
          this._updateTrail(f, dt);
          // Transient 'hurt' faces relax back to the resting expression.
          // KO'd fighters keep the dazed face under the result modal.
          if (f.expressionT > 0) {
            f.expressionT -= dt;
            if (f.expressionT <= 0 && f.state !== 'ko') {
              setExpression(f.rig, 'neutral');
            }
          }
        }
      }
      // While programs link in the background a render would block on them, so the
      // canvas keeps its last frame until the warm-up settles.
      if (this._compiling) return;
      this.composer.render();
      // The director's iso-cam inset, drawn over the finished frame (director.js).
      this._renderIsoCam();
      // Showtime modules that read the finished frame (replay grade, result glass).
      this._renderShow(now);
      // The result shatter snapshots the frame, so it has the same constraint.
      if (this._shatterPending) this._shatterNow();
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ── Pause ───────────────────────────────────────────────────────────────

  /** Pause exists in 1P (training included) and 2P, never online or in the Cup, and only live. */
  _canPause() {
    const m = this.options.mode;
    return (m === '1p' || m === '2p') && (this.phase === 'countdown' || this.phase === 'fighting');
  }

  /**
   * Pause or resume (PoBrawl.setPaused, Escape/P, losing the window). Paused: no sim ticks, no
   * clock, the audio context suspended and the loop idle on its last frame; resuming restarts
   * the frame clock, so there is no dt spike. A request to pause outside _canPause is ignored.
   * Tells the page on every change (OnPauseChanged). Returns the state it landed in.
   */
  setPaused(on) {
    const want = !!on && !this.disposed && this._canPause();
    if (want === this.paused) return this.paused;
    this.paused = want;
    // Both ways, every held or queued key is dropped: nothing held into the menu keeps walking,
    // and a punch tapped under it does not fire on the resume. A pad still held presses again
    // on its next poll; a keyboard key wants a fresh press.
    this._releaseHeldInput();
    this.audio?.setPaused(want);
    if (!want) {
      this.lastFrame = performance.now();
      // The first gesture of the session may have arrived while paused (see _resumeAudio).
      if (!this._audioKicked) this._resumeAudio?.();
    }
    try {
      this.dotnet?.invokeMethodAsync('OnPauseChanged', want).catch(() => {});
    } catch { /* the page's reference is already disposed */ }
    return want;
  }

  /**
   * Pause menu: run the bout back from the count, same corners and same CPU rung, without a
   * re-init. The training room just puts both fighters back on their marks.
   */
  restart() {
    const m = this.options.mode;
    if (this.disposed || !this.fighters || (m !== '1p' && m !== '2p')) return;
    this.setPaused(false);
    if (this.training) { this.resetTraining(); return; }
    this.resetMatch({ splash: false });
  }

  /** Let go of every held key: keyboards, pads and the online corner (which tells the server). */
  _releaseHeldInput() {
    for (const f of this.fighters || []) f.controller?.releaseAll?.();
    this.gamepads?.releaseAll();
    this.netInput?._onBlur?.();
  }

  _makeController(playerIndex, spawnedCharId = null) {
    const mode = this.options.mode;
    const difficulty = this.options.difficulty || 'medium';
    // Each AI controller also learns its charId so it can pull personality
    // additive AI knobs (HW Bush's blockP/baitP/punishP bump). The SPAWNED id wins
    // over options (it is the resolved one: an unknown id falls back to the first).
    const charIdForIndex = spawnedCharId ?? (playerIndex === 1
      ? this.options.p1Character
      : this.options.p2Character);
    // The training room (1P) claims the dummy's slot. Null means "not a training slot".
    const trainingController = this._trainingController(playerIndex);
    if (trainingController) return trainingController;
    // Online both corners are driven by the local rollback sim (netplay.js / rollbackSession.js).
    if (mode === 'online') return new NetController(playerIndex === this.options.localSide);
    const keys = (layout) => new KeyboardController(layout);
    if (mode === 'tournament') return new AiController(difficulty, this.rng, charIdForIndex);
    if (mode === '2p') return keys(playerIndex);
    return playerIndex === 1
      ? keys(1)
      : new AiController(difficulty, this.rng, charIdForIndex);
  }

  _spawnFighters(p1Char, p2Char) {
    if (this.fighters) {
      for (const f of this.fighters) {
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
        this.scene.remove(f.rig.root);
        if (f.blob) {
          this.scene.remove(f.blob);
          f.blob.geometry.dispose();
          f.blob.material.dispose(); // texture is shared; disposed in dispose()
        }
        if (f.aoDisc) {
          this.scene.remove(f.aoDisc);
          f.aoDisc.geometry.dispose();
          f.aoDisc.material.dispose();
        }
        if (f.trail) {
          this.scene.remove(f.trail.mesh);
          f.trail.mesh.geometry.dispose();
          f.trail.mesh.material.dispose();
        }
        f.controller.dispose();
      }
    }

    // A fresh match starts on a clean canvas — the accumulated blood
    // stains belong to the fight that produced them. Not in the tournament:
    // there the ring keeps all seven bouts' blood, scuffs and sweat (cup.js).
    const keepWear = this.options.mode === 'tournament';
    if (!keepWear) this._clearBlood();
    // …and so do the scuffs, skids and sweat.
    if (this.matWear && !keepWear) this.matWear.clear();
    this._koDust = null;

    // Clear any arms torn off in the previous fight.
    if (this._pendingSevers) this._pendingSevers.length = 0;
    if (this._severedLimbs) {
      for (const l of this._severedLimbs) {
        if (l.arm) l.arm.dispose();
        for (const obj of [l.shoulder, l.elbow]) {
          if (!obj) continue;
          this.scene.remove(obj);
          obj.traverse((o) => {
            if (o.userData.shared) return; // blood.js wound caps share one geometry + material
            if (o.geometry) o.geometry.dispose();
            if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
          });
        }
      }
      this._severedLimbs.length = 0;
    }

    this.combat = new CombatPlay({ maxHealth: MAX_HP });

    const resolve = (id) => (CHARACTERS[id] ? id : CHARACTER_IDS[0]);
    const mirror = resolve(p1Char) === resolve(p2Char);
    this.fighters = [1, 2].map((index) => {
      const charId = index === 1 ? p1Char : p2Char;
      const resolvedId = resolve(charId);
      // Wardrobe material tier. Build-time only, like the light count and for the
      // same reason: swapping a material's class means new shader programs for
      // every mesh wearing it, so it cannot chase a live tier change without a
      // recompile stall. Fighters ARE rebuilt between rounds, so a tier that
      // dropped mid-match is picked up at the next spawn.
      const rig = buildFighter(resolvedId, {
        physicalMaterials: Quality.settings().physicalMaterials,
      });
      if (mirror && index === 2) altKit(rig);
      // Must run before the first render: onBeforeCompile only fires on
      // initial program compile, so injecting after a material has been drawn
      // once does nothing until something else dirties it.
      const inkUniforms = this._applyInkEdge(rig);
      // Spawn on the same side as this fighter's HUD bar (SPAWN_X_BY_SIDE).
      const side = index === 1 ? 'left' : 'right';
      rig.root.position.set(SPAWN_X_BY_SIDE[side], 0, 0);
      this.scene.add(rig.root);
      const playerId = `p${index}`;
      this.combat.addPlayer({ playerId, teamId: String(index) });

      const rigBody = createRootBody(this._physics.world, this._physics.materials,
        { x: rig.root.position.x, z: rig.root.position.z });

      // Soft contact shadow + ambient-occlusion disc. Two stacked planes:
      //   • blob — radial gradient that darkens and widens as the fighter
      //     drops; sells vertical grounding
      //   • aoDisc — a tight, near-pitch-black inner ring that hugs the
      //     planted foot. Reads as ambient occlusion, not cast shadow —
      //     sells horizontal contact (the fighter isn't floating).
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture(), transparent: true,
          opacity: 0.34, depthWrite: false,
        })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.055;
      this.scene.add(blob);

      // AO disc scales with mass — heavy fighters (LBJ mass 1.25) get a
      // visibly larger plant patch than light fighters (JFK mass 0.9).
      const aoR = 0.95 * Math.sqrt(rig.config.mass || 1.0);
      const aoDisc = new THREE.Mesh(
        new THREE.PlaneGeometry(aoR * 2, aoR * 2),
        new THREE.MeshBasicMaterial({
          map: this._makeBlobTexture({ inner: 'rgba(0,0,0,0.85)', outer: 'rgba(0,0,0,0)' }),
          transparent: true, opacity: 0.55, depthWrite: false,
        })
      );
      aoDisc.rotation.x = -Math.PI / 2;
      aoDisc.position.y = 0.056; // 1 mm above blob to avoid z-fight
      this.scene.add(aoDisc);

      return {
        index,
        playerId,
        // 'left' | 'right' — the side this fighter's HUD bar is drawn on and
        // the X they spawned at. Do not mutate after spawn.
        side,
        // Resolved character id (an unknown id falls back to the first — the
        // HUD reads it back via the OnMatchStart callback so the on-screen
        // names always match the actual fighters).
        charId: resolvedId,
        rig,
        // The ink-edge uniform objects for this rig's materials, so the
        // super cinematic can spike the edge to the character's accent colour
        // and let it fall back without re-walking the hierarchy every frame.
        inkUniforms,
        // Stance offsets give each president a personal idle silhouette
        // (Trump's chin-up lean, Nixon's hunch) on top of the shared guard.
        animator: new Animator(rig.joints, rig.config.stance),
        controller: this._makeController(index, resolvedId),
        // Personality entrance — played under the "3 / 2 / 1 / FIGHT!" banner
        // during _startCountdown. Resolves to GUARD by the time FIGHT! fires.
        entranceKey: (CHARACTERS[charId] && CHARACTERS[charId].entrance) || 'salute',
        state: 'idle',
        stateT: 0,
        attack: null,
        hasHit: false,
        // ── Hold-to-charge ────────────────────────────────────────────
        chargeName: null,  // 'punch'|'kick' while state === 'charge'
        chargeAmt: 0,      // 0..1 charge drained out of `energy` while charging
        chargeMul: 1,      // damage/knockback multiplier of the current swing
        energy: ENERGY_DEFAULT, // 0..1 strike power AND stamina (see the ENERGY_* block)
        gassed: false,     // true while under the floor: no punch, no kick (see _canAttack)
        // ── Guard timing (see the PERFECT_GUARD_* block) ──────────────
        // Engine time the guard last went UP. Every route into the 'block'
        // state stamps it, and _applyHit compares it against the moment the
        // strike connects to tell a read from a camp. -99 so a fighter who has
        // not guarded yet can never score a perfect one off the initialiser.
        guardAt: -99,
        blockStunT: 0,     // frozen out of our own recovery by the guard we hit
        counterUntil: -99, // perfect guard armed a bonus swing until this time

        // The super meter is NOT here: it lives on `personality.superMeter`.
        // Don't add a copy on the fighter — the HUD and AI would bind to it.
        // ── Per-round scorecard ───────────────────────────────────────
        // Counters for the end-of-fight recap and the on-screen combo readout.
        // Every round (including a best-of-3 rematch) goes through
        // _spawnFighters, so initialising here IS the per-round reset.
        stats: { hits: 0, blocks: 0, biggestHit: 0, bestCombo: 0 },
        comboN: 0,      // consecutive landed hits inside COMBO_WINDOW
        comboT: -99,    // engine time of this fighter's last landed hit
        chargeCued: false, // full-charge audio cue fired
        chargeSparkT: 0,   // spark-mote emission timer
        // ── Momentum + weight ─────────────────────────────────────────
        vel: new THREE.Vector3(),
        targetVel: new THREE.Vector3(),
        knockback: new THREE.Vector3(),
        // ── Per-region damage ─────────────────────────────────────────
        regionDmg: { head: 0, torso: 0, arms: 0, legs: 0 },
        // ── Dismemberment ─────────────────────────────────────────────
        // Which arm sides ('L'/'R') have torn off, plus the still-bleeding
        // stumps that pump in time with the heart. See _severArm / blood.js.
        armsLost: new Set(),
        stumps: [],
        // 0..1 sweat built over the round (blood.js _tickSweat).
        sweat: 0,
        // ── Misc ──────────────────────────────────────────────────────
        idleT: this.rng.random() * 10,
        speedAmt: 0,
        // Facial expression timer: >0 while a transient 'hurt' face is held.
        expressionT: 0,
        // Rotational knockback: yaw angular velocity + accumulated offset
        // layered on top of the hard-set facing (see the yaw-track block).
        spinVel: 0,
        spinYaw: 0,
        // Skid/landing ground-reaction state.
        _skidT: 0,
        _wasSkidding: false,
        // ── Personality state (per-president Punch-Out!! pattern) ──────
        // Runtime counters that personalities data above refer to. Reset on
        // match restart via _resetPersonalities below.
        // Off online: every personality effect that moves HP (reflect, flourishes, supers) would
        // move HP the server never moved. BOB has none either way.
        personality: makePersonalityState(this.options.mode === 'online' ? null : resolvedId),
        // Slow effect (Biden charge hit): applies a moveMul to the body for
        // a few seconds. Read in the _tickFighting mobility pass.
        slowUntil: 0,
        slowMul: 1.0,
        // Block-reduce nudge (Nixon "Tricky Dick"): on the next commit dirty
        // hit, the defender's block absorbs `dirtyBlockFraction` less.
        dirtyBlockReduce: 0,
        hpCur: MAX_HP,
        // Impact feedback: cartoon squash timer (shape only — per user request
        // the model's colors never change on hits or KO).
        squashT: 0,
        // Soft contact-shadow mesh (tracks the hips each frame).
        blob,
        // AO disc: mass-tinted "planted foot" patch. Tighter than blob,
        // never widens with drop — it just anchors the fighter to the floor.
        aoDisc,
        // Additive swing ribbon following the striking limb.
        trail: this._makeTrail(),
        // Track the last frame's windup flag for the AI to read.
        lastWasWindup: false,
        // Rigid-body ragdoll — the cannon-es skeleton used for the KO.
        // Built lazily (pendingKO), outside world.step.
        koRagdoll: new CannonRagdoll(this._physics.world, this._physics.materials.ragdoll, rig),
        pendingKO: null,
        // Kinematic cannon body for shoving ragdolls/props; null once KO'd.
        rigBody,
      };
    });
    this.hudDirty = true;
    this.hudTimer = 0;
    // Tell the HUD which characters actually spawned so the left/right names
    // match the fighters (an unknown id resolves to a different one).
    if (this.dotnet) {
      this.dotnet.invokeMethodAsync('OnMatchStart',
        this.fighters[0].charId, this.fighters[1].charId).catch(() => {});
      // Whether this match is a training session, so the page can drop the
      // ladder chrome. Its own call rather than a third OnMatchStart argument:
      // interop fails silently on an arity change.
      this.dotnet.invokeMethodAsync('OnTrainingState', !!this.training).catch(() => {});
    }
  }

  _hp(f) {
    return Math.max(0, Math.round(this.combat.getPlayer(f.playerId).health));
  }

  _startCountdown() {
    this.phase = 'countdown';
    this.phaseT = 0;
    this._show('countdown');
    this.clock = 0;
    this.winner = 0;
    // Rebuild the corner crate stacks so each round opens with an intact ring.
    // The tournament restacks only what survived: broken crates stay broken all night.
    if (this.props) resetProps(this.props, { keepBroken: this.options.mode === 'tournament' });
    // Drop the previous round's floating numbers and combo badges.
    this._clearFx();
    this._clearSpectacle();
    // Land the previous match's celebrant before the fresh countdown.
    if (this.celebrant) this.celebrant.rig.root.position.y = 0;
    this.celebrant = null;
    this.pendingCelebration = null;
    this.celebrationT = 0;
    this.timeScale = 1;
    this._setCameraMode('normal', { force: true });
    this.cameraModeT = 0;
    // A super fired on the last frame of the previous round would otherwise
    // still own timeScale and the camera into this countdown.
    this._superT = 0;
    this._superFighter = null;
    // Re-arm the PA count; without this the new round's "3" matches the
    // remembered value and the announcer sits out the whole countdown.
    this._lastCount = null;
    this._resetCommentary();
    // Snap the boom back to the canonical +Z side before the round starts.
    // The KO cinematic swings the camera to the −Z side and the spring
    // camera keeps whatever side it's on, so without this the next round is
    // filmed from behind and P1 renders on the right, against its HUD name.
    this._snapCameraToFraming();
    // Kick the personality entrance for each fighter. The track lasts ~1.5 s
    // (3-4 keyframes); the countdown is 3.7 s, so the entrance resolves to
    // GUARD before FIGHT! fires and the match starts clean.
    if (this.fighters) {
      for (const f of this.fighters) {
        if (f.animator && f.entranceKey) f.animator.play(f.entranceKey);
      }
      // Period-appropriate chiptune intro for the opponent (P2). Plays on
      // introGain while the music loop ducks; fades back up after ~5 s.
      if (this.audio && this.fighters[1]) {
        this.audio.playIntroTheme(this.fighters[1].charId);
      }
    }
    this._setBanner('3');
    this._dangerPushed = -1;
  }

  /**
   * Opening VS splash for an engine's first match: the same card
   * resetMatch shows between rounds, then the countdown. The fighters idle under
   * it — phase 'intro' matches none of _tick's branches, so nothing fights,
   * scores or times out until the countdown takes over.
   */
  _beginWithSplash(p1Char, p2Char, label) {
    this.phase = 'intro';
    this.phaseT = 0;
    this.clock = 0;
    this.winner = 0;
    this._snapCameraToFraming();
    this._showSplash(p1Char, p2Char, SPLASH_HOLD_MS, label);
    const hold = this._introHold();
    // Online the server's pre-roll starts the count (netplay.js applyNet), so both screens say
    // "FIGHT!" on the same tick.
    if (this.options.mode === 'online') return;
    this._armSplashTimer(hold);
  }

  // Close the splash into the countdown once the hold has run AND the shader warm-up
  // has settled. The phase check drops a stale timer (netplay or a newer reset took over).
  _armSplashTimer(hold) {
    clearTimeout(this._splashTimer);
    this._splashTimer = setTimeout(() => this._ready.then(() => {
      if (this.disposed || this.phase !== 'intro') return;
      this._hideSplash();
      this._startCountdown();
    }), hold);
  }

  /**
   * Speak the ring introduction, if one is waiting, and return how long the VS splash should
   * hold so the line finishes before "3" (the count cancels whatever the PA is saying).
   */
  /**
   * A knockout bracket cannot advance a draw, so a tournament bout always has a winner at the
   * bell: more health, then more hits landed, then the bigger single hit, then a seeded coin.
   */
  _tournamentDecision(h1, h2) {
    if (h1 !== h2) return h1 > h2 ? 1 : 2;
    const [a, b] = this.fighters.map((f) => f.stats);
    if (a.hits !== b.hits) return a.hits > b.hits ? 1 : 2;
    if (a.biggestHit !== b.biggestHit) return a.biggestHit > b.biggestHit ? 1 : 2;
    return this.rng.random() < 0.5 ? 1 : 2;
  }

  _introHold() {
    const line = this._introLine;
    this._introLine = null;
    if (!line || this.training) return SPLASH_HOLD_MS;
    // Held long enough to read the introduction off the caption bar.
    const words = String(line).split(/\s+/).length;
    const hold = Math.min(7000, Math.max(SPLASH_HOLD_MS, 600 + words * 360));
    this._caption(line, hold / 1000);
    return hold;
  }

  // Compile every GPU program the current scene needs, then reset the frame
  // clock. three compiles a material's shader lazily, on its first render;
  // with this many distinct materials (arena + backdrop + crowd + props + two
  // freshly built fighters + the whole post chain) that lands as one long
  // stall on the first animated frame of a match, which also starves the
  // music scheduler past its lookahead. Warming up here spends the same
  // time, but before the clock starts / behind the round splash.
  //
  // compileAsync links the scene's programs without blocking the page
  // (KHR_parallel_shader_compile); the loop skips rendering until it settles.
  // Then one render with the passes the match switches on later (afterimage
  // smear, KO rack focus) compiles those too, instead of on the frame they appear.
  // Returns (and stores as _ready) a promise that settles when it is done.
  _warmupRender() {
    this._compiling = true;
    // compile() only walks visible objects, and much of the scene waits hidden until
    // it is needed (strike trails, shock rings, flash bulbs, the shader keepers). Show
    // them for the synchronous compile pass inside the call, then hide them again.
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    // Compile against the composer's buffer, where RenderPass draws the scene. With no
    // target bound, three builds the on-screen variants (tone mapping + sRGB output
    // baked in), which the composer never uses, and the real ones still compile on
    // first draw.
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.composer.readBuffer);
    let compiled;
    try {
      compiled = this.renderer.compileAsync
        ? this.renderer.compileAsync(this.scene, this.camera)
        : Promise.resolve(this.renderer.compile(this.scene, this.camera));
    } catch (e) {
      compiled = Promise.reject(e);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      for (const o of hidden) o.visible = false;
    }
    this._ready = compiled.catch(() => {}).then(() => {
      this._compiling = false;
      if (this.disposed) return;
      const transient = [this.afterimage, this.rackFocus?.pass].filter((p) => p && !p.enabled);
      try {
        for (const p of transient) p.enabled = true;
        this.composer.render();
      } catch { /* best effort — never block the match on the warm-up */ }
      for (const p of transient) p.enabled = false;
      // Don't bill the warm-up to the simulation: the next frame's dt is
      // measured from here, and no catch-up ticks are owed.
      this.lastFrame = performance.now();
      this.accumulator = 0;
    });
    return this._ready;
  }

  /**
   * The next bout on the same engine (PoBrawl.next / matchup / restart): fresh fighters from
   * options, then the VS splash and the count. `splash: false` (the pause menu's restart) goes
   * straight back to the count once the new rigs have compiled.
   */
  resetMatch({ splash = true } = {}) {
    // Out of 'result' (or a paused fight) at once, before anything below can tick.
    this.setPaused(false);
    this.phase = 'intro';
    this.phaseT = 0;
    this.hitstopT = 0;
    this.timeScale = 1;
    this._show('reset');
    const p1 = this.options.p1Character, p2 = this.options.p2Character;
    // A tier change deferred mid-match lands here, ahead of the warm-up that compiles it.
    if (this._qualityDirty) this._applyQuality();
    this._spawnFighters(p1, p2);
    this._initTraining();
    this._renderTrainingHud();
    // New rigs mean new materials: compile them under the splash rather than
    // on the countdown's first frame.
    this._warmupRender();
    if (!splash) {
      this._setBanner('');
      this._snapCameraToFraming();
      this._armSplashTimer(0);
      return;
    }
    // Show the inter-round splash, then start the countdown once it's
    // faded in. The splash doubles as a brief loading screen — the new
    // match's physics + arena are ready under it, so the transition reads
    // as "next round" rather than "page reload".
    this._showSplash(p1, p2, SPLASH_HOLD_MS);
    // The tape rewinds into the next fight under the splash (spectacle.js).
    this._rewindT = REWIND_SEC;
    this.audio?.rewind(REWIND_SEC);
    this._armSplashTimer(this._introHold());
  }

  _showSplash(p1Char, p2Char, holdMs, label = null) {
    const p1 = CHARACTERS[p1Char]?.name ?? p1Char;
    const p2 = CHARACTERS[p2Char]?.name ?? p2Char;
    // `label` is the first match's heading (_beginWithSplash); rounds after it get the generic one.
    // The tournament page names every bout ('QUARTERFINAL 2 OF 4') through PoBrawl.matchup.
    label ||= this.training ? 'TRAINING'
      : this._roundLabel ? this._roundLabel
      : 'NEXT ROUND';
    this.splash.querySelector('.pb-splash__round').textContent = label;
    this.splash.querySelector('.pb-splash__p1').textContent = p1;
    this.splash.querySelector('.pb-splash__p2').textContent = p2;
    this.splash.classList.remove('pb-splash--instant');
    this.splash.classList.add('pb-splash--visible');
    // Riser into a boom timed to the cards slamming together.
    this.audio?.vsSting();
  }

  // The names FLY into the HUD. With the View Transitions API the splash's
  // two name spans and the page's two .pb-hp-name labels swap a shared
  // view-transition-name across the DOM update, so the browser morphs each name
  // from the centre card to its health bar. Only one element per name may carry
  // it at a time, which is why it moves from the splash to the HUD INSIDE the
  // update callback. Without the API (Firefox, Safari < 18), under reduced
  // motion, or if the HUD is not on the page, the splash just fades.
  _hideSplash() {
    const splash = this.splash;
    if (!splash.classList.contains('pb-splash--visible')) return;
    const huds = this.container.parentElement?.querySelectorAll('.pb-hp-name') || [];
    const names = [splash.querySelector('.pb-splash__p1'), splash.querySelector('.pb-splash__p2')];
    if (typeof document.startViewTransition !== 'function' || huds.length < 2 || motionReduced()
        || document.visibilityState !== 'visible') {
      splash.classList.remove('pb-splash--visible');
      return;
    }
    ensureViewTransitionStyle();
    names[0].style.viewTransitionName = 'pb-name-1';
    names[1].style.viewTransitionName = 'pb-name-2';
    let vt;
    try {
      vt = document.startViewTransition(() => {
        names[0].style.viewTransitionName = '';
        names[1].style.viewTransitionName = '';
        huds[0].style.viewTransitionName = 'pb-name-1';
        huds[1].style.viewTransitionName = 'pb-name-2';
        // The new state must have the splash fully gone, not mid-fade — the
        // root cross-fade is what fades it.
        splash.classList.add('pb-splash--instant');
        splash.classList.remove('pb-splash--visible');
      });
    } catch {
      splash.classList.remove('pb-splash--visible');
      return;
    }
    vt.finished.finally(() => {
      huds[0].style.viewTransitionName = '';
      huds[1].style.viewTransitionName = '';
      names[0].style.viewTransitionName = '';
      names[1].style.viewTransitionName = '';
    }).catch(() => { /* skipped transition */ });
  }

  // ── simulation ──────────────────────────────────────────────────────────

  _tick(dt) {
    // The instant replay (replay.js) owns the rigs and the camera: the sim holds still under it.
    if (this.phase === 'replay') return;
    // The sim clock every timed personality effect is written against.
    this.t += dt;
    this.phaseT += dt;

    if (this.phase === 'countdown') {
      const remaining = 3 - Math.floor(this.phaseT);
      this._setBanner(remaining > 0 ? String(remaining) : 'FIGHT!');
      // The bell at zero. Edge-triggered off the banner value rather than a timer of
      // its own, so it can never drift out of step with the number on screen.
      if (remaining !== this._lastCount) {
        this._lastCount = remaining;
        if (remaining <= 0) {
          // The banner already says FIGHT! (no caption under it); the jumbotron echoes it in-world.
          this._jumboCaption('FIGHT', 1.4);
          this.audio?.crowdSwell(0.85);
        }
      }
      if (this.phaseT >= 3.7) {
        this.phase = 'fighting';
        this._show('fight');
        this.combat.startGame();
        this._setBanner('');
      }
    } else if (this.phase === 'fighting') {
      this.clock += dt;
      this._tickFighting(dt);
      this._tickCombos();
      this._tickCommentary();
      // The training room has no clock.
      if (this.training) this._tickTraining();
      // Online the server rings the bell (netplay.js _tickNet), on its own clock.
      if (!this.training && !this.online && this.clock >= TIME_LIMIT && this.phase === 'fighting') {
        const h1 = this._hp(this.fighters[0]), h2 = this._hp(this.fighters[1]);
        // Decision on health. A clear health lead wins; bars within DRAW_HP_BAND
        // of each other is a DRAW.
        const margin = Math.abs(h1 - h2);
        let winner;
        if (this.options.mode === 'tournament') winner = this._tournamentDecision(h1, h2);
        else if (margin <= DRAW_HP_BAND) winner = 0;   // too close to call
        else winner = h1 > h2 ? 1 : 2;
        // 'TIME!' is the flash on the way out, not the final word: _endMatch
        // calls _reportResult synchronously and that sets the real banner —
        // 'DRAW' for winner 0, '<NAME> WINS!' otherwise.
        this._endMatch(winner, 'TIME!');
      }
    } else if (this.phase === 'ko') {
      // Build any pending rigid-body ragdoll now — we're guaranteed to be
      // outside cannon's step here, so body removal/creation is safe.
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      if (this.phaseT >= 1.4) {
        this.timeScale = 1;
        // The instant replay (replay.js) runs between the fall and the result when it
        // can, and calls _koResult itself once it is done.
        if (!this._replayBegin?.()) this._koResult();
      }
    } else if (this.phase === 'result') {
      this._buildPendingKO();
      this._buildPendingSevers();
      if (this._physics) stepWorld(this._physics.world, dt);
      this._tickKoFall(dt);
      this._tickCelebration(dt);
    }

    // Hit-pause countdown: skip sim while paused but still advance render rate later.
    if (this.hitstopT > 0) {
      this.hitstopT = Math.max(0, this.hitstopT - dt);
    }
    if (this._clashCooldown > 0) this._clashCooldown -= dt;

    for (const f of this.fighters) {
      f.idleT += dt;
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      this._updatePosture(f, opp, dt);
      // Per-fighter personality evaluation: trigger-once modes, slow clears,
      // flourish scheduling.
      this._tickPersonalities(f, dt);
      this._tickClintonFlourish(f, dt);
      f.animator.update({
        dt, speed: f.speedAmt, idleT: f.idleT,
        root: f.rig.root,
        vel: _animVel.set(f.vel.x + f.knockback.x, 0, f.vel.z + f.knockback.z),
      });
      f.animator.decayLean(dt);
      f.hpCur = this._hp(f);

      // Cartoon squash: compress the whole body for a couple of frames on impact.
      if (f.squashT > 0) {
        f.squashT = Math.max(0, f.squashT - dt);
        const q = f.squashT / 0.14;
        const s = q * q * 0.2;
        f.rig.joints.hips.scale.set(1 + s * 0.8, 1 - s, 1 + s * 0.8);
      }

      // Bleeding stumps and the sweat a round builds up (blood.js).
      this._tickStumps(f, dt);
      this._tickSweat(f, dt);
    }

    // Drive music tension from the lower of the two HPs (0..1 → 0..1).
    if (this.fighters && this.fighters.length) {
      const low = Math.min(...this.fighters.map((f) => f.hpCur)) / MAX_HP;
      this.audio.setMusicTension(1 - low);
    }

    // Audio-reactive bloom: every SFX call nudges the AudioBus envelope;
    // here we decay it and pulse UnrealBloomPass strength so each impact
    // glows brighter for ~150 ms. Base 0.32, peak +0.6, eased back via
    // exp-decay (k ≈ 7.5 in audio.tick).
    if (this.audio && typeof this.audio.tick === 'function') this.audio.tick(dt);
    if (this.bloomPass) {
      const env = (this.audio && this.audio.getEnvelope) ? this.audio.getEnvelope() : 0;
      const target = 0.32 + env * 0.6;
      // Smoothly chase the target so back-to-back hits stack without snap.
      const k = 1 - Math.exp(-dt * 18);
      this.bloomPass.strength = this.bloomPass.strength + (target - this.bloomPass.strength) * k;
    }

    this._pushHud(dt);
  }

  _tickFighting(dt) {
    const [f1, f2] = this.fighters;

    // Skip sim while in hit-pause.
    if (this.hitstopT > 0) return;

    // Strikes that reach their active frames this tick are queued by
    // _tickFighter and resolved after BOTH fighters have ticked. Resolving them
    // inline handed every same-frame trade to P1: his hit put P2 in hitstun
    // before P2's own active frame was ever tested. Online keeps the inline
    // path — the server already rules on each swing (netplay.js).
    this._pendingHits = this.online ? null : [];

    for (const f of this.fighters) {
      if (f.blockStunT > 0) {
        f.blockStunT = Math.max(0, f.blockStunT - dt);
        f.vel.multiplyScalar(0.2);
        f.knockback.multiplyScalar(0.25);
      }
      const opp = f === f1 ? f2 : f1;
      const ctx = this._aiContext(f, opp, dt);
      let intent = f.controller.update(ctx);
      if (f.blockStunT > 0) {
        intent = { ...intent, punch: false, kick: false, block: false, side: 0 };
      }
      // ── Nixon "I Am Not a Crook" eye-gouge / Ford "PARDON ME" ───────
      // Block presses drop with the blind window's miss rate
      // (f._inputBlindMissRate, 30% Nixon / 60% Ford). Rolled ONCE per blind
      // window: a per-tick roll strobed the guard, and every re-raise restamped
      // guardAt — so the gouge handed its victim free PERFECT guards.
      if (f._inputBlindUntil && this.t < f._inputBlindUntil) {
        if (f._blindRolledFor !== f._inputBlindUntil) {
          const missRate = f._inputBlindMissRate
            || PERSONALITIES.nixon?.oncePerRound?.blindMissRate
            || 0.30;
          f._blindRolledFor = f._inputBlindUntil;
          f._blindDropsGuard = this.rng.random() < missRate;
        }
        if (f._blindDropsGuard) intent = { ...intent, block: false };
      }
      // ── W Bush "Decider Mode" freeze: stall out his attacking moves ──
      if (f.controller?.__freezeUntil && this.t < f.controller.__freezeUntil) {
        intent = { ...intent, punch: false, kick: false, side: 0 };
      }
      this._tickFighter(f, opp, intent, dt);
      if (this.online) this._netDeadline(f, opp);
      // Super meter fills passively by taking damage (see _tickSuperMeter).
      // Drain any activated super state, decay swing-counted supers.
      this._tickSuperMeter(f, opp, dt);
    }

    // Resolve this tick's strikes. Both were tested against the same frame,
    // so two swings that connect together both land — a true trade. _tryHit
    // skips a swing whose thrower the first strike already knocked out.
    const pending = this._pendingHits;
    this._pendingHits = null;
    if (pending) {
      for (const [atk, def, attack] of pending) {
        if (!atk.hasHit) this._tryHit(atk, def, attack);
      }
    }

    if (this.online) this._tickNet(dt);

    // ── Ring clamp + cannon-es physics step ────────────────────────
    // 1. Clamp each fighter inside the ring (still the engine's job — cannon
    //    wouldn't otherwise know about the arena boundary). A fighter thrown
    //    hard into the boundary rebounds off the ropes instead of sticking.
    for (const f of this.fighters) {
      const pos = f.rig.root.position;
      const rawX = pos.x, rawZ = pos.z;
      pos.x = THREE.MathUtils.clamp(rawX, -RING_HALF, RING_HALF);
      pos.z = THREE.MathUtils.clamp(rawZ, -RING_HALF, RING_HALF);
      // Elastic rope rebound: the ropes catch a launched fighter and spring
      // them back INTO the ring. Restitution ramps 0.55 → 0.9 with incoming
      // speed, so harder impacts snap back harder.
      if (pos.x !== rawX && Math.abs(f.knockback.x) > 1.2) {
        const speed = Math.abs(f.knockback.x);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.x *= -restitution;
        f.animator.applyLean(0, rawX > 0 ? 0.4 : -0.4);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'x', rawX > 0 ? 1 : -1, power);
        this.audio.prop({ material: 'rope', power, worldPos: pos });
        if (power > 1.8) this._kickRig(0.25, pos.x, pos.z);
      }
      if (pos.z !== rawZ && Math.abs(f.knockback.z) > 1.2) {
        const speed = Math.abs(f.knockback.z);
        const power = Math.min(2.6, speed / 3.5);
        const restitution = THREE.MathUtils.clamp(0.55 + speed * 0.05, 0.55, 0.9);
        f.knockback.z *= -restitution;
        f.animator.applyLean(rawZ > 0 ? -0.4 : 0.4, 0);
        f.animator.applyReaction('torso', -3, 0, 0);
        twangRope(this.arena, 'z', rawZ > 0 ? 1 : -1, power);
        this.audio.prop({ material: 'rope', power, worldPos: pos });
        if (power > 1.8) this._kickRig(0.25, pos.x, pos.z);
      }

      // Turnbuckle hazard: a fighter knocked into a CORNER takes bonus
      // damage and is flung back toward ring-center harder than a plain rope
      // bounce. Cooldown-gated so a body wedged in the corner isn't shredded.
      f._cornerCd = Math.max(0, (f._cornerCd || 0) - dt);
      const inCorner = Math.abs(pos.x) > RING_HALF - 0.5 && Math.abs(pos.z) > RING_HALF - 0.5;
      const cornerKb = Math.hypot(f.knockback.x, f.knockback.z);
      if (inCorner && cornerKb > 3.0 && f._cornerCd === 0 && f.state !== 'ko') {
        f._cornerCd = 0.6;
        const sx = Math.sign(pos.x) || 1, sz = Math.sign(pos.z) || 1;
        const tox = -sx / Math.SQRT2, toz = -sz / Math.SQRT2; // toward center
        f.knockback.x = tox * cornerKb * 0.7;
        f.knockback.z = toz * cornerKb * 0.7;
        f.animator.applyReaction('torso', -3.5, 0, 0);
        this._propHooks.onChip(f, Math.min(4, cornerKb - 3.0), tox, toz);
        const pv = new THREE.Vector3(sx * (RING_HALF + 0.1), 1.0, sz * (RING_HALF + 0.1));
        this._spawnSparks(pv, sx < 0 ? 0xff5a4a : 0x4a7dff, 10, 2.2);
        this.audio.impact({ power: 1.3, worldPos: pv });
        this.audio.prop({ material: 'steel', power: 1.2, worldPos: pv });
        this._kickRig(0.6, pv.x, pv.z);
      }

      // ── Ground reaction: skids and landings ────────────────────────
      // Heavy knockback drags the feet: kick up canvas dust along the
      // slide, then a landing squash when the body finally grips.
      const kb = Math.hypot(f.knockback.x, f.knockback.z);
      if (kb > 3.2 && f.state !== 'ko') {
        f._wasSkidding = true;
        f._skidT -= dt;
        if (f._skidT <= 0) {
          f._skidT = 0.05;
          this._spawnParticle(
            pos.x + (this.rng.random() - 0.5) * 0.25, 0.1,
            pos.z + (this.rng.random() - 0.5) * 0.25,
            -f.knockback.x * 0.12, 0.7 + this.rng.random() * 0.6, -f.knockback.z * 0.12,
            0x8a8fb8, 0.4, -2.5);
        }
      } else if (f._wasSkidding && kb < 1.6) {
        // The slide grips: compress into the landing.
        f._wasSkidding = false;
        f.squashT = Math.max(f.squashT, 0.12);
      }
    }

    // 2. Sync cannon bodies to current rig transforms BEFORE stepping so
    //    the solver sees the fighter where the controllers put them.
    if (this._physics) {
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.rigBody) syncRigRoot(f.rigBody, f);
      }
      stepWorld(this._physics.world, dt);
      this._checkClash();
      // Arms torn off by this tick's hits get their bodies built here,
      // outside world.step.
      this._buildPendingSevers();

      // 3. Push-apart via cannon-es contact events: translate each root by
      //    half the overlap along the contact normal.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.rigBody) {
          for (const c of this._physics.world.contacts) {
            const a = c.bi, b = c.bj;
            if (a === f.rigBody || b === f.rigBody) {
              const other = a === f.rigBody ? b : a;
              if (!other.userData || other.userData.kind !== 'rigRoot') continue;
              const dx = f.rigBody.position.x - other.position.x;
              const dz = f.rigBody.position.z - other.position.z;
              const d = Math.hypot(dx, dz) || 1e-4;
              const overlap = (f.rigBody.shapes[0].radius +
                              other.shapes[0].radius) - d;
              if (overlap > 0) {
                const nx = dx / d, nz = dz / d;
                const push = overlap * 0.5;
                f.rigBody.position.x += nx * push;
                f.rigBody.position.z += nz * push;
                other.position.x -= nx * push;
                other.position.z -= nz * push;
              }
            }
          }
        }
      }

      // 3b. Cannon never generates contacts between the two rig roots —
      //    both are KINEMATIC, and the broadphase skips pairs with no
      //    dynamic body — so the contact loop above only handles ragdoll
      //    shoves. Enforce the fighter-vs-fighter minimum separation
      //    directly: half the deficit each, XZ only.
      const [fA, fB] = this.fighters;
      if (fA.state !== 'ko' && fB.state !== 'ko'
          && fA.rigBody && fB.rigBody) {
        const pa = fA.rigBody.position;
        const pb = fB.rigBody.position;
        const dx = pa.x - pb.x, dz = pa.z - pb.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        if (d < MIN_SEPARATION) {
          const push = (MIN_SEPARATION - d) * 0.5;
          const nx = dx / d, nz = dz / d;
          pa.x += nx * push; pa.z += nz * push;
          pb.x -= nx * push; pb.z -= nz * push;

          // Body-check shove: the part of each fighter's knockback driving
          // INTO the other is transferred, so charging/knocked into an opponent
          // shoves them instead of both sliding to a dead stop at the clamp.
          const aInto = -(fA.knockback.x * nx + fA.knockback.z * nz); // A → B
          if (aInto > 0.4) {
            fB.knockback.x += -nx * aInto * 0.45;
            fB.knockback.z += -nz * aInto * 0.45;
            fA.knockback.x -= -nx * aInto * 0.2;
            fA.knockback.z -= -nz * aInto * 0.2;
          }
          const bInto = (fB.knockback.x * nx + fB.knockback.z * nz);  // B → A
          if (bInto > 0.4) {
            fA.knockback.x += nx * bInto * 0.45;
            fA.knockback.z += nz * bInto * 0.45;
            fB.knockback.x -= nx * bInto * 0.2;
            fB.knockback.z -= nz * bInto * 0.2;
          }
        }
      }

      // 3c. Side view: cap the depth offset between the two at SIDE_VIEW_DEPTH_RATIO of their
      //    side-on spacing, half the correction each.
      if (this._sideView() && fA.state !== 'ko' && fB.state !== 'ko'
          && fA.rigBody && fB.rigBody) {
        const pa = fA.rigBody.position;
        const pb = fB.rigBody.position;
        const dz = pb.z - pa.z;
        const maxDz = Math.abs(pb.x - pa.x) * SIDE_VIEW_DEPTH_RATIO;
        if (Math.abs(dz) > maxDz) {
          const fix = (Math.abs(dz) - maxDz) * 0.5 * Math.sign(dz);
          pa.z += fix;
          pb.z -= fix;
        }
      }

      // 4. Read rig-root positions back into the THREE rigs so the visual
      //    matches the kinematic body. Clamped again: the push-apart above runs after
      //    step 1's ring clamp, and a fighter shoved onto the ropes rendered ~0.2 m
      //    through them.
      for (const f of this.fighters) {
        if (f.state !== 'ko' && f.rigBody) {
          const p = f.rigBody.position;
          p.x = THREE.MathUtils.clamp(p.x, -RING_HALF, RING_HALF);
          p.z = THREE.MathUtils.clamp(p.z, -RING_HALF, RING_HALF);
          f.rig.root.position.x = p.x;
          f.rig.root.position.z = p.z;
        }
      }
    }

    // Post collisions: high-momentum knockback against breakable props.
    for (const f of this.fighters) {
      for (const post of this.arena.posts) {
        if (!post.userData.breakable || !post.visible) continue;
        const d = post.position.clone().sub(f.rig.root.position);
        d.y = 0;
        const horiz = Math.hypot(d.x, d.z);
        if (horiz < 0.55 && f.knockback.lengthSq() > 6) {
          const chunks = damagePost(post, 30, this.scene);
          this.effects.push(...chunks.map((c) => ({ mesh: c, life: c.userData.life })));
          // Reflect knockback and dampen hard.
          f.knockback.multiplyScalar(-0.3);
          this._spawnSparks(post.position, 0xc8a060, 8, 1.5);
          this.audio.impact({ power: 1.0, worldPos: post.position });
          this.audio.prop({ material: 'steel', power: 1.0, worldPos: post.position });
        }
      }
    }

    // Face each other (yaw only). A body lying on the canvas doesn't yaw-track.
    // Rotational knockback rides on top as a decaying yaw offset: a hook
    // spins the defender off-facing, then they recover square.
    for (const f of this.fighters) {
      const opp = f === f1 ? f2 : f1;
      if (f.state !== 'ko') {
        if (f.spinVel !== 0 || f.spinYaw !== 0) {
          f.spinYaw += f.spinVel * dt;
          f.spinYaw = THREE.MathUtils.clamp(f.spinYaw, -0.7, 0.7);
          f.spinVel *= Math.exp(-dt * 5.5);
          f.spinYaw *= Math.exp(-dt * 4);
          if (Math.abs(f.spinVel) < 0.02 && Math.abs(f.spinYaw) < 0.005) {
            f.spinVel = 0;
            f.spinYaw = 0;
          }
        }
        const p = opp.rig.root.position;
        f.rig.root.rotation.y = Math.atan2(
          p.x - f.rig.root.position.x, p.z - f.rig.root.position.z) + f.spinYaw;
      }
    }
  }

  _aiContext(f, opp, dt) {
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const oppAttack = (opp.state === 'punch' || opp.state === 'kick') ? opp.attack : null;
    // A charging opponent reads as windup — the coil is the tell to block.
    const oppInWindup = opp.state === 'charge'
      || (!!oppAttack && opp.stateT < oppAttack.windup);
    const oppInActive = !!oppAttack && opp.stateT >= oppAttack.windup
      && opp.stateT <= oppAttack.windup + oppAttack.active;
    const oppInRecover = !!oppAttack && opp.stateT > oppAttack.windup + oppAttack.active;
    // Seconds until the opponent's live swing stops being able to hurt us, with
    // the per-swing timing muls _tryHit uses (Eisenhower stretches his wind-up).
    const oppSwingLeft = oppAttack
      ? Math.max(0, oppAttack.windup * (opp.swingWindupMul ?? 1)
        + oppAttack.active * (opp.swingActiveMul ?? 1) - opp.stateT)
      : 0;
    // ── Ring sense ────────────────────────────────────────────────────
    // Metres of canvas ahead of us along a direction before the ring clamp.
    // Without it every retreat and every gassed back-off walked the CPU
    // straight into the ropes; with it the AI can tell "give ground" from
    // "slide out sideways". `side` +1 follows _circleAxis (see _tickFighter).
    const pos = f.rig.root.position;
    const room = (dx, dz) => {
      let t = Infinity;
      if (dx > 1e-4) t = Math.min(t, (RING_HALF - pos.x) / dx);
      else if (dx < -1e-4) t = Math.min(t, (-RING_HALF - pos.x) / dx);
      if (dz > 1e-4) t = Math.min(t, (RING_HALF - pos.z) / dz);
      else if (dz < -1e-4) t = Math.min(t, (-RING_HALF - pos.z) / dz);
      return Math.max(0, t === Infinity ? RING_HALF * 2 : t);
    };
    const tx = opp.rig.root.position.x - pos.x;
    const tz = opp.rig.root.position.z - pos.z;
    const tl = Math.hypot(tx, tz) || 1;
    const ux = tx / tl, uz = tz / tl;
    return {
      dt,
      distance: dist,
      // Ring and scoreboard, for the AI's footwork and risk (ai.js). Rooms are
      // metres to the ropes going backward / circling +side / circling −side.
      backRoom: room(-ux, -uz),
      sideRoomPos: room(-uz, ux),
      sideRoomNeg: room(uz, -ux),
      ropeDist: RING_HALF - Math.max(Math.abs(pos.x), Math.abs(pos.z)),
      selfHp: this._hp(f) / MAX_HP,
      opponentHp: this._hp(opp) / MAX_HP,
      clock: this.clock || 0,
      timeLimit: this.training ? Infinity : TIME_LIMIT,
      // Frame data the guard and the punish need: how long the opponent's
      // swing can still hurt, whether they are coiling (and for how long), and
      // how long a blocked or stunned opponent stays unable to answer.
      opponentSwingLeft: oppSwingLeft,
      opponentCharging: opp.state === 'charge',
      opponentChargeT: opp.state === 'charge' ? opp.stateT : 0,
      opponentBlockStun: opp.blockStunT || 0,
      opponentHitstunLeft: opp.state === 'hitstun'
        ? Math.max(0, HITSTUN + (opp.hitstunBonus || 0) - opp.stateT) : 0,
      selfState: f.state,
      // How full our own coil is (0..1): ai.js lets go at its rung's maxCharge.
      selfCharge: f.state === 'charge' ? f.chargeAmt : 0,
      // The super fires only from idle (the 'idle' case of _tickFighter), so
      // the AI asks only when it will actually go off — a request from the
      // guard was dropped on the floor while ai.js still spent its cooldown.
      canSuper: f.state === 'idle' && !(f.blockStunT > 0)
        && (f.personality?.superMeter || 0) >= 1.0 && !!PERSONALITIES[f.charId]?.onSuper,
      // Sign of (opponent.x − self.x): +1 when the opponent is to our right,
      // −1 when to our left. The keyboard controller uses this to keep the
      // left/right keys screen-relative regardless of which side we're on.
      towardX: Math.sign(opp.rig.root.position.x - f.rig.root.position.x) || 1,
      kickRange: ATTACKS.kick.reach * opp.rig.config.heightScale + 0.3,
      opponentWindup: oppInWindup,
      opponentActive: oppInActive,
      opponentRecover: oppInRecover,
      opponentState: opp.state,
      ownAttacks: ATTACKS,
      // Super meter full? Only the AI reads this; players fire on the key.
      superMeterFull: (f.personality?.superMeter || 0) >= 1.0,
      // Energy gate. The engine enforces this regardless — a
      // gassed fighter's punch/kick intent is simply dropped in _tickFighter —
      // but the AI needs to KNOW, or it spends the whole recovery mashing
      // attack inputs into a closed gate and standing there wide open. Reading
      // it lets the CPU do what a player should do here: put the guard up and
      // earn the bar back.
      selfExhausted: !!f.gassed,
      selfEnergy: f.energy,
      // The same gate read from the other side. A gassed opponent cannot throw
      // anything until the bar recovers, and the guard is the fastest way back
      // up it — so this is the AI's cue to load a full coil (ai.js `punishGas`)
      // and ask the player whether they have learned to block yet.
      opponentExhausted: !!opp.gassed,
    };
  }

  _tickFighter(f, opp, intent, dt) {
    f.stateT += dt;

    // ── Energy regen ──────────────────────────────────────────────────
    // See the ENERGY_* block: guarding refills fast, standing refills slowly, swinging refills
    // nothing, and the charge state is exempt because it is actively DRAINING
    // the pool into the strike — regenerating there would refund the wind-up.
    //
    // No hudDirty here on purpose: _pushHud already flushes every 0.25 s, so a
    // continuous change reaches the HUD four times a second without flagging a
    // push on every single frame.
    //
    // Biden's "THE BIG GUY" super is exempt for its lock window: its payload
    // is a *guaranteed* max-power strike, so neither regen nor the gassed
    // bookkeeping may touch the bar before he throws it.
    const bigGuyLocked = f.personality?._bigGuyLockUntil
      && this.t < f.personality._bigGuyLockUntil;
    if (f.state !== 'charge' && f.state !== 'ko' && !bigGuyLocked) {
      let regen = 0;
      if (f.state === 'block') regen = ENERGY_BLOCK_REGEN_PER_SEC;
      else if (f.state === 'hitstun') regen = ENERGY_HITSTUN_REGEN_PER_SEC;
      else if (f.state !== 'punch' && f.state !== 'kick') regen = ENERGY_REGEN_PER_SEC;
      if (regen > 0) f.energy = Math.min(1, f.energy + dt * regen);
    }
    // Gassed-out bookkeeping, with the hysteresis band from ENERGY_RECOVER_TO.
    // Kept outside the exempt branch so a fighter can never be left flagged
    // gassed while sitting on a full bar.
    if (f.gassed) {
      if (f.energy >= ENERGY_RECOVER_TO) { f.gassed = false; this.hudDirty = true; }
    } else if (f.energy < ENERGY_ATTACK_FLOOR) {
      f.gassed = true;
      this.hudDirty = true;
    }
    const pos = f.rig.root.position;
    const effect = regionEffect(f.regionDmg);
    const moveSpeed = intent.move > 0 ? 2.4 : 1.9;
    const moveAccel = f.rig.config.moveAccel * 0.5; // tune base accel

    f.speedAmt = 0;

    // ── Movement with momentum ────────────────────────────────────────
    // Compute a desired world velocity from intent, lerp `vel` toward it,
    // and integrate. Knockback is added directly and decays.
    const desired = new THREE.Vector3();
    const incapacitated = f.state === 'ko';
    // Charging roots the fighter — all the weight is loaded into the coil.
    const rooted = f.state === 'charge';
    const canSteer = !incapacitated && !rooted;

    // Unit vector toward the opponent. Hoisted out of the move branch below
    // because circling needs it too: an orbit is defined by the line between
    // the fighters, so both axes of movement derive from it.
    const toward = opp.rig.root.position.clone().sub(pos);
    toward.y = 0;
    if (toward.lengthSq() > 1e-6) toward.normalize();

    // Speed modifiers, hoisted for the same reason — a slowed or dashing
    // fighter should circle slowed or dashing too.
    // Biden "The Big Guy" slow-on-charge: halved moveMul while the slow
    // window is live. Defaults to 1.0 (no slowdown).
    // JFK "PT-109 Survivor" dash speed boost: +30% for 4 s when below 50%.
    // FDR "Four-Term Foundation" startup boost: +10% for first 3 s.
    const slow = f.slowMul || 1.0;
    let passiveMul = 1.0;
    const per = f.personality;
    if (per?.jfkDashUntil && this.t < per.jfkDashUntil) passiveMul *= 1.30;
    if (per?.fdrStartupUntil && this.t < per.fdrStartupUntil
        && PERSONALITIES.fdr?.startupBoost) {
      passiveMul *= PERSONALITIES.fdr.startupBoost.speedMul || 1.10;
    }

    if (intent.move !== 0 && canSteer) {
      desired.add(toward.clone().multiplyScalar(
        intent.move * moveSpeed * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.min(1, Math.abs(intent.move));
    }

    // ── Circling (camera depth) ───────────────────────────────────────
    // `intent.side` is a HELD direction along the CAMERA's forward axis
    // (W/↑ = +1, into the screen; S/↓ = −1, out toward the viewer). Because the
    // fighters stand side-on to the camera, walking that axis carries you
    // around your opponent. Screen-relative, deliberately: an axis derived
    // from the fighters' line flips on screen whenever they swap sides.
    // It feeds `desired` (the same lerped velocity `move` uses), not an
    // impulse — a held impulse accumulates against its own decay.
    // The CPU has no screen: it circles on the axis perpendicular to the line
    // between the fighters (_circleAxis). On the camera axis its orbit turned
    // with every director cut, and near-parallel shots made it a lunge or a
    // retreat; its ring sense (_aiContext sideRoom*) is measured on this axis.
    if (intent.side !== 0 && canSteer) {
      const camFwd = f.controller instanceof AiController
        ? this._circleAxis(toward) : this._cameraForward();
      desired.add(camFwd.multiplyScalar(
        intent.side * CIRCLE_SPEED * effect.moveMul * slow * passiveMul));
      f.speedAmt = Math.max(f.speedAmt, Math.min(1, Math.abs(intent.side)));
    }
    // Move slowly even in hitstun/attack windup — the player is "shuffling".
    if (f.state === 'hitstun') desired.multiplyScalar(0.2);

    // Lerp velocity toward desired — mass-scaled accel; heavier fighters feel weightier.
    const a = moveAccel * (1 / f.rig.config.mass);
    const k = 1 - Math.exp(-dt * a);
    f.vel.lerp(desired, k);

    // Knockback impulse decays.
    f.knockback.multiplyScalar(Math.max(0, 1 - dt * 8));

    // Integrate position.
    pos.x += (f.vel.x + f.knockback.x) * dt;
    pos.z += (f.vel.z + f.knockback.z) * dt;

    // ── State machine ────────────────────────────────────────────────
    switch (f.state) {
      case 'idle': {
        // Energy regenerates slowly here and fast in the 'block' case; the
        // wind-up spends it and every release costs a flat toll on top. The
        // regen itself is applied once, above the state machine.
        // A punch needs the striking (right) arm — a fighter that lost it can
        // only kick. Kick input still works with no arms.
        // The energy gate sits ahead of both: a gassed fighter throws nothing.
        const hasEnergy = this._canAttack(f);
        const canPunch = intent.punch && hasEnergy && this._canPunch(f);
        if (canPunch || (intent.kick && hasEnergy)) {
          const name = canPunch ? 'punch' : 'kick';
          this._enterCharge(f, name);
          break;
        }
        // Signature super activation: only from idle so the pose read is clean
        // ("He lines up. He fires."). No-op if the meter isn't full or this
        // fighter has no onSuper config. A HUMAN fighter has no super key and
        // fires the instant the meter fills; the AI keeps its own gate (ai.js:
        // rung-scaled chance plus a cooldown) because that pacing is a
        // DIFFICULTY knob.
        if (intent.super || this._autoSuperReady(f)) this._fireSuper(f);
        if (intent.block) {
          f.state = 'block';
          // Stamp the moment the guard went up — this is what separates a read
          // from a camp when a strike lands on it. See PERFECT_GUARD_WINDOW.
          f.guardAt = this.t;
          f.animator.setBlocking(true);
        }
        break;
      }
      case 'charge': {
        // Winding up: charge accrues while the button is held (capped at
        // CHARGE_TIME; you can hold at max forever). Release throws the
        // attack scaled by the stored charge.
        const held = f.chargeName === 'punch' ? intent.punchHeld : intent.kickHeld;
        // Holding POURS the pool into the strike: the bar
        // drains at the same rate the coil loads, so a fighter watching their
        // own energy bar can see exactly what the swing is costing them, and a
        // full-power release is only available to someone who banked a full
        // bar by guarding for it. The drain is clamped to what is actually left,
        // so the coil simply stops growing on an empty bar rather than loading
        // power that was never paid for.
        // Biden's "THE BIG GUY" coil arrives pre-loaded (_enterCharge) and paid
        // for, so it pours nothing more out of the bar.
        const drain = bigGuyLocked ? 0 : Math.min(dt / CHARGE_TIME, f.energy);
        f.energy -= drain;
        f.chargeAmt = Math.min(1, f.chargeAmt + drain);
        f.animator.setCharge(f.chargeName, f.chargeAmt);
        // The coil in the hand: a pulse train that rises with it (haptics.js).
        this.haptics?.charge(f, f.chargeAmt);
        // Full-charge cue: one audible snap when the coil tops out.
        if (f.chargeAmt >= 1 && !f.chargeCued) {
          f.chargeCued = true;
          this.audio.whoosh();
        }
        // Spark motes at the loaded fist/foot once the charge means something.
        f.chargeSparkT -= dt;
        if (f.chargeAmt > 0.25 && f.chargeSparkT <= 0) {
          f.chargeSparkT = 0.16 - 0.08 * f.chargeAmt;
          const anchor = f.rig.joints[f.chargeName === 'punch' ? 'fistR' : 'footR'];
          if (anchor) {
            const p = new THREE.Vector3();
            anchor.getWorldPosition(p);
            this._spawnSparks(p, 0xffd257, 2, 0.4 + 0.5 * f.chargeAmt);
          }
        }
        if (!held) {
          const amt = f.chargeAmt;
          f.animator.setCharge(null, 0);
          this._enterAttack(f, f.chargeName, amt);
        }
        break;
      }
      case 'block': {
        if (!intent.block) {
          f.state = 'idle';
          f.animator.setBlocking(false);
        }
        break;
      }
      case 'punch':
      case 'kick': {
        const a = ATTACKS[f.state];
        const inActive = f.stateT >= a.windup && f.stateT <= a.windup + a.active;
        // Queued for the end of the tick when _tickFighting is collecting
        // (see _pendingHits there), so a same-frame trade is fair to both.
        if (inActive && !f.hasHit) {
          if (this._pendingHits) this._pendingHits.push([f, opp, a]);
          else this._tryHit(f, opp, a);
        }

        // Cancel windows: if the player input another action and we're past the
        // configured stateT threshold for that target, transition immediately.
        // Attack cancels re-enter the charge state so a held follow-up charges too.
        if (intent.punch && this._canAttack(f) && this._canPunch(f) && f.stateT >= a.cancelInto.punch) this._enterCharge(f, 'punch');
        else if (intent.kick && this._canAttack(f) && f.stateT >= a.cancelInto.kick) this._enterCharge(f, 'kick');
        else if (intent.block && f.stateT >= a.cancelInto.block) {
          f.state = 'block'; f.stateT = 0; f.guardAt = this.t;
          f.animator.setBlocking(true);
        } else if (f.stateT >= a.windup + a.active + a.recover) {
          f.state = 'idle'; f.stateT = 0; f.attack = null;
        }
        break;
      }
      case 'hitstun': {
        // hitstunBonus: a rattled head stuns longer (hitResolution.js _landHit).
        if (f.stateT >= HITSTUN + (f.hitstunBonus || 0)) f.state = 'idle';
        break;
      }
    }
  }

  // Start winding an attack up. The fighter is rooted until the button is
  // released (see the 'charge' case in _tickFighter), then _enterAttack
  // throws the strike scaled by the stored charge.
  _enterCharge(f, name) {
    this.haptics?.chargeEnd(f);
    f.state = 'charge';
    f.stateT = 0;
    f.chargeName = name;
    // Coil starts EMPTY and is filled out of the energy bar while the button is
    // held (see the 'charge' case) — except inside Biden's "THE BIG GUY" lock,
    // whose whole payload is a guaranteed full-power strike: resetting it here
    // threw that charge away on the very swing the super armed.
    const bigGuy = f.personality?._bigGuyLockUntil && this.t < f.personality._bigGuyLockUntil;
    f.chargeAmt = bigGuy ? 1 : 0;
    f.chargeCued = false;
    f.chargeSparkT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(name, f.chargeAmt);
    this._show('chargeStart', { f, name });
  }

  _enterAttack(f, name, chargeAmt = 0) {
    // A punch needs the striking (right) arm; if it was torn off mid-charge,
    // drop back to idle rather than swinging a missing limb.
    if (name === 'punch' && !this._canPunch(f)) {
      f.state = 'idle';
      f.stateT = 0;
      f.chargeName = null;
      f.animator.setCharge(null, 0);
      return;
    }
    f.state = name;
    f.stateT = 0;
    f.hasHit = false;
    f.attack = ATTACKS[name];
    f.chargeName = null;
    f.chargeMul = 1 + (CHARGE_MAX_MUL - 1) * chargeAmt;
    this._show('release', { f, name, chargeAmt });
    // Per-swing timing multipliers (Eisenhower "Operation Overlord": 1.5×
    // windup, 0.5× active; cleared at swing completion). Read by _tryHit
    // for the phase boundary check.
    f.swingWindupMul = 1.0;
    f.swingActiveMul = 1.0;
    if (f.personality?.id === 'eisenhower' && PERSONALITIES.eisenhower?.onSwingP) {
      f.swingWindupMul = PERSONALITIES.eisenhower.onSwingP.overWindupMul || 1.0;
      f.swingActiveMul = PERSONALITIES.eisenhower.onSwingP.overActiveMul || 1.0;
    }
    // The flat swing toll. The wind-up has already drained
    // whatever charge this strike carries; this is the additional per-swing cost
    // that makes tap-spam unsustainable, since a jab banks almost no charge but
    // still pays the toll. Scaled by the attack's own energyMul — a punch pays
    // half a kick's, which is what makes it the tempo move. Blocking and
    // standing are what refill the bar — see the ENERGY_* block and the regen
    // in _tickFighter.
    f.energy = Math.max(0, f.energy - ATTACK_ENERGY_COST * (f.attack.energyMul ?? 1));
    if (f.energy < ENERGY_ATTACK_FLOOR) f.gassed = true;
    this.hudDirty = true;
    f.animator.play(name);

    // ── On-swing personality flags (consumed at hit landing) ─────────
    // Trump "THE WALL" haymaker: 18% of swings commit to a heavy right with
    // 1.5× damage and 1.3× knockback. We tag the swing here; the hit handler
    // multiplies base damage by the mul and clears the flag.
    const per = f.personality;
    if (per?.id === 'trump' && PERSONALITIES.trump?.onSwingP
        && !per._haymakerSuppressedThisSwing
        && this.rng.random() < PERSONALITIES.trump.onSwingP.haymakerChance) {
      f._trumpHaymaker = true;
    }
    // Nixon "Tricky Dick": 25% of swings carry a dirty tag — when the hit
    // is blocked, ~40% of the time the block lets the damage slip through.
    // SUPER override: when "I Am Not a Crook" is active, ALL swings in the
    // remaining counter carry the dirty tag (decays per swing via the
    // superDirtySwingsLeft counter).
    const nixonDirtyChance = per?.id === 'nixon'
      ? (per.superDirtySwingsLeft > 0
          ? 1.0
          : PERSONALITIES.nixon.onSwingP.dirtyChance)
      : 0;
    if (per?.id === 'nixon' && PERSONALITIES.nixon?.onSwingP
        && !f._dirtySwing
        && this.rng.random() < nixonDirtyChance) {
      f._dirtySwing = true;
      if (per.superDirtySwingsLeft > 0) {
        per.superDirtySwingsLeft = Math.max(0, per.superDirtySwingsLeft - 1);
      }
    }
    // Bush Sr. "VOODOO ECONOMICS": next 3 swings after a super each carry
    // 1.4× damage on top of whatever else is going on. The flag flips off
    // one swing at a time.
    if (per?.id === 'bushsr' && per.superPumpSwingsLeft > 0) {
      f._bushsrSuperPump = true;
      per.superPumpSwingsLeft = Math.max(0, per.superPumpSwingsLeft - 1);
    }
    // Ford "Ford Stumble": 15% of swings self-stun for 0.6 s — abort the
    // committed swing mid-air and route the fighter to 'idle' briefly.
    if (per?.id === 'ford' && PERSONALITIES.ford?.onSwingP) {
      const cfg = PERSONALITIES.ford.onSwingP;
      if (this.rng.random() < cfg.stumbleChance) {
        per.stumbleUntil = this.t + cfg.stumbleSelfStunSecs;
        f.state = 'idle';
        f.stateT = 0;
        f.attack = null;
        f.animator.play('stumble');
        return;
      }
    }
    // Trail color: cool steel normally, hot gold on a well-charged release, so
    // gold reads as earned bonus power rather than lighting up every tap.
    if (f.trail) f.trail.color.setHex(chargeAmt > 0.65 ? 0xffd257 : 0xcfe0ff);
    this.audio.whoosh();
    if (name === 'kick' || chargeAmt > 0.65) this.audio.effort(f.charId, chargeAmt);
    // Attack lunge: a real step into the strike, scaled by charge. This is
    // where the "reach" lives, since the hitboxes track the actual limb.
    const opp = this.fighters.find((o) => o !== f);
    if (opp) {
      const dir = new THREE.Vector3().subVectors(opp.rig.root.position, f.rig.root.position);
      dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        // FDR "Fireside Chat" reach bonus: his next swing's lunge is scaled
        // by the per-fighter fdrNextSwingReachMul (set during a chat iframe).
        // (Was `(x && x > 1) || 1`, which yields `true`, i.e. 1 — never the bonus.)
        const reachMul = Math.max(1.0, f.personality?.fdrNextSwingReachMul || 1.0);
        if (reachMul > 1.0) f.personality.fdrNextSwingReachMul = 1.0; // consumed
        const lunge = (name === 'kick' ? 2.2 : 1.8) * (1 + 1.4 * chargeAmt) * reachMul;
        f.knockback.add(dir.multiplyScalar(lunge));
      }
    }
  }

  // The CPU's circling axis: the line between the fighters turned 90° (left of
  // `toward`, a unit XZ vector). +1 on `intent.side` follows it.
  _circleAxis(toward) {
    return new THREE.Vector3(-toward.z, 0, toward.x);
  }

  // The camera's forward direction, flattened to the ground plane: the axis the
  // circle keys walk along. +1 on `intent.side` follows this vector (into the
  // screen, away from the viewer); −1 walks back against it, toward the viewer.
  // The fallback covers the first frames before the camera is aimed; a zero
  // vector would drop the input silently.
  _cameraForward() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, -1);
  }

  // Decay the post-FX pulses and push them into the passes.
  _updateFx(dt) {
    // The super cinematic runs on WALL-CLOCK dt, which is why it lives here rather than in
    // _tick: the cinematic's own time dilation would otherwise stretch its
    // timeline, and a beat that slows itself down never ends.
    this._tickSuperCinematic(dt);
    this.caPulse *= Math.exp(-dt * 4);
    this.bloomPulse *= Math.exp(-dt * 5);
    this.exposurePulse *= Math.exp(-dt * 5);
    this.radialPulse *= Math.exp(-dt * 7);
    // Speedlines decay fast — they are a stamp, not a state. The super
    // cinematic re-arms them every frame while it runs, which is what keeps
    // them up for its duration without needing a second code path.
    this._speedPulse = (this._speedPulse || 0) * Math.exp(-dt * 6.5);
    if (this._speedPulse < 0.002 || this._calm()) this._speedPulse = 0;
    // The KO shot has to read: the killing blow arms a 0.78 afterimage and full speedlines,
    // which over a body launched across the ring smeared the frame into mush. Both are held
    // down for as long as the KO camera runs, and the rack focus follows the body below.
    const koShot = this.cameraMode === 'ko';
    if (koShot) this._speedPulse = Math.min(this._speedPulse, KO_SPEED_MAX);
    this._updateImpactFrames(dt);
    this._updateSpectacle(dt);

    // The room drops out for the length of the freeze. Driven from the
    // renderer rather than from _hitFeedback so it tracks the ACTUAL pause
    // (which _tick decrements) instead of the requested one; every path that
    // sets hitstopT — hits, clashes, supers — gets it for free.
    if (this.audio) this.audio.setHitstop(this.hitstopT > 0);

    // Afterimage. The pass is switched off (not just faded to 0) the moment
    // the window closes, because a damp-0 AfterimagePass still costs a full
    // screen blit and a target swap every frame; a disabled one costs nothing.
    if (this.afterimage) {
      if (this._smearT > 0) {
        this._smearT -= dt;
        this.afterimage.enabled = true;
        this.afterimage.uniforms.damp.value = koShot ? Math.min(this._smearAmt, KO_SMEAR_MAX) : this._smearAmt;
        if (this._smearT <= 0) {
          this._smearT = 0;
          this._smearAmt = 0;
          this.afterimage.enabled = false;
        }
      } else if (this.afterimage.enabled) {
        this.afterimage.enabled = false;
      }
    }

    // No-op unless a KO is running.
    if (this.rackFocus) {
      this.rackFocus.update(dt);
      // The focus was measured once, at the blow; the camera then pushes in on a moving body.
      // Keep it on the body's hips, and keep the field shallow rather than smeared.
      const pass = this.rackFocus.pass;
      const down = koShot && pass.enabled ? this.fighters?.find((f) => f.state === 'ko') : null;
      if (down) {
        down.rig.joints.hips.getWorldPosition(_blobPos);
        pass.uniforms.focus.value = this.camera.position.distanceTo(_blobPos);
        pass.uniforms.maxblur.value *= KO_DOF_MUL;
      }
    }
    if (this.fxPass) {
      // The shared impact envelope is ADDED to this game's own pulses rather
      // than replacing them. PoBrawl's per-attack feedback is tuned to the
      // attack (a kick smears more than a jab) and that nuance is worth
      // keeping; impactBus contributes the part that is common to every game,
      // so a hit punches the 3D image and shakes the DOM chrome on one curve.
      this.fxPass.uniforms.uCA.value = this.caPulse + PostFx.punchAberration(0.8);
      this.fxPass.uniforms.uRadial.value = this.radialPulse + PostFx.punchRadial(0.35);
      // KO color drain rides the lights-down blend (keeps the reds hot).
      this.fxPass.uniforms.uDesat.value = this.lightsDim * 0.55;
      // One uniform serves both the impact stamp and the super, which
      // simply keeps re-arming _speedPulse while its cinematic runs.
      this.fxPass.uniforms.uSpeed.value = this._speedPulse || 0;

      // Film grain clock. atmoT always advances, even between
      // rounds, so the grain never freezes on a paused frame.
      this.fxPass.uniforms.uTime.value = this.atmoT;
      // Vignette breathing: a slow ±0.04 swell around the 0.5 base,
      // tightening hard as the house lights drop for the KO so the frame
      // closes in on the fallen fighter.
      this.fxPass.uniforms.uVignette.value =
        0.5 + 0.04 * Math.sin(this.atmoT * 0.7) + this.lightsDim * 0.35;

      // Godrays stay off (visible streaks from the spotlight): held at 0 so the
      // shader's `if (uGodrays > 0.003)` branch skips its 16 taps per pixel.
      this.fxPass.uniforms.uGodrays.value = 0;
    }
    if (this.bloomPass) this.bloomPass.strength = 0.32 + this.bloomPulse;
    this.renderer.toneMappingExposure = this.exposureBase + this.exposurePulse;

    // Impact-light pool decay.
    for (const s of this._impactLights || []) {
      if (s.life > 0) {
        s.life = Math.max(0, s.life - dt);
        s.light.intensity = s.peak * (s.life / s.dur);
      }
    }
    this._updateDanger(dt);
  }

  // ══ Danger state ══════════════════════════════════════════════════════
  // A fighter under DANGER_HP is in the red: a heartbeat starts under the mix,
  // quickening as they drop; the music sinks under a lowpass; and the screen
  // edge on THEIR side of the frame tints red on each beat. The side is taken
  // from where the fighter actually is on screen (they swap sides), not from
  // which player they are. Wall-clock, so the beat keeps time through hitstop.
  _updateDanger(dt) {
    const side = [0, 0];
    let worst = 0;
    let worstF = null;
    if (this.phase === 'fighting' && !this.training && this.fighters && this.combat) {
      for (const f of this.fighters) {
        const hp = this._hp(f) / MAX_HP;
        if (hp <= 0) continue;
        const d = THREE.MathUtils.clamp((DANGER_HP - hp) / DANGER_RAMP, 0, 1);
        if (d <= 0) continue;
        _dmgProj.copy(f.rig.root.position).project(this.camera);
        const s = _dmgProj.x < 0 ? 0 : 1;
        side[s] = Math.max(side[s], d);
        if (d > worst) { worst = d; worstF = f; }
      }
    }
    const k = 1 - Math.exp(-dt * 3);
    this._dangerL = (this._dangerL || 0) + (side[0] - (this._dangerL || 0)) * k;
    this._dangerR = (this._dangerR || 0) + (side[1] - (this._dangerR || 0)) * k;

    // Heartbeat: 70 bpm at the threshold, 130 at the brink.
    if (worst > 0.01) {
      const period = 60 / (70 + 60 * worst);
      this._heartT = (this._heartT ?? period) + dt;
      if (this._heartT >= period) {
        this._heartT = 0;
        this._heartAge = 0;
        this.audio?.heartbeat(0.45 + 0.55 * worst);
        // Every other beat the fighter in the red sucks wind, in their own voice.
        this._breathBeat = !this._breathBeat;
        if (this._breathBeat && worstF) this.audio?.breath(worstF.charId, worst);
      }
    } else {
      this._heartT = undefined;
    }
    this._heartAge = (this._heartAge ?? 9) + dt;
    const a = this._heartAge;
    // Lub-dub envelope, matching the two thumps audio.heartbeat schedules.
    let pulse = Math.exp(-a * 7) + (a > 0.17 ? 0.7 * Math.exp(-(a - 0.17) * 7) : 0);
    if (this._calm()) pulse = 0.5; // reduced motion: the tint holds still
    if (this.fxPass) {
      const u = this.fxPass.uniforms;
      u.uDangerL.value = this._dangerL < 0.003 ? 0 : this._dangerL;
      u.uDangerR.value = this._dangerR < 0.003 ? 0 : this._dangerR;
      u.uHeart.value = Math.min(1, pulse);
    }
    // The music filter: throttled like the crowd push, for the same reason.
    if (this.audio && Math.abs(worst - (this._dangerPushed ?? -1)) > 0.04) {
      this._dangerPushed = worst;
      this.audio.setDanger(worst);
    }
  }

  // ══ Mat wear ══════════════════════════════════════════════════════════
  // Footwork scuffs the vinyl where a moving fighter plants; knockback drags
  // skid streaks; a KO'd body leaves a scrape and a puff of canvas dust.
  _updateMatWear(dt) {
    if (!this.matWear) return;
    this.matWear.update(dt);
    if (!this.fighters) return;
    if (this.phase === 'fighting' || this.phase === 'ko') {
      for (const f of this.fighters) {
        if (f.state === 'ko' || !f.vel || !f.knockback) continue;
        const root = f.rig.root.position;
        const kb = Math.hypot(f.knockback.x, f.knockback.z);
        if (kb > 1.6) {
          // Skid: two parallel streaks (one per shoe) from last frame's spot.
          if (f._skidFrom) {
            const dx = root.x - f._skidFrom.x, dz = root.z - f._skidFrom.z;
            const len = Math.hypot(dx, dz) || 1;
            const ox = (-dz / len) * 0.12, oz = (dx / len) * 0.12;
            const str = Math.min(1, kb / 4);
            this.matWear.skid(f._skidFrom.x + ox, f._skidFrom.z + oz, root.x + ox, root.z + oz, str);
            this.matWear.skid(f._skidFrom.x - ox, f._skidFrom.z - oz, root.x - ox, root.z - oz, str);
          } else {
            this._spawnDust(root.x, root.z, 0.3);
          }
          f._skidFrom = { x: root.x, z: root.z };
          continue;
        }
        f._skidFrom = null;
        const sp = Math.hypot(f.vel.x, f.vel.z);
        f._scuffT = (f._scuffT || 0) - dt;
        if (sp > 0.9 && f._scuffT <= 0) {
          f._scuffT = 0.14;
          const ang = Math.atan2(f.vel.z, f.vel.x);
          for (const name of ['footL', 'footR']) {
            const j = f.rig.joints[name];
            if (!j) continue;
            j.getWorldPosition(_blobPos);
            this.matWear.scuff(_blobPos.x, _blobPos.z, ang, Math.min(1, sp / 3));
          }
        }
      }
    }
    // The KO'd body meets the mat a beat after the blow (see the KO block in
    // hitResolution.js, which arms this): dust, a scrape and a sweat splash.
    if (this._koDust) {
      this._koDust.t -= dt;
      if (this._koDust.t <= 0) {
        const f = this._koDust.fighter;
        this._koDust = null;
        const hips = f?.rig?.joints?.hips;
        if (hips) {
          hips.getWorldPosition(_blobPos);
          if (Math.abs(_blobPos.x) < MAT_HALF && Math.abs(_blobPos.z) < MAT_HALF) {
            this._spawnDust(_blobPos.x, _blobPos.z, 1.3);
            this.matWear.bodyfall(_blobPos.x, _blobPos.z, 1);
            this._kickRig(1, _blobPos.x, _blobPos.z);
          }
        }
      }
    }
  }

  // ══ Result package: shatter + pyro (Full show) ═══════════════════════════
  // Called from _reportResult once the winner is known. The result itself — line, recap,
  // press — is the page's one result modal; nothing here repeats it.
  _presentResult() {
    // Full show: a KO breaks the glass into the result, and the winner gets the pyro.
    if (this._fullShow() && this.fighters.some((f) => f.state === 'ko')) {
      this._shatterPending = true;
      if (this.winner) this._startPyro();
    }
  }

  // Photosensitive-safe presentation: the app-wide reduced-motion setting
  // (user toggle OR OS preference) alone. Read live rather than cached so
  // flipping it mid-fight takes effect at once.
  _calm() {
    return motionReduced();
  }

  _triggerFlash() {
    // CSS chromatic-aberration flash on KO — DOM overlay so we don't need a
    // post-processing chain. Auto-clears on the next animation frame.
    if (!this.flash || this._calm()) return;
    this.flash.classList.remove('pb-flash-active');
    void this.flash.offsetWidth; // force reflow
    this.flash.classList.add('pb-flash-active');
  }

  // Hooks handed to props.js so the crate module can push damage / FX back
  // through the engine without importing it.
  _makePropHooks() {
    return {
      onChip: (f, dmg, dx, dz) => this._propChip(f, dmg, dx, dz),
      onImpactFx: (pos, power, kind) => {
        this._spawnSparks(pos, 0xc8a060, 8, 1.6);
        if (kind === 'wood') {
          this.audio.prop({ material: 'wood', power: power ?? 1, worldPos: pos });
          this._kickRig(0.35, pos.x, pos.z);
        } else {
          this.audio.impact({ power: power ?? 1, worldPos: pos });
        }
      },
    };
  }

  // Secondary "chip" damage from crashing into / getting hit by a crate
  // (chain reactions, corner turnbuckle). Capped so a crate can never land the
  // KILLING blow — HP is floored at 5 — keeping the KO strictly a fist/foot
  // event and the combat/KO pipeline untouched.
  _propChip(f, dmg, dx = 0, dz = 0) {
    if (!f || f.state === 'ko' || dmg <= 0) return;
    const player = this.combat.getPlayer(f.playerId);
    if (!player) return;
    const capped = Math.min(dmg, Math.max(0, player.health - 5));
    if (capped <= 0.1) return;
    // Online the server owns every point of HP — the crate still flies, it just costs nothing.
    if (!this.online) this.combat.damage({ playerId: f.playerId, amount: capped, sourceId: f.playerId });
    this.hudDirty = true;
    this._commentate('crate', f);
    const p = f.rig.root.position;
    this._spawnSparks(new THREE.Vector3(p.x, 1.0, p.z), 0xffd0a0, 5, 1.2);
    this.audio.grunt({ power: 0.6, charId: f.charId });
    setExpression(f.rig, 'hurt');
    f.expressionT = Math.max(f.expressionT, 0.4);
  }

  // Remove a fighter's live-fight rig root. Used at KO handoff (the ragdoll
  // replaces it), respawn and dispose. Never call from inside a physics step.
  _removeFighterPhysics(f) {
    if (!this._physics || !f.rigBody) return;
    const world = this._physics.world;
    if (world.bodies.includes(f.rigBody)) world.removeBody(f.rigBody);
    f.rigBody = null;
  }

  // Should this fighter's signature super fire on its own this frame? True
  // only for HUMAN-driven fighters with a full meter (there is no super key).
  // AI fighters fire through `intent.super`, keeping ai.js's rung-scaled
  // pacing. `_fireSuper` no-ops without an onSuper config (BOB has none).
  _autoSuperReady(f) {
    return f?.controller?.isHuman === true
      && (f.personality?.superMeter || 0) >= 1.0;
  }

  // Can this fighter still throw a punch? The engine only ever swings the RIGHT
  // arm, so a punch needs the right arm attached. (The left arm always tears off
  // first — see _severArm — so a one-armed fighter punches with its right; once
  // the right is gone too it can only kick.)
  _canPunch(f) {
    return !f.armsLost || !f.armsLost.has('R');
  }

  /**
   * The energy gate. False means this fighter may not START a
   * punch or kick — not a weaker one, none at all — because they have gassed
   * themselves out. Blocking and movement are deliberately still allowed: the
   * guard is the way back up the bar, so the punishment is "you must defend
   * now", not "you are a statue".
   *
   * Checked on the three routes a fighter takes into a normal attack: the idle
   * branch and the two mid-swing cancel-into-punch/kick windows.
   *
   * Deliberately NOT checked in _enterAttack. Supers go straight there, and a
   * signature move is a rare earned payoff that should never be swallowed by
   * the stamina economy — Biden's "THE BIG GUY" in particular sets energy to
   * 1.0 and swings on the same frame, before the gassed flag has been
   * recomputed, so a flag check there would eat exactly the strike the super
   * exists to guarantee.
   */
  _canAttack(f) {
    return !f.gassed;
  }


  _updateEffects(dt) {
    this._updateParticles(dt);
    this._updateSeveredLimbs(dt);
    this._updateBlood(dt);
    // The mesh-based list below carries post debris chunks.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      const mesh = e.mesh;
      if (e.vel) {
        mesh.position.x += e.vel.x * dt;
        mesh.position.y += e.vel.y * dt;
        mesh.position.z += e.vel.z * dt;
        e.vel.y += (e.gravity ?? 0) * dt;
      }
      if (e.angVel) {
        mesh.rotation.x += e.angVel.x * dt;
        mesh.rotation.y += e.angVel.y * dt;
        mesh.rotation.z += e.angVel.z * dt;
      }
      if (!e.vel) mesh.scale.multiplyScalar(1 + dt * 10);
      mesh.material.opacity = Math.max(0, e.life / 0.35);
      if (e.life <= 0) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  _updateCrowd(dt) {
    // Tournament: round baseline + the Elo storyline (cup.js); null in every other mode.
    this._tickCup(dt);
    const cup = this._cup;
    animateCrowd(this.arena.crowd, dt, this.clock, this.excited);
    // Phones come up for the last ten seconds, a fighter in the red, and the result.
    const phonesWanted = Math.max(cup ? cup.phones : 0, this.phase === 'result' ? 0.8
      : this.phase === 'fighting' && !this.training
        && (TIME_LIMIT - (this.clock || 0) <= 10 || (this._dangerPushed || 0) > 0.3) ? 1 : 0);
    this._phoneLevel += (phonesWanted - this._phoneLevel) * (1 - Math.exp(-dt * 1.5));
    this.excited = Math.max(cup ? cup.exciteFloor : 0, this.excited - dt * (cup ? cup.decay : 0.4));
    // The reactive hall shares the crowd's clock because it is driven by
    // the same two signals (excitement and the audio envelope).
    this._updateReactiveArena(dt);
    // The crowd you HEAR is fed the same excitement value as the crowd you
    // SEE, plus a floor that rises as the round wears on and a lift when either
    // fighter is nearly out. One signal, so the hall can never look tense and
    // sound bored.
    if (this.audio && this.fighters && this.combat) {
      const lowest = Math.min(this._hp(this.fighters[0]), this._hp(this.fighters[1])) / MAX_HP;
      const desperation = 1 - lowest;
      const late = Math.min(1, (this.clock || 0) / TIME_LIMIT);
      const want = Math.min(1, (0.18 + (cup ? cup.crowdLift : 0) + this.excited * 0.45 + desperation * 0.4 + late * 0.15)
        * (cup ? cup.energy : 1));
      // Throttled: each call cancels and rewrites automation on three
      // AudioParams, and at 60 fps that is 180 scheduled ramps a second for a
      // value that moves slowly. Every ramp is 0.6 s long anyway, so pushing
      // more often than the change is audible only cancels the previous ramp
      // before it arrives — the level would crawl instead of gliding.
      if (Math.abs(want - (this._crowdPushed ?? -1)) > 0.03) {
        this._crowdPushed = want;
        this.audio.setCrowdIntensity(want);
      }
    }
  }

  setMuted(m) {
    this.muted = !!m;
    this.audio.setMuted(this.muted);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this._splashTimer);
    // The pads first: releasing their held keys has to
    // reach the controllers before those are disposed below.
    if (this.gamepads) { this.gamepads.dispose(); this.gamepads = null; }
    if (this.haptics) { this.haptics.dispose(); this.haptics = null; }
    if (this.matWear) { this.matWear.dispose(); this.matWear = null; }
    if (this._pSprite) { this._pSprite.dispose(); this._pSprite = null; }
    this._disposeBlood();
    // Drop the tier subscription before anything else is torn down — the handler
    // touches the renderer and the arena lights, and a `po-gfx-tier` firing during
    // teardown would reach both after they are gone.
    if (this._offTierChange) { this._offTierChange(); this._offTierChange = null; }
    // Hand the analyser pump back. Leaving it on would keep a rAF loop
    // alive on every page the player visits afterwards, writing CSS variables
    // nothing reads.
    try { VisualRuntime.enableAudioReactive(false); } catch { /* */ }
    if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
    if (this._dropResumeAudio) this._dropResumeAudio();
    window.removeEventListener('keydown', this._onMuteKey);
    window.removeEventListener('keydown', this._onPauseKey);
    window.removeEventListener('blur', this._onFocusLost);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._disposeShow();
    this._disposeTraining();
    this._disposeNet();
    this._disposeCommentary();
    this._clearSpectacle();
    this._disposeCup();
    if (this.touchEl) { this.touchEl.remove(); this.container.classList.remove('pb-has-pad'); }
    if (this.fighters) for (const f of this.fighters) f.controller.dispose();
    if (this.audio) this.audio.close();
    if (this.props) { disposeProps(this.props); this.props = null; }
    if (this.fighters) {
      for (const f of this.fighters) {
        this._removeFighterPhysics(f);
        if (f.koRagdoll) f.koRagdoll.dispose();
      }
    }
    this._physics = null;
    // Before the traverse: a Reflector's render target is invisible to a
    // geometry/material walk. See disposeArenaReflector.
    disposeArenaReflector();
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose();
        }
      });
    }
    if (this.composer) this.composer.dispose?.();
    this._disposeDirector();
    // PMREM output target — a WebGLRenderTarget, invisible to the
    // geometry/material traverse above.
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this.scene) this.scene.environment = null;
    // The contact-shadow and AO-disc gradients, shared by every spawn (lighting.js); the
    // traverse above freed their materials, never the maps.
    this._disposeBlobTextures();
    // The live jumbotron canvas texture. The traverse above disposes
    // materials but never their maps, and this one is ours (arena.js's cached
    // static texture, which we replaced, deliberately is not touched).
    if (this._jumboTex) { this._jumboTex.dispose(); this._jumboTex = null; }
    this._jumboCanvas = this._jumboCtx = null;
    this._rigLenses = null;
    if (this.renderer) {
      this.renderer.dispose();
      // dispose() frees the GPU objects three.js allocated; it does NOT release
      // the WebGL context itself, which stays live until the detached canvas is
      // garbage collected. This is an SPA — the player walks between the 3D
      // games without a page load — so those zombie contexts accumulate against
      // the browser's per-process ceiling (~16 in Chrome). Past it, the next
      // getContext() can come back null and GameShell's probe reports "This game
      // needs 3D graphics" on a machine that renders 3D fine.
      // forceContextLoss() is WebGL-only; the WebGPU renderer has no such method.
      try { this.renderer.forceContextLoss?.(); } catch { /* context already gone */ }
      this.renderer.domElement.remove();
    }
    if (this.banner) this.banner.remove();
    if (this.flash) this.flash.remove();
    if (this.splash) this.splash.remove();
    // Removing the fx layer takes its damage numbers and combo badges with it;
    // dropping the node list too so a disposed game holds no detached elements.
    if (this.fx) this.fx.remove();
    if (this._dmgNodes) this._dmgNodes.length = 0;
    this.dotnet = null;
  }
}
// ── Subsystem composition ───────────────────────────────────────────────────
// Must run at module scope, after the class declaration and before any instance
// is constructed. index.js only ever imports BrawlGame from here, so by the time
// `new BrawlGame()` can be reached these methods are already on the prototype. The Full-show
// layers are the exception: show.js mixes them in when they first load.
mixin(BrawlGame.prototype, SceneSetup, PersonalityEffects, Vfx, Blood, Cinematics, HitResolution, Training, Netplay, Commentary, Spectacle, Cup, Ceremony, Director, Show, ...SHOW_MODULES,
  ReactiveArena, Lighting, HudFeedback);
