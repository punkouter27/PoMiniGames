// gantry.js — the start gantry (#4): a frame over the road just ahead of the grid with three
// lamps that light red one by one through the countdown and all go green on GO. It replaces the
// three DOM dots the pre-race card used to carry: the lights are now IN the shot, they glow through
// the bloom, and on GO they wash the front of the grid green for a beat.
//
// Emissive meshes only (no lights added: a light count change recompiles every lit material); the
// green wash on GO borrows one of scene.js's pooled impact-light pulses.
import * as THREE from 'three-eco/webgpu';

const RED = new THREE.Color(1, 0.12, 0.08);
const GREEN = new THREE.Color(0.2, 1, 0.38);
const OFF = new THREE.Color(0.09, 0.1, 0.12);
const LAMP_GLOW = 7;          // emissive intensity of a lit lamp (well past the bloom threshold)
const LAMP_GAP = 4.2;         // lamp spacing across the beam
const BEAM_H = 15;            // beam height over the road
const AHEAD = 14;             // units past the front row of the grid

/**
 * Build the gantry for `track` (the track interface in maps.js). Returns null if the track lacks
 * what it needs. `startPositions` place it just past the front row.
 */
export function createGantry(track) {
  if (!track || !track.centerAt || !track.dirAt || !track.rightAt || !track.upAt) return null;
  const c0 = track.centerAt(0, new THREE.Vector3());
  const d0 = track.dirAt(0, new THREE.Vector3());
  let front = 0;
  for (const p of track.startPositions || []) {
    const along = (p.x - c0.x) * d0.x + (p.y - c0.y) * d0.y + (p.z - c0.z) * d0.z;
    if (along > front) front = along;
  }
  const s = Math.min(track.length * 0.2, front + AHEAD);
  const c = track.centerAt(s, new THREE.Vector3());
  const d = track.dirAt(s, new THREE.Vector3());
  const r = track.rightAt(s, new THREE.Vector3());
  const u = track.upAt(s, new THREE.Vector3());
  const hw = (track.halfWidthAt ? track.halfWidthAt(s) : 26) + 2;

  const group = new THREE.Group();
  group.name = 'StartGantry';
  const basis = new THREE.Matrix4().makeBasis(r, u, d);
  group.quaternion.setFromRotationMatrix(basis);
  group.position.copy(c);

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.5, metalness: 0.6 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.35, metalness: 0.2, emissive: 0x38bdf8, emissiveIntensity: 0.6 });
  const geos = [];
  const box = (w, h, dd, mat, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, dd);
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  // posts, beam, a lit trim along the beam's underside, and the lamp housing
  box(1.4, BEAM_H + 2, 1.4, frameMat, -hw, (BEAM_H + 2) / 2, 0);
  box(1.4, BEAM_H + 2, 1.4, frameMat, hw, (BEAM_H + 2) / 2, 0);
  box(hw * 2 + 1.4, 1.8, 1.8, frameMat, 0, BEAM_H + 1.2, 0);
  box(hw * 2 - 1, 0.18, 0.3, trimMat, 0, BEAM_H + 0.25, -0.8);
  box(LAMP_GAP * 3 + 1.6, 4.4, 1.2, frameMat, 0, BEAM_H - 1.6, -0.2);

  // three lamps facing back up the grid (toward the camera on the start overview)
  const lampGeo = new THREE.CylinderGeometry(1.45, 1.45, 0.5, 28);
  lampGeo.rotateX(Math.PI / 2);
  geos.push(lampGeo);
  const lamps = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.25, metalness: 0, emissive: OFF.clone(), emissiveIntensity: 1 });
    const m = new THREE.Mesh(lampGeo, mat);
    m.position.set((i - 1) * LAMP_GAP, BEAM_H - 1.6, -0.95);
    group.add(m);
    lamps.push({ mesh: m, mat, glow: 0, target: 0, color: OFF.clone() });
  }

  let lit = 0;            // lamps lit red
  let goT = 0;            // seconds since GO, for the fade back to dark
  let isGo = false;

  /** `n` lamps red (0..3), or every lamp green when `go`. */
  function set(n, go = false) {
    lit = Math.max(0, Math.min(3, n | 0));
    isGo = !!go;
    goT = 0;
    lamps.forEach((l, i) => {
      if (isGo) { l.color.copy(GREEN); l.target = LAMP_GLOW * 1.2; }
      else if (i < lit) { l.color.copy(RED); l.target = LAMP_GLOW; }
      else { l.color.copy(OFF); l.target = 1; }
    });
  }

  function update(dt) {
    if (isGo) {
      goT += dt;
      // green holds a beat, then the gantry goes dark for the race
      if (goT > 2.2) lamps.forEach((l) => { l.target = 1; l.color.lerp(OFF, 1 - Math.exp(-3 * dt)); });
    }
    for (const l of lamps) {
      // a lit lamp snaps on (incandescent punch); going dark fades
      const rate = l.target > l.glow ? 30 : 5;
      l.glow += (l.target - l.glow) * (1 - Math.exp(-rate * dt));
      l.mat.emissive.copy(l.color);
      l.mat.emissiveIntensity = l.glow;
    }
  }

  /** Where the lamps are, for the GO light pulse. */
  const lampWorld = new THREE.Vector3(0, BEAM_H - 4, -3).applyQuaternion(group.quaternion).add(group.position);

  return {
    group,
    set,
    update,
    get lit() { return lit; },
    lampWorld,
    dispose() {
      group.removeFromParent();
      for (const g of geos) g.dispose();
      frameMat.dispose(); trimMat.dispose();
      for (const l of lamps) l.mat.dispose();
    },
  };
}
