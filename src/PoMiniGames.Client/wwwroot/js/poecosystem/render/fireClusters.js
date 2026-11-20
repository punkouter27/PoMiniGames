// fireClusters.js — where the island is burning, as a handful of places.
//
// A firestorm is up to 400 burning tiles and a lava flow dozens more. Nothing that reacts to
// fire can afford one of itself per tile: not a light (every lit pixel pays for every light),
// not a sound (a voice is a panner and a filter chain). So the burning and molten tiles the
// renderer already lists on each tile sync are gathered into a few GROUPS, and the lights
// (fireLights.js) and the fire's voice (audio.js setFires) are parked on those.
//
// Pure maths, no three.js and no DOM, so it can be unit-driven.
//
//   GROUPS   tiles are bucketed on a CELL-metre grid; a bucket is one group at the mean of
//            its tiles. Lava and fire are kept apart: they light and sound differently.
//   CHOICE   the `max` groups that matter most to someone standing at `at`: big and near
//            beats small and far (size / (1 + distance / FALLOFF)).
//   SLOTS    `assignSlots` keeps a group in the slot it had last time, matched by distance,
//            so a light does not hop between two fires because their scores swapped.

const CELL = 14;          // metres per bucket: a group is roughly a clearing's worth of fire
const FALLOFF = 40;       // metres at which a group counts half as much
const SAME_PLACE = 16;    // a group this close to a slot's last place keeps the slot

/**
 * @param {{x:number,y:number,z:number}[]} fireTiles burning tiles (the campfire may be among them)
 * @param {{x:number,y:number,z:number}[]} lavaTiles molten tiles
 * @param {{x:number,y:number,z:number}} at the listener / camera
 * @param {{ max?: number, campfire?: object|null, isWater?: (x:number, z:number) => boolean }} [o]
 *   `campfire` is the tile object that is the tribe's hearth (kept as its own small group);
 *   `isWater` marks a lava group that touches water, which is where lava hisses.
 * @returns {{x:number,y:number,z:number,size:number,lava:boolean,camp:boolean,steam:boolean,score:number}[]}
 */
export function clusterFires(fireTiles, lavaTiles, at, { max = 4, campfire = null, isWater = null } = {}) {
  const buckets = new Map();
  const add = (t, lava) => {
    const camp = t === campfire;
    const key = camp ? 'camp' : `${lava ? 'L' : 'F'}:${Math.floor(t.x / CELL)}:${Math.floor(t.z / CELL)}`;
    let b = buckets.get(key);
    if (!b) { b = { x: 0, y: 0, z: 0, size: 0, lava, camp, steam: false }; buckets.set(key, b); }
    b.x += t.x; b.y += t.y; b.z += t.z; b.size++;
    if (lava && !b.steam && isWater && (isWater(t.x + 1, t.z) || isWater(t.x - 1, t.z) || isWater(t.x, t.z + 1) || isWater(t.x, t.z - 1))) b.steam = true;
  };
  for (const t of fireTiles ?? []) add(t, false);
  for (const t of lavaTiles ?? []) add(t, true);

  const groups = [];
  for (const b of buckets.values()) {
    b.x /= b.size; b.y /= b.size; b.z /= b.size;
    const d = Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z);
    // A hearth is one tile and always a small fire, however near.
    b.score = (b.camp ? 0.6 : b.size * (b.lava ? 1.3 : 1)) / (1 + d / FALLOFF);
    b.dist = d;
    groups.push(b);
  }
  groups.sort((p, q) => q.score - p.score);
  return groups.slice(0, max);
}

/**
 * Put `groups` into `slots` (an array of `{ x, y, z, group }`, mutated): a group near where
 * a slot already is keeps that slot, the rest fill the free ones, and a slot with no group
 * gets `group = null` (and keeps its last position, so whatever lives there can fade out
 * in place).
 */
export function assignSlots(slots, groups) {
  const free = new Set(slots.keys());
  const left = [];
  for (const s of slots) s.next = null;
  for (const g of groups) {
    let best = -1; let bestD = SAME_PLACE;
    for (const i of free) {
      const s = slots[i];
      if (!s.group) continue;
      const d = Math.hypot(s.x - g.x, s.z - g.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { slots[best].next = g; free.delete(best); } else left.push(g);
  }
  for (const g of left) {
    const i = free.values().next().value;
    if (i === undefined) break;
    slots[i].next = g; free.delete(i);
  }
  for (const s of slots) { s.group = s.next; s.next = null; }
  return slots;
}
