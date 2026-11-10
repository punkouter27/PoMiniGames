import assert from 'node:assert/strict';
import { test } from 'node:test';

// How a body answers a hit, tested without a renderer: collapse timing, tip direction and the
// body-frame split of an impact. The crowd renderer reads exactly these helpers.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { collapseStage, tipAxes, impactFrame } = await import(new URL('js/pocapitol/collapse.js', client));

test('a torso hit braces before it tips; a head hit folds straight away', () => {
    const early = collapseStage(0.1, 'torso');
    assert.ok(early.brace > 0, 'the body is still catching its weight');
    assert.equal(early.tip, 0, 'nothing has tipped yet');

    const headEarly = collapseStage(0.1, 'head');
    assert.equal(headEarly.brace, 0, 'a head hit gets no bracing');
    assert.ok(headEarly.tip > 0, 'it is already going down');
    assert.ok(headEarly.tip > early.tip);
});

test('a collapse finishes, settles, and never overshoots', () => {
    for (const zone of ['head', 'torso', 'limbs']) {
        const end = collapseStage(5, zone);
        assert.equal(end.p, 1);
        assert.equal(end.tip, 1);
        assert.equal(end.settle, 1);
        assert.ok(Math.abs(end.tipAngle - Math.PI / 2) < 1e-9, 'it ends flat on the ground');
        assert.equal(end.flail, 0, 'a settled body does not twitch');
    }
});

test('the body tips away from the impact, in its own frame', () => {
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    // Struck from behind, straight ahead of it: falls forward, onto its front.
    const forward = tipAxes(0, Math.PI / 2);
    assert.ok(near(forward.fall, -Math.PI / 2) && near(forward.lean, 0));
    // Struck from its left: falls to its right, which is a negative roll.
    const right = tipAxes(Math.PI / 2, Math.PI / 2);
    assert.ok(near(right.fall, 0));
    assert.ok(right.lean < 0);
    // Struck from the front: falls backwards, the pre-existing behaviour.
    const back = tipAxes(Math.PI, Math.PI / 2);
    assert.ok(back.fall > 0 && near(back.lean, 0));
});

test('an impact splits into forward and sideways parts for any heading', () => {
    // A shot travelling +Z hits a figure facing -Z (heading 0) square in the chest.
    const front = impactFrame(0, 1, 0);
    assert.ok(front.fw < 0, 'it arrives from the front');
    assert.ok(Math.abs(front.rt) < 1e-9);
    assert.ok(Math.abs(Math.abs(front.rel) - Math.PI) < 1e-9, 'so the body falls backwards');

    // The same shot on a figure that has turned to face +X arrives from its right.
    const turned = impactFrame(0, 1, -Math.PI / 2);
    assert.ok(Math.abs(Math.abs(turned.rel) - Math.PI / 2) < 1e-9);

    // No direction at all still yields a defined, backward fall.
    const none = impactFrame(0, 0, 0);
    assert.equal(none.rel, Math.PI);
});

test('bad input cannot produce a NaN pose', () => {
    for (const [age, zone] of [[NaN, 'torso'], [-1, 'head'], [0, undefined], [Infinity, 'limbs']]) {
        const stage = collapseStage(age, zone);
        for (const key of ['p', 'ease', 'brace', 'tip', 'settle', 'flail', 'tipAngle']) {
            assert.ok(Number.isFinite(stage[key]), `${key} must be finite for age ${age}`);
        }
        const axes = tipAxes(stage.tipAngle, stage.tipAngle);
        assert.ok(Number.isFinite(axes.fall) && Number.isFinite(axes.lean));
    }
});

test('a head hit reaches the ground sooner than a body hit', () => {
    let headDone = null, torsoDone = null;
    for (let age = 0; age <= 1.5; age += 0.01) {
        if (headDone === null && collapseStage(age, 'head').tip === 1) headDone = age;
        if (torsoDone === null && collapseStage(age, 'torso').tip === 1) torsoDone = age;
    }
    assert.ok(headDone < torsoDone, `head ${headDone}s should beat torso ${torsoDone}s`);
});
