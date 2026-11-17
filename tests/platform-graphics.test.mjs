// node --test tests/platform-graphics.test.mjs
// Pure halves of the platform GFX layer (deck ideas #1-#7): render budget, anticipation,
// damage signatures, instanced pools, the light rig, the diegetic board and the fog fallback.
import test from 'node:test';
import assert from 'node:assert/strict';

const P = '../src/PoMiniGames.Client/wwwroot/js/platform/';
const { percentile, createBudgetState, stepBudget, LADDER, TIER_TOP, RenderBudget } = await import(P + 'renderBudget.js');
const { envelope, KINDS, closestApproach, Anticipation } = await import(P + 'anticipation.js');
const { planSignature, hemisphereDir } = await import(P + 'damageSignature.js');
const { tierCap } = await import(P + 'instancedPool.js');
const { PRESETS, blendPresets, lightningEnvelope, wetRoughness, LightRig } = await import(P + 'lightRig.js');
const { formatStandings, boardOnScreen } = await import(P + 'diegeticBoard.js');
const { pushFactor, cardDepths } = await import(P + 'volumetricFog.js');

function feed(state, ms, frames, tier = 'high') {
    const changes = [];
    for (let i = 0; i < frames; i++) {
        const r = stepBudget(state, ms, tier);
        if (r >= 0) changes.push(r);
    }
    return changes;
}

test('#1 percentile reads the hitch, not the mean', () => {
    const v = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40];
    assert.equal(percentile(v, v.length, 0.95), 10);
    assert.equal(percentile(v, v.length, 1), 40);
    const spiky = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 40 : 10));
    assert.equal(percentile(spiky, 100, 0.95), 40);
    assert.equal(percentile([], 0, 0.95), 0);
});

test('#1 budget drops fast, raises slowly, and never above the tier ceiling', () => {
    const s = createBudgetState({ tier: 'high' });
    assert.equal(s.rung, TIER_TOP.high);
    // Slow frames (30 fps): two slow reads (60 frames) drop exactly one rung.
    const down = feed(s, 33, 60);
    assert.deepEqual(down, [TIER_TOP.high - 1]);
    // Fast frames: five reads in a row before one rung comes back.
    const up = feed(s, 8, 30 * 4);
    assert.deepEqual(up, []);
    assert.deepEqual(feed(s, 8, 30), [TIER_TOP.high]);
    // Already at the top: more headroom changes nothing.
    assert.deepEqual(feed(s, 8, 300), []);
    // A lower ceiling applies immediately, without waiting for a read.
    assert.equal(stepBudget(s, 8, 'low'), TIER_TOP.low);
    assert.deepEqual(feed(s, 8, 600, 'low'), []);
    assert.equal(LADDER[s.rung].tier, 'low');
});

test('#1 budget ignores tab-switch frames and bottoms out at 1x pixels with static shadows', () => {
    const s = createBudgetState({ tier: 'medium' });
    assert.deepEqual(feed(s, 5000, 200, 'medium'), []);
    feed(s, 60, 2000, 'medium');
    assert.equal(s.rung, 0);
    assert.equal(LADDER[0].maxDpr, 1);
    assert.equal(LADDER[0].staticShadows, true);
    const b = new RenderBudget({ tier: () => 'medium' });
    b.snapTo('low');
    assert.equal(b.rung.index, TIER_TOP.low);
    assert.ok(b.particleScale <= 1);
});

test('#2 anticipation dips before contact, pops on it, and is gentle when calm', () => {
    const k = KINDS.impact;
    assert.equal(envelope('impact', -k.lead - 1).active, false);
    const early = envelope('impact', -k.lead * 0.8);
    const late = envelope('impact', -k.lead * 0.1);
    assert.ok(late.bloom > early.bloom, 'bloom swells toward contact');
    assert.ok(late.exposure < 1, 'exposure dips before contact');
    const hit = envelope('impact', 10);
    assert.ok(hit.exposure > 1, 'exposure pops on contact');
    assert.equal(envelope('impact', k.hold + 1).active, false);
    const calm = envelope('impact', 10, 1, true);
    assert.equal(calm.exposure, 1, 'no dip/pop under reduce-flashing');
    assert.ok(calm.bloom < hit.bloom);
});

test('#2 closest approach predicts a head-on and ignores a pass', () => {
    const head = closestApproach(0, 0, 10, 0, 20, 0, -10, 0);
    assert.ok(Math.abs(head.t - 1) < 1e-9);
    assert.ok(head.miss < 1e-9);
    assert.equal(head.closing, 20);
    const apart = closestApproach(0, 0, -5, 0, 10, 0, 5, 0);
    assert.ok(apart.t < 0, 'separating cars meet in the past');
    const a = new Anticipation();
    assert.equal(a.arm('impact', { leadMs: 500, strength: 1 }), true);
    assert.equal(a.arm('overtake', { leadMs: 600, strength: 0.5 }), false, 'a weaker later event does not replace it');
});

test('#3 damage signatures follow the material', () => {
    const steel = planSignature('metal', 30, { tier: 'high' });
    const stone = planSignature('stone', 30, { tier: 'high' });
    const dirt = planSignature('dirt', 30, { tier: 'high' });
    assert.ok(steel.sparks > stone.sparks, 'steel throws more sparks');
    assert.equal(steel.decal.kind, 'scorch', 'a hot steel hit scorches');
    assert.equal(stone.decal.kind, 'crack');
    assert.ok(dirt.dust > steel.dust, 'dirt throws dust');
    assert.equal(planSignature('stone', 0.1).decal, null, 'a graze leaves no mark');
    const low = planSignature('stone', 30, { tier: 'low' });
    const total = (p) => p.chips + p.sparks + p.dust + p.drops;
    assert.ok(total(low) < total(stone), 'low tier throws fewer');
    assert.ok(total(stone) <= 48, 'per-hit cap');
});

test('#3 spray directions stay in the hemisphere of the normal', () => {
    const out = [0, 0, 0];
    for (const n of [[0, 1, 0], [1, 0, 0], [0, 0, -1]]) {
        for (let k = 0; k < 50; k++) {
            hemisphereDir(n[0], n[1], n[2], k, 0.9, out);
            assert.ok(Math.abs(Math.hypot(...out) - 1) < 1e-6);
            assert.ok(out[0] * n[0] + out[1] * n[1] + out[2] * n[2] > 0, 'never into the surface');
        }
    }
});

test('#5 pools cap visible instances by tier', () => {
    assert.equal(tierCap(256, 'high'), 256);
    assert.equal(tierCap(256, 'medium'), 153);
    assert.equal(tierCap(256, 'low'), 64);
    assert.equal(tierCap(2, 'low'), 1);
    assert.equal(tierCap(0, 'high'), 0);
});

test('#6 light presets blend, lightning flickers twice, wet goes glossy', () => {
    const mid = blendPresets(PRESETS.sun, PRESETS.moon, 0.5);
    assert.ok(Math.abs(mid.sun - (1 + 0.18) / 2) < 1e-9);
    assert.equal(blendPresets(PRESETS.sun, PRESETS.storm, 1).wet, 1);
    assert.equal(lightningEnvelope(-0.1), 0);
    assert.equal(lightningEnvelope(1), 0);
    assert.ok(lightningEnvelope(0.03) > 0.9, 'first stroke');
    assert.ok(lightningEnvelope(0.1) < lightningEnvelope(0.17), 'dark gap, then the return stroke');
    assert.ok(wetRoughness(0.8, 1) < 0.8 && wetRoughness(0.8, 1) > 0.05);
    assert.equal(wetRoughness(0.8, 0), 0.8);
    // The rig scales the engine's own values and puts them back.
    const sun = { intensity: 3, color: { r: 1, g: 1, b: 1, setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } } };
    const rig = new LightRig({ sun });
    rig.setState('moon', 0);
    rig.update(0.016);
    assert.ok(Math.abs(sun.intensity - 3 * PRESETS.moon.sun) < 1e-9);
    rig.restore();
    assert.equal(sun.intensity, 3);
});

test('#7 board text is formatted for the HUD and visibility is judged from the camera', () => {
    const lines = formatStandings([{ name: 'Ada' }, { name: 'YOU', you: true, gap: 1.23 }, { name: 'Cy', gap: 'LAP' }]);
    assert.deepEqual(lines, ['P1 Ada', 'P2 YOU ◀ +1.2', 'P3 Cy LAP']);
    assert.deepEqual(formatStandings(null), []);
    const board = { x: 0, y: 5, z: 0 }, facing = { x: 0, y: 0, z: 1 };
    assert.equal(boardOnScreen(board, facing, { x: 0, y: 5, z: 30 }, { x: 0, y: 0, z: -1 }), true);
    assert.equal(boardOnScreen(board, facing, { x: 0, y: 5, z: -30 }, { x: 0, y: 0, z: 1 }), false, 'seen from behind');
    assert.equal(boardOnScreen(board, facing, { x: 0, y: 5, z: 30 }, { x: 0, y: 0, z: 1 }), false, 'camera looking away');
    assert.equal(boardOnScreen(board, facing, { x: 0, y: 5, z: 400 }, { x: 0, y: 0, z: -1 }), false, 'too far to read');
});

test('#4 blasts hollow the air and it refills; cards crowd the near field', () => {
    assert.equal(pushFactor(0, 10, 0), 1);
    assert.equal(pushFactor(10, 10, 0), 0);
    assert.ok(pushFactor(0, 10, 5) < pushFactor(0, 10, 1), 'refills over time');
    const d = cardDepths(5, 10, 160);
    assert.equal(d.length, 5);
    assert.equal(d[0], 10);
    assert.ok(Math.abs(d[4] - 160) < 1e-9);
    assert.ok(d[1] - d[0] < d[4] - d[3], 'denser near the camera');
});
