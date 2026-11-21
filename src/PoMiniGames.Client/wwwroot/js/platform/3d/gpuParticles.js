// platform/3d/gpuParticles.js — compute-shader particles that collide with what the camera sees.
//
// WHAT ALREADY EXISTED, AND WHAT THIS ADDS
//   - platform/particlesCore.js / particlesWorker.js: CPU particles (worker-integrated) for the
//     r165 games. - pobrawl/confettiSim.js, bloodFluid.js: GPU sims of one specific thing each.
//   - poecosystem/render/flock.js: the compute pattern used here (instancedArray + Fn().compute()).
//   - pomarblerace/fx-race.js (before this): 8,192 particles whose motion is a closed-form function
//     of time in the VERTEX shader. Cheap, but a particle is a ballistic curve that goes through the
//     floor: sparks never land, debris never rests, dust never gathers against a wall.
// This is the missing piece: a real per-particle integrator on the GPU, in storage buffers, whose
// update kernel REPROJECTS EACH PARTICLE INTO THE CAMERA'S DEPTH and bounces it off whatever it hits.
//
// HOW THE COLLISION WORKS (screen-space, like Niagara's / Unity VFX Graph's depth collision)
//   depthGrid.js reduces last frame's scene depth to a small grid (nearest + farthest eye distance
//   per cell) before the scene renders. For each particle, per step:
//     1. integrate: gravity, drag, a little wander (snow, dust);
//     2. project the new position through last frame's camera into that grid;
//     3. if the particle is now BEHIND the nearest surface in its cell, but by less than a thickness
//        (so it has just gone through that surface, not slipped behind a wall far in front of it),
//        rebuild the surface normal from the depth of the four neighbouring cells, push the particle
//        back out along it, reflect the velocity (restitution), take friction off the tangential
//        part, and if what is left is slow and the surface faces up, SETTLE it (it stops, and lives
//        out its life lying there).
//   The honest limits of screen-space collision apply: only what the camera saw last frame is solid,
//   so a particle off-screen falls freely, and something hidden behind the first surface cannot be hit.
//   That is the right trade for FX: sparks, debris, dust and snow are only interesting where the
//   player is looking.
//
// DRAWING: ONE draw call, instanced billboards (streaks for sparks: stretched along the screen-space
// velocity), premultiplied blending so sparks add and dust/debris/snow blend in the same pass, and a
// soft fade where a sprite meets a surface (read from the same depth grid: the scene's depth texture
// cannot be sampled while the pass that draws the particles is writing it).
//
// ONE EMIT PATH. `emit(pos, vel, count, preset, opts)` appends a request to a small CPU list; once per
// frame the requests are uploaded in one uniform array and ONE compute dispatch writes every new
// particle into a RING of slots (oldest overwritten first: no free list, no atomics, no readback).
//
// QUALITY: capacity 65,536 / 32,768 / 16,384 on the high / medium / low PoQuality tiers (it was 262,144 on
// high, and a full ring of soft additive sprites cost about 25 ms of overdraw; no caller may ask for more than
// the high cap). The update dispatch and the draw only cover the slots that have ever been used (`hi`), so an
// idle system is free.
//
// Resolves to null off the WebGPU backend (no compute on WebGL2): callers keep what they had.
import {
  CustomBlending, DoubleSide, Float32BufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, OneFactor, OneMinusSrcAlphaFactor, Vector4,
} from 'three-eco/webgpu';
import {
  Fn, If, abs, cameraViewMatrix, cameraWorldMatrix, clamp, cross, dot, exp, float, floor, hash, instanceIndex, instancedArray, int, length, mix,
  normalize, positionGeometry, positionView, screenUV, select, smoothstep, storage, uint, uniform, uniformArray, varying, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { createDepthGrid } from './depthGrid.js';

export const PRESETS = Object.freeze({ sparks: 0, debris: 1, dust: 2, snow: 3 });
const CAPACITY = Object.freeze({ high: 65536, medium: 32768, low: 16384 });
const MAX_REQ = 32;        // emit requests uploaded per frame
const PER_REQ = 512;       // particles one request may spawn (bigger ones are split)

// Four vec4 rows per preset.
//   R0 [gravity m/s^2 (down +), drag 1/s, restitution, friction]
//   R1 [life min s, life max s, size min m, size max m]
//   R2 [stretch (streak length per m/s, 0 = round), soft fade metres, additive 0..1, wander m/s^2]
//   R3 [growth (size multiplier at end of life), fade starts at life fraction, base alpha, 0]
const PRESET_ROWS = [
  // sparks: fast, bright, bouncy, long streaks that burn out
  [[22, 0.35, 0.5, 0.45], [0.5, 1.3, 0.05, 0.11], [0.045, 0.04, 1, 0], [0.2, 0.15, 1, 0]],
  // debris: chunky, heavy, tumbles and stays where it lands
  [[26, 0.12, 0.34, 0.7], [2.5, 5, 0.07, 0.2], [0, 0.04, 0, 0], [1, 0.85, 1, 0]],
  // dust: buoyant, draggy, billows and thins out
  [[-0.5, 2.0, 0, 1], [1.2, 2.6, 0.5, 1.1], [0, 0.7, 0, 1.4], [2.6, 0, 0.3, 0]],
  // snow: slow, wandering, lands and sits until it melts
  [[1.7, 1.1, 0, 1], [4, 8, 0.05, 0.11], [0, 0.06, 0, 2.4], [1, 0.8, 0.95, 0]],
];
const DEFAULT_COLOUR = [[1, 0.72, 0.28], [0.42, 0.38, 0.34], [0.72, 0.68, 0.6], [0.95, 0.97, 1]];

function liveTier() {
  try { return (typeof window !== 'undefined' && window.PoQuality?.tier?.()) || 'high'; } catch { return 'high'; }
}

/**
 * @param renderer an initialised WebGPURenderer
 * @param scene    the scene the sprites are added to
 * @param {{ camera: any, depth?: any, tier?: string, capacity?: number, collide?: boolean }} opts
 *        depth: the scene pass's (non-multisampled) depth TextureNode. Without it particles still fly,
 *        they just do not collide or fade against surfaces.
 * @returns {null | { mesh:any, capacity:number, tier:string, emit:Function, update:Function, clear:Function,
 *                    setVisible:Function, stats:Function, dispose:Function, grid:any, PRESETS:object }}
 */
export function createGpuParticles(renderer, scene, { camera, depth = null, tier = liveTier(), capacity = 0, collide = true } = {}) {
  if (!renderer?.backend?.isWebGPUBackend || !camera) return null;
  const vertexStorage = renderer.backend.device?.limits?.maxStorageBuffersInVertexStage;
  const cap = capacity > 0 ? Math.min(capacity | 0, CAPACITY.high) : (CAPACITY[tier] ?? CAPACITY.high);

  const grid = depth && collide ? createDepthGrid(renderer, { depth, near: camera.near, far: camera.far }) : null;

  // Per-particle state: A = position + age, B = velocity + life, C = colour + size, D = preset, settled, seed.
  const dead = new Float32Array(cap * 4);
  for (let i = 0; i < cap; i++) { dead[i * 4 + 3] = 1; }   // age 1 >= life 0: free
  const A = instancedArray(dead.slice(), 'vec4');
  const B = instancedArray(cap, 'vec4');
  const C = instancedArray(cap, 'vec4');
  const D = instancedArray(cap, 'vec4');

  const rows = uniformArray(PRESET_ROWS.flatMap((p) => p.map((r) => new Vector4(...r))));
  const uDt = uniform(1 / 60);
  const uSeed = uniform(1, 'uint');
  const uCollide = uniform(0);
  const reqs = uniformArray(Array.from({ length: MAX_REQ * 5 }, () => new Vector4()));
  const cols = grid?.cols ?? 1; const nrows = grid?.rows ?? 1;

  // ── emit: one thread per (request, k) ──
  const emitPass = Fn(() => {
    const id = instanceIndex;
    const req = id.div(uint(PER_REQ));
    const k = id.mod(uint(PER_REQ));
    const base5 = req.mul(uint(5));
    const r0 = reqs.element(base5); const r1 = reqs.element(base5.add(1)); const r2 = reqs.element(base5.add(2));
    const r3 = reqs.element(base5.add(3)); const r4 = reqs.element(base5.add(4));
    If(k.lessThan(uint(r1.w)), () => {
      const slot = uint(r0.w).add(k).mod(uint(cap));
      const h = id.mul(uint(97)).add(uSeed);
      const rn = (n) => hash(h.add(uint(n * 7919)));
      const preset = uint(r2.x);
      const pr = rows.element(preset.mul(uint(4)).add(1));
      const dir = normalize(vec3(rn(1).sub(0.5), rn(2).sub(0.5), rn(3).sub(0.5)).add(1e-3));
      const dir2 = normalize(vec3(rn(11).sub(0.5), rn(12).sub(0.5), rn(13).sub(0.5)).add(1e-3));
      const vel = r1.xyz.mul(mix(float(1).sub(r2.z), float(1).add(r2.z), rn(4))).add(dir.mul(r2.y).mul(rn(5).mul(0.7).add(0.3)));
      const pos = r0.xyz.add(dir2.mul(r2.w).mul(rn(6)));
      const life = mix(pr.x, pr.y, rn(7)).mul(r4.x);
      const col = r3.xyz.mul(rn(8).mul(0.3).add(0.85));
      const size = mix(pr.z, pr.w, rn(9)).mul(r3.w);
      A.element(slot).assign(vec4(pos, 0));
      B.element(slot).assign(vec4(vel, life));
      C.element(slot).assign(vec4(col, size));
      D.element(slot).assign(vec4(float(preset), 0, rn(10), 0));
    });
  })().compute(MAX_REQ * PER_REQ);

  // ── view-space position of a grid cell's nearest surface (for normals) ──
  const cellView = (cx, cy) => {
    const c = grid.cell(cx, cy).x;
    const u = float(cx).add(0.5).div(cols).mul(2).sub(1);
    const v = float(1).sub(float(cy).add(0.5).div(nrows).mul(2));
    return vec3(u.mul(c).div(grid.uPrevProjX), v.mul(c).div(grid.uPrevProjY), c.negate());
  };

  // ── update: integrate, collide, settle ──
  const updatePass = Fn(() => {
    const a = A.element(instanceIndex); const b = B.element(instanceIndex); const d = D.element(instanceIndex);
    const life = b.w;
    If(a.w.lessThan(life), () => {
      const preset = uint(d.x);
      const pa = rows.element(preset.mul(uint(4)));
      const pc = rows.element(preset.mul(uint(4)).add(2));
      const pos = a.xyz.toVar(); const vel = b.xyz.toVar(); const settled = d.y.toVar();
      const age = a.w.add(uDt);
      If(settled.lessThan(0.5), () => {
        const hh = instanceIndex.mul(uint(31)).add(uSeed);
        const wander = vec3(hash(hh).sub(0.5), hash(hh.add(uint(17))).sub(0.5), hash(hh.add(uint(43))).sub(0.5)).mul(pc.w);
        vel.addAssign(wander.mul(uDt));
        vel.y.subAssign(pa.x.mul(uDt));
        vel.mulAssign(exp(pa.y.negate().mul(uDt)));
        const np = pos.add(vel.mul(uDt)).toVar();
        if (grid) {
          const pr = grid.project(np);
          const eye = pr.z;
          If(uCollide.greaterThan(0.5).and(pr.w.greaterThan(0.5)).and(pr.x.greaterThan(0.002)).and(pr.x.lessThan(0.998)).and(pr.y.greaterThan(0.002)).and(pr.y.lessThan(0.998)), () => {
            const ix = int(floor(pr.x.mul(cols)));
            const iy = int(floor(pr.y.mul(nrows)));
            const surf = grid.cell(ix, iy).x;
            // A particle this far behind the surface passed BEHIND it (an occluder far in front): leave it be.
            const thick = length(vel).mul(uDt).mul(1.5).max(0.5).add(eye.mul(0.01));
            If(eye.greaterThan(surf).and(eye.lessThan(surf.add(thick))), () => {
              const pc0 = cellView(ix, iy);
              const pL = cellView(ix.sub(1), iy); const pR = cellView(ix.add(1), iy);
              const pU = cellView(ix, iy.sub(1)); const pD = cellView(ix, iy.add(1));
              // The gentler of the two one-sided differences: it stays on this side of a silhouette edge.
              const dx = select(abs(pR.z.sub(pc0.z)).lessThan(abs(pc0.z.sub(pL.z))), pR.sub(pc0), pc0.sub(pL));
              const dy = select(abs(pU.z.sub(pc0.z)).lessThan(abs(pc0.z.sub(pD.z))), pU.sub(pc0), pc0.sub(pD));
              const nv = normalize(cross(dx, dy).add(vec3(0, 0, 1e-5)));
              const nView = select(nv.z.lessThan(0), nv.negate(), nv);
              const n = normalize(grid.uPrevWorld.mul(vec4(nView, 0)).xyz);
              const pen = eye.sub(surf).mul(abs(nView.z)).clamp(0, 0.45);
              np.addAssign(n.mul(pen.add(0.015)));
              const vn = dot(vel, n);
              If(vn.lessThan(0), () => {
                vel.subAssign(n.mul(vn.mul(pa.z.add(1))));
                const vt = vel.sub(n.mul(dot(vel, n)));
                vel.subAssign(vt.mul(pa.w.mul(0.5)));
                If(length(vel).lessThan(1.6).and(n.y.greaterThan(0.35)), () => { vel.assign(vec3(0)); settled.assign(1); });
              });
            });
          });
        }
        pos.assign(np);
      });
      a.assign(vec4(pos, age));
      b.assign(vec4(vel, life));
      d.assign(vec4(d.x, settled, d.z, d.w));
    });
  })().compute(cap);

  // ── draw: instanced billboards / streaks ──
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 0;

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  material.blending = CustomBlending;
  material.blendSrc = OneFactor; material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor; material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.fog = false;
  {
    const aP = A.toAttribute(); const aV = B.toAttribute(); const aC = C.toAttribute(); const aD = D.toAttribute();
    const preset = uint(aD.x);
    const pc = rows.element(preset.mul(uint(4)).add(2));
    const pg = rows.element(preset.mul(uint(4)).add(3));
    const alive = select(aP.w.lessThan(aV.w), float(1), float(0));
    const l01 = clamp(aP.w.div(aV.w.max(1e-3)), 0, 1);
    const size = aC.w.mul(mix(float(1), pg.x, l01)).mul(alive);
    const speed = length(aV.xyz);
    const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const up = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    const sv = cameraViewMatrix.mul(vec4(aV.xyz, 0)).xyz.xy;
    const svLen = length(sv);
    const dir2 = select(svLen.greaterThan(1e-3), sv.div(svLen.max(1e-3)), vec2(0, 1));
    const axis = right.mul(dir2.x).add(up.mul(dir2.y));
    const perp = right.mul(dir2.y.negate()).add(up.mul(dir2.x));
    const streak = pc.x.greaterThan(0);
    const along = select(streak, size.mul(float(1).add(speed.mul(pc.x).mul(float(1).sub(l01.mul(0.5))))).min(size.mul(26)), size);
    const across = select(streak, size.mul(0.42), size);
    material.positionNode = aP.xyz.add(perp.mul(positionGeometry.x).mul(across)).add(axis.mul(positionGeometry.y).mul(along));

    const uv = varying(positionGeometry.xy, 'vPUv');
    const r = length(uv);
    const shape = float(1).sub(smoothstep(0.15, 1, r));
    const alpha = pg.z.mul(float(1).sub(smoothstep(pg.y, 1, l01))).mul(smoothstep(0, 0.05, l01.add(0.02)));
    // Soft fade at a surface: eye distance of this fragment against the nearest surface in its grid cell.
    let soft = float(1);
    if (grid) {
      const gridRO = storage(grid.buffer.value, 'vec2', cols * nrows).toReadOnly();
      const cx = int(floor(screenUV.x.mul(cols))).clamp(0, cols - 1);
      const cy = int(floor(screenUV.y.mul(nrows))).clamp(0, nrows - 1);
      const surf = gridRO.element(cy.mul(cols).add(cx)).x;
      const eye = positionView.z.negate();
      soft = select(uCollide.greaterThan(0.5), clamp(surf.sub(eye).add(0.15).div(pc.y.max(0.01)), 0, 1), float(1));
    }
    const a = shape.mul(alpha).mul(soft);
    const hot = select(streak, mix(vec3(1), aC.rgb, smoothstep(0, 0.9, r)), aC.rgb);   // a white-hot core in a streak
    const rgb = hot.mul(a).mul(mix(float(1), float(2.4), pc.z));
    material.outputNode = vec4(rgb, a.mul(float(1).sub(pc.z)));
  }
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'gpu-particles';
  mesh.renderOrder = 20;
  mesh.userData.noAO = true;
  scene.add(mesh);

  const pending = [];
  let head = 0; let total = 0; let frames = 0;
  let failed = false;
  const _tmp = [0, 0, 0];

  function colourOf(preset, c) {
    if (c === undefined || c === null) return DEFAULT_COLOUR[preset];
    if (typeof c === 'number') { _tmp[0] = ((c >> 16) & 255) / 255; _tmp[1] = ((c >> 8) & 255) / 255; _tmp[2] = (c & 255) / 255; return _tmp; }
    if (Array.isArray(c)) return c;
    return [c.r, c.g, c.b];
  }

  return {
    mesh, capacity: cap, tier, grid, depth, PRESETS,
    get live() { return Math.min(cap, total); },
    get failed() { return failed; },

    /**
     * Queue `count` particles. pos/vel are {x,y,z}; preset is a name ('sparks'|'debris'|'dust'|'snow') or index.
     * opts: { spread (m/s random), speedJitter (0..1), radius (m of position jitter), colour (hex | [r,g,b] | {r,g,b}),
     *         size (multiplier), life (multiplier) }
     */
    emit(pos, vel, count, preset = 'sparks', opts = {}) {
      if (failed || !(count > 0)) return;
      const pi = typeof preset === 'number' ? preset : (PRESETS[preset] ?? 0);
      let left = Math.min(count | 0, cap);
      const col = colourOf(pi, opts.colour);
      while (left > 0 && pending.length < MAX_REQ * 4) {
        const n = Math.min(left, PER_REQ); left -= n;
        pending.push({
          x: pos.x, y: pos.y, z: pos.z, vx: vel?.x ?? 0, vy: vel?.y ?? 0, vz: vel?.z ?? 0, n, pi,
          spread: opts.spread ?? 4, jitter: opts.speedJitter ?? 0.25, radius: opts.radius ?? 0.15,
          r: col[0], g: col[1], b: col[2], size: opts.size ?? 1, life: opts.life ?? 1,
        });
      }
    },

    /** Per frame, BEFORE the scene renders. Reads the depth the previous frame left, steps the particles. */
    update(dt, cam = camera) {
      if (failed) return;
      try {
        uDt.value = Math.min(Math.max(dt, 1 / 240), 1 / 20);
        uSeed.value = (Math.imul(uSeed.value >>> 0, 1664525) + 1013904223) >>> 0;
        // The depth reduce only runs while something is alive or arriving: an idle system costs nothing.
        if (grid && (total > 0 || pending.length)) { grid.update(); uCollide.value = grid.valid ? 1 : 0; }
        const nReq = Math.min(pending.length, MAX_REQ);
        if (nReq) {
          for (let k = 0; k < nReq; k++) {
            const q = pending[k]; const o = k * 5;
            reqs.array[o].set(q.x, q.y, q.z, head);
            reqs.array[o + 1].set(q.vx, q.vy, q.vz, q.n);
            reqs.array[o + 2].set(q.pi, q.spread, q.jitter, q.radius);
            reqs.array[o + 3].set(q.r, q.g, q.b, q.size);
            reqs.array[o + 4].set(q.life, 0, 0, 0);
            head = (head + q.n) % cap; total += q.n;
          }
          pending.splice(0, nReq);
          renderer.compute(emitPass);
        }
        const hi = Math.min(cap, total);
        if (hi > 0) {
          updatePass.count = hi;
          geometry.instanceCount = hi;
          renderer.compute(updatePass);
        }
        mesh.visible = hi > 0;
        grid?.commit(cam);
        frames++;
      } catch (e) { failed = true; mesh.visible = false; console.warn('[gpuParticles] disabled:', e?.message || e); }
    },

    setVisible(v) { mesh.visible = !!v && total > 0; },
    clear() { pending.length = 0; total = 0; head = 0; geometry.instanceCount = 0; mesh.visible = false; /* slots still hold stale rows; `hi` = 0 hides them, and a re-emit overwrites from slot 0 */ },
    /** Debug/tests: read the live particles back. Async; {pos: Float32Array(x,y,z,age), state: Float32Array(preset,settled,seed,0), vel: Float32Array(x,y,z,life)}. */
    async readback() {
      const [a, b, d] = await Promise.all([renderer.getArrayBufferAsync(A.value), renderer.getArrayBufferAsync(B.value), renderer.getArrayBufferAsync(D.value)]);
      return { pos: new Float32Array(a), vel: new Float32Array(b), state: new Float32Array(d) };
    },
    stats() { return { capacity: cap, tier, live: Math.min(cap, total), emitted: total, collide: !!grid?.valid, frames }; },
    dispose() {
      scene.remove(mesh);
      geometry.dispose(); material.dispose();
      try { emitPass.dispose?.(); updatePass.dispose?.(); grid?.dispose(); } catch { /* gone */ }
    },
  };
}
