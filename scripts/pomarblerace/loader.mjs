// Module resolve hook for the harness. The engine's modules import bare 'three' / 'cannon-es'
// (an import map in the browser), and game.js pulls in the renderer, the audio graph and two
// window-only effect modules. Bare names resolve to this folder's node_modules; the renderer,
// audio and effects resolve to the headless stubs. Everything else is the real engine source.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const nm = path.join(here, 'node_modules');
const stub = (f) => pathToFileURL(path.join(here, 'stubs', f)).href;

const BARE = {
  'three': pathToFileURL(path.join(nm, 'three/build/three.module.js')).href,
  'cannon-es': pathToFileURL(path.join(nm, 'cannon-es/dist/cannon-es.js')).href,
};
const STUBBED = { 'scene.js': stub('scene.mjs'), 'audio.js': stub('audio.mjs'), 'weather.js': stub('empty.mjs'), 'glassFx.js': stub('empty.mjs') };

export function resolve(specifier, context, next) {
  if (BARE[specifier]) return { url: BARE[specifier], shortCircuit: true };
  if (specifier.startsWith('three/addons/')) {
    return { url: pathToFileURL(path.join(nm, 'three/examples/jsm', specifier.slice('three/addons/'.length))).href, shortCircuit: true };
  }
  const parent = context.parentURL || '';
  if (parent.includes('/js/pomarblerace/') || parent.includes('/js/pomarblerace%2F')) {
    const base = specifier.split('/').pop();
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && STUBBED[base]) {
      return { url: STUBBED[base], shortCircuit: true };
    }
  }
  return next(specifier, context);
}

// The stall tuner (tune-stall.mjs) runs each candidate in its own process with PMR_TUNE set to
// a JSON object of tuning.js constants to override, e.g. {"STALL_NUDGE":20}. tuning.js exports
// plain `const`s, so they are rewritten in the source as it loads rather than patched after.
// Written to work as both kinds of hook: module.registerHooks (in-thread, `next` returns the
// result) and module.register (off-thread, `next` returns a promise).
export function load(url, context, next) {
  const result = next(url, context);
  const tune = process.env.PMR_TUNE;
  if (!tune || !url.endsWith('/pomarblerace/tuning.js')) return result;
  return result instanceof Promise ? result.then((r) => retune(r, tune)) : retune(result, tune);
}

function retune(result, tune) {
  let src = String(result.source);
  for (const [name, value] of Object.entries(JSON.parse(tune))) {
    const re = new RegExp(`export const ${name} = [^;]+;`);
    if (!re.test(src)) throw new Error(`PMR_TUNE: tuning.js has no constant ${name}`);
    src = src.replace(re, `export const ${name} = ${JSON.stringify(value)};`);
  }
  return { ...result, source: src, shortCircuit: true };
}
