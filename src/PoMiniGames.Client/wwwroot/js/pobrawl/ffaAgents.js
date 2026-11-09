export const FFA_AGENT_REVISION = 1;
export const FFA_AGENT_PRESETS = Object.freeze(['native', 'pressure', 'counter', 'opportunist']);
export const FFA_AGENT_EVALUATION_SEEDS = Object.freeze([101, 211, 307, 401, 503, 601, 701, 809]);

const STYLES = Object.freeze({
  trump: { pace: 0.92, guard: 1.12, weak: 0.48, aggression: 1.12, move: 1.02, retarget: 0.92 },
  biden: { pace: 1.08, guard: 0.88, weak: 0.18, aggression: 0.86, move: 1.12, retarget: 1.08 },
  obama: { pace: 0.96, guard: 0.96, weak: 0.38, aggression: 1.02, move: 1.10, retarget: 0.94 },
  bush: { pace: 1.02, guard: 1.08, weak: 0.22, aggression: 1.06, move: 0.96, retarget: 1.04 },
  clinton: { pace: 0.98, guard: 0.94, weak: 0.52, aggression: 0.96, move: 1.08, retarget: 0.90 },
  bushsr: { pace: 1.12, guard: 0.82, weak: 0.28, aggression: 0.90, move: 1.14, retarget: 1.12 },
  reagan: { pace: 1.04, guard: 0.90, weak: 0.32, aggression: 0.98, move: 1.04, retarget: 1.02 },
  carter: { pace: 1.16, guard: 0.78, weak: 0.16, aggression: 0.82, move: 0.98, retarget: 1.16 },
  ford: { pace: 0.94, guard: 1.16, weak: 0.24, aggression: 1.08, move: 0.92, retarget: 1.06 },
  nixon: { pace: 1.06, guard: 1.04, weak: 0.66, aggression: 0.94, move: 0.94, retarget: 0.86 },
  lbj: { pace: 0.88, guard: 1.18, weak: 0.36, aggression: 1.18, move: 0.96, retarget: 0.96 },
  jfk: { pace: 0.90, guard: 0.86, weak: 0.44, aggression: 1.08, move: 1.18, retarget: 0.88 },
  eisenhower: { pace: 1.10, guard: 1.14, weak: 0.30, aggression: 0.92, move: 0.90, retarget: 1.10 },
  truman: { pace: 0.92, guard: 1.02, weak: 0.58, aggression: 1.14, move: 0.98, retarget: 0.92 },
  fdr: { pace: 1.14, guard: 1.00, weak: 0.12, aggression: 0.84, move: 0.88, retarget: 1.14 },
  hoover: { pace: 1.18, guard: 0.84, weak: 0.42, aggression: 0.88, move: 0.92, retarget: 1.06 },
});
export const FFA_AGENT_CHARACTER_IDS = Object.freeze(Object.keys(STYLES));

const PRESET_ADJUSTMENTS = Object.freeze({
  native: Object.freeze({}),
  pressure: Object.freeze({ pace: 0.88, aggression: 1.16, move: 1.08, guard: 1.12, weak: 1.10 }),
  counter: Object.freeze({ pace: 1.10, aggression: 0.88, move: 0.94, guard: 0.78, weak: 0.86 }),
  opportunist: Object.freeze({ pace: 0.96, aggression: 0.96, move: 0.98, guard: 1.04, weak: 1.35, retarget: 0.84 }),
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function getFfaAgentStrategy(characterId, preset = 'native') {
  const base = STYLES[characterId];
  const adjustment = PRESET_ADJUSTMENTS[preset];
  if (!base) throw new Error(`Unknown FFA character: ${characterId}`);
  if (!adjustment) throw new Error(`Unknown FFA agent preset: ${preset}`);
  return Object.freeze(Object.fromEntries(Object.keys(base).map((key) => [
    key,
    clamp(base[key] * (adjustment[key] ?? 1), key === 'weak' ? 0 : 0.65, key === 'weak' ? 1 : 1.5),
  ])));
}

export function getFfaAgentPresets(characterId) {
  getFfaAgentStrategy(characterId);
  return FFA_AGENT_PRESETS.map((id) => ({ id, strategy: getFfaAgentStrategy(characterId, id) }));
}

export function createFfaAgentEvaluation(characterId, candidatePreset, incumbentPreset = 'native') {
  getFfaAgentStrategy(characterId, incumbentPreset);
  getFfaAgentStrategy(characterId, candidatePreset);
  if (candidatePreset === incumbentPreset) throw new Error('The candidate must differ from the incumbent.');
  return Object.freeze({
    revision: FFA_AGENT_REVISION,
    characterId,
    candidatePreset,
    incumbentPreset,
    seeds: FFA_AGENT_EVALUATION_SEEDS,
  });
}

export function evaluateFfaAgentPairs(evaluation, pairs) {
  if (evaluation?.revision !== FFA_AGENT_REVISION
      || !STYLES[evaluation.characterId]
      || !PRESET_ADJUSTMENTS[evaluation.candidatePreset]
      || !PRESET_ADJUSTMENTS[evaluation.incumbentPreset]
      || evaluation.candidatePreset === evaluation.incumbentPreset
      || !Array.isArray(pairs)
      || pairs.length !== FFA_AGENT_EVALUATION_SEEDS.length) {
    throw new Error('FFA agent evaluation is incompatible or incomplete.');
  }
  const validResult = (result) => result && Number.isInteger(result.place) && result.place >= 1 && result.place <= 16
    && ['damage', 'knockouts'].every((key) => Number.isSafeInteger(result[key]) && result[key] >= 0)
    && result.knockouts <= 15;
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair?.seed !== FFA_AGENT_EVALUATION_SEEDS[index]
        || !validResult(pair.candidate) || !validResult(pair.incumbent)) {
      throw new Error('FFA agent results must contain valid paired results for every fixed seed.');
    }
  }
  const total = (side, key) => pairs.reduce((sum, pair) => sum + pair[side][key], 0);
  const count = (side, key, predicate) => pairs.filter((pair) => predicate(pair[side][key])).length;
  const candidatePlace = total('candidate', 'place') / pairs.length;
  const incumbentPlace = total('incumbent', 'place') / pairs.length;
  const candidateWins = count('candidate', 'place', (place) => place === 1);
  const incumbentWins = count('incumbent', 'place', (place) => place === 1);
  const placementGain = incumbentPlace - candidatePlace;
  return {
    revision: FFA_AGENT_REVISION,
    characterId: evaluation.characterId,
    candidatePreset: evaluation.candidatePreset,
    incumbentPreset: evaluation.incumbentPreset,
    rounds: pairs.length,
    averagePlace: { candidate: candidatePlace, incumbent: incumbentPlace },
    averageDamage: {
      candidate: total('candidate', 'damage') / pairs.length,
      incumbent: total('incumbent', 'damage') / pairs.length,
    },
    averageKnockouts: {
      candidate: total('candidate', 'knockouts') / pairs.length,
      incumbent: total('incumbent', 'knockouts') / pairs.length,
    },
    wins: { candidate: candidateWins, incumbent: incumbentWins },
    placementGain,
    promoted: placementGain > 0,
  };
}

export function isValidFfaAgentState(agentState, characterIds) {
  if (!agentState || agentState.version !== FFA_AGENT_REVISION || !agentState.incumbents
      || typeof agentState.incumbents !== 'object' || Array.isArray(agentState.incumbents)) return false;
  const validIds = new Set(characterIds.filter((id) => Object.hasOwn(STYLES, id)));
  return Object.entries(agentState.incumbents).every(([characterId, preset]) =>
    validIds.has(characterId) && Object.hasOwn(PRESET_ADJUSTMENTS, preset))
    && (agentState.report == null || (isValidFfaAgentReport(agentState.report, [...validIds])
      && (agentState.incumbents[agentState.report.characterId] ?? 'native')
        === (agentState.report.promoted ? agentState.report.candidatePreset : agentState.report.incumbentPreset)));
}

export function isValidFfaAgentReport(report, characterIds) {
  const pair = (value, minimum, maximum, integer = false) => value
    && ['candidate', 'incumbent'].every((side) => Number.isFinite(value[side])
      && value[side] >= minimum && value[side] <= maximum
      && (!integer || Number.isSafeInteger(value[side])));
  return report?.revision === FFA_AGENT_REVISION && characterIds.includes(report.characterId)
    && Object.hasOwn(PRESET_ADJUSTMENTS, report.candidatePreset)
    && Object.hasOwn(PRESET_ADJUSTMENTS, report.incumbentPreset)
    && report.candidatePreset !== report.incumbentPreset
    && report.rounds === FFA_AGENT_EVALUATION_SEEDS.length
    && pair(report.averagePlace, 1, 16)
    && pair(report.averageDamage, 0, Number.MAX_SAFE_INTEGER)
    && pair(report.averageKnockouts, 0, 15)
    && pair(report.wins, 0, report.rounds, true)
    && Number.isFinite(report.placementGain)
    && report.placementGain === report.averagePlace.incumbent - report.averagePlace.candidate
    && report.promoted === (report.placementGain > 0);
}

export function createFfaAgentState() {
  return { version: FFA_AGENT_REVISION, incumbents: {}, report: null };
}
