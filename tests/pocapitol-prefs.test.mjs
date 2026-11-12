import assert from 'node:assert/strict';
import { test } from 'node:test';

// PoCapitol's own comfort preferences: sanitising stored values, the key map, and the
// arrow-key fallback that must survive any remap.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { sanitizePrefs, loadPrefs, savePrefs, matches, rebind, describeCode, DEFAULTS, ACTIONS } =
    await import(new URL('js/pocapitol/prefs.js', client));

const storage = () => {
    const map = new Map();
    return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, value) };
};

test('nothing stored gives the defaults, with every action bound', () => {
    const prefs = sanitizePrefs(null);
    assert.equal(prefs.sensitivity, DEFAULTS.sensitivity);
    assert.equal(prefs.fov, DEFAULTS.fov);
    assert.equal(prefs.captions, false);
    assert.equal(prefs.director, true);
    for (const action of ACTIONS) assert.equal(prefs.keys[action.id], action.key);
});

test('a corrupt record falls back to defaults instead of throwing', () => {
    const store = storage();
    store.setItem('pocapitol.prefs.v1', '{not json');
    assert.deepEqual(loadPrefs(store), sanitizePrefs(null));
});

test('numbers are clamped and enums are whitelisted', () => {
    const prefs = sanitizePrefs({ sensitivity: 99, fov: 5, contrast: 'ultra', radar: 'rainbow', captions: 'yes' });
    assert.equal(prefs.sensitivity, 3);
    assert.equal(prefs.fov, 50);
    assert.equal(prefs.contrast, 'normal');
    assert.equal(prefs.radar, 'auto');
    assert.equal(prefs.captions, false, 'only a real boolean turns captions on');
});

test('a bad key binding is ignored but its action keeps its default', () => {
    const prefs = sanitizePrefs({ keys: { forward: 'ArrowUp', push: '</script>', pause: 'KeyP' } });
    assert.equal(prefs.keys.forward, 'ArrowUp', 'valid remaps survive');
    assert.equal(prefs.keys.push, 'Space', 'an invalid code keeps the default');
});

test('save then load round-trips exactly', () => {
    const store = storage();
    savePrefs({ sensitivity: 1.75, fov: 71, captions: true, contrast: 'high', radar: 'colorsafe', director: false,
        keys: { push: 'KeyF' } }, store);
    const loaded = loadPrefs(store);
    assert.equal(loaded.sensitivity, 1.75);
    assert.equal(loaded.fov, 71);
    assert.equal(loaded.captions, true);
    assert.equal(loaded.contrast, 'high');
    assert.equal(loaded.radar, 'colorsafe');
    assert.equal(loaded.director, false);
    assert.equal(loaded.keys.push, 'KeyF');
});

test('the arrows always steer, whatever the map says', () => {
    const prefs = sanitizePrefs({ keys: { forward: 'KeyI', back: 'KeyK', left: 'KeyJ', right: 'KeyL' } });
    assert.equal(matches(prefs, 'forward', 'KeyI'), true);
    assert.equal(matches(prefs, 'forward', 'ArrowUp'), true);
    assert.equal(matches(prefs, 'right', 'ArrowRight'), true);
    assert.equal(matches(prefs, 'forward', 'KeyW'), false, 'a remap really does unbind the old key');
});

test('codes read back as something a person can recognise', () => {
    assert.equal(describeCode('KeyW'), 'W');
    assert.equal(describeCode('ShiftLeft'), 'Shift');
    assert.equal(describeCode('Space'), 'Space');
    assert.equal(describeCode('ArrowLeft'), 'LEFT');
    assert.equal(describeCode(undefined), '—');
});

test('tracer style, combat shake and the debrief writer are remembered and whitelisted', () => {
    const store = storage();
    const saved = savePrefs({ tracers: 'off', motion: 'reduced', debrief: 'ollama', debriefModel: 'qwen2.5:3b' }, store);
    assert.deepEqual([saved.tracers, saved.motion, saved.debrief, saved.debriefModel], ['off', 'reduced', 'ollama', 'qwen2.5:3b']);
    assert.deepEqual(loadPrefs(store), saved);
    const bad = sanitizePrefs({ tracers: 'laser', motion: 'none', debrief: 'cloud', debriefModel: 'x; rm -rf' });
    assert.deepEqual([bad.tracers, bad.motion, bad.debrief, bad.debriefModel],
        [DEFAULTS.tracers, DEFAULTS.motion, DEFAULTS.debrief, DEFAULTS.debriefModel]);
});

test('binding a key another action holds swaps the two, so no key does two things', () => {
    const prefs = sanitizePrefs(null);
    const swapped = rebind(prefs, 'push', 'KeyW');
    assert.equal(swapped.keys.push, 'KeyW');
    assert.equal(swapped.keys.forward, 'Space');
    assert.equal(new Set(Object.values(swapped.keys)).size, ACTIONS.length, 'every action still has its own key');
    assert.equal(rebind(prefs, 'push', '</script>'), prefs, 'a bad code changes nothing');
    assert.equal(rebind(prefs, 'jump', 'KeyJ'), prefs, 'an unknown action changes nothing');
    assert.equal(prefs.keys.push, 'Space', 'the original map is not mutated');
});

test('the footage look defaults to a trace, can be full or off, and rejects anything else', () => {
    assert.equal(sanitizePrefs(null).footage, 'light');
    assert.equal(savePrefs({ footage: 'off' }, storage()).footage, 'off');
    assert.equal(savePrefs({ footage: 'on' }, storage()).footage, 'on');
    assert.equal(sanitizePrefs({ footage: 'vhs' }).footage, DEFAULTS.footage);
});
