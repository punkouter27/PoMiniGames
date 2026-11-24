// maps.js — the single marble-race map ("Grand Circuit") and the track interface the game
// speaks to.
//
// Grand Circuit is ONE map whose course is dealt fresh every race from the race seed: composer.js
// picks a theme and a shuffled run of set-pieces, track-procedural.js builds it. A seed always
// deals the same course, so an online host and guest (who share the seed) race the same one.
//
// Slots 1-6 remain recognized on the server (MarbleRaceRunVerifier.cs) for legacy records only.
import * as THREE from 'three-eco/webgpu';
import { generateTrack } from './track-procedural.js';
import { composeCourse } from './composer.js';

/**
 * A fresh, zeroed projection record for a caller to own and reuse. `lane`/`ring`/`hw`/`reach`
 * are kept on the shape so callers stay uniform.
 */
export const newProjection = () => ({ s: 0, index: -1, lateral: 0, height: 0, lane: -1, ring: 0, hw: 0, reach: 0 });

// ── procedural adapter ──────────────────────────────────────────────────────────────────────
// The procedural chute predates the interface above and speaks in world +Z. Because it descends
// monotonically in +Z, `s` and `z` are the same number, so this adapter is a thin translation
// rather than a reimplementation — and the original generator is left exactly as it was.
const _c = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();
// Second right-vector scratch: upAt() derives up FROM right, and its caller may be holding
// _r as its own result at the time — sharing one scratch across both would clobber it.
const _r2 = new THREE.Vector3();

// How far beneath the floor plane a marble may sit before it counts as off the chute. The
// original test was `y < floorY(z) - 58` in WORLD space; in the local frame the banking is
// already accounted for, so the margin only has to cover a hard bounce.
const PROC_OOB_DROP = 34;
const PROC_OOB_LATERAL = 26;

function adaptProceduralTrack(t) {
  // The generator's own right vector points the WRONG WAY for this interface, and this is
  // where that gets corrected.
  //
  // Every consumer of the interface — steering, the lateral sign, the edge gauge — assumes
  // right = dir x up, which is the same vector a chase camera renders as screen-right, and is
  // what both baked GLB courses store. The chute's generator instead derives its basis as
  // `(1,0,0)` rotated by the quaternion that takes +Z onto dir, which is -(dir x up): with the
  // marble running down +Z that is world +X, and a camera looking down +Z renders +X to
  // screen-LEFT. So the right arrow key pushed the marble left, and only on this map.
  //
  // The fix lands here rather than in the generator because `rb` is also the basis every wall,
  // kerb and obstacle is placed along; negating it there would mirror the whole course. The
  // adapter already exists to translate this map's older conventions, so it translates one more.
  //
  // This is also what made the sibling `upAt` below wrong: right x dir recovers up only for a
  // right-handed basis, and with the generator's vector it returned -up, which put a sign error
  // straight into `height`, isOutOfBounds and floorPoint.
  const rightAt = (s, out) => (out || _r).copy(t.rightAt(s)).negate();

  // up = right x dir. The generator publishes dir and right but not up, and for a right-handed
  // basis where right = dir x up, that cross product recovers up exactly.
  const upAt = (s, out) => {
    const d = t.dirAt(s);
    return (out || _u).copy(rightAt(s, _r2)).cross(d).normalize();
  };
  const halfWidthAt = (s) => t.halfWidthAt(s);

  return {
    group: t.group,
    startPositions: t.startPositions,
    length: t.length,
    finishS: t.finishZ,
    overviewTarget: t.overviewTarget,
    paddles: t.turnstiles,
    kickers: t.kickers,
    regenerate: true,

    project(pos, hint, out) {
      const o = out || newProjection();
      const s = Math.max(0, Math.min(t.length, pos.z));
      const c = t.centerAt(s), r = rightAt(s, _r);
      upAt(s, _u);
      const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
      o.s = s;
      o.index = 0;                                     // no hint needed: the lookup is O(1)
      o.lateral = dx * r.x + dy * r.y + dz * r.z;
      o.height = dx * _u.x + dy * _u.y + dz * _u.z;
      return o;
    },

    centerAt: (s, out) => (out ? out.copy(t.centerAt(s)) : t.centerAt(s)),
    dirAt: (s, out) => (out ? out.copy(t.dirAt(s)) : t.dirAt(s)),
    rightAt: (s, out) => rightAt(s, out),
    upAt,
    halfWidthAt,
    lateralOf: (proj) => Math.max(-1.4, Math.min(1.4, proj.lateral / Math.max(1, halfWidthAt(proj.s)))),
    isOutOfBounds: (proj) =>
      proj.height < -PROC_OOB_DROP || Math.abs(proj.lateral) > halfWidthAt(proj.s) + PROC_OOB_LATERAL,
    floorPoint: (pos, proj, out) => {
      upAt(proj.s, _u);
      return out.set(pos.x, pos.y, pos.z).addScaledVector(_u, -proj.height + 0.06);
    },
    // Where a respawned marble goes back on (course.js _respawn): above the centre of the floor.
    respawnPoint: (safe, lift, out) => out.copy(t.centerAt(safe.s)).addScaledVector(upAt(safe.s, _u), lift),
    inBoost: (s) => t.inBoost(s),
    brakeAt: t.brakeAt ? (s) => t.brakeAt(s) : undefined,
    checkpoints: t.checkpoints,
    // Set-pieces and surfaces (composer.js deals them). Their lateral values are already in
    // this interface's sign; see track-procedural.js.
    trampolines: t.trampolines,
    conveyors: t.conveyors,
    magnets: t.magnets,
    flume: t.flume,
    surfaceAt: t.surfaceAt,
    driveMotors: () => t.driveMotors(),
    dispose: () => t.dispose(),
  };
}

// ── checkpoint arches ──
// A glowing half-hoop standing over the channel at each checkpoint: where the course branches on
// the authored maps, at each hazard zone on the procedural ones. Purely visual — game.js reads the
// same `checkpoints` list for the sector splits. Built from the track interface alone, so every
// map gets them. The hoop is squashed to at most ARCH_H tall so a 100-wide channel does not grow
// a 50-high arch through the containment lid.
const ARCH_H = 16;
let _archMat = null;
function addCheckpointArches(track) {
  if (!track.checkpoints || !track.checkpoints.length) return track;
  _archMat = _archMat || new THREE.MeshStandardMaterial({
    color: 0x7c3aed, emissive: 0xa855f7, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.1,
  });
  const c = new THREE.Vector3(), d = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  for (const s of track.checkpoints) {
    const hw = track.halfWidthAt(s) + 1;
    track.centerAt(s, c); track.dirAt(s, d); track.rightAt(s, r); track.upAt(s, u);
    // Half torus in its local XY plane: X across the channel, Y up, Z along the track.
    const arch = new THREE.Mesh(new THREE.TorusGeometry(hw, 0.7, 8, 40, Math.PI), _archMat);
    basis.makeBasis(r, u, d);
    arch.quaternion.setFromRotationMatrix(basis);
    arch.scale.set(1, Math.min(1, ARCH_H / hw), 1);
    arch.position.copy(c);
    arch.name = 'CheckpointArch';
    track.group.add(arch);
  }
  return track;
}

// ── Grand Circuit: one map, a new course every race ─────────────────────────────────────────
// The single map deals its course from the race seed (composer.js): a theme and a shuffled run of
// set-pieces — split lanes, plinko, kickers, pendulums, washboard, vortex funnel, drop tunnel,
// turnstiles, trampolines, see-saws, conveyors, magnets, ice, sand and a water flume — between a
// fixed start and the fixed Gauntlet finale. The length never changes (the server's run check
// knows it), so only what is on the course does.

/** Today's UTC day as yyyy-MM-dd (retained for store.js compatibility). */
export const dailyKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** The course seed for a day key (FNV-1a over its characters). */
export function dailySeed(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const MAPS = [
  {
    id: 7,
    name: 'Grand Circuit',
    blurb: 'A new course every race: a random theme and a shuffled run of set-pieces — plinko, pendulums, trampolines, see-saws, magnets, ice, sand, a water flume and more — down to the Gauntlet.',
    // The fallback look; every built course carries its own theme (track.theme, composer.js).
    theme: {
      bg: 0x0b1024, fogNear: 90, fogFar: 360,
      ambient: [0xb4b0d8, 2.7], hemi: [0xc4a8ff, 0x2a1824, 1.8], key: [0xffe8cc, 3.0], exposure: 1.1,
      reflect: true,
    },
    // Open-air slapback; a drop tunnel, when one is dealt, adds its own boxed-in zone
    // (track.reverbZones).
    reverb: {
      decay: 1.8, wet: 0.25, tone: 4400,
      echo: { time: 0.30, feedback: 0.28, level: 0.36 },
      zones: [],
    },
    load: () => Promise.resolve(null),
    build: (world, materials, marbleCount, _asset, seed) => {
      const course = composeCourse(seed >>> 0);
      const track = adaptProceduralTrack(generateTrack(world, materials, seed >>> 0, marbleCount, course.variant));
      track.theme = course.theme;
      track.acts = course.acts;
      track.reverbZones = course.reverbZones;
      track.courseName = course.name;
      track.courseSub = course.sub;
      track.pieces = course.pieces;
      track.spans = course.spans;
      return addCheckpointArches(track);
    },
  },
];

/** The slot the game opens on (the one unified Grand Circuit). */
export const DEFAULT_MAP_ID = 7;

/** Look a map up by slot id, falling back to Grand Circuit rather than throwing. */
export function mapById(id) {
  return MAPS.find((m) => m.id === Number(id)) || MAPS[0];
}

/** Slot ids and names (single entry: Grand Circuit). */
export function mapMenu() {
  return MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb, daily: !!m.daily }));
}
