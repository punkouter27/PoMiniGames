// decals.js — scorch marks left by blasts and dig hits.
//
// A fixed pool of camera-independent quads in ONE InstancedMesh, so the whole history of
// a firefight costs a single draw call. Each instance carries its own age, radius and
// tint in instanced attributes; the fragment shader draws a soft, noisy ring procedurally
// so there is no texture to author or load.
//
// Deliberately NOT three's DecalGeometry: that projects new geometry onto the target mesh,
// and every surface in this game is re-meshed the moment it is dug. A projected decal
// would be orphaned by the very explosion that created it. A flat oriented quad survives
// the re-mesh; the cost is that a decal straddling a fresh crater lip floats slightly.
//
// Oldest-first reuse: when the pool is full the next mark overwrites the oldest, which is
// the behaviour players expect — the battle's recent history stays visible.

import * as THREE from 'three-eco/webgpu';
import {
  atan, cross, fract, instancedDynamicBufferAttribute, max, mix, normalize, positionGeometry, select, sin, smoothstep,
  uniform, uv, varying, vec2, vec3, vec4, cameraProjectionMatrix, cameraViewMatrix, modelWorldMatrix, dot, abs, float,
} from 'three-eco/tsl';

export class DecalField {
  /** @param capacity max simultaneous marks; 0 disables the field entirely. */
  constructor(scene, capacity) {
    this.scene = scene;
    this.capacity = Math.max(0, capacity | 0);
    this.enabled = this.capacity > 0;
    this.cursor = 0;
    this.time = 0;
    if (!this.enabled) return;

    const n = this.capacity;
    this.decal = new Float32Array(n * 4);
    this.basis = new Float32Array(n * 4);
    this.tint = new Float32Array(n * 4);

    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(2, 2);
    g.index = quad.index;
    g.attributes.position = quad.attributes.position;
    g.attributes.uv = quad.attributes.uv;
    g.instanceCount = n;
    this.aDecal = new THREE.InstancedBufferAttribute(this.decal, 4).setUsage(THREE.DynamicDrawUsage);
    this.aBasis = new THREE.InstancedBufferAttribute(this.basis, 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aDecal', this.aDecal);
    g.setAttribute('aBasis', this.aBasis);
    g.setAttribute('aTint', this.aTint);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    // Instance attributes -> a camera-independent oriented quad, drawn procedurally (no
    // texture). The old GLSL had a vertex stage that built a frame around the surface normal
    // and a fragment stage that drew a ragged soft ring; both are nodes now.
    const uTime = uniform(0);
    this.uTime = uTime;
    const aDecal = instancedDynamicBufferAttribute(this.aDecal, 'vec4');   // xyz centre, w radius
    const aBasis = instancedDynamicBufferAttribute(this.aBasis, 'vec4');   // xyz normal, w birth
    const aTint = instancedDynamicBufferAttribute(this.aTint, 'vec4');     // rgb, a lifetime
    const life = aTint.w;
    const fade = select(life.greaterThan(0), max(life.sub(uTime.sub(aBasis.w)).div(max(life, 0.0001)), 0), 1);
    const nrm = normalize(aBasis.xyz);
    // The up-vector fallback matters: the perimeter wall and cliff faces are vertical, and
    // cross(nrm, up) degenerates there.
    const ref = select(abs(nrm.y).greaterThan(0.95), vec3(1, 0, 0), vec3(0, 1, 0));
    const t = normalize(cross(ref, nrm));
    const bt = cross(nrm, t);
    // Lifted along the normal so the quad wins the depth test against the surface it marks.
    const world = aDecal.xyz.add(nrm.mul(0.06)).add(t.mul(positionGeometry.x).add(bt.mul(positionGeometry.y)).mul(aDecal.w));
    const dead = aDecal.w.lessThanEqual(0).or(fade.lessThanEqual(0));
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(world, 1));
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    // A dead slot goes behind the far plane (w stays valid, z > w clips it).
    material.vertexNode = select(dead, vec4(0, 0, 2, 1), clip);
    const d = uv().sub(0.5);
    const r = d.length().mul(2);
    // Ragged edge: a smooth disc reads as a decal, a noisy one reads as a burn.
    const ang = atan(d.y, d.x);
    const wobble = fract(sin(vec2(ang.mul(6).floor(), 3).dot(vec2(127.1, 311.7))).mul(43758.5453)).mul(0.18).add(0.82);
    const edge = smoothstep(wobble.mul(0.55), wobble, r).oneMinus();
    const core = smoothstep(0, 0.55, r).oneMinus();
    const tint = varying(aTint.rgb);
    material.colorNode = mix(tint.mul(0.35), tint, core);
    material.opacityNode = edge.mul(varying(fade)).mul(0.85).mul(select(r.greaterThan(1), 0, 1));
    this.material = material;

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // under the particles, over the terrain
    scene.add(this.mesh);
    this._c = new THREE.Color();
  }

  /**
   * Stamp a mark.
   * @param position THREE.Vector3 contact point
   * @param normal THREE.Vector3 surface normal (falls back to straight up)
   * @param opts { radius, color, life } — life 0 keeps the mark for the whole match
   */
  stamp(position, normal, opts = {}) {
    if (!this.enabled) return;
    const { radius = 1.6, color = 0x1a1410, life = 0 } = opts;
    const i = this.cursor;
    const o = i * 4;
    this.decal[o] = position.x;
    this.decal[o + 1] = position.y;
    this.decal[o + 2] = position.z;
    this.decal[o + 3] = radius * (0.8 + Math.random() * 0.45);
    const n = normal && normal.lengthSq() > 0.0001 ? normal : { x: 0, y: 1, z: 0 };
    this.basis[o] = n.x;
    this.basis[o + 1] = n.y;
    this.basis[o + 2] = n.z;
    this.basis[o + 3] = this.time;
    this._c.set(color);
    this.tint[o] = this._c.r;
    this.tint[o + 1] = this._c.g;
    this.tint[o + 2] = this._c.b;
    this.tint[o + 3] = life;

    for (const attr of [this.aDecal, this.aBasis, this.aTint]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(o, 4);
      attr.needsUpdate = true;
    }
    this.cursor = (i + 1) % this.capacity;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this.uTime.value = this.time;
  }

  dispose() {
    if (!this.enabled) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
