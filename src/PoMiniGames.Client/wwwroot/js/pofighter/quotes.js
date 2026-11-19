// pofighter/quotes.js — the winner's line after a match (the arcade's win screen). The lines live
// in data/pofighter/quotes.json, one list per fighter id plus "default" for Studio fighters, so
// they can be rewritten without touching code; "{foe}" is replaced with the loser's name.

let table = null;
let loading = null;

/** Starts loading the quote table once; the win screen works without it (default lines). */
export function loadQuotes() {
    loading ??= fetch(new URL('data/pofighter/quotes.json', document.baseURI).href)
        .then(r => (r.ok ? r.json() : null)).then(t => { table = t; }).catch(() => { });
    return loading;
}

const FALLBACK = ['Is that all you brought, {foe}?'];

/** A line for winner `id` against `foe`. r: a 0..1 number (pure, the tests pass their own). */
export function pickQuote(id, foe, r, quotes = table) {
    const list = quotes?.[id]?.length ? quotes[id] : quotes?.default?.length ? quotes.default : FALLBACK;
    const line = list[Math.min(list.length - 1, Math.floor(r * list.length))];
    return line.replaceAll('{foe}', foe);
}
