// shrapnel.js — individual voxels blown out of a structure, simulated as real rigid
// bodies with real collision.
//
// Before this, the voxels a shot removed simply vanished: only the cluster the carve
// STRUCTURALLY detached became a physics piece, and the crater itself produced a couple
// of decorative sprites that passed through the ground. So the thing the player actually
// aimed at — the stone coming out of the wall — never existed.
//
// Now every carve throws voxels. Each one is a cannon-es box that collides with the
// terrain heightfield, the structure colliders and the debris already lying around, and
// it comes to rest in the rubble.
//
// Two design constraints shape everything here:
//
//   1. COUNT. A primary shot at 0.25-unit voxels removes on the order of 1500 cells, and
//      an alt-fire blast tens of thousands. Nothing simulates that. So a carve SAMPLES
//      its removed voxels — outermost first, because those are the ones the player can
//      see leave — up to a per-shot cap, and the rest stay as the existing dust burst.
//      The cap is the tier knob; it is not a hidden truncation, it is the whole design.
//
//   2. POOLING. Bodies are allocated once and recycled oldest-first. Creating and
//      destroying a hundred cannon bodies per trigger pull churns the broadphase and the
//      GC in the exact frame that is already doing a carve and a re-mesh.
//
// Rendering is one InstancedMesh: the entire field of flying rubble is a single draw
// call regardless of how much of it is in the air.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { materialFor, massOf, MATERIAL_PRESETS } from './physics.js';

const LIFE_S = 11;             // then it fades and returns to the pool
const FADE_S = 1.6;
// Collider half-extent floor. This used to be the ONLY defence against tunnelling and
// was set well above the true voxel half-size to compensate; sweep() does that job
// properly now, so this is back to a sanity floor for absurdly small voxels rather than a
// fudge factor, and a shrapnel box is its real size.
const MIN_COLLIDER_HALF = 0.06;
const MAX_SPEED = 13;          // also anti-tunnelling: nothing may outrun its own size

export class ShrapnelField {
  /**
   * @param capacity max simultaneous voxels in flight; 0 disables the system
   * @param collision { terrain, structures } for the swept-contact pass; omit to skip it
   * @param physicsMaterial CANNON.Material this rubble contacts the world with
   */
  constructor(scene, physicsWorld, capacity, collision = null, physicsMaterial = undefined) {
    this.scene = scene;
    this.world = physicsWorld;
    this.collision = collision;
    this.physicsMaterial = physicsMaterial;
    this.capacity = Math.max(0, capacity | 0);
    this.budget = this.capacity;
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    if (!this.enabled) return;

    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }),
      this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    // Pool. Bodies start out of the world; spawn() adds them, expiry removes them, and
    // the shape is resized per spawn because voxel size differs between structures.
    this.slots = [];
    for (let i = 0; i < this.capacity; i++) {
      const body = new CANNON.Body({
        mass: 1,
        shape: new CANNON.Box(new CANNON.Vec3(MIN_COLLIDER_HALF, MIN_COLLIDER_HALF, MIN_COLLIDER_HALF)),
        angularDamping: 0.25,
        linearDamping: 0.02,
        allowSleep: true,
        material: this.physicsMaterial,
      });
      body.sleepSpeedLimit = 0.4;
      body.sleepTimeLimit = 0.6;
      this.slots.push({ body, live: false, age: 0, size: 1 });
      this.mesh.setMatrixAt(i, this._zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
  }

  /**
   * Throw one voxel.
   * @param position world centre of the voxel
   * @param size world edge length of the voxel
   * @param color THREE.Color
   * @param velocity THREE.Vector3 initial velocity (clamped to MAX_SPEED)
   */
  spawn(position, size, color, velocity, density = MATERIAL_PRESETS.stone.density) {
    if (!this.enabled || this.budget === 0) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.budget;
    const slot = this.slots[i];
    if (slot.live) this.world.removeBody(slot.body); else this.live++;

    const half = Math.max(MIN_COLLIDER_HALF, size / 2);
    const shape = slot.body.shapes[0];
    shape.halfExtents.set(half, half, half);
    shape.updateConvexPolyhedronRepresentation();
    shape.updateBoundingSphereRadius();
    slot.body.updateBoundingRadius();
    slot.body.updateMassProperties();
    // Real mass: rho * V, no fudge factor. A 0.25 m stone voxel is 37 kg, which is why
    // it lands with weight and does not get flicked around by the pieces near it.
    slot.body.mass = massOf(1, size, density);
    slot.body.updateMassProperties();

    slot.body.position.set(position.x, position.y, position.z);
    slot.body.quaternion.set(0, 0, 0, 1);
    slot.body.angularVelocity.set(
      (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
    const speed = velocity.length();
    const scale = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
    slot.body.velocity.set(velocity.x * scale, velocity.y * scale, velocity.z * scale);
    slot.body.wakeUp();
    this.world.addBody(slot.body);

    slot.live = true;
    slot.age = 0;
    slot.size = size;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Throw a sample of the voxels a carve removed.
   * @param structure the Structure they came out of (for grid → world and palette)
   * @param removed the `removed` array carveSphere returned
   * @param origin world point the blast came from — velocity radiates from it
   * @param power metres/second at the centre of the blast
   * @param budget max voxels to throw from this one carve
   */
  spawnFromCarve(structure, removed, origin, power, budget) {
    if (!this.enabled || this.budget === 0 || removed.length === 0) return;
    const take = Math.min(budget, removed.length, this.budget);
    // Even stride rather than the first N: `removed` is emitted in grid-scan order, so
    // the first N would all come from one corner of the crater and the rubble would fly
    // out of one face instead of the whole hole.
    const stride = Math.max(1, Math.floor(removed.length / take));
    const dir = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const color = new THREE.Color();

    for (let k = 0, n = 0; k < removed.length && n < take; k += stride, n++) {
      const v = removed[k];
      const world = structure.voxelWorldCenter(v.x, v.y, v.z);
      dir.copy(world).sub(origin);
      const d = dir.length();
      if (d < 1e-3) dir.set(0, 1, 0); else dir.divideScalar(d);
      // Falls off with distance from the blast centre, plus an upward bias so rubble
      // arcs out of the wall instead of squirting sideways along it.
      const speed = power * (0.35 + 0.65 * Math.random()) / (1 + d * 0.35);
      vel.copy(dir).multiplyScalar(speed);
      vel.y += speed * 0.45 + Math.random() * 1.5;
      paletteColor(structure.palette, v.value, color);
      const m = materialFor(structure.volume, v.value);
      this.spawn(world, structure.scale, color, vel, m.density);
    }
  }

  /** Same, for terrain: the caller supplies world points because terrain has no grid API. */
  spawnBurst(origin, count, size, color, power, density = MATERIAL_PRESETS.soil.density) {
    if (!this.enabled || this.budget === 0) return;
    const vel = new THREE.Vector3();
    const at = new THREE.Vector3();
    const n = Math.min(count, this.budget);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2;
      at.set(origin.x + Math.cos(theta) * r, origin.y + Math.random() * 0.8,
        origin.z + Math.sin(theta) * r);
      const speed = power * (0.4 + Math.random() * 0.8);
      vel.set(Math.cos(theta) * speed, speed * (0.7 + Math.random() * 0.8), Math.sin(theta) * speed);
      this.spawn(at, size, color, vel, density);
    }
  }

  /**
   * Swept contact pass -- the poor man's CCD, because cannon-es has none.
   *
   * A 0.25 m voxel at 13 m/s covers 0.22 m in a 60 Hz step, the same order as its own
   * size, so the discrete solver can miss a thin wall entirely and the piece surfaces on
   * the far side. Before the world steps, each FAST piece casts a ray along the motion it
   * is about to make; anything in the way stops it just short of the surface and reflects
   * what is left of its velocity. Slow pieces skip the test -- the discrete solver is
   * correct for them, and this is the most expensive thing in the file.
   *
   * This is also what let the collider padding go: the boxes can be their true voxel size
   * now instead of being inflated to survive a timestep.
   */
  sweep(dt) {
    if (!this.enabled || !this.collision) return;
    const { terrain, structures } = this.collision;
    const dir = this._sweepDir ??= new THREE.Vector3();
    const from = this._sweepFrom ??= new THREE.Vector3();
    for (let i = 0; i < this.capacity; i++) {
      const slot = this.slots[i];
      if (!slot.live || slot.body.sleepState === CANNON.Body.SLEEPING) continue;
      const v = slot.body.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      const travel = speed * dt;
      if (travel < slot.size * 0.75) continue;   // the discrete solver will catch it

      from.set(slot.body.position.x, slot.body.position.y, slot.body.position.z);
      dir.set(v.x / speed, v.y / speed, v.z / speed);
      const limit = travel + slot.size * 0.5;

      let hit = terrain ? terrain.raycast(from, dir, limit) : null;
      if (structures) {
        for (const st of structures) {
          const h = st.raycast(from, dir, limit);
          if (h && (!hit || h.distance < hit.distance)) hit = h;
        }
      }
      if (!hit) continue;

      // Stop just short of the surface, then reflect. Losing most of the energy is right:
      // a stone chip striking masonry does not ricochet like a ball bearing.
      const back = Math.max(0, hit.distance - slot.size * 0.5);
      slot.body.position.set(
        from.x + dir.x * back, from.y + dir.y * back, from.z + dir.z * back);
      const n = hit.normal;
      if (n) {
        const along = v.x * n.x + v.y * n.y + v.z * n.z;
        slot.body.velocity.set(
          (v.x - 2 * along * n.x) * 0.25,
          (v.y - 2 * along * n.y) * 0.25,
          (v.z - 2 * along * n.z) * 0.25);
      } else {
        slot.body.velocity.set(v.x * 0.2, v.y * 0.2, v.z * 0.2);
      }
    }
  }

  update(dt) {
    if (!this.enabled) return;
    for (let i = 0; i < this.capacity; i++) {
      const slot = this.slots[i];
      if (!slot.live) continue;
      slot.age += dt;
      if (slot.age >= LIFE_S) {
        this.world.removeBody(slot.body);
        slot.live = false;
        this.live--;
        this.mesh.setMatrixAt(i, this._zero);
        continue;
      }
      const b = slot.body;
      this._p.set(b.position.x, b.position.y, b.position.z);
      this._q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      // Shrink away over the last FADE_S rather than popping out of existence. Scaling
      // the instance is free; the collider keeps its size, which is fine because the
      // piece is about to be retired anyway.
      const remaining = LIFE_S - slot.age;
      const shrink = remaining < FADE_S ? Math.max(0, remaining / FADE_S) : 1;
      this._s.setScalar(slot.size * shrink);
      this.mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Shrink the sampled chip pool without reallocating or touching structural rubble. */
  setBudget(budget) {
    this.budget = Math.min(this.capacity, Math.max(0, budget | 0));
    this.cursor = this.budget ? this.cursor % this.budget : 0;
    if (!this.enabled) return;
    for (let i = this.budget; i < this.capacity; i++) {
      const slot = this.slots[i];
      if (!slot.live) continue;
      this.world.removeBody(slot.body);
      slot.live = false;
      this.live--;
      this.mesh.setMatrixAt(i, this._zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (!this.enabled) return;
    for (const slot of this.slots) if (slot.live) this.world.removeBody(slot.body);
    this.slots.length = 0;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Palette entry → THREE.Color, written into `out`. Index 0 is empty, so it is never asked for. */
function paletteColor(palette, value, out) {
  const i = (value - 1) * 4;
  if (!palette || i < 0 || i + 2 >= palette.length) return out.setRGB(0.62, 0.62, 0.65);
  return out.setRGB(palette[i] / 255, palette[i + 1] / 255, palette[i + 2] / 255);
}
