// maps.js — the single combined marble-race track ("Grand Circuit") and the track interface
// the game speaks to.
//
// Grand Circuit (slot 7) fuses the signature best sections of all four previous courses into one
// continuous, strictly-descending, non-trapping mega-track:
//   · Spiral Works   — banked opening helix, brake strip before the split, physical split-lane island
//   · Neon Canyon    — wet reflective neon night, boost pads, 9-row plinko, kickers, pendulums, double Gauntlet
//   · Grand Spiral   — washboard ridges, wide vortex funnel bowl + neck pinch, steep free-fall plunge
//   · Playground Run — enclosed drop tunnel (with boxed-in reverb zone) into the glossy big slide & wide finish tray
//
// Slots 1-6 remain recognized on the server (MarbleRaceRunVerifier.cs) for legacy records only.
import * as THREE from 'three-eco/webgpu';
import { generateTrack } from './track-procedural.js';

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

// ── Grand Circuit: the one unified mega-track ───────────────────────────────────────────────
// Combines the signature set-pieces of every previous track into one non-trapping 2,800-unit run:
//   0.00–0.21  Spiral Works   — banked opener, brake strip, physical split-lane island + boost
//   0.22–0.52  Neon Canyon    — 9-row plinko, telegraphed kickers, rumble, boost, pendulum bobs
//   0.52–0.69  Grand Spiral   — washboard ridges, wide vortex funnel bowl + pinch, free-fall plunge
//   0.70–0.86  Playground Run — enclosed drop tunnel (reverb zone) into the glossy slide & turnstiles
//   0.86–1.00  Grand Finale   — final boost launch into the double kinematic Gauntlet & wide finish tray
const GRAND_CIRCUIT = {
  track: { LENGTH: 2800, DROP: 1120, START_Y: 240, CHANNEL_WIDTH: 58, SEGMENTS: 780 },
  zones: {
    BRAKE: [[0.085, 0.115, 50]],
    SPLITS: [{ from: 0.125, to: 0.205, widthFrac: 0.20 }],
    BOOST: [[0.145, 0.175], [0.41, 0.435], [0.775, 0.80], [0.865, 0.885]],
    PLINKO: { from: 0.22, to: 0.33, rows: 9 },
    KICKERS: [0.345, 0.365],
    RUMBLE: [[0.375, 0.40], [0.585, 0.605]],
    BOBS: { from: 0.445, to: 0.515, step: 0.035 },
    RIDGES: { from: 0.525, to: 0.575, step: 0.025 },
    TUNNELS: [{ from: 0.695, to: 0.765 }],
    SLIDE: [0.77, 0.82],
    TURNSTILES: { from: 0.815, to: 0.855, step: 0.02 },
    GAUNTLET: { from: 0.89, to: 0.94, step: 0.016 },
    FINISH: [0.945, 1.0],
  },
  // Vortex funnel bowl (0.61) + wide finish tray (0.975)
  flares: [
    { c: 0.61, w: 0.03, d: 0.42 },
    { c: 0.975, w: 0.035, d: 0.35 },
  ],
  // Funnel neck pinch (0.65) + pre-gauntlet squeeze (0.86)
  pinches: [
    { c: 0.39, w: 0.03, d: 0.35 },
    { c: 0.65, w: 0.028, d: 0.52 },
    { c: 0.86, w: 0.025, d: 0.36 },
  ],
  // Grand Spiral free-fall waterfall drop out of the funnel neck into Playground's drop tunnel
  plunges: [{ c: 0.675, w: 0.015, drop: 90 }],
  curve: 1.12,
};

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
    blurb: 'All-in-one mega-track: split-lane helix, neon plinko & pendulums, vortex funnel plunge, drop tunnel slide, and double Gauntlet.',
    // Neon twilight with wet reflective tarmac and warm highlight bounce.
    theme: {
      bg: 0x0b1024, fogNear: 90, fogFar: 360,
      ambient: [0xb4b0d8, 2.7], hemi: [0xc4a8ff, 0x2a1824, 1.8], key: [0xffe8cc, 3.0], exposure: 1.1,
      reflect: true,
    },
    // Open canyon slapback echo that tightens into Playground Run's enclosed tunnel acoustics.
    reverb: {
      decay: 1.8, wet: 0.25, tone: 4400,
      echo: { time: 0.30, feedback: 0.28, level: 0.36 },
      zones: [{ from: 0.695, to: 0.765, wet: 0.45, tone: 2200 }],
    },
    load: () => Promise.resolve(null),
    build: (world, materials, marbleCount, _asset, seed) =>
      addCheckpointArches(adaptProceduralTrack(generateTrack(world, materials, seed >>> 0, marbleCount, GRAND_CIRCUIT))),
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
