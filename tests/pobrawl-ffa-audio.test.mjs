import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pobrawl/', import.meta.url);
const core = await readFile(new URL('audioCore.js', root), 'utf8');
const coreUrl = `data:text/javascript;base64,${Buffer.from(core).toString('base64')}`;
const source = (await readFile(new URL('ffaAudio.js', root), 'utf8'))
  .replace("'./audioCore.js'", JSON.stringify(coreUrl));
const { FfaAudio, impactParameters, arenaAcoustics, FFA_AUDIO_LIMITS } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Param {
  constructor(value = 0) { this.value = value; this.calls = []; }
  cancelScheduledValues(time) { this.calls.push(['cancel', time]); }
  setValueAtTime(value, time) { this.value = value; this.calls.push(['set', value, time]); }
  setTargetAtTime(value, time, tau) { this.value = value; this.calls.push(['target', value, time, tau]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.calls.push(['linear', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.calls.push(['exp', value, time]); }
}

function fixture() {
  const nodes = [], sources = [], errors = [];
  const node = (kind) => {
    const n = { kind, connections: [], disconnected: false,
      connect(dest) { this.connections.push(dest); return dest; },
      disconnect() { this.connections = []; this.disconnected = true; },
    };
    for (const key of ['gain', 'frequency', 'Q', 'delayTime', 'positionX', 'positionY',
      'positionZ', 'orientationX', 'orientationY', 'orientationZ']) n[key] = new Param();
    if (kind === 'noise' || kind === 'oscillator') {
      n.start = (at = 0) => { n.started = at; };
      n.stop = (at = 0) => { n.stopped = at; };
      n.end = () => n.onended?.();
      sources.push(n);
    }
    nodes.push(n);
    return n;
  };
  const ctx = {
    currentTime: 2, state: 'running', sampleRate: 8000,
    listener: Object.fromEntries(['position', 'forward', 'up'].flatMap((p) =>
      ['X', 'Y', 'Z'].map((axis) => [p + axis, new Param()]))),
    createGain: () => node('gain'),
    createPanner: () => node('panner'),
    createBiquadFilter: () => node('filter'),
    createDelay: () => node('delay'),
    createBufferSource: () => node('noise'),
    createOscillator: () => node('oscillator'),
    createBuffer: (channels, size) => ({
      getChannelData: () => new Float32Array(size), numberOfChannels: channels,
    }),
  };
  let resumed = 0;
  const sfx = node('shared-sfx'), master = node('shared-master');
  sfx.connect(master);
  const bus = {
    ctx, sfxGain: sfx, master, muted: false,
    resume() { resumed++; this.ctx.state = 'running'; return Promise.resolve(); },
    setMuted(value) { this.muted = value; },
  };
  const audio = new FfaAudio(bus, { onError: (e) => errors.push(e) });
  const camera = { position: { x: 0, y: 5, z: 8 }, forward: { z: -1 }, up: { y: 1 } };
  const fighter = (index, x, velocity = { x: 2, y: 0, z: 0 }) => ({
    index, alive: true, position: { x, y: 0, z: 0 }, velocity,
  });
  return { audio, bus, ctx, nodes, sources, errors, camera, fighter, resumed: () => resumed };
}

test('impact energy and materials produce measured synthesis parameters', () => {
  const low = impactParameters(4), high = impactParameters(200);
  assert.ok(high.peak > low.peak);
  assert.ok(high.frequency > low.frequency);
  assert.ok(high.cutoff > low.cutoff);
  assert.ok(high.duration > low.duration);
  assert.equal(impactParameters(-1).peak, 0);
  assert.equal(impactParameters(Infinity).energy, 0);
  assert.equal(impactParameters(500).energy, 250);
  assert.equal(impactParameters(1, 'unknown').material, 'flesh');
  assert.ok(impactParameters(200, 'flesh', true).peak < high.peak);
  assert.equal(new Set(['flesh', 'cloth', 'shoe', 'rope'].map((m) =>
    impactParameters(100, m).cutoff)).size, 4);
  const f = fixture();
  f.audio.update(f.camera, [], 0);
  assert.equal(f.audio.impact({ position: { x: 2, y: 1, z: -3 }, energy: 200, material: 'rope',
    normal: { x: 3, y: 0, z: 0 } }), true);
  const settings = impactParameters(200, 'rope');
  const osc = f.sources.find((n) => n.kind === 'oscillator');
  assert.equal(osc.type, 'triangle');
  assert.deepEqual(osc.frequency.calls[0], ['set', settings.frequency, 2]);
  const envelope = f.nodes.find((n) => n.gain.calls.some((c) => c[0] === 'linear'));
  assert.equal(envelope.gain.calls.find((c) => c[0] === 'linear')[1], settings.peak);
  const panner = f.nodes.find((n) => n.kind === 'panner');
  assert.equal(panner.panningModel, 'HRTF');
  assert.equal(panner.distanceModel, 'inverse');
  assert.equal(panner.positionX.value, 2);
  assert.equal(panner.positionY.value, 1);
  assert.equal(panner.positionZ.value, -3);
  assert.equal(panner.orientationX.value, 1);
  assert.equal(f.audio.stats.lastImpact.energy, 200);
  assert.equal(f.audio.ctx, f.bus.ctx);
  assert.ok(f.audio.output.connections.includes(f.bus.sfxGain));
  osc.end();
  assert.equal(f.audio.stats.voices, 0);
  assert.equal(f.audio.stats.ownedNodes, 1);
  assert.ok(f.nodes.filter((n) => !n.kind.startsWith('shared') && n !== f.audio.output)
    .every((n) => n.disconnected), 'partial graph construction releases every allocated node');
  assert.ok(f.nodes.filter((n) => !['shared-sfx', 'shared-master'].includes(n.kind)
    && n !== f.audio.output).every((n) => n.disconnected));
  f.audio.dispose();
});

test('listener follows rotated camera world orientation and position, including parent transforms', () => {
  const f = fixture();
  let updated = 0;
  f.camera.updateMatrixWorld = () => updated++;
  f.camera.matrixWorld = { elements: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 4, 7, 3, 1] };
  f.audio.update(f.camera);
  assert.equal(updated, 1);
  assert.equal(f.ctx.listener.positionX.value, 4);
  assert.equal(f.ctx.listener.positionY.value, 7);
  assert.equal(f.ctx.listener.positionZ.value, 3);
  assert.equal(f.ctx.listener.forwardX.value, 1);
  assert.equal(f.ctx.listener.upY.value, 1);
  f.camera.matrixWorld.elements[12] = -5;
  f.audio.update(f.camera);
  assert.equal(f.ctx.listener.positionX.value, -5);
  f.audio.dispose();
});

test('nearest moving agents have capped friction; shear rejects normal velocity and scales brightness/level', () => {
  const f = fixture();
  const fighters = Array.from({ length: 16 }, (_, i) => f.fighter(i, i));
  f.audio.update(f.camera, fighters, 0.1);
  assert.equal(f.audio.stats.frictionVoices, FFA_AUDIO_LIMITS.friction);
  assert.deepEqual(f.audio.stats.selectedFighters, [0, 1, 2, 3]);
  const voice = f.audio.friction.get(0);
  const lowGain = voice.shear.gain.gain.value, lowHz = voice.shear.filter.frequency.value;
  fighters[0].velocity.x = 4;
  f.audio.update(f.camera, fighters, 0.1);
  assert.ok(voice.shear.gain.gain.value > lowGain);
  assert.ok(voice.shear.filter.frequency.value > lowHz);
  fighters[0].velocity = { x: 0, y: 10, z: 0 };
  f.audio.update(f.camera, fighters, 0.1);
  assert.equal(f.audio.friction.has(0), false);
  assert.ok(voice.nodes.every((n) => n.disconnected));
  f.camera.position.x = 15;
  f.audio.update(f.camera, fighters, 0.1);
  assert.deepEqual(f.audio.stats.selectedFighters, [15, 14, 13, 12]);
  for (let i = 0; i < 10; i++) f.audio.update(f.camera, fighters, 0.1);
  assert.ok(f.audio.stats.footsteps > 0);
  assert.ok(f.audio.stats.voices <= FFA_AUDIO_LIMITS.impacts);
  f.audio.update(f.camera, [f.fighter(99, 15, { x: 0, y: 0, z: 0 })], 0.1);
  assert.equal(f.audio.stats.frictionVoices, 0);
  f.audio.dispose();
  assert.equal(f.audio.stats.ownedNodes, 0);
});

test('transient voice cap prioritizes nearby events and cleans every stolen/reset source', () => {
  const f = fixture();
  f.audio.update(f.camera);
  for (let i = 0; i < 12; i++) {
    assert.equal(f.audio.impact({ position: { x: 20 + i }, energy: 100 }), true);
  }
  const stolen = [...f.audio.voices].at(-1);
  assert.equal(f.audio.impact({ position: { x: 100 }, energy: 100 }), false);
  assert.equal(f.audio.impact({ position: f.camera.position, energy: 100 }), true);
  assert.equal(f.audio.stats.voices, 12);
  assert.ok(stolen.nodes.every((n) => n.disconnected));
  assert.equal(f.audio.stats.dropped, 2);
  assert.equal(f.audio.stats.peakVoices, 12);
  f.audio.resetRound();
  assert.equal(f.audio.stats.ownedNodes, 0);
  assert.ok(f.nodes.filter((n) => !n.kind.startsWith('shared')).every((n) => n.disconnected));
  assert.equal(f.bus.sfxGain.disconnected, false);
  assert.equal(f.bus.master.disconnected, false);
  assert.equal(f.ctx.state, 'running');
});

test('arena boundary changes actual lowpass, wet reflection gain and travel delay without raytrace claims', () => {
  const centre = arenaAcoustics({ x: 0 }, { x: 8, y: 0, z: 0 });
  const boundary = arenaAcoustics({ x: 4.85 }, { x: 8, y: 0, z: 0 });
  const overhead = arenaAcoustics({ x: 4.85 }, { x: 8, y: 8, z: 0 });
  assert.ok(boundary.cutoff < centre.cutoff);
  assert.ok(boundary.gain < centre.gain);
  assert.ok(boundary.wet > centre.wet);
  assert.equal(overhead.cutoff, 18000);
  const f = fixture();
  f.camera.position = { x: 8, y: 0, z: 0 };
  f.audio.update(f.camera);
  f.audio.impact({ position: { x: 4.85 }, energy: 100 });
  const voice = [...f.audio.voices][0];
  assert.equal(voice.spatial.filter.frequency.value, boundary.cutoff);
  assert.equal(voice.spatial.send.gain.value, boundary.wet);
  assert.equal(voice.spatial.delay.delayTime.value, boundary.delay);
  f.camera.position.y = 8;
  f.audio.update(f.camera);
  assert.equal(voice.spatial.filter.frequency.value, overhead.cutoff);
  f.audio.dispose();
});

test('bus/global mute clears persistent friction and all cues, shared resume and UI action pitches work', async () => {
  const f = fixture();
  f.ctx.state = 'suspended';
  f.audio.update(f.camera, [f.fighter(0, 0)], 0.1);
  assert.equal(f.resumed(), 1);
  await Promise.resolve();
  assert.equal(f.audio.stats.frictionVoices, 1);
  const oldWindow = globalThis.window;
  try {
    let globalMuted = true;
    globalThis.window = { PoAudioBus: { isMuted: () => globalMuted } };
    f.audio.update(f.camera, [f.fighter(0, 0)], 0.1);
    assert.equal(f.audio.stats.ownedNodes, 0);
    assert.equal(f.audio.impact({ energy: 100 }), false);
    assert.equal(f.audio.click('confirm'), false);
    globalMuted = false;
    assert.equal(f.audio.click('confirm'), true);
    const confirm = f.sources.at(-1);
    assert.equal(confirm.frequency.calls[0][1], 740);
    confirm.end();
    assert.equal(f.audio.click('back'), true);
    assert.equal(f.sources.at(-1).frequency.calls[0][1], 620);
    f.audio.setMuted(true);
    assert.equal(f.bus.muted, true);
    assert.equal(f.audio.stats.ownedNodes, 0);
    assert.equal(f.audio.click('toggle'), false);
    f.audio.setMuted(false);
    assert.equal(f.audio.click('toggle'), true);
    f.audio.dispose();
    assert.equal(f.audio.click('confirm'), false);
    assert.equal(f.audio.impact({ energy: 100 }), false);
    assert.equal(f.ctx.state, 'running');
    assert.equal(f.bus.master.disconnected, false);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('unsupported/broken graphs report errors and release partially allocated voices', () => {
  const f = fixture();
  f.ctx.createOscillator = () => { throw new Error('no oscillator'); };
  assert.equal(f.audio.impact({ energy: 100 }), false);
  assert.equal(f.audio.stats.voices, 0);
  assert.equal(f.audio.stats.ownedNodes, 1);
  assert.match(f.errors[0], /no oscillator/);
  assert.ok(f.nodes.filter((n) => !n.kind.startsWith('shared') && n !== f.audio.output)
    .every((n) => n.disconnected), 'failed partial graph releases all its nodes');
  f.audio.dispose();
  const unavailable = new FfaAudio({ ctx: null, resume: () => Promise.resolve() });
  unavailable.update(null, []);
  assert.equal(unavailable.click('confirm'), false);
  unavailable.dispose();
});

test('legacy listener and panner mapping works; contact normal projects shear and disconnected errors stay bounded', () => {
  const f = fixture();
  f.ctx.listener = {
    setPosition(...values) { this.position = values; },
    setOrientation(...values) { this.orientation = values; },
  };
  const createPanner = f.ctx.createPanner;
  f.ctx.createPanner = () => {
    const node = createPanner();
    delete node.positionX;
    node.setPosition = (...values) => { node.position = values; };
    return node;
  };
  const vertical = f.fighter(0, 0, { x: 0, y: 3, z: 0 });
  vertical.contactNormal = { x: 1, y: 0, z: 0 };
  f.audio.update(f.camera, [vertical]);
  assert.deepEqual(f.ctx.listener.position, [0, 5, 8]);
  assert.deepEqual(f.ctx.listener.orientation, [0, 0, -1, 0, 1, 0]);
  assert.equal(f.audio.stats.frictionVoices, 1, 'motion tangent to a vertical contact is shear');
  assert.deepEqual(f.audio.friction.get(0).spatial.panner.position, [0, 0, 0]);
  f.audio.dispose();
  const broken = fixture();
  broken.ctx.createPanner = () => { throw new Error('panner unavailable'); };
  broken.audio.update(broken.camera, [broken.fighter(0, 0)], 0.1);
  assert.equal(broken.audio.stats.ownedNodes, 0);
  assert.ok(broken.nodes.filter((n) => !n.kind.startsWith('shared')).every((n) => n.disconnected));
  assert.match(broken.errors[0], /panner unavailable/);
  broken.audio.dispose();
});
