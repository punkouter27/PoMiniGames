import assert from 'node:assert/strict';
import { test } from 'node:test';

// The after-action debrief router: the built-in writer, the opt-in local model, and the
// telemetry each result carries. No network: fetch is injected.
const client = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { createDebriefRouter, ruleDebrief, buildPrompt, cleanText, DEFAULT_MODEL } =
    await import(new URL('js/pocapitol/debrief.js', client));

const report = {
    mode: 'solo', role: 'raider', difficulty: 'standard', outcome: 'curfew', status: 'failed', clock: '6:00 PM',
    standing: 301, police: 39, casualties: 4, immediate: 1, lowestIntegrity: 22, peakPressure: 18.4,
    firstBreak: 96.2, milestones: [{ index: 1 }, { index: 2 }],
};
const json = body => ({ ok: true, status: 200, json: async () => body });

test('the built-in writer is deterministic and states only what the report holds', () => {
    const text = ruleDebrief(report);
    assert.equal(text, ruleDebrief(report));
    assert.match(text, /6:00 PM/);
    assert.match(text, /2 milestones/);
    assert.match(text, /4 casualties \(1 immediate\)/);
    assert.match(text, /after 96 seconds/);
    assert.match(ruleDebrief({ ...report, firstBreak: null, casualties: 0, milestones: 1 }), /No police line broke.*1 milestone\b.*no casualties/s);
    assert.match(ruleDebrief({}), /ended/, 'an empty report still reads as a sentence');
});

test('the default provider never touches the network', async () => {
    let calls = 0;
    const router = createDebriefRouter({ fetch: async () => { calls++; throw new Error('no'); } });
    const result = await router.write(report);
    assert.equal(calls, 0);
    assert.deepEqual([result.provider, result.fallback, result.retries, result.tokens], ['rules', false, 0, 0]);
    assert.equal(result.text, ruleDebrief(report));
});

test('a local model writes the debrief and reports its own pace', async () => {
    const seen = [];
    const router = createDebriefRouter({
        fetch: async (address, init) => {
            seen.push([address, JSON.parse(init.body)]);
            return json({ response: '**The lines held.** <b>Two</b> milestones were crossed.', eval_count: 40, eval_duration: 2e9 });
        },
    });
    const result = await router.write(report, { provider: 'ollama', model: 'qwen2.5:3b' });
    assert.equal(seen[0][0], 'http://localhost:11434/api/generate');
    assert.equal(seen[0][1].model, 'qwen2.5:3b');
    assert.equal(seen[0][1].stream, false);
    assert.equal(seen[0][1].think, false, 'a reasoning model must be told to answer, not think');
    assert.equal(seen[0][1].prompt, buildPrompt(report));
    assert.equal(result.provider, 'ollama');
    assert.equal(result.text, 'The lines held. Two milestones were crossed.', 'markup is stripped from model output');
    assert.deepEqual([result.tokens, result.tokensPerSecond, result.retries, result.fallback], [40, 20, 0, false]);
    assert.deepEqual(router.last(), result);
});

test('a failing local model is retried once, then the built-in writer takes over and says why', async () => {
    let calls = 0;
    const router = createDebriefRouter({ fetch: async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; } });
    const result = await router.write(report, { provider: 'ollama', model: 'not a model!' });
    assert.equal(calls, 2, 'one try and one retry');
    assert.deepEqual([result.provider, result.fallback, result.retries, result.error], ['rules', true, 1, 'HTTP 404']);
    assert.equal(result.text, ruleDebrief(report));

    let second = 0;
    const flaky = createDebriefRouter({
        fetch: async () => ++second === 1 ? Promise.reject(new Error('connection refused')) : json({ response: 'Recovered.', eval_count: 3, eval_duration: 1e9 }),
    });
    const recovered = await flaky.write(report, { provider: 'ollama' });
    assert.deepEqual([recovered.provider, recovered.retries, recovered.fallback, recovered.model], ['ollama', 1, false, DEFAULT_MODEL]);
});

test('probing a local runtime never throws and lists only usable model names', async () => {
    const up = createDebriefRouter({ fetch: async () => json({ models: [{ name: 'llama3.2:latest' }, { name: '<script>' }] }) });
    assert.deepEqual(await up.probe(), { available: true, models: ['llama3.2:latest'] });
    const down = await createDebriefRouter({ fetch: async () => { throw new Error('refused'); } }).probe();
    assert.equal(down.available, false);
    assert.match(down.error, /refused/);
});

test('model output is bounded to one short paragraph', () => {
    const long = cleanText('Sentence one is here. '.repeat(60));
    assert.ok(long.length <= 600);
    assert.ok(long.endsWith('.'));
    assert.equal(cleanText('  a\n\n b  '), 'a b');
    assert.equal(cleanText(null), '');
});

test('a runtime that rejects the thinking flag is asked again without it', async () => {
    const bodies = [];
    const router = createDebriefRouter({
        fetch: async (address, init) => {
            const body = JSON.parse(init.body);
            bodies.push(body);
            return 'think' in body ? { ok: false, status: 400, json: async () => ({}) } : json({ response: 'Done.', eval_count: 2, eval_duration: 1e9 });
        },
    });
    const result = await router.write(report, { provider: 'ollama' });
    assert.equal(bodies.length, 2);
    assert.equal('think' in bodies[1], false);
    assert.deepEqual([result.provider, result.text, result.retries, result.fallback], ['ollama', 'Done.', 0, false]);
});
