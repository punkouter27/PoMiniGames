// flock.js — the island's birds as a GPU flock (WebGPU compute).
//
// fauna.js steps twenty-four birds on the main thread, every pair against every other. That
// is all a main thread should spend on scenery, and it is why the sky over the island was
// nearly empty. Here position and velocity live in two storage buffers and one compute pass
// steps every bird, so the same island carries hundreds, and at dusk they do what hundreds
// of birds do: the flocks gather over the middle of the island into one murmuration before
// they go to roost.
//
// THE RULES are the classic three (stay close, fly the same way, do not touch), plus a slow
// target each flock chases round the island (the same loop fauna.js flies), a floor a few
// metres over whatever ground is under the bird (read from the heightmap), and a startle: a
// lightning strike or an eruption throws every bird near it outward.
//
// NEIGHBOURS ARE SAMPLED, NOT SEARCHED. A bird looks at SAMPLES others picked by a hash that
// changes every frame, and reacts to the ones that happen to be near. Over a few frames it
// has seen its whole neighbourhood, the cost is N x SAMPLES instead of N x N, and there is
// no grid to build. It also looks right: a real bird tracks a handful of neighbours, not
// all of them.
//
// Render only, like everything in fauna.js: no rule reads a bird, no sim stream is drawn for
// one. On the WebGL2 backend, or if the passes will not build, `createFlock` returns null
// and fauna.js keeps flying its own birds.
import { BufferAttribute, Color, DataTexture, DoubleSide, FloatType, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, NearestFilter, RedFormat, Vector4 } from 'three-eco/webgpu';
import {
  Fn, If, Loop, clamp, cos, cross, float, hash, instanceIndex, instancedArray, ivec2, length, max, mix, normalize,
  positionGeometry, select, sin, textureLoad, uint, uniform, uniformArray, vec3, vec4,
} from 'three-eco/tsl';
import { VIEW_ONLY_LAYER } from './materials.js';

const SAMPLES = 20;           // other birds looked at per bird per frame
const SEE_METRES = 11;        // a sampled bird nearer than this is a neighbour
const AVOID_METRES = 3.2;     // and one nearer than this is too close
const MIN_SPEED = 6.5;
const MAX_SPEED = 13;
const CLEARANCE = 7;          // metres kept over the ground (and over the sea)
const MAX_GROUPS = 4;
// lighting.js's `night` (1 - the sun's height): the flocks gather past the first and roost
// past the second. A day is two minutes long, so that window is about twelve seconds.
const MERGE_NIGHT = 0.3;
const ROOST_NIGHT = 0.86;

/**
 * @param renderer an initialised WebGPURenderer
 * @param scene
 * @param terrainApi { size, height } (the corner heightmap, (size + 1) squared)
 * @param {{ groups?: number, perGroup?: number }} opts
 * @returns {null | { mesh, count, update(dt, time, state), startle(x, y, z, strength), dispose() }}
 */
export function createFlock(renderer, scene, terrainApi, { groups = 3, perGroup = 300 } = {}) {
  if (!renderer?.backend?.isWebGPUBackend) return null;
  groups = Math.max(1, Math.min(MAX_GROUPS, groups | 0));
  const N = groups * perGroup;
  const size = terrainApi.size; const cs = size + 1;

  // xyz + a random 0..1 (wingbeat phase, wander phase, shade); velocity + the bird's flock.
  const p0 = new Float32Array(N * 4); const v0 = new Float32Array(N * 4);
  for (let b = 0; b < N; b++) {
    const g = Math.floor(b / perGroup);
    p0[b * 4] = size * (0.3 + 0.2 * g) + (Math.random() - 0.5) * 24;
    p0[b * 4 + 1] = 26 + Math.random() * 10;
    p0[b * 4 + 2] = size * 0.5 + (Math.random() - 0.5) * 24;
    p0[b * 4 + 3] = Math.random();
    const a = Math.random() * Math.PI * 2;
    v0[b * 4] = Math.cos(a) * 8; v0[b * 4 + 1] = (Math.random() - 0.5) * 2; v0[b * 4 + 2] = Math.sin(a) * 8;
    v0[b * 4 + 3] = g;
  }
  const P = instancedArray(p0, 'vec4');
  const V = instancedArray(v0, 'vec4');

  const heightTex = new DataTexture(new Float32Array(terrainApi.height), cs, cs, RedFormat, FloatType);
  heightTex.minFilter = heightTex.magFilter = NearestFilter;
  heightTex.unpackAlignment = 1;
  heightTex.needsUpdate = true;

  const uDt = uniform(1 / 60); const uTime = uniform(0);
  const uSeed = uniform(1, 'uint');
  const uMerge = uniform(0);                           // 1: every bird samples the whole flock (dusk)
  const uStartle = uniform(new Vector4(0, 0, 0, 0));   // xyz, strength (decays on the CPU)
  const uPresence = uniform(1);                        // 0 = roosting: drawn at no size
  const targets = uniformArray(Array.from({ length: MAX_GROUPS }, () => new Vector4(size / 2, 30, size / 2, 0)));

  const stepPass = Fn(() => {
    const p = P.element(instanceIndex); const v = V.element(instanceIndex);
    const pos = p.xyz.toVar(); const vel = v.xyz.toVar();
    const group = uint(v.w);
    const merged = uMerge.greaterThan(0.5);
    const first = select(merged, uint(0), group.mul(uint(perGroup)));
    const span = select(merged, float(N), float(perGroup));

    const centre = vec3(0).toVar(); const heading = vec3(0).toVar(); const away = vec3(0).toVar();
    const seen = float(0).toVar();
    Loop(SAMPLES, ({ i }) => {
      const h = hash(instanceIndex.mul(uint(31)).add(uint(i).mul(uint(7919))).add(uSeed));
      const j = first.add(uint(h.mul(span)));
      const other = P.element(j).xyz;
      const d = other.sub(pos);
      const dist = length(d);
      If(dist.lessThan(SEE_METRES).and(dist.greaterThan(0.001)), () => {
        centre.addAssign(other);
        heading.addAssign(V.element(j).xyz);
        seen.addAssign(1);
        If(dist.lessThan(AVOID_METRES), () => { away.subAssign(d.div(dist.mul(dist))); });
      });
    });

    const acc = vec3(0).toVar();
    If(seen.greaterThan(0), () => {
      // The pull together is stronger in the murmuration: it is what makes it one shape.
      acc.addAssign(centre.div(seen).sub(pos).mul(mix(0.16, 0.42, uMerge)));
      acc.addAssign(heading.div(seen).sub(vel).mul(0.7));
    });
    // Only a few of the birds that are too close are among the ones sampled this frame, so
    // each one seen stands for several.
    acc.addAssign(away.mul(34));

    // The flock's target: a steady pull, capped so a bird a long way off does not dive at it.
    const toTarget = targets.element(group).xyz.sub(pos);
    const far = length(toTarget);
    acc.addAssign(toTarget.div(max(far, 0.001)).mul(clamp(far.mul(0.12), 0, 5)));

    // Each bird's own restlessness, so the flock boils instead of gliding as one rigid body.
    const ph = p.w.mul(6.283);
    acc.addAssign(vec3(sin(uTime.mul(1.7).add(ph.mul(3))), sin(uTime.mul(1.1).add(ph.mul(5))).mul(0.5), cos(uTime.mul(1.3).add(ph.mul(2)))).mul(2.6));

    // Thunder, or the mountain going up: away from it, fast.
    If(uStartle.w.greaterThan(0.01), () => {
      const from = pos.sub(uStartle.xyz);
      const range = length(from);
      If(range.lessThan(70), () => {
        acc.addAssign(from.div(max(range, 0.5)).add(vec3(0, 0.5, 0)).mul(uStartle.w.mul(float(1).sub(range.div(70))).mul(40)));
      });
    });

    // The floor: the ground under the bird (the sea counts as ground at 0), plus clearance.
    const cell = ivec2(clamp(pos.xz, 0, size));
    const floor = max(textureLoad(heightTex, cell).r, 0).add(CLEARANCE);
    If(pos.y.lessThan(floor), () => { acc.y.addAssign(floor.sub(pos.y).mul(7)); });
    If(pos.y.greaterThan(95), () => { acc.y.subAssign(pos.y.sub(95).mul(2)); });

    vel.addAssign(acc.mul(uDt));
    const speed = length(vel);
    vel.assign(vel.div(max(speed, 0.001)).mul(clamp(speed, MIN_SPEED, MAX_SPEED)));
    pos.addAssign(vel.mul(uDt));
    p.assign(vec4(pos, p.w));
    v.assign(vec4(vel, v.w));
  })().compute(N);

  // ── drawing: the same flat "V" fauna.js draws, turned to face where it is flying ──
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0.28, -0.62, 0.18, -0.12, 0, 0, -0.32,
    0, 0, 0.28, 0, 0, -0.32, 0.62, 0.18, -0.12,
  ]), 3));
  geometry.instanceCount = N;
  const material = new MeshBasicNodeMaterial({ side: DoubleSide });
  {
    const p = P.toAttribute(); const v = V.toAttribute();
    const forward = normalize(v.xyz);
    const right = normalize(cross(vec3(0, 1, 0), forward).add(vec3(1e-4, 0, 0)));
    const up = cross(forward, right);
    // The wing tips swing through the body plane: at this size that reads as a wingbeat.
    const flap = sin(uTime.mul(mix(9, 13, p.w)).add(p.w.mul(40)));
    const local = positionGeometry;
    material.positionNode = p.xyz.add(
      right.mul(local.x).add(up.mul(local.y.mul(flap))).add(forward.mul(local.z)).mul(uPresence.mul(mix(0.7, 0.95, p.w))));
    const dark = new Color(0x23252b); const light = new Color(0x3b3d45);
    material.colorNode = mix(vec3(dark.r, dark.g, dark.b), vec3(light.r, light.g, light.b), p.w);
  }
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;       // positions are made in the shader; the box is meaningless
  mesh.name = 'flock';
  mesh.layers.set(VIEW_ONLY_LAYER);
  scene.add(mesh);

  let presence = 1; let seed = 1; let startle = 0; let merge = 0;
  const centreXZ = size / 2;
  const points = Array.from({ length: groups }, () => ({ x: centreXZ, y: 30, z: centreXZ }));

  return {
    mesh,
    count: N,
    get merged() { return merge > 0.5; },
    /** 0..1: how far the flocks have gathered into the dusk murmuration. */
    get gather() { return merge; },
    /** Where each flock is headed (the point its birds circle): `[{ x, y, z }]`, reused. */
    points,
    get presence() { return presence; },

    /**
     * @param state { night 0..1, storm 0..1, focus: {x, z} | null, heightAt(x, z) }
     */
    update(dt, time, { night = 0, storm = 0, focus = null, heightAt = () => 0 } = {}) {
      // Roost at night and in a storm: the flock shrinks to nothing rather than vanishing.
      // (Later than fauna.js's birds: the last light is when the murmuration flies.)
      const want = night > ROOST_NIGHT || storm > 0.5 ? 0 : 1;
      presence += (want - presence) * Math.min(1, dt * 0.6);
      uPresence.value = presence;
      if (presence < 0.02) { mesh.visible = false; return; }
      mesh.visible = true;

      // Low sun, either end of the day: one flock over the middle of the island.
      merge += ((night > MERGE_NIGHT ? 1 : 0) - merge) * Math.min(1, dt * 0.6);
      uMerge.value = merge > 0.5 ? 1 : 0;
      for (let g = 0; g < groups; g++) {
        const a = time * (0.045 + g * 0.012) + g * 2.1;
        // Flock 0 circles where the carcasses are when the renderer points it there.
        const scavenging = g === 0 && focus;
        const bx = scavenging ? focus.x : centreXZ; const bz = scavenging ? focus.z : centreXZ;
        const span = scavenging ? 18 : 55 + g * 12;
        let tx = bx + Math.cos(a) * span; let tz = bz + Math.sin(a * 1.3) * span * 0.82;
        let ty = Math.max(16, heightAt(tx, tz) + 18) + g * 3;
        if (merge > 0.02) {
          // The murmuration's own path: a slow figure of eight, low over the island.
          const m = time * 0.11;
          const mx = centreXZ + Math.sin(m) * 46; const mz = centreXZ + Math.sin(m * 2) * 24;
          const my = Math.max(20, heightAt(mx, mz) + 24) + Math.sin(m * 3.1) * 7;
          tx += (mx - tx) * merge; ty += (my - ty) * merge; tz += (mz - tz) * merge;
        }
        targets.array[g].set(tx, ty, tz, 0);
        points[g].x = tx; points[g].y = ty; points[g].z = tz;
      }

      startle = Math.max(0, startle - dt * 0.9);
      uStartle.value.w = startle;
      uDt.value = Math.min(dt, 1 / 20);
      uTime.value = time;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      uSeed.value = seed;
      renderer.compute(stepPass);
    },

    /** Scatter every bird within 70 m of a world point. strength 0..1. */
    startle(x, y, z, strength = 1) {
      uStartle.value.set(x, y, z, 0);
      startle = Math.max(startle, Math.min(1, strength));
    },

    dispose() {
      scene.remove(mesh);
      geometry.dispose(); material.dispose(); heightTex.dispose();
      stepPass.dispose?.();
    },
  };
}
