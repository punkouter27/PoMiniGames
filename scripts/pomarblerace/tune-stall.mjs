// Stall tuner: sweeps the unstick constants (tuning.js STALL_*) across every map with the
// headless harness and prints a table. Each candidate runs in its own process (tuning.js is
// rewritten as it loads, see loader.mjs), several at once.
//
//   node tune-stall.mjs [mapIds=all] [seeds=1,2]
//
// Lower is better for stalled / stallEvents / maxStall / eliminated; higher for finished. It
// never edits tuning.js: a candidate is worth adopting only if it beats today's on EVERY map.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const [mapsArg = 'all', seedsArg = '1'] = process.argv.slice(2);
const maps = mapsArg === 'all' ? [1, 2, 3, 4, 5] : mapsArg.split(',').map(Number);
const seeds = seedsArg.split(',').map(Number);

// Today's values first; each other row changes one or two knobs.
const CANDIDATES = [
  { label: 'today' },
  { label: 'nudge 20', STALL_NUDGE: 20 },
  { label: 'nudge 10', STALL_NUDGE: 10 },
  { label: 'after 3', STALL_AFTER: 3 },
  { label: 'after 4 repeat 1.5', STALL_AFTER: 4, STALL_REPEAT: 1.5 },
  { label: 'step 12 max 50', STALL_STEP: 12, STALL_MAX: 50 },
  { label: 'gain 8', STALL_GAIN: 8 },
  { label: 'lookahead 20', STALL_LOOKAHEAD: 20 },
];

function run(cand, map, seed) {
  const { label, ...over } = cand;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(here, 'harness.mjs'), 'race', String(map), String(seed)],
      { env: { ...process.env, PMR_TUNE: JSON.stringify(over) }, maxBuffer: 1 << 20, timeout: 30 * 60_000 },
      (err, stdout) => (err ? reject(err) : resolve({ label, ...JSON.parse(stdout.trim().split('\n').pop()) })));
  });
}

const jobs = [];
for (const c of CANDIDATES) for (const m of maps) for (const s of seeds) jobs.push([c, m, s]);
const results = [];
const width = Math.max(1, Math.min(os.cpus().length - 1, 12));
let next = 0;
await Promise.all(Array.from({ length: width }, async () => {
  while (next < jobs.length) {
    const [c, m, s] = jobs[next++];
    const r = await run(c, m, s);
    results.push(r);
    process.stderr.write(`  ${r.label.padEnd(20)} map ${m} seed ${s}: fin ${r.finished} stall ${r.stalled} events ${r.stallEvents} max ${r.maxStall}s (${Math.round(r.ms / 1000)}s)\n`);
  }
}));

// Sum over seeds, per candidate per map.
const agg = new Map();
for (const r of results) {
  const k = `${r.label}|${r.map}`;
  const a = agg.get(k) || { label: r.label, map: r.map, finished: 0, eliminated: 0, stalled: 0, stallEvents: 0, maxStall: 0, median: 0, n: 0 };
  a.finished += r.finished; a.eliminated += r.eliminated; a.stalled += r.stalled; a.stallEvents += r.stallEvents;
  a.maxStall = Math.max(a.maxStall, r.maxStall); a.median += r.median; a.n++;
  agg.set(k, a);
}
console.log('candidate'.padEnd(22) + 'map  finished  elim  stalled  events  maxStall  medianFinish');
for (const c of CANDIDATES) {
  for (const m of maps) {
    const a = agg.get(`${c.label}|${m}`);
    console.log(`${c.label.padEnd(22)}${String(m).padEnd(5)}${String(a.finished).padEnd(10)}${String(a.eliminated).padEnd(6)}${String(a.stalled).padEnd(9)}${String(a.stallEvents).padEnd(8)}${String(a.maxStall).padEnd(10)}${(a.median / a.n).toFixed(1)}`);
  }
}
// A candidate "beats today" only if it is no worse on every map and better on at least one.
const key = (a) => [a.finished - a.eliminated * 2 - a.stalled * 2, -a.stallEvents];
for (const c of CANDIDATES.slice(1)) {
  let better = 0, worse = 0;
  for (const m of maps) {
    const [t0, t1] = key(agg.get(`today|${m}`)), [c0, c1] = key(agg.get(`${c.label}|${m}`));
    if (c0 > t0 || (c0 === t0 && c1 > t1)) better++;
    else if (c0 < t0 || (c0 === t0 && c1 < t1)) worse++;
  }
  console.log(`${c.label}: better on ${better}, worse on ${worse} of ${maps.length} maps${worse === 0 && better > 0 ? '  ← beats today everywhere' : ''}`);
}
