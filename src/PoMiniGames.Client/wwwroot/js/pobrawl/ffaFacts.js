// Optional, structured Wikidata facts; no article abstracts or copied prose.
const CACHE_KEY = 'pominigames:pobrawl-ffa-facts-v1';
const CACHE_LIMIT = 24;
const CACHE_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const US_PRESIDENT_OFFICE = 'Q11696';
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 1000;
let wikidataRetryAfter = 0;

const CANONICAL_FIGHTERS = {
  trump: { name: 'Donald Trump', entityId: 'Q22686' },
  biden: { name: 'Joe Biden', entityId: 'Q6279' },
  obama: { name: 'Barack Obama', entityId: 'Q76' },
  bush: { name: 'George W. Bush', entityId: 'Q207' },
  clinton: { name: 'Bill Clinton', entityId: 'Q1124' },
  bushsr: { name: 'George H. W. Bush', entityId: 'Q23505' },
  reagan: { name: 'Ronald Reagan', entityId: 'Q9960' },
  carter: { name: 'Jimmy Carter', entityId: 'Q23685' },
  ford: { name: 'Gerald Ford', entityId: 'Q9582' },
  nixon: { name: 'Richard Nixon', entityId: 'Q9588' },
  lbj: { name: 'Lyndon B. Johnson', entityId: 'Q9640' },
  jfk: { name: 'John F. Kennedy', entityId: 'Q9696' },
  eisenhower: { name: 'Dwight D. Eisenhower', entityId: 'Q9916' },
  truman: { name: 'Harry S. Truman', entityId: 'Q11613' },
  fdr: { name: 'Franklin D. Roosevelt', entityId: 'Q8007' },
  hoover: { name: 'Herbert Hoover', entityId: 'Q35236' },
};

function claimValue(claim) {
  return claim?.mainsnak?.datavalue?.value;
}

function dateValue(value) {
  if (!value?.time) return null;
  const match = /^\+?(-?\d{1,6})-(\d{2})-(\d{2})/.exec(value.time);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year)) return null;
  if ((value.precision || 0) <= 9) return `${year}`;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return `${year}`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function wikidataDate(value) {
  return dateValue(value);
}

export function ordinalLabel(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

export function buildPresidentFacts(entity, name = '') {
  if (!entity?.id || !entity.claims) return null;
  const facts = [];
  const birth = dateValue(claimValue(entity.claims.P569?.[0]));
  if (birth) facts.push({ label: 'Born', value: birth });

  const terms = (entity.claims.P39 || []).filter((claim) =>
    claimValue(claim)?.id === US_PRESIDENT_OFFICE);
  for (const term of terms) {
    const qualifiers = term.qualifiers || {};
    const ordinal = ordinalLabel(qualifiers.P1545?.[0]?.datavalue?.value);
    const start = dateValue(qualifiers.P580?.[0]?.datavalue?.value);
    const end = dateValue(qualifiers.P582?.[0]?.datavalue?.value);
    if (ordinal) facts.push({ label: 'Presidency', value: `${ordinal} U.S. president` });
    if (start || end) facts.push({ label: 'Term', value: [start, end].filter(Boolean).join(' – ') });
  }
  if (!facts.length) return null;
  return {
    entityId: entity.id,
    name,
    facts,
    text: `Facts from Wikidata · ${facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}`,
    sourceUrl: `https://www.wikidata.org/wiki/${encodeURIComponent(entity.id)}`,
    attribution: 'Facts from Wikidata',
  };
}

function readCache(storage, now) {
  try {
    const value = JSON.parse(storage?.getItem(CACHE_KEY) || '{}');
    const entries = Object.entries(value).filter(([, row]) =>
      row && Number.isFinite(row.savedAt) && now - row.savedAt < CACHE_MAX_AGE && row.facts);
    return Object.fromEntries(entries.slice(-CACHE_LIMIT));
  } catch {
    return {};
  }
}

function writeCache(storage, cache) {
  if (!storage) return;
  try {
    const limited = Object.fromEntries(Object.entries(cache).slice(-CACHE_LIMIT));
    storage.setItem(CACHE_KEY, JSON.stringify(limited));
  } catch { /* private browsing and quota limits must not block a match */ }
}

function emit(callback, state, message, detail = {}) {
  try { callback?.({ state, message, ...detail }); } catch { /* UI listeners are optional */ }
}

function safeLocalStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function createWikimediaFacts(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const now = options.now || (() => Date.now());
  const onStatus = options.onStatus;
  const failureCooldownMs = Math.max(60_000, options.failureCooldownMs || DEFAULT_FAILURE_COOLDOWN_MS);
  const controllers = new Set();
  let disposed = false;
  const cache = readCache(storage, now());

  function cancelRequests() {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  function notify(state, text, name, sourceUrl = null) {
    emit(onStatus, state, text, { name, sourceUrl });
    try { options.onPresentation?.({ fact: { status: state, text, sourceUrl, name } }); }
    catch { /* parent UI is optional */ }
  }

  notify('off', 'Facts are off. Enable them to load Wikidata facts.', '');

  async function request(url, signal) {
    if (!fetchImpl) throw new Error('Fetch is unavailable.');
    const response = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
    if (!response?.ok) {
      const error = new Error(`Wikimedia returned ${response?.status || 'an error'}.`);
      error.status = response?.status || 0;
      error.retryAfter = response?.headers?.get?.('Retry-After') || null;
      throw error;
    }
    return response.json();
  }

  function parseRetryAfter(value, currentTime) {
    if (!value) return currentTime + failureCooldownMs;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return currentTime + Math.max(failureCooldownMs, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(currentTime + failureCooldownMs, date) : currentTime + failureCooldownMs;
  }

  async function loadFighter(id, displayName = id) {
    if (disposed) return null;
    cancelRequests();
    const canonical = CANONICAL_FIGHTERS[id];
    const name = canonical?.name || displayName || id;
    const cacheId = String(id || name).toLowerCase();
    const cached = cache[cacheId];
    if (cached?.facts && now() - cached.savedAt < CACHE_MAX_AGE) {
      notify('cached', cached.facts.text, name, cached.facts.sourceUrl);
      return cached.facts;
    }
    if (globalThis.navigator?.onLine === false) {
      notify('offline', 'Wikidata facts are unavailable offline.', name);
      return null;
    }
    if (now() < wikidataRetryAfter) {
      const seconds = Math.ceil((wikidataRetryAfter - now()) / 1000);
      notify('unavailable', `Wikidata is rate-limited; try again in about ${seconds} seconds.`, name);
      return null;
    }
    if (!fetchImpl) {
      notify('unavailable', 'Wikidata facts are unavailable in this browser.', name);
      return null;
    }

    const controller = new AbortController();
    controllers.add(controller);
    const signal = controller.signal;
    try {
      notify('loading', 'Loading structured facts from Wikidata.', name);
      let entityId = canonical?.entityId;
      if (!entityId) {
        const searchUrl = new URL(WIKIDATA_API);
        for (const [key, value] of Object.entries({
          action: 'wbsearchentities', search: name, language: 'en', uselang: 'en',
          type: 'item', limit: '5', format: 'json', origin: '*',
        })) searchUrl.searchParams.set(key, value);
        const search = await request(searchUrl, signal);
        if (disposed || signal.aborted) return null;
        entityId = (search.search || []).find((item) =>
          item.label?.toLowerCase() === name.toLowerCase())?.id;
      }
      if (!entityId) {
        notify('unavailable', 'No matching Wikidata entry was found.', name);
        return null;
      }

      const entityUrl = new URL(WIKIDATA_API);
      for (const [key, value] of Object.entries({
        action: 'wbgetentities', ids: entityId, props: 'claims', format: 'json', origin: '*',
      })) entityUrl.searchParams.set(key, value);
      const response = await request(entityUrl, signal);
      if (disposed || signal.aborted) return null;
      const facts = buildPresidentFacts(response.entities?.[entityId], name);
      if (!facts) {
        notify('unavailable', 'No structured presidential facts were found.', name);
        return null;
      }
      cache[cacheId] = { facts, savedAt: now() };
      wikidataRetryAfter = 0;
      const limited = Object.fromEntries(Object.entries(cache).slice(-CACHE_LIMIT));
      Object.keys(cache).forEach((key) => delete cache[key]);
      Object.assign(cache, limited);
      writeCache(storage, cache);
      notify('ready', facts.text, name, facts.sourceUrl);
      return facts;
    } catch (error) {
      if (disposed || signal.aborted || error?.name === 'AbortError') return null;
      const offline = globalThis.navigator?.onLine === false;
      if (!offline) {
        wikidataRetryAfter = error?.status === 429
          ? parseRetryAfter(error.retryAfter, now())
          : now() + failureCooldownMs;
      }
      const text = offline
        ? 'Wikidata facts are unavailable offline.'
        : error?.status === 429
          ? `Wikidata is rate-limited; try again in about ${Math.ceil((wikidataRetryAfter - now()) / 1000)} seconds.`
          : 'Wikidata facts could not be loaded; retry is paused briefly.';
      notify(offline ? 'offline' : 'unavailable', text, name);
      return null;
    } finally {
      controllers.delete(controller);
    }
  }

  return {
    loadFighter,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRequests();
    },
  };
}
