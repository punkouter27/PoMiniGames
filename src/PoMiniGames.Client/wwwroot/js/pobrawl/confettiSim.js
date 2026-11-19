// confettiSim.js — confetti that lands. WebGPU only (compute shaders and storage buffers);
// on the WebGL2 backend `createConfettiSim` returns null and the callers keep throwing their
// confetti through the shared particle pool, where it flies a fixed arc and fades in the air.
//
// Here every piece is simulated: it flutters down (light gravity, heavy drag, a sideways
// wobble of its own), tumbles as it falls, and stops where it meets something. On the canvas
// or the hall floor it lies flat and stays for the rest of its life, so a KO leaves the ring
// littered. A foot or a falling body going through a lying piece kicks it back into the air.
//
// Spawning is a compute pass: an emitter is a handful of uniforms (where, how fast, how
// scattered) and the GPU fills a run of slots from them.
//
// Presentation only: nothing here feeds back into the match.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, Loop, abs, cameraProjectionMatrix, cameraViewMatrix, cos, cross, dot, exp, float, hash, instanceIndex,
  instancedArray, length, max, min, mix, normalize, positionGeometry, select, sin, smoothstep, uint, uniform,
  uniformArray, varying, vec3, vec4,
} from 'three-eco/tsl';

const PIECES = 6144;
const PUSHERS = 8;
const EMITS = 8;
const GRAVITY = -2.6;         // paper, not gravel
const DRAG = 1.5;
const LIFE = 20;              // seconds a piece exists, most of them lying down
const FADE = 1.6;
const KICK_RADIUS = 0.32;
const HALL_FLOOR = -0.52;     // what catches a piece that misses the ring
const PALETTE = [0xffd257, 0xfff3c4, 0xff4a3c, 0x4a7dff, 0xf5f2ec, 0xffb02e];

/**
 * @param {object} renderer  an initialised WebGPURenderer
 * @param {{half: number, floorY: number}} o  half-width of the canvas, and its top
 * @returns {null | object}
 */
export function createConfettiSim(renderer, { half, floorY }) {
  if (!renderer?.backend?.isWebGPUBackend) return null;

  const P = instancedArray(PIECES, 'vec4');     // xyz, seconds left (<= 0: free slot)
  const V = instancedArray(PIECES, 'vec4');     // velocity, random 0..1 (phase, colour, spin)
  const S = instancedArray(PIECES, 'vec4');     // lying 0/1, size m, spare, spare

  const dt = uniform(1 / 60), time = uniform(0);
  const pushers = uniformArray(Array.from({ length: PUSHERS }, () => new THREE.Vector4(0, 0, 0, 0)));   // x, z, vx, vz
  const palette = uniformArray(PALETTE.map((hex) => new THREE.Color(hex)));

  // One burst: slots [start, start + count) are (re)born inside a box round `origin`, moving
  // at `velocity` with each component jittered by up to `scatter`.
  const eOrigin = uniform(new THREE.Vector3()), eBox = uniform(new THREE.Vector3());
  const eVelocity = uniform(new THREE.Vector3()), eScatter = uniform(new THREE.Vector3());
  const eStart = uniform(0), eCount = uniform(0), eSeed = uniform(0, 'uint');
  const emitPass = Fn(() => {
    const slot = float(instanceIndex).sub(eStart);
    const offset = select(slot.lessThan(0), slot.add(PIECES), slot);
    If(offset.lessThan(eCount), () => {
      const rnd = (k) => hash(instanceIndex.mul(uint(17)).add(uint(k)).add(eSeed));
      const jitter = vec3(rnd(1), rnd(2), rnd(3)).sub(0.5).mul(2);
      const kick = vec3(rnd(4), rnd(5), rnd(6)).sub(0.5).mul(2);
      P.element(instanceIndex).assign(vec4(eOrigin.add(jitter.mul(eBox)), mix(LIFE * 0.75, LIFE, rnd(7))));
      V.element(instanceIndex).assign(vec4(eVelocity.add(kick.mul(eScatter)), rnd(8)));
      S.element(instanceIndex).assign(vec4(0, mix(0.045, 0.085, rnd(9)), 0, 0));
    });
  })().compute(PIECES);

  const stepPass = Fn(() => {
    const p = P.element(instanceIndex), v = V.element(instanceIndex), s = S.element(instanceIndex);
    If(p.w.greaterThan(0), () => {
      const life = p.w.sub(dt).toVar();
      const pos = p.xyz.toVar(), vel = v.xyz.toVar();
      const lying = s.x.toVar();
      If(lying.lessThan(0.5), () => {
        // Flutter: each piece slips sideways on its own rhythm as it comes down.
        const phase = v.w.mul(40).add(time.mul(mix(2.2, 4.4, v.w)));
        vel.addAssign(vec3(sin(phase), 0, cos(phase.mul(1.3))).mul(dt.mul(1.6)));
        vel.y.addAssign(dt.mul(GRAVITY));
        vel.mulAssign(exp(dt.mul(-DRAG)));
        pos.addAssign(vel.mul(dt));
        const onCanvas = abs(pos.x).lessThan(half).and(abs(pos.z).lessThan(half));
        const ground = select(onCanvas, float(floorY), float(HALL_FLOOR));
        If(pos.y.lessThanEqual(ground).and(vel.y.lessThan(0)), () => {
          pos.y.assign(ground);
          vel.assign(vec3(0));
          lying.assign(1);
        });
      }).Else(() => {
        // Lying on the floor: whatever comes through fast enough sends it back up.
        Loop(PUSHERS, ({ i }) => {
          const u = pushers.element(i);
          const speed = length(u.zw);
          If(length(pos.xz.sub(u.xy)).lessThan(KICK_RADIUS).and(speed.greaterThan(0.7)), () => {
            const r = hash(instanceIndex.add(uint(time.mul(60))));
            vel.assign(vec3(u.z.mul(0.7).add(r.sub(0.5)), mix(0.9, 2.1, r), u.w.mul(0.7).add(v.w.sub(0.5))));
            pos.y.addAssign(0.02);
            lying.assign(0);
          });
        });
      });
      p.assign(vec4(pos, life));
      v.assign(vec4(vel, v.w));
      s.assign(vec4(lying, s.y, 0, 0));
    });
  })().compute(PIECES);

  const clearPass = Fn(() => { P.element(instanceIndex).assign(vec4(0, -9, 0, 0)); })().compute(PIECES);

  // ── Drawing ──────────────────────────────────────────────────────────
  const quad = new THREE.PlaneGeometry(1, 0.6);
  const geo = new THREE.InstancedBufferGeometry().copy(quad);
  quad.dispose();
  geo.instanceCount = PIECES;
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  {
    const p = P.toAttribute(), v = V.toAttribute(), s = S.toAttribute();
    const alive = p.w.greaterThan(0);
    const size = select(alive, s.y, 0);
    // The piece's own plane: tumbling about two axes in the air, flat (with its own heading)
    // once it lies down.
    const spin = time.mul(mix(4, 11, v.w)).add(v.w.mul(50));
    const yaw = v.w.mul(31.4);
    const flat = s.x.greaterThan(0.5);
    const tilt = select(flat, float(0), spin);
    const turn = select(flat, yaw, spin.mul(0.6));
    const ax = vec3(cos(turn), 0, sin(turn));
    const up = vec3(0, 1, 0);
    const side = normalize(cross(up, ax));
    const ay = side.mul(cos(tilt)).add(up.mul(sin(tilt)));
    const normal = normalize(cross(ax, ay));
    const world = p.xyz.add(ax.mul(positionGeometry.x).add(ay.mul(positionGeometry.y)).mul(size))
      .add(vec3(0, select(flat, float(0.006), float(0)), 0));
    material.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1)));
    // Paper catching the house lights as it turns: brightest face-up.
    const lit = abs(normal.y).mul(0.5).add(0.5);
    material.colorNode = varying(palette.element(uint(v.w.mul(PALETTE.length - 0.01))).mul(lit));
    material.opacityNode = varying(select(alive, smoothstep(0, FADE, p.w), 0));
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  let cursor = 0, seed = 7, clock = 0, wantClear = true;
  const bursts = [];
  const run = (b) => {
    eOrigin.value.set(b.x, b.y, b.z); eBox.value.set(b.bx, b.by, b.bz);
    eVelocity.value.set(b.vx, b.vy, b.vz); eScatter.value.set(b.sx, b.sy, b.sz);
    eStart.value = cursor; eCount.value = b.count; eSeed.value = seed;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    cursor = (cursor + b.count) % PIECES;
    renderer.compute(emitPass);
  };

  return {
    mesh,
    /**
     * Throw `count` pieces. `box` is the half-size of the volume they start in; `scatter`
     * the per-axis spread added to `velocity`. Queued to the next update.
     */
    emit({ origin, box = [0, 0, 0], velocity = [0, 0, 0], scatter = [0, 0, 0], count = 80 }) {
      if (bursts.length >= EMITS) return;
      bursts.push({
        x: origin[0], y: origin[1], z: origin[2], bx: box[0], by: box[1], bz: box[2],
        vx: velocity[0], vy: velocity[1], vz: velocity[2], sx: scatter[0], sy: scatter[1], sz: scatter[2],
        count: Math.min(count, PIECES),
      });
    },
    /** Pusher `i`: something at (x, z) moving at (vx, vz) m/s along the floor. */
    setPusher(i, x, z, vx, vz) {
      if (i < PUSHERS) pushers.array[i].set(x, z, vx, vz);
    },
    update(step) {
      if (wantClear) { wantClear = false; renderer.compute(clearPass); }
      dt.value = Math.min(step, 1 / 20);
      clock += dt.value;
      time.value = clock;
      for (const b of bursts) run(b);
      bursts.length = 0;
      renderer.compute(stepPass);
    },
    /** Compile the passes now, under the loading screen, not on the first burst. */
    warm() {
      eCount.value = 0;
      for (const pass of [clearPass, emitPass, stepPass]) renderer.compute(pass);
      wantClear = false;
    },
    clear() { wantClear = true; bursts.length = 0; },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      material.dispose();
      for (const pass of [emitPass, stepPass, clearPass]) pass.dispose?.();
    },
  };
}
