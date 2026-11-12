import assert from 'node:assert/strict';
import { test } from 'node:test';

// Carried signage comes from a data file: short, unique, printable phrases, and nothing that
// can break the scene build when the list is edited or missing.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { sanitizeSigns, loadSigns, MAX_WORDS } = await import(new URL('js/pocapitol/signs.js', client));

test('a missing or malformed list yields nothing, never a throw', () => {
    assert.deepEqual(sanitizeSigns(null), []);
    assert.deepEqual(sanitizeSigns({}), []);
    assert.deepEqual(sanitizeSigns({ placards: 'not an array' }), []);
    assert.deepEqual(sanitizeSigns(['ok', 42, null, {}]), ['OK']);
});

test('entries are trimmed, collapsed, upper-cased and de-duplicated', () => {
    assert.deepEqual(sanitizeSigns({ placards: ['  we   are here ', 'WE ARE HERE', 'press'] }), ['WE ARE HERE', 'PRESS']);
});

test('long entries are dropped and the list is capped', () => {
    assert.deepEqual(sanitizeSigns({ placards: ['x'.repeat(41)] }), []);
    const many = Array.from({ length: 40 }, (_, i) => `SIGN ${i}`);
    assert.equal(sanitizeSigns({ placards: many }).length, 24, 'the board budget stays bounded');
});

test('a board holds no more than six words', () => {
    assert.equal(MAX_WORDS, 6);
    assert.deepEqual(sanitizeSigns({ placards: ['ONE', 'ONE TWO THREE FOUR FIVE SIX', 'ONE TWO THREE FOUR FIVE SIX SEVEN'] }),
        ['ONE', 'ONE TWO THREE FOUR FIVE SIX']);
});

test('the shipped placard file loads and parses', async () => {
    const { readFileSync } = await import('node:fs');
    const file = new URL('data/pocapitol/placards.json', client);
    const texts = sanitizeSigns(JSON.parse(readFileSync(file, 'utf8')));
    assert.ok(texts.length >= 10, 'the shipped list has enough variety to read as a crowd');
    assert.ok(texts.every(text => text.length <= 40));
    assert.ok(texts.every(text => text.split(' ').length <= MAX_WORDS), 'a shipped line is too long for a board');
});

test('loadSigns returns an empty list instead of rejecting when fetch is unavailable', async () => {
    assert.deepEqual(await loadSigns('data/pocapitol/placards.json', { fetchImpl: undefined }), []);
    assert.deepEqual(await loadSigns('missing.json', { fetchImpl: async () => ({ ok: false }) }), []);
    assert.deepEqual(await loadSigns('bomb.json', { fetchImpl: async () => { throw new Error('offline'); } }), []);
});
