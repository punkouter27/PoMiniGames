// node --test tests/platform-ui.test.mjs
// Pure pieces of the UI/UX deck ideas: #17 spring micro-interactions, #19 result ceremony
// schedule, #20 preview measurement and stutter rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { springStep, atRest, rubberBand, SPRING } from '../src/PoMiniGames.Client/wwwroot/js/platform/springUi.js';
import { schedule, BEATS } from '../src/PoMiniGames.Client/wwwroot/js/platform/resultCeremony.js';
import {
    percentile, summarize, recommend, shouldRollback, SMOOTH_P95_MS, STUTTER_P95_MS,
} from '../src/PoMiniGames.Client/wwwroot/js/platform/framePacing.js';

test('spring press overshoots on release and settles at rest', () => {
    const s = { x: 0.95, v: 0 };
    let peak = s.x;
    for (let i = 0; i < 240 && !(i > 10 && atRest(s, 1)); i++) {
        springStep(s, 1, 1 / 60, SPRING);
        peak = Math.max(peak, s.x);
    }
    assert.ok(peak > 1, `expected an overshoot past 1, peaked at ${peak}`);
    assert.ok(atRest(s, 1), `expected rest at 1, got x=${s.x} v=${s.v}`);
});

test('a dropped frame cannot launch the spring', () => {
    const s = { x: 0.9, v: 0 };
    springStep(s, 1, 2.5);              // 2.5 s gap is clamped to one 1/30 s step
    assert.ok(s.x <= 1.2 && s.x >= 0.9, `x=${s.x}`);
});

test('drag rubber-bands to a soft maximum', () => {
    assert.equal(rubberBand(0), 0);
    assert.ok(Math.abs(rubberBand(10)) < 6);
    assert.ok(Math.abs(rubberBand(10_000)) <= 6);
    assert.ok(rubberBand(-40) < 0);
});

test('ceremony runs freeze → headline → rank → (record) → action, in order', () => {
    const plain = schedule();
    assert.deepEqual(plain.map((b) => b.beat), ['freeze', 'headline', 'rank', 'action']);
    const best = schedule({ newBest: true });
    assert.deepEqual(best.map((b) => b.beat), BEATS);
    for (const plan of [plain, best]) {
        for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at > plan[i - 1].at);
        assert.ok(plan.at(-1).at <= 1500, 'the whole ceremony stays under 1.5 s');
    }
    assert.ok(schedule({ speed: 2 }).at(-1).at < plain.at(-1).at);
});

test('percentile is nearest-rank and does not mutate', () => {
    const xs = [5, 1, 4, 2, 3];
    assert.equal(percentile(xs, 0.5), 3);
    assert.equal(percentile(xs, 0.95), 5);
    assert.deepEqual(xs, [5, 1, 4, 2, 3]);
    assert.equal(percentile([], 0.95), 0);
});

test('summarize judges smooth, ok and stutter by p95', () => {
    const smooth = Array.from({ length: 300 }, () => 16.7);
    assert.equal(summarize(smooth).verdict, 'smooth');

    const ok = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 28 : 22));
    assert.equal(summarize(ok).verdict, 'ok');

    const stutter = Array.from({ length: 300 }, (_, i) => (i % 8 === 0 ? 60 : 30));
    const s = summarize(stutter);
    assert.equal(s.verdict, 'stutter');
    assert.ok(s.p95 > STUTTER_P95_MS);

    assert.equal(summarize([16, 16]).verdict, 'unknown');
});

test('recommend steps down on stutter and up only with headroom', () => {
    assert.equal(recommend('high', { verdict: 'stutter', p95: 50 }).tier, 'medium');
    assert.equal(recommend('low', { verdict: 'stutter', p95: 50 }).tier, 'low');
    assert.equal(recommend('medium', { verdict: 'smooth', p95: SMOOTH_P95_MS * 0.7 }).tier, 'high');
    assert.equal(recommend('medium', { verdict: 'smooth', p95: SMOOTH_P95_MS }).tier, 'medium');
    assert.equal(recommend('high', { verdict: 'smooth', p95: 10 }).tier, 'high');
    assert.equal(recommend('medium', { verdict: 'unknown', p95: 0 }).tier, 'medium');
});

test('rollback needs two stuttering windows and a lighter stable tier', () => {
    const st = { verdict: 'stutter' }, ok = { verdict: 'smooth' };
    assert.equal(shouldRollback([st, st], 'high', 'medium'), true);
    assert.equal(shouldRollback([ok, st], 'high', 'medium'), false);
    assert.equal(shouldRollback([st], 'high', 'medium'), false);
    assert.equal(shouldRollback([st, st], 'medium', 'high'), false, 'never "rolls back" upward');
    assert.equal(shouldRollback([st, st], 'high', null), false);
});
