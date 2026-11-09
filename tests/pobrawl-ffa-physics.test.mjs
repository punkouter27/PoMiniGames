import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaPhysics.js', import.meta.url), 'utf8')
  .replace(/^export /gm, ''), context);
const { moveFighters, impactImpulse, sweptCircleTime } = vm.runInContext('({moveFighters, impactImpulse, sweptCircleTime})', context);

function fighter(id, x, z, vx = 0, vz = 0, mass = 1) {
  return { id, alive: true, rig: { config: { mass }, root: { position: { x, y: 0, z }, rotation: { y: 0 } } },
    velocity: { x: vx, y: 0, z: vz } };
}

test('CCD prevents fast fighters swapping sides and conserves unequal-mass momentum', () => {
  const a = fighter('light', -1, 0, 60, 0, 1);
  const b = fighter('heavy', 1, 0, -20, 0, 2);
  const momentum = a.velocity.x * 80 + b.velocity.x * 160;
  const contacts = [];
  const result = moveFighters([a, b], 0.02, (contact) => contacts.push(contact));
  assert.ok(a.rig.root.position.x < b.rig.root.position.x);
  assert.ok(b.rig.root.position.x - a.rig.root.position.x >= 0.76);
  assert.ok(Math.abs(a.velocity.x * 80 + b.velocity.x * 160 - momentum) < 1e-8);
  assert.ok(a.velocity.x < b.velocity.x);
  assert.equal(result.saturated, false);
  assert.equal(contacts.length, 1);
  assert.ok(contacts[0].energy > 0);
  assert.ok(Math.abs(sweptCircleTime(2, 0, -80, 0, 0.76, 0.02) - 0.0155) < 1e-8);
});

test('ring CCD catches high-speed exits, reports rope energy and never pushes a KO body', () => {
  const a = fighter('runner', 4, 0, 100, 10);
  const contacts = [];
  moveFighters([a], 0.05, (contact) => contacts.push(contact));
  assert.ok(Math.hypot(a.rig.root.position.x, a.rig.root.position.z) <= 4.85);
  assert.ok(contacts.some((c) => c.material === 'rope'));
  const corpse = fighter('corpse', 0, 0);
  corpse.alive = false;
  const runner = fighter('runner2', 0, -1, 0, 60);
  moveFighters([corpse, runner], 1 / 60);
  assert.equal(corpse.rig.root.position.x, 0);
  assert.equal(corpse.rig.root.position.z, 0);
  assert.equal(corpse.velocity.x, 0);
  assert.ok(runner.rig.root.position.z > -0.57);
  assert.ok(runner.rig.root.position.y >= 0.4, 'the moving fighter steps over the immovable prone body');
});

test('crowded contact correction separates sixteen bodies within the arena and stays bounded', () => {
  const fighters = Array.from({ length: 16 }, (_, i) => fighter(`p${i}`, (i % 4) * 0.4 - 0.6, Math.floor(i / 4) * 0.4 - 0.6));
  for (let frame = 0; frame < 30; frame++) {
    const result = moveFighters(fighters, 1 / 60);
    assert.ok(result.events <= 128);
    assert.equal(result.saturated, false);
  }
  for (let i = 0; i < fighters.length; i++) {
    const a = fighters[i].rig.root.position;
    assert.ok(Math.hypot(a.x, a.z) <= 4.85);
    for (let j = i + 1; j < fighters.length; j++) {
      const b = fighters[j].rig.root.position;
      assert.ok(Math.hypot(b.x - a.x, b.z - a.z) >= 0.759);
    }
  }
});

test('strike knockback respects mass ratios and rejects invalid physics inputs', () => {
  const a = fighter('attacker', 0, -1);
  const light = fighter('light', 0, 0);
  const heavy = fighter('heavy', 0, 0, 0, 0, 2);
  const first = impactImpulse(a, light, true, 24);
  impactImpulse(fighter('other', 0, -1), heavy, true, 24);
  assert.ok(Math.abs(light.velocity.z - heavy.velocity.z * 2) < 1e-8);
  assert.ok(first.energy > 0);
  assert.throws(() => moveFighters([a], 1), /50 ms/);
  assert.throws(() => moveFighters([fighter('bad', 0, 0, 0, 0, -1)], 1 / 60), /mass/);
  assert.throws(() => moveFighters([fighter('nan', 0, 0, NaN)], 1 / 60), /Non-finite/);
});
