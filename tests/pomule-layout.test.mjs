import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pomule/', import.meta.url);
const moduleUrl = async (name) => `data:text/javascript;base64,${Buffer.from(await readFile(new URL(name, root), 'utf8')).toString('base64')}`;
const source = (await readFile(new URL('render.js', root), 'utf8'))
  .replace("'./world.js'", JSON.stringify(await moduleUrl('world.js')))
  .replace("'./font.js'", JSON.stringify(await moduleUrl('font.js')));
const { frameLayout, drawFrame } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('the entire picture fits with an inset on desktop and narrow portrait screens', () => {
  for (const view of [{ w: 1341, h: 570 }, { w: 390, h: 600 }, { w: 320, h: 540 }]) {
    const layout = frameLayout(view);
    assert.ok(layout.x >= 8);
    assert.ok(layout.x + layout.width <= view.w - 8);
    assert.ok(layout.y >= 0);
    assert.ok(layout.y + layout.height <= view.h);
    if (layout.portrait) assert.ok(layout.y + layout.height + 12 + 4 * 68 <= view.h);
  }
});

test('portrait draws eight readable player cards without cropping their stats', () => {
  const text = [];
  const context = new Proxy({}, { get: (_, key) => key === 'fillText'
    ? (value, x, y) => text.push({ value, x, y }) : () => {} });
  const game = {
    lo: { getContext: () => context }, phase: 5, snap: Array(200).fill(0), seats: 8,
    names: Array.from({ length: 8 }, (_, i) => `Player ${i + 1}`),
    colors: Array(8).fill('#000000'), species: Array(8).fill(0),
    seat: () => 1, trades: [], time: 0,
  };
  drawFrame(context, game, { w: 320, h: 540 });
  assert.equal(text.length, 24);
  assert.equal(text.filter(item => item.value === 'F1 E1 S1 C1').length, 8);
  assert.ok(text.every(item => item.x >= 8 && item.y >= 0 && item.y < 540));
});
