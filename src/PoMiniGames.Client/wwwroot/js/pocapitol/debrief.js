/**
 * The after-action debrief: two or three plain sentences about the attempt that just ended.
 *
 * A small inference router picks who writes them:
 *
 *   rules   Built in, instant, free, nothing leaves the page. Always available and always the
 *           fallback, so a debrief can never fail to appear.
 *   ollama  A model on the player's own machine (http://localhost:11434). Free and private, but
 *           slow to start and only there if the player runs it. Opt-in.
 *   browser A small model run inside this page by Transformers.js on ONNX Runtime Web (WebGPU when
 *           the browser has it, WASM otherwise). Opt-in: the first use downloads about 120 MB of
 *           weights from Hugging Face, which the browser then keeps; nothing is sent anywhere,
 *           the report never leaves the page. A model that small cannot be trusted with figures
 *           (in testing it swapped the crowd and police counts), so it writes only an opening
 *           line with no numbers in it, and the figures follow word for word from the built-in
 *           writer. A line with a digit in it is refused like any other failure.
 *
 * There is deliberately no cloud provider: this app ships no paid AI boundary, and the debrief
 * is not worth one. `PROVIDERS` is the one place a new backend would be added.
 *
 * Every result carries its own telemetry (provider, model, milliseconds, tokens, tokens per
 * second, retries, whether it fell back and why) so the page can show what actually ran.
 *
 * Pure apart from the injected `fetch` and clock: no DOM and no storage.
 */
export const DEFAULT_ENDPOINT = 'http://localhost:11434';
export const DEFAULT_MODEL = 'llama3.2';
/** The in-page model: SmolLM2 135M Instruct (Apache-2.0), ONNX weights published with the model. */
export const BROWSER_MODEL = 'HuggingFaceTB/SmolLM2-135M-Instruct';

let generatorLoading = null;
/** Transformers.js (the import map's `transformers` entry) and the model, loaded once per page. */
function loadBrowserGenerator(onProgress) {
    generatorLoading ??= (async () => {
        const { pipeline, env } = await import('transformers');
        env.allowLocalModels = false;
        const webgpu = Boolean(globalThis.navigator?.gpu && await globalThis.navigator.gpu.requestAdapter().catch(() => null));
        return pipeline('text-generation', BROWSER_MODEL, {
            device: webgpu ? 'webgpu' : 'wasm', dtype: webgpu ? 'q4f16' : 'q4',
            progress_callback: onProgress,
        });
    })().catch(error => { generatorLoading = null; throw error; });
    return generatorLoading;
}
const MAX_CHARS = 600;

const OUTCOMES = {
    doors: 'the crowd reached the House chamber doors and found them barricaded',
    curfew: 'the lines held until the 6:00 pm curfew',
    overcome: 'the player was worn down and pulled out',
    dispersed: 'the crowd was spent before it reached the doors',
};

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The built-in writer. Deterministic: the same report always reads the same way. */
export function ruleDebrief(report) {
    const r = report ?? {};
    const who = r.mode === 'demo' ? 'The armed demo' : r.role === 'police' ? 'The police-line attempt'
        : r.role === 'observer' ? 'The observed attempt' : 'The attempt';
    const ended = OUTCOMES[r.outcome] ?? 'it ended';
    const when = r.clock ? ` at ${r.clock}` : '';
    const crossed = Array.isArray(r.milestones) ? r.milestones.length : Number(r.milestones) || 0;
    const lines = [`${who} ended${when}: ${ended}.`];
    const broke = r.firstBreak === null || r.firstBreak === undefined || r.firstBreak < 0
        ? 'No police line broke'
        : `The first police line broke after ${Math.round(r.firstBreak)} seconds`;
    lines.push(`${broke}; the weakest line fell to ${r.lowestIntegrity ?? 100}% under a peak pressure of ${r.peakPressure ?? 0}, and the crowd crossed ${plural(crossed, 'milestone')}.`);
    const harm = (r.casualties ?? 0) > 0
        ? `${plural(r.casualties, 'casualty', 'casualties')} (${r.immediate ?? 0} immediate)`
        : 'no casualties';
    lines.push(`${r.standing ?? 0} of the crowd and ${r.police ?? 0} police were still standing, with ${harm} recorded.`);
    return lines.join(' ');
}

/** What a model is asked. The numbers are the whole brief: it is told to add nothing to them. */
export function buildPrompt(report) {
    return [
        'You are writing a short after-action note for a fictional crowd simulation game.',
        'Write exactly three plain sentences in a neutral, factual tone.',
        'Use only the figures below. Do not invent events, names or dialogue. Do not praise or',
        'encourage either side, and do not describe injuries. No headings, lists or markdown.',
        '',
        ruleDebrief(report),
    ].join('\n');
}

/** What the in-page model is asked: one opening line in words, the figures stay out of its hands. */
export function buildHeadlinePrompt(report) {
    return [
        'Write one short, neutral opening sentence for an after-action note about a fictional crowd simulation game.',
        'Do not use any numbers or digits. Do not invent names, events or dialogue. Do not praise either side or describe injuries.',
        '',
        ruleDebrief(report),
    ].join('\n');
}

/** The first sentence of a reply, with its full stop. */
export function firstSentence(text) {
    const match = /^(.{12,220}?[.!?])(\s|$)/.exec(text ?? '');
    return match ? match[1] : '';
}

/** Model output is untrusted text: one paragraph, no markup, bounded length. */
export function cleanText(raw) {
    const text = String(raw ?? '').replace(/<[^>]*>/g, ' ').replace(/[*_#`>]+/g, '').replace(/\s+/g, ' ').trim();
    if (text.length <= MAX_CHARS) return text;
    const cut = text.slice(0, MAX_CHARS);
    const stop = cut.lastIndexOf('. ');
    return stop > 120 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const isModel = value => typeof value === 'string' && /^[\w.:\/-]{1,60}$/.test(value);

/**
 * @param {{ fetch?: typeof fetch, now?: () => number, endpoint?: string, timeoutMs?: number, retries?: number }} options
 */
export function createDebriefRouter({
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    endpoint = DEFAULT_ENDPOINT, timeoutMs = 25000, retries = 1,
    loadGenerator = loadBrowserGenerator, onProgress = null,
} = {}) {
    let last = null;

    async function call(path, body, limit) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), limit);
        try {
            const response = await fetchImpl(`${endpoint}${path}`, body
                ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal }
                : { signal: abort.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } finally { clearTimeout(timer); }
    }

    const PROVIDERS = {
        rules: {
            label: 'Built-in', local: true,
            async write(report) { return { text: ruleDebrief(report), model: 'rules', tokens: 0, tokensPerSecond: 0 }; },
        },
        ollama: {
            label: 'Local model', local: true,
            async write(report, { model }) {
                const body = {
                    model, prompt: buildPrompt(report), stream: false,
                    options: { temperature: 0.2, num_predict: 200 },
                };
                // Reasoning models spend the whole token budget thinking and answer with nothing
                // unless told not to. A runtime too old to know the flag rejects it, so it is
                // dropped and the request sent once more as it stands.
                let data;
                try { data = await call('/api/generate', { ...body, think: false }, timeoutMs); }
                catch (error) {
                    if (error?.message !== 'HTTP 400') throw error;
                    data = await call('/api/generate', body, timeoutMs);
                }
                const text = cleanText(data?.response);
                if (!text) throw new Error('The model returned nothing.');
                const tokens = Number(data.eval_count) || 0;
                // eval_duration is nanoseconds of generation only, so this is the model's real pace.
                const seconds = (Number(data.eval_duration) || 0) / 1e9;
                return { text, model, tokens, tokensPerSecond: seconds > 0 ? Math.round(tokens / seconds * 10) / 10 : 0 };
            },
        },
        browser: {
            label: 'In-browser model', local: true,
            async write(report) {
                // The download is the slow part and happens once; it has no timeout of its own.
                const generate = await loadGenerator(onProgress);
                const started = now();
                const messages = [{ role: 'user', content: buildHeadlinePrompt(report) }];
                const output = await generate(messages, { max_new_tokens: 40, do_sample: false, return_full_text: false });
                const reply = output?.[0]?.generated_text;
                const headline = firstSentence(cleanText(Array.isArray(reply) ? reply.at(-1)?.content : reply));
                if (!headline) throw new Error('The model returned nothing.');
                if (/\d/.test(headline)) throw new Error('The model put figures in its line.');
                const tokens = Math.round(headline.length / 4);
                const text = cleanText(`${headline} ${ruleDebrief(report)}`);
                const seconds = (now() - started) / 1000;
                return { text, model: BROWSER_MODEL, tokens, tokensPerSecond: seconds > 0 ? Math.round(tokens / seconds * 10) / 10 : 0 };
            },
        },
    };

    return {
        providers: () => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, local: p.local })),

        /** Is a local model answering, and which ones does it have? Never throws. */
        async probe() {
            if (!fetchImpl) return { available: false, models: [], error: 'No network access in this browser.' };
            try {
                const data = await call('/api/tags', null, 2500);
                return { available: true, models: (data?.models ?? []).map(m => String(m.name)).filter(isModel) };
            } catch (error) {
                return { available: false, models: [], error: String(error?.message ?? error) };
            }
        },

        /**
         * Write the debrief. `provider` is what the player asked for; the result says what
         * actually ran. A provider that fails is retried, then the built-in writer takes over.
         */
        async write(report, { provider = 'rules', model = DEFAULT_MODEL } = {}) {
            const started = now();
            const wanted = PROVIDERS[provider] && fetchImpl ? provider : 'rules';
            const chosen = isModel(model) ? model : DEFAULT_MODEL;
            let attempts = 0, error = '';
            if (wanted !== 'rules') {
                for (; attempts <= retries; attempts++) {
                    try {
                        const out = await PROVIDERS[wanted].write(report, { model: chosen });
                        last = { ...out, provider: wanted, ms: Math.round(now() - started), retries: attempts, fallback: false, error: '' };
                        return last;
                    } catch (failure) {
                        error = failure?.name === 'AbortError' ? 'Timed out.' : String(failure?.message ?? failure);
                    }
                }
            }
            const out = await PROVIDERS.rules.write(report);
            last = {
                ...out, provider: 'rules', ms: Math.round(now() - started),
                retries: Math.max(0, attempts - 1), fallback: wanted !== 'rules', error,
            };
            return last;
        },

        last: () => last,
    };
}
