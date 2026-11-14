// sparks.js — pooled GPU velocity-stretched spark system and ground dust-ring skirt (#9).
//
// Sparks use a single InstancedMesh of thin boxes aligned and stretched along their
// instantaneous velocity vector, glowing hot orange-white so UnrealBloom picks them up.
// Dust skirts spawn an outward-rolling low-profile ring of masonry dust on hard debris
// landings and blast bases.

import * as THREE from 'three';

const SPARK_GRAVITY = -16.5;
const SKIRT_POOL = 8;

export class SparkSystem {
  constructor(scene, capacity = 240) {
    this.scene = scene;
    this.capacity = Math.max(0, capacity | 0);
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    this.activeCount = 0;
    this.skirts = [];

    // Ground dust-ring skirt geometry (short open cylinder / ring)
    this.skirtGeometry = new THREE.CylinderGeometry(0.65, 1.0, 0.45, 20, 1, true);
    this.skirtMaterial = new THREE.MeshBasicMaterial({
      color: 0xb8aa94,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    if (!this.enabled) return;

    const geo = new THREE.BoxGeometry(0.035, 0.035, 1.0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd28a,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;

    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._mat = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
    this._dir = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._color = new THREE.Color();

    this.slots = new Array(this.capacity).fill(null);
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, this._zero);
      this.mesh.setColorAt(i, this._color.setHex(0xffd28a));
    }
    this.scene.add(this.mesh);
  }

  /**
   * Emit velocity-stretched sparks around `pos` biased along `normal`.
   */
  sparks(pos, normal = null, count = 12) {
    if (!this.enabled || count <= 0 || !pos) return;
    const n = Math.min(count | 0, this.capacity);
    const nx = normal ? normal.x : 0;
    const ny = normal ? normal.y : 1;
    const nz = normal ? normal.z : 0;

    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.slots[i] === null) this.activeCount++;

      const speed = 7 + Math.random() * 13;
      const rx = (Math.random() - 0.5) * 1.6 + nx * 0.9;
      const ry = Math.random() * 1.1 + ny * 0.9 + 0.25;
      const rz = (Math.random() - 0.5) * 1.6 + nz * 0.9;
      const len = Math.hypot(rx, ry, rz) || 1;
      const life = 0.22 + Math.random() * 0.28;

      this.slots[i] = {
        pos: new THREE.Vector3(
          pos.x + (Math.random() - 0.5) * 0.25,
          pos.y + (Math.random() - 0.5) * 0.25,
          pos.z + (Math.random() - 0.5) * 0.25),
        vel: new THREE.Vector3((rx / len) * speed, (ry / len) * speed, (rz / len) * speed),
        life,
        maxLife: life,
      };
      // Hot white-gold core tint per spark
      this._color.setHSL(0.07 + Math.random() * 0.05, 1.0, 0.65 + Math.random() * 0.3);
      this.mesh.setColorAt(i, this._color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Spawn an expanding ground-hugging dust ring skirt at `pos` with target `radius`.
   */
  dustSkirt(pos, radius = 2.5) {
    if (!pos || this.capacity <= 0) return;
    while (this.skirts.length >= SKIRT_POOL) {
      const old = this.skirts.shift();
      this.scene.remove(old.mesh);
      old.mesh.material.dispose();
    }
    const mat = this.skirtMaterial.clone();
    const mesh = new THREE.Mesh(this.skirtGeometry, mat);
    mesh.position.set(pos.x, pos.y + 0.18, pos.z);
    mesh.scale.set(0.4, 0.5, 0.4);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.skirts.push({
      mesh,
      age: 0,
      life: 0.65,
      targetRadius: Math.max(1.2, radius),
    });
  }

  update(dt) {
    for (let i = this.skirts.length - 1; i >= 0; i--) {
      const s = this.skirts[i];
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) {
        this.scene.remove(s.mesh);
        s.mesh.material.dispose();
        this.skirts.splice(i, 1);
        continue;
      }
      const r = 0.4 + s.targetRadius * (1 - Math.pow(1 - t, 2.2));
      const h = 0.4 + 0.9 * Math.sin(t * Math.PI);
      s.mesh.scale.set(r, h, r);
      s.mesh.material.opacity = 0.48 * (1 - t) * (1 - t);
    }

    if (!this.enabled || this.activeCount === 0) return;
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.slots[i];
      if (!p) continue;
      dirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        this.slots[i] = null;
        this.activeCount--;
        this.mesh.setMatrixAt(i, this._zero);
        continue;
      }
      p.vel.y += SPARK_GRAVITY * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - 1.8 * dt));
      p.pos.addScaledVector(p.vel, dt);

      const speed = p.vel.length();
      if (speed > 0.001) {
        this._dir.copy(p.vel).divideScalar(speed);
        this._quat.setFromUnitVectors(this._up, this._dir);
      }
      const fade = p.life / p.maxLife;
      const stretch = Math.min(1.1, Math.max(0.12, speed * 0.045)) * (0.4 + 0.6 * fade);
      this._scale.set(fade, fade, stretch);
      this._mat.compose(p.pos, this._quat, this._scale);
      this.mesh.setMatrixAt(i, this._mat);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const s of this.skirts) {
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
    }
    this.skirts.length = 0;
    this.skirtGeometry.dispose();
    this.skirtMaterial.dispose();
    if (!this.enabled) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
