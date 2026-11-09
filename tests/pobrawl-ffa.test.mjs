// Rendering/audio are stubbed; the FFA loop and PoBrawl's guard arc run unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const base = new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/', import.meta.url);
const source = (name) => readFileSync(new URL(name, base), 'utf8')
  .replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const n = this.length() || 1; return this.set(this.x / n, this.y / n, this.z / n); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  lerp(v, t) { return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t); }
}

class Animator {
  constructor() { this.guard = {}; }
  play() {}
  setBlocking() {}
  update() {}
}

class Object3D {
  constructor() {
    this.position = new Vector3();
    this.rotation = { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } };
    this.visible = true;
  }
  getWorldDirection(out) { return out.set(Math.sin(this.rotation.y), 0, Math.cos(this.rotation.y)); }
}

function harness(seed = 1, profile = 'balanced', human = false) {
  const math = Object.create(Math);
  math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const timers = [];
  const events = [];
  const world = { steps: 0 };
  const context = vm.createContext({
    console, Math: math, MAX_HP: 100, Animator,
    THREE: {
      Vector3, Object3D,
      Box3: class {
        setFromObject(root) { this.min = { y: root.position.y - 0.2 }; return this; }
      },
      MathUtils: { degToRad: (n) => n * Math.PI / 180, radToDeg: (n) => n * 180 / Math.PI },
    },
    setExpression() {}, updateJiggles() {},
    stepWorld(value) { value.steps++; },
    window: {
      setTimeout(callback, delay) {
        if (delay === 0) { callback(); return 0; }
        timers.push({ callback, delay }); return timers.length;
      },
      clearTimeout() {},
    },
    cancelAnimationFrame() {},
    requestAnimationFrame() { return 0; },
  });
  vm.runInContext(source('ffaAgents.js'), context);
  vm.runInContext(source('hitboxes.js'), context);
  vm.runInContext(source('ffaSeason.js'), context);
  vm.runInContext(source('ffaPhysics.js'), context);
  vm.runInContext(source('ffa.js'), context);
  const Game = vm.runInContext('BrawlFfaGame', context);
  const rosterSource = readFileSync(new URL('../src/PoMiniGames.Domain/Primitives/PoBrawlRoster.cs', import.meta.url), 'utf8');
  const entries = [...rosterSource.split('public static readonly PoBrawlFighter Bob')[0].matchAll(/new\("([^"]+)", "([^"]+)"\)/g)]
    .map((match) => ({ id: match[1], name: match[2] }));
  context.CHARACTERS = Object.fromEntries(entries.map(({ id }) => [id, { attackPower: 1, moveAccel: 12 }]));
  const game = new Game(null, {
    invokeMethodAsync(method, ...args) { events.push({ method, args }); return Promise.resolve(); },
  }, { fighters: entries, seed, profile, human });
  game.ragdollPhysics = { world };
  game.fighters = game.roster.map((entry) => {
    const root = {
      position: new Vector3(), rotation: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
      visible: true,
      getWorldDirection(out) { return out.set(Math.sin(this.rotation.y), 0, Math.cos(this.rotation.y)); },
    };
    return {
      ...entry, human: human && entry.id === 'bob', rig: { root, config: { attackPower: 1, moveAccel: 12 }, joints: {} },
      animator: new Animator(), velocity: new Vector3(), idleT: 0,
      koRagdoll: {
        active: false, drives: 0,
        activate(direction, options) {
          this.active = true;
          this.direction = new Vector3(direction.x, direction.y, direction.z);
          this.velocity = options.velocity.clone();
          this.launch = options.launch;
        },
        drive() { if (this.active) this.drives++; },
        dispose() { this.active = false; },
      },
    };
  });
  game.player = game.fighters.find((f) => f.human) || null;
  game._startRound();
  return { game, events, timers, context };
}

test('a held guard stops a front attack, but both guarded and unguarded backs take damage', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const { game } = harness();
    const [attacker, defender] = game.fighters;
    defender.rig.root.position.set(0, 0, 0);
    defender.rig.root.rotation.y = yaw;
    defender.blocking = true;
    attacker.rig.root.position.set(Math.sin(yaw), 0, Math.cos(yaw));
    attacker.rig.root.rotation.y = yaw + Math.PI;
    game._landStrike(attacker, defender, false);
    assert.equal(defender.hp, 100, 'front guard must protect');
    attacker.rig.root.position.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    attacker.rig.root.rotation.y = yaw;
    game._landStrike(attacker, defender, false);
    assert.ok(defender.hp < 100, 'guard must not protect the back');
    defender.stun = 0;
    const before = defender.hp;
    game._landStrike(attacker, defender, false);
    assert.ok(defender.hp < before, 'unguarded rear attack must also land');
  }
});

test('human FFA adds Bob to all sixteen CPUs, moves only with input and uses player-follow framing', () => {
  const { game } = harness(1, 'balanced', true);
  assert.equal(game.fighters.length, 17);
  assert.equal(game.fighters.filter((f) => f.human).length, 1);
  const bob = game.player;
  assert.equal(bob.id, 'bob');
  game.playerInput = { update: () => ({ move: 0, side: 0 }), release() {} };
  const before = bob.rig.root.position.clone();
  game._step(1 / 60);
  assert.equal(bob.rig.root.position.x, before.x);
  assert.equal(bob.rig.root.position.z, before.z);
  game.playerInput.update = () => ({ move: 1, side: 1 });
  for (let i = 0; i < 10; i++) game._step(1 / 60);
  assert.ok(bob.rig.root.position.x > before.x);
  assert.ok(bob.rig.root.position.z < before.z);
  game.camera = { position: new Vector3(), aspect: 1.6, lookAt() {}, updateProjectionMatrix() {} };
  game.elapsed = 10;
  game.fighters[0].hp = 1;
  game._updateCamera(0);
  assert.equal(game.cameraFocus, bob);
  assert.equal(game.camera.position.x, bob.rig.root.position.x);
  assert.equal(game.camera.position.z, bob.rig.root.position.z + 5);
  game.setPaused(true);
  assert.equal(game.paused, true);
  game._startRound();
  assert.equal(game.paused, false);
});

test('human attacks require a press and can select a kick without CPU auto-attacks', () => {
  const { game } = harness(1, 'balanced', true);
  const bob = game.player, rival = game.fighters[0];
  bob.rig.root.position.set(0, 0, 0);
  rival.rig.root.position.set(0, 0, -1.2);
  bob.target = rival;
  bob.retargetIn = 10;
  bob.attackIn = 0;
  game.playerInput = { update: () => ({ move: 0, side: 0, kick: false, punch: false }) };
  game._step(1 / 60);
  assert.equal(bob.swing, null);
  game.playerInput.update = () => ({ move: 0, side: 0, kick: true });
  game._step(1 / 60);
  assert.equal(bob.swing.kick, true);
});

test('paused human results cannot restart behind the studio; resume starts the pending next round', () => {
  const { game, timers } = harness(1, 'balanced', true);
  game._finish(game.fighters[0]);
  game.setPaused(true);
  const round = game.round;
  timers[0].callback();
  assert.equal(game.round, round);
  assert.equal(game.resultPending, true);
  game.setPaused(false);
  assert.equal(game.round, round + 1);
  assert.equal(game.phase, 'fighting');
});

test('final fall leads to half-speed replay before five-second results; reduced motion skips replay', () => {
  for (const reducedMotion of [false, true]) {
    const { game, timers } = harness();
    const champion = game.fighters[0];
    let restored = 0, began = 0;
    game.reducedMotion = reducedMotion;
    game.rendering = { render() {} };
    game.replay = { begin() { began++; return true; }, capture() {}, update: () => false, restore() { restored++; } };
    game._finish(champion);
    assert.equal(game.phase, 'ko');
    assert.equal(timers.length, 0);
    game.lastFrame = 100;
    game.koTime = 0.89;
    game._frame(130);
    assert.equal(game.phase, reducedMotion ? 'result' : 'replay');
    assert.equal(began, reducedMotion ? 0 : 1);
    if (!reducedMotion) {
      assert.equal(timers.length, 0);
      game._frame(160);
      assert.equal(restored, 1);
    }
    assert.equal(game.phase, 'result');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5000);
  }
});

test('paired strategy benchmark completes all 48 deterministic simulations without changing the live round', async () => {
  const { game, timers } = harness();
  const live = game.fighters.map((f) => ({ hp: f.hp, place: f.place }));
  await game.runBenchmark();
  assert.equal(game.benchmark.completed, 48);
  assert.equal(game.benchmarkRunning, false);
  assert.equal(game.benchmark.rows.length, 3);
  assert.ok(game.benchmark.rows.every((r) => r.rounds === 16 && r.averagePlace >= 1 && r.averagePlace <= 16));
  assert.equal(game.benchmark.rows[0].placementGain, 0);
  assert.deepEqual(game.fighters.map((f) => ({ hp: f.hp, place: f.place })), live);
  assert.equal(timers.length, 0);
  const first = JSON.stringify(game.benchmark);
  await game.runBenchmark();
  assert.equal(JSON.stringify(game.benchmark), first);
});

test('cinematic camera cuts to the lowest health, holds a KO, changes angles, and resets', () => {
  const { game } = harness();
  game.camera = { position: new Vector3(), aspect: 1.6, lookAt() {}, updateProjectionMatrix() {} };
  game._updateCamera(0);
  assert.equal(game.camera.position.y, 10);
  game.elapsed = 4;
  const [first, second] = game.fighters;
  first.hp = 12;
  game._updateCamera(0.016);
  assert.equal(game.cameraFocus, first);
  const shot = game.cameraShot;
  game._updateCamera(4);
  assert.notEqual(game.cameraShot, shot);
  second.hp = 5;
  game._updateCamera(0.016);
  assert.equal(game.cameraFocus, second);
  game._eliminate(second);
  game._updateCamera(0.5);
  assert.equal(game.cameraFocus, second);
  game._updateCamera(0.8);
  assert.equal(game.cameraFocus, first);
  game.camera.aspect = 390 / 700;
  game._updateCamera(0);
  assert.ok(game.camera.fov > 48 && game.camera.fov < 100);
  game._finish(first);
  game._updateCamera(0.016);
  assert.equal(game.cameraFocus, first);
  game._updateCamera(3);
  game._updateCamera(2);
  assert.ok(game.camera.position.y > 9.9);
  game._startRound();
  game._updateCamera(0);
  assert.equal(game.cameraFocus, null);
  assert.equal(game.camera.position.y, 10);
  game.elapsed = 5;
  game.reducedMotion = true;
  game._updateCamera(0);
  assert.equal(game.camera.position.y, 10);
});

test('a strike has a windup and cannot hit a dead, distant, or behind-the-attacker target', () => {
  const { game } = harness();
  const [attacker, target] = game.fighters;
  attacker.rig.root.position.set(0, 0, 0);
  attacker.rig.root.rotation.y = 0;
  target.rig.root.position.set(0, 0, 1);
  game._attack(attacker, target);
  assert.equal(target.hp, 100);
  assert.ok(attacker.swing.remaining > 0);
  target.rig.root.position.z = -1;
  game._landStrike(attacker, target, false);
  assert.equal(target.hp, 100);
  target.rig.root.position.z = 3;
  game._landStrike(attacker, target, false);
  assert.equal(target.hp, 100);
  target.rig.root.position.z = 1;
  target.alive = false;
  game._landStrike(attacker, target, false);
  assert.equal(target.hp, 100);
  assert.notEqual(game._nearestOpponent(attacker, game.fighters), target);
});

test('16 fighters reach one champion, unique places 1–16, and a five-second automatic reset', () => {
  for (const [profile, seed] of ['balanced', 'aggressive', 'cautious']
    .flatMap((profile) => Array.from({ length: 25 }, (_, i) => [profile, i + 1]))) {
    const { game, timers, events } = harness(seed, profile);
    assert.equal(game.fighters.length, 16);
    for (let frame = 0; frame < 60 * 180 && game.phase === 'fighting'; frame++) game._step(1 / 60);
    assert.equal(game.phase, 'result', `${profile} seed ${seed} must finish within 180 simulated seconds: ${
      JSON.stringify(game.fighters.filter((f) => f.alive).map((f) => ({ id: f.id, hp: f.hp,
        p: f.rig.root.position, v: f.velocity, detour: f.detour })))}`);
    assert.equal(game.fighters.filter((fighter) => fighter.alive).length, 1);
    assert.deepEqual(game.fighters.map((fighter) => fighter.place).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.equal(events.filter((event) => event.method === 'OnFfaEliminated').length, 15);
    assert.equal(events.filter((event) => event.method === 'OnFfaChampion').length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5000);
    for (let frame = 0; frame < 60 * 4; frame++) game._animateFalls(1 / 60);
    const knockedOut = game.fighters.filter((fighter) => !fighter.alive);
    assert.ok(knockedOut.every((fighter) => fighter.rig.root.visible && fighter.animator.frozen));
    assert.ok(knockedOut.every((fighter) => fighter.koRagdoll.active && fighter.koRagdoll.drives > 0));
    assert.ok(knockedOut.every((fighter) => fighter.velocity.length() === 0));
    timers[0].callback();
    assert.equal(game.round, 2);
    assert.equal(game.phase, 'fighting');
    assert.ok(game.fighters.every((fighter) => fighter.alive && fighter.hp === 100 && fighter.place === 0));
    assert.equal(game.fighters.filter((fighter) => fighter.swing).length, 0);
    assert.ok(game.fighters.every((fighter) => fighter.rig.root.visible && !fighter.animator.frozen));
    assert.ok(game.fighters.every((fighter) => !fighter.koRagdoll.active));
    assert.ok(game.fighters.every((fighter) => fighter.rig.root.position.y === 0 && fighter.rig.root.rotation.z === 0));
  }
});

test('knockout hands the current pose and hit momentum to the ragdoll without snapping to the floor', () => {
  const { game } = harness();
  const fighter = game.fighters[0];
  fighter.rig.root.position.set(1, 0.2, 2);
  fighter.rig.root.rotation.set(0.1, 0.7, 0.05);
  fighter.velocity.set(2, 0, -3);
  const direction = new Vector3(1, 0, 0);
  game._eliminate(fighter, direction, true);
  assert.deepEqual(fighter.rig.root.position, new Vector3(1, 0.2, 2));
  assert.equal(fighter.rig.root.rotation.z, 0.05);
  assert.equal(fighter.rig.root.rotation.x, 0.1);
  assert.deepEqual(fighter.koRagdoll.velocity, new Vector3(2, 0, -3));
  assert.deepEqual(fighter.koRagdoll.direction, direction);
  assert.equal(fighter.koRagdoll.launch.flip, 2.5);
  assert.equal(fighter.animator.frozen, true);
  game._animateFalls(1 / 60);
  assert.equal(fighter.koRagdoll.drives, 1);
  game._finish(game.fighters[1]);
  game._animateFalls(1 / 60);
  assert.equal(fighter.koRagdoll.drives, 2, 'fall continues during champion results');
  game.dispose();
  assert.equal(fighter.koRagdoll.active, false);
  assert.equal(game.ragdollPhysics, null);
});

test('a new round restores ragdolled joints immediately, not just the root transform', () => {
  const { game } = harness();
  const fighter = game.fighters[0];
  fighter.rig.joints.hips = new Object3D();
  fighter.rig.joints.hips.rotation.set(1.5, 0.6, -0.8);
  fighter.rig.joints.hips.position.set(0.1, 0.95, 0);
  fighter.rig.joints.torso = new Object3D();
  fighter.rig.joints.torso.rotation.set(1.4, -0.4, 0.9);
  game._eliminate(fighter);
  game._startRound();
  assert.deepEqual(fighter.rig.joints.hips.position, new Vector3(0, 1, 0));
  for (const joint of Object.values(fighter.rig.joints)) {
    assert.equal(joint.rotation.x, 0);
    assert.equal(joint.rotation.y, 0);
    assert.equal(joint.rotation.z, 0);
  }
});

test('a disposed exhibition cannot restart through an already queued result timer', () => {
  const { game, timers } = harness();
  game._finish(game.fighters[0]);
  game.dispose();
  timers[0].callback();
  assert.equal(game.round, 1);
});
