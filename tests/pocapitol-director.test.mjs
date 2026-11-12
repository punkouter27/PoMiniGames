import assert from 'node:assert/strict';
import { test } from 'node:test';

// The spectator auto-director: a decaying heat grid over the impact events the simulation
// already emits, scored against every living raider, cut on a dwell with hysteresis.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { createDirector, scoreCandidate, addHeat, decayHeat, heatAt, cellKey } =
    await import(new URL('js/pocapitol/director.js', client));

const stateOf = (actors, lines = [{ state: 'holding', id: 0, integrity: 100 }]) => ({
    lines, enemies: [{ line: 0, z: 33, health: 10 }], events: [], companions: actors,
});
const actor = (id, x, z, extra = {}) => ({ id, x, z, health: 30, milestone: 0, crowding: 0, ...extra });

test('heat decays and can be raised by an event', () => {
    const heat = new Map();
    addHeat(heat, { x: 10, z: 10, energy: 240 });
    const before = heatAt(heat, 10, 10);
    assert.ok(before > 1, 'a heavy blow registers');
    decayHeat(heat, 4.5);
    const after = heatAt(heat, 10, 10);
    assert.ok(after < before && after > 0, 'one half-life lowers but does not clear it');
    decayHeat(heat, 60);
    assert.equal(heat.size, 0, 'a quiet minute clears the grid');
});

test('neighbouring cells count toward the same point', () => {
    const heat = new Map();
    heat.set(cellKey(11, 9), 2);
    assert.equal(heatAt(heat, 0, 0), 2, 'a hit in the next cell still warms this one');
});

test('a downed raider is never a subject', () => {
    const state = stateOf([actor(1, 0, 50, { health: 0 })]);
    assert.equal(scoreCandidate(state, state.companions[0], new Map()), -Infinity);
});

test('heat beats progress when the camera has a choice', () => {
    const state = stateOf([actor(1, 0, 50), actor(2, 30, 50)]);
    const heat = new Map();
    heat.set(cellKey(30, 50), 6);
    const quiet = scoreCandidate(state, state.companions[0], new Map());
    const hot = scoreCandidate(state, state.companions[1], heat);
    assert.ok(hot > quiet);
});

test('progress alone still decides on a quiet stretch', () => {
    const state = stateOf([actor(1, 0, 50), actor(2, 0, 52, { milestone: 4 })]);
    const none = new Map();
    assert.ok(scoreCandidate(state, state.companions[1], none) > scoreCandidate(state, state.companions[0], none));
});

test('the camera holds a subject through a short lull, then cuts', () => {
    const director = createDirector({ dwellMin: 3, dwellMax: 3 });
    const state = stateOf([actor(1, 0, 50), actor(2, 30, 50)]);
    let now = 0;
    director.observe(state, now);
    const first = director.pick(state);
    assert.ok(first, 'a subject is chosen');

    // The other raider becomes the interesting one.
    for (let i = 0; i < 40; i++) {
        now += 100;
        state.events = [{ type: 'hit', x: 30, z: 50, energy: 400 }];
        director.observe(state, now);
    }
    const second = director.pick(state);
    assert.equal(second.id, 2, 'after the dwell, the camera cuts to the action');

    // Reset forgets everything.
    director.reset();
    assert.equal(director.id, -1);
});
