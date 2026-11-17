import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../src/PoMiniGames.Client/wwwroot/js/pomule/', import.meta.url);
const moduleUrl = async (name) => `data:text/javascript;base64,${Buffer.from(await readFile(new URL(name, root), 'utf8')).toString('base64')}`;
const source = (await readFile(new URL('render.js', root), 'utf8'))
  .replace("'./world.js'", JSON.stringify(await moduleUrl('world.js')))
  .replace("'./font.js'", JSON.stringify(await moduleUrl('font.js')));
const { frameLayout, drawFrame, hint, shortName, SCREEN_W, SCREEN_H } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const SEATS = 16;
const CARD_PITCH = 46;

/** A 2D context that records rectangles, for the parts of the picture that are not text. */
function recordingContext(boxes, texts = []) {
  return new Proxy({}, {
    get: (_, key) => key === 'fillRect' ? (x, y, w, h) => boxes.push({ x, y, w, h })
      : key === 'fillText' ? (value, x, y) => texts.push({ value, x, y })
        : () => {},
  });
}

/** Everything drawFrame reads off the game, so a whole frame can be drawn with no browser. */
function makeGame(context, overrides = {}) {
  const snap = Array(23 + SEATS * 16).fill(0);
  snap[0] = 3; // month
  const game = {
    lo: { getContext: () => context },
    tiles: { getContext: () => context, width: SCREEN_W, height: 144 },
    tilesStale: true,
    phase: 2, snap, seats: SEATS, human: true,
    names: Array.from({ length: SEATS }, (_, i) => (i ? `Colonist ${i}` : 'You')),
    colors: Array(SEATS).fill('#58d854'), species: Array(SEATS).fill(0),
    terrain: Array(216).fill(0), peaks: Array(216).fill(0), owner: Array(216).fill(-1),
    installed: Array(216).fill(-1), crystite: Array(216).fill(0),
    avatars: Array.from({ length: SEATS }, (_, i) => ({
      seat: i, species: 0, x: 40 + i * 8, y: 40, facing: 1, dashing: false, frame: 0, hidden: false, mule: null,
    })),
    runaways: [], trades: [], production: null, time: 0, phaseTime: 1,
    interior: null, eventPlot: -1, message: '',
    seat(seat, field) { return this.snap[23 + seat * 16 + field]; },
  };
  return Object.assign(game, overrides);
}

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
      terrain: Array(216).fill(0),
      seat: () => 4, trades: [], time: 0,
    };
    drawFrame(context, game, { w: 1341, h: 570 });
    return boxes.filter(b => b.y === 134 && b.w === 20 && b.h === 9);
  };
  assert.equal(rects(true).length, 1, 'inverse YOU box at the foot of lane 0');
  assert.equal(rects(false).length, 0, 'demo mode leaves lane 0 unmarked');
});

test('every phase paints a whole screen, so a match cannot come up blank', () => {
  const cases = [
    ['land grant', { phase: 0 }, (s) => { s[2] = 200; s[10] = 30; }],
    ['land auction preview', { phase: 1 }, (s) => { s[2] = 200; s[4] = 30; }],
    ['land auction floor', { phase: 1 }, (s) => {
      s[2] = 100; s[4] = 30; s[5] = 450; s[6] = 1; s[8] = 150; s[22] = 600;
    }],
    ['development', { phase: 2 }, (s) => { s[23 + 15] = 250; }],
    ['the store', { phase: 2, interior: { town: 0 } }, (s) => { s[23 + 15] = 250; s[9] = 12; }],
    ['production', { phase: 3, production: Array(216).fill(3) }, () => {}],
    ['a colony event', { phase: 4, eventPlot: 40 }, (s) => { s[7] = 7; }],
    ['the market', { phase: 5 }, (s) => { s[3] = 0; s[8] = 30; s[11] = 47; s[22] = 65; }],
    ['the status summary', { phase: 6 }, () => {}],
    ['the ship returns', { phase: 7 }, () => {}],
  ];
  for (const [name, overrides, fill] of cases) {
    for (const view of [{ w: 1341, h: 570 }, { w: 320, h: 540 }]) {
      const boxes = [];
      const context = recordingContext(boxes);
      const game = makeGame(context, overrides);
      fill(game.snap);
      assert.doesNotThrow(() => drawFrame(context, game, view), `${name} at ${view.w}x${view.h}`);
      assert.ok(boxes.length > 100, `${name} at ${view.w}x${view.h} drew ${boxes.length} rectangles`);
    }
  }
});

test('the land auction says what is for sale, even once the bidding starts', () => {
  const snap = Array(23 + SEATS * 16).fill(0);
  const game = { phase: 1, human: true, snap, names: ['You', 'Speculator'], terrain: Array(216).fill(2) };
  snap[2] = 100; // at or below LAND_TICKS: the bidding floor is showing
  snap[4] = 30; // a mountain plot
  snap[6] = -1; // nobody has bid yet
  snap[8] = 150;
  assert.match(hint(game), /MOUNTAIN PLOT/);
  assert.match(hint(game), /OPENING \$160/);

  snap[5] = 450;
  snap[6] = 1; // somebody has bid, which used to replace the whole line
  const line = hint(game);
  assert.match(line, /MOUNTAIN PLOT/, 'the plot stays named while the bidding runs');
  assert.match(line, /Speculator BIDS \$450/);
});

test('a price label lifted off its lane keeps a hairline back to its colonist', () => {
  const boxes = [];
  const context = recordingContext(boxes);
  const snap = Array(23 + SEATS * 16).fill(0);
  snap[2] = 60; snap[3] = 0; snap[8] = 30; snap[11] = 47; snap[22] = 600;
  // Sixteen buyers standing at the same three-figure price: every label but one has to
  // move up a line, because a label is wider than the gap between two lanes.
  for (let seat = 0; seat < SEATS; seat++) {
    snap[23 + seat * 16 + 9] = -1;
    snap[23 + seat * 16 + 10] = 450;
  }
  const game = makeGame(context, { phase: 5, snap });
  drawFrame(context, game, { w: 1341, h: 570 });
  // One pixel wide and taller than a glyph pixel: the leader, not a character.
  assert.ok(boxes.some(b => b.w === 1 && b.h > 1), 'a lifted label is tied to its own lane');
});
