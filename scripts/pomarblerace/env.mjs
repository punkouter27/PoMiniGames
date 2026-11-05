// The slice of a browser the engine touches when nothing is drawn: a window, canvases whose 2D
// context accepts anything (procedural textures are painted but never uploaded), an in-memory
// localStorage, and a fetch that serves wwwroot/ from disk so the GLB courses load.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
export const WWWROOT = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot');

// Playground Run's visual model is Draco-compressed, and the decoder is a browser Worker. Nothing
// physical comes from it — that course collides against playground_colliders.glb plus the baked
// lanes (maps.js) — so the harness hands the loader an empty glTF in its place.
const VISUAL_ONLY = new Set(['models/playground.glb']);

function emptyGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }).padEnd(48, ' '));
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.alloc(12 + 8 + chunk.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(chunk.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(out, 20);
  return out;
}

function ctx2d(canvas) {
  const img = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
  const base = {
    canvas,
    getImageData: (x, y, w, h) => img(w, h),
    createImageData: (w, h) => (typeof w === 'object' ? img(w.width, w.height) : img(w, h)),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t).length * 6 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function element(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), width: 300, height: 150, style: {}, children: [],
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => null,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  if (el.tagName === 'CANVAS') { let c; el.getContext = (kind) => (kind === '2d' ? (c ||= ctx2d(el)) : null); el.toDataURL = () => 'data:,'; }
  return el;
}

let installed = false;
export function installBrowser() {
  if (installed) return;
  installed = true;
  const g = globalThis;
  g.window = g;
  g.self = g;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.document = {
    createElement: element, createElementNS: (_ns, tag) => element(tag),
    getElementById: () => element('div'), querySelector: () => null, body: element('body'),
    addEventListener() {}, removeEventListener() {}, hidden: false,
  };
  const mem = new Map();
  g.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  g.ProgressEvent ||= class ProgressEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  // FileLoader builds a Request from a page-relative URL, which node's Request refuses.
  g.Request = class { constructor(url, init = {}) { this.url = String(url); Object.assign(this, init); } };
  const realFetch = g.fetch;
  g.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('blob:') || url.startsWith('data:')) return new Response(new Uint8Array(0));
    if (/^https?:/.test(url)) return realFetch(input);
    const rel = url.replace(/^\.?\//, '').split('?')[0];
    const body = VISUAL_ONLY.has(rel) ? emptyGlb() : fs.readFileSync(path.join(WWWROOT, rel));
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}

/** Deterministic Math.random for one race. */
export function seedRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
