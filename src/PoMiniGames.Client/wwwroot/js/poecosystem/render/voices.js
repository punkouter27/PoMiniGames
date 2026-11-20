// voices.js — the island's fixed lines, spoken.
//
// A creature's thought ("The clover by the hollow is sweetest.") was only ever text in a
// panel. The lines are scripted and there are sixty-odd of them, so each was voiced once,
// offline (scripts/poecosystem/voices.mjs, a local text-to-speech model), in a voice of its
// species: these are recordings, like any sound effect. Nothing is generated at run time, the
// game talks to no service, and a line the script has not voiced yet is simply not spoken.
//
//   THOUGHTS   played from where the creature stands, through the same positional path as
//              every other sound on the island (audio.js): near is clear, far is faint and
//              wet. A thought is a line and sometimes one of five asides; those are separate
//              clips, played one after the other.
//   NARRATION  nine short lines for the chronicle's cards ("The mountain erupts."), not
//              positioned: the narrator is not on the island.
//
// One voice at a time. A line asked for while another is playing, or sooner than its caller's
// gap allows, is refused (the caller asks again when it next has reason to) rather than
// queued: a thought spoken ten seconds late is about a moment that has gone.
const MANIFEST = new URL('../../../audio/poecosystem/voices.json', import.meta.url);
const CACHE = 20;             // decoded clips kept; the rest are fetched again (the browser has them)
const ASIDE_PAUSE = 0.18;     // seconds between a line and its aside

export function createVoices(audio, { fetchImpl = (...a) => fetch(...a) } = {}) {
  let manifest = null; let loading = null; let failed = false;
  const decoded = new Map();    // file → AudioBuffer, oldest first
  let quietAt = 0;              // context time the current line ends
  let lastAt = -Infinity;       // context time the last line started

  function load() {
    if (!loading) {
      loading = fetchImpl(MANIFEST, { credentials: 'omit' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`voices.json ${r.status}`))))
        .then((m) => { manifest = m; })
        .catch(() => { failed = true; });
    }
    return loading;
  }

  async function clip(file) {
    const hit = decoded.get(file);
    if (hit) { decoded.delete(file); decoded.set(file, hit); return hit; }
    const res = await fetchImpl(new URL(`voices/${file}`, MANIFEST), { credentials: 'omit' });
    if (!res.ok) throw new Error(`${file} ${res.status}`);
    const buffer = await audio.context.decodeAudioData(await res.arrayBuffer());
    decoded.set(file, buffer);
    if (decoded.size > CACHE) decoded.delete(decoded.keys().next().value);
    return buffer;
  }

  /** The clips for a thought: the line, then its aside if it has one and both are voiced. */
  function partsOf(voice, text) {
    const lines = manifest.lines?.[voice];
    if (!lines) return null;
    if (lines[text]) return [lines[text]];
    for (const aside of manifest.asides ?? []) {
      if (!text.endsWith(aside)) continue;
      const line = text.slice(0, -aside.length).trimEnd();
      if (lines[line] && lines[aside]) return [lines[line], lines[aside]];
    }
    return null;
  }

  /**
   * Start `files` one after another. Returns false, having started nothing, when a line is
   * already playing or the last one started less than `gap` seconds ago.
   */
  function say(files, at, { gap = 0, level = 0.9, wet = 0.32 } = {}) {
    const ctx = audio.context;
    if (!ctx || !audio.enabled || failed || !files) return false;
    const now = ctx.currentTime;
    if (now < quietAt || now - lastAt < gap) return false;
    // Claimed before the fetch, so two askers in the same second cannot both win.
    lastAt = now; quietAt = now + 6;
    Promise.all(files.map(clip)).then((buffers) => {
      let when = ctx.currentTime + 0.03;
      for (const buffer of buffers) {
        const seconds = audio.playClip(buffer, at, { when, level, wet });
        if (!seconds) break;                   // out of earshot, or the device went away
        when += seconds + ASIDE_PAUSE;
      }
      quietAt = when;
    }).catch(() => { quietAt = ctx.currentTime; });
    return true;
  }

  return {
    /** Fetch the manifest now (the first line would otherwise wait for it). */
    warm() { load(); },
    get ready() { return !!manifest; },
    get failed() { return failed; },
    /** How many lines have a clip, by voice. */
    get counts() { return manifest ? Object.fromEntries(Object.entries(manifest.lines).map(([k, v]) => [k, Object.keys(v).length])) : {}; },

    /**
     * Speak a creature's thought from `at` ({ x, y, z }). Returns true if it started.
     * `gap`: the least seconds since the last line of any kind.
     */
    thought(species, text, at, { gap = 0 } = {}) {
      if (!manifest) { load(); return false; }
      const voice = manifest.species?.[species];
      return voice ? say(partsOf(voice, text), at, { gap }) : false;
    },

    /** Speak a narrator line by its text (chronicle.js NARRATION). Not positioned. */
    narrate(text) {
      if (!manifest) { load(); return false; }
      const file = manifest.lines?.narrator?.[text];
      return file ? say([file], null, { level: 0.8 }) : false;
    },
  };
}
