// ffaMode.js — the free-for-all on the 1v1 engine. BrawlGame runs mode 'ffa' with the same
// fighters, renderer, post chain, blood, sweat, limb loss, charge strikes, daze, crowd, PA and
// camera director as a 1v1 bout; this mixin adds what a crowded ring needs on top:
//
//   • a field of FFA_FIELD presidents (+ Bob when a human plays), spawned on a ring
//   • every fighter picks a TARGET (the 1v1 "opp"); the AI controllers fight that target
//   • a swing can land on whoever its limb touches, not only the target
//   • NO count in the free-for-all: a fighter who goes down is out for good. A knockdown
//     and an empty health bar both eliminate; the last one standing is champion
//   • the FFA page's interop (OnFfa*): standings, feed, broadcast, seasons, facts, agent lab
//
// The benchmark and the agent lab still play thousands of rounds with no renderer; that
// headless simulation lives in ffaSim.js and only feeds the dashboard.
import * as THREE from 'three-eco/webgpu';
import { MAX_HP, TIME_LIMIT } from './constants.js';
import { CHARACTERS } from './fighters.js';
import { FfaSeason, FFA_PROFILES } from './ffaSeason.js';
import { getFfaAgentStrategy, getFfaAgentPresets } from './ffaAgents.js';
import { createWikimediaFacts } from './ffaFacts.js';
import { FfaSim } from './ffaSim.js';

export const FFA_FIELD = 16;
/** Seconds the champion holds the ring before the next round. */
const RESULT_HOLD = 5;
/** Spawn ring radius (RING_HALF is 5.2). */
const SPAWN_RADIUS = 4.0;
/** A swing is tested against every standing body this close to the swinger. */
const HIT_REACH = 2.2;
/** After the clock runs out every blow lands harder, so a round always ends. */
const OVERTIME_DMG = 1.5;
/** Seconds a fallen body stays in the physics solver before it is frozen in place. */
const RETIRE_AFTER = 4;
/** Overtime: the closing ring's radius shrinks this fast (m/s) down to RING_MIN. */
const RING_CLOSE_RATE = 0.2;
const RING_MIN = 1.4;
/** Seconds between broadcast snapshots to the page. */
const BROADCAST_EVERY = 0.5;

class FfaModeMethods {
  /** Free-for-all bookkeeping. Called from start() before the first spawn. */
  _ffaInit() {
    const o = this.options;
    if (!Array.isArray(o.fighters) || o.fighters.length !== FFA_FIELD) {
      throw new Error(`Brawl FFA needs exactly ${FFA_FIELD} fighters.`);
    }
    this.ffaHuman = !!o.human;
    this.ffaRoster = this.ffaHuman ? [...o.fighters, { id: 'bob', name: 'Bob' }] : [...o.fighters];
    this.ffaFeed = [];
    this.ffaRoundId = 0;
    this.ffaBroadcastT = 0;
    this.ffaResultPending = false;
    this.ffaFocus = null;
    this.ffaFocusHold = 0;
    this.benchmark = null;
    this.benchmarkRunning = false;
    this.agentEvaluation = null;
    this.presentation = {};
    this.seasons = new FfaSeason(this.ffaRoster, {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    }, (message) => this._ffaNotify('OnFfaError', message),
    this.ffaHuman ? 'pobrawl.ffa.player.seasons.v1' : undefined);
    this.ffaRound = this.seasons.state.totalRounds;
    this.factsEnabled = this.seasons.state.factsEnabled === true;
    this.facts = createWikimediaFacts({ onPresentation: (p) => this._ffaPresent(p) });
    if (this.factsEnabled) this._ffaWaitingForFact();
    if (o.muted) this.setMuted(true);
  }

  _ffaNotify(method, ...args) {
    if (!this.dotnet || this.disposed) return;
    this.dotnet.invokeMethodAsync(method, ...args).catch((error) => {
      if (!this.disposed) console.error(`[PoBrawl FFA] ${method} callback failed`, error);
    });
  }

  _ffaPresent(partial) {
    this.presentation = { ...this.presentation, ...partial };
    this._ffaNotify('OnFfaPresentation', JSON.stringify(this.presentation));
  }

  /** The character ids to spawn, in roster order. */
  _ffaCharIds() {
    return this.ffaRoster.map((e) => e.id);
  }

  /** Where fighter `i` of `n` starts: a shuffled place on the spawn ring, facing the centre. */
  _ffaSpawnSlots(n) {
    const slots = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rng.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    return slots.map((s, i) => {
      const a = (2 * Math.PI * s) / n;
      const r = SPAWN_RADIUS + (i % 2) * 0.35;
      return { x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: a + Math.PI };
    });
  }

  /** Fresh per-round FFA fields on a just-spawned fighter. */
  _ffaDecorate(f, entry) {
    f.id = entry.id;
    f.ffaName = entry.name;
    f.human = this.ffaHuman && entry.id === 'bob';
    f.target = null;
    f.retargetIn = this.rng.random() * 0.4;
    f.alive = true;
    f.place = 0;
    f.dealt = 0;
    f.knockouts = 0;
    f.rearHitsTaken = 0;
    f.lastAttacker = null;
    f.ffaKoAt = 0;
    f.ffaRetired = false;
    // The meshes that cast a real shadow; only the camera's pair keep theirs (_ffaShadows).
    f.ffaCasters = [];
    f.rig.root.traverse((o) => { if (o.isMesh && o.castShadow) f.ffaCasters.push(o); });
  }

  /**
   * Sixteen full rigs casting into the key light's shadow map doubles the draw calls. The two
   * fighters the camera frames cast real shadows; the rest keep their contact blobs.
   */
  _ffaShadows() {
    const duo = this._duo();
    for (const f of this.fighters) {
      const on = duo.includes(f);
      if (f.ffaShadowOn === on) continue;
      f.ffaShadowOn = on;
      for (const m of f.ffaCasters || []) m.castShadow = on;
    }
  }

  /** A new round has spawned: tell the page, reset the feed and the camera's subject. */
  _ffaRoundStarted() {
    this.ffaRound += 1;
    this.ffaRoundId += 1;
    this.ffaFeed = [];
    this.ffaFocus = null;
    this.ffaFocusHold = 0;
    this.ffaResultPending = false;
    this.ffaRingCalled = false;
    this._ffaNotify('OnFfaPaused', false);
    this._ffaNotify('OnFfaRoundStarted', this.ffaRound, this.ffaRoundId);
    this._ffaPublishDashboard();
  }

  // ── Targets ────────────────────────────────────────────────────────────

  /** This round's style for a fighter (ffaAgents.js preset × the season profile). */
  _ffaStrategy(f) {
    const global = FFA_PROFILES[this.seasons?.state.profile] || FFA_PROFILES.balanced;
    if (f.id === 'bob') return { ...global, aggression: 1, move: 1, retarget: 1 };
    const style = getFfaAgentStrategy(f.id, this.seasons?.getAgentPreset(f.id) || 'native');
    return { ...style, weak: style.weak * global.weak / FFA_PROFILES.balanced.weak };
  }

  _ffaStanding() {
    return this.fighters.filter((f) => f.alive);
  }

  /** Nearest standing rival, weighted toward the hurt ones by the fighter's style. */
  _ffaPickTarget(f) {
    const weak = this._ffaStrategy(f).weak;
    let best = null, score = Infinity;
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      const q = o.rig.root.position;
      const s = Math.hypot(q.x - p.x, q.z - p.z) * (0.85 + (this._hp(o) / MAX_HP) * weak);
      if (s < score) { score = s; best = o; }
    }
    return best;
  }

  /** Re-aim everybody whose target fell or whose re-think timer ran out. Once per tick. */
  _ffaRetarget(dt) {
    for (const f of this.fighters) {
      if (!f.alive) continue;
      f.retargetIn -= dt;
      if (f.target?.alive && f.retargetIn > 0) continue;
      // Whoever just hit you is a strong candidate: a free-for-all is full of grudges.
      const grudge = f.lastAttacker && this.fighters.find((o) => o.id === f.lastAttacker && o.alive);
      f.target = grudge && this.rng.random() < 0.45 ? grudge : this._ffaPickTarget(f);
      f.retargetIn = (0.9 + this.rng.random() * 0.8) * this._ffaStrategy(f).retarget;
    }
  }

  /**
   * The fighter `f` is squared up to: the other corner in a 1v1, the chosen target in the
   * free-for-all. Never null while two are standing.
   */
  _opponentOf(f) {
    if (!this.ffa) return f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
    if (f.target && f.target !== f && f.target.alive) return f.target;
    f.target = this._ffaPickTarget(f) || f.target || this.fighters.find((o) => o !== f);
    return f.target;
  }

  /** Who a live swing by `f` may land on this tick: its target first, then anyone in reach. */
  _hitCandidates(f, opp) {
    if (!this.ffa) return [opp];
    const out = opp?.alive ? [opp] : [];
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || o === opp || !o.alive) continue;
      const q = o.rig.root.position;
      if (Math.hypot(q.x - p.x, q.z - p.z) <= HIT_REACH) out.push(o);
    }
    return out;
  }

  /** Overtime: past the clock every blow in the free-for-all lands harder. */
  _ffaDamageMul() {
    return this.ffa && (this.clock || 0) > TIME_LIMIT ? OVERTIME_DMG : 1;
  }

  /** A blow landed: credit it and tell the standings. */
  _ffaOnDamage(attacker, defender, dmg) {
    if (!this.ffa || !(dmg > 0)) return;
    attacker.dealt += Math.min(dmg, this._hp(defender) + dmg);
    defender.lastAttacker = attacker.id;
    // Hit from behind (outside the defender's facing): the agent lab scores these.
    const yaw = defender.rig.root.rotation.y;
    const a = attacker.rig.root.position, d = defender.rig.root.position;
    const dx = a.x - d.x, dz = a.z - d.z, len = Math.hypot(dx, dz) || 1;
    if ((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / len < 0) defender.rearHitsTaken += 1;
    // The struck fighter turns on whoever is hitting them.
    if (defender.target !== attacker && this.rng.random() < 0.6) defender.target = attacker;
    this._ffaNotify('OnFfaHit', defender.id, this._hp(defender));
  }

  /**
   * In the free-for-all a knockdown is the end: no count. Empty the health bar through
   * CombatPlay so the usual KO path (ragdoll, feed, champion) runs.
   */
  _ffaKnockout(f, attacker, knockDir) {
    const hp = this._hp(f);
    if (hp > 0) {
      this.combat.damage({ playerId: f.playerId, amount: hp + 1, sourceId: attacker?.playerId ?? f.playerId, bypassArmor: true });
    }
    this._resolveCombatEvents({
      attacker: attacker || f, defender: f, attack: { name: 'punch' },
      hit: { point: f.rig.root.position.clone().setY(1.2) }, region: 'head',
      knockDir: knockDir || new THREE.Vector3(0, 0, -1), torqueY: 0, counter: false,
    });
  }

  /** Called from the PLAYER_KILLED event: the fighter is out of the free-for-all. */
  _ffaEliminated(downed, attacker) {
    if (!downed.alive) return;
    downed.alive = false;
    downed.target = null;
    downed.controller?.releaseAll?.();
    if (attacker && attacker !== downed) attacker.knockouts += 1;
    const remaining = this.fighters.filter((f) => f.alive).length;
    downed.place = remaining + 1;
    downed.ffaKoAt = this.t;
    this.ffaFeed.unshift({ id: downed.id, attacker: downed.lastAttacker || '', place: downed.place });
    this.ffaFeed = this.ffaFeed.slice(0, 4);
    // Shadows and the swing ribbon go with them; the ragdoll stays on the canvas.
    if (downed.trail) downed.trail.mesh.visible = false;
    for (const f of this.fighters) if (f.target === downed) f.retargetIn = 0;
    if (this.ffaFocus === downed) this.ffaFocusHold = 1.4;
    const p = downed.rig.root.position;
    this._spawnCallout?.(new THREE.Vector3(p.x, 1.6, p.z), `#${downed.place}`);
    if (remaining > 1) {
      this._jumboCaption?.(`${remaining} LEFT`, 1.2);
      this.audio?.crowdSwell?.(0.8);
    }
    this._ffaNotify('OnFfaEliminated', downed.id, downed.place, remaining);
  }

  // ── The camera's pair ──────────────────────────────────────────────────

  /**
   * The two fighters the camera, the director, the spotlight and the danger cues frame:
   * both corners in a 1v1; in the free-for-all Bob (or the featured fighter) and whoever
   * they are squared up to.
   */
  _duo() {
    if (!this.ffa) return this.fighters;
    const focus = this._ffaFocusFighter();
    const other = focus.alive ? this._opponentOf(focus) : this._ffaNearest(focus);
    return [focus, other || focus];
  }

  _ffaNearest(f) {
    let best = null, d = Infinity;
    const p = f.rig.root.position;
    for (const o of this.fighters) {
      if (o === f || !o.alive) continue;
      const q = o.rig.root.position;
      const s = Math.hypot(q.x - p.x, q.z - p.z);
      if (s < d) { d = s; best = o; }
    }
    return best;
  }

  /** Bob while he stands; otherwise the most endangered fighter, held a moment after a KO. */
  _ffaFocusFighter() {
    const bob = this.fighters.find((f) => f.human);
    if (bob?.alive) return (this.ffaFocus = bob);
    if (this.phase === 'result' || this.phase === 'ko') {
      const champ = this.winner ? this.fighters[this.winner - 1] : null;
      if (champ) return (this.ffaFocus = champ);
    }
    if (this.ffaFocus && (this.ffaFocusHold > 0 || this.ffaFocus.alive)) {
      if (this.ffaFocus.alive && this._hp(this.ffaFocus) > 30) return this.ffaFocus;
      if (this.ffaFocusHold > 0) return this.ffaFocus;
    }
    let pick = null;
    for (const f of this.fighters) {
      if (!f.alive) continue;
      if (!pick || this._hp(f) < this._hp(pick)) pick = f;
    }
    this.ffaFocus = pick || this.fighters[0];
    return this.ffaFocus;
  }

  // ── The tick ───────────────────────────────────────────────────────────

  /** Per tick, before the fighters move. */
  _ffaTick(dt) {
    this.ffaFocusHold = Math.max(0, this.ffaFocusHold - dt);
    if (this.phase === 'fighting') {
      this._ffaRetarget(dt);
      this._ffaCloseRing(dt);
    }
    this._ffaRetireBodies();
    this.ffaBroadcastT += dt;
    if (this.ffaBroadcastT >= BROADCAST_EVERY) {
      this.ffaBroadcastT = 0;
      this._ffaBroadcast();
      this._ffaShadows();
    }
    if (this.phase === 'result' && !this.ffaResultPending && this.phaseT >= RESULT_HOLD) {
      if (this.paused) this.ffaResultPending = true;
      else this._ffaNextRound();
    }
  }

  /**
   * A fallen body leaves the physics solver once it has had RETIRE_AFTER seconds to land,
   * keeping its last pose, so a ring full of bodies costs nothing to simulate.
   */
  _ffaRetireBodies() {
    for (const f of this.fighters) {
      if (f.alive || f.ffaRetired || !f.ffaKoAt || this.t - f.ffaKoAt < RETIRE_AFTER) continue;
      if (f.pendingKO) continue; // not built yet
      if (f.koRagdoll?.active) f.koRagdoll.drive();
      f.koRagdoll?.dispose();
      f.ffaRetired = true;
    }
  }

  /**
   * Overtime: the ring closes. Past the clock every standing fighter is herded inside a
   * shrinking circle, so the last few cannot keep to their own corners and the round ends.
   */
  _ffaCloseRing(dt) {
    const over = (this.clock || 0) - TIME_LIMIT;
    if (over < 0) { this.ffaRingCalled = false; return; }
    if (!this.ffaRingCalled) {
      this.ffaRingCalled = true;
      this._jumboCaption?.('OVERTIME', 1.6);
      this._caption?.('Overtime: the ring is closing.');
      this.audio?.crowdSwell?.(0.9);
    }
    const r = Math.max(RING_MIN, SPAWN_RADIUS + 1 - over * RING_CLOSE_RATE);
    for (const f of this.fighters) {
      if (!f.alive) continue;
      const p = f.rig.root.position;
      const d = Math.hypot(p.x, p.z);
      if (d <= r || d < 1e-3) continue;
      const push = Math.min(4, (d - r) * 6) * dt;
      f.knockback.x -= (p.x / d) * push;
      f.knockback.z -= (p.z / d) * push;
    }
    // Everybody squares up to the nearest survivor: no more stalking across the ring.
    for (const f of this.fighters) if (f.alive && f.retargetIn > 0.5) f.retargetIn = 0.5;
  }

  _ffaNextRound() {
    this.ffaResultPending = false;
    this.resetMatch({ splash: false });
  }

  _ffaBroadcast() {
    const focus = this.ffaFocus;
    const standing = this.fighters.filter((f) => f.alive).length;
    const bob = this.fighters.find((f) => f.human);
    this._ffaNotify('OnFfaBroadcast', JSON.stringify({
      focus: focus?.id || '', health: focus ? this._hp(focus) : 0,
      attacker: focus?.lastAttacker || '',
      shot: this.ffaHuman ? (bob?.alive ? 'Bob follow cam' : 'Bob is out · spectating')
        : this._dir?.shot ? String(this._dir.shot) : 'Ringside',
      paused: !!this.paused, replay: this.phase === 'replay',
      finalDuel: standing === 2,
      overtime: (this.clock || 0) > TIME_LIMIT,
      feed: this.ffaFeed,
    }));
  }

  /** The last one standing: record the season, show the champion, queue the next round. */
  _ffaReportResult() {
    const champ = this.winner ? this.fighters[this.winner - 1] : this.fighters.find((f) => f.alive);
    if (!champ) return;
    champ.place = 1;
    this._setBanner(`${(champ.ffaName || champ.rig.config.name).toUpperCase()} WINS!`);
    this._setCameraMode('normal', { force: true });
    this._ffaNotify('OnFfaReplay', false);
    this._ffaNotify('OnFfaChampion', champ.id, this.ffaRoundId);
    if (this.factsEnabled) void this.facts?.loadFighter(champ.id, champ.ffaName || champ.rig.config.name);
    this.seasons?.record(this._ffaResults());
    this._ffaPublishDashboard();
    this._show('result', { winner: this.winner, ko: true });
    this._presentResult();
  }

  _ffaResults() {
    return this.fighters.map((f) => ({
      id: f.id, place: f.place || 1, damage: Math.round(f.dealt), knockouts: f.knockouts,
      rearHitsTaken: f.rearHitsTaken,
    }));
  }

  _ffaPublishDashboard() {
    if (!this.seasons) return;
    this._ffaNotify('OnFfaDashboard', JSON.stringify({
      ...this.seasons.snapshot(), activeProfile: this.seasons.state.profile || 'balanced',
      benchmark: this.benchmark || this.seasons.state.benchmark,
      benchmarkRunning: this.benchmarkRunning,
      agentEvaluation: this.agentEvaluation || this.seasons.state.agentLab?.report,
      agents: this.options.fighters.map(({ id, name }) => ({
        id, name, preset: this.seasons.getAgentPreset(id),
        style: getFfaAgentStrategy(id, this.seasons.getAgentPreset(id)),
        presets: getFfaAgentPresets(id).map((p) => p.id),
      })),
    }));
  }

  _ffaWaitingForFact() {
    this.presentation.fact = {
      status: 'waiting', text: 'Facts enabled. Champion facts appear between rounds.', sourceUrl: null, name: '',
    };
    this._ffaNotify('OnFfaPresentation', JSON.stringify(this.presentation));
  }

  // ── The FFA page's API (index.js ffa*) ─────────────────────────────────

  setProfile(profile) {
    this.seasons?.setProfile(profile);
    this._ffaPublishDashboard();
  }

  setFacts(enabled) {
    if (!this.seasons) return;
    this.factsEnabled = !!enabled;
    this.seasons.state.factsEnabled = this.factsEnabled;
    this.seasons.save();
    this._ffaPublishDashboard();
    this.facts?.dispose();
    this.facts = createWikimediaFacts({ onPresentation: (p) => this._ffaPresent(p) });
    if (enabled) this._ffaWaitingForFact();
    if (enabled && this.phase === 'result') {
      const champ = this.winner ? this.fighters[this.winner - 1] : null;
      if (champ) void this.facts.loadFighter(champ.id, champ.ffaName || champ.rig.config.name);
    }
  }

  resetSeasons() {
    if (this.benchmarkRunning) throw new Error('Wait for the benchmark to finish before resetting local seasons.');
    this.benchmark = null;
    this.seasons.reset();
    this.setFacts(false);
    this.ffaRound = 0;
    this._ffaNextRound();
  }

  /** Headless rounds through ffaSim.js; the live ring keeps fighting meanwhile. */
  async _ffaSimulate(opts) {
    const sim = new FfaSim({ fighters: this.options.fighters, ...opts });
    let frame = 0;
    while (sim.phase === 'fighting' && frame < 60 * 180) {
      for (let batch = 0; batch < 60 && sim.phase === 'fighting'; batch++, frame++) sim.step(1 / 60);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (this.disposed) return null;
    }
    if (sim.phase !== 'result') throw new Error(`Seed ${opts.seed} exceeded 180 simulated seconds.`);
    return sim.results();
  }

  async runBenchmark() {
    if (this.benchmarkRunning || this.disposed || !this.seasons) return;
    this.benchmarkRunning = true;
    this.benchmark = { completed: 0, total: 48, physicsVersion: 5, rows: [] };
    this._ffaPublishDashboard();
    const totals = Object.keys(FFA_PROFILES).map((profile) =>
      ({ profile, rounds: 0, wins: 0, place: 0, damage: 0, knockouts: 0 }));
    const presets = Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons.getAgentPreset(id)]));
    try {
      for (let seed = 1; seed <= 16 && !this.disposed; seed++) {
        for (const row of totals) {
          const candidate = this.options.fighters[seed - 1].id;
          const results = await this._ffaSimulate({ seed, profile: row.profile, candidate, agentPresets: presets });
          if (!results) return;
          const result = results.find((r) => r.id === candidate);
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
          this._ffaPublishDashboard();
        }
      }
      if (!this.disposed) {
        this.seasons.state.benchmark = this.benchmark;
        this.seasons.save();
      }
    } catch (error) {
      this._ffaNotify('OnFfaError', `Strategy benchmark failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._ffaPublishDashboard();
    }
  }

  async evaluateAgent(characterId, preset) {
    if (this.benchmarkRunning || this.disposed || !this.seasons) return;
    this.benchmarkRunning = true;
    this.agentEvaluation = null;
    this._ffaPublishDashboard();
    try {
      const evaluation = this.seasons.createAgentEvaluation(characterId, preset);
      const incumbents = Object.fromEntries(this.options.fighters.map(({ id }) => [id, this.seasons.getAgentPreset(id)]));
      const profile = this.seasons.state.profile;
      const run = async (seed, candidatePreset) => {
        const results = await this._ffaSimulate({
          seed, profile, agentPresets: { ...incumbents, [characterId]: candidatePreset },
        });
        return results && results.find((r) => r.id === characterId);
      };
      const pairs = [];
      for (const seed of evaluation.seeds) {
        const incumbent = await run(seed, evaluation.incumbentPreset);
        if (this.disposed || !incumbent) return;
        const candidate = await run(seed, evaluation.candidatePreset);
        if (this.disposed || !candidate) return;
        pairs.push({ seed, incumbent, candidate });
        this.agentEvaluation = { characterId, candidatePreset: preset, rounds: pairs.length,
          status: `Evaluated ${pairs.length} / ${evaluation.seeds.length} paired seeds` };
        this._ffaPublishDashboard();
      }
      this.agentEvaluation = { ...this.seasons.evaluateAgentCandidate(evaluation, pairs),
        status: 'Complete. Better average placement promotes the preset next round; ties retain the incumbent.' };
    } catch (error) {
      this._ffaNotify('OnFfaError', `Agent evaluation failed: ${error.message}`);
    } finally {
      this.benchmarkRunning = false;
      this._ffaPublishDashboard();
    }
  }

  /** The page's buttons click through the arena's audio bus. */
  uiClick() {
    this.audio?.uiClick?.();
  }

  _ffaDispose() {
    this.facts?.dispose();
    this.facts = null;
  }
}

/** Character name for an FFA roster id (Bob included). */
export function ffaName(id) {
  return CHARACTERS[id]?.name ?? id;
}

export const FfaMode = FfaModeMethods.prototype;
