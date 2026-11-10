import assert from 'node:assert/strict';
import { test } from 'node:test';

// The measurement layer behind inspector telemetry: severity, estimated blood loss, haemorrhage
// class and triage. A coarse model, tested so balance numbers mean something consistent.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { severityOf, bleedRate, bloodVolume, hemorrhageClass, triageFor, createHarm, applyInjury,
    advanceHarm, harmSummary } = await import(new URL('js/pocapitol/harm.js', client));

test('severity ranks zones in the order a medic would', () => {
    const limbs = severityOf({ zone: 'limbs', energy: 100 });
    const torso = severityOf({ zone: 'torso', energy: 100 });
    const head = severityOf({ zone: 'head', energy: 100 });
    assert.ok(limbs < torso, 'torso outranks a limb');
    assert.ok(torso < head, 'head outranks torso');
    assert.ok(head <= 6 && limbs >= 1, 'stays on the 1..6 scale');
});

test('energy raises severity, and a vest lowers it for the body but never the head', () => {
    assert.ok(severityOf({ zone: 'torso', energy: 500 }) > severityOf({ zone: 'torso', energy: 100 }));
    assert.ok(severityOf({ zone: 'torso', energy: 500, armor: 1 }) < severityOf({ zone: 'torso', energy: 500 }));
    assert.equal(severityOf({ zone: 'head', energy: 500, armor: 1 }), severityOf({ zone: 'head', energy: 500 }));
    // Nothing can push it off the ends of the scale.
    for (const energy of [0, 1e6]) for (const armor of [0, 9]) {
        const s = severityOf({ zone: 'head', energy, armor });
        assert.ok(Number.isInteger(s) && s >= 1 && s <= 6);
    }
});

test('bleeding rises with severity and a light injury barely bleeds', () => {
    assert.ok(bleedRate(1) < bleedRate(3));
    assert.ok(bleedRate(3) < bleedRate(6));
    assert.equal(bleedRate(0), 0);
});

test('blood volume follows body mass', () => {
    assert.equal(bloodVolume(70), 4900);
    assert.ok(bloodVolume(100) > bloodVolume(60));
    assert.ok(bloodVolume(undefined) > 0, 'a missing mass still yields a sane volume');
});

test('haemorrhage classes follow the share of volume lost', () => {
    const volume = 5000;
    assert.equal(hemorrhageClass(0, volume), 0);
    assert.equal(hemorrhageClass(300, volume), 1);
    assert.equal(hemorrhageClass(1000, volume), 2);
    assert.equal(hemorrhageClass(1750, volume), 3);
    assert.equal(hemorrhageClass(2500, volume), 4);
});

test('triage escalates on severity and on blood loss', () => {
    assert.equal(triageFor(1, 0), 'Minimal');
    assert.equal(triageFor(3, 0), 'Delayed');
    assert.equal(triageFor(5, 0), 'Immediate');
    assert.equal(triageFor(2, 4), 'Immediate', 'a heavily bleeding minor wound is still immediate');
});

test('a hit is recorded once and keeps the worst zone', () => {
    const harm = createHarm();
    applyInjury(harm, { zone: 'limbs', energy: 100 });
    assert.equal(harm.hits, 1);
    assert.equal(harm.worstZone, 'limbs');
    applyInjury(harm, { zone: 'head', energy: 500 });
    assert.equal(harm.hits, 2);
    assert.equal(harm.worstZone, 'head');
    assert.equal(harm.severity, severityOf({ zone: 'head', energy: 500 }));
    // A later, lesser hit must not lower the recorded severity.
    applyInjury(harm, { zone: 'limbs', energy: 10 });
    assert.equal(harm.worstZone, 'head');
});

test('bleeding accumulates with time and slows once the casualty is down', () => {
    const moving = createHarm(), down = createHarm();
    applyInjury(moving, { zone: 'torso', energy: 500 });
    applyInjury(down, { zone: 'torso', energy: 500 });
    advanceHarm(moving, 30);
    advanceHarm(down, 30, { down: true });
    assert.ok(moving.lossMl > 0);
    assert.ok(down.lossMl > 0);
    assert.ok(down.lossMl < moving.lossMl, 'a body that has stopped loses volume more slowly');
});

test('an unhurt person reports a clean summary and injured ones escalate', () => {    const clean = harmSummary(undefined, 72);
    assert.equal(clean.hits, 0);
    assert.equal(clean.triage, 'Minimal');
    assert.equal(clean.lossMl, 0);

    const harm = createHarm();
    applyInjury(harm, { zone: 'torso', energy: 500 });
    advanceHarm(harm, 600);
    const hurt = harmSummary(harm, 72);
    assert.equal(hurt.hits, 1);
    assert.ok(hurt.lossMl > 0);
    assert.ok(hurt.hemorrhage >= 1, 'ten minutes of untreated bleeding is measurable');
    assert.ok(Number.isInteger(hurt.volumeMl) && hurt.volumeMl > 0);
});

test('the summary carries exactly the fields the inspector telemetry copies', () => {
    const summary = harmSummary(createHarm(), 80);
    for (const key of ['hits', 'severity', 'lossMl', 'hemorrhage', 'triage']) {
        assert.ok(key in summary, `inspector reads ${key}`);
    }
    assert.equal(typeof summary.triage, 'string');
    assert.ok(Number.isInteger(summary.hits));
    assert.ok(Number.isInteger(summary.severity));
    assert.ok(Number.isInteger(summary.lossMl));
    assert.ok(Number.isInteger(summary.hemorrhage));
});
