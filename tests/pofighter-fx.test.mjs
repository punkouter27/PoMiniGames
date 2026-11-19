// node --test tests/pofighter-fx.test.mjs
// The fight's pure effect rules: how blows sound and place (sfx.js) and how they throw sparks (fx.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { panFor, impactShape, whooshShape } from '../src/PoMiniGames.Client/wwwroot/js/pofighter/sfx.js';
import { PROFILES, profileFor } from '../src/PoMiniGames.Client/wwwroot/js/pofighter/fx.js';

test('a sound is panned from its place in the arena, never hard to one side', () => {
    assert.equal(panFor(550, 1100), 0);
    assert.ok(panFor(90, 1100) < -0.6 && panFor(90, 1100) >= -0.8);
    assert.ok(panFor(1010, 1100) > 0.6 && panFor(1010, 1100) <= 0.8);
    assert.equal(panFor(-500, 1100), -0.8);
    assert.equal(panFor(10, 0), 0);
});

test('a kick lands harder than a punch, combos crack brighter, a block only paps', () => {
    const punch = impactShape({ type: 'hit', move: 'punchMid', combo: 1 });
    const kick = impactShape({ type: 'hit', move: 'kick', combo: 1 });
    const combo = impactShape({ type: 'hit', move: 'punchMid', combo: 4 });
    const block = impactShape({ type: 'block', move: 'kick' });
    assert.equal(punch.tag, 'flesh');
    assert.ok(kick.impulse > punch.impulse && kick.crack > punch.crack);
    assert.ok(combo.impulse > punch.impulse && combo.crack > punch.crack && combo.crack <= 1);
    assert.deepEqual([block.tag, block.crack], ['rubber', 0]);
});

test('a kick whooshes longer and lower than a punch', () => {
    const k = whooshShape('kick'), p = whooshShape('punchMid');
    assert.ok(k.dur > p.dur && k.from < p.from && k.to > k.from && p.to > p.from);
});

test('each blow throws its own sparks, and the round-ending blow throws the most', () => {
    assert.equal(profileFor({ type: 'block', move: 'kick' }), PROFILES.block);
    assert.equal(profileFor({ type: 'hit', move: 'kick' }), PROFILES.kick);
    assert.equal(profileFor({ type: 'hit', move: 'punchMid' }), PROFILES.punch);
    assert.equal(profileFor({ type: 'hit', move: 'punchMid' }, true), PROFILES.ko);
    const n = Object.values(PROFILES).map(p => p.n);
    assert.equal(Math.max(...n), PROFILES.ko.n);
    assert.equal(PROFILES.block.drops, 0);   // a block throws no sweat
});
