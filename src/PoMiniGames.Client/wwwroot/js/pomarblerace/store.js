// store.js — the marble race's local save: one versioned localStorage record instead of five
// loose keys. Every access is guarded: storage can be blocked (private mode), and a stat card is
// never worth a crash.
//
//   { v: 2, best, trackStats: { [mapId]: { races, top10, wins, bestPlace, bestTime } },
//     marble: { skin, weight }, sectors: { [mapId]: [best sector seconds] }, ghostOn,
//     prefs: { announcer, muted, perfHud, effects: 'full'|'lite', tutorialSeen }, courseEpoch,
//     gp: { best, bestRank }, dailyDay }
//
// `prefs` are the Settings drawer's switches (PoMarbleRacePage OptionsContent); each engine
// system reads its own with readPref() and the page writes them through setPref().
//
// Ghost runs stay in their own per-map keys (ghostTrack.js, 'pomarblerace.ghost.v1.<map>'): they
// are the only large values, and keeping them apart means a stats write never rewrites them.

const KEY = 'pomarblerace.v2';
const COURSE_EPOCH_NOW = 2;   // a new save has nothing to retire (see retire below)
// The v1 keys, read once and folded in the first time v2 is missing.
const LEGACY = {
  best: 'pomarblerace_best',
  trackStats: 'pomarblerace_trackstats',
  marble: 'pomarblerace_marble',
  sectors: 'pomarblerace_sectors',
  ghost: 'pomarblerace_ghost',
};

const PREFS = () => ({ announcer: false, muted: false, music: true, perfHud: false, effects: 'full', tutorialSeen: false });
const fresh = () => ({ v: 2, courseEpoch: COURSE_EPOCH_NOW, best: 0, trackStats: {}, marble: { skin: 'swirl', weight: 'balanced' }, sectors: {}, ghostOn: true, prefs: PREFS(), gp: { best: 0, bestRank: 0 }, dailyDay: '' });

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

// Course changes that invalidate per-map history. 2026-11-05: Neon Chute (slot 1) and Canyon Run
// (slot 4) were folded into Neon Canyon on slot 1 — a longer course, so slot 1's best time and
// sector splits no longer compare, and slot 4 is gone. Race/win counts on slot 1 are kept.
// 2026-11-13 (epoch 2): Spiral Works (slot 2) races its whole course; the finish used to sit in
// front of the first loop. Its best time, sector splits and ghost were set on the short course
// (a ghost that fast could never be beaten on the long one), so they go.
const COURSE_EPOCH = COURSE_EPOCH_NOW;
function retire(s) {
  const was = s.courseEpoch || 0;
  if (was >= COURSE_EPOCH) return false;
  if (was < 1) {
    delete s.trackStats[4];
    delete s.sectors[4];
    delete s.sectors[1];
    if (s.trackStats[1]) s.trackStats[1].bestTime = 0;
  }
  if (was < 2) {
    delete s.sectors[2];
    if (s.trackStats[2]) s.trackStats[2].bestTime = 0;
    try { localStorage.removeItem('pomarblerace.ghost.v1.2'); } catch { }
  }
  s.courseEpoch = COURSE_EPOCH;
  return true;
}

let cache = null;

/** The whole save. Cached for the page's life; every write goes through {@link update}. */
export function load() {
  if (cache) return cache;
  let s = null;
  try { s = parse(localStorage.getItem(KEY), null); } catch { }
  // A v2 save from before courseEpoch existed has retired nothing yet.
  cache = s && s.v === 2 ? { ...fresh(), ...s, courseEpoch: s.courseEpoch || 0, prefs: { ...PREFS(), ...(s.prefs || {}) } } : migrate();
  if (retire(cache) || !s) save();
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

export const readGrandPrix = () => ({ best: 0, bestRank: 0, ...(load().gp || {}) });

/**
 * The Daily Canyon is a new course each UTC day, so what was kept for yesterday's (its stats,
 * sector bests and ghost) is dropped the first time today's is seen.
 */
export function rollDaily(mapId, day, ghostKey) {
  if (load().dailyDay === day) return;
  update((s) => {
    s.dailyDay = day;
    delete s.trackStats[mapId];
    delete s.sectors[mapId];
  });
  try { localStorage.removeItem(ghostKey); } catch { }
}

// Test seam: forget the cache so a test can swap localStorage underneath.
export function _reset() { cache = null; }
