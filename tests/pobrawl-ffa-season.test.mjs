import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
const agentSource = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaAgents.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
vm.runInContext(agentSource, context);
const source = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaSeason.js', import.meta.url), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '\.\/ffaAgents\.js';\r?\n/, '')
  .replace(/^export /gm, '');
vm.runInContext(source, context);
const Season = vm.runInContext('FfaSeason', context);
const createEvaluation = vm.runInContext('createFfaAgentEvaluation', context);
const cpuIds = ['trump', 'biden', 'obama', 'bush', 'clinton', 'bushsr', 'reagan', 'carter',
  'ford', 'nixon', 'lbj', 'jfk', 'eisenhower', 'truman', 'fdr', 'hoover'];
const roster = cpuIds.map((id) => ({ id, name: id }));
const results = roster.map(({ id }, index) => ({ id, place: index + 1, damage: 25, knockouts: 1, rearHitsTaken: 2 }));

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}

test('twenty complete matches crown a season champion and preserve lifetime statistics after reload', () => {
  const store = storage();
  const errors = [];
  const season = new Season(roster, store, (error) => errors.push(error));
  for (let round = 0; round < 20; round++) season.record(results);
  const state = season.snapshot();
  assert.equal(state.season, 2);
  assert.equal(state.completed, 0);
  assert.equal(state.history[0].champion, 'trump');
  assert.equal(state.history[0].points, 320);
  const topRecord = state.records.find((record) => record.id === 'trump');
  assert.equal(topRecord.wins, 20);
  assert.equal(topRecord.damage, 500);
  assert.equal(topRecord.rearHitsTaken, 40);
  assert.ok(topRecord.rating > 1000);
  assert.ok(Math.abs(state.records.reduce((sum, r) => sum + r.rating, 0) - 16000) < 1e-6);
  assert.ok(state.records.every((r) => r.seasonPoints === 0));
  season.setProfile('cautious');
  season.state.factsEnabled = true;
  season.state.recordHighlights = false;
  season.state.benchmark = {
    completed: 48, total: 48, physicsVersion: 3,
    rows: ['balanced', 'aggressive', 'cautious'].map((profile) =>
      ({ profile, rounds: 16, wins: 1, knockouts: 4, averagePlace: 8, averageDamage: 100, placementGain: 0 })),
  };
  season.save();
  const loaded = new Season(roster, store, (error) => errors.push(error));
  assert.equal(loaded.state.totalRounds, 20);
  assert.equal(loaded.state.profile, 'cautious');
  assert.equal(loaded.state.factsEnabled, true);
  assert.equal(loaded.state.recordHighlights, false);
  assert.equal(loaded.state.benchmark.rows.length, 3);
  assert.equal(errors.length, 0);
  loaded.reset();
  assert.equal(loaded.state.totalRounds, 0);
  assert.equal(loaded.state.records[0].rating, 1000);
});

test('invalid results cannot change standings and corrupted saves are not overwritten', () => {
  const store = storage();
  const errors = [];
  const season = new Season(roster, store, (error) => errors.push(error));
  assert.throws(() => season.record(results.map((r) => ({ ...r, place: 1 }))), /unique/);
  assert.throws(() => season.record(results.map((r) => ({ ...r, damage: -1 }))), /unique/);
  assert.equal(season.state.totalRounds, 0);
  store.setItem('pobrawl.ffa.seasons.v1', '{broken');
  const damaged = new Season(roster, store, (error) => errors.push(error));
  damaged.record(results);
  assert.equal(store.getItem('pobrawl.ffa.seasons.v1'), '{broken');
  assert.equal(damaged.writable, false);
  assert.equal(errors.length, 1);
  damaged.reset();
  assert.equal(new Season(roster, store, () => {}).state.totalRounds, 0);
});

test('storage failures are explicitly reported and seed streams repeat', () => {
  const errors = [];
  const store = { getItem() { return null; }, setItem() { throw new Error('quota exceeded'); } };
  const season = new Season(roster, store, (message) => errors.push(message));
  season.record(results);
  assert.match(errors[0], /quota exceeded/);
  const random = vm.runInContext('seededRandom', context);
  const first = random(12), second = random(12), different = random(13);
  assert.deepEqual(Array.from({ length: 20 }, first), Array.from({ length: 20 }, second));
  assert.notEqual(random(12)(), different());
});

test('agent choices survive reload, rejected candidates stay local, and promotions persist', () => {
  const store = storage();
  const season = new Season(roster, store, () => {});
  const candidate = createEvaluation('trump', 'pressure', season.getAgentPreset('trump'));
  const seeds = Array.from(candidate.seeds);
  const pairs = seeds.map((seed) => ({
    seed,
    incumbent: { place: 8, damage: 100, knockouts: 2 },
    candidate: { place: 8, damage: 130, knockouts: 3 },
  }));
  const rejected = season.evaluateAgentCandidate(candidate, pairs);
  assert.equal(rejected.promoted, false);
  assert.equal(season.getAgentPreset('trump'), 'native');
  assert.deepEqual(new Season(roster, store, () => {}).snapshot().agentLab.report, rejected);
  assert.throws(() => season.evaluateAgentCandidate(candidate, pairs.slice(1)), /incomplete/);

  const improved = pairs.map((pair) => ({
    ...pair, candidate: { ...pair.candidate, place: 7 },
  }));
  const promoted = season.evaluateAgentCandidate(candidate, improved);
  assert.equal(promoted.promoted, true);
  assert.equal(season.getAgentPreset('trump'), 'pressure');
  const reloaded = new Season(roster, store, () => {});
  assert.equal(reloaded.getAgentPreset('trump'), 'pressure');
  assert.equal(reloaded.getAgentPreset('biden'), 'native');
  assert.deepEqual(reloaded.snapshot().agentLab.report, promoted);
  assert.throws(() => reloaded.getAgentPreset('bob'), /Unknown CPU/);
});

test('invalid saved evaluation reports block writes and old benchmark revisions expire without losing seasons', () => {
  const store = storage();
  const season = new Season(roster, store, () => {});
  season.record(results);
  season.state.benchmark = {
    completed: 48, total: 48, physicsVersion: 2,
    rows: ['balanced', 'aggressive', 'cautious'].map((profile) =>
      ({ profile, rounds: 16, wins: 1, knockouts: 4, averagePlace: 8, averageDamage: 100, placementGain: 0 })),
  };
  season.save();
  const loaded = new Season(roster, store, () => {});
  assert.equal(loaded.state.benchmark, null);
  assert.equal(loaded.state.totalRounds, 1);
  const evaluation = loaded.createAgentEvaluation('bushsr', 'counter');
  const pairs = Array.from(evaluation.seeds, (seed) => ({
    seed, candidate: { place: 6, damage: 90, knockouts: 1 }, incumbent: { place: 8, damage: 100, knockouts: 1 },
  }));
  loaded.evaluateAgentCandidate(evaluation, pairs);
  const saved = store.getItem('pobrawl.ffa.seasons.v1');
  for (const corrupt of [
    (report) => { report.promoted = false; },
    (report) => { report.characterId = 'bob'; },
    (report) => { report.rounds = 7; },
    (report) => { report.averageDamage.candidate = -1; },
    (report) => { report.placementGain = 99; },
    (report) => { report.wins.incumbent = 9; },
  ]) {
    const parsed = JSON.parse(saved);
    corrupt(parsed.agentLab.report);
    const damagedValue = JSON.stringify(parsed);
    store.setItem('pobrawl.ffa.seasons.v1', damagedValue);
    const errors = [];
    const damaged = new Season(roster, store, (message) => errors.push(message));
    damaged.record(results);
    assert.equal(damaged.writable, false);
    assert.equal(errors.length, 1);
    assert.equal(store.getItem('pobrawl.ffa.seasons.v1'), damagedValue);
  }
});

test('invalid saved agent presets are treated as corruption and never overwritten', () => {
  const store = storage();
  store.setItem('pobrawl.ffa.seasons.v1', JSON.stringify({
    version: 1, totalRounds: 0, season: 1, completed: 0, profile: 'balanced',
    history: [], records: roster.map(({ id, name }) => ({
      id, name, rating: 1000, rounds: 0, wins: 0, places: 0, damage: 0,
      knockouts: 0, rearHitsTaken: 0, seasonPoints: 0,
    })),
    agentLab: { version: 1, incumbents: { trump: 'not-a-preset' } },
  }));
  const errors = [];
  const damaged = new Season(roster, store, (message) => errors.push(message));
  damaged.record(results);
  assert.equal(damaged.writable, false);
  assert.match(errors[0], /damaged/);
  assert.equal(JSON.parse(store.getItem('pobrawl.ffa.seasons.v1')).agentLab.incumbents.trump, 'not-a-preset');
});

test('season storage keys isolate human play from CPU seasons', () => {
  const store = storage();
  const errors = [];
  const cpu = new Season(roster, store, (message) => errors.push(message));
  cpu.record(results);
  const humanRoster = [...roster, { id: 'bob', name: 'Bob' }];
  const human = new Season(humanRoster, store, (message) => errors.push(message), 'pobrawl.ffa.player.seasons.v1');
  human.record([...results, { id: 'bob', place: 17, damage: 0, knockouts: 0, rearHitsTaken: 0 }]);
  assert.ok(store.getItem('pobrawl.ffa.seasons.v1'));
  assert.ok(store.getItem('pobrawl.ffa.player.seasons.v1'));
  assert.equal(new Season(roster, store, () => {}).state.totalRounds, 1);
  assert.equal(new Season(humanRoster, store, () => {}, 'pobrawl.ffa.player.seasons.v1').state.totalRounds, 1);
  assert.equal(errors.length, 0);
});
