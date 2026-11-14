import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pomule/', import.meta.url);
const moduleUrl = async (name) => `data:text/javascript;base64,${Buffer.from(await readFile(new URL(name, root), 'utf8')).toString('base64')}`;
const source = (await readFile(new URL('render.js', root), 'utf8'))
  .replace("'./world.js'", JSON.stringify(await moduleUrl('world.js')))
  .replace("'./font.js'", JSON.stringify(await moduleUrl('font.js')));
const { frameLayout, drawFrame, shortName, SCREEN_W, SCREEN_H } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const SEATS = 16;
const CARD_PITCH = 46;

test('the entire picture fits with an inset on desktop and narrow portrait screens', () => {
  for (const view of [{ w: 1341, h: 570 }, { w: 390, h: 600 }, { w: 320, h: 540 }]) {
    const layout = frameLayout(view);
    assert.ok(layout.x >= 8);
    assert.ok(layout.x + layout.width <= view.w - 8);
    assert.ok(layout.y >= 0);
    assert.ok(layout.y + layout.height <= view.h);
    // Sixteen cards in two columns: eight rows under the planet.
    if (layout.portrait) assert.ok(layout.y + layout.height + 12 + (SEATS / 2) * CARD_PITCH <= view.h);
  }
});

test('the screen holds two bands of eight status columns under the planet', () => {
  assert.equal(SCREEN_W, 384, 'eight 48-pixel columns a band');
  assert.equal(SCREEN_H, 242);
});

test('portrait draws sixteen player cards without cropping their stats', () => {
  const text = [];
  const context = new Proxy({}, { get: (_, key) => key === 'fillText'
    ? (value, x, y) => text.push({ value, x, y }) : () => {} });
  const game = {
    lo: { getContext: () => context }, phase: 5, snap: Array(400).fill(0), seats: SEATS,
    names: Array.from({ length: SEATS }, (_, i) => `Player ${i + 1}`),
    colors: Array(SEATS).fill('#000000'), species: Array(SEATS).fill(0),
    seat: () => 1, trades: [], time: 0,
  };
  drawFrame(context, game, { w: 320, h: 540 });
  assert.equal(text.length, SEATS * 3, 'name, money and goods on each card');
  assert.equal(text.filter(item => item.value === 'F1 E1 S1 C1').length, SEATS);
  assert.ok(text.every(item => item.x >= 8 && item.y >= 0 && item.y < 540));
});

test('a repeated personality keeps its numeral when the name is cut to a status column', () => {
  assert.equal(shortName('Hoarder'), 'Hoarder');
  assert.equal(shortName('Industrialist'), 'Indust.');
  assert.equal(shortName('Hoarder II'), 'Hoar II');
  assert.equal(shortName('Speculator III'), 'Spe III');
  for (const name of ['Industrialist III', 'Prospector II']) assert.ok(shortName(name).length <= 7);
});

test('the 16-lane market floor marks seat 0 with an inverse tag only when a human plays', () => {
  const rects = (human) => {
    const boxes = [];
    const context = new Proxy({}, { get: (_, key) => key === 'fillRect'
      ? (x, y, w, h) => boxes.push({ x, y, w, h }) : () => {} });
    const snap = Array(700).fill(0);
    snap[2] = 100; // <= LAND_TICKS (170), so onLandFloor(g) is true when phase === 1
    const game = {
      lo: { getContext: () => context }, tiles: { getContext: () => context },
      phase: 1, snap, seats: SEATS, human,
      names: Array.from({ length: SEATS }, (_, i) => `P${i}`),
      colors: Array(SEATS).fill('#58d854'), species: Array(SEATS).fill(0),
      seat: () => 4, trades: [], time: 0,
    };
    drawFrame(context, game, { w: 1341, h: 570 });
    return boxes.filter(b => b.y === 134 && b.w === 20 && b.h === 9);
  };
  assert.equal(rects(true).length, 1, 'inverse YOU box at the foot of lane 0');
  assert.equal(rects(false).length, 0, 'demo mode leaves lane 0 unmarked');
});
