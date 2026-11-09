import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/ffaAgents.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const getStrategy = vm.runInContext('getFfaAgentStrategy', context);
const getPresets = vm.runInContext('getFfaAgentPresets', context);
const createEvaluation = vm.runInContext('createFfaAgentEvaluation', context);
const evaluatePairs = vm.runInContext('evaluateFfaAgentPairs', context);
const evaluationSeeds = Array.from(vm.runInContext('FFA_AGENT_EVALUATION_SEEDS', context));
const characterIds = [
  'trump', 'biden', 'obama', 'bush', 'clinton', 'bushsr', 'reagan', 'carter',
  'ford', 'nixon', 'lbj', 'jfk', 'eisenhower', 'truman', 'fdr', 'hoover',
];

test('presidents have stable, distinct default tactics and offer fixed candidate presets', () => {
  const signatures = characterIds.map((id) => JSON.stringify(getStrategy(id)));
  assert.equal(new Set(signatures).size, characterIds.length);
  for (const id of characterIds) {
    assert.deepEqual(Object.keys(getStrategy(id)), ['pace', 'guard', 'weak', 'aggression', 'move', 'retarget']);
    assert.deepEqual(getStrategy(id), getStrategy(id));
    assert.deepEqual(Array.from(getPresets(id), (preset) => preset.id), ['native', 'pressure', 'counter', 'opportunist']);
    for (const preset of getPresets(id)) {
      assert.ok(Object.values(preset.strategy).every(Number.isFinite));
    }
  }
  assert.throws(() => getStrategy('unknown'), /Unknown FFA character/);
  assert.throws(() => getStrategy('bob'), /Unknown FFA character/);
});

test('paired evaluations use the same fixed seeds and require a strict placement gain', () => {
  const evaluation = createEvaluation('obama', 'pressure', 'native');
  assert.deepEqual(Array.from(evaluation.seeds), evaluationSeeds);
  assert.throws(() => createEvaluation('obama', 'native', 'native'), /differ/);
  const ties = evaluationSeeds.map((seed) => ({
    seed,
    candidate: { place: 4, damage: 140, knockouts: 3 },
    incumbent: { place: 4, damage: 90, knockouts: 1 },
  }));
  const tiedReport = evaluatePairs(evaluation, ties);
  assert.equal(tiedReport.placementGain, 0);
  assert.equal(tiedReport.promoted, false);

  const improved = ties.map((pair) => ({ ...pair, candidate: { ...pair.candidate, place: 3 } }));
  const report = evaluatePairs(evaluation, improved);
  assert.equal(report.promoted, true);
  assert.equal(report.rounds, evaluationSeeds.length);
  assert.equal(report.averagePlace.candidate, 3);
  assert.equal(report.averagePlace.incumbent, 4);
});

test('candidate results cannot omit, reorder, mismatch, or corrupt paired fixed-seed results', () => {
  const evaluation = createEvaluation('reagan', 'counter');
  const pairs = evaluationSeeds.map((seed) => ({
    seed,
    candidate: { place: 8, damage: 10, knockouts: 0 },
    incumbent: { place: 7, damage: 10, knockouts: 0 },
  }));
  assert.throws(() => evaluatePairs(evaluation, pairs.slice(1)), /incomplete/);
  assert.throws(() => evaluatePairs(evaluation, [{ ...pairs[0], seed: 999 }, ...pairs.slice(1)]), /fixed seed/);
  assert.throws(() => evaluatePairs(evaluation, [pairs[1], pairs[0], ...pairs.slice(2)]), /fixed seed/);
  assert.throws(() => evaluatePairs(evaluation, [
    { ...pairs[0], candidate: { ...pairs[0].candidate, place: 17 } }, ...pairs.slice(1),
  ]), /fixed seed/);
});
