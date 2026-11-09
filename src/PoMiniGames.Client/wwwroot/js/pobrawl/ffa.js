// ffa.js — presidential battle royale, with optional human-controlled Bob.
import * as THREE from 'three';
import { buildArena } from './arena.js';
import { buildFighter, CHARACTERS, setExpression, updateJiggles } from './fighters.js';
import { Animator } from './animation.js';
import { AudioBus } from './audio.js';
import { guardCovers } from './hitboxes.js';
import { MAX_HP } from './constants.js';
import { FfaSeason, FFA_PROFILES, seededRandom } from './ffaSeason.js';
import { setup as setupFfaRendering } from './ffaRendering.js';
import { createAutomaticHighlights } from './ffaHighlights.js';
import { createWikimediaFacts } from './ffaFacts.js';
import { moveFighters, impactImpulse } from './ffaPhysics.js';
import { FfaAudio } from './ffaAudio.js';
import { createPhysicsWorld, buildArenaColliders, stepWorld } from './physics.js';
import { CannonRagdoll } from './ragdollPhysics.js';
import { FfaReplay } from './ffaReplay.js';
import { FfaPlayerInput } from './ffaPlayer.js';
import { getFfaAgentStrategy, getFfaAgentPresets } from './ffaAgents.js';
import { FfaRagdollBudget } from './ffaRagdollBudget.js';

const FIELD_SIZE = 16;
const ATTACK_RANGE = 1.55;
const RESULT_HOLD_MS = 5000;
const MODEL_SCALE = 0.68;

export class BrawlFfaGame {
  constructor(container, dotnetRef, options) {
    if (!Array.isArray(options.fighters) || options.fighters.length !== FIELD_SIZE) {
      throw new Error(`Brawl FFA needs exactly ${FIELD_SIZE} fighters.`);
    }

    this.container = container;
    this.dotnetRef = dotnetRef;
    this.options = options;
    this.roster = options.human ? [...options.fighters, { id: 'bob', name: 'Bob' }] : options.fighters;
    this.human = !!options.human;
    this.player = null;
    this.playerInput = null;
    this.paused = false;
    this.replay = null;
    this.koTime = 0;
    this.pendingChampion = null;
    this.replayVictim = null;
    this.fighters = [];
    this.audio = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.resizeObserver = null;
    this.lastFrame = 0;
    this.elapsed = 0;
    this.phase = 'intro';
    this.round = 0;
    this.disposed = false;
    this.started = false;
    this.resultTimer = 0;
    this.resultPending = false;
    this._animFrame = 0;
    this.cameraFocus = null;
    this.cameraShot = -1;
    this.cameraShotTime = 0;
    this.cameraKoHold = 0;
    this.cameraLook = new THREE.Vector3();
    this.reducedMotion = false;
    this.random = seededRandom(options.seed ?? 1);
    this.simulationTime = 0;
    this.seasons = null;
    this.roundProfile = 'balanced';
    this.broadcastTime = 0;
    this.eliminationFeed = [];
    this.benchmarkRunning = false;
    this.benchmark = null;
    this.agentEvaluation = null;
    this.rendering = null;
    this.highlights = null;
    this.facts = null;
    this.factsEnabled = false;
    this.presentation = {};
    this.physicsState = { pairs: 0, events: 0, saturated: false };
    this.physicsWarning = false;
    this.spatialAudio = null;
    this.motionQuery = null;
    this.ragdollPhysics = null;
    this.ragdollBudget = null;
    this.motionListener = () => {
      this.reducedMotion = this.motionQuery.matches;
      this.rendering?.setReducedMotion(this.reducedMotion);
      this._updateCamera(0);
    };
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionQuery.matches;
    this.motionQuery.addEventListener('change', this.motionListener);
    this.seasons = new FfaSeason(this.roster, {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    }, (message) => this._notify('OnFfaError', message), this.human ? 'pobrawl.ffa.player.seasons.v1' : undefined);
    this.round = this.seasons.state.totalRounds;
    this.factsEnabled = this.seasons.state.factsEnabled === true;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.setSize(this.container.clientWidth || 800, this.container.clientHeight || 540);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const arena = buildArena(this.scene, { rectAreaLights: 0 });
    // The overhead TV rig was designed for ringside cameras and occludes the FFA overview.
    arena.backdrop.visible = false;
    this.ragdollPhysics = createPhysicsWorld();
    this.ragdollPhysics.world.allowSleep = true;
    buildArenaColliders(this.ragdollPhysics.world, this.ragdollPhysics.materials);
    this.ragdollBudget = new FfaRagdollBudget();
    this.rendering = setupFfaRendering(this.scene, this.renderer, arena);
    this.rendering.setReducedMotion(this.reducedMotion);
    const onPresentation = (partial) => {
      this.presentation = { ...this.presentation, ...partial };
      this._notify('OnFfaPresentation', JSON.stringify(this.presentation));
    };
    this.highlights = createAutomaticHighlights(this.renderer.domElement, {
      onPresentation, enabled: this.seasons.state.recordHighlights !== false,
    });
    this.facts = createWikimediaFacts({ onPresentation });
    if (this.factsEnabled) this._waitingForFact();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 10, 13);
    this.camera.lookAt(0, 0, 0);
    this._resize();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.container);

    this.audio = new AudioBus();
    this.audio.setMuted(!!this.options.muted);
    void this.audio.resume();
    this.audio.startCrowd();
    this.spatialAudio = new FfaAudio(this.audio, { onError: (error) => {
      this._notify('OnFfaError', `Spatial audio failed: ${error.message || error}`);
    } });

    this.fighters = this.roster.map((entry, index) => {
      const rig = buildFighter(entry.id, this.rendering.fighterBuildOptions);
      rig.root.scale.setScalar(MODEL_SCALE);
      this.scene.add(rig.root);
      return {
        id: entry.id,
        name: entry.name,
        index,
        human: this.human && entry.id === 'bob',
        rig,
        animator: new Animator(rig.joints, rig.config.stance),
        koRagdoll: new CannonRagdoll(this.ragdollPhysics.world, this.ragdollPhysics.materials.ragdoll, rig),
        velocity: new THREE.Vector3(),
        target: null,
        retargetIn: 0,
        attackIn: 0,
        swing: null,
        blocking: false,
        guardRemaining: 0,
        guardCooldown: 0,
        stun: 0,
        hp: MAX_HP,
        alive: true,
        place: 0,
        expressionIn: 0,
        idleT: index * 0.6,
      };
    });
    this.rendering.registerFighters(this.fighters);
    this.player = this.fighters.find((f) => f.human) || null;
    if (this.human) this.playerInput = new FfaPlayerInput(this.container, (value) => this.setPaused(value ?? !this.paused));
    this.replay = new FfaReplay(this.fighters);

    this._startRound();
    this._animFrame = requestAnimationFrame((t) => this._frame(t));
  }

  _resize() {
    if (!this.renderer || !this.camera || !this.container) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this._updateCamera(0);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.rendering?.resize(width, height);
  }

  _startRound() {
    if (this.disposed) return;
    this.paused = false;
    this.resultPending = false;
    this._notify('OnFfaPaused', false);
    this.replay?.reset();
    this.ragdollBudget?.reset();
    this.playerInput?.release();
    this.pendingChampion = null;
    this.replayVictim = null;
    this.round++;
    this.roundProfile = this.seasons?.state.profile || this.options.profile || 'balanced';
    this.roundAgentPresets = Object.freeze(this.options.agentPresets ? { ...this.options.agentPresets }
      : Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons?.getAgentPreset(id) ?? 'native'])));
    this.random = seededRandom(this.seasons ? this.seasons.state.totalRounds + 1
      : (this.options.seed ?? 1) + (this.options.headless ? 0 : this.round - 1));
    this.simulationTime = 0;
    this.eliminationFeed = [];
    this.elapsed = 0;
    this.phase = 'fighting';
    this.cameraFocus = null;
    this.cameraShot = -1;
    this.cameraShotTime = 0;
    this.cameraKoHold = 0;
    this.audio?.crowdSwell(0.6);
    this.rendering?.resetRound();
    this.spatialAudio?.resetRound();
    this.physicsWarning = false;

    const slots = Array.from({ length: this.fighters.length }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    this.fighters.forEach((fighter, index) => {
      fighter.koRagdoll?.dispose();
      const angle = (2 * Math.PI * slots[index]) / this.fighters.length;
      const radius = 4.0 + (index % 2) * 0.28;
      fighter.rig.root.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      fighter.rig.root.rotation.set(0, angle + Math.PI, 0);
      fighter.rig.root.visible = true;
      fighter.animator = this.options.headless
        ? { play() {}, setBlocking() {}, update() {} }
        : new Animator(fighter.rig.joints, fighter.rig.config.stance);
      if (!this.options.headless) {
        for (const [name, joint] of Object.entries(fighter.rig.joints)) {
          const pose = fighter.animator.guard[name];
          joint.rotation.set(pose?.x || 0, pose?.y || 0, pose?.z || 0);
        }
        fighter.rig.joints.hips?.position.set(0, 1, 0);
      }
      fighter.velocity.set(0, 0, 0);
      fighter.target = null;
      fighter.retargetIn = this.random() * 0.4;
      fighter.attackIn = 0.5 + this.random() * 1.5;
      fighter.swing = null;
      fighter.blocking = false;
      fighter.guardRemaining = 0;
      fighter.guardCooldown = 0;
      fighter.stun = 0;
      fighter.hp = MAX_HP;
      fighter.alive = true;
      fighter.place = 0;
      fighter.expressionIn = 0;
      fighter.damage = 0;
      fighter.knockouts = 0;
      fighter.rearHitsTaken = 0;
      fighter.lastAttacker = null;
      fighter.idleT = index * 0.6;
      if (!this.options.headless) setExpression(fighter.rig, 'neutral');
    });
    this._notify('OnFfaRoundStarted', this.round);
    this._publishDashboard();
  }

  _frame(timestamp) {
    if (this.disposed) return;
    const dt = this.lastFrame ? Math.min((timestamp - this.lastFrame) / 1000, 0.05) : 0;
    this.lastFrame = timestamp;

    if (dt > 0 && !this.paused) {
      if (this.phase === 'fighting') {
        this.simulationTime += dt;
        while (this.simulationTime >= 1 / 60 && this.phase === 'fighting') {
          this._step(1 / 60);
          this.simulationTime -= 1 / 60;
        }
      }
      else if (this.phase === 'replay') {
        if (!this.replay.update(dt)) {
          this.replay.restore();
          this._showResult(this.pendingChampion);
        }
      } else {
        this._animateFalls(dt);
        if (this.phase === 'ko') {
          this.replay?.capture(dt);
          this.koTime += dt;
          if (this.koTime >= 0.9) {
            if (!this.reducedMotion && this.replay?.begin()) {
              this.phase = 'replay';
              this.playerInput?.release();
              this._notify('OnFfaReplay', true);
            } else this._showResult(this.pendingChampion);
          }
        }
        const champion = this.fighters.find((f) => f.alive);
        if (champion && this.phase !== 'replay') champion.animator.update({
          dt, speed: 0, idleT: champion.idleT += dt, root: champion.rig.root, vel: champion.velocity,
        });
      }
    }
    this._updateCamera(this.paused ? 0 : dt);
    this.spatialAudio?.update(this.camera, this.fighters, dt);
    this.broadcastTime += dt;
    if (this.broadcastTime >= 0.5) {
      this.broadcastTime = 0;
      const focus = this.cameraFocus;
      this._notify('OnFfaBroadcast', JSON.stringify({
        focus: focus?.id || '', health: focus?.hp || 0,
        attacker: focus?.lastAttacker || '', shot: this.phase === 'replay' ? 'KO replay · 0.5×'
          : this.human ? (this.player?.alive ? 'Bob follow cam' : 'Bob is out · spectating')
            : ['Ringside', 'Reverse angle', 'High crane'][this.cameraShot] || 'Overview',
        paused: this.paused, replay: this.phase === 'replay',
        finalDuel: this.fighters.filter((f) => f.alive).length === 2,
        overtime: this.elapsed >= 55,
        feed: this.eliminationFeed,
      }));
    }
    this.audio?.tick(dt);
    this.rendering.render(this.camera, dt);
    this._animFrame = requestAnimationFrame((t) => this._frame(t));
  }

  _updateCamera(dt) {
    if (!this.camera) return;
    if (this.human && this.player && this.phase !== 'replay') {
      const p = this.player.rig.root.position;
      this.cameraFocus = this.player;
      // Stable over-the-shoulder boom: movement stays screen-relative as Bob changes targets.
      const reach = this.camera.aspect < 0.8 ? 7 : 5;
      const position = new THREE.Vector3(p.x, 3.2, p.z + reach);
      const look = new THREE.Vector3(p.x, this.player.alive ? 0.9 : 0.25, p.z - 1);
      const blend = dt === 0 || this.reducedMotion ? 1 : 1 - Math.exp(-dt * 8);
      this.camera.position.lerp(position, blend);
      this.cameraLook.lerp(look, blend);
      this.camera.lookAt(this.cameraLook);
      this.camera.fov = this.camera.aspect < 0.8 ? 64 : 55;
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.phase === 'replay' && this.replayVictim) {
      const p = this.replayVictim.rig.root.position;
      this.cameraFocus = this.replayVictim;
      this.camera.position.set(p.x + 3.5, 2.8, p.z + 4);
      this.cameraLook.set(p.x, 0.55, p.z);
      this.camera.lookAt(this.cameraLook);
      this.camera.fov = this.camera.aspect < 0.8 ? 70 : 48;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.cameraShotTime += dt;
    this.cameraKoHold = Math.max(0, this.cameraKoHold - dt);
    const alive = this.fighters.filter((fighter) => fighter.alive);
    const weakest = alive.reduce((best, fighter) =>
      !best || fighter.hp < best.hp ? fighter : best,
    this.cameraFocus?.alive ? this.cameraFocus : null);
    const overview = this.reducedMotion || this.elapsed < 3
      || (this.phase === 'result' && this.cameraShotTime > 2.5);
    let cut = this.cameraShot < 0;
    if (!overview && this.cameraKoHold <= 0 && weakest !== this.cameraFocus) {
      this.cameraFocus = weakest;
      cut = true;
    }
    if (cut || (!overview && this.cameraShotTime >= 4)) {
      this.cameraShot = (this.cameraShot + 1) % 3;
      this.cameraShotTime = 0;
      cut = true;
    }
    const position = new THREE.Vector3(0, 10, 13);
    const look = new THREE.Vector3();
    if (!overview && this.cameraFocus) {
      const focus = this.cameraFocus;
      const opponent = this._nearestOpponent(focus, alive);
      const p = focus.rig.root.position;
      const q = opponent?.rig.root.position || p;
      const angle = Math.atan2(q.x - p.x, q.z - p.z)
        + [Math.PI / 2, -Math.PI / 2, Math.PI * 0.8][this.cameraShot];
      const x = p.x + Math.max(-1, Math.min(1, (q.x - p.x) * 0.35));
      const z = p.z + Math.max(-1, Math.min(1, (q.z - p.z) * 0.35));
      position.set(Math.max(-6, Math.min(6, x + Math.sin(angle) * 5.5)),
        [3.4, 4.3, 5.8][this.cameraShot],
        Math.max(-6, Math.min(6, z + Math.cos(angle) * 5.5)));
      // Leave space for the standings on the left without hiding the endangered fighter.
      look.set(x - Math.cos(angle) * 0.8, focus.alive ? 0.85 : 0.25, z + Math.sin(angle) * 0.8);
    }
    const blend = cut || dt === 0 ? 1 : 1 - Math.exp(-dt * 4);
    this.camera.position.lerp(position, blend);
    this.cameraLook.lerp(look, blend);
    this.camera.lookAt(this.cameraLook);
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(overview ? 42 : 48) / 2)
      / Math.min(this.camera.aspect, 1)));
    this.camera.updateProjectionMatrix();
  }

  _step(dt) {
    this.elapsed += dt;
    this._animateFalls(dt);
    this.replay?.capture(dt);

    const alive = this.fighters.filter((fighter) => fighter.alive);
    const intent = this.player?.alive ? this.playerInput?.update() : null;
    if (alive.length <= 1) {
      this._finish(alive[0]);
      return;
    }

    for (const fighter of alive) {
      if (this.phase !== 'fighting') break;
      if (!fighter.alive) continue;
      const strategy = this._strategy(fighter);
      fighter.idleT += dt;
      fighter.attackIn -= dt;
      fighter.stun = Math.max(0, fighter.stun - dt);
      fighter.guardRemaining = Math.max(0, fighter.guardRemaining - dt);
      fighter.guardCooldown = Math.max(0, fighter.guardCooldown - dt);
      fighter.retargetIn -= dt;
      if (!fighter.target?.alive || fighter.retargetIn <= 0) {
        fighter.target = this._nearestOpponent(fighter, alive);
        fighter.retargetIn = (0.35 + this.random() * 0.2) * strategy.retarget;
      }

      const target = fighter.target;
      if (!target) continue;
      const root = fighter.rig.root;
      const dx = target.rig.root.position.x - root.position.x;
      const dz = target.rig.root.position.z - root.position.z;
      const distance = Math.hypot(dx, dz) || 0.001;
      if (fighter.human) {
        fighter.intent = intent || { move: 0, side: 0, punch: false, kick: false, block: false };
        if (!fighter.swing && fighter.stun <= 0) root.rotation.y = Math.atan2(dx, dz);
        fighter.blocking = this.elapsed < 55 && !fighter.swing && fighter.stun <= 0 && fighter.intent.block;
        fighter.animator.setBlocking(fighter.blocking);
        const length = Math.hypot(fighter.intent.move, fighter.intent.side) || 1;
        const canMove = !fighter.swing && fighter.stun <= 0 && !fighter.blocking;
        const blend = Math.min(1, dt * (fighter.stun > 0 ? 1.5 : 8));
        const mx = canMove ? fighter.intent.move / length * 1.9 : 0;
        const mz = canMove ? -fighter.intent.side / length * 1.9 : 0;
        fighter.velocity.x += (mx - fighter.velocity.x) * blend;
        fighter.velocity.z += (mz - fighter.velocity.z) * blend;
        continue;
      }
      // Keep committed swings and hit reactions facing their original direction.
      // A third fighter can hit this fighter's exposed back without making them auto-turn.
      if (!fighter.swing && fighter.stun <= 0) root.rotation.y = Math.atan2(dx, dz);
      if (this.elapsed < 55 && !fighter.swing && fighter.stun <= 0 && target.swing && fighter.guardCooldown <= 0
          && guardCovers(fighter.rig, target.rig.root.position)) {
        fighter.guardRemaining = 0.24;
        fighter.guardCooldown = strategy.guard;
      }
      fighter.blocking = this.elapsed < 55 && !fighter.swing && fighter.stun <= 0 && fighter.guardRemaining > 0;
      fighter.animator.setBlocking(fighter.blocking);

      let moveX = 0, moveZ = 0;
      if (!fighter.swing && fighter.stun <= 0 && distance > ATTACK_RANGE * (0.82 / strategy.aggression)) {
        moveX = dx / distance;
        moveZ = dz / distance;
      }
      for (const other of alive) {
        if (other === fighter || !other.alive) continue;
        const ox = root.position.x - other.rig.root.position.x;
        const oz = root.position.z - other.rig.root.position.z;
        const separation = Math.hypot(ox, oz);
        if (separation > 0.001 && separation < 0.9) {
          const push = (0.9 - separation) / 0.9;
          moveX += (ox / separation) * push * 1.15;
          moveZ += (oz / separation) * push * 1.15;
        }
      }
      const moveLength = Math.hypot(moveX, moveZ);
      if (moveLength > 0.001 && fighter.stun <= 0) {
        moveX /= moveLength;
        moveZ /= moveLength;
      } else {
        moveX = 0;
        moveZ = 0;
      }

      const speed = (1.4 + Math.max(0, (fighter.rig.config.moveAccel || 12) - 10) * 0.08) * strategy.move;
      const blend = Math.min(1, dt * (fighter.stun > 0 ? 1.5 : 5));
      fighter.velocity.x += (moveX * speed - fighter.velocity.x) * blend;
      fighter.velocity.z += (moveZ * speed - fighter.velocity.z) * blend;
    }
    this.physicsState = moveFighters(this.fighters, dt, this.options.headless ? null
      : (contact) => this.spatialAudio?.impact(contact));
    if (this.physicsState.saturated && !this.physicsWarning) {
      this.physicsWarning = true;
      this._notify('OnFfaError', 'A crowded physics contact exceeded its budget; movement was stopped safely for this frame.');
    }
    for (const fighter of alive) {
      if (this.phase !== 'fighting') break;
      if (!fighter.alive) continue;
      const root = fighter.rig.root;
      const target = fighter.target;
      if (!target?.alive) continue;
      const distance = Math.hypot(target.rig.root.position.x - root.position.x, target.rig.root.position.z - root.position.z);
      fighter.animator.update({
        dt,
        speed: Math.min(1, fighter.velocity.length() / 2),
        idleT: fighter.idleT,
        root,
        vel: fighter.velocity,
      });
      if (!this.options.headless) updateJiggles(fighter.rig, dt);

      if (fighter.expressionIn > 0) {
        fighter.expressionIn -= dt;
        if (fighter.expressionIn <= 0 && !this.options.headless) setExpression(fighter.rig, 'neutral');
      }
      if (fighter.swing) {
        fighter.swing.remaining -= dt;
        if (fighter.swing.remaining <= 0) {
          const swing = fighter.swing;
          fighter.swing = null;
          this._landStrike(fighter, swing.target, swing.kick);
        }
      }
      if (fighter.human) {
        if (fighter.stun <= 0 && !fighter.blocking && !fighter.swing && fighter.attackIn <= 0
            && (fighter.intent.punch || fighter.intent.kick)) this._attack(fighter, target, fighter.intent.kick);
      } else if (distance <= ATTACK_RANGE && fighter.stun <= 0 && !fighter.blocking
          && !fighter.swing && fighter.attackIn <= 0) {
        this._attack(fighter, target);
      }
    }
  }

  _animateFalls(dt) {
    if (this.options.headless || !this.ragdollPhysics) return;
    stepWorld(this.ragdollPhysics.world, dt);
    for (const fighter of this.fighters) {
      if (!fighter.alive && (!this.ragdollBudget || this.ragdollBudget.shouldDrive(fighter.koRagdoll))) fighter.koRagdoll?.drive();
    }
    this.ragdollBudget?.update(dt);
  }

  _nearestOpponent(fighter, alive) {
    let nearest = null;
    let score = Infinity;
    for (const other of alive) {
      if (other === fighter || !other.alive) continue;
      const dx = other.rig.root.position.x - fighter.rig.root.position.x;
      const dz = other.rig.root.position.z - fighter.rig.root.position.z;
      const distance = Math.hypot(dx, dz);
      const candidate = distance * (0.85 + (other.hp / MAX_HP) * this._strategy(fighter).weak);
      if (candidate < score) {
        score = candidate;
        nearest = other;
      }
    }
    return nearest;
  }

  _attack(attacker, target, humanKick = false) {
    if (this.phase !== 'fighting' || !attacker.alive || !target.alive) return;
    const kick = attacker.human ? humanKick : this.random() < 0.35;
    attacker.animator.play(kick ? 'kick' : 'punch');
    attacker.attackIn = (0.72 + this.random() * 0.32) * this._strategy(attacker).pace;
    attacker.swing = { target, kick, remaining: kick ? 0.18 : 0.1 };
  }

  _landStrike(attacker, target, kick) {
    if (!attacker.alive || !target.alive || attacker.stun > 0 || this.phase !== 'fighting') return;
    const dx = target.rig.root.position.x - attacker.rig.root.position.x;
    const dz = target.rig.root.position.z - attacker.rig.root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > ATTACK_RANGE) return;
    // The attacker must face the strike, but the defender need not face the attacker.
    const yaw = attacker.rig.root.rotation.y;
    if (distance > 0.001 && (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / distance < 0.5) return;
    if (target.blocking && guardCovers(target.rig, attacker.rig.root.position)) {
      this.spatialAudio?.impact({ position: target.rig.root.position, energy: kick ? 35 : 20, material: 'cloth', blocked: true });
      this.rendering?.impact({ position: target.rig.root.position, power: 0.3, kind: 'hit', target, blocked: true });
      return;
    }
    const overtime = this.elapsed > 55 ? 1.45 : 1;
    const damage = Math.round((18 + this.random() * 14) * (attacker.rig.config.attackPower || 1) * overtime);
    const contact = impactImpulse(attacker, target, kick, damage);
    attacker.damage += Math.min(target.hp, damage);
    if (!guardCovers(target.rig, attacker.rig.root.position)) target.rearHitsTaken++;
    target.lastAttacker = attacker.id;
    target.hp = Math.max(0, target.hp - damage);
    target.stun = Math.max(target.stun, 0.24);
    target.swing = null;
    target.blocking = false;
    target.guardRemaining = 0;
    target.animator.setBlocking(false);
    target.animator.play('hitstun');
    if (!this.options.headless) setExpression(target.rig, 'hurt');
    target.expressionIn = 0.5;
    const hitPoint = target.rig.root.position.clone();
    hitPoint.y += 1.0;
    this.spatialAudio?.impact({ ...contact, position: hitPoint, material: 'flesh' });
    this.rendering?.impact({ position: hitPoint, normal: contact.normal, power: Math.min(1, damage / 35), kind: 'hit', target });
    this._notify('OnFfaHit', target.id, target.hp);

    if (target.hp <= 0) {
      attacker.knockouts++;
      this._eliminate(target, contact.normal, kick);
    }
  }

  _eliminate(fighter, knockDirection, kick = false) {
    if (!fighter.alive) return;
    fighter.alive = false;
    fighter.swing = null;
    fighter.blocking = false;
    if (!this.options.headless && fighter.koRagdoll) {
      const direction = knockDirection || new THREE.Vector3(
        -Math.sin(fighter.rig.root.rotation.y), 0, -Math.cos(fighter.rig.root.rotation.y));
      const options = {
        velocity: fighter.velocity,
        // Presentation jitter must not consume the seeded combat random stream.
        rng: { random: seededRandom(this.round * FIELD_SIZE + this.fighters.indexOf(fighter)) },
        launch: { knockMul: 0.45, velMul: 0.55, upMul: kick ? 0.85 : 0.4, flip: kick ? 2.5 : 1.2 },
      };
      if (this.ragdollBudget) this.ragdollBudget.activate(fighter.koRagdoll, direction, options);
      else fighter.koRagdoll.activate(direction, options);
    }
    fighter.velocity.set(0, 0, 0);
    if (fighter === this.cameraFocus) this.cameraKoHold = 1.2;
    const remaining = this.fighters.filter((entry) => entry.alive).length;
    fighter.place = remaining + 1;
    this.eliminationFeed.unshift({ id: fighter.id, attacker: fighter.lastAttacker || '', place: fighter.place });
    this.eliminationFeed = this.eliminationFeed.slice(0, 4);
    fighter.animator.frozen = true;
    this.audio?.ko();
    this.audio?.grunt({ power: 1, charId: fighter.id });
    this.audio?.crowdSwell(0.8);
    this.spatialAudio?.impact({ position: fighter.rig.root.position, energy: 55, material: 'shoe' });
    this.rendering?.impact({ position: fighter.rig.root.position, power: 1, kind: 'ko', target: fighter });
    this._notify('OnFfaEliminated', fighter.id, fighter.place, remaining);
    this.highlights?.mark({ type: 'ko', label: `Round ${this.round}: ${fighter.name} knocked out (#${fighter.place})` });
    if (remaining === 2) this.highlights?.mark({ type: 'final', label: `Round ${this.round}: final duel` });
    if (remaining === 1) this._finish(this.fighters.find((entry) => entry.alive));
  }

  _finish(champion) {
    if (this.phase !== 'fighting' || !champion) return;
    if (!this.options.headless && this.replay) {
      this.pendingChampion = champion;
      this.replayVictim = this.fighters.find((f) => f.place === 2);
      this.koTime = 0;
      this.phase = 'ko';
      this.playerInput?.release();
      return;
    }
    this._showResult(champion);
  }

  _showResult(champion) {
    if (this.disposed || !champion) return;
    this._notify('OnFfaReplay', false);
    this.phase = 'result';
    this.cameraFocus = champion;
    this.cameraKoHold = 0;
    this.cameraShotTime = 0;
    this.cameraShot = -1;
    champion.place = 1;
    champion.swing = null;
    champion.blocking = false;
    champion.velocity.set(0, 0, 0);
    champion.animator.setBlocking(false);
    champion.animator.play(champion.rig.config.entrance);
    if (!this.options.headless) setExpression(champion.rig, 'grin');
    this.audio?.crowdSwell(1);
    this._notify('OnFfaChampion', champion.id);
    if (this.options.headless) return;
    this.highlights?.mark({ type: 'champion', label: `Round ${this.round}: ${champion.name} wins` });
    if (this.factsEnabled) void this.facts.loadFighter(champion.id, champion.name);
    this.seasons?.record(this._results());
    this._publishDashboard();
    this.resultTimer = window.setTimeout(() => {
      if (this.human && this.paused) this.resultPending = true;
      else this._startRound();
    }, RESULT_HOLD_MS);
  }

  setPaused(paused) {
    if (!this.human) return;
    this.paused = !!paused;
    this.playerInput?.release();
    this._notify('OnFfaPaused', this.paused);
    if (!this.paused && this.resultPending) this._startRound();
  }

  _strategy(fighter) {
    const profile = this.options.candidate && fighter.id !== this.options.candidate ? 'balanced' : this.roundProfile;
    const global = FFA_PROFILES[profile];
    if (fighter.id === 'bob') return { ...global, aggression: 1, move: 1, retarget: 1 };
    const style = getFfaAgentStrategy(fighter.id, this.roundAgentPresets?.[fighter.id] || 'native');
    return { ...style, pace: style.pace * global.pace, guard: style.guard * global.guard,
      weak: style.weak * global.weak / FFA_PROFILES.balanced.weak };
  }

  _results() {
    return this.fighters.map(({ id, place, damage, knockouts, rearHitsTaken }) =>
      ({ id, place, damage, knockouts, rearHitsTaken }));
  }

  _publishDashboard() {
    if (this.seasons) this._notify('OnFfaDashboard', JSON.stringify({
      ...this.seasons.snapshot(), activeProfile: this.roundProfile, benchmark: this.benchmark || this.seasons.state.benchmark,
      benchmarkRunning: this.benchmarkRunning,
      agentEvaluation: this.agentEvaluation || this.seasons.state.agentLab?.report,
      agents: this.options.fighters.map(({ id, name }) => ({
        id, name, preset: this.seasons.getAgentPreset(id),
        style: getFfaAgentStrategy(id, this.seasons.getAgentPreset(id)),
        presets: getFfaAgentPresets(id).map((p) => p.id),
      })),
    }));
  }

  setProfile(profile) {
    this.seasons.setProfile(profile);
    this._publishDashboard();
  }

  setRecording(enabled) {
    this.highlights.setEnabled(enabled);
    this.seasons.state.recordHighlights = enabled;
    this.seasons.save();
  }

  downloadClip(id) {
    this.highlights.download(id);
  }

  setFacts(enabled) {
    this.factsEnabled = enabled;
    this.seasons.state.factsEnabled = enabled;
    this.seasons.save();
    this._publishDashboard();
    this.facts?.dispose();
    this.facts = createWikimediaFacts({ onPresentation: (partial) => {
      this.presentation = { ...this.presentation, ...partial };
      this._notify('OnFfaPresentation', JSON.stringify(this.presentation));
    } });
    if (enabled) this._waitingForFact();
    if (enabled && this.phase === 'result') {
      const champion = this.fighters.find((f) => f.alive);
      void this.facts.loadFighter(champion.id, champion.name);
    }
  }

  _waitingForFact() {
    this.presentation.fact = {
      status: 'waiting', text: 'Facts enabled. Champion facts appear between rounds.', sourceUrl: null, name: '',
    };
    this._notify('OnFfaPresentation', JSON.stringify(this.presentation));
  }

  resetSeasons() {
    if (this.benchmarkRunning) throw new Error('Wait for the benchmark to finish before resetting local seasons.');
    window.clearTimeout(this.resultTimer);
    this.benchmark = null;
    this.seasons.reset();
    this.setFacts(false);
    this.setRecording(true);
    this.round = 0;
    this._startRound();
  }

  async runBenchmark() {
    if (this.benchmarkRunning || this.disposed) return;
    this.benchmarkRunning = true;
    this.benchmark = { completed: 0, total: 48, physicsVersion: 3, rows: [] };
    this._publishDashboard();
    const totals = Object.keys(FFA_PROFILES).map((profile) =>
      ({ profile, rounds: 0, wins: 0, place: 0, damage: 0, knockouts: 0 }));
    try {
      for (let seed = 1; seed <= 16 && !this.disposed; seed++) {
        for (const row of totals) {
          const candidate = this.options.fighters[seed - 1].id;
          const match = new BrawlFfaGame(null, null, {
            fighters: this.options.fighters, headless: true, seed, profile: row.profile, candidate,
            agentPresets: this.roundAgentPresets,
          });
          match.fighters = this.options.fighters.map((entry) => ({
            ...entry, rig: { root: new THREE.Object3D(), config: CHARACTERS[entry.id], joints: {} },
            velocity: new THREE.Vector3(),
          }));
          match._startRound();
          let frame = 0;
          while (match.phase === 'fighting' && frame < 60 * 180) {
            for (let batch = 0; batch < 60 && match.phase === 'fighting'; batch++, frame++) match._step(1 / 60);
            await new Promise((resolve) => window.setTimeout(resolve, 0));
            if (this.disposed) return;
          }

          if (match.phase !== 'result') throw new Error(`Benchmark seed ${seed} exceeded 180 simulated seconds.`);
          const result = match._results().find((r) => r.id === candidate);
          row.rounds++;
          row.wins += result.place === 1 ? 1 : 0;
          row.place += result.place;
          row.damage += result.damage;
          row.knockouts += result.knockouts;
          this.benchmark.completed++;
          this.benchmark.rows = totals.filter((r) => r.rounds).map((r) => ({
            profile: r.profile, rounds: r.rounds, wins: r.wins, averagePlace: r.place / r.rounds,
            averageDamage: r.damage / r.rounds, knockouts: r.knockouts,
            placementGain: totals[0].place / totals[0].rounds - r.place / r.rounds,
          }));
          this._publishDashboard();
        }
      }
      if (!this.disposed && this.seasons) {
        this.seasons.state.benchmark = this.benchmark;
        this.seasons.save();
      }
    } catch (error) {
      this._notify('OnFfaError', `Strategy benchmark failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._publishDashboard();
    }
  }

  async evaluateAgent(characterId, preset) {
    if (this.benchmarkRunning || this.disposed) return;
    this.benchmarkRunning = true;
    this.agentEvaluation = null;
    this._publishDashboard();
    try {
      const evaluation = this.seasons.createAgentEvaluation(characterId, preset);
      const incumbents = Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons.getAgentPreset(id)]));
      const profile = this.seasons.state.profile;
      const simulate = async (seed, candidatePreset) => {
        const match = new BrawlFfaGame(null, null, {
          fighters: this.options.fighters, headless: true, seed, profile,
          agentPresets: { ...incumbents, [characterId]: candidatePreset },
        });
        match.fighters = this.options.fighters.map((entry) => ({
          ...entry, rig: { root: new THREE.Object3D(), config: CHARACTERS[entry.id], joints: {} },
          velocity: new THREE.Vector3(),
        }));
        match._startRound();
        let frame = 0;
        while (match.phase === 'fighting' && frame < 60 * 180) {
          for (let batch = 0; batch < 60 && match.phase === 'fighting'; batch++, frame++) match._step(1 / 60);
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          if (this.disposed) return null;
        }
        if (match.phase !== 'result') throw new Error(`Agent evaluation seed ${seed} exceeded 180 seconds.`);
        return match._results().find((r) => r.id === characterId);
      };
      const pairs = [];
      for (const seed of evaluation.seeds) {
        const incumbent = await simulate(seed, evaluation.incumbentPreset);
        if (this.disposed) return;
        const candidate = await simulate(seed, evaluation.candidatePreset);
        if (this.disposed) return;
        pairs.push({ seed, incumbent, candidate });
        this.agentEvaluation = { characterId, candidatePreset: preset, rounds: pairs.length,
          status: `Evaluated ${pairs.length} / ${evaluation.seeds.length} paired seeds` };
        this._publishDashboard();
      }
      this.agentEvaluation = { ...this.seasons.evaluateAgentCandidate(evaluation, pairs),
        status: 'Complete. Better average placement promotes the preset next round; ties retain the incumbent.' };
    } catch (error) {
      this._notify('OnFfaError', `Agent evaluation failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._publishDashboard();
    }
  }

  _notify(method, ...args) {
    if (!this.dotnetRef || this.disposed) return;
    this.dotnetRef.invokeMethodAsync(method, ...args).catch((error) => {
      if (!this.disposed) console.error(`[PoBrawl FFA] ${method} callback failed`, error);
    });
  }

  setMuted(muted) {
    this.audio?.setMuted(!!muted);
    this.spatialAudio?.setMuted(!!muted);
  }

  uiClick(action) {
    this.spatialAudio?.click(action);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this._animFrame);
    window.clearTimeout(this.resultTimer);
    this.resizeObserver?.disconnect();
    this.motionQuery?.removeEventListener('change', this.motionListener);
    this.spatialAudio?.dispose();
    this.audio?.close();
    this.highlights?.dispose();
    this.facts?.dispose();
    this.rendering?.dispose();
    this.playerInput?.dispose();
    this.replay?.dispose();
    this.ragdollBudget?.dispose();
    for (const fighter of this.fighters) fighter.koRagdoll?.dispose();
    this.ragdollPhysics = null;

    if (this.scene) {
      const geometries = new Set();
      const materials = new Set();
      this.scene.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material);
          }
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
    }
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
    this.fighters = [];
    this.scene = null;
    this.renderer = null;
  }
}
