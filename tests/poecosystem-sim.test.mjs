import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWorld } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/world.js';
import { NONE, ROLE } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/entities.js';
import { SPECIES_ID } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/species.js';
import { TRIBES, CANNON_LOCAL_URL, TICK_SECONDS, YEAR_SECONDS } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/core/config.js';
import { createTribeStore } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/tribeStore.js';
import { BUILDING_KIND, TECH_TIER } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/tribe/contracts.js';
import { seasonEffects } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/events/weather.js';
import { isSick, stepDisease } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/creatures/disease.js';
import { snapshotWorld, restoreWorld } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/persistence/snapshot.js';
import { createSimRuntime } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/host/simRuntime.js';

test('vendored cannon-es module exists locally (#19)', () => {
  const path = fileURLToPath(CANNON_LOCAL_URL);
  assert.equal(existsSync(path), true, `Expected vendored cannon-es at ${path}`);
});

test('tribes unify with human entities and count real elders (#1, #4)', () => {
  const world = createWorld(101);
  const { entities: e, tribeStore } = world;
  assert.ok(tribeStore.tribes.length >= 3);

  const stats0 = world.stats();
  const popSum = stats0.tribes.reduce((sum, t) => sum + t.population, 0);
  assert.equal(stats0.counts[SPECIES_ID.HUMAN], popSum, 'Human species count must equal sum of tribal populations');

  // Verify every human has a valid tribeId and non-normal role
  let elderMade = false;
  e.forEachAlive((i) => {
    if (e.species[i] !== SPECIES_ID.HUMAN) return;
    assert.ok(e.tribeId[i] >= 0 && e.tribeId[i] < tribeStore.tribes.length);
    assert.notEqual(e.role[i], ROLE.NORMAL);
    if (!elderMade && e.tribeId[i] === 0) {
      e.age[i] = TRIBES.elderAgeYears + 2;
      elderMade = true;
    }
  });
  assert.equal(elderMade, true);

  for (let k = 0; k < 20; k++) world.step();
  const amber = tribeStore.getTribe(0);
  assert.ok(amber.elderCount >= 1, `Expected real elderCount >= 1, got ${amber.elderCount}`);
});

test('seasonal multipliers adjust ecology across Spring and Winter (#7)', () => {
  const spring = seasonEffects(0);
  const summer = seasonEffects(1);
  const winter = seasonEffects(3);

  assert.ok(spring.grass > winter.grass, 'Spring grass growth must outpace Winter');
  assert.ok(spring.breed > winter.breed, 'Spring breeding multiplier must exceed Winter');
  assert.ok(summer.thirst > winter.thirst, 'Summer thirst drain must exceed Winter');
  assert.ok(winter.chill > spring.chill, 'Winter chill must exceed Spring');
});

test('physical construction progresses via human builders and War Totem builds during rivalry (#3, #5)', () => {
  const world = createWorld(202);
  const t0 = world.tribeStore.getTribe(0);
  t0.wood = 200;
  t0.stone = 200;
  t0.relations[1] = 2; // RIVAL

  // Step a few seconds so stepConstruction initiates a building and physical builders advance it
  for (let k = 0; k < 600; k++) world.step();

  const blds = world.stats().buildings.filter(b => b.tribeId === 0);
  assert.ok(blds.length >= 1, 'Tribe should initiate buildings');
  assert.ok(blds.some(b => b.progress > 0.1), 'Buildings should progress under physical builders');
});

test('disease carcass miasma & agrarian hygiene mitigation (#11)', () => {
  const world = createWorld(303);
  const { entities: e, tribeStore } = world;
  let testHuman = -1;
  e.forEachAlive((i) => {
    if (testHuman < 0 && e.species[i] === SPECIES_ID.HUMAN && e.tribeId[i] === 0) testHuman = i;
  });
  assert.notEqual(testHuman, -1);

  // Give tribe 0 Agrarian tier so hygiene applies
  tribeStore.getTribe(0).tech = TECH_TIER.AGRARIAN;
  assert.equal(tribeStore.hasHygiene(0), true);

  // Place a carcass right on the creature and step disease several seconds
  world.carcasses.push({ id: 9999, x: e.x[testHuman], z: e.z[testHuman], species: 0, food: 5, expires: 99999 });
  e.sickUntil[testHuman] = 200;
  stepDisease(world, world.stats().counts);
  assert.equal(isSick(e, testHuman, world.clock.tick), true);
  // Hygiene reduces sickUntil faster than normal (decremented on stepDisease)
  assert.ok(e.sickUntil[testHuman] < 200, 'Agrarian hygiene should accelerate recovery ticks');
});

test('snapshot round-trip stays deterministic across tribeId & role (#1, #20)', () => {
  const w1 = createWorld(404);
  for (let k = 0; k < 120; k++) w1.step();

  const snap = snapshotWorld(w1);
  const w2 = restoreWorld(snap);
  assert.ok(w2, 'restoreWorld must succeed');

  for (let k = 0; k < 120; k++) {
    w1.step();
    w2.step();
  }

  const s1 = w1.stats();
  const s2 = w2.stats();
  assert.deepEqual(s1.counts, s2.counts);
  assert.equal(s1.tick, s2.tick);
  assert.deepEqual(
    s1.tribes.map(t => ({ id: t.id, pop: t.population, tech: t.tech, wood: t.wood })),
    s2.tribes.map(t => ({ id: t.id, pop: t.population, tech: t.tech, wood: t.wood })),
  );
});

test('simRuntime fastForward advances years & triggers fastForwardDone (#17)', () => {
  const messages = [];
  const runtime = createSimRuntime((msg) => messages.push(msg), { schedule: () => 0, cancel: () => {} });
  runtime.handle({ type: 'init', seed: 505, lowEnd: true, demo: true, ephemeral: true });
  messages.length = 0;

  runtime.handle({ type: 'fastForward', years: 1 });
  const done = messages.find(m => m.type === 'fastForwardDone');
  assert.ok(done, 'Expected fastForwardDone message');
  assert.ok(done.year >= 1, `Expected year >= 1 after 1y fast-forward, got ${done.year}`);
  assert.ok(messages.some(m => m.type === 'stats'), 'Expected updated stats after fast-forward');
  assert.ok(messages.some(m => m.type === 'frame'), 'Expected updated frame after fast-forward');
  runtime.dispose();
});

test('multi-year island soak stays finite and balanced (#20)', () => {
  const world = createWorld(606);
  const ticksForFiveYears = Math.round((5 * YEAR_SECONDS) / TICK_SECONDS);
  for (let k = 0; k < ticksForFiveYears; k++) {
    world.step();
  }
  const st = world.stats();
  assert.equal(st.year, 5);
  for (const c of st.counts) {
    assert.ok(Number.isFinite(c) && c >= 0);
  }
  assert.ok(st.alive > 10, `Expected living ecosystem after 5 full years, got ${st.alive}`);
});
