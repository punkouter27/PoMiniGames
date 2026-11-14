// acousticsProbe.js — the world geometry, as the audio graph needs to see it.
//
// audio.js knows nothing about voxels; it asks this probe three questions:
//   occlusion(from, to)   how much solid matter lies on the straight line from the listener
//                         to a sound (0 = clear, 1 = behind a wall). Drives the per-voice
//                         muffle (#13).
//   reflections(from)     distances to the nearest surfaces in six fixed directions. Drives
//                         the early-reflection taps (#14): a narrow gate answers back fast
//                         and loud, an open field barely at all.
//   altitude(p)           height above the ground under p. Drives the wind bed (#18).
//
// Every ray is coarse on purpose. Sound diffracts round anything smaller than its
// wavelength, so a 2 m terrain step and the structures' own voxel DDA are already more
// precise than the ear. Structures are rejected by bounding sphere before any march.

import * as THREE from 'three';

const TERRAIN_STEP_M = 2;
const REFLECT_MAX_M = 48;

// Fixed probe directions: the four horizontal compass points, straight up, and one
// downward diagonal for the floor bounce. World-fixed, not camera-fixed — the taps are
// placed in the world with panners, so turning your head turns the echoes with the room.
const DIRS = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.6, -0.8, 0).normalize(),
];

export class AcousticProbe {
  constructor(terrain, structures) {
    this.terrain = terrain;
    this.structures = structures;
    this._dir = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._out = DIRS.map(() => ({ x: 0, y: 0, z: 0, d: -1 }));
  }

  /** Height of p above the terrain directly under it (never negative). */
  altitude(p) {
    return Math.max(0, p.y - this.terrain.heightAt(p.x, p.z));
  }

  /** 0..1: a building in the way muffles fully, a hill crest most of the way. */
  occlusion(from, to) {
    const dir = this._dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = dir.length();
    if (len < 1.5) return 0;
    dir.divideScalar(len);
    // Stop short of the source: the thing making the noise is usually touching a wall.
    const reach = len - 1.2;
    if (this._structureHit(from, dir, reach) !== null) return 1;
    return this._terrainHit(from, dir, reach) !== null ? 0.7 : 0;
  }

  /**
   * Nearest surface in each probe direction. Reuses one output array: callers read it
   * immediately. d = -1 means nothing within range (no echo from that side).
   */
  reflections(from) {
    for (let i = 0; i < DIRS.length; i++) {
      const dir = DIRS[i];
      let d = this._structureHit(from, dir, REFLECT_MAX_M);
      const t = dir.y > 0.5 ? null : this._terrainHit(from, dir, d ?? REFLECT_MAX_M);
      if (t !== null && (d === null || t < d)) d = t;
      const o = this._out[i];
      o.d = d ?? -1;
      if (d !== null) {
        o.x = from.x + dir.x * d; o.y = from.y + dir.y * d; o.z = from.z + dir.z * d;
      }
    }
    return this._out;
  }

  _structureHit(origin, dir, reach) {
    let best = null;
    for (const s of this.structures) {
      if (!s?.group || typeof s.raycast !== 'function') continue;
      // Segment-vs-bounding-sphere reject: the DDA is not free and most buildings are
      // nowhere near the line.
      const c = s.group.position;
      const r = Math.max(s.dims[0], s.dims[1], s.dims[2]) * s.scale * 0.9;
      const cx = c.x - origin.x, cy = c.y - origin.y, cz = c.z - origin.z;
      const along = THREE.MathUtils.clamp(cx * dir.x + cy * dir.y + cz * dir.z, 0, reach);
      const px = cx - dir.x * along, py = cy - dir.y * along, pz = cz - dir.z * along;
      if (px * px + py * py + pz * pz > r * r) continue;
      const hit = s.raycast(origin, dir, reach);
      if (hit && hit.distance <= reach && (best === null || hit.distance < best)) best = hit.distance;
    }
    return best;
  }

  _terrainHit(origin, dir, reach) {
    const p = this._p;
    for (let t = TERRAIN_STEP_M; t <= reach; t += TERRAIN_STEP_M) {
      p.copy(origin).addScaledVector(dir, t);
      if (p.y <= this.terrain.heightAt(p.x, p.z)) return t;
    }
    return null;
  }
}
