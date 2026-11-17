// node --test tests/features-10-16.test.mjs
// Focused unit checks for the pure JS helpers introduced in features 10, 11, 13, and 16.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapWmoToWeather, computeDayFraction } from '../src/PoMiniGames.Client/wwwroot/js/poecosystem/host/liveWeather.js';
import { encodeGif } from '../src/PoMiniGames.Client/wwwroot/js/sand-playground/gifEncoder.js';
import { matchSpokenOption } from '../src/PoMiniGames.Client/wwwroot/js/platform/speechBus.js';
import { classifyPose, STUDIO_MOVES } from '../src/PoMiniGames.Client/wwwroot/js/pofighter/studio.js';

test('liveWeather maps WMO codes and solar day fraction cleanly', () => {
    assert.equal(mapWmoToWeather(95, 22).kind, 2); // storm
    assert.equal(mapWmoToWeather(73, -2).kind, 4); // snow
    assert.equal(mapWmoToWeather(61, 15).kind, 1); // rain
    assert.equal(mapWmoToWeather(0, 36).kind, 3);  // heatwave drought
    assert.equal(mapWmoToWeather(0, 20).kind, 0);  // clear

    const noon = computeDayFraction(
        Date.parse('2026-06-21T12:00:00Z'),
        '2026-06-21T06:00:00Z',
        '2026-06-21T18:00:00Z',
        0,
    );
    assert.ok(Math.abs(noon - 0.5) < 0.01, `expected ~0.5 at solar noon, got ${noon}`);
});

test('gifEncoder produces a valid GIF89a animated blob', async () => {
    const w = 8, h = 6;
    const f1 = new Uint8Array(w * h * 4).fill(255);
    const f2 = new Uint8Array(w * h * 4).fill(40);
    const blob = encodeGif({ width: w, height: h, frames: [{ rgba: f1, delayCs: 10 }, { rgba: f2, delayCs: 10 }] });
    assert.equal(blob.type, 'image/gif');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const header = String.fromCharCode(...bytes.slice(0, 6));
    assert.equal(header, 'GIF89a');
    assert.equal(bytes[bytes.length - 1], 0x3b);
});

test('speechBus matchSpokenOption parses numbers, letters, and option text', () => {
    const opts = ['Paris', 'Tokyo', 'Cairo', 'Reykjavik'];
    assert.equal(matchSpokenOption('option two', opts), 1);
    assert.equal(matchSpokenOption('C', opts), 2);
    assert.equal(matchSpokenOption('number 4', opts), 3);
    assert.equal(matchSpokenOption('I think Tokyo', opts), 1);
    assert.equal(matchSpokenOption('something unrelated', opts), -1);
});

test('pofighter studio classifies basic poses and exposes expected move list', () => {
    assert.ok(STUDIO_MOVES.some(m => m.id === 'punchMid'));
    assert.ok(STUDIO_MOVES.some(m => m.id === 'kick'));

    // Build a 33-point landmark array standing neutral
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
    lm[0] = { x: 0.5, y: 0.2 };   // nose
    lm[11] = { x: 0.45, y: 0.32 }; lm[12] = { x: 0.55, y: 0.32 };
    lm[15] = { x: 0.44, y: 0.50 }; lm[16] = { x: 0.56, y: 0.50 };
    lm[23] = { x: 0.47, y: 0.56 }; lm[24] = { x: 0.53, y: 0.56 };
    lm[27] = { x: 0.47, y: 0.90 }; lm[28] = { x: 0.53, y: 0.90 };
    assert.equal(classifyPose(lm), 'idle');

    // Raise both wrists above nose -> victory
    lm[15] = { x: 0.42, y: 0.10 };
    lm[16] = { x: 0.58, y: 0.10 };
    assert.equal(classifyPose(lm), 'victory');

    // Extend right wrist forward -> punchMid
    lm[15] = { x: 0.45, y: 0.45 };
    lm[16] = { x: 0.82, y: 0.34 };
    assert.equal(classifyPose(lm), 'punchMid');
});
