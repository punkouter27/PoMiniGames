// node --test tests/platform-audio.test.mjs
// Pure parts of the deck's audio ideas: #13 impact synthesis, #14 acoustic zones,
// #15 tension engine, #16 spatial menu + event sonification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImpactVoice, BASE_HZ, MATERIAL_TAGS, play } from '../src/PoMiniGames.Client/wwwroot/js/platform/impactSynth.js';
import { zoneAt, createZoneMap, zoneSend, ZONES } from '../src/PoMiniGames.Client/wwwroot/js/platform/acoustics.js';
import { tensionFromDrivers, stemGains, createTensionMixer } from '../src/PoMiniGames.Client/wwwroot/js/platform/tensionMixer.js';
import { STEM_NAMES } from '../src/PoMiniGames.Client/wwwroot/js/platform/musicLayers.js';
import { navPitch, screenPan, countdownPitch, rankChangeNotes } from '../src/PoMiniGames.Client/wwwroot/js/platform/uiAudio.js';
import { resultSummaryText } from '../src/PoMiniGames.Client/wwwroot/js/platform/speechBus.js';

test('#13 impact voice follows material, impulse, size, occlusion and doppler', () => {
    for (const tag of MATERIAL_TAGS) assert.ok(BASE_HZ[tag] > 0, `base pitch for ${tag}`);

    const soft = buildImpactVoice('metal', 2, { variation: 0.5 });
    const hard = buildImpactVoice('metal', 60, { variation: 0.5 });
    assert.ok(hard.energy > soft.energy && hard.gain > soft.gain, 'harder hit is louder');
    assert.ok(hard.modes.length >= 3, 'metal rings with several modes');
    assert.ok(hard.modes[1].decay < hard.modes[0].decay, 'upper modes die faster');

    const glass = buildImpactVoice('glass', 20, { variation: 0.5 });
    const dirt = buildImpactVoice('dirt', 20, { variation: 0.5 });
    assert.ok(glass.transient.highpass > dirt.transient.highpass, 'hard material has the brighter click');
    assert.ok(dirt.body, 'soft material gets a body thud');

    const big = buildImpactVoice('wood', 20, { size: 4, variation: 0.5 });
    const small = buildImpactVoice('wood', 20, { size: 1, variation: 0.5 });
    assert.ok(Math.abs(big.modes[0].freq * 2 - small.modes[0].freq) < 1, 'f ∝ 1/√size');

    const hidden = buildImpactVoice('stone', 20, { occlusion: 1 });
    assert.ok(hidden.lowpass < 1000 && soft.lowpass > 17000, 'occlusion closes the lowpass');

    const approaching = buildImpactVoice('metal', 20, {
        variation: 0.5, position: { x: 0, y: 0, z: -10 }, velocity: { x: 0, y: 0, z: 30 },
    });
    assert.ok(approaching.doppler > 1 && approaching.pan === null, 'approaching source is pitched up and positioned in 3D');

    assert.equal(buildImpactVoice('unobtainium', 10).material, 'stone', 'unknown tag falls back');
    assert.equal(play('metal', 10), false, 'no AudioContext in node: play is a silent no-op');
});

test('#14 zoneAt picks the strongest region and blends across falloff', () => {
    const map = createZoneMap([
        { zone: 'tunnel', min: { x: 0, z: 0 }, max: { x: 10, z: 100 }, falloff: 10 },
        { zone: 'grandstand', center: { x: 50, z: 50 }, radius: 5, falloff: 20 },
    ], 'field');
    assert.deepEqual(map.at({ x: 5, z: 50 }), { zone: 'tunnel', weight: 1 });
    const edge = map.at({ x: 15, z: 50 });
    assert.equal(edge.zone, 'tunnel');
    assert.ok(Math.abs(edge.weight - 0.5) < 1e-9);
    assert.equal(map.at({ x: 60, z: 50 }).zone, 'grandstand');
    assert.deepEqual(map.at({ x: 500, z: 500 }), { zone: 'field', weight: 1 });
    assert.equal(zoneAt({ x: 0, z: 0 }, []).zone, 'field');
    for (const z of Object.keys(ZONES)) assert.ok(zoneSend(z) >= 0, `send for ${z}`);
    assert.ok(zoneSend('field') < zoneSend('cave'), 'open field is drier than a cave');
});

test('#15 tension rises with pressure and brings stems in in order', () => {
    assert.equal(tensionFromDrivers({}), 0);
    const calm = tensionFromDrivers({ clock: 0.1, position: 0.5, health: 1 });
    const late = tensionFromDrivers({ clock: 1, position: 0, proximity: 0.9, scoreDiff: 0.05 });
    assert.ok(late > calm && late <= 1);
    assert.ok(tensionFromDrivers({ health: 0 }) >= 0.75, 'a single alarm pulls the mix up');
    assert.ok(tensionFromDrivers({ clock: 1, scoreDiff: 0 }) > tensionFromDrivers({ clock: 1, scoreDiff: 1 }), 'close score is tenser');

    const low = stemGains(0.1), high = stemGains(1);
    for (const n of STEM_NAMES) assert.ok(n in low && n in high, `stem ${n}`);
    assert.equal(low.kick, 0);
    assert.equal(high.lead, 1);
    assert.ok(low.pad > high.pad, 'pad thins as drums arrive');
    assert.ok(stemGains(1, { weather: 1 }).pad > high.pad, 'a storm keeps a dark bed');

    const calls = [];
    const fake = { setIntensity: (x) => calls.push(['i', x]), setStemGains: (g) => calls.push(['g', g]) };
    const mix = createTensionMixer(fake);
    let t = 0;
    for (let i = 0; i < 40; i++) t = mix.update({ clock: 1, proximity: 1 }, 0.1);
    const target = tensionFromDrivers({ clock: 1, proximity: 1 });
    assert.ok(target > 0.8 && Math.abs(t - target) < 0.01, `attack reaches the target ${target}, got ${t}`);
    const up = t;
    t = mix.update({}, 0.1);
    assert.ok(t < up && t > up * 0.9, 'release is slow');
    assert.ok(calls.some((c) => c[0] === 'g'), 'stems handed to musicLayers');
    mix.reset();
    assert.equal(mix.tension(), 0);
});

test('#16 sonification pitches carry meaning; pan is capped and mono-safe', () => {
    assert.ok(navPitch(1) > navPitch(0) && navPitch(5) > navPitch(4), 'list order climbs');
    assert.ok(Math.abs(navPitch(5) / navPitch(0) - 2) < 1e-9, 'wraps an octave up');
    assert.equal(screenPan(0, 1000), -0.6);
    assert.equal(screenPan(1000, 1000), 0.6);
    assert.equal(screenPan(500, 1000), 0);
    assert.equal(screenPan(10, 0), 0);
    assert.ok(countdownPitch(1) > countdownPitch(2) && countdownPitch(2) > countdownPitch(3), '3-2-1 climbs');
    assert.ok(countdownPitch(0) > countdownPitch(1), 'go is highest');
    const up = rankChangeNotes(4, 2), down = rankChangeNotes(2, 4);
    assert.ok(up.gained && up.notes[1] > up.notes[0]);
    assert.ok(!down.gained && down.notes[1] < down.notes[0]);

    assert.equal(
        resultSummaryText({ game: 'PoRacer', outcome: 'win', rank: 1, of: 4, score: 12345, best: true }),
        'You win in PoRacer, 1st of 4, score 12,345, a new personal best.');
    assert.equal(resultSummaryText({ rank: 12 }), '12th place.');
    assert.equal(resultSummaryText({}), '');
});
