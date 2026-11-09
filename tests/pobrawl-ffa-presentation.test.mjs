import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/', import.meta.url);
const readSource = (name) => readFile(new URL(name, root), 'utf8');

function moduleContext(source, globals = {}) {
  const body = source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ ...globals });
  return { context, evaluate: (expression) => vm.runInContext(`${body}\n${expression}`, context) };
}

test('FFA renderer applies studio-style rendering, adapts DPR, and releases owned resources', async () => {
  let envDisposed = 0;
  const colorSpace = {};
  const THREE = {
    SRGBColorSpace: colorSpace, AgXToneMapping: 5, PCFSoftShadowMap: 4,
    EquirectangularReflectionMapping: 8,
    CanvasTexture: class {
      dispose() { envDisposed++; }
    },
    PMREMGenerator: class {
      compileEquirectangularShader() {}
      fromEquirectangular() {
        return { texture: {}, dispose() { envDisposed++; } };
      }
      dispose() { envDisposed++; }
    },
  };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      set fillStyle(_value) {},
      createRadialGradient: () => ({ addColorStop() {} }),
    }),
  };
  const renderer = {
    domElement: { parentElement: { clientWidth: 1200, clientHeight: 700 } },
    shadowMap: { enabled: false, type: 0 },
    toneMapping: 0, toneMappingExposure: 1, outputColorSpace: null, ratio: 1,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    setSize(width, height) { this.size = [width, height]; },
    render() { this.frames = (this.frames || 0) + 1; },
  };
  const shadow = { mapSize: { x: 2048, y: 2048, set(x, y) { this.x = x; this.y = y; } }, map: null };
  const key = { castShadow: false, shadow };
  const scene = { environment: null, environmentIntensity: 0, };
  const scope = {
    THREE, Quality: { pixelRatio: () => 1.5 },
    devicePixelRatio: 2,
    document: { createElement: () => canvas },
  };
  const { evaluate } = moduleContext(await readSource('ffaRendering.js'), scope);
  const api = evaluate('({ setup, render, resize, dispose, fighterBuildOptions })');
  const visual = api.setup(scene, renderer, { lights: { key } });

  assert.equal(visual.fighterBuildOptions.physicalMaterials, true);
  assert.equal(api.fighterBuildOptions(false).physicalMaterials, false);
  assert.equal(renderer.shadowMap.enabled, true);
  assert.equal(key.castShadow, true);
  assert.ok(scene.environment, 'the generated arena environment is assigned to the scene');
  api.resize(600, 400);
  assert.deepEqual(renderer.size, [600, 400]);
  const camera = { aspect: 1, updateProjectionMatrix() { this.updated = true; } };
  for (let i = 0; i < 80; i++) api.render(scene, camera, 0.05);
  assert.equal(renderer.frames, 80);
  assert.ok(renderer.ratio < 1.5, 'sustained slow frames lower backing-store DPR');
  assert.ok(camera.updated);
  api.dispose(scene);
  assert.equal(scene.environment, null);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(key.castShadow, false);
  assert.equal(shadow.mapSize.x, 2048);
  assert.ok(envDisposed >= 3, 'PMREM, source texture, and render target are disposed');
});

test('Wikidata date and presidential claim helpers produce only generated structured facts', async () => {
  const source = await readSource('ffaFacts.js');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(module.wikidataDate({ time: '+1946-07-14T00:00:00Z', precision: 11 }), 'Jul 14, 1946');
  assert.equal(module.wikidataDate({ time: '+1789-00-00T00:00:00Z', precision: 9 }), '1789');
  assert.equal(module.ordinalLabel('21'), '21st');
  assert.equal(module.ordinalLabel('13'), '13th');
  const facts = module.buildPresidentFacts({
    id: 'Q123',
    claims: {
      P569: [{ mainsnak: { datavalue: { value: { time: '+1946-07-14T00:00:00Z', precision: 11 } } } }],
      P39: [{
        mainsnak: { datavalue: { value: { id: 'Q11696' } } },
        qualifiers: {
          P1545: [{ datavalue: { value: '45' } }],
          P580: [{ datavalue: { value: { time: '+2017-01-20T00:00:00Z', precision: 11 } } }],
          P582: [{ datavalue: { value: { time: '+2021-01-20T00:00:00Z', precision: 11 } } }],
        },
      }],
    },
  }, 'Donald Trump');
  assert.equal(facts.name, 'Donald Trump');
  assert.match(facts.text, /^Facts from Wikidata/);
  assert.match(facts.text, /Born: Jul 14, 1946/);
  assert.match(facts.text, /45th U\.S\. president/);
  assert.match(facts.sourceUrl, /wikidata\.org\/wiki\/Q123/);
  assert.equal(facts.attribution, 'Facts from Wikidata');
  assert.equal(module.buildPresidentFacts({ id: 'Q1', claims: { P39: [] } }), null);
});

test('facts fetch structured claims, cache a bounded presentation and return cached facts offline', async () => {
  const source = await readSource('ffaFacts.js');
  const { createWikimediaFacts } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const rows = new Map();
  const storage = {
    getItem: (key) => rows.get(key) || null,
    setItem: (key, value) => rows.set(key, value),
  };
  const states = [];
  let requests = 0;
  const fetchImpl = async (url) => {
    requests++;
    const parsed = new URL(url);
    if (parsed.searchParams.get('action') === 'wbsearchentities') {
      return { ok: true, json: async () => ({ search: [{ id: 'Q76', label: 'Barack Obama' }] }) };
    }
    return {
      ok: true,
      json: async () => ({
        entities: {
          Q76: {
            id: 'Q76',
            claims: {
              P569: [{ mainsnak: { datavalue: { value: { time: '+1961-08-04T00:00:00Z', precision: 11 } } } }],
              P39: [{
                mainsnak: { datavalue: { value: { id: 'Q11696' } } },
                qualifiers: { P1545: [{ datavalue: { value: '44' } }] },
              }],
            },
          },
        },
      }),
    };
  };
  const first = createWikimediaFacts({ fetchImpl, storage, onPresentation: (state) => states.push(state) });
  assert.equal(states[0].fact.status, 'off');
  const facts = await first.loadFighter('obama', 'Obama');
  assert.equal(facts.name, 'Barack Obama');
  assert.equal(requests, 1, 'a known fighter uses one entity lookup rather than an ambiguous name search');
  assert.equal(states.at(-1).fact.status, 'ready');
  assert.equal(states.at(-1).fact.name, 'Barack Obama');
  first.dispose();

  const cached = createWikimediaFacts({
    fetchImpl: async () => { throw new Error('cache should prevent a request'); },
    storage,
    onPresentation: (state) => states.push(state),
  });
  assert.equal((await cached.loadFighter('obama')).entityId, 'Q76');
  assert.equal(states.at(-1).fact.status, 'cached');
  cached.dispose();
});

test('disposing the optional facts client aborts an in-flight Wikimedia request', async () => {
  const source = await readSource('ffaFacts.js');
  const { createWikimediaFacts } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const states = [];
  let observedSignal;
  const client = createWikimediaFacts({
    storage: null,
    onPresentation: (state) => states.push(state),
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const pending = client.loadFighter('obama');
  await Promise.resolve();
  assert.equal(observedSignal.aborted, false);
  client.dispose();
  assert.equal(observedSignal.aborted, true);
  assert.equal(await pending, null);
  assert.deepEqual(states.map((state) => state.fact.status), ['off', 'loading']);
});

test('loading a new fact cancels the previous Wikimedia request', async () => {
  const source = await readSource('ffaFacts.js');
  const { createWikimediaFacts } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const signals = [];
  const client = createWikimediaFacts({
    storage: null,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const oldRequest = client.loadFighter('obama');
  await Promise.resolve();
  const newRequest = client.loadFighter('biden');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  client.dispose();
  await Promise.all([oldRequest, newRequest]);
});

test('known FDR resolves to the presidential entity and rate limits honor a cooldown', async () => {
  const source = await readSource('ffaFacts.js');
  const { createWikimediaFacts } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const states = [];
  let entityId;
  const direct = createWikimediaFacts({
    storage: null,
    onPresentation: (state) => states.push(state),
    fetchImpl: async (url) => {
      entityId = new URL(url).searchParams.get('ids');
      return {
        ok: true,
        json: async () => ({
          entities: {
            Q8007: {
              id: 'Q8007',
              claims: {
                P569: [{ mainsnak: { datavalue: { value: { time: '+1882-01-30T00:00:00Z', precision: 11 } } } }],
                P39: [{
                  mainsnak: { datavalue: { value: { id: 'Q11696' } } },
                  qualifiers: { P1545: [{ datavalue: { value: '32' } }] },
                }],
              },
            },
          },
        }),
      };
    },
  });
  const fdrFacts = await direct.loadFighter('fdr', 'FDR');
  assert.equal(entityId, 'Q8007');
  assert.equal(fdrFacts.name, 'Franklin D. Roosevelt');
  assert.match(fdrFacts.text, /32nd U\.S\. president/);
  direct.dispose();

  let now = 1000;
  let calls = 0;
  const statuses = [];
  const limited = createWikimediaFacts({
    now: () => now,
    storage: null,
    onPresentation: (state) => statuses.push(state.fact),
    fetchImpl: async () => {
      calls++;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === 'Retry-After' ? '120' : null },
      };
    },
  });
  assert.equal(await limited.loadFighter('truman'), null);
  assert.match(statuses.at(-1).text, /120 seconds/);
  now += 20_000;
  assert.equal(await limited.loadFighter('truman'), null);
  assert.equal(calls, 1, 'a new round within the cooldown must not retry the rate-limited endpoint');
  assert.equal(statuses.at(-1).status, 'unavailable');
  now += 100_001;
  assert.equal(await limited.loadFighter('truman'), null);
  assert.equal(calls, 2, 'retry becomes eligible after the server cooldown');
  limited.dispose();
  const reenabled = createWikimediaFacts({
    now: () => now,
    storage: null,
    onPresentation: (state) => statuses.push(state.fact),
    fetchImpl: async () => { calls++; return { ok: false, status: 429 }; },
  });
  await reenabled.loadFighter('truman');
  assert.equal(calls, 2, 'disposing and re-enabling facts cannot bypass the in-page cooldown');
  reenabled.dispose();
});

test('automatic highlights retain a rolling clip, publish downloadable URLs, bound clips and clean up', async () => {
  const source = (await readSource('ffaHighlights.js')).replace(/^export /gm, '');
  let now = 1000;
  let recorder;
  let capturedTrack;
  const timers = [];
  const revoked = [];
  const presented = [];
  const created = [];
  class FakeRecorder {
    static isTypeSupported = () => true;
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.blobs = [];
      recorder = this;
    }
    start() { this.state = 'recording'; }
    emit(text) {
      const blob = new Blob([text], { type: this.mimeType });
      this.blobs.push(blob);
      this.ondataavailable?.({ data: blob });
    }
    requestData() { this.emit('tail'); }
    stop() {
      this.emit('final');
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  const urlApi = {
    createObjectURL(blob) { const url = `blob:${created.length + 1}`; created.push({ url, blob }); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const canvas = {
    captureStream(rate) {
      assert.equal(rate, 30);
      capturedTrack = { stop() { this.stopped = true; } };
      return { getTracks: () => [capturedTrack] };
    },
  };
  const { evaluate } = moduleContext(source, {
    Blob, URL: urlApi, MediaRecorder: FakeRecorder,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
    document: undefined,
  });
  const api = evaluate('({ AutomaticHighlights, createAutomaticHighlights })');
  const highlights = api.createAutomaticHighlights(canvas, {
    enabled: false, MediaRecorderClass: FakeRecorder, URLApi: urlApi, BlobClass: Blob,
    now: () => now, setTimer: (callback, delay) => {
      const timer = { callback, delay }; timers.push(timer); return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
    preRollSeconds: 2, postRollSeconds: 1, maxClips: 2,
    rotationSeconds: 5,
    onPresentation: (state) => presented.push(state),
  });
  assert.equal(highlights.setEnabled(true), true);
  recorder.emit('header');
  now += 500;
  recorder.emit('before-ko');
  assert.equal(highlights.mark({ type: 'ko', label: 'KO: Reagan' }), true);
  now += 900;
  recorder.emit('after-ko');
  timers.findLast((timer) => !timer.cancelled && timer.delay === 1000).callback();
  assert.equal(highlights.getClips().length, 1);
  assert.equal(highlights.getClips()[0].label, 'KO: Reagan');
  assert.deepEqual(Array.from(presented.at(-1).recording.clips, (clip) => clip.url), ['blob:1']);
  const clipBlob = created[0].blob;
  assert.match(await clipBlob.text(), /header/);
  assert.match(await clipBlob.text(), /before-ko/);
  assert.match(await clipBlob.text(), /after-ko/);
  assert.match(await clipBlob.text(), /final/);

  for (let i = 0; i < 2; i++) {
    now += 1500;
    recorder.emit(`round-${i}`);
    highlights.mark({ type: 'final', label: `Final ${i}` });
    now += 1100;
    recorder.emit(`end-${i}`);
    timers.findLast((timer) => !timer.cancelled && timer.delay === 1000).callback();
  }
  assert.equal(highlights.getClips().length, 2);
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(presented.at(-1).recording.clips.length, 2);
  highlights.dispose();
  assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3']);
  assert.equal(capturedTrack.stopped, true);
  assert.equal(highlights.getClips().length, 0);
});

test('a rotated rolling segment yields a self-contained clip without prior recorder streams', async () => {
  const source = (await readSource('ffaHighlights.js')).replace(/^export /gm, '');
  let now = 0;
  const recorders = [];
  const timers = [];
  const urls = [];
  class SessionRecorder {
    static isTypeSupported = () => true;
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.index = recorders.length + 1;
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
      this.emit(`EBML-HEADER-SESSION-${this.index}`);
    }
    emit(value) {
      this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) });
    }
    stop() {
      this.emit(`FINAL-SESSION-${this.index}`);
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  const urlApi = {
    createObjectURL(blob) { const url = `blob:session-${urls.length + 1}`; urls.push({ url, blob }); return url; },
    revokeObjectURL() {},
  };
  const { evaluate } = moduleContext(source, {
    Blob,
    MediaRecorder: SessionRecorder,
  });
  const { createAutomaticHighlights } = evaluate('({ createAutomaticHighlights })');
  const capture = createAutomaticHighlights({
    captureStream: () => ({ getTracks: () => [] }),
  }, {
    MediaRecorderClass: SessionRecorder,
    URLApi: urlApi,
    BlobClass: Blob,
    now: () => now,
    rotationSeconds: 8,
    postRollSeconds: 1,
    setTimer(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cancelled = true; },
  });

  recorders[0].emit('OLD-SEGMENT');
  now += 8000;
  timers.find((timer) => !timer.cancelled && timer.delay === 8000).callback();
  assert.equal(recorders.length, 2, 'the completed eight-second stream is replaced with a fresh recorder');
  now += 1500;
  recorders[1].emit('CURRENT-SEGMENT-FRAME');
  assert.equal(capture.mark({ type: 'champion', label: 'Champion' }), true);
  now += 1000;
  assert.equal(timers.at(-1)?.delay, 1000);
  timers.at(-1).callback();

  assert.equal(capture.getClips().length, 1);
  const clip = await urls[0].blob.text();
  assert.match(clip, /^EBML-HEADER-SESSION-2/);
  assert.match(clip, /CURRENT-SEGMENT-FRAME/);
  assert.match(clip, /FINAL-SESSION-2/);
  assert.doesNotMatch(clip, /OLD-SEGMENT|SESSION-1/);
  capture.dispose();
});

test('disabling then re-enabling during recorder stop reuses the stream and disposal stops it once', async () => {
  const source = (await readSource('ffaHighlights.js')).replace(/^export /gm, '');
  const recorders = [];
  const streams = [];
  let stoppedTracks = 0;
  class DeferredStopRecorder {
    static isTypeSupported = () => true;
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['final'], { type: this.mimeType }) });
    }
    completeStop() { this.onstop?.(); }
  }
  const { evaluate } = moduleContext(source, { Blob });
  const { createAutomaticHighlights } = evaluate('({ createAutomaticHighlights })');
  const capture = createAutomaticHighlights({
    captureStream() {
      const stream = { getTracks: () => [{ stop() { stoppedTracks++; } }] };
      streams.push(stream);
      return stream;
    },
  }, {
    MediaRecorderClass: DeferredStopRecorder,
    URLApi: { createObjectURL() {}, revokeObjectURL() {} },
    BlobClass: Blob,
  });

  assert.equal(recorders.length, 1);
  capture.setEnabled(false);
  assert.equal(recorders[0].state, 'inactive');
  assert.equal(stoppedTracks, 0, 'tracks stay live until the recorder stop event finishes');
  assert.equal(capture.setEnabled(true), true);
  assert.equal(recorders.length, 1, 'a stop in flight is reused instead of racing another recorder');
  recorders[0].completeStop();
  assert.equal(recorders.length, 2, 'recording resumes on a fresh canvas stream');
  assert.notEqual(recorders[1].stream, recorders[0].stream, 'each full recording starts with a fresh canvas stream');
  assert.equal(stoppedTracks, 1, 'the completed segment stream was released');
  capture.dispose();
  assert.equal(stoppedTracks, 2);
  assert.equal(capture.enabled, false);
});

test('automatic highlights report unsupported capture and do not start a recorder', async () => {
  const source = (await readSource('ffaHighlights.js')).replace(/^export /gm, '');
  const statuses = [];
  const { evaluate } = moduleContext(source, { URL, Blob, MediaRecorder: undefined });
  const { createAutomaticHighlights } = evaluate('({ createAutomaticHighlights })');
  const capture = createAutomaticHighlights({}, {
    onPresentation: (state) => statuses.push(state.recording),
  });
  assert.equal(capture.supported, false);
  assert.equal(capture.setEnabled(true), false);
  assert.equal(statuses.at(-1).supported, false);
  assert.match(statuses.at(-1).status, /not supported/i);
  capture.dispose();
});

test('automatic highlights start by default when supported and can still be explicitly disabled', async () => {
  const source = (await readSource('ffaHighlights.js')).replace(/^export /gm, '');
  class FakeRecorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    mimeType = 'video/webm';
    constructor() {}
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const { evaluate } = moduleContext(source, {
    URL, Blob,
    MediaRecorder: FakeRecorder,
  });
  const { createAutomaticHighlights } = evaluate('({ createAutomaticHighlights })');
  const canvas = { captureStream: () => ({ getTracks: () => [] }) };
  const enabled = createAutomaticHighlights(canvas, {
    MediaRecorderClass: FakeRecorder,
    URLApi: { createObjectURL() {}, revokeObjectURL() {} },
    BlobClass: Blob,
  });
  assert.equal(enabled.enabled, true);
  enabled.dispose();
  const disabled = createAutomaticHighlights(canvas, {
    enabled: false,
    MediaRecorderClass: FakeRecorder,
    URLApi: { createObjectURL() {}, revokeObjectURL() {} },
    BlobClass: Blob,
  });
  assert.equal(disabled.enabled, false);
  disabled.dispose();
});
