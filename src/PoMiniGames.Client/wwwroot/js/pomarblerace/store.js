// store.js — the marble race's local save: one versioned localStorage record instead of five
// loose keys. Every access is guarded: storage can be blocked (private mode), and a stat card is
// never worth a crash.
//
//   { v: 2, best, trackStats: { [mapId]: { races, top10, wins, bestPlace, bestTime } },
//     marble: { skin, weight }, sectors: { [mapId]: [best sector seconds] }, ghostOn,
//     prefs: { announcer, perfHud, effects: 'full'|'lite', tutorialSeen } }
//
// `prefs` are the Settings drawer's switches (PoMarbleRacePage OptionsContent); each engine
// system reads its own with readPref() and the page writes them through setPref().
//
// Ghost runs stay in their own per-map keys (ghostTrack.js, 'pomarblerace.ghost.v1.<map>'): they
// are the only large values, and keeping them apart means a stats write never rewrites them.

const KEY = 'pomarblerace.v2';
// The v1 keys, read once and folded in the first time v2 is missing.
const LEGACY = {
  best: 'pomarblerace_best',
  trackStats: 'pomarblerace_trackstats',
  marble: 'pomarblerace_marble',
  sectors: 'pomarblerace_sectors',
  ghost: 'pomarblerace_ghost',
};

const PREFS = () => ({ announcer: false, perfHud: false, effects: 'full', tutorialSeen: false });
const fresh = () => ({ v: 2, best: 0, trackStats: {}, marble: { skin: 'swirl', weight: 'balanced' }, sectors: {}, ghostOn: true, prefs: PREFS() });

function parse(raw, fallback) {
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

function migrate() {
  const s = fresh();
  try {
    s.best = parseInt(localStorage.getItem(LEGACY.best) || '0', 10) || 0;
    s.trackStats = parse(localStorage.getItem(LEGACY.trackStats), {}) || {};
    s.marble = { ...s.marble, ...(parse(localStorage.getItem(LEGACY.marble), {}) || {}) };
    s.sectors = parse(localStorage.getItem(LEGACY.sectors), {}) || {};
    s.ghostOn = localStorage.getItem(LEGACY.ghost) !== '0';
    for (const k of Object.values(LEGACY)) localStorage.removeItem(k);
  } catch { /* blocked storage: start fresh */ }
  return s;
}

let cache = null;

/** The whole save. Cached for the page's life; every write goes through {@link update}. */
export function load() {
  if (cache) return cache;
  let s = null;
  try { s = parse(localStorage.getItem(KEY), null); } catch { }
  cache = s && s.v === 2 ? { ...fresh(), ...s, prefs: { ...PREFS(), ...(s.prefs || {}) } } : migrate();
  if (!s) save();
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { }
}

/** Mutate the save in place and persist it. */
export function update(fn) {
  fn(load());
  save();
}

export const readBest = () => load().best;
export const readTrackStats = () => load().trackStats;
export const readMarbleChoice = () => ({ ...load().marble });
export const readSectorBests = (mapId) => load().sectors[mapId] || [];
export const readPref = (key) => load().prefs[key];
export function setPref(key, value) { update((s) => { s.prefs[key] = value; }); }

// Test seam: forget the cache so a test can swap localStorage underneath.
export function _reset() { cache = null; }
