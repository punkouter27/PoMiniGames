// node --test tests/platform-physics.test.mjs
// The shared physics-feel helpers (GFX/Physics/Audio deck ideas #8-#12): impulse coupling,
// ragdoll settle math, directed debris, soft chains and interest management. All pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromImpulse, impulseImpact } from '../src/PoMiniGames.Client/wwwroot/js/platform/feelPresets.js';
import {
    crossfadeWeight, recoveryWeight, settleAlpha, clampSwingTwist, angleBetween, createSettler, biasToward,
} from '../src/PoMiniGames.Client/wwwroot/js/platform/ragdollBlend.js';
import { spawnBatch, createDebrisField, mulberry32 } from '../src/PoMiniGames.Client/wwwroot/js/platform/debrisField.js';
import { createSoftGrid, createChain, VERTEX_WAVE_GLSL } from '../src/PoMiniGames.Client/wwwroot/js/platform/softChain.js';
import { classify, shouldStep, stepDt, createInterest, LEVEL } from '../src/PoMiniGames.Client/wwwroot/js/platform/simInterest.js';

test('#8 impulse maps to one rising profile; reduced motion zeroes motion but keeps recoil', () => {
    const graze = fromImpulse(1, { x: 2, y: 0, z: 0 }, { reduced: false });
    const ko = fromImpulse(60, { x: 2, y: 0, z: 0 }, { reduced: false });
    assert.equal(graze.kind, 'whiff');
    assert.equal(ko.kind, 'ko');
    assert.equal(ko.impactKind, 'heavy');
    assert.ok(ko.shake.amp > graze.shake.amp);
    assert.ok(ko.hitstopMs > graze.hitstopMs);
    assert.ok(ko.radialBlur > 0 && graze.radialBlur === 0);
    assert.ok(ko.crowdRecoil > graze.crowdRecoil);
    assert.deepEqual(ko.dir, { x: 1, y: 0, z: 0 });

    const calm = fromImpulse(60, null, { reduced: true });
    assert.equal(calm.shake.amp, 0);
    assert.equal(calm.hitstopMs, 0);
    assert.equal(calm.radialBlur, 0);
    assert.ok(calm.crowdRecoil > 0 && calm.crowdRecoil < ko.crowdRecoil);
    assert.equal(calm.dir, null);
});

test('#8 impulseImpact arms a camera target without lowering an existing shake', () => {
    const cam = { shakeT: 0.5, shakeAmp: 0 };
    const prof = impulseImpact(40, { x: 0, z: 1 }, { target: cam, dom: false, reduced: false });
    assert.equal(cam.shakeT, 0.5);              // kept the longer one
    assert.equal(cam.shakeAmp, prof.shake.amp);
});

test('#9 crossfade and recovery weights run 0→1 and 1→0', () => {
    assert.equal(crossfadeWeight(0), 0);
    assert.equal(crossfadeWeight(1), 1);
    assert.ok(crossfadeWeight(0.06) > 0 && crossfadeWeight(0.06) < 1);
    assert.equal(recoveryWeight(0), 1);
    assert.equal(recoveryWeight(10), 0);
    assert.ok(settleAlpha(0) < settleAlpha(0.8) && settleAlpha(5) === 1);
});

test('#9 swing-twist clamp respects the cone and leaves in-range rotations alone', () => {
    const axis = { x: 0, y: 1, z: 0 };
    // 90° swing about X: past a 30° cone.
    const h = Math.PI / 4;
    const q = { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) };
    const out = clampSwingTwist(q, axis, Math.PI / 6, Math.PI / 6);
    assert.ok(Math.abs(angleBetween(out, { x: 0, y: 0, z: 0, w: 1 }) - Math.PI / 6) < 1e-6);
    // 10° twist about the bone: inside limits, unchanged.
    const t = (10 * Math.PI) / 180 / 2;
    const small = { x: 0, y: Math.sin(t), z: 0, w: Math.cos(t) };
    const kept = clampSwingTwist(small, axis, 1, 1);
    assert.ok(angleBetween(kept, small) < 1e-6);
});

test('#9 settler follows moving bodies exactly and damps jitter on still ones', () => {
    const s = createSettler();
    const a = { x: 0, y: 0, z: 0, w: 1 };
    s.apply('k', a, 0);
    const h = 0.1;
    const jitter = { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) };
    s.apply('k', jitter, 0);                    // still: only part of the jitter shows
    assert.ok(angleBetween(jitter, a) < 0.2 * 0.1 * 2 + 1e-6);
    const moved = { x: Math.sin(0.5), y: 0, z: 0, w: Math.cos(0.5) };
    const copy = { ...moved };
    s.apply('k', moved, 10);                    // moving: exact
    assert.ok(angleBetween(moved, copy) < 1e-9);
    const rest = { x: 0, y: 0, z: 0, w: 1 };
    const q = { ...copy };
    biasToward(q, rest, 0);
    assert.ok(angleBetween(q, rest) < angleBetween(copy, rest));
});

test('#10 debris is seeded, follows the blast direction and carries parent momentum', () => {
    const o = { origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 }, impulse: 50, material: 'wood', count: 24, seed: 7, lift: 0 };
    const a = spawnBatch(o), b = spawnBatch(o);
    assert.deepEqual(a, b);
    const meanVx = a.reduce((s, c) => s + c.vx, 0) / a.length;
    assert.ok(meanVx > 0 && a.every((c) => c.vx > 0), 'every chunk heads down-blast');
    const moving = spawnBatch({ ...o, parentVelocity: { x: 0, y: 0, z: 5 } });
    const meanVz = moving.reduce((s, c) => s + c.vz, 0) / moving.length;
    assert.ok(meanVz > 4, `parent momentum carried, got ${meanVz}`);
    // Denser material, same impulse: slower chunks.
    const stone = spawnBatch({ ...o, material: 'stone' });
    const sp = (arr) => arr.reduce((s, c) => s + Math.hypot(c.vx, c.vy, c.vz), 0) / arr.length;
    assert.ok(sp(stone) < sp(a));
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

test('#10 debris field keeps its count/age budget, culls off-view and merges rest piles', () => {
    const removed = [];
    const f = createDebrisField({ maxCount: 10, maxAge: 2, onRemove: (c) => removed.push(c) });
    f.add(spawnBatch({ dir: { x: 0, y: 1, z: 0 }, impulse: 5, count: 8, seed: 1 }));
    f.add(spawnBatch({ dir: { x: 0, y: 1, z: 0 }, impulse: 5, count: 8, seed: 2 }));
    assert.equal(f.count, 10);
    assert.equal(removed.length, 6);
    for (let i = 0; i < 60; i++) f.step(1 / 60, () => true);
    assert.ok(f.count < 10, 'resting neighbours merged');
    for (let i = 0; i < 200; i++) f.step(1 / 60);
    assert.equal(f.count, 0, 'everything aged out');

    const g = createDebrisField();
    g.add(spawnBatch({ dir: { x: 1, y: 0, z: 0 }, impulse: 20, count: 4, seed: 3 }));
    g.step(0.3, () => false);
    assert.equal(g.count, 0, 'left the view after the grace period');
});

test('#11 soft grid keeps its length, swings on impulse and settles back to rest', () => {
    const c = createChain({ count: 8, length: 2, memory: 0.08 });
    const o = { x: 0, y: 0, z: 0 };
    c.impulse(0, 0, 6);
    let peak = 0;
    for (let i = 0; i < 30; i++) { c.step(1 / 60); peak = Math.max(peak, c.energy()); }
    assert.ok(peak > 0.05, 'the kick moved it');
    assert.equal(c.offset(0, o).z, 0, 'the pinned end never moves');
    for (let i = 0; i < 600; i++) c.step(1 / 60);
    assert.ok(c.energy() < 0.02, `shape memory brought it back, energy ${c.energy()}`);

    const grid = createSoftGrid({ cols: 5, rows: 13, width: 2.2, height: 4 });
    assert.equal(grid.N, 65);
    grid.setForce(0, 0, 3);
    for (let i = 0; i < 120; i++) grid.step(1 / 60);
    assert.ok(grid.offset(64, o).z > grid.offset(5, o).z, 'the free bottom swings more than the top');
    assert.match(VERTEX_WAVE_GLSL, /vec3 poSoftWave\(/);
});

test('#12 interest: deterministic bodies are always full; far still ones sleep', () => {
    assert.equal(classify({ distance: 999, visible: false, speed: 0, deterministic: true }), LEVEL.FULL);
    assert.equal(classify({ distance: 2, visible: false }), LEVEL.FULL);
    assert.equal(classify({ distance: 20, visible: true, speed: 1 }), LEVEL.FULL);
    assert.equal(classify({ distance: 20, visible: true, speed: 0 }), LEVEL.REDUCED);
    assert.equal(classify({ distance: 20, visible: false, speed: 1 }), LEVEL.REDUCED);
    assert.equal(classify({ distance: 20, visible: false, speed: 0 }), LEVEL.DORMANT);
    assert.equal(classify({ distance: 99, visible: true, speed: 0 }), LEVEL.DORMANT);

    // Reduced bodies alternate, staggered by id, and catch up with 2 × dt.
    assert.notEqual(shouldStep(LEVEL.REDUCED, 4, 0), shouldStep(LEVEL.REDUCED, 4, 1));
    assert.equal(stepDt(LEVEL.REDUCED, 0.5), 1);
    assert.equal(shouldStep(LEVEL.DORMANT, 0, 0), false);

    const im = createInterest();
    let simulated = 0;
    for (let f = 0; f < 10; f++) {
        im.begin();
        simulated += im.step(0, { distance: 20, visible: true, speed: 0 }, 0.1);
    }
    assert.ok(Math.abs(simulated - 1) < 1e-9, 'reduced still covers all simulated time');
    assert.deepEqual(im.stats(), { full: 0, reduced: 1, dormant: 0 });
});
