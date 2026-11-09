import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaRagdollBudget.js', import.meta.url), 'utf8');
const context = vm.createContext({ Math, Number, Object, Map });
const { FfaRagdollBudget } = vm.runInContext(
  `${source.replace(/^export /gm, '')}\n({ FfaRagdollBudget })`, context,
);

class Body {
  static SLEEPING = 2;
  constructor() {
    this.sleepState = 0;
    this.velocity = { x: 0, y: 1, z: 0 };
    this.angularVelocity = { x: 0, y: 0, z: 0 };
  }
  sleep() { this.sleepState = Body.SLEEPING; }
  wakeUp() { this.sleepState = 0; }
}

function ragdoll(world = { bodies: [], constraints: [] }, scale = 1) {
  const instance = {
    rig: { root: { scale: { x: scale }, visible: true, pose: 0 } },
    world, bodies: null, constraints: null, drives: 0, disposals: 0, options: null,
    get active() { return !!this.bodies; },
    activate(direction, options) {
      if (this.active) this.dispose();
      this.options = options;
      this.bodies = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`part${i}`, new Body()]));
      this.constraints = Array.from({ length: 10 }, () => ({}));
      world.bodies.push(...Object.values(this.bodies));
      world.constraints.push(...this.constraints);
    },
    drive() { this.drives++; this.rig.root.pose++; },
    dispose() {
      if (!this.active) return;
      this.disposals++;
      for (const body of Object.values(this.bodies)) world.bodies.splice(world.bodies.indexOf(body), 1);
      for (const constraint of this.constraints) world.constraints.splice(world.constraints.indexOf(constraint), 1);
      this.bodies = null;
      this.constraints = null;
    },
  };
  instance.activate();
  return instance;
}

test('default capacity supports seventeen fighters and sixteen corpses; deadline retires all physics', () => {
  const budget = new FfaRagdollBudget();
  const world = { bodies: [], constraints: [] };
  const corpses = Array.from({ length: 16 }, () => ragdoll(world));
  for (const corpse of corpses) assert.equal(budget.track(corpse), true);
  assert.equal(budget.stats.maxRagdolls, 16);
  assert.equal(budget.stats.maxBodies, 176);
  assert.equal(budget.stats.maxFallSeconds, 4);
  assert.equal(world.bodies.length, 176);
  assert.equal(world.constraints.length, 160);
  budget.update(3.9);
  assert.equal(world.bodies.length, 176, 'moving ragdolls keep their fall until the deadline');
  assert.equal(budget.update(0.1), 16);
  assert.equal(world.bodies.length, 0);
  assert.equal(world.constraints.length, 0);
  assert.equal(budget.stats.bodies, 0);
  assert.equal(budget.stats.constraints, 0);
  assert.equal(budget.stats.retiredRagdolls, 16);
  assert.equal(budget.stats.activeRagdolls, 0);
  for (const corpse of corpses) {
    assert.equal(corpse.active, false);
    assert.equal(budget.shouldDrive(corpse), false);
    assert.equal(corpse.rig.root.visible, true);
    assert.equal(corpse.drives, 1, 'last physics pose is driven before disposing');
  }
  const poses = corpses.map((corpse) => corpse.rig.root.pose);
  budget.update(10);
  budget.reset();
  assert.deepEqual(corpses.map((corpse) => corpse.rig.root.pose), poses, 'reset does not change frozen visuals');
  assert.equal(budget.stats.trackedRagdolls, 0);
});

test('still parts sleep independently and a fully settled corpse retires early', () => {
  const budget = new FfaRagdollBudget({ settleSeconds: 0.2 });
  const corpse = ragdoll();
  budget.track(corpse);
  const bodies = Object.values(corpse.bodies);
  for (const body of bodies.slice(1)) body.velocity.y = 0;
  budget.update(0.1);
  assert.equal(budget.update(0.1), 0);
  assert.equal(budget.stats.sleepingBodies, 10);
  assert.equal(budget.shouldDrive(corpse), true);
  bodies[0].velocity.y = 0;
  assert.equal(budget.update(0.2), 1);
  assert.equal(budget.stats.settledRagdolls, 1);
  assert.equal(corpse.world.bodies.length, 0);
  assert.equal(corpse.world.constraints.length, 0);
  assert.equal(budget.shouldDrive(corpse), false);
});

test('retired ragdolls resume from retained rigs or activate again without stale resources', () => {
  const budget = new FfaRagdollBudget({ maxFallSeconds: 3 });
  const corpse = ragdoll();
  budget.track(corpse);
  budget.update(3);
  const pose = corpse.rig.root.pose;
  assert.equal(budget.resume(corpse), true);
  assert.equal(corpse.rig.root.pose, pose);
  assert.equal(corpse.options.launch.upMul, 0);
  assert.equal(corpse.world.bodies.length, 11);
  assert.equal(corpse.world.constraints.length, 10);
  assert.equal(budget.shouldDrive(corpse), true);
  budget.update(3);
  assert.equal(budget.activate(corpse, { x: 1, z: 0 }, { launch: { upMul: 2 } }), true);
  assert.equal(corpse.options.launch.upMul, 2);
  assert.equal(corpse.world.bodies.length, 11);
  assert.equal(budget.stats.retiredRagdolls, 0);
  budget.reset();
  assert.equal(corpse.world.bodies.length, 0);
  assert.equal(corpse.world.constraints.length, 0);
  assert.equal(budget.activate(corpse, { x: 1, z: 0 }), true);
  budget.dispose();
  budget.dispose();
  assert.equal(corpse.world.bodies.length, 0);
  assert.equal(corpse.world.constraints.length, 0);
  assert.equal(budget.activate(corpse, { x: 1 }), false);
});

test('capacity overflow preserves the visible pose, body cap is independent, and scale affects sleep', () => {
  const budget = new FfaRagdollBudget({ maxRagdolls: 2, maxBodies: 11, linearSpeed: 0.1 });
  const corpse = ragdoll(undefined, 0.5);
  assert.equal(budget.track(corpse), true);
  assert.equal(Object.values(corpse.bodies)[0].sleepSpeedLimit, 0.05);
  const overflow = ragdoll();
  assert.equal(budget.track(overflow), false);
  assert.equal(overflow.active, false);
  assert.equal(overflow.drives, 1);
  assert.equal(overflow.rig.root.visible, true);
  assert.equal(overflow.world.bodies.length, 0);
  assert.equal(overflow.world.constraints.length, 0);
});

test('invalid time does not advance retirement and external disposal is safely forgotten', () => {
  const budget = new FfaRagdollBudget({ maxFallSeconds: 100 });
  assert.equal(budget.maxFallSeconds, 4, 'fall duration cannot exceed four seconds');
  const corpse = ragdoll();
  budget.track(corpse);
  assert.equal(budget.update(Number.NaN), 0);
  assert.equal(budget.update(-1), 0);
  assert.equal(budget.update(0), 0);
  assert.equal(budget.stats.activeRagdolls, 1);
  corpse.dispose();
  assert.equal(budget.shouldDrive(corpse), false);
  budget.update(1 / 60);
  assert.equal(budget.stats.trackedRagdolls, 0);
});

test('four-second retirement is exact at 120 Hz despite floating point accumulation', () => {
  const budget = new FfaRagdollBudget();
  const corpse = ragdoll();
  budget.track(corpse);
  for (let step = 0; step < 479; step++) budget.update(1 / 120);
  assert.equal(corpse.active, true);
  budget.update(1 / 120);
  assert.equal(corpse.active, false);
  assert.equal(corpse.world.bodies.length, 0);
  assert.equal(corpse.world.constraints.length, 0);
});
