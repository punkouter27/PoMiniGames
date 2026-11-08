// physics.js — the simulation's units, materials and world factory.
//
// Everything in this game is now in SI: metres, kilograms, seconds, newtons, pascals.
// It was not before, and the three things that were wrong compounded into rubble that
// behaved like polystyrene:
//
//   * gravity was −20 m/s², twice Earth;
//   * debris mass was computed as volume × density and then DIVIDED BY 100, so every
//     falling chunk weighed 1 % of what it should, and was additionally capped at 500 kg
//     — a cap a single cubic metre of stone already exceeds;
//   * every material had the same 600 kg/m³ density, so slate, plaster and oak were
//     indistinguishable.
//
// The .pvx format has always carried per-material density, compressive and tensile
// strength, and every builtin volume declares them. Nothing read them. They are the
// input to the stress solver and the mass calculation now.
//
// Contact behaviour was the other half: the world had ZERO ContactMaterials, so stone,
// timber, soil and the player all shared cannon's default (friction 0.3, restitution 0).
// That is why rubble slid forever instead of grinding to a halt.

import * as CANNON from 'cannon-es';

export const GRAVITY = 9.81;              // m/s², positive magnitude
export const PHYSICS_STEP = 1 / 60;

export class VoxelNarrowphase extends CANNON.Narrowphase {
  constructor(world) {
    super(world);
    this.boundsWorld = world;
    this.boundsCache = new WeakMap();
    this.terrainPosition = new CANNON.Vec3();
    this.terrainRotation = new CANNON.Quaternion();
    this.terrainLower = new CANNON.Vec3();
    this.terrainUpper = new CANNON.Vec3();
    this.pillarPosition = new CANNON.Vec3();
    this.terrainHeights = [];
    this.terrainFaces = [0];
    this.separationCache = new WeakMap();
    this.axisProjectionA = [];
    this.axisProjectionB = [];
    this.preparedBoxes = new WeakSet();
    this.boxProjections = new WeakMap();
    this.projectionAxis = new CANNON.Vec3();
    this.projectionZero = new CANNON.Vec3();
  }

  _prepareBox(shape, originalShape) {
    if (originalShape?.type !== CANNON.Shape.types.BOX || this.preparedBoxes.has(shape)) return;
    // SAT needs edge directions, not both signs of each direction. Cannon boxes
    // retain six signed edges and repeat the same nine cross axes four times.
    shape.uniqueEdges = shape.uniqueEdges.filter((edge, index, edges) =>
      !edges.slice(0, index).some(previous =>
        edge.x === -previous.x && edge.y === -previous.y && edge.z === -previous.z));
    this.boxProjections.set(shape, { half: originalShape.halfExtents, origin: new CANNON.Vec3() });
    shape.testSepAxis = this._testBoxAxis.bind(this, shape);
    this.preparedBoxes.add(shape);
  }

  _project(shape, axis, position, rotation, output) {
    const cached = this.boxProjections.get(shape);
    if (!cached) {
      CANNON.ConvexPolyhedron.project(shape, axis, position, rotation, output);
      return;
    }
    if (cached.x !== position.x || cached.y !== position.y || cached.z !== position.z
      || cached.qx !== rotation.x || cached.qy !== rotation.y
      || cached.qz !== rotation.z || cached.qw !== rotation.w) {
      CANNON.Transform.pointToLocalFrame(position, rotation, this.projectionZero, cached.origin);
      cached.x = position.x; cached.y = position.y; cached.z = position.z;
      cached.qx = rotation.x; cached.qy = rotation.y;
      cached.qz = rotation.z; cached.qw = rotation.w;
    }
    CANNON.Transform.vectorToLocalFrame(position, rotation, axis, this.projectionAxis);
    // These are exactly the extreme dot products of a box's eight corners.
    const radius = Math.abs(this.projectionAxis.x) * cached.half.x
      + Math.abs(this.projectionAxis.y) * cached.half.y
      + Math.abs(this.projectionAxis.z) * cached.half.z;
    const offset = cached.origin.dot(this.projectionAxis);
    output[0] = radius - offset;
    output[1] = -radius - offset;
  }

  _testBoxAxis(shape, axis, other, positionA, rotationA, positionB, rotationB) {
    this._project(shape, axis, positionA, rotationA, this.axisProjectionA);
    this._project(other, axis, positionB, rotationB, this.axisProjectionB);
    const [maxA, minA] = this.axisProjectionA;
    const [maxB, minB] = this.axisProjectionB;
    if (maxA < minB || maxB < minA) return false;
    return Math.min(maxA - minB, maxB - minA);
  }

  _bounds(shape, position, rotation, body) {
    let entry = this.boundsCache.get(body);
    if (!entry) {
      entry = {
        shapes: new WeakMap(),
        cachedGeometry: body.type === CANNON.Body.STATIC
          && (body.voxelBoundsStatic === true
            || (body.shapes[0]?.type === CANNON.Shape.types.HEIGHTFIELD
              && body.shapes[0].cacheEnabled)),
      };
      this.boundsCache.set(body, entry);
    }
    const shapes = entry.shapes;
    let cached = shapes.get(shape);
    if (!cached) {
      cached = { lower: new CANNON.Vec3(), upper: new CANNON.Vec3(), step: -1 };
      shapes.set(shape, cached);
    }
    // Cannon reuses convex shapes (including cached terrain pillars). A body/shape
    // pair may also appear at multiple compound offsets within the same step.
    // Heightfield.update() replaces cached pillar objects after a dig, so their
    // identity also invalidates these bounds without retransforming every still
    // unchanged pillar on every physics step. Structure rebuilds likewise replace
    // their explicitly immutable collider bodies after a carve.
    if ((!entry.cachedGeometry && cached.step !== this.boundsWorld.stepnumber)
      || cached.x !== position.x || cached.y !== position.y || cached.z !== position.z
      || cached.qx !== rotation.x || cached.qy !== rotation.y
      || cached.qz !== rotation.z || cached.qw !== rotation.w) {
      shape.calculateWorldAABB(position, rotation, cached.lower, cached.upper);
      cached.step = this.boundsWorld.stepnumber;
      cached.x = position.x; cached.y = position.y; cached.z = position.z;
      cached.qx = rotation.x; cached.qy = rotation.y;
      cached.qz = rotation.z; cached.qw = rotation.w;
    }
    return cached;
  }

  convexConvex(si, sj, xi, xj, qi, qj, bi, bj, rsi, rsj, justTest, faceListA, faceListB) {
    this._prepareBox(si, rsi);
    this._prepareBox(sj, rsj);
    const a = this._bounds(si, xi, qi, bi);
    const b = this._bounds(sj, xj, qj, bj);
    const margin = 1e-6;
    // Tall terrain pillars have huge bounding spheres: a collapse was testing
    // millions of non-touching pairs with SAT. AABB rejection is conservative;
    // overlapping pairs still use Cannon's unchanged contact and friction solver.
    if (a.lower.x > b.upper.x + margin || a.upper.x < b.lower.x - margin
      || a.lower.y > b.upper.y + margin || a.upper.y < b.lower.y - margin
      || a.lower.z > b.upper.z + margin || a.upper.z < b.lower.z - margin) return false;
    let axes = this.separationCache.get(si);
    const cachedAxis = axes?.get(sj);
    if (cachedAxis && this._separated(cachedAxis, si, sj, xi, xj, qi, qj)) return false;
    const contactCount = this.result?.length;
    const result = super.convexConvex(si, sj, xi, xj, qi, qj, bi, bj, rsi, rsj,
      justTest, faceListA, faceListB);
    // Re-test a previous separating axis before repeating the full SAT search.
    // Every rejection projects the current geometry, so moving/rotating bodies
    // and reshaped terrain cannot turn a cached axis into a missed contact.
    if (result !== true && contactCount === this.result?.length && si.uniqueAxes?.length) {
      const axis = cachedAxis ?? new CANNON.Vec3();
      for (const localAxis of si.uniqueAxes) {
        qi.vmult(localAxis, axis);
        if (!this._separated(axis, si, sj, xi, xj, qi, qj)) continue;
        if (!axes) {
          axes = new WeakMap();
          this.separationCache.set(si, axes);
        }
        axes.set(sj, axis);
        break;
      }
    }
    return result;
  }

  _separated(axis, a, b, positionA, positionB, rotationA, rotationB) {
    this._project(a, axis, positionA, rotationA, this.axisProjectionA);
    this._project(b, axis, positionB, rotationB, this.axisProjectionB);
    const margin = 1e-6;
    return this.axisProjectionA[0] < this.axisProjectionB[1] - margin
      || this.axisProjectionB[0] < this.axisProjectionA[1] - margin;
  }

  convexHeightfield(shape, terrain, position, terrainPosition, rotation, terrainRotation,
    body, terrainBody, rsi, rsj, justTest) {
    this._prepareBox(shape, rsi);
    CANNON.Transform.pointToLocalFrame(terrainPosition, terrainRotation, position, this.terrainPosition);
    terrainRotation.conjugate(this.terrainRotation);
    this.terrainRotation.mult(rotation, this.terrainRotation);
    shape.calculateWorldAABB(this.terrainPosition, this.terrainRotation,
      this.terrainLower, this.terrainUpper);
    const size = terrain.elementSize;
    const radius = shape.boundingSphereRadius;
    const margin = 1e-6;
    // Intersect Cannon's sphere search with the actual footprint. Long, rotated
    // chunks otherwise visit thousands of terrain triangles they cannot touch.
    const startX = Math.max(0,
      Math.floor((this.terrainPosition.x - radius) / size) - 1,
      Math.floor((this.terrainLower.x - margin) / size));
    const endX = Math.min(terrain.data.length - 1,
      Math.ceil((this.terrainPosition.x + radius) / size) + 1,
      Math.ceil((this.terrainUpper.x + margin) / size));
    const startY = Math.max(0,
      Math.floor((this.terrainPosition.y - radius) / size) - 1,
      Math.floor((this.terrainLower.y - margin) / size));
    const endY = Math.min(terrain.data[0].length - 1,
      Math.ceil((this.terrainPosition.y + radius) / size) + 1,
      Math.ceil((this.terrainUpper.y + margin) / size));
    if (startX >= endX || startY >= endY) return;
    terrain.getRectMinMax(startX, startY, endX, endY, this.terrainHeights);
    if (this.terrainLower.z > this.terrainHeights[1] + margin
      || this.terrainPosition.z - radius > this.terrainHeights[1]
      || this.terrainPosition.z + radius < this.terrainHeights[0]) return;

    for (let x = startX; x < endX; x++) {
      for (let y = startY; y < endY; y++) {
        const cellTop = Math.max(terrain.data[x][y], terrain.data[x + 1][y],
          terrain.data[x][y + 1], terrain.data[x + 1][y + 1]);
        if (this.terrainLower.z > cellTop + margin) continue;
        for (let triangle = 0; triangle < 2; triangle++) {
          terrain.getConvexTrianglePillar(x, y, triangle === 1);
          CANNON.Transform.pointToWorldFrame(terrainPosition, terrainRotation,
            terrain.pillarOffset, this.pillarPosition);
          if (position.distanceTo(this.pillarPosition) >= radius + terrain.pillarConvex.boundingSphereRadius) continue;
          const hit = this.convexConvex(shape, terrain.pillarConvex, position, this.pillarPosition,
            rotation, terrainRotation, body, terrainBody, null, null, justTest, this.terrainFaces, null);
          if (justTest && hit) return true;
        }
      }
    }
  }
}

/**
 * Real densities (kg/m³) and strengths (Pa). Compressive/tensile are the values that
 * decide when a wall crushes or a cantilever snaps, so they are the published figures for
 * the real material rather than round numbers: masonry runs 5–30 MPa compressive and is
 * roughly 10× weaker in tension, which is exactly why arches exist.
 */
export const MATERIAL_PRESETS = {
  stone: { density: 2400, compressive: 20e6, tensile: 2.0e6, kind: 'stone' },
  slate: { density: 2700, compressive: 25e6, tensile: 3.0e6, kind: 'stone' },
  brick: { density: 1900, compressive: 12e6, tensile: 1.2e6, kind: 'stone' },
  plaster: { density: 1400, compressive: 4e6, tensile: 0.5e6, kind: 'stone' },
  terracotta: { density: 2000, compressive: 9e6, tensile: 1.0e6, kind: 'stone' },
  wood: { density: 700, compressive: 35e6, tensile: 90e6, kind: 'wood' },
  soil: { density: 1600, compressive: 1e6, tensile: 0.05e6, kind: 'dirt' },
};

// Surface kinds the contact table is written against. A volume's material carries one.
export const SURFACES = ['stone', 'wood', 'dirt', 'player'];

/**
 * Build the physics world with SI gravity, a sweep-and-prune broadphase and the full
 * contact matrix. Returns { world, materials } where `materials` maps a surface kind to
 * its CANNON.Material — every body added to this world should be given one.
 */
export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.allowSleep = true;
  // Sweep-and-prune, not the default naive broadphase: voxel shrapnel can put a couple
  // of hundred extra bodies in the world on top of the debris pieces, and naive is O(n²)
  // over every pair every step.
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.broadphase.useBoundingBoxes = true;
  world.narrowphase = new VoxelNarrowphase(world);
  world.collisionMatrix = new CANNON.ObjectCollisionMatrix();
  world.collisionMatrixPrevious = new CANNON.ObjectCollisionMatrix();
  // Real masses span four orders of magnitude now (a 0.25 m stone voxel is ~37 kg, a
  // collapsed tower section tens of tonnes). Large mass ratios are exactly what makes an
  // iterative solver spongy, so it gets more iterations and a tighter tolerance than the
  // default 10 / 1e-7 — this is the cost of using real units, paid deliberately.
  world.solver.iterations = 16;
  world.solver.tolerance = 1e-4;

  const materials = {};
  for (const kind of SURFACES) materials[kind] = new CANNON.Material(kind);

  // friction, restitution. Masonry on masonry is high-friction and almost perfectly
  // inelastic — a dropped block does not bounce, it thuds and stays put. Soil is higher
  // friction still and completely dead. Timber keeps a little life in it.
  const table = [
    ['stone', 'stone', 0.75, 0.04],
    ['stone', 'dirt', 0.85, 0.02],
    ['stone', 'wood', 0.55, 0.12],
    ['wood', 'wood', 0.45, 0.20],
    ['wood', 'dirt', 0.70, 0.06],
    ['dirt', 'dirt', 0.95, 0.00],
    // The player is deliberately frictionless against everything: movement is driven by
    // setting velocity directly, and any tangential friction against a wall reads to the
    // player as "stuck on the scenery" rather than as realism.
    ['player', 'stone', 0.0, 0.0],
    ['player', 'wood', 0.0, 0.0],
    ['player', 'dirt', 0.0, 0.0],
    ['player', 'player', 0.0, 0.0],
  ];
  for (const [a, b, friction, restitution] of table) {
    world.addContactMaterial(new CANNON.ContactMaterial(materials[a], materials[b], {
      friction, restitution,
      contactEquationStiffness: 1e8,
      contactEquationRelaxation: 3,
    }));
  }
  world.defaultContactMaterial.friction = 0.6;
  world.defaultContactMaterial.restitution = 0.05;

  return { world, materials };
}

/**
 * Resolve the material record for one voxel value of a volume.
 * `paletteMaterial[value - 1]` indexes into `materials[]`; both come straight out of the
 * .pvx file (or the builtin volume tables). Falls back to stone, which is what an asset
 * with no material table should behave as in a fortress.
 */
export function materialFor(volume, value) {
  const table = volume?.materials;
  if (!table || table.length === 0) return MATERIAL_PRESETS.stone;
  const index = volume.paletteMaterial ? (volume.paletteMaterial[value - 1] ?? 0) : 0;
  return table[Math.min(index, table.length - 1)] ?? MATERIAL_PRESETS.stone;
}

/**
 * Build the `materials` + `paletteMaterial` pair a volume needs from a per-colour list of
 * preset names. Presets are de-duplicated, so a wall with three shades of stone carries
 * ONE material entry and three palette slots pointing at it — which is what keeps the
 * stress solver's per-material lookups cheap.
 */
export function buildMaterialTable(kinds) {
  const materials = [];
  const index = new Map();
  const paletteMaterial = new Uint8Array(kinds.length);
  kinds.forEach((name, i) => {
    if (!index.has(name)) {
      index.set(name, materials.length);
      materials.push({ ...(MATERIAL_PRESETS[name] ?? MATERIAL_PRESETS.stone) });
    }
    paletteMaterial[i] = index.get(name);
  });
  return { materials, paletteMaterial };
}

/** Surface kind for a material record, for picking its CANNON.Material. */
export function surfaceOf(material) {
  return SURFACES.includes(material?.kind) ? material.kind : 'stone';
}

/**
 * Mass of a solid block of `voxelCount` voxels of edge `scale` metres.
 * No fudge factor and no cap: this is ρ·V, and a wall section really does weigh tonnes.
 */
export function massOf(voxelCount, scale, density) {
  return Math.max(0.05, voxelCount * scale * scale * scale * density);
}
