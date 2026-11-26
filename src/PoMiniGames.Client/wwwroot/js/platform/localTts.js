// platform/localTts.js — opt-in in-browser Kokoro-82M ONNX TTS with IndexedDB phrase caching.
// Voices dynamic player initials, Brawl corner advice, and trivia questions on-device through
// audioBus.js (with automatic music ducking and optional 3D spatialization), cutting origin egress.
import * as audioBus from './audioBus.js';

const DB_NAME = 'pomini-tts-cache';
const STORE = 'phrases';
const ENABLED_KEY = 'pominigames:local-tts';

let worker = null;
let nextId = 1;
const pending = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
  } catch { return null; }
}

async function cachePut(key, val) {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
  } catch { /* quota/private mode */ }
}

function getWorker() {
  if (worker || typeof Worker === 'undefined') return worker;
  worker = new Worker(new URL('./ttsWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data?.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve({ pcm: e.data.pcm, sampleRate: e.data.sampleRate });
    else p.reject(new Error(e.data.error || 'TTS failed'));
  };
  return worker;
}

export function isLocalTtsEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

export function setLocalTtsEnabled(on) {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ok */ }
}

/** Synthesize (or fetch from IndexedDB cache) and play through audioBus.js. */
export async function speakLocal(text, { voice = 'af_bella', speed = 1.0, pos = null } = {}) {
  if (!text || audioBus.isMuted()) return false;
  const key = `${voice}|${speed}|${text}`;
  let entry = await cacheGet(key);
  if (!entry) {
    const w = getWorker();
    if (!w) return false;
    entry = await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, text, voice, speed });
    });
    await cachePut(key, entry);
  }
  const ctx = await audioBus.context();
  const sfxBus = audioBus.bus('sfx');
  if (!ctx || !sfxBus) return false;

  const buf = ctx.createBuffer(1, entry.pcm.length, entry.sampleRate);
  buf.getChannelData(0).set(entry.pcm);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  if (pos) {
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.positionX.value = pos.x ?? 0; pan.positionY.value = pos.y ?? 1.6; pan.positionZ.value = pos.z ?? 0;
    src.connect(pan).connect(sfxBus);
  } else {
    src.connect(sfxBus);
  }
  audioBus.duck?.(0.35, Math.min(5, buf.duration));
  src.start();
  return true;
}

if (typeof window !== 'undefined') {
  window.PoLocalTts = { isLocalTtsEnabled, setLocalTtsEnabled, speakLocal };
}
