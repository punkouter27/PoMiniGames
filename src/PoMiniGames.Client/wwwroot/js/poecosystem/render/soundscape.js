// soundscape.js — what the ground under the listener should sound like.
//
// The island's everyday sound bed had no map: the surf was as loud on the summit as on the
// beach, and a forest sounded like a meadow. This is the map, worked out once per island
// from the terrain the renderer already holds. Pure maths (no three.js, no audio), so the
// numbers can be checked in a test; audio.js turns them into levels (setPlace, footfalls).
//
//   SHORE    metres from each tile to the nearest water (sea or lake), by a breadth-first
//            flood from every water tile. One byte a tile, capped at SHORE_REACH.
//   CANOPY   standing trees per CANOPY_CELL-metre cell, refreshed when the tile sync says
//            the trees changed (felled, burnt, regrown).
//   GROUND   the footfall surface for a point: water, sand, rock, snow or grass.
import { TILE, TILE_STATE, isWater } from '../sim/terrain/tiles.js';

export const SHORE_REACH = 60;      // metres inland at which the surf is gone
const CANOPY_CELL = 8;
const CANOPY_FULL = 9;              // trees in a cell that count as a closed canopy

export function createSoundscape(terrain) {
  const size = terrain.size; const type = terrain.type;
  const shore = new Uint8Array(size * size).fill(255);
  // Breadth-first from every water tile: the first time a tile is reached is its distance.
  let frontier = [];
  for (let t = 0; t < size * size; t++) if (isWater(type[t])) { shore[t] = 0; frontier.push(t); }
  for (let d = 1; d <= SHORE_REACH && frontier.length; d++) {
    const next = [];
    for (const t of frontier) {
      const x = t % size; const z = (t / size) | 0;
      if (x > 0 && shore[t - 1] === 255) { shore[t - 1] = d; next.push(t - 1); }
      if (x < size - 1 && shore[t + 1] === 255) { shore[t + 1] = d; next.push(t + 1); }
      if (z > 0 && shore[t - size] === 255) { shore[t - size] = d; next.push(t - size); }
      if (z < size - 1 && shore[t + size] === 255) { shore[t + size] = d; next.push(t + size); }
    }
    frontier = next;
  }

  const side = Math.ceil(size / CANOPY_CELL);
  const canopy = new Uint8Array(side * side);
  // Where the lakes are: every few lake tiles, enough to say how near one is.
  const lakes = [];
  for (let t = 0, n = 0; t < size * size; t++) if (type[t] === TILE.LAKE && n++ % 5 === 0) lakes.push([(t % size) + 0.5, ((t / size) | 0) + 0.5]);

  const tileOf = (x, z) => {
    const cx = x < 0 ? 0 : x >= size ? size - 1 : x | 0;
    const cz = z < 0 ? 0 : z >= size ? size - 1 : z | 0;
    return cz * size + cx;
  };

  return {
    /**
     * Count the standing trees again. `trees` is the tile list, `treeState[i]` the tile
     * sync's state for tree i and `standing` the value that means it is up (TREE_STATE.STANDING).
     */
    setTrees(trees, treeState = null, standing = 0) {
      canopy.fill(0);
      if (!trees) return;
      for (let i = 0; i < trees.length; i++) {
        if (treeState && treeState[i] !== standing) continue;
        const t = trees[i];
        const c = (((t / size) | 0) / CANOPY_CELL | 0) * side + ((t % size) / CANOPY_CELL | 0);
        if (canopy[c] < 255) canopy[c]++;
      }
    },
    /** The nearest lake point to (x, z): `{ x, z, distance }`, or null on an island with no lake. */
    nearestLake(x, z) {
      let best = null; let bd = Infinity;
      for (const l of lakes) { const d = (l[0] - x) ** 2 + (l[1] - z) ** 2; if (d < bd) { bd = d; best = l; } }
      return best ? { x: best[0], z: best[1], distance: Math.sqrt(bd) } : null;
    },
    /** Metres to the nearest water, capped at SHORE_REACH; 0 on (or off the edge into) water. */
    shoreDistance(x, z) {
      if (x < 0 || z < 0 || x >= size || z >= size) return 0;
      const d = shore[tileOf(x, z)];
      return d === 255 ? SHORE_REACH : d;
    },
    /** 1 at the waterline, 0 from SHORE_REACH inland. */
    shore(x, z) { return 1 - this.shoreDistance(x, z) / SHORE_REACH; },
    /** 0..1: how closed the canopy is around a point (the cell and its four neighbours). */
    canopy(x, z) {
      const cx = Math.max(0, Math.min(side - 1, (x / CANOPY_CELL) | 0)); const cz = Math.max(0, Math.min(side - 1, (z / CANOPY_CELL) | 0));
      let n = canopy[cz * side + cx] * 2; let w = 2;
      if (cx > 0) { n += canopy[cz * side + cx - 1]; w++; }
      if (cx < side - 1) { n += canopy[cz * side + cx + 1]; w++; }
      if (cz > 0) { n += canopy[(cz - 1) * side + cx]; w++; }
      if (cz < side - 1) { n += canopy[(cz + 1) * side + cx]; w++; }
      return Math.min(1, n / w / CANOPY_FULL);
    },
    /** Is the tile under a point water? (Off the map is sea.) */
    isWater(x, z) { return x < 0 || z < 0 || x >= size || z >= size || isWater(type[tileOf(x, z)]); },
    /**
     * The footfall surface under a point: 'water' | 'sand' | 'rock' | 'snow' | 'grass'.
     * `snow` is the renderer's 0..1 cover; `tileState` the last tile sync (cooled lava is rock).
     */
    ground(x, z, y, snow = 0, tileState = null) {
      const t = tileOf(x, z);
      const k = type[t];
      if (isWater(k) || y < 0.06) return 'water';
      if (snow > 0.45) return 'snow';
      if (k === TILE.BEACH) return 'sand';
      if (k === TILE.MOUNTAIN || k === TILE.VOLCANO || (tileState && (tileState[t] === TILE_STATE.COOLED || tileState[t] === TILE_STATE.BOULDER))) return 'rock';
      return 'grass';
    },
  };
}
