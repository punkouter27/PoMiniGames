// foliage.js — grass meadows and fortress banners that answer the wind and every blast.
//
// Presentation only: no physics bodies, nothing the simulation reads, so co-op peers may
// disagree about a blade and it does not matter. All motion is in the vertex shader:
//
//   * Wind — a slow travelling gust field, so a meadow ripples in bands rather than every
//     blade nodding in unison.
//   * Blasts — the last BLASTS detonations/carves live in a uniform ring buffer (the same
//     trick materials.js uses for hot carve edges). A blast is a shock front moving out at
//     SHOCK_SPEED: blades it has passed are flattened away from the centre, then spring
//     back as a damped oscillation. Banners billow away from it the same way.
//
// Grass is one InstancedMesh (one draw call) of 3-triangle tapered blades, scattered in
// seeded noise patches so the field reads as meadows, not carpet. Blades over ground a
// weapon has since dug are re-seated (or hidden, if the crater swallowed them) when a
// blast lands near them, via a coarse spatial grid of instance indices.
//
// Banners hang from poles on the tallest structures and fall when the stone under the
// pole is shot away.

import * as THREE from 'three';
import { createActorMaterial } from './materials.js';

const BLASTS = 6;
const SHOCK_SPEED = 38;          // m/s — reads as a pressure wave, not a sound wave
const BLAST_LIFE_S = 3.5;
const GRID = 8;                  // spatial grid cell for re-seating blades (m)
const BLADE_COUNT = { low: 0, medium: 9000, high: 22000, ultra: 40000 };

const shared = {
  time: { value: 0 },
  blasts: { value: Array.from({ length: BLASTS }, () => new THREE.Vector4(0, -9999, 0, 0)) },
  births: { value: new Float32Array(BLASTS).fill(-1000) },
  power: { value: new Float32Array(BLASTS) },
};
let blastNext = 0;
const listeners = new Set();

/** A blast/carve happened: the shock front bends grass and billows banners within radius. */
export function markBlast(point, radius, power = 1) {
  shared.blasts.value[blastNext].set(point.x, point.y, point.z, radius);
  shared.births.value[blastNext] = shared.time.value;
  shared.power.value[blastNext] = power;
  blastNext = (blastNext + 1) % BLASTS;
  for (const fn of listeners) fn(point, radius);
}

// Shared GLSL: world-space displacement for a vertex at `wp` whose bend weight is `w`.
const BEND_GLSL = /* glsl */`
  uniform float uFolTime;
  uniform vec4 uBlast[${BLASTS}];
  uniform float uBlastBirth[${BLASTS}];
  uniform float uBlastPower[${BLASTS}];
  vec3 pvsBend(vec3 wp, float w, float stiff) {
    float gust = sin(wp.x * 0.07 + uFolTime * 1.3) * 0.5 + sin(wp.z * 0.11 - uFolTime * 0.9) * 0.5;
    float flutter = sin(uFolTime * 6.0 + wp.x * 1.7 + wp.z * 2.3) * 0.08;
    vec3 d = vec3(0.6, 0.0, 0.35) * (0.18 + 0.22 * gust + flutter) * w / stiff;
    for (int i = 0; i < ${BLASTS}; i++) {
      float age = uFolTime - uBlastBirth[i];
      if (age < 0.0 || age > ${BLAST_LIFE_S.toFixed(1)}) continue;
      vec3 off = wp - uBlast[i].xyz;
      float dist = length(off.xz) + 0.001;
      if (dist > uBlast[i].w) continue;
      float since = age - dist / ${SHOCK_SPEED.toFixed(1)};   // time since the front passed
      if (since < 0.0) continue;
      float reach = 1.0 - dist / uBlast[i].w;
      float spring = exp(-since * 2.6) * cos(since * 9.0);
      vec2 away = off.xz / dist;
      float amt = uBlastPower[i] * reach * spring * 1.4 * w / stiff;
      d.xz += away * amt;
      d.y -= abs(amt) * 0.35;                                   // flattened, not stretched
    }
    return d;
  }`;

// Bend weight is a custom attribute (aBend: 0 = pinned, 1 = free) rather than uv, because
// three only declares `uv` in the vertex prefix when the material samples a texture.
function hookBend(material, stiff, key) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFolTime = shared.time;
    shader.uniforms.uBlast = shared.blasts;
    shader.uniforms.uBlastBirth = shared.births;
    shader.uniforms.uBlastPower = shared.power;
    const bendDecl = shader.vertexShader.includes('attribute float aBend;') ? '' : 'attribute float aBend;\n';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${bendDecl}${BEND_GLSL}`)
      .replace('#include <project_vertex>', /* glsl */`
        vec4 pvsWp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          pvsWp = instanceMatrix * pvsWp;
        #endif
        pvsWp = modelMatrix * pvsWp;
        pvsWp.xyz += pvsBend(pvsWp.xyz, aBend, ${stiff.toFixed(2)});
        vec4 mvPosition = viewMatrix * pvsWp;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  material.customProgramCacheKey = () => key;
}

/** Seeded PRNG (mulberry32) — the meadow layout belongs to the seed like the weather. */
function prng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bladeGeometry() {
  // Two segments + tip: 5 vertices, 3 triangles. uv.y is the bend weight (0 root, 1 tip).
  const w = 0.07, h = 1;
  const pos = [-w, 0, 0, w, 0, 0, -w * 0.6, h * 0.55, 0, w * 0.6, h * 0.55, 0, 0, h, 0];
  const uv = [0, 0, 1, 0, 0, 0.55, 1, 0.55, 0.5, 1];   // only .y is used: the bend weight
  const col = [0.35, 0.42, 0.2, 0.35, 0.42, 0.2, 0.7, 0.8, 0.45, 0.7, 0.8, 0.45, 1, 1, 0.7];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBend', new THREE.Float32BufferAttribute(uv.filter((_, k) => k % 2).map((v) => v * v), 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
  g.computeVertexNormals();
  return g;
}

export class Foliage {
  /**
   * @param scene THREE.Scene
   * @param ctx { terrain, structures, arenaHalf, seed, quality }
   */
  constructor(scene, { terrain, structures, arenaHalf, seed, quality }) {
    this.scene = scene;
    this.terrain = terrain;
    this.structures = structures;
    this.banners = [];
    this._checkT = 0;
    this._onBlast = (p, r) => this._reseat(p, r);
    listeners.add(this._onBlast);
    shared.births.value.fill(-1000);

    const count = BLADE_COUNT[quality?.tier] ?? 0;
    if (count > 0) this._buildGrass(count, arenaHalf, seed);
    if (quality?.tier !== 'low') this._buildBanners(seed);
  }

  _footprints() {
    // World-space XZ boxes of every structure: no grass growing through a keep floor.
    const boxes = [];
    for (const s of this.structures ?? []) {
      const b = new THREE.Box3();
      const [nx, ny, nz] = s.dims;
      for (const [x, z] of [[0, 0], [nx, 0], [0, nz], [nx, nz]]) {
        b.expandByPoint(new THREE.Vector3(x - s.cx, 0, z - s.cz).applyMatrix4(s.group.matrixWorld));
        b.expandByPoint(new THREE.Vector3(x - s.cx, ny, z - s.cz).applyMatrix4(s.group.matrixWorld));
      }
      boxes.push(b);
    }
    return boxes;
  }

  _buildGrass(count, half, seed) {
    const rnd = prng((seed ?? 1) * 7919 + 13);
    const boxes = this._footprints();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    hookBend(mat, 1, 'pvs-grass');
    const mesh = new THREE.InstancedMesh(bladeGeometry(), mat, count);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    // Meadow patches: a coarse value-noise mask decides where grass grows at all.
    const patch = (x, z) => 0.5 + 0.5 * Math.sin(x * 0.045 + Math.sin(z * 0.06) * 2) * Math.cos(z * 0.05 + seed);
    this.grid = new Map();
    this.base = new Float32Array(count * 4);   // x, z, height, scale
    let n = 0;
    for (let tries = 0; n < count && tries < count * 6; tries++) {
      const x = (rnd() * 2 - 1) * (half - 2);
      const z = (rnd() * 2 - 1) * (half - 2);
      if (patch(x, z) < 0.42 + rnd() * 0.2) continue;
      let blocked = false;
      for (const b of boxes) {
        if (x > b.min.x - 0.5 && x < b.max.x + 0.5 && z > b.min.z - 0.5 && z < b.max.z + 0.5) { blocked = true; break; }
      }
      if (blocked) continue;
      const y = this.terrain.heightAt(x, z);
      const sc = 0.35 + rnd() * 0.45;
      p.set(x, y, z);
      q.setFromAxisAngle(up, rnd() * Math.PI);
      s.set(1, sc, 1);
      mesh.setMatrixAt(n, m.compose(p, q, s));
      c.setHSL(0.2 + rnd() * 0.08, 0.45 + rnd() * 0.2, 0.32 + rnd() * 0.14);
      mesh.setColorAt(n, c);
      this.base.set([x, z, y, sc], n * 4);
      const key = `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
      (this.grid.get(key) ?? this.grid.set(key, []).get(key)).push(n);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.grass = mesh;
    this.scene.add(mesh);
  }

  /** A blast dug the ground: drop blades onto the new surface, hide those in the crater. */
  _reseat(point, radius) {
    if (!this.grass) return;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const r = radius * 0.7;
    let dirty = false;
    for (let gx = Math.floor((point.x - r) / GRID); gx <= Math.floor((point.x + r) / GRID); gx++) {
      for (let gz = Math.floor((point.z - r) / GRID); gz <= Math.floor((point.z + r) / GRID); gz++) {
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          const x = this.base[i * 4], z = this.base[i * 4 + 1];
          const y = this.terrain.heightAt(x, z);
          if (Math.abs(y - this.base[i * 4 + 2]) < 0.02) continue;
          this.grass.getMatrixAt(i, m);
          m.decompose(p, q, s);
          // Ground that fell away more than a blade's height is bare dirt now.
          const sc = this.base[i * 4 + 2] - y > 0.25 ? 0 : this.base[i * 4 + 3];
          p.y = y;
          if (sc === 0) s.set(0, 0, 0);
          this.grass.setMatrixAt(i, m.compose(p, q, s));
          this.base[i * 4 + 2] = y;
          if (sc === 0) this.base[i * 4 + 3] = 0;
          dirty = true;
        }
      }
    }
    if (dirty) this.grass.instanceMatrix.needsUpdate = true;
  }

  _buildBanners(seed) {
    const tall = [...(this.structures ?? [])]
      .map((st) => ({ st, h: st.dims[1] * st.scale }))
      .sort((a, b) => b.h - a.h)
      .slice(0, 4);
    const rnd = prng((seed ?? 1) * 31 + 5);
    const clothMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    hookBend(clothMat, 0.55, 'pvs-banner');
    const poleMat = createActorMaterial({ color: 0x3b2d22 });
    for (const { st } of tall) {
      const top = this._topOf(st);
      if (!top) continue;
      const g = new THREE.PlaneGeometry(1.6, 1.0, 12, 6);
      g.translate(0.8, 0, 0);                       // pinned edge at x = 0 (the pole)
      const col = [];
      const pos = g.getAttribute('position');
      const hue = rnd() < 0.5 ? 0.0 : 0.6;
      const base = new THREE.Color().setHSL(hue, 0.7, 0.32);
      const trim = new THREE.Color(0xd8b14a);
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v);
        const c = Math.abs(y) > 0.38 ? trim : base;
        col.push(c.r, c.g, c.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const bend = new Float32Array(pos.count);
      for (let v = 0; v < pos.count; v++) bend[v] = pos.getX(v) / 1.6;
      g.setAttribute('aBend', new THREE.BufferAttribute(bend, 1));
      const banner = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.2, 6), poleMat);
      pole.position.y = 1.6;
      pole.castShadow = true;
      const cloth = new THREE.Mesh(g, clothMat);
      cloth.position.set(0.05, 2.6, 0);
      cloth.castShadow = true;
      banner.add(pole, cloth);
      banner.position.copy(top.world);
      banner.rotation.y = rnd() * Math.PI * 2;
      this.scene.add(banner);
      this.banners.push({ group: banner, st, voxel: top.voxel, falling: false, vy: 0, spin: 0 });
    }
  }

  /** Highest solid voxel near a structure's centre, in voxel and world coordinates. */
  _topOf(st) {
    const [nx, ny, nz] = st.dims;
    const cx = Math.floor(nx / 2), cz = Math.floor(nz / 2);
    let best = null;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let y = ny - 1; y >= 0; y--) {
          if (st.at(cx + dx, y, cz + dz) === 0) continue;
          if (!best || y > best.y) best = { x: cx + dx, y, z: cz + dz };
          break;
        }
      }
    }
    if (!best) return null;
    const world = new THREE.Vector3(best.x + 0.5 - st.cx, best.y + 1, best.z + 0.5 - st.cz)
      .applyMatrix4(st.group.matrixWorld);
    return { voxel: best, world };
  }

  update(dt, time) {
    shared.time.value = time;
    this._checkT -= dt;
    const check = this._checkT <= 0;
    if (check) this._checkT = 0.4;
    for (const b of this.banners) {
      if (!b.falling && check && b.st.at(b.voxel.x, b.voxel.y, b.voxel.z) === 0) {
        b.falling = true;                           // the stone under the pole is gone
        b.spin = (b.voxel.x % 2 ? 1 : -1) * 1.4;
      }
      if (!b.falling) continue;
      b.vy -= 9.81 * dt;
      b.group.position.y += b.vy * dt;
      b.group.rotation.z += b.spin * dt;
      const ground = this.terrain.heightAt(b.group.position.x, b.group.position.z);
      if (b.group.position.y < ground) {
        b.group.position.y = ground;
        b.group.rotation.z = Math.sign(b.spin) * Math.PI / 2;
        b.vy = 0; b.spin = 0;
      }
    }
  }

  dispose() {
    listeners.delete(this._onBlast);
    if (this.grass) {
      this.scene.remove(this.grass);
      this.grass.geometry.dispose();
      this.grass.material.dispose();
    }
    for (const b of this.banners) {
      this.scene.remove(b.group);
      b.group.traverse((o) => { o.geometry?.dispose(); });
    }
    this.banners = [];
  }
}
