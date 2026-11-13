import assert from 'node:assert/strict';
import { test } from 'node:test';

// PoCapitol's worn ground: where the crowd has walked, the lawn turns to mud.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { createWear, WEAR_STANDING, WEAR_WALKING } = await import(new URL('js/pocapitol/ground.js', client));

test('a lawn nobody has walked on is untouched', () => {
    const wear = createWear();
    assert.equal(wear.at(0, 60), 0);
    assert.ok(wear.bytes.every(b => b === 0));
    assert.equal(wear.dirty, false);
});

test('walking wears faster than standing, and both add up over time', () => {
    const walked = createWear(), stood = createWear();
    for (let i = 0; i < 40; i++) {
        walked.tread([{ x: 5, z: 50, moving: true }], 0.25);
        stood.tread([{ x: 5, z: 50, moving: false }], 0.25);
    }
    assert.ok(WEAR_WALKING > WEAR_STANDING);
    assert.ok(walked.at(5, 50) > stood.at(5, 50));
    assert.ok(stood.at(5, 50) > 0);
    assert.equal(walked.dirty, true);
});

test('a packed spot saturates at fully worn and never beyond', () => {
    const wear = createWear();
    const crowd = Array.from({ length: 40 }, () => ({ x: -3, z: 30, moving: true }));
    for (let i = 0; i < 400; i++) wear.tread(crowd, 0.25);
    assert.equal(wear.at(-3, 30), 1);
    assert.equal(Math.max(...wear.bytes), 255);
});

test('wear stays where the feet were, and off the map is ignored', () => {
    const wear = createWear();
    for (let i = 0; i < 100; i++) wear.tread([{ x: 20, z: 80, moving: true }, { x: 500, z: -500, moving: true }], 0.25);
    assert.ok(wear.at(20, 80) > 0);
    assert.equal(wear.at(-20, 30), 0);
    assert.equal(wear.at(500, -500), 0);
});

test('a new attempt starts on a clean lawn', () => {
    const wear = createWear();
    for (let i = 0; i < 100; i++) wear.tread([{ x: 0, z: 40, moving: true }], 0.25);
    wear.dirty = false;
    wear.reset();
    assert.equal(wear.at(0, 40), 0);
    assert.ok(wear.bytes.every(b => b === 0));
    assert.equal(wear.dirty, true);
});
