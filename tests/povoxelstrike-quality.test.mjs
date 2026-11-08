import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/povoxelstrike/', import.meta.url);
const source = (name) => readFile(new URL(name, root), 'utf8');
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const settingsUrl = moduleUrl(await source('settings.js'));
const qualityUrl = moduleUrl((await source('quality.js')).replace("'./settings.js'", JSON.stringify(settingsUrl)));
const { resolveQuality, detectTier, AdaptiveQuality, applyRenderTier } = await import(qualityUrl);
// Execute the production methods with small renderer doubles; no WebGL/browser needed.
const importsRemoved = (text) => text.replace(/^import .*;\r?$/gm, '');
const { Engine } = await import(moduleUrl(`
import { AdaptiveQuality, applyRenderTier } from ${JSON.stringify(qualityUrl)};
const SI_PHYSICS_STEP = 1 / 60;
${importsRemoved(await source('game.js'))}
`));
const { Vfx } = await import(moduleUrl(`
const THREE = { Vector2: class {}, Matrix4: class {}, Color: class {} };
class Pass {}
${importsRemoved(await source('vfx.js'))}
`));
const { ShrapnelField } = await import(moduleUrl(`
const MATERIAL_PRESETS = { stone: { density: 2400 }, soil: { density: 1600 } };
${importsRemoved(await source('shrapnel.js'))}
`));

beforeEach(() => {
    globalThis.window = { location: { search: '' }, devicePixelRatio: 1 };
    globalThis.document = { documentElement: { dataset: {} }, hidden: false };
    globalThis.localStorage = { getItem: () => null };
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: 'desktop', hardwareConcurrency: 16, deviceMemory: 8 },
    });
});

function feed(controller, fps, seconds) {
    const changes = [];
    for (let i = 0; i < fps * seconds; i++) {
        const change = controller.update(1 / fps);
        if (change) changes.push(change);
    }
    return changes;
}

test('high core count is not a GPU benchmark; auto never guesses ultra', () => {
    assert.equal(detectTier(), 'high');
    assert.equal(resolveQuality().auto, true);
    assert.equal(resolveQuality().dynamicResolution, true);
    assert.equal(resolveQuality().shadowMapSize, 2048);
    assert.equal(resolveQuality().shrapnel, 48);
    assert.equal(resolveQuality().ssaoHalfRes, true);
    assert.equal(resolveQuality().pixelRatioCap, 1);
    navigator.hardwareConcurrency = 4;
    assert.equal(detectTier(), 'medium');
    navigator.userAgent = 'Android Mobile';
    assert.equal(detectTier(), 'low');
    assert.equal(resolveQuality().shadows, false);
    assert.equal(resolveQuality().bloom, false);
});

test('URL wins over saved quality; explicit tiers retain their feature budgets', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra']) {
        localStorage.getItem = () => JSON.stringify({ gfx: tier });
        let q = resolveQuality();
        assert.equal(q.tier, tier);
        assert.equal(q.auto, false);
        assert.equal(q.bloom, true);
        assert.equal(q.shadows, true);
        assert.equal(q.dynamicResolution, tier !== 'ultra');
        assert.equal(q.pixelRatioCap, 2);
        window.location.search = '?gfx=ULTRA';
        q = resolveQuality();
        assert.equal(q.tier, 'ultra');
        assert.equal(q.dynamicResolution, false);
        assert.equal(q.shadowMapSize, 4096);
        assert.equal(q.shrapnel, 140);
        window.location.search = '';
    }
    localStorage.getItem = () => '{"gfx":"auto"}';
    assert.equal(resolveQuality('ultra').auto, false);
    window.location.search = '?gfx=invalid';
    assert.equal(resolveQuality().auto, true);
});

test('sustained 8–12 FPS reaches lower post/shadow budgets within a demo slot', () => {
    for (const fps of [8, 11, 12, 25]) {
        const controller = new AdaptiveQuality(resolveQuality());
        const changes = feed(controller, fps, 12);
        assert.equal(controller.scale, 0.6, `${fps} FPS resolution floor`);
        assert.equal(controller.tier, 'low', `${fps} FPS demotion`);
        assert.ok(changes.some(c => c.tier === 'medium'));
        assert.ok(changes.some(c => c.tier === 'low'));
        assert.ok(changes.length < 15, 'target reallocations are throttled');
    }
});

test('healthy frames and isolated stalls do not demote; resolution recovers without tier flapping', () => {
    const q = resolveQuality();
    const controller = new AdaptiveQuality(q);
    feed(controller, 60, 10);
    assert.equal(controller.scale, 1);
    assert.equal(controller.tier, 'high');
    controller.update(0.3);
    feed(controller, 60, 4);
    assert.equal(controller.tier, 'high');
    feed(controller, 12, 12);
    feed(controller, 60, 12);
    assert.equal(controller.scale, 1);
    assert.equal(controller.tier, 'low');
});

test('hidden tabs, suspension, invalid timestamps and paused observations reset the probe', () => {
    for (const [dt, visible] of [[10, true], [-1, true], [0, true], [NaN, true], [0.1, false]]) {
        const controller = new AdaptiveQuality(resolveQuality());
        feed(controller, 12, 2);
        const scale = controller.scale;
        for (let i = 0; i < 100; i++) assert.equal(controller.update(dt, visible), null);
        assert.equal(controller.tier, 'high');
        assert.equal(controller.scale, scale);
        assert.equal(controller.slowTime, 0);
    }
});

test('forced quality never demotes, even under sustained 8 FPS', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra']) {
        const controller = new AdaptiveQuality(resolveQuality(tier));
        feed(controller, 8, 30);
        assert.equal(controller.tier, tier);
        const q = resolveQuality(tier);
        const budget = q.shrapnel;
        applyRenderTier(q, 'low');
        assert.equal(q.shrapnel, budget);
    }
});

test('auto chip budget retires surplus bodies immediately and zero budget does no spawn work', () => {
    const removed = [], matrices = [];
    const chips = Object.assign(Object.create(ShrapnelField.prototype), {
        enabled: true, capacity: 48, budget: 48, cursor: 47, live: 48,
        slots: Array.from({ length: 48 }, (_, i) => ({ live: true, body: { id: i, mass: 37 } })),
        world: { removeBody: b => removed.push(b.id) },
        mesh: { setMatrixAt: i => matrices.push(i), instanceMatrix: {} },
    });
    chips.setBudget(24);
    assert.equal(chips.live, 24);
    assert.equal(chips.cursor, 23);
    assert.equal(removed.length, 24);
    assert.ok(chips.slots.slice(0, 24).every(s => s.live && s.body.mass === 37));
    chips.setBudget(0);
    assert.equal(chips.live, 0);
    assert.equal(removed.length, 48);
    assert.equal(new Set(removed).size, 48);
    chips.setBudget(0);
    assert.equal(removed.length, 48, 'no duplicate removal');
    // No vectors, palette reads, random draws or bodies are needed at zero budget.
    chips.spawn(null, null, null, null);
    chips.spawnFromCarve(null, null, null, null, 24);
    chips.spawnBurst(null, 100, null, null, null);
    chips.setBudget(100);
    assert.equal(chips.budget, 48);
    assert.equal(matrices.length, 48);
});

function target() {
    return { setSize(w, h) { this.width = w; this.height = h; } };
}

function effects(q, ratio = 1) {
    return Object.assign(Object.create(Vfx.prototype), {
        q,
        renderer: { getPixelRatio: () => ratio },
        sceneTarget: target(), aoTarget: target(), shaftTarget: target(),
        composer: target(), smaaPass: target(), bloomPass: {},
        combinePass: { material: { uniforms: { aoEnabled: { value: 1 }, shaftEnabled: { value: 1 } } } },
    });
}

test('every offscreen pass follows the effective pixel ratio, including DPR and resolution floor', () => {
    for (const dpr of [1, 1.25, 2]) {
        for (const scale of [1, 0.8, 0.6]) {
            const vfx = effects(resolveQuality(), dpr * scale);
            vfx.resize(800, 480);
            const w = Math.floor(800 * dpr * scale);
            const h = Math.floor(480 * dpr * scale);
            assert.deepEqual([vfx.sceneTarget.width, vfx.sceneTarget.height], [w, h]);
            assert.deepEqual([vfx.composer.width, vfx.composer.height], [w, h]);
            assert.deepEqual([vfx.smaaPass.width, vfx.smaaPass.height], [w, h]);
            assert.deepEqual([vfx.aoTarget.width, vfx.aoTarget.height], [Math.floor(w / 2), Math.floor(h / 2)]);
            assert.deepEqual([vfx.shaftTarget.width, vfx.shaftTarget.height], [Math.floor(w / 4), Math.floor(h / 4)]);
        }
    }
    const vfx = effects(resolveQuality(), 0.6);
    vfx.resize(0, 0);
    assert.equal(vfx.sceneTarget.width, 1);
    assert.equal(vfx.aoTarget.height, 1);
});

test('engine applies auto demotion without changing structural simulation or particle/material budgets', () => {
    window.devicePixelRatio = 2;
    const q = resolveQuality();
    const initial = { particles: q.particles, pbr: q.pbr };
    const vfx = effects(q);
    let disposals = 0;
    let resizes = 0;
    const engine = Object.assign(Object.create(Engine.prototype), {
        q, vfx, state: 'playing', _adaptiveQuality: new AdaptiveQuality(q),
        sun: { castShadow: true, shadow: {
            map: { dispose() { disposals++; } },
            mapSize: { set(w, h) { this.width = w; this.height = h; } },
        } },
        renderer: { shadowMap: { enabled: true }, setPixelRatio(ratio) { this.ratio = ratio; } },
        _resize() { resizes++; },
    });
    for (let i = 0; i < 144; i++) engine._updateRenderScale(1 / 12);
    assert.equal(q.renderTier, 'low');
    assert.equal(engine.sun.castShadow, false);
    assert.equal(engine.renderer.shadowMap.enabled, false);
    assert.equal(engine.sun.shadow.mapSize.width, 1024);
    assert.equal(disposals, 1);
    assert.equal(engine.renderer.ratio, 0.6);
    assert.equal(vfx.combinePass.material.uniforms.aoEnabled.value, 0);
    assert.equal(vfx.combinePass.material.uniforms.shaftEnabled.value, 0);
    assert.equal(vfx.smaaPass.enabled, false);
    assert.equal(vfx.bloomPass.enabled, false);
    assert.deepEqual({ particles: q.particles, pbr: q.pbr }, initial);
    assert.equal(q.shrapnel, 0);
    assert.ok(resizes < 15);
    const renderTier = q.renderTier;
    engine.state = 'paused';
    for (let i = 0; i < 120; i++) engine._updateRenderScale(1 / 60);
    assert.equal(q.renderTier, renderTier);
    assert.equal(engine.renderer.ratio, 0.6);
});

test('low render profile skips auxiliary draw passes and preserves the main scene/composer', () => {
    const q = resolveQuality();
    applyRenderTier(q, 'low');
    const calls = [];
    const vfx = effects(q);
    vfx.renderer.setRenderTarget = (t) => calls.push(t ? 'target' : 'screen');
    vfx.renderer.clear = () => {};
    vfx.renderer.render = () => calls.push('scene');
    vfx.composer.render = () => calls.push('composer');
    vfx._renderAo = () => assert.fail('AO should not run');
    vfx._renderShafts = () => assert.fail('shafts should not run');
    vfx.render();
    assert.deepEqual(calls, ['target', 'scene', 'screen', 'composer']);
});
