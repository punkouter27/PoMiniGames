// bloodFluid.js — blood simulated on the GPU: droplets in the air, and the film they leave
// on the canvas. WebGPU only (compute shaders and storage buffers); where the renderer is on
// its WebGL2 backend `createBloodFluid` returns null and blood.js keeps its closed-form spray
// and the canvas keeps matWear's painted stains.
//
// DROPLETS. Each one is simulated every frame, not played back along a fixed arc: gravity and
// drag, then collisions. It glances off a fighter's head, chest and hips (spheres the engine
// moves each frame), and when it meets the canvas it stops, sits for a moment as a bead, and
// hands its volume to the film underneath. Spawning is a compute pass too: an emitter is a
// handful of uniforms and the GPU fills a run of slots from them, so a heavy burst costs the
// CPU nothing per droplet.
//
// FILM. The canvas carries a grid of cells (6 cm), each holding how much wet blood is on it
// and how much has dried in. Two passes a frame:
//   carry    feet and fallen bodies drag the film with them (it is advected along whatever is
//            moving through it), and the frame's new blood arrives: beads the droplet pass
//            dropped into the cell, and the splats blood.js reports for its own lit drops
//   spread   a deep cell runs into its shallower neighbours; a thin one is pinned by surface
//            tension and stays a bead. Then it dries, leaving its stain behind.
// The canvas material reads the grid directly, so the film is lit by the ring lights like the
// vinyl it sits on: dark where it has dried in, glossy where it is still wet.
//
// Presentation only: nothing here feeds back into the match.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, Loop, abs, cameraProjectionMatrix, cameraViewMatrix, clamp, dot, exp, float, floor, fract, hash,
  instanceIndex, instancedArray, int, length, max, min, mix, positionGeometry, select, smoothstep, step, storage,
  normalView, normalize, transformNormalToView, uint, uniform, uniformArray, uv, varying, vec2, vec3, vec4,
} from 'three-eco/tsl';

const DROPS = 16384;          // droplets in the ring buffer
const GRID = 192;             // film cells per side
const COLLIDERS = 8;          // body spheres the droplets glance off
const PUSHERS = 8;            // feet and bodies that drag the film
const SPLATS = 12;            // lit-drop landings accepted per frame
const EMITS = 6;              // bursts accepted per frame

const GRAVITY = -11;
const AIR_DRAG = 0.9;
const BEAD_SECS = 1.6;        // a landed droplet sits this long before it is only film
const BEAD_VOLUME = 0.3;      // film height one droplet adds to the cell it lands in
const SPREAD_ABOVE = 0.22;    // film deeper than this runs into its neighbours
const SPREAD_RATE = 0.18;     // share of the height difference moved per pass (stable under 0.25)
const DRY_SECS = 22;          // wet film → dry
const PUSH_RADIUS = 0.24;     // metres round a foot that drags the film
const DROP_COLOR = 0x7c0e0b;  // unlit, so it carries its own brightness
const FILM_WET = 0x4d0907;
const FILM_DRY = 0x230605;
const FILM_RELIEF = 0.9;       // how steep the film's edge is shaded, per unit of height

/**
 * @param {object} renderer  an initialised WebGPURenderer
 * @param {{half: number, floorY: number}} o  half-width of the canvas, and its top
 * @returns {null | object} the simulation, or null when this renderer cannot run it
 */
export function createBloodFluid(renderer, { half, floorY }) {
  if (!renderer?.backend?.isWebGPUBackend) return null;

  // ── Droplets ─────────────────────────────────────────────────────────
  const P = instancedArray(DROPS, 'vec4');     // xyz, seconds left (<= 0: free slot)
  const V = instancedArray(DROPS, 'vec4');     // velocity, radius in metres
  const S = instancedArray(DROPS, 'vec4');     // landed 0/1, life it started with, alpha, spare

  // ── Film ─────────────────────────────────────────────────────────────
  const CELLS = GRID * GRID;
  const A = instancedArray(CELLS, 'vec4');     // x wet height, y dried stain: what is drawn
  const B = instancedArray(CELLS, 'vec4');     // scratch for the two-pass step
  const D = instancedArray(CELLS, 'float');    // this frame's deposits from the droplet pass
  const cellOf = (xz) => {
    const g = clamp(xz.add(half).div(2 * half).mul(GRID), 0, GRID - 1);
    return int(floor(g.y)).mul(GRID).add(int(floor(g.x)));
  };

  const dt = uniform(1 / 60);
  const colliders = uniformArray(Array.from({ length: COLLIDERS }, () => new THREE.Vector4(0, -99, 0, 0)));
  const pushers = uniformArray(Array.from({ length: PUSHERS }, () => new THREE.Vector4(0, 0, 0, 0)));   // x, z, vx, vz
  const splats = uniformArray(Array.from({ length: SPLATS }, () => new THREE.Vector4(0, 0, 0, 0)));     // x, z, radius, amount

  // One burst. Slots [start, start + count) of the ring are (re)born from these.
  const eOrigin = uniform(new THREE.Vector3()), eDir = uniform(new THREE.Vector3(1, 0, 0));
  const eStart = uniform(0), eCount = uniform(0), ePower = uniform(1), eSeed = uniform(0, 'uint');
  // 1 = thrown by a blow; near 0 = let go of, a drip that only falls.
  const eThrow = uniform(1);
  const emitPass = Fn(() => {
    const slot = float(instanceIndex).sub(eStart);
    const offset = select(slot.lessThan(0), slot.add(DROPS), slot);
    If(offset.lessThan(eCount), () => {
      const rnd = (k) => hash(instanceIndex.mul(uint(13)).add(uint(k)).add(eSeed));
      // The first sixth are a fine mist that hangs; the rest are streaks thrown along the blow.
      const mist = step(rnd(1), 0.16);
      const speed = mix(mix(1.6, 6.4, rnd(2)), mix(0.4, 1.5, rnd(2)), mist).mul(ePower.mul(0.3).add(0.7)).mul(eThrow);
      const side = vec3(eDir.z.negate(), 0, eDir.x);
      const cone = eDir.mul(speed)
        .add(side.mul(rnd(3).sub(0.5).mul(1.1).mul(speed)))
        .add(vec3(0, mix(0.3, 2.7, rnd(4)).mul(eThrow), 0))
        // A blow with no heading (straight up or down) fans all the way round.
        .add(vec3(rnd(5).sub(0.5), 0, rnd(6).sub(0.5)).mul(length(eDir.xz).oneMinus().mul(4)).mul(eThrow));
      const jitter = vec3(rnd(7), rnd(8), rnd(9)).sub(0.5).mul(0.07);
      const life = mix(1.2, 2.6, rnd(10));
      P.element(instanceIndex).assign(vec4(eOrigin.add(jitter), life));
      V.element(instanceIndex).assign(vec4(cone, mix(mix(0.009, 0.024, rnd(11)), mix(0.05, 0.085, rnd(11)), mist)));
      S.element(instanceIndex).assign(vec4(0, life, mix(mix(0.8, 1, rnd(12)), 0.2, mist), mist));
    });
  })().compute(DROPS);

  const dropPass = Fn(() => {
    const p = P.element(instanceIndex), v = V.element(instanceIndex), s = S.element(instanceIndex);
    If(p.w.greaterThan(0), () => {
      const life = p.w.sub(dt).toVar();
      If(s.x.lessThan(0.5), () => {
        const vel = v.xyz.toVar();
        vel.y.addAssign(dt.mul(GRAVITY).mul(s.w.mul(-0.85).add(1)));     // mist barely falls
        vel.mulAssign(exp(dt.mul(-AIR_DRAG).mul(s.w.mul(3).add(1))));
        const pos = p.xyz.add(vel.mul(dt)).toVar();
        // Bodies: pushed back to the surface, the inward speed lost, most of the rest too,
        // so a droplet that hits a chest slides off it rather than bouncing like a ball.
        Loop(COLLIDERS, ({ i }) => {
          const c = colliders.element(i);
          const away = pos.sub(c.xyz).toVar();
          const dist = length(away).toVar();
          If(dist.lessThan(c.w), () => {
            const n = away.div(max(dist, 0.0001)).toVar();
            pos.assign(c.xyz.add(n.mul(c.w)));
            vel.subAssign(n.mul(min(dot(vel, n), 0)));
            vel.mulAssign(0.45);
          });
        });
        const landed = float(0).toVar();
        const onCanvas = abs(pos.x).lessThan(half).and(abs(pos.z).lessThan(half));
        If(pos.y.lessThanEqual(floorY).and(onCanvas).and(vel.y.lessThan(0)), () => {
          pos.y.assign(floorY);
          vel.assign(vec3(0));
          landed.assign(1);
          life.assign(min(life, BEAD_SECS));
          // Its volume goes into the film. Several droplets can hit one cell in a frame and
          // the adds are not atomic, so some are lost; nobody can count beads.
          const cell = cellOf(pos.xz);
          D.element(cell).assign(D.element(cell).add(v.w.mul(BEAD_VOLUME / 0.016).mul(s.w.oneMinus())));
        });
        // Off the canvas and under it: gone.
        If(pos.y.lessThan(-0.6), () => { life.assign(0); });
        p.assign(vec4(pos, life));
        v.assign(vec4(vel, v.w));
        s.assign(vec4(landed, s.y, s.z, s.w));
      }).Else(() => {
        p.assign(vec4(p.xyz, life));
      });
    });
  })().compute(DROPS);

  // Film, pass 1: carry (advection by the pushers) and arrivals, A → B.
  const cellXZ = () => {
    const ix = float(instanceIndex.mod(uint(GRID))), iz = float(instanceIndex.div(uint(GRID)));
    return vec2(ix, iz).add(0.5).div(GRID).mul(2 * half).sub(half);
  };
  const readA = (g) => {
    // Bilinear read of the film at a position in cell units.
    const q = clamp(g.sub(0.5), 0, GRID - 1.001);
    const f = fract(q), i0 = floor(q);
    const at = (dx, dz) => A.element(int(i0.y.add(dz)).mul(GRID).add(int(i0.x.add(dx))));
    return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
  };
  const carryPass = Fn(() => {
    const xz = cellXZ().toVar();
    const drag = vec2(0).toVar();
    Loop(PUSHERS, ({ i }) => {
      const u = pushers.element(i);
      const d = xz.sub(u.xy);
      drag.addAssign(u.zw.mul(exp(dot(d, d).negate().div(PUSH_RADIUS * PUSH_RADIUS))));
    });
    const from = xz.sub(drag.mul(dt));
    const film = readA(from.add(half).div(2 * half).mul(GRID)).toVar();
    film.x.addAssign(D.element(instanceIndex));
    Loop(SPLATS, ({ i }) => {
      const sp = splats.element(i);
      const d = xz.sub(sp.xy);
      film.x.addAssign(sp.w.mul(exp(dot(d, d).negate().div(max(sp.z.mul(sp.z), 0.0001)))));
    });
    D.element(instanceIndex).assign(0);
    B.element(instanceIndex).assign(vec4(min(film.x, 3), film.y, 0, 0));
  })().compute(CELLS);

  // Film, pass 2: spread and dry, B → A.
  const spreadPass = Fn(() => {
    const ix = int(instanceIndex.mod(uint(GRID))), iz = int(instanceIndex.div(uint(GRID)));
    const here = B.element(instanceIndex);
    const h = here.x.toVar();
    const flow = float(0).toVar();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = clamp(ix.add(dx), 0, GRID - 1), nz = clamp(iz.add(dz), 0, GRID - 1);
      const hn = B.element(nz.mul(GRID).add(nx)).x;
      // Surface tension: the pair only exchanges when the deeper of the two is over the bar.
      flow.addAssign(hn.sub(h).mul(step(SPREAD_ABOVE, max(hn, h))));
    }
    const wet = max(h.add(flow.mul(SPREAD_RATE)), 0).toVar();
    const stain = max(here.y, min(wet.mul(5), 1));
    A.element(instanceIndex).assign(vec4(wet.mul(exp(dt.div(-DRY_SECS))), stain, 0, 0));
  })().compute(CELLS);

  const clearDrops = Fn(() => { P.element(instanceIndex).assign(vec4(0, -9, 0, 0)); })().compute(DROPS);
  const clearFilm = Fn(() => {
    A.element(instanceIndex).assign(vec4(0));
    B.element(instanceIndex).assign(vec4(0));
    D.element(instanceIndex).assign(0);
  })().compute(CELLS);

  // ── Drawing the droplets ─────────────────────────────────────────────
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry().copy(quad);
  quad.dispose();
  geo.instanceCount = DROPS;
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  {
    const p = P.toAttribute(), v = V.toAttribute(), s = S.toAttribute();
    const alive = p.w.greaterThan(0);
    const size = select(alive, v.w.mul(2), 0);
    const view = cameraViewMatrix.mul(vec4(p.xyz, 1));
    // In the air a droplet is a streak along its motion on screen; the faster, the longer.
    const vv = cameraViewMatrix.mul(vec4(v.xyz, 0)).xy;
    const speed = length(vv);
    const along = select(speed.greaterThan(0.05), vv.div(max(speed, 0.0001)), vec2(1, 0));
    const across = vec2(along.y.negate(), along.x);
    const stretch = min(speed.mul(0.03).div(max(v.w, 0.004)), 5).mul(s.w.oneMinus()).add(1);
    const air = view.add(vec4(
      along.mul(positionGeometry.x.mul(stretch)).add(across.mul(positionGeometry.y)).mul(size), 0, 0));
    // On the canvas it is a bead lying flat, a little wider than it flew.
    const bead = cameraViewMatrix.mul(vec4(
      p.xyz.add(vec3(positionGeometry.x, 0, positionGeometry.y).mul(size.mul(1.7))).add(vec3(0, 0.004, 0)), 1));
    material.vertexNode = cameraProjectionMatrix.mul(select(s.x.greaterThan(0.5), bead, air));
    const fade = smoothstep(0, 0.35, p.w);
    const r = length(uv().sub(0.5)).mul(2);
    material.colorNode = new THREE.Color(DROP_COLOR);
    material.opacityNode = smoothstep(0.55, 1, r).oneMinus().mul(varying(select(alive, s.z.mul(fade), 0)));
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  // ── Drawing the film (nodes for the canvas material) ─────────────────
  const filmRead = storage(A.value, 'vec4', CELLS).toReadOnly();
  /**
   * Lay the film over the canvas material's own colour and roughness nodes.
   * @param {object} worldXZ  node: the fragment's world XZ
   */
  const over = (colorNode, roughnessNode, worldXZ) => {
    const q = clamp(worldXZ.add(half).div(2 * half).mul(GRID).sub(0.5), 0, GRID - 1.001);
    const f = fract(q), i0 = floor(q);
    const at = (dx, dz) => filmRead.element(int(i0.y.add(dz)).mul(GRID).add(int(i0.x.add(dx))));
    const film = mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
    // A liquid has an edge: the cover comes up sharply at a thin film, not as a gradient.
    const wet = smoothstep(0.03, 0.1, film.x);
    const stained = mix(colorNode, new THREE.Color(FILM_DRY), film.y.mul(0.74));
    // The film has thickness, and its surface slopes down to its edge. That slope is what
    // the ring lights catch: a bright rim round every puddle and bead, which is the single
    // thing that makes a dark patch read as liquid. From the height difference across the
    // four cells this fragment sits between, exaggerated (the real film is a millimetre).
    const h00 = at(0, 0).x, h10 = at(1, 0).x, h01 = at(0, 1).x, h11 = at(1, 1).x;
    const slope = vec2(mix(h10.sub(h00), h11.sub(h01), f.y), mix(h01.sub(h00), h11.sub(h10), f.x)).mul(FILM_RELIEF);
    const filmNormal = transformNormalToView(normalize(vec3(slope.x.negate(), 1, slope.y.negate())));
    return {
      colorNode: mix(stained, new THREE.Color(FILM_WET), wet.mul(0.94)),
      roughnessNode: mix(roughnessNode, 0.06, wet),
      normalNode: normalize(mix(normalView, filmNormal, wet)),
    };
  };

  let cursor = 0, seed = 1, wantClear = true;
  const bursts = [];
  let splatCount = 0;

  return {
    mesh,
    over,
    /** Throw `count` droplets from `origin` along `dir` (need not be unit). Queued to the next update. */
    emit(origin, dir, power = 1, count = 160, thrown = 1) {
      // `thrown` near 0 makes it a drip: let go where it is, to fall straight down.
      if (bursts.length >= EMITS) return;
      const flat = Math.hypot(dir.x, dir.z);
      bursts.push({
        x: origin.x, y: origin.y, z: origin.z,
        dx: flat > 0.05 ? dir.x / flat : 0, dz: flat > 0.05 ? dir.z / flat : 0, power, count, thrown,
      });
    },
    /** A lit drop landed at (x, z): add it to the film. */
    splat(x, z, radius, amount) {
      if (splatCount >= SPLATS) return;
      splats.array[splatCount++].set(x, z, radius, amount);
    },
    /** Sphere `i` (centre, radius) the droplets glance off this frame; radius 0 switches it off. */
    setCollider(i, x, y, z, radius) {
      if (i < COLLIDERS) colliders.array[i].set(x, y, z, radius);
    },
    /** Pusher `i`: something at (x, z) moving at (vx, vz) m/s through the film. */
    setPusher(i, x, z, vx, vz) {
      if (i < PUSHERS) pushers.array[i].set(x, z, vx, vz);
    },
    update(step) {
      if (wantClear) { wantClear = false; renderer.compute(clearDrops); renderer.compute(clearFilm); }
      dt.value = Math.min(step, 1 / 20);
      for (const b of bursts) {
        eOrigin.value.set(b.x, b.y, b.z);
        eDir.value.set(b.dx, 0, b.dz);
        eStart.value = cursor; eCount.value = b.count; ePower.value = b.power; eSeed.value = seed;
        eThrow.value = b.thrown;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        cursor = (cursor + b.count) % DROPS;
        renderer.compute(emitPass);
      }
      bursts.length = 0;
      renderer.compute(dropPass);
      renderer.compute(carryPass);
      renderer.compute(spreadPass);
      for (let i = 0; i < splatCount; i++) splats.array[i].w = 0;
      splatCount = 0;
    },
    /**
     * Run every pass once, empty. A compute pipeline is compiled the first time it is
     * dispatched; done here, at boot, that cost sits under the loading screen instead of on
     * the first frame of the fight (and the first burst no longer hitches).
     */
    warm() {
      eCount.value = 0;
      for (const pass of [clearDrops, clearFilm, emitPass, dropPass, carryPass, spreadPass]) renderer.compute(pass);
      wantClear = false;
    },
    /** Empty the air and the canvas (a rematch). Runs on the next update. */
    clear() { wantClear = true; bursts.length = 0; },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      material.dispose();
      for (const pass of [emitPass, dropPass, carryPass, spreadPass, clearDrops, clearFilm]) pass.dispose?.();
    },
  };
}
