// PoMule world geometry: a 24×9 tile planet whose columns wrap. Pure maths, no DOM and no
// imports, so tests/pomule-world.test.mjs can load this file on its own.

export const COLS = 24;
export const ROWS = 9;
export const TILE = 64;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;
export const TOWN_ROW = 4;
export const TOWN_COLS = [2, 8, 14, 20];

// Mirrors Terrain in PoMuleMap.cs.
export const PLAINS = 0, RIVER = 1, MOUNTAIN = 2, CRATER = 3, TOWN = 4;

// Where on a town plot an AI colonist walks to for each errand (left, middle, right third).
export const OUTFITTER = 0, PUB = 1, ASSAY = 2;

/** Brings any x back onto the planet: leaving the east edge re-enters at the west. */
export function wrapX(x, width = WORLD_W) {
  return ((x % width) + width) % width;
}

/** Signed shortest east–west step from `from` to `to`, going round the seam when closer. */
export function wrapDelta(from, to, width = WORLD_W) {
  let d = wrapX(to - from, width);
  if (d > width / 2) d -= width;
  return d;
}

export function tileAt(x, y) {
  const col = Math.floor(wrapX(x) / TILE);
  const row = Math.min(ROWS - 1, Math.max(0, Math.floor(y / TILE)));
  return { col, row, index: row * COLS + col };
}

export function tileCenter(index) {
  return { x: (index % COLS) * TILE + TILE / 2, y: Math.floor(index / COLS) * TILE + TILE / 2 };
}

/** The point to walk to for a building of this kind in the town nearest to x. */
export function nearestBuilding(x, kind) {
  let best = 0;
  for (let i = 1; i < TOWN_COLS.length; i++) {
    if (Math.abs(wrapDelta(x, townX(i, kind))) < Math.abs(wrapDelta(x, townX(best, kind)))) best = i;
  }
  return { town: best, x: townX(best, kind), y: TOWN_ROW * TILE + TILE / 2 };
}

function townX(town, kind) {
  return TOWN_COLS[town] * TILE + (kind + 0.5) * (TILE / 3);
}

// ── Inside a town ──────────────────────────────────────────────────────────────────
// Walking onto a town plot takes the player into the store, drawn on the same canvas as
// the planet and measured in the same units. Four outfitting stalls line the top wall, the
// Assay Office, the Pub and the M.U.L.E. corral the bottom; the way out is either side.
export const STALL_HALF = 100;
export const TOP_STALLS = [192, 576, 960, 1344];   // centre x of Food, Energy, Smithore, Crystite
export const BOTTOM_STALLS = [256, 768, 1280];     // centre x of Assay Office, Pub, corral
export const STALL_DEPTH = 150;

// What walking into a stall does (the codes PoMulePage.OnTown takes).
export const TOWN_BUY_MULE = 0, TOWN_PUB = 5, TOWN_ASSAY = 6; // 1–4 = outfit for that good

/** The stall under a point inside the store, as a town action code, or -1. */
export function stallAt(x, y) {
  if (y < STALL_DEPTH - 40) {
    const k = TOP_STALLS.findIndex((cx) => Math.abs(x - cx) < STALL_HALF - 20);
    return k < 0 ? -1 : k + 1;
  }
  if (y > WORLD_H - STALL_DEPTH + 40) {
    const k = BOTTOM_STALLS.findIndex((cx) => Math.abs(x - cx) < STALL_HALF - 20);
    return k < 0 ? -1 : [TOWN_ASSAY, TOWN_PUB, TOWN_BUY_MULE][k];
  }
  return -1;
}