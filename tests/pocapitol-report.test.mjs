import assert from 'node:assert/strict';
import { test } from 'node:test';

// The after-action recorder: what an attempt looked like, sampled once a second and turned
// into one flat object the page can chart, export as CSV, or read out.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { createRecorder, toCsv, toText, toSvg } = await import(new URL('js/pocapitol/report.js', client));

const attempt = (overrides = {}) => ({
    elapsed: 0, milestone: 0, difficulty: 'standard', role: 'raider', demo: false,
    outcome: '', status: 'active', pushes: 3, staggers: 2, harmed: 0, immediate: 0,
    lines: [
        { state: 'holding', integrity: 100, pressure: 0, brokenAt: -1 },
        { state: 'holding', integrity: 100, pressure: 0, brokenAt: -1 },
    ],
    companions: [{ health: 30 }, { health: 30 }, { health: 0 }],
    enemies: [{ health: 10 }, { health: 0 }],
    ...overrides,
});

test('samples once per second and remembers the worst reading', () => {
    const recorder = createRecorder({ labels: ['Pass the barricades', 'Enter the Crypt'] });
    const state = attempt();
    recorder.step(state);                       // t=0
    state.elapsed = 0.6; recorder.step(state);  // too soon
    state.elapsed = 1; state.lines[0].integrity = 72; state.lines[0].pressure = 14.2;
    recorder.step(state);
    state.elapsed = 2; state.lines[0].integrity = 61; state.lines[0].pressure = 9;
    recorder.step(state);

    const report = recorder.build(state);
    assert.equal(report.series.length, 3, 'one sample per whole second, not per frame');
    assert.equal(report.lowestIntegrity, 61);
    assert.equal(report.peakPressure, 14.2);
    assert.equal(report.standing, 2);
    assert.equal(report.police, 1);
});

test('a milestone is recorded once, with its label, at the time it was crossed', () => {
    const recorder = createRecorder({ labels: ['Pass the barricades', 'Enter the Crypt'] });
    const state = attempt();
    recorder.step(state);
    state.elapsed = 12; state.milestone = 1; recorder.step(state);
    state.elapsed = 13; recorder.step(state);
    state.elapsed = 40; state.milestone = 2; recorder.step(state);

    const report = recorder.build(state);
    assert.deepEqual(report.milestones.map(m => m.label), ['Pass the barricades', 'Enter the Crypt']);
    assert.deepEqual(report.milestones.map(m => m.at), [12, 40]);
    assert.equal(report.milestones[0].index, 1);
});

test('the first broken line is reported, or null when every line held', () => {
    const recorder = createRecorder();
    const state = attempt();
    recorder.step(state);
    assert.equal(recorder.build(state).firstBreak, null);

    state.lines[0].brokenAt = 88.3;
    state.lines[1].brokenAt = 61.9;
    recorder.step(state);
    assert.equal(recorder.build(state).firstBreak, 61.9);
});

test('reset clears the attempt so the next one starts empty', () => {
    const recorder = createRecorder();
    const state = attempt();
    state.elapsed = 5; state.lines[0].pressure = 20; state.harmed = 7;
    recorder.step(state);
    recorder.reset();
    state.elapsed = 0; state.harmed = 0; state.lines[0].pressure = 0;
    const report = recorder.build(state);
    assert.equal(report.series.length, 0);
    assert.equal(report.casualties, 0);
    assert.equal(report.peakPressure, 0);
    assert.equal(report.lowestIntegrity, 100);
});

test('the series is capped, so a long attempt cannot grow without bound', () => {
    const recorder = createRecorder({ maxSamples: 4 });
    const state = attempt();
    for (let t = 0; t <= 20; t++) { state.elapsed = t; recorder.step(state); }
    assert.equal(recorder.build(state).series.length, 4);
});

test('CSV has one header and one row per sample; the text report names the outcome', () => {
    const recorder = createRecorder({ labels: ['Pass the barricades'] });
    const state = attempt();
    recorder.step(state);
    state.elapsed = 1; state.milestone = 1; state.outcome = 'doors'; state.status = 'completed';
    recorder.step(state);
    const report = recorder.build(state, { clock: '2:20 PM' });

    const csv = toCsv(report).split('\n');
    assert.equal(csv[0], 'minute,line_integrity,line_pressure,raiders_standing,police_standing,casualties');
    assert.equal(csv.length, 3, 'header plus two samples');

    const text = toText(report);
    assert.match(text, /completed/);
    assert.match(text, /2:20 PM/);
    assert.match(text, /Pass the barricades @ 1s/);
});

test('the chart is a self-contained SVG, and a one-sample attempt has no chart', () => {
    const recorder = createRecorder({ labels: ['Pass the barricades'] });
    const state = attempt();
    recorder.step(state);
    state.elapsed = 1; state.milestone = 1; recorder.step(state);
    state.elapsed = 2; recorder.step(state);
    const report = recorder.build(state);

    const svg = toSvg(report);
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
    assert.match(svg, /viewBox="0 0 640 220"/);
    assert.equal((svg.match(/<polyline/g) ?? []).length, 2, 'integrity and pressure');
    assert.match(svg, /#54a0ff/, 'colours are literal so the PNG export matches the page');
    assert.match(svg, /stroke-dasharray/, 'the milestone tick is drawn');

    const tiny = createRecorder();
    const short = attempt();
    tiny.step(short);
    assert.equal(toSvg(tiny.build(short)), '', 'one point is not a line');
});
