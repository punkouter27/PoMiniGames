// PoMule drawing. Everything here only reads the game object index.js owns; nothing here
// changes the match.
//
// The screen is laid out and coloured after the 1983 Atari 800 game. One 384×190 buffer of
// fat pixels holds the whole thing and is blown up to fit, with smoothing off:
//
//   title line     "DEVELOPMENT #3" in grey, the month's clock at the right
//   the planet     all 24×8 plots at once (16 pixels a plot), or the store's interior,
//                  or the auction floor
//   message line   orange block capitals
//   status block   one column per colonist: name, money, goods
//
// Pale grey ground, plots fenced in their owner's colour with the M.U.L.E.'s glyph inside, a
// dotted orange river, small grey mountains, black store blocks.
import * as W from './world.js';
import { drawText } from './font.js';

export const SCREEN_W = 384, SCREEN_H = 190, MAP_Y = 10;
const MSG_Y = 141, STATUS_Y = 153, COLUMN_W = 48;
const PX = 4; // one fat pixel in world units (a plot is 64 units, 16 pixels)

const GROUND = '#dcdce0';
const SPECK = '#c4c4c8';
const RIVER = '#f0a020';
const ROCK = '#a4a4a8';
const INK = '#000000';
const WINDOW = '#f4f4f4';
const CRYSTITE = '#8040c0';
const ORANGE = '#c86000';
const TEXT = '#585858';
const GOOD_NAME = ['FOOD', 'ENERGY', 'SMITHORE', 'CRYSTITE'];
const TERRAIN_NAME = ['PLAINS', 'RIVER', 'MOUNTAIN', 'CRATER'];
// Ticks: a whole development month, a goods auction, and a land auction once its floor opens.
const DEVELOP_TICKS = 450, MARKET_TICKS = 120, LAND_TICKS = 170;

/** The land auction shows the plot on the map first, then moves to the bidding floor. */
const onLandFloor = (g) => g.phase === 1 && g.snap[2] <= LAND_TICKS;
const GOOD_COLOR = ['#28a010', '#c08000', '#707070', '#8040c0'];

/** Fat-pixel rectangles: [cellX, cellY, width, height] from (x, y), one cell per Atari pixel. */
function cells(c, x, y, color, list, unit = PX) {
  c.fillStyle = color;
  for (const [cx, cy, cw = 1, ch = 1] of list) c.fillRect(x + cx * unit, y + cy * unit, cw * unit, ch * unit);
}

// What a M.U.L.E. is making, drawn in its owner's colour: a plant, a pair of arrows, a
// pick over a pile, a gem. Two dots under each, like the original's.
const GOOD_GLYPH = [
  [[3, 0, 1, 7], [1, 1, 1, 2], [5, 1, 1, 2], [2, 3, 3, 1], [0, 0, 1, 1], [6, 0, 1, 1], [1, 8, 1, 1], [3, 8, 1, 1], [5, 8, 1, 1]],
  [[0, 1, 6, 1], [5, 0, 1, 3], [6, 1, 1, 1], [1, 5, 6, 1], [1, 4, 1, 3], [0, 5, 1, 1], [2, 8, 1, 1], [4, 8, 1, 1]],
  [[2, 0, 1, 7], [0, 1, 5, 1], [4, 2, 1, 3], [0, 3, 2, 1], [0, 5, 2, 1], [1, 8, 1, 1], [3, 8, 1, 1], [5, 8, 1, 1]],
  [[3, 0, 1, 1], [2, 1, 3, 1], [1, 2, 5, 1], [0, 3, 7, 1], [1, 4, 5, 1], [2, 5, 3, 1], [3, 6, 1, 1], [1, 8, 1, 1], [5, 8, 1, 1]],
];

function drawTile(c, g, i, x, y) {
  const terrain = g.terrain[i], col = i % W.COLS, row = Math.floor(i / W.COLS);
  if (terrain === W.RIVER) {
    const dots = [];
    for (let r = 0; r < 16; r++) for (let k = 5; k < 11; k++) if ((r + k + (r >> 1)) % 2 === 0) dots.push([k + ((r >> 2) % 2), r]);
    cells(c, x, y, RIVER, dots);
  } else if (terrain === W.MOUNTAIN) {
    const spots = [[2, 9], [9, 5], [6, 12]];
    for (let k = 0; k < g.peaks[i]; k++) {
      const [mx, my] = spots[k];
      cells(c, x, y, ROCK, [[mx + 2, my - 2, 1, 1], [mx + 1, my - 1, 3, 1], [mx, my, 5, 1]]);
    }
  } else if (terrain === W.CRATER) {
    cells(c, x, y, ROCK, [[5, 5, 6, 1], [4, 6, 1, 4], [11, 6, 1, 4], [5, 10, 6, 1]]);
    cells(c, x, y, SPECK, [[5, 6, 6, 4]]);
  } else if (terrain === W.TOWN) {
    // The store: a black block with lit windows.
    cells(c, x, y, INK, [[0, 0, 16, 16]]);
    cells(c, x, y, WINDOW, [[1, 1, 3, 2], [6, 1, 4, 2], [12, 1, 3, 2], [1, 6, 2, 3], [5, 6, 2, 3], [9, 6, 6, 9]]);
    return;
  } else {
    cells(c, x, y, SPECK, [[3 + (col * 5) % 9, 4], [11 - (row * 3) % 7, 10]]);
  }

  const owner = g.owner[i];
  if (owner >= 0) cells(c, x, y, g.colors[owner], [[0, 0, 16, 1], [0, 15, 16, 1], [0, 0, 1, 16], [15, 0, 1, 16]]);
  const installed = g.installed[i];
  if (installed >= 0) cells(c, x + 5 * PX, y + 3 * PX, owner >= 0 ? g.colors[owner] : TEXT, GOOD_GLYPH[installed]);
  for (let k = 0; k < g.crystite[i]; k++) cells(c, x, y, CRYSTITE, [[2 + k * 2, 2, 1, 1]]);
}

/**
 * A blocky one-colour colonist, with one feature per species and a two-frame walk.
 * Origin is its centre; `frame` is 0 or 1.
 */
export function drawColonist(c, x, y, color, species, facing, dashing, frame = 0) {
  const block = (col, list) => cells(c, x, y, col, list);
  block(color, [[-1, -4, 2, 2], [-2, -2, 4, 3]]);
  // Legs: stride on frame 1.
  if (species === 6) block(color, [[-1, 2, 2, 1]]);                 // the Spheroid hovers
  else block(color, frame ? [[-2, 1, 1, 2], [1, 1, 1, 3]] : [[-2, 1, 1, 3], [1, 1, 1, 2]]);
  switch (species) {
    case 0: block(color, [[-2, -4, 1, 1], [1, -4, 1, 1]]); break;                       // eyes on stalks
    case 1: block(GROUND, [[-2, -1, 4, 1]]); break;                                      // segmented chassis
    case 2: block(color, [[-3, -2, 1, 1], [2, -2, 1, 1], [-3, 0, 1, 1], [2, 0, 1, 1]]); break; // four arms
    case 3: block(color, [[-1, -5, 1, 1], [0, -6, 1, 1]]); break;                        // crystal spire
    case 4: block(color, frame ? [[-4, -2, 2, 1], [2, -2, 2, 1]] : [[-4, -3, 2, 2], [2, -3, 2, 2]]); break; // wings beat
    case 5: block(color, [[-3, -2, 6, 1]]); break;                                       // broad shoulders
    case 6: break;
    default: block(GROUND, [[-1, -3, 2, 1]]); break;                                     // visor
  }
  if (dashing) block(color, [[-facing * 4 - (facing > 0 ? 1 : 0), -1, 2, 1], [-facing * 5 - (facing > 0 ? 1 : 0), 1, 2, 1]]);
}

function drawMule(c, x, y, color, frame = 0) {
  cells(c, x - 3 * PX, y - 2 * PX, color, [[0, 0, 5, 2], [5, -1, 1, 2], [6, -2, 1, 1],
    ...(frame ? [[0, 2, 1, 1], [4, 2, 1, 2], [1, 2, 1, 2]] : [[0, 2, 1, 2], [4, 2, 1, 1], [3, 2, 1, 2]])]);
}

/** Draws something at world x, and again across the seam when it straddles the map's edge. */
function wrapped(x, draw) {
  draw(x);
  if (x < W.TILE) draw(x + W.WORLD_W);
  else if (x > W.WORLD_W - W.TILE) draw(x - W.WORLD_W);
}

const snap = (v) => Math.round(v / PX) * PX;

/**
 * The planet's 192 plots, painted once and kept: terrain, fences and installed M.U.L.E.s
 * only change when index.js is handed new plots (setPlots marks the layer stale). Painting
 * them tile by tile every frame was most of the frame's cost.
 */
function tileLayer(g) {
  if (g.tiles && !g.tilesStale) return g.tiles;
  g.tiles ??= Object.assign(document.createElement('canvas'), { width: SCREEN_W, height: W.ROWS * W.TILE / PX });
  const c = g.tiles.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, g.tiles.width, g.tiles.height);
  c.setTransform(1 / PX, 0, 0, 1 / PX, 0, 0);
  for (let i = 0; i < g.terrain.length; i++) drawTile(c, g, i, (i % W.COLS) * W.TILE, Math.floor(i / W.COLS) * W.TILE);
  g.tilesStale = false;
  return g.tiles;
}

function drawMap(c, g) {
  // A planetquake rattles the whole picture.
  const quake = g.phase === 4 && g.snap[7] === 4 ? (Math.floor(g.time * 20) % 3 - 1) : 0;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(tileLayer(g), quake, MAP_Y);
  c.setTransform(1 / PX, 0, 0, 1 / PX, quake, MAP_Y);

  const frame = (index, color) => {
    const t = W.tileCenter(index);
    cells(c, t.x - W.TILE / 2, t.y - W.TILE / 2, color, [[0, 0, 16, 2], [0, 14, 16, 2], [0, 0, 2, 16], [14, 0, 2, 16]]);
  };
  const blink = Math.floor(g.time * 6) % 2 === 0;
  const event = g.snap[7];

  if (g.phase === 0 && g.snap[10] >= 0) {
    frame(g.snap[10], blink ? INK : ORANGE); // the one land-grant highlighter everybody watches
  } else if (g.phase === 1 && g.snap[4] >= 0) {
    frame(g.snap[4], blink ? INK : ORANGE);
  } else if (g.phase === 2) {
    if (g.snap[20] >= 0 && blink) {
      // The wampus, blinking in the mountains.
      const t = W.tileCenter(g.snap[20]);
      cells(c, t.x, t.y, INK, [[-1, -3, 2, 1], [-2, -2, 4, 3], [-3, -1, 1, 1], [2, -1, 1, 1], [-2, 1, 1, 1], [1, 1, 1, 1]]);
      cells(c, t.x, t.y, ORANGE, [[-1, -1, 1, 1], [0, -1, 1, 1]]);
    }
    for (const a of g.avatars) {
      if (a.hidden || !a.mule) continue;
      wrapped(snap(a.mule.x), (x) => drawMule(c, x, snap(a.mule.y), g.colors[a.seat], a.frame));
    }
    for (const r of g.runaways) wrapped(snap(r.x), (x) => drawMule(c, x, snap(r.y), TEXT, Math.floor(g.time * 12) % 2));
    for (const a of g.avatars) {
      if (a.hidden) continue;
      wrapped(snap(a.x), (x) => drawColonist(c, x, snap(a.y), g.colors[a.seat], a.species, a.facing, a.dashing, a.frame));
    }
  } else if (g.phase === 3 && g.production) {
    // Production: each plot's units appear one at a time along its bottom edge.
    const shown = Math.floor(g.phaseTime / 0.35);
    for (let i = 0; i < g.production.length; i++) {
      const n = Math.min(g.production[i], shown, 7);
      for (let k = 0; k < n; k++) cells(c, (i % W.COLS) * W.TILE, Math.floor(i / W.COLS) * W.TILE, INK, [[1 + k * 2, 13, 1, 1]]);
    }
  } else if (g.phase === 4) {
    if (event === 5) {
      // Space pirates: their ship crosses the sky.
      const x = snap((g.phaseTime * 500) % (W.WORLD_W + 200) - 100);
      cells(c, x, 96, INK, [[2, 0, 10, 1], [0, 1, 14, 2], [3, 3, 8, 1]]);
      cells(c, x, 96, ORANGE, [[4, 1, 1, 1], [7, 1, 1, 1], [10, 1, 1, 1]]);
    } else if (g.eventPlot >= 0 && (event === 7 || event === 3 || event === 8)) {
      frame(g.eventPlot, blink ? ORANGE : INK); // where the meteor fell, the pests fed, or a M.U.L.E. went crazy
    } else if (event === 6 && blink) {
      for (const col of W.TOWN_COLS) cells(c, col * W.TILE, W.TOWN_ROW * W.TILE, ORANGE, [[2, -3, 2, 3], [6, -5, 3, 5], [11, -2, 2, 2]]);
    }
  } else if (g.phase === 7) {
    // The colony ship comes back for the final count.
    const y = snap(Math.min(200, -160 + g.phaseTime * 140));
    const x = W.WORLD_W / 2 - 96;
    cells(c, x, y, INK, [[10, 0, 4, 2], [6, 2, 12, 3], [0, 5, 24, 4], [3, 9, 18, 2], [4, 11, 2, 3], [18, 11, 2, 3]], 8);
    cells(c, x, y, WINDOW, [[3, 6, 2, 2], [8, 6, 2, 2], [14, 6, 2, 2], [19, 6, 2, 2]], 8);
    if (blink) cells(c, x, y, ORANGE, [[4, 14, 2, 2], [18, 14, 2, 2]], 8);
  }
}

/** Inside the store: stalls along the top and bottom walls, the way out at either side. */
function drawInterior(c, g) {
  c.setTransform(1 / PX, 0, 0, 1 / PX, 0, MAP_Y);
  const half = W.STALL_HALF, depth = W.STALL_DEPTH, bottom = W.WORLD_H;
  c.fillStyle = INK;
  W.TOP_STALLS.forEach((cx, k) => {
    c.fillRect(cx - half, 0, half * 2, 12);
    c.fillRect(cx - half, 0, 12, depth);
    c.fillRect(cx + half - 12, 0, 12, depth);
    cells(c, cx - 28, 34, GOOD_COLOR[k], GOOD_GLYPH[k], 8);
    c.fillStyle = INK;
  });
  W.BOTTOM_STALLS.forEach((cx) => {
    c.fillRect(cx - half, bottom - 12, half * 2, 12);
    c.fillRect(cx - half, bottom - depth, 12, depth);
    c.fillRect(cx + half - 12, bottom - depth, 12, depth);
  });
  // The corral holds a M.U.L.E. while the Store has any.
  if (g.snap[9] > 0) drawMule(c, W.BOTTOM_STALLS[2], bottom - 50, TEXT, 0);
  cells(c, W.BOTTOM_STALLS[1] - 20, bottom - 90, ORANGE, [[0, 0, 3, 5], [3, 1, 1, 3], [0, 5, 3, 1]], 8); // a mug
  cells(c, W.BOTTOM_STALLS[0] - 28, bottom - 90, CRYSTITE, GOOD_GLYPH[3], 8);

  const me = g.avatars[0];
  if (me.mule) drawMule(c, snap(me.mule.x), snap(me.mule.y), g.colors[0], me.frame);
  drawColonist(c, snap(me.x), snap(me.y), g.colors[0], me.species, me.facing, me.dashing, me.frame);

  c.setTransform(1, 0, 0, 1, 0, MAP_Y);
  const outfit = [25, 50, 75, 100];
  W.TOP_STALLS.forEach((cx, k) => drawText(c, `${GOOD_NAME[k]} $${outfit[k]}`, cx / PX, 42, TEXT, 1, 'center'));
  drawText(c, 'ASSAY', W.BOTTOM_STALLS[0] / PX, 80, TEXT, 1, 'center');
  drawText(c, 'PUB', W.BOTTOM_STALLS[1] / PX, 80, TEXT, 1, 'center');
  drawText(c, g.snap[9] > 0 ? `MULE $${g.snap[19]}` : 'NO MULES', W.BOTTOM_STALLS[2] / PX, 80, TEXT, 1, 'center');
  drawText(c, 'EXIT', 2, 60, ORANGE);
  drawText(c, 'EXIT', SCREEN_W - 2, 60, ORANGE, 1, 'right');
}

/**
 * The auction floor: sellers come down from the top, buyers up from the bottom. Land is sold
 * on the same floor, with everyone a buyer and the plot where the Store's stock would be.
 */
function drawMarket(c, g) {
  const land = g.phase === 1;
  const good = g.snap[3], floor = g.snap[8], ceiling = g.snap[22];
  const top = 18, bottom = 92, lane = 40, left = 22;
  const laneX = (seat) => left + (seat < 4 ? seat : seat + 1) * lane + lane / 2;
  const priceY = (p) => Math.round(bottom - ((p - floor) / Math.max(1, ceiling - floor)) * (bottom - top));
  const storeX = left + 4 * lane;
  c.setTransform(1, 0, 0, 1, 0, MAP_Y);

  // The Store, between lanes 4 and 5.
  c.fillStyle = INK;
  c.fillRect(storeX + 4, top - 8, lane - 8, bottom - top + 16);
  drawText(c, land ? 'LAND' : 'STORE', storeX + lane / 2, top - 5, WINDOW, 1, 'center');
  drawText(c, land ? '1' : String(g.snap[11 + good] ?? 0), storeX + lane / 2, (top + bottom) / 2 - 3, WINDOW, 1, 'center');

  // The Store's two prices (for land, the opening bid) as dotted lines; the best bid and ask as dashed ones.
  // For land the upper line is the top of the scale, which climbs ahead of the bidding.
  for (const p of land ? [ceiling, floor + 10] : [ceiling, floor]) {
    c.fillStyle = RIVER;
    for (let x = left; x < SCREEN_W - 8; x += 4) c.fillRect(x, priceY(p), 2, 1);
    drawText(c, String(p), left - 2, priceY(p) - 3, ORANGE, 1, 'right');
  }
  let bestBid = -1, bestAsk = -1;
  for (let seat = 0; seat < g.seats; seat++) {
    const role = g.seat(seat, 9), price = g.seat(seat, 10);
    if (role === -1) bestBid = Math.max(bestBid, price);
    if (role === 1) bestAsk = bestAsk < 0 ? price : Math.min(bestAsk, price);
  }
  for (const p of [bestBid, bestAsk]) {
    if (p < 0) continue;
    c.fillStyle = INK;
    for (let x = left; x < SCREEN_W - 8; x += 8) c.fillRect(x, priceY(p), 4, 1);
  }

  for (let seat = 0; seat < g.seats; seat++) {
    const x = laneX(seat), role = g.seat(seat, 9), price = g.seat(seat, 10), units = land ? '' : g.seat(seat, 1 + good);
    const y = role === 0 ? bottom + 14 : priceY(price);
    c.fillStyle = g.colors[seat];
    if (role === 1) for (let k = 0; k < Math.min(units, 6); k++) c.fillRect(x - 3, y + 8 + k * 3, 6, 2); // crates
    c.setTransform(1 / PX, 0, 0, 1 / PX, 0, MAP_Y);
    c.globalAlpha = role === 0 ? 0.35 : 1;
    drawColonist(c, x * PX, y * PX, g.colors[seat], g.species[seat], role === 1 ? 1 : -1, false, Math.floor(g.time * 4) % 2);
    c.globalAlpha = 1;
    c.setTransform(1, 0, 0, 1, 0, MAP_Y);
    if (role !== 0 && !(land && price <= floor)) drawText(c, String(price), x, y - 13, TEXT, 1, 'center');
    drawText(c, String(units), x, 119, g.colors[seat], 1, 'center');
  }

  // A bar between the two sides of each trade, for a third of a second.
  for (const t of g.trades) {
    const from = t.seller < 0 ? storeX + lane / 2 : laneX(t.seller);
    const to = t.buyer < 0 ? storeX + lane / 2 : laneX(t.buyer);
    c.fillStyle = INK;
    c.fillRect(Math.min(from, to), priceY(t.price) - 1, Math.abs(to - from), 2);
  }

  // Time left, as a bar draining down the right edge.
  c.fillStyle = TEXT;
  c.fillRect(SCREEN_W - 5, 4, 3, 120);
  c.fillStyle = ORANGE;
  const left120 = Math.max(0, Math.min(1, g.snap[2] / (land ? LAND_TICKS : MARKET_TICKS)));
  c.fillRect(SCREEN_W - 5, 4 + 120 * (1 - left120), 3, 120 * left120);
}

function title(g) {
  const n = `#${g.snap[0]}`;
  switch (g.phase) {
    case 0: return `LAND GRANT ${n}`;
    case 1: return `LAND AUCTION ${n}`;
    case 2: return g.interior ? `THE STORE ${n}` : `DEVELOPMENT ${n}`;
    case 3: return `PRODUCTION ${n}`;
    case 4: return `COLONY EVENT ${n}`;
    case 5: return `AUCTION: ${GOOD_NAME[g.snap[3]] ?? ''} ${n}`;
    case 6: return `STATUS SUMMARY ${n}`;
    default: return 'THE SHIP HAS RETURNED';
  }
}

function hint(g) {
  const me = g.human;
  switch (g.phase) {
    case 0: return me ? 'PRESS THE BUTTON WHEN YOUR PLOT IS LIT' : 'THE COLONISTS CHOOSE THEIR LAND';
    case 1: return g.snap[6] >= 0 ? `${g.names[g.snap[6]]} BIDS $${g.snap[5]}`
      : !onLandFloor(g) ? `${TERRAIN_NAME[g.terrain[g.snap[4]]] ?? 'LAND'} PLOT FOR SALE`
      : me ? `WALK UP TO BID. OPENING BID $${g.snap[8] + 10}` : 'LAND FOR SALE. WHO WILL BID?';
    case 2: return g.interior ? 'WALK INTO A STALL, OR OUT EITHER SIDE'
      : g.snap[9] > 0 ? `STORE HAS ${g.snap[9]} MULES AT $${g.snap[19]}` : 'THE CORRAL IS EMPTY. THE STORE NEEDS SMITHORE';
    case 3: return 'THE MULES ARE AT WORK';
    case 5: return g.snap[11 + g.snap[3]] === 0 ? `STORE IS SOLD OUT. IT BUYS AT $${g.snap[8]}. SELLERS NAME THEIR PRICE`
      : me ? 'WALK UP TO RAISE YOUR PRICE, DOWN TO LOWER IT' : `STORE BUYS AT $${g.snap[8]}, SELLS AT $${g.snap[22]}`;
    default: return '';
  }
}

/**
 * A name cut to seven characters (a status column holds eight, and one is the gap to the
 * next), so that it still reads as a name: "INDUSTRIALIST" becomes "INDUST." and a second
 * "HOARDER II" stays "HOAR II".
 */
export function shortName(name) {
  const s = String(name);
  if (s.length <= 7) return s;
  return / II$/.test(s) ? `${s.slice(0, -3).slice(0, 4)} II` : `${s.slice(0, 6)}.`;
}

function drawStatus(c, g) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  for (let seat = 0; seat < g.seats; seat++) {
    const x = seat * COLUMN_W + 1, color = g.colors[seat];
    const name = shortName(g.names[seat]);
    if (seat === 0 && g.human) {
      // The player's own name is shown inverse, as a selected item is on the Atari.
      c.fillStyle = color;
      c.fillRect(x - 1, STATUS_Y - 1, name.length * 6 + 2, 9);
      drawText(c, name, x, STATUS_Y, GROUND);
    } else drawText(c, name, x, STATUS_Y, color);
    const away = g.phase === 2 && (g.seat(seat, 8) === 1 || g.seat(seat, 5) === 0);
    drawText(c, away ? (g.seat(seat, 8) === 1 ? 'IN PUB' : 'TIME UP') : `$${g.seat(seat, 0)}`, x, STATUS_Y + 9, color);
    drawText(c, `F${g.seat(seat, 1)} E${g.seat(seat, 2)}`, x, STATUS_Y + 18, color);
    drawText(c, `S${g.seat(seat, 3)} C${g.seat(seat, 4)}`, x, STATUS_Y + 27, color);
  }
}

export function frameLayout(view) {
  const portrait = view.w < 600 && view.h > view.w;
  const sourceHeight = portrait ? STATUS_Y - 2 : SCREEN_H;
  const scale = Math.min(Math.max(1, view.w - 16) / SCREEN_W,
    Math.max(1, view.h - (portrait ? 300 : 16)) / sourceHeight);
  const width = SCREEN_W * scale, height = sourceHeight * scale;
  return { portrait, sourceHeight, width, height, x: (view.w - width) / 2,
    y: portrait ? 8 : (view.h - height) / 2 };
}

function drawPortraitStatus(ctx, g, layout, view) {
  const top = layout.y + layout.height + 12;
  const columnWidth = (view.w - 24) / 2;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let seat = 0; seat < g.seats; seat++) {
    const x = 8 + seat % 2 * (columnWidth + 8), y = top + Math.floor(seat / 2) * 68;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(x, y, columnWidth, 60);
    ctx.fillStyle = g.colors[seat];
    ctx.fillRect(x, y, 3, 60);
    ctx.fillStyle = TEXT;
    ctx.fillText(shortName(g.names[seat]), x + 8, y + 5);
    ctx.fillText(`$${g.seat(seat, 0)}`, x + 8, y + 23);
    ctx.fillText(`F${g.seat(seat, 1)} E${g.seat(seat, 2)} S${g.seat(seat, 3)} C${g.seat(seat, 4)}`,
      x + 8, y + 41, columnWidth - 16);
  }
}

/** Portrait keeps the planet intact and gives the eight colonists readable cards. */
export function drawFrame(ctx, g, view) {
  const lo = (g.lo ??= Object.assign(document.createElement('canvas'), { width: SCREEN_W, height: SCREEN_H }));
  const c = lo.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = GROUND;
  c.fillRect(0, 0, SCREEN_W, SCREEN_H);

  if (g.phase === 5 || onLandFloor(g)) drawMarket(c, g);
  else if (g.interior) drawInterior(c, g);
  else drawMap(c, g);

  c.setTransform(1, 0, 0, 1, 0, 0);
  // Cover anything a sprite drew outside the picture area before the text goes on.
  c.fillStyle = GROUND;
  c.fillRect(0, 0, SCREEN_W, MAP_Y);
  c.fillRect(0, MAP_Y + 128, SCREEN_W, SCREEN_H - MAP_Y - 128);
  drawText(c, title(g), SCREEN_W / 2, 1, TEXT, 1, 'center');
  // In development the player's clock is their own: hunger takes the end off it.
  const clock = g.phase === 2 && g.human ? g.seat(0, 15) : g.snap[2];
  if (g.phase <= 2 && clock > 0 && !onLandFloor(g)) drawText(c, String(Math.ceil(clock / 10)), SCREEN_W - 2, 1, ORANGE, 1, 'right');
  if (g.phase === 2 && g.human) {
    // The time bar of the original: a full month wide, already short for a hungry colonist.
    c.fillStyle = TEXT;
    c.fillRect(2, 3, 90, 3);
    c.fillStyle = ORANGE;
    c.fillRect(2, 3, Math.round(90 * Math.min(1, clock / DEVELOP_TICKS)), 3);
  }
  drawText(c, (g.message || hint(g)).slice(0, 63), SCREEN_W / 2, MSG_Y, ORANGE, 1, 'center');
  drawStatus(c, g);

  const layout = frameLayout(view);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(lo, 0, 0, SCREEN_W, layout.sourceHeight,
    layout.x, layout.y, layout.width, layout.height);
  if (layout.portrait) drawPortraitStatus(ctx, g, layout, view);
}
