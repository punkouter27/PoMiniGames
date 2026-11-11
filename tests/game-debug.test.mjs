import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/PoMiniGames.Client/wwwroot/js/game-debug.js', import.meta.url), 'utf8');

function harness() {
  const listeners = new Map();
  const calls = [];
  const document = {
    body: {}, documentElement: {},
    activeElement: null,
    modal: false,
    querySelector() { return this.modal ? {} : null; }
  };
  const window = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent() {},
    innerWidth: 950, innerHeight: 657, devicePixelRatio: 1
  };
  vm.runInNewContext(source, {
    window, document, navigator: { hardwareConcurrency: 4 }, performance: {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  });
  window.poGameDebug.start({ invokeMethodAsync: (...args) => { calls.push(args); return Promise.resolve(); } });
  function key(key, extra = {}) {
    const event = { key, preventDefault() { this.defaultPrevented = true; }, ...extra };
    listeners.get('keydown')?.(event);
    return event;
  }
  return { window, document, calls, listeners, key };
}

test('Tab toggles once; repeat and modified Tab preserve navigation', () => {
  const h = harness();
  assert.equal(h.key('Tab').defaultPrevented, true);
  assert.equal(h.window.poGameStatsOpen, true);
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'repeat']) {
    assert.equal(h.key('Tab', { [modifier]: true }).defaultPrevented, undefined);
  }
  h.key('Tab');
  assert.equal(h.window.poGameStatsOpen, false);
  assert.equal(h.calls.length, 2);
});

test('dialogs, controls and claimed events retain Tab', () => {
  const h = harness();
  h.document.modal = true;
  assert.equal(h.key('Tab').defaultPrevented, undefined);
  h.document.modal = false;
  h.document.activeElement = { matches: () => true, closest: () => null };
  assert.equal(h.key('Tab').defaultPrevented, undefined);
  h.document.activeElement = null;
  h.key('Tab', { defaultPrevented: true });
  assert.equal(h.calls.length, 0);
});

test('visible Stats action and Escape share state; disposal removes listeners', () => {
  const h = harness();
  h.window.poGameDebug.toggle();
  assert.equal(h.window.poGameStatsOpen, true);
  h.listeners.get('keyup')({ key: 'Escape' });
  assert.equal(h.window.poGameStatsOpen, false);
  h.window.poGameDebug.stop();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.window.poGameStatsOpen, false);
});
