// names.js — species-flavoured names, unique within a run. Repeats get a roman
// numeral ("Fern II"), which reads as lineage in the log. The namer owns its RNG
// stream so its state (rng + used counts) snapshots as one unit.

const TABLES = [
  // rabbit: soft, botanical
  { pre: ['Fe', 'Clo', 'Mo', 'Ha', 'Bra', 'Thi', 'Pi', 'So', 'Dai', 'Wi', 'Nu', 'Ta', 'Li', 'Po', 'Bu'],
    suf: ['rn', 'ver', 'ss', 'zel', 'mble', 'stle', 'p', 'rrel', 'sy', 'llow', 't', 'bby', 'ly', 'ppy', 'tton'] },
  // deer: trees and meadows
  { pre: ['Wil', 'Bir', 'Al', 'Ro', 'Bel', 'Fa', 'Hea', 'Jun', 'Lau', 'Mea', 'Sor', 'Ver', 'Lin', 'Bry'],
    suf: ['low', 'ch', 'der', 'wan', 'la', 'wn', 'ther', 'iper', 'rel', 'dow', 'ra', 'na', 'den', 'ony'] },
  // wolf: hard consonants
  { pre: ['Em', 'Fa', 'Sto', 'Sa', 'Gho', 'Roo', 'Fli', 'Sha', 'Gri', 'Ho', 'Va', 'Ky', 'Dra', 'Ny'],
    suf: ['ber', 'ng', 'rm', 'ble', 'st', 'k', 'nt', 'de', 'm', 'wl', 'rg', 'ra', 'ke', 'x'] },
  // human: short given names
  { pre: ['Ab', 'El', 'Ka', 'To', 'Mi', 'Ru', 'Sa', 'Ori', 'Ne', 'Ly', 'Jo', 'Ida', 'Ma', 'Te'],
    suf: ['el', 'ara', 'i', 'mas', 'ra', 'th', 'ma', 'on', 'va', 'dia', 'nas', 'n', 'ren', 'o'] },
];

// Syllable pairs that land on a rude word or a slur. Every combination was listed and read
// (2026-11-23); these three are the ones that came out wrong. A blocked pair takes the next
// suffix instead, with no extra draw, so the stream (and every other name) is unchanged.
const BLOCKED = new Set(['Piss', 'Porn', 'Kyke']);

function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

export function createNamer(rng) {
  let used = new Map();
  return {
    next(speciesId) {
      const t = TABLES[speciesId] ?? TABLES[0];
      const pre = t.pre[rng.int(t.pre.length)];
      let si = rng.int(t.suf.length);
      while (BLOCKED.has(pre + t.suf[si])) si = (si + 1) % t.suf.length;
      const base = pre + t.suf[si];
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      return count === 1 ? base : `${base} ${roman(count)}`;
    },
    getState() { return { rng: rng.getState(), used: [...used.entries()] }; },
    setState(s) { rng.setState(s.rng); used = new Map(s.used ?? []); },
  };
}
