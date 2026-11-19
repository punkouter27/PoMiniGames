// particlePool.js — one instanced draw call of camera-facing quads, simulated on the GPU.
//
// A particle is written ONCE at spawn; the vertex stage evaluates the closed-form
// trajectory at the pool's clock —
//     p(t) = p0 + v * (1 - e^(-k*t)) / k  +  0.5 * g * t^2      (k -> 0: p0 + v*t)
// — fades it over its life, and collapses it to nothing once dead. Per frame the CPU only
// advances the clock and uploads the slots written since last frame. Slots are a ring; the
// oldest recycles first.
//
// Two looks from the same pool:
//   additive  sparks, motes, dust: "fade" is colour → black, so alpha is unused.
//   alpha     blood spray: an opaque pigment that thins out, so it darkens what is behind
//             it instead of glowing. Never used for anything that should read as light.
//
// Quads, not THREE.Points: WebGPU draws points one pixel wide, so a sized sprite has to be a
// quad there, and the same quad runs on the WebGL2 backend.
import * as THREE from 'three-eco/webgpu';
import {
  attribute, cameraFar, cameraNear, cameraProjectionMatrix, cameraViewMatrix, exp, max, perspectiveDepthToViewZ,
  positionGeometry, select, smoothstep, texture, uniform, uv, varying, vec3, vec4, viewportDepthTexture,
} from 'three-eco/tsl';

const _color = new THREE.Color();
const SOFT_DEPTH = 0.14;     // metres over which a soft particle fades into what is behind it

// Soft round sprite so particles don't render as squares.
function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 1, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/**
 * @param {number} capacity  slots in the ring
 * @param {{additive?: boolean, renderOrder?: number, soft?: boolean}} [o]  `soft`: fade where a
 *   particle meets the scene behind it, instead of ending on a hard line (see SOFT_DEPTH)
 * @returns {{mesh: object, spawn: Function, update: Function, clear: Function, dispose: Function}}
 */
export function createParticlePool(capacity, { additive = true, renderOrder = 3, soft = false } = {}) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry().copy(quad);
  quad.dispose();
  geo.instanceCount = capacity;
  const attr = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const pos = attr('aPos', 3);       // spawn point
  const vel = attr('aVel', 3);
  const col = attr('aColor', 4);     // rgb + alpha (alpha pools only)
  const meta = attr('aMeta', 4);     // birth, life, gravity, drag
  const size = attr('aSize', 2);     // metres, growth over life (0 = none, 1 = doubles)
  const all = [pos, vel, col, meta, size];
  // Every slot starts long dead.
  for (let i = 0; i < capacity; i++) meta.array[i * 4] = -1e6;

  const sprite = softSprite();
  const uTime = uniform(0);
  // View-space width of a size-1 particle at distance 1: tan(fov / 2), which keeps the
  // on-screen size a size-attenuated point had. Set per frame from the camera.
  const uScale = uniform(0.52);
  const aPos = attribute('aPos', 'vec3'), aVel = attribute('aVel', 'vec3');
  const aColor = attribute('aColor', 'vec4'), aMeta = attribute('aMeta', 'vec4');
  const aSize = attribute('aSize', 'vec2');
  const age = uTime.sub(aMeta.x);
  const alive = age.greaterThanEqual(0).and(age.lessThanEqual(aMeta.y));
  const t = age.div(max(aMeta.y, 0.0001));
  const k = aMeta.w;
  const travel = select(k.greaterThan(0.001), exp(k.mul(age).negate()).oneMinus().div(max(k, 0.001)), age);
  const p = aPos.add(aVel.mul(travel)).add(vec3(0, aMeta.z.mul(0.5).mul(age).mul(age), 0));
  const mv = cameraViewMatrix.mul(vec4(p, 1));
  // Dead or not yet born: zero size, so the quad covers no pixels.
  const width = select(alive, aSize.x.mul(aSize.y.mul(t).add(1)).mul(uScale), 0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    fog: false,
  });
  material.vertexNode = cameraProjectionMatrix.mul(vec4(mv.xy.add(positionGeometry.xy.mul(width)), mv.zw));
  // Soft particles: a quad that cuts through the canvas or a body ends on a hard line, which
  // is what makes a dust puff read as a card. Faded out over the last SOFT_DEPTH metres before
  // whatever is behind it, the puff sits in the scene instead. Needs the scene's depth as a
  // texture, so it is opt-in and only for pools drawn after the opaque pass.
  let soften = 1;
  if (soft) {
    const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
    soften = smoothstep(0, SOFT_DEPTH, varying(mv.z).sub(sceneZ));
  }
  const round = texture(sprite, uv()).a.mul(soften);
  if (additive) {
    // Linear fade to black over the life: additive blending, so black is gone.
    material.colorNode = varying(select(alive, aColor.rgb.mul(t.oneMinus()), vec3(0)));
    material.opacityNode = round;
  } else {
    material.colorNode = varying(aColor.rgb);
    material.opacityNode = round.mul(varying(select(alive, aColor.a.mul(t.oneMinus()), 0)));
  }

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;

  let cursor = 0, clock = 0, lo = Infinity, hi = -1;

  return {
    mesh,
    capacity,
    get clock() { return clock; },
    /**
     * Write one particle. `size` is world metres; `drag` is an exponential velocity damping
     * rate, 0 = none; `alpha` and `grow` matter to alpha pools and puffs.
     */
    spawn(x, y, z, vx, vy, vz, color, life, gravity = -8, sizeM = 0.11, drag = 0, alpha = 1, grow = 0) {
      const i = cursor;
      cursor = (i + 1) % capacity;
      const i2 = i * 2, i3 = i * 3, i4 = i * 4;
      pos.array[i3] = x; pos.array[i3 + 1] = y; pos.array[i3 + 2] = z;
      vel.array[i3] = vx; vel.array[i3 + 1] = vy; vel.array[i3 + 2] = vz;
      _color.set(color);
      col.array[i4] = _color.r; col.array[i4 + 1] = _color.g; col.array[i4 + 2] = _color.b; col.array[i4 + 3] = alpha;
      meta.array[i4] = clock; meta.array[i4 + 1] = life; meta.array[i4 + 2] = gravity; meta.array[i4 + 3] = drag;
      size.array[i2] = sizeM; size.array[i2 + 1] = grow;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    },
    /** Advance the clock (the RENDER clock, so particles keep flying through hitstop). */
    update(dt, camera) {
      clock += dt;
      uTime.value = clock;
      // 1 / projection[1][1] = tan(fov / 2); follows a FOV change (portrait framing, zooms).
      if (camera) uScale.value = 1 / (camera.projectionMatrix.elements[5] || 1.92);
      if (hi < 0) return;
      // Upload only the slots written since last frame. A ring wrap inside one
      // frame makes the span the whole buffer, which is still just one upload.
      const count = hi - lo + 1;
      for (const a of all) {
        a.clearUpdateRanges();
        a.addUpdateRange(lo * a.itemSize, count * a.itemSize);
        a.needsUpdate = true;
      }
      lo = Infinity;
      hi = -1;
    },
    /** Kill everything in flight (a rematch, a round reset). */
    clear() {
      for (let i = 0; i < capacity; i++) meta.array[i * 4] = -1e6;
      meta.clearUpdateRanges();
      meta.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      material.dispose();
      sprite.dispose();
    },
  };
}
