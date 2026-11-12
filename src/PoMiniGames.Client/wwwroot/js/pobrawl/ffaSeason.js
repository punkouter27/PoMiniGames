import { createFfaAgentEvaluation, createFfaAgentState, evaluateFfaAgentPairs, isValidFfaAgentState, FFA_AGENT_CHARACTER_IDS } from './ffaAgents.js';

const STORE_KEY = 'pominigames:pobrawl-ffa-seasons-v1';
export const SEASON_ROUNDS = 20;
export const FFA_PROFILES = {
  balanced: { pace: 1, guard: 1.4, weak: 0.2 },
  aggressive: { pace: 0.8, guard: 1.8, weak: 0.5 },
  cautious: { pace: 1.15, guard: 0.9, weak: 0.1 },
};

export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function fresh(roster) {
  return {
    version: 1, totalRounds: 0, season: 1, completed: 0, profile: 'balanced', factsEnabled: false, recordHighlights: true, history: [],
    agentLab: createFfaAgentState(),
    records: roster.map(({ id, name }) => ({
      id, name, rating: 1000, rounds: 0, wins: 0, places: 0, damage: 0,
      knockouts: 0, rearHitsTaken: 0, seasonPoints: 0,
    })),
  };
}

export class FfaSeason {
  constructor(roster, storage, onError, storageKey = STORE_KEY) {
    this.roster = roster;
    this.storage = storage;
    this.onError = onError;
    this.storageKey = storageKey;
    this.state = fresh(roster);
    this.writable = true;
    try {
      const saved = storage.getItem(this.storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!this._valid(parsed)) throw new Error('Saved FFA seasons are incompatible or damaged. Reset local seasons to recover.');
        if (parsed.benchmark && parsed.benchmark.physicsVersion !== 3) parsed.benchmark = null;
        if (!parsed.agentLab) parsed.agentLab = createFfaAgentState();
        if (parsed.agentLab.report === undefined) parsed.agentLab.report = null;
        this.state = parsed;
      }
    } catch (error) {
      this.writable = false;
      onError(`Local seasons could not load: ${error.message}`);
    }
  }

  _valid(state) {
    const integer = (n) => Number.isSafeInteger(n) && n >= 0;
    return state?.version === 1 && integer(state.totalRounds) && integer(state.season) && state.season > 0
      && integer(state.completed) && state.completed < SEASON_ROUNDS
      && Object.hasOwn(FFA_PROFILES, state.profile) && Array.isArray(state.history) && state.history.length <= 8
      && (state.factsEnabled === undefined || typeof state.factsEnabled === 'boolean')
      && (state.recordHighlights === undefined || typeof state.recordHighlights === 'boolean')
      && (state.agentLab === undefined || isValidFfaAgentState(state.agentLab, this.roster.map((entry) => entry.id)))
      && state.history.every((h) => integer(h.season) && this.roster.some((r) => r.id === h.champion))
      && (state.benchmark == null || (state.benchmark.completed === 48 && state.benchmark.total === 48
        && Array.isArray(state.benchmark.rows) && state.benchmark.rows.length === 3
        && state.benchmark.rows.every((row) => Object.hasOwn(FFA_PROFILES, row.profile) && row.rounds === 16
          && integer(row.wins) && integer(row.knockouts)
          && ['averagePlace', 'averageDamage', 'placementGain'].every((key) => Number.isFinite(row[key])))))
      && Array.isArray(state.records) && state.records.length === this.roster.length
      && this.roster.every((entry) => state.records.filter((r) => r.id === entry.id).length === 1)
      && state.records.every((r) => Number.isFinite(r.rating) && typeof r.name === 'string'
        && ['rounds', 'wins', 'places', 'damage', 'knockouts', 'rearHitsTaken', 'seasonPoints'].every((key) => integer(r[key])));
  }

  save() {
    if (!this.writable) return;
    try { this.storage.setItem(this.storageKey, JSON.stringify(this.state)); }
    catch (error) { this.onError(`Local seasons could not save: ${error.message}`); }
  }

  setProfile(profile) {
    if (!Object.hasOwn(FFA_PROFILES, profile)) throw new Error(`Unknown FFA strategy: ${profile}`);
    this.state.profile = profile;
    this.save();
  }

  getAgentPreset(characterId) {
    if (!this.roster.some((entry) => entry.id === characterId) || !FFA_AGENT_CHARACTER_IDS.includes(characterId)) {
      throw new Error(`Unknown CPU FFA character: ${characterId}`);
    }
    return this.state.agentLab?.incumbents?.[characterId] || 'native';
  }

  createAgentEvaluation(characterId, candidatePreset) {
    return createFfaAgentEvaluation(characterId, candidatePreset, this.getAgentPreset(characterId));
  }

  evaluateAgentCandidate(evaluation, pairs) {
    if (!this.roster.some((entry) => entry.id === evaluation?.characterId)
        || evaluation.incumbentPreset !== this.getAgentPreset(evaluation.characterId)) {
      throw new Error('The FFA agent incumbent changed; restart the paired evaluation.');
    }
    const report = evaluateFfaAgentPairs(evaluation, pairs);
    if (report.promoted) this.state.agentLab.incumbents[report.characterId] = report.candidatePreset;
    this.state.agentLab.report = report;
    this.save();
    return report;
  }

  record(results) {
    if (results.length !== this.roster.length || new Set(results.map((r) => r.id)).size !== this.roster.length
      || results.some((r) => !this.state.records.some((entry) => entry.id === r.id))
      || new Set(results.map((r) => r.place)).size !== results.length
      || results.some((r) => !Number.isInteger(r.place) || r.place < 1 || r.place > results.length
        || ['damage', 'knockouts', 'rearHitsTaken'].some((key) => !Number.isSafeInteger(r[key]) || r[key] < 0))) {
      throw new Error('FFA results must contain unique, valid placements and statistics for the full roster.');
    }
    const ratings = new Map(this.state.records.map((r) => [r.id, r.rating]));
    for (const result of results) {
      const record = this.state.records.find((r) => r.id === result.id);
      let change = 0;
      for (const other of results) {
        if (other.id === result.id) continue;
        const expected = 1 / (1 + 10 ** ((ratings.get(other.id) - ratings.get(result.id)) / 400));
        change += ((result.place < other.place ? 1 : 0) - expected) * 24 / (results.length - 1);
      }
      record.rating += change;
      record.rounds++;
      record.wins += result.place === 1 ? 1 : 0;
      record.places += result.place;
      record.damage += result.damage;
      record.knockouts += result.knockouts;
      record.rearHitsTaken += result.rearHitsTaken;
      record.seasonPoints += results.length + 1 - result.place;
    }
    this.state.completed++;
    this.state.totalRounds++;
    if (this.state.completed === SEASON_ROUNDS) {
      const winner = [...this.state.records].sort((a, b) => b.seasonPoints - a.seasonPoints || b.rating - a.rating)[0];
      this.state.history.unshift({ season: this.state.season, champion: winner.id, points: winner.seasonPoints });
      this.state.history = this.state.history.slice(0, 8);
      this.state.season++;
      this.state.completed = 0;
      this.state.records.forEach((r) => { r.seasonPoints = 0; });
    }
    this.save();
  }

  reset() {
    this.state = fresh(this.roster);
    this.writable = true;
    this.save();
  }

  snapshot() {
    return { ...this.state, seasonRounds: SEASON_ROUNDS, writable: this.writable,
      records: [...this.state.records].sort((a, b) => b.seasonPoints - a.seasonPoints || b.rating - a.rating) };
  }
}
