// node --test tests/platform-stage.test.mjs
// The shared 2D/3D game host (platform/stage, platform/2d, platform/3d): loop timing, the
// feature registry, the stage lifecycle, 2D fitting/particles and 3D renderer wiring.
import test from 'node:test';
import assert from 'node:assert/strict';

const P = '../src/PoMiniGames.Client/wwwroot/js/platform/';
const { createLoop } = await import(P + 'stage/loop.js');
const { registerFeature, unregisterFeature, resolveFeatures, defineFeature } = await import(P + 'stage/features.js');
const { createStage } = await import(P + 'stage/stage.js');
const { shakeOffset } = await import(P + 'stage/features/shake.js');
const { fitWorld, viewToWorld } = await import(P + '2d/camera2d.js');
const { createParticles2D } = await import(P + '2d/particles2d.js');
const { damp, springStep } = await import(P + '2d/tween.js');
const { configureRenderer, sizeRenderer, attachRenderer, createRenderer } = await import(P + '3d/renderer.js');
const { disposeObject3D } = await import(P + '3d/dispose.js');

const manualRaf = () => ({ raf: () => 1, caf: () => { } });

test('loop clamps dt and resets the clock on resume', () => {
    const steps = [];
    const loop = createLoop({ ...manualRaf(), maxDt: 0.1, step: (dt) => steps.push(+dt.toFixed(3)) });
    loop.start();
    loop.tick(0); loop.tick(16); loop.tick(5016);        // a 5 s stall is one 0.1 s step
    assert.deepEqual(steps, [0.016, 0.1]);
    loop.setPaused(true); loop.tick(9000);
    loop.setPaused(false); loop.tick(20000); loop.tick(20010);
    assert.deepEqual(steps, [0.016, 0.1, 0.01]);         // no catch-up step for the paused time
});

test('loop fixed step runs an accumulator with a step cap and a time scale', () => {
    let n = 0, scale = 1;
    const loop = createLoop({ ...manualRaf(), fixedStep: 0.01, maxSteps: 5, maxDt: 1, timeScale: () => scale, step: () => n++ });
    loop.start(); loop.tick(0); loop.tick(35);
    assert.equal(n, 3);
    assert.ok(Math.abs(loop.alpha - 0.5) < 1e-6);
    loop.tick(1035);                                     // 1 s backlog: capped at 5
    assert.equal(n, 8);
    scale = 0; loop.tick(1100);                          // hitstop: time frozen
    assert.equal(n, 8);
});

test('features: defaults by kind, use, exclude, ordering', () => {
    const a = registerFeature({ id: 't-any', kind: 'any', order: 5, create: () => ({}) });
    const b = registerFeature({ id: 't-3d', kind: '3d', create: () => ({}) });
    const c = registerFeature({ id: 't-opt', kind: '2d', default: false, create: () => ({}) });
    try {
        const ids2 = resolveFeatures('2d').map((d) => d.id);
        assert.ok(ids2.includes('t-any') && !ids2.includes('t-3d') && !ids2.includes('t-opt'));
        assert.ok(resolveFeatures('3d').map((d) => d.id).includes('t-3d'));
        assert.ok(resolveFeatures('2d', { use: ['t-opt'] }).some((d) => d.id === 't-opt'));
        assert.ok(!resolveFeatures('2d', { exclude: ['t-any'] }).some((d) => d.id === 't-any'));
        assert.throws(() => resolveFeatures('2d', { use: ['t-3d'] }), /3d-only/);
        assert.throws(() => defineFeature({ id: 'x', kind: 'vr', create() { } }), /kind/);
        const order = resolveFeatures('2d').map((d) => d.id);
        assert.ok(order.indexOf('shake') < order.indexOf('t-any'));
    } finally { for (const d of [a, b, c]) unregisterFeature(d.id); }
});

function fakeCtx() {
    const calls = [];
    return {
        calls,
        setTransform: (...a) => calls.push(['T', ...a]),
        save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    };
}
function fakeCanvas(w, h) {
    const ctx = fakeCtx();
    return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx, ctx };
}

test('stage: sizes the canvas through the DPR policy, runs features around render, disposes', () => {
    globalThis.PoCanvasDpr = { resolve: () => 2 };
    const log = [];
    const def = registerFeature({
        id: 't-probe', kind: '2d',
        create: (stage) => ({
            update: () => log.push('update'),
            beforeRender: () => log.push('before'),
            afterRender: () => log.push('after'),
            pause: () => log.push('pause'), resume: () => log.push('resume'),
            dispose: () => log.push(`dispose:${stage.kind}`),
        }),
    });
    try {
        const canvas = fakeCanvas(300, 150);
        const stage = createStage({ kind: '2d', canvas, ...manualRaf(), onFrame: () => stage.render(() => log.push('draw')) });
        assert.equal(canvas.width, 600);
        assert.equal(canvas.height, 300);
        assert.deepEqual([stage.view.sx, stage.view.sy], [2, 2]);
        stage.start(); stage.loop.tick(0); stage.loop.tick(16);
        assert.deepEqual(log.slice(0, 4), ['update', 'before', 'draw', 'after']);
        stage.setPaused(true, 'menu'); stage.setPaused(true, 'hidden'); stage.setPaused(false, 'menu');
        assert.ok(stage.paused);                         // still hidden
        stage.setPaused(false, 'hidden');
        assert.ok(!stage.paused);
        assert.deepEqual(log.filter((x) => x === 'pause' || x === 'resume'), ['pause', 'resume']);
        stage.dispose();
        assert.ok(log.includes('dispose:2d'));
        assert.ok(stage.disposed);
    } finally { unregisterFeature(def.id); delete globalThis.PoCanvasDpr; }
});

test('stage.setTransform folds the backing scale and shake into CSS-px units', () => {
    globalThis.PoCanvasDpr = { resolve: () => 1.5 };
    try {
        const canvas = fakeCanvas(200, 100);
        const stage = createStage({ kind: '2d', canvas, ...manualRaf(), exclude: ['shake'] });
        stage.shake.x = 4; stage.shake.y = -2;
        stage.setTransform(2, 10, 20);
        assert.deepEqual(canvas.ctx.calls.at(-1), ['T', 3, 0, 0, 3, 1.5 * 14, 1.5 * 18]);
        stage.dispose();
    } finally { delete globalThis.PoCanvasDpr; }
});

test('shake: 3D camera is nudged for the render and put back after', () => {
    globalThis.PoImpact = { getShake: () => 0.5 };
    try {
        const pos = { x: 1, y: 2, z: 3, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
        const camera = { position: pos, rotation: { z: 0 } };
        const stage = createStage({ kind: '3d', ...manualRaf() });
        stage.camera = camera;
        stage.start(); stage.loop.tick(0); stage.loop.tick(100);
        let during;
        stage.render(() => { during = { ...pos }; });
        assert.ok(during.x !== 1 || during.y !== 2);
        assert.deepEqual([pos.x, pos.y, pos.z], [1, 2, 3]);
        stage.dispose();
    } finally { delete globalThis.PoImpact; }
    const z = shakeOffset(0, 1);
    assert.deepEqual([z.x, z.y, z.ux], [0, 0, 0]);
});

test('fitWorld letterboxes, bottom-aligns and does integer pixel scale', () => {
    const c = fitWorld(800, 600, 400, 200, { alignY: 'bottom' });
    assert.deepEqual(c, { scale: 2, x: 0, y: 200, w: 800, h: 400 });
    const p = fitWorld(1000, 700, 320, 180, { integer: true });
    assert.equal(p.scale, 3);
    assert.deepEqual(viewToWorld(c, 400, 400), { x: 200, y: 100 });
});

test('particles2d: pooled, tier-capped, decays to nothing', () => {
    const ps = createParticles2D(100);
    ps.setTier('low');                                   // 25 visible slots
    ps.burst(0, 0, { n: 60, life: 0.2, rand: () => 0.5 });
    assert.equal(ps.alive, 25);
    for (let i = 0; i < 30; i++) ps.step(1 / 60);
    assert.equal(ps.alive, 0);
    assert.ok(Math.abs(damp(0, 10, 5, 10) - 10) < 1e-6);
    const s = springStep({ x: 0, v: 0 }, 1, 200, 28, 2);
    assert.ok(Math.abs(s.x - 1) < 0.01);
});

const THREE = {
    ACESFilmicToneMapping: 4, AgXToneMapping: 6, NoToneMapping: 0, SRGBColorSpace: 'srgb', LinearSRGBColorSpace: 'lin',
    PCFSoftShadowMap: 2, PCFShadowMap: 1, VSMShadowMap: 3, BasicShadowMap: 0,
    WebGLRenderer: class {
        constructor(p) { this.params = p; this.shadowMap = {}; this.domElement = { isConnected: true }; }
        setPixelRatio(d) { this.dpr = d; } setSize(w, h) { this.size = [w, h]; }
        dispose() { this.disposed = true; } forceContextLoss() { this.lost = true; }
    },
};

test('3d renderer: one config path, sized with the stage, disposed with it', async () => {
    const r = await createRenderer(THREE, { tone: 'agx', exposure: 1.2, shadows: 'pcfsoft' });
    assert.equal(r.userData.api, 'webgl');
    assert.equal(r.toneMapping, 6);
    assert.equal(r.toneMappingExposure, 1.2);
    assert.equal(r.shadowMap.type, 2);
    configureRenderer(THREE, r, { shadows: false });
    assert.equal(r.shadowMap.enabled, false);

    globalThis.PoCanvasDpr = { resolve: () => 1.25 };
    try {
        const container = { clientWidth: 640, clientHeight: 360 };
        const stage = createStage({ kind: '3d', container, ...manualRaf() });
        const camera = { aspect: 1, updateProjectionMatrix() { this.updated = true; } };
        const composer = { setSize(w, h) { this.size = [w, h]; } };
        attachRenderer(stage, r, { camera, composer });
        assert.equal(r.dpr, 1.25);
        assert.deepEqual(r.size, [640, 360]);
        assert.deepEqual(composer.size, [640, 360]);
        assert.ok(camera.updated && Math.abs(camera.aspect - 16 / 9) < 1e-9);
        assert.equal(stage.camera, camera);
        stage.dispose();
        assert.ok(r.disposed && r.lost);
    } finally { delete globalThis.PoCanvasDpr; }
    const r2 = { setPixelRatio(d) { this.d = d; }, setSize(w, h) { this.s = [w, h]; } };
    sizeRenderer(r2, 10, 20, 2);
    assert.deepEqual([r2.d, r2.s], [2, [10, 20]]);
});

test('disposeObject3D frees shared assets once and every texture slot', () => {
    let tex = 0, geo = 0, mat = 0;
    const t = { isTexture: true, dispose: () => tex++ };
    const g = { dispose: () => geo++ };
    const m = { map: t, normalMap: t, uniforms: { u: { value: { isTexture: true, dispose: () => tex++ } } }, dispose: () => mat++ };
    const kids = [{ geometry: g, material: m }, { geometry: g, material: [m] }];
    const root = { isScene: true, background: t, traverse(fn) { fn(root); kids.forEach(fn); } };
    const r = disposeObject3D(root);
    assert.deepEqual([geo, mat, tex], [1, 1, 2]);
    assert.deepEqual(r, { geometries: 1, materials: 1 });
});
