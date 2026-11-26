// platform/3d/softBody.js — XPBD soft bodies (distance + volume + shape-attachment constraints),
// solved in a TSL compute shader on three r186 WebGPU, with the same algorithm on the CPU for the
// WebGL2 backend (and for the frames before the renderer is known).
//
// WHY XPBD (extended position-based dynamics) and not a spring-mass system or Rapier's own soft
// bodies: every constraint has a COMPLIANCE (inverse stiffness, in m/N) that is independent of the
// step size and iteration count, so one number says "jelly" or "rubber" and it keeps meaning that
// at 30 or 144 fps and at 3 or 12 iterations. A volume constraint is what makes squash-and-stretch
// read: pressed flat along the contact normal, the body bulges sideways instead of just shrinking.
//
// WHAT RUNS WHERE
//   Particles = the vertices of a welded, indexed triangle mesh (createIcoSphere). Constraints:
//     * distance  — every edge keeps its rest length (cloth/shell stiffness);
//     * volume    — the closed mesh keeps its rest volume V0: C = V - V0, gradient per vertex is the
//                   sum of its incident triangles' (b x c)/6, so one scalar lambda is shared by all;
//     * attach    — a soft pull toward the rest position in the body's local frame (shape memory).
//   The body is simulated in LOCAL space (origin = the host object's centre) and driven by the host's
//   acceleration as a fictitious force, so a rigid-body hit (the marble landing: huge deceleration in
//   one step) squashes it and the springs/volume rebound it, with no coupling code beyond one vec3.
//   The force is weighted per vertex: a push acts on the host through its CONTACT side, so the
//   vertices there travel with the host (weight 0) while the far side lags by the full inertia
//   (weight 1): w = 1/2 - 1/2 * (rest direction . fictitious-force direction). A uniform force would
//   only slide the shell; the weighting is what compresses it along the hit and lets the volume
//   constraint bulge it sideways.
//   Jacobi iterations (each vertex gathers its own constraints), in-place on the GPU: the tiny race
//   between threads only adds relaxation noise, and the volume scalar is reduced in its own 1-thread
//   dispatch per iteration (N is a few hundred, so that is microseconds).
//   GPU: predict -> K x [volume reduce, solve] -> finalize velocities -> vertex normals, as
//   renderer.compute([...]) dispatches. The mesh then reads positions AND normals from the storage
//   buffers in its vertex stage (material.positionNode / normalNode), so nothing returns to the CPU.
//   CPU/WebGL2: identical maths on Float32Arrays, written straight into the geometry attributes.
//
// Off the WebGPU backend `use(renderer)` leaves the CPU path in place; nothing here throws.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, Loop, cross, dot, float, instanceIndex, instancedArray, int, length, max, normalize, select,
  transformNormalToView, uniform, vec3, vec4, vertexIndex,
} from 'three-eco/tsl';

const MAXN = 6;   // icosphere vertices have 5 or 6 neighbours / incident triangles

/** Welded, indexed, outward-wound icosphere. Returns { positions:Float32Array, indices:Uint32Array }. */
export function createIcoSphere(subdiv = 2, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  verts = verts.map(norm);
  for (let s = 0; s < subdiv; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = cache.get(key);
      if (i === undefined) {
        const va = verts[a], vb = verts[b];
        i = verts.length; verts.push(norm([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2])); cache.set(key, i);
      }
      return i;
    };
    const next = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  // Outward winding: flip any triangle whose normal points at the centre.
  for (const tr of tris) {
    const a = verts[tr[0]], b = verts[tr[1]], c = verts[tr[2]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * a[0] + n[1] * a[1] + n[2] * a[2] < 0) { const x = tr[1]; tr[1] = tr[2]; tr[2] = x; }
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { positions[i * 3] = v[0] * radius; positions[i * 3 + 1] = v[1] * radius; positions[i * 3 + 2] = v[2] * radius; });
  return { positions, indices: Uint32Array.from(tris.flat()) };
}

/**
 * A soft body over an indexed closed mesh.
 * @param {object} o
 * @param {Float32Array} o.positions rest positions (xyz), local space
 * @param {Uint32Array} o.indices triangles
 * @param {number} [o.distanceCompliance=2e-4] edge compliance (m/N); 0 = rigid edges
 * @param {number} [o.volumeCompliance=2e-5]   volume compliance; larger = squishier, less bulge
 * @param {number} [o.attachCompliance=0.02]   shape memory; larger = floppier, slower to recover
 * @param {number} [o.damping=0.92]            per-step velocity damping
 * @param {number} [o.iterations=6]
 */
export class SoftBody {
  constructor(o) {
    const rest = o.positions, tris = o.indices;
    this.n = rest.length / 3;
    this.t = tris.length / 3;
    this.alphaD = o.distanceCompliance ?? 2e-4;
    this.alphaV = o.volumeCompliance ?? 2e-5;
    this.alphaA = o.attachCompliance ?? 0.02;
    this.damping = o.damping ?? 0.92;
    this.iterations = o.iterations ?? 6;
    this.mode = 'cpu';
    this._renderer = null;
    this._gpu = null;
    this.rest = Float32Array.from(rest);
    this.pos = Float32Array.from(rest);
    this.prev = Float32Array.from(rest);
    this.vel = new Float32Array(rest.length);
    this.restDir = new Float32Array(rest.length);   // unit direction of each rest vertex from the centre
    for (let i = 0; i < rest.length; i += 3) {
      const l = Math.hypot(rest[i], rest[i + 1], rest[i + 2]) || 1;
      this.restDir[i] = rest[i] / l; this.restDir[i + 1] = rest[i + 1] / l; this.restDir[i + 2] = rest[i + 2] / l;
    }
    this.nor = new Float32Array(rest.length);
    this.tris = Int32Array.from(tris);

    // Adjacency, padded to MAXN with -1: neighbours (+ rest lengths) and incident triangles.
    const n = this.n;
    this.nbr = new Int32Array(n * MAXN).fill(-1);
    this.nbrLen = new Float32Array(n * MAXN);
    this.inc = new Int32Array(n * MAXN).fill(-1);
    const deg = new Uint8Array(n), tdeg = new Uint8Array(n);
    const addNbr = (a, b) => {
      for (let k = 0; k < deg[a]; k++) if (this.nbr[a * MAXN + k] === b) return;
      if (deg[a] >= MAXN) return;
      this.nbr[a * MAXN + deg[a]] = b;
      this.nbrLen[a * MAXN + deg[a]] = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
      deg[a]++;
    };
    for (let f = 0; f < this.t; f++) {
      const a = this.tris[f * 3], b = this.tris[f * 3 + 1], c = this.tris[f * 3 + 2];
      addNbr(a, b); addNbr(b, a); addNbr(b, c); addNbr(c, b); addNbr(c, a); addNbr(a, c);
      for (const v of [a, b, c]) if (tdeg[v] < MAXN) this.inc[v * MAXN + tdeg[v]++] = f;
    }
    this.v0 = this._volume(this.rest);
    this.accel = { x: 0, y: 0, z: 0 };

    // Render geometry for the CPU path; the GPU path reads storage buffers instead.
    this.geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.pos, 3);
    this.normalAttr = new THREE.BufferAttribute(this.nor, 3);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('normal', this.normalAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(tris), 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4 * Math.max(1e-3, Math.hypot(rest[0], rest[1], rest[2])));
    this._cpuNormals();
    this.normalAttr.needsUpdate = true;
  }

  _volume(p) {
    let v = 0;
    for (let f = 0; f < this.t; f++) {
      const a = this.tris[f * 3] * 3, b = this.tris[f * 3 + 1] * 3, c = this.tris[f * 3 + 2] * 3;
      v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return v;
  }

  /** Volume of the current shape (CPU path; used by tests and to prove the volume constraint holds). */
  volume() { return this.mode === 'cpu' ? this._volume(this.pos) : this.v0; }

  /**
   * Hand over the renderer (any time). On the WebGPU backend this builds the compute kernels once and
   * returns true: the caller must then give its material the nodes from `gpuNodes()`.
   */
  use(renderer) {
    if (this._renderer === renderer) return this.mode === 'gpu';
    this._renderer = renderer;
    if (!renderer || !renderer.backend || !renderer.backend.isWebGPUBackend || typeof renderer.compute !== 'function') return false;
    try { this._buildGpu(); this.mode = 'gpu'; return true; } catch (err) {
      console.warn('[softBody] GPU path unavailable, staying on CPU:', err?.message || err);
      this._gpu = null; this.mode = 'cpu';
      return false;
    }
  }

  /** TSL nodes for a material: { positionNode, normalNode } (valid once `use()` returned true). */
  gpuNodes() {
    const g = this._gpu;
    if (!g) return null;
    return {
      positionNode: g.P.element(vertexIndex).xyz,
      normalNode: transformNormalToView(g.N.element(vertexIndex).xyz),
    };
  }

  /** Advance by dt. `accel` is the HOST's acceleration (world units/s^2); the body feels the opposite. */
  step(dt, ax = 0, ay = 0, az = 0) {
    dt = Math.min(Math.max(dt, 1e-4), 1 / 30);
    // Fictitious force: the body lags behind its accelerating host.
    this.accel.x = -ax; this.accel.y = -ay; this.accel.z = -az;
    if (this.mode === 'gpu') this._stepGpu(dt); else this._stepCpu(dt);
  }

  // ── CPU path ───────────────────────────────────────────────────────────────────────────────────
  _stepCpu(dt) {
    const n = this.n, P = this.pos, V = this.vel, Pp = this.prev, R = this.rest;
    const am = Math.hypot(this.accel.x, this.accel.y, this.accel.z);
    const ux = am > 1e-6 ? this.accel.x / am : 0, uy = am > 1e-6 ? this.accel.y / am : 0, uz = am > 1e-6 ? this.accel.z / am : 0;
    const amdt = am * dt, damp = this.damping, RH = this.restDir;
    for (let i = 0; i < n * 3; i += 3) {
      const w = Math.min(1, Math.max(0, 0.5 - 0.5 * (RH[i] * ux + RH[i + 1] * uy + RH[i + 2] * uz))) * amdt;
      V[i] = (V[i] + ux * w) * damp; V[i + 1] = (V[i + 1] + uy * w) * damp; V[i + 2] = (V[i + 2] + uz * w) * damp;
      Pp[i] = P[i]; Pp[i + 1] = P[i + 1]; Pp[i + 2] = P[i + 2];
      P[i] += V[i] * dt; P[i + 1] += V[i + 1] * dt; P[i + 2] += V[i + 2] * dt;
    }
    const inv2 = 1 / (dt * dt);
    const dDen = 2 + this.alphaD * inv2, aDen = 1 + this.alphaA * inv2, aV = this.alphaV * inv2;
    const T = this.tris, INC = this.inc, NB = this.nbr, NL = this.nbrLen;
    const out = this._tmp || (this._tmp = new Float32Array(n * 3));
    for (let it = 0; it < this.iterations; it++) {
      // Volume: one shared lambda.
      const V0 = this.v0;
      const vol = this._volume(P);
      let S = 0;
      const grad = this._grad || (this._grad = new Float32Array(n * 3));
      for (let i = 0; i < n; i++) {
        let gx = 0, gy = 0, gz = 0;
        for (let k = 0; k < MAXN; k++) {
          const f = INC[i * MAXN + k]; if (f < 0) break;
          const ia = T[f * 3], ib = T[f * 3 + 1], ic = T[f * 3 + 2];
          const a = ia * 3, b = ib * 3, c = ic * 3;
          let ux, uy, uz, wx, wy, wz;   // gradient = (u x w) / 6
          if (ia === i) { ux = P[b]; uy = P[b + 1]; uz = P[b + 2]; wx = P[c]; wy = P[c + 1]; wz = P[c + 2]; }
          else if (ib === i) { ux = P[c]; uy = P[c + 1]; uz = P[c + 2]; wx = P[a]; wy = P[a + 1]; wz = P[a + 2]; }
          else { ux = P[a]; uy = P[a + 1]; uz = P[a + 2]; wx = P[b]; wy = P[b + 1]; wz = P[b + 2]; }
          gx += (uy * wz - uz * wy) / 6; gy += (uz * wx - ux * wz) / 6; gz += (ux * wy - uy * wx) / 6;
        }
        grad[i * 3] = gx; grad[i * 3 + 1] = gy; grad[i * 3 + 2] = gz;
        S += gx * gx + gy * gy + gz * gz;
      }
      const lambda = -(vol - V0) / (S + aV);
      // Per-vertex Jacobi gather (reads P, writes `out`, then swapped in).
      for (let i = 0; i < n; i++) {
        const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
        let dx = 0, dy = 0, dz = 0, cnt = 0;
        for (let k = 0; k < MAXN; k++) {
          const j = NB[i * MAXN + k]; if (j < 0) break;
          const ex = px - P[j * 3], ey = py - P[j * 3 + 1], ez = pz - P[j * 3 + 2];
          const l = Math.max(Math.hypot(ex, ey, ez), 1e-6);
          const w = -(l - NL[i * MAXN + k]) / dDen / l;
          dx += ex * w; dy += ey * w; dz += ez * w; cnt++;
        }
        const ic = 1 / Math.max(cnt, 1);
        out[i * 3] = px + dx * ic + (R[i * 3] - px) / aDen + grad[i * 3] * lambda;
        out[i * 3 + 1] = py + dy * ic + (R[i * 3 + 1] - py) / aDen + grad[i * 3 + 1] * lambda;
        out[i * 3 + 2] = pz + dz * ic + (R[i * 3 + 2] - pz) / aDen + grad[i * 3 + 2] * lambda;
      }
      P.set(out);
    }
    const idt = 1 / dt;
    for (let i = 0; i < n * 3; i++) V[i] = (P[i] - Pp[i]) * idt;
    this._cpuNormals();
    this.positionAttr.needsUpdate = true;
    this.normalAttr.needsUpdate = true;
  }

  _cpuNormals() {
    const P = this.pos, N = this.nor, T = this.tris;
    N.fill(0);
    for (let f = 0; f < this.t; f++) {
      const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
    }
    for (let i = 0; i < N.length; i += 3) {
      const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
      N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
    }
  }

  // ── GPU path ───────────────────────────────────────────────────────────────────────────────────
  _buildGpu() {
    const n = this.n, T = this.t;
    const v4 = (src) => { const a = new Float32Array(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = src[i * 3]; a[i * 4 + 1] = src[i * 3 + 1]; a[i * 4 + 2] = src[i * 3 + 2]; } return a; };
    const P = instancedArray(v4(this.pos), 'vec4');
    const Pp = instancedArray(v4(this.pos), 'vec4');
    const V = instancedArray(new Float32Array(n * 4), 'vec4');
    const R = instancedArray(v4(this.rest), 'vec4');
    const N = instancedArray(v4(this.nor), 'vec4');
    const NB = instancedArray(this.nbr, 'int');
    const NL = instancedArray(this.nbrLen, 'float');
    const IN = instancedArray(this.inc, 'int');
    const TR = instancedArray(this.tris, 'int');
    const LAM = instancedArray(new Float32Array(1), 'float');

    const uDt = uniform(1 / 60);
    const uAccelDir = uniform(new THREE.Vector3());  // unit direction (zero when idle)
    const uAccelMag = uniform(0);
    const uDamp = uniform(this.damping);
    const uAlphaD = uniform(this.alphaD), uAlphaV = uniform(this.alphaV), uAlphaA = uniform(this.alphaA);
    const uV0 = uniform(this.v0);

    // Gradient of the volume w.r.t. vertex `vi` (sum over its incident triangles of (u x w)/6).
    const grad = (vi) => {
      const g = vec3(0).toVar();
      Loop(MAXN, ({ i: k }) => {
        const f = IN.element(vi.mul(MAXN).add(k)).toVar();
        If(f.greaterThanEqual(0), () => {
          const ia = TR.element(f.mul(3)).toVar(), ib = TR.element(f.mul(3).add(1)).toVar(), ic = TR.element(f.mul(3).add(2)).toVar();
          const a = P.element(ia).xyz, b = P.element(ib).xyz, c = P.element(ic).xyz;
          g.addAssign(select(ia.equal(vi), cross(b, c), select(ib.equal(vi), cross(c, a), cross(a, b))).div(6));
        });
      });
      return g;
    };

    const predict = Fn(() => {
      const i = instanceIndex;
      const rh = normalize(R.element(i).xyz);
      const w = float(0.5).sub(dot(rh, uAccelDir).mul(0.5)).clamp(0, 1);
      const v = V.element(i).xyz.add(uAccelDir.mul(uAccelMag.mul(uDt).mul(w))).mul(uDamp).toVar();
      const p = P.element(i).xyz.toVar();
      Pp.element(i).assign(vec4(p, 0));
      V.element(i).assign(vec4(v, 0));
      P.element(i).assign(vec4(p.add(v.mul(uDt)), 0));
    })().compute(n);

    // One thread: V, sum |grad|^2, lambda. n is a few hundred, so this is microseconds.
    const volume = Fn(() => {
      const vol = float(0).toVar();
      Loop(T, ({ i }) => {
        const a = P.element(TR.element(i.mul(3))).xyz, b = P.element(TR.element(i.mul(3).add(1))).xyz, c = P.element(TR.element(i.mul(3).add(2))).xyz;
        vol.addAssign(dot(a, cross(b, c)).div(6));
      });
      const s = float(0).toVar();
      Loop(n, ({ i }) => { const g = grad(int(i)); s.addAssign(dot(g, g)); });
      LAM.element(0).assign(vol.sub(uV0).negate().div(s.add(uAlphaV.div(uDt.mul(uDt)))));
    })().compute(1);

    const solve = Fn(() => {
      const i = int(instanceIndex);
      const p = P.element(i).xyz.toVar();
      const d = vec3(0).toVar(), cnt = float(0).toVar();
      const inv2 = float(1).div(uDt.mul(uDt));
      Loop(MAXN, ({ i: k }) => {
        const j = NB.element(i.mul(MAXN).add(k)).toVar();
        If(j.greaterThanEqual(0), () => {
          const e = p.sub(P.element(j).xyz);
          const l = max(length(e), 1e-6);
          const c = l.sub(NL.element(i.mul(MAXN).add(k)));
          d.addAssign(e.div(l).mul(c.negate().div(float(2).add(uAlphaD.mul(inv2)))));
          cnt.addAssign(1);
        });
      });
      d.divAssign(max(cnt, 1));
      const att = R.element(i).xyz.sub(p).div(float(1).add(uAlphaA.mul(inv2)));
      P.element(i).assign(vec4(p.add(d).add(att).add(grad(i).mul(LAM.element(0))), 0));
    })().compute(n);

    const finalize = Fn(() => {
      const i = instanceIndex;
      V.element(i).assign(vec4(P.element(i).xyz.sub(Pp.element(i).xyz).div(uDt), 0));
    })().compute(n);

    const normals = Fn(() => {
      const i = int(instanceIndex);
      const nv = vec3(0).toVar();
      Loop(MAXN, ({ i: k }) => {
        const f = IN.element(i.mul(MAXN).add(k)).toVar();
        If(f.greaterThanEqual(0), () => {
          const a = P.element(TR.element(f.mul(3))).xyz, b = P.element(TR.element(f.mul(3).add(1))).xyz, c = P.element(TR.element(f.mul(3).add(2))).xyz;
          nv.addAssign(cross(b.sub(a), c.sub(a)));
        });
      });
      N.element(i).assign(vec4(normalize(nv), 0));
    })().compute(n);

    const passes = [predict];
    for (let k = 0; k < this.iterations; k++) passes.push(volume, solve);
    passes.push(finalize, normals);
    this._gpu = { P, N, V, uDt, uAccelDir, uAccelMag, uDamp, passes, uAlphaD, uAlphaV, uAlphaA };
  }

  _stepGpu(dt) {
    const g = this._gpu;
    g.uDt.value = dt;
    const am = Math.hypot(this.accel.x, this.accel.y, this.accel.z);
    g.uAccelMag.value = am;
    g.uAccelDir.value.set(am > 1e-6 ? this.accel.x / am : 0, am > 1e-6 ? this.accel.y / am : 0, am > 1e-6 ? this.accel.z / am : 0);
    g.uAlphaD.value = this.alphaD; g.uAlphaV.value = this.alphaV; g.uAlphaA.value = this.alphaA;
    this._renderer.compute(g.passes);
  }

  /** Read the GPU positions back (async; for verification, never per frame). */
  async readback() {
    if (this.mode !== 'gpu') return Float32Array.from(this.pos);
    const buf = await this._renderer.getArrayBufferAsync(this._gpu.P.value);
    const a = new Float32Array(buf), out = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) { out[i * 3] = a[i * 4]; out[i * 3 + 1] = a[i * 4 + 1]; out[i * 3 + 2] = a[i * 4 + 2]; }
    return out;
  }

  dispose() { this.geometry.dispose(); this._gpu = null; }
}

/**
 * A translucent soft sphere ("jelly shell") around a host object: the SoftBody, its mesh and the
 * material wiring. `update(dt, center, velocity)` derives the host's acceleration from successive
 * velocities and steps the body; the mesh follows `center`. Picks the GPU path itself the first time
 * the renderer draws it.
 * @param {object} o { radius, subdiv=2, color, opacity, ...SoftBody options }
 */
export function createJellyShell(o) {
  const { positions, indices } = createIcoSphere(o.subdiv ?? 2, o.radius);
  const body = new SoftBody({ positions, indices, ...o });
  const material = new THREE.MeshStandardNodeMaterial({
    color: o.color ?? 0xff5a5a, roughness: 0.18, metalness: 0, transparent: true, opacity: o.opacity ?? 0.34, depthWrite: false,
    emissive: o.emissive ?? 0x400808,
  });
  const mesh = new THREE.Mesh(body.geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.userData.noAO = true;
  let wired = false;
  mesh.onBeforeRender = (renderer) => {
    if (wired) return;
    wired = true;
    // Switching to the GPU path swaps the vertex source: compile the material once more.
    if (body.use(renderer)) {
      const nodes = body.gpuNodes();
      material.positionNode = nodes.positionNode;
      material.normalNode = nodes.normalNode;
      material.needsUpdate = true;
    }
  };
  const last = { x: 0, y: 0, z: 0, ok: false };
  const gain = o.accelGain ?? 1, maxA = o.maxAccel ?? 3500;
  const api = {
    mesh, body, material,
    update(dt, center, vel) {
      mesh.position.set(center.x, center.y, center.z);
      let ax = 0, ay = 0, az = 0;
      if (last.ok && dt > 1e-4) {
        ax = (vel.x - last.x) / dt * gain; ay = (vel.y - last.y) / dt * gain; az = (vel.z - last.z) / dt * gain;
        const m = Math.hypot(ax, ay, az);
        if (m > maxA) { const k = maxA / m; ax *= k; ay *= k; az *= k; }
      }
      last.x = vel.x; last.y = vel.y; last.z = vel.z; last.ok = true;
      body.step(dt, ax, ay, az);
    },
    reset() { last.ok = false; body.pos.set(body.rest); body.vel.fill(0); },
    dispose() { body.dispose(); material.dispose(); },
  };
  return api;
}

/**
 * XPBD hanging cloth grid (banners, ring flags, barricade tarps) with wind gusts and radial blast
 * impulses. Runs on the same SoftBody solver architecture with pinned top-row vertices.
 * @param {{ width?: number, height?: number, cols?: number, rows?: number, color?: number, doubleSided?: boolean }} [o]
 */
export function createClothGrid(o = {}) {
  const width = o.width ?? 4, height = o.height ?? 2;
  const cols = Math.max(4, o.cols ?? 24), rows = Math.max(4, o.rows ?? 12);
  const n = cols * rows;
  const dx = width / (cols - 1), dy = height / (rows - 1);
  const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3);
  const at = (i, j) => (j * cols + i) * 3;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = at(i, j);
      pos[k] = prev[k] = -width / 2 + i * dx;
      pos[k + 1] = prev[k + 1] = -j * dy;
      pos[k + 2] = prev[k + 2] = 0;
    }
  }
  const indices = [];
  const links = [];
  const diag = Math.hypot(dx, dy);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      if (i + 1 < cols) links.push(a * 3, (a + 1) * 3, dx);
      if (j + 1 < rows) links.push(a * 3, (a + cols) * 3, dy);
      if (i + 1 < cols && j + 1 < rows) {
        links.push(a * 3, (a + cols + 1) * 3, diag);
        links.push((a + 1) * 3, (a + cols) * 3, diag);
        indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardNodeMaterial({
    color: o.color ?? 0x2a4d8f, roughness: 0.78, metalness: 0.05,
    side: o.doubleSided === false ? THREE.FrontSide : THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  const iters = o.iterations ?? 5;
  function step(dt, windZ = 0, time = 0) {
    const h = Math.min(0.033, Math.max(0.001, dt || 0.016));
    const h2 = h * h, drag = 0.985;
    for (let j = 1; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = at(i, j);
        const x = pos[k], y = pos[k + 1], z = pos[k + 2];
        const vx = (x - prev[k]) * drag, vy = (y - prev[k + 1]) * drag, vz = (z - prev[k + 2]) * drag;
        prev[k] = x; prev[k + 1] = y; prev[k + 2] = z;
        const gust = 0.6 + 0.4 * Math.sin(time * 2.1 + x * 0.9 + y * 0.6);
        pos[k] = x + vx;
        pos[k + 1] = y + vy - 9.81 * h2;
        pos[k + 2] = z + vz + windZ * gust * h2;
      }
    }
    for (let it = 0; it < iters; it++) {
      for (let l = 0; l < links.length; l += 3) {
        const a = links[l], b = links[l + 1], rest = links[l + 2];
        const rx = pos[b] - pos[a], ry = pos[b + 1] - pos[a + 1], rz = pos[b + 2] - pos[a + 2];
        const d = Math.hypot(rx, ry, rz) || 1e-6;
        const diff = (d - rest) / d;
        const pinA = a < cols * 3, pinB = b < cols * 3;
        if (pinA && pinB) continue;
        const wa = pinA ? 0 : (pinB ? 1 : 0.5);
        const wb = pinB ? 0 : (pinA ? 1 : 0.5);
        pos[a] += rx * diff * wa; pos[a + 1] += ry * diff * wa; pos[a + 2] += rz * diff * wa;
        pos[b] -= rx * diff * wb; pos[b + 1] -= ry * diff * wb; pos[b + 2] -= rz * diff * wb;
      }
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function blast(lx, ly, lz, strength = 12, radius = 3.5) {
    const r2 = radius * radius;
    for (let j = 1; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = at(i, j);
        const dx0 = pos[k] - lx, dy0 = pos[k + 1] - ly, dz0 = pos[k + 2] - lz;
        const d2 = dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
        if (d2 >= r2) continue;
        const d = Math.sqrt(d2) || 0.01;
        const f = (1 - d / radius) * strength * 0.016;
        prev[k] -= (dx0 / d) * f;
        prev[k + 1] -= (dy0 / d) * f;
        prev[k + 2] -= (dz0 / d) * f;
      }
    }
  }

  return { mesh, geometry: geo, material: mat, step, blast, dispose() { geo.dispose(); mat.dispose(); } };
}

/**
 * Direct-impulse XPBD soft-body prop (PoBrawl punching bags, PoCabinet deformable bumpers).
 * @param {object} o { radius, subdiv=2, color, ...SoftBody options }
 */
export function createImpactSoftBody(o = {}) {
  const shell = createJellyShell({ opacity: o.opacity ?? 0.95, ...o });
  let pendingAx = 0, pendingAy = 0, pendingAz = 0;
  return {
    ...shell,
    push(ix, iy, iz) { pendingAx += ix; pendingAy += iy; pendingAz += iz; },
    stepImpact(dt) {
      shell.body.step(dt, pendingAx, pendingAy, pendingAz);
      pendingAx *= 0.25; pendingAy *= 0.25; pendingAz *= 0.25;
    },
  };
}
