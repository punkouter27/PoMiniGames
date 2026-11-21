// particles.js — GPU dust and smoke for PoVoxelStrike.
//
// One instanced draw call of camera-facing quads (WebGPU draws a Points object one pixel wide,
// so a sized sprite has to be a quad; the same quads run on the WebGL2 backend), a fixed ring
// buffer of particles. The CPU never touches a particle after it is spawned: the vertex stage
// (a TSL node graph now, r186) integrates
// position = origin + velocity·t + ½·g·t² from a per-particle birth time, so a frame
// with 4000 live puffs costs exactly the same JS as a frame with none.
//
// That matters here because dust is spawned from the destruction hot path — a collapsing
// castle emits dozens of clusters in one carve, and a per-particle CPU update loop was
// the thing that made the old debris burst hitch.
//
// Spawning writes into the ring buffer and marks only the touched attribute range dirty
// (`addUpdateRange`), so a 12-particle puff uploads 12 particles, not 4000. Wrapping
// spawns split into two ranges rather than uploading the whole buffer.

import * as THREE from 'three-eco/webgpu';
import {
  cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, dot, exp, instancedDynamicBufferAttribute,
  max, perspectiveDepthToViewZ, positionGeometry, pow, select, sin, smoothstep, uniform, uv, varying, vec3, vec4,
  viewportDepthTexture,
} from 'three-eco/tsl';

export class ParticleSystem {
  /** @param capacity max simultaneous particles; 0 disables the system entirely. */
  constructor(scene, capacity) {
    this.scene = scene;
    this.capacity = Math.max(0, capacity | 0);
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    this.time = 0;
    this.soft = null;               // soft-depth / sun-scatter mode the material was built for
    if (!this.enabled) return;

    const n = this.capacity;
    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.seeds = new Float32Array(n * 4);
    this.colors = new Float32Array(n * 3);
    // Birth time far in the past → age > 1 → the vertex stage collapses them on frame 1.
    for (let i = 0; i < n; i++) { this.seeds[i * 4] = -1e6; this.seeds[i * 4 + 1] = 1; }

    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry().copy(quad);
    quad.dispose();
    g.instanceCount = n;
    this.aPos = new THREE.InstancedBufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(this.velocities, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.InstancedBufferAttribute(this.seeds, 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    // Particles move in the shader, so three's own bounds are always wrong. An infinite
    // sphere disables culling — cheaper and more correct than recomputing bounds.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = g;

    // Uniform nodes, shared by every material variant (soft on / off).
    this.u = {
      time: uniform(0),
      gravity: uniform(-3.2),       // lighter than the physics world: dust hangs
      scale: uniform(0.52),         // tan(fov / 2): world size that keeps the old pixel size
      sunDir: uniform(new THREE.Vector3(0.4, 0.8, 0.25)),
      sunColor: uniform(new THREE.Color(0xfff2df)),
    };
    this.mesh = new THREE.Mesh(g, this._buildMaterial(false));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.soft = false;

    this._c = new THREE.Color();
  }

  /**
   * The graph. `soft` adds the depth fade against scene geometry and the sunlit forward
   * scattering; it is a separate material because sampling the scene depth makes the renderer
   * copy it every frame, which the low tier must not pay for.
   */
  _buildMaterial(soft) {
    const u = this.u;
    const iPos = instancedDynamicBufferAttribute(this.aPos, 'vec3');
    const iVel = instancedDynamicBufferAttribute(this.aVel, 'vec3');
    const iSeed = instancedDynamicBufferAttribute(this.aSeed, 'vec4');   // birth, life, size, flicker seed
    const iCol = instancedDynamicBufferAttribute(this.aCol, 'vec3');
    const age = u.time.sub(iSeed.x).div(max(iSeed.y, 0.0001));
    const alive = age.greaterThanEqual(0).and(age.lessThanEqual(1));
    const t = age.mul(iSeed.y);
    // Drag: puffs slow down as they expand, or every plume looks like a firework.
    const drag = exp(t.mul(-2.2)).oneMinus();
    const pos = iPos.add(iVel.mul(drag.div(2.2))).add(vec3(0, u.gravity.mul(0.5).mul(t).mul(t), 0));
    const mv = cameraViewMatrix.mul(vec4(pos, 1));
    // Smoke grows as it ages. Dead: zero size, so the quad covers no pixels.
    const width = select(alive, iSeed.z.mul(age.mul(1.6).add(0.45)).mul(u.scale), 0);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.NormalBlending,
    });
    material.vertexNode = cameraProjectionMatrix.mul(vec4(mv.xy.add(positionGeometry.xy.mul(width)), mv.zw));

    const d = uv().sub(0.5);
    const r = dot(d, d).mul(4);
    // Soft round sprite, generated rather than sampled: nothing to load or keep resident.
    const round = smoothstep(0.35, 1.0, r).oneMinus().mul(select(r.greaterThan(1), 0, 1));
    // Fade in fast, out slow: a puff should appear instantly and linger.
    let fade = varying(smoothstep(0, 0.08, age).mul(smoothstep(0.45, 1.0, age).oneMinus()));
    const flicker = varying(sin(iSeed.w.mul(30).add(age.mul(12))).mul(0.15).add(0.85));
    let col = varying(iCol).mul(flicker);
    if (soft) {
      // Soft depth fade against scene geometry intersections.
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
      fade = fade.mul(clamp(varying(mv.z).sub(sceneZ).mul(0.85), 0, 1));
      // Directional sun-backlit forward scattering + rim glow; the rim term uses the sprite's
      // own up (uv y is up here, where the old point-coord y was down).
      const worldPos = varying(pos);
      const viewDir = worldPos.sub(cameraPosition).normalize();
      const fwd = max(0, dot(viewDir, u.sunDir.normalize()));
      const scatter = pow(fwd, 4).mul(0.65).add(round.oneMinus().mul(pow(fwd, 2)).mul(0.35));
      const topLight = clamp(d.y.mul(0.9).add(0.5), 0, 1).mul(max(0, u.sunDir.y));
      col = col.add(u.sunColor.mul(scatter.add(topLight.mul(0.22))));
    }
    material.colorNode = col;
    material.opacityNode = round.mul(fade).mul(0.55);
    return material;
  }

  /** Kept for the engine's resize path: the quad size follows the camera now, not the pixel height. */
  setViewportHeight() {}

  /** Wire the sun uniforms; builds the soft-depth variant of the material on demand. */
  setSoftLighting({ sunDir = null, sunColor = null, enabled = true } = {}) {
    if (!this.enabled) return;
    if (sunDir) this.u.sunDir.value.copy(sunDir);
    if (sunColor) this.u.sunColor.value.copy(sunColor);
    const want = !!enabled;
    if (want !== this.soft) {
      const old = this.mesh.material;
      this.mesh.material = this._buildMaterial(want);
      old.dispose();
      this.soft = want;
    }
  }

  /**
   * Emit a puff.
   * @param position THREE.Vector3 origin
   * @param count particles to spawn (clamped to the remaining ring capacity per call)
   * @param opts { color, speed, spread, size, life, upward }
   */
  emit(position, count, opts = {}) {
    if (!this.enabled || count <= 0) return;
    const n = Math.min(count | 0, this.capacity);
    const {
      color = 0x9a8f7d, speed = 2.4, spread = 1, size = 0.5, life = 1.4, upward = 1.2,
    } = opts;
    this._c.set(color);

    const start = this.cursor;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % this.capacity;
      const p3 = i * 3, s4 = i * 4;
      this.positions[p3] = position.x + (Math.random() - 0.5) * spread * 0.4;
      this.positions[p3 + 1] = position.y + (Math.random() - 0.5) * spread * 0.4;
      this.positions[p3 + 2] = position.z + (Math.random() - 0.5) * spread * 0.4;

      // Cosine-ish hemisphere: mostly outward and up, never straight down.
      const theta = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const v = speed * (0.35 + Math.random() * 0.9);
      this.velocities[p3] = Math.cos(theta) * r * v;
      this.velocities[p3 + 1] = (upward + Math.random() * 0.8) * v * 0.5;
      this.velocities[p3 + 2] = Math.sin(theta) * r * v;

      this.seeds[s4] = this.time;
      this.seeds[s4 + 1] = life * (0.7 + Math.random() * 0.6);
      this.seeds[s4 + 2] = size * (0.6 + Math.random() * 0.9);
      this.seeds[s4 + 3] = Math.random();

      // Per-particle tint jitter so a plume is not one flat colour.
      const j = 0.82 + Math.random() * 0.36;
      this.colors[p3] = this._c.r * j;
      this.colors[p3 + 1] = this._c.g * j;
      this.colors[p3 + 2] = this._c.b * j;
    }
    this._markDirty(start, n);
    this.cursor = (start + n) % this.capacity;
  }

  /** Flag only the written slice(s). A wrap becomes two ranges, never a full re-upload. */
  _markDirty(start, count) {
    const attrs = [
      [this.aPos, 3], [this.aVel, 3], [this.aSeed, 4], [this.aCol, 3],
    ];
    const end = start + count;
    const ranges = end <= this.capacity
      ? [[start, count]]
      : [[start, this.capacity - start], [0, end - this.capacity]];
    for (const [attr, stride] of attrs) {
      attr.clearUpdateRanges();
      for (const [from, len] of ranges) attr.addUpdateRange(from * stride, len * stride);
      attr.needsUpdate = true;
    }
  }

  /** @param camera optional: keeps the quad size matched to the lens through FOV changes */
  update(dt, camera = null) {
    if (!this.enabled) return;
    this.time += dt;
    this.u.time.value = this.time;
    // 1 / projection[1][1] = tan(fov / 2).
    if (camera) this.u.scale.value = 1 / (camera.projectionMatrix.elements[5] || 1.92);
  }

  dispose() {
    if (!this.enabled) return;
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}
