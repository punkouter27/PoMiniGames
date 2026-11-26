// platform/3d/gpuParticlesWebgl2.js — WebGL2 instanced GPU particle fallback for gpuParticles.js.
// Runs on WebGPURenderer's WebGL2 backend (Safari / older GPUs) with the exact same emit/update API
// as createGpuParticles() so games never lose sparks/debris/dust/snow when WebGPU compute is absent.
import {
  AdditiveBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, MeshBasicNodeMaterial, NormalBlending, Float32BufferAttribute,
} from 'three-eco/webgpu';
import {
  clamp, dot, exp, float, instancedBufferAttribute, mix, positionGeometry, select, varying, vec2, vec3, vec4,
} from 'three-eco/tsl';

export const PRESETS = Object.freeze({ sparks: 0, debris: 1, dust: 2, snow: 3 });
const CAP_BY_TIER = Object.freeze({ high: 16384, medium: 8192, low: 4096 });
const GRAVITY = [22, 26, -0.5, 1.7];
const DRAG = [0.35, 0.12, 2.0, 1.1];
const LIFE = [[0.5, 1.3], [2.0, 4.0], [1.2, 2.4], [3.5, 7.0]];
const SIZE = [[0.05, 0.11], [0.07, 0.18], [0.45, 0.95], [0.05, 0.11]];
const DEFAULT_COLOUR = [[1, 0.72, 0.28], [0.42, 0.38, 0.34], [0.72, 0.68, 0.6], [0.95, 0.97, 1]];

export function createWebgl2GpuParticles(renderer, scene, { camera, tier = 'medium', capacity = 0 } = {}) {
  if (!renderer || !scene || !camera) return null;
  const cap = capacity > 0 ? Math.min(capacity | 0, CAP_BY_TIER.high) : (CAP_BY_TIER[tier] ?? CAP_BY_TIER.medium);

  const posLife = new Float32Array(cap * 4);  // x, y, z, age/life (1 = dead)
  const colSize = new Float32Array(cap * 4);  // r, g, b, size
  const vel = new Float32Array(cap * 3);
  const meta = new Float32Array(cap * 2);     // life, preset
  for (let i = 0; i < cap; i++) posLife[i * 4 + 3] = 1;

  const posAttr = new InstancedBufferAttribute(posLife, 4);
  const colAttr = new InstancedBufferAttribute(colSize, 4);
  posAttr.setUsage(DynamicDrawUsage);
  colAttr.setUsage(DynamicDrawUsage);

  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aPosLife', posAttr);
  geo.setAttribute('aColSize', colAttr);
  geo.instanceCount = 0;

  const aPL = instancedBufferAttribute(posAttr);
  const aCS = instancedBufferAttribute(colAttr);
  const q = positionGeometry.xy;
  const alive = aPL.w.lessThan(0.999);
  const fade = clamp(float(1).sub(aPL.w), 0, 1);
  const vCol = varying(aCS.rgb, 'vWgl2PCol');
  const vAlpha = varying(select(alive, fade, float(0)), 'vWgl2PAlpha');
  const vQuad = varying(q, 'vWgl2PQuad');

  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  mat.positionNode = vec3(aPL.xyz).add(vec3(q.x.mul(aCS.w), q.y.mul(aCS.w), float(0)));
  mat.colorNode = vCol;
  const r2 = dot(vQuad, vQuad).mul(4);
  mat.opacityNode = select(r2.greaterThan(1), float(0), exp(r2.mul(-2.2)).mul(vAlpha));
  mat.blending = NormalBlending;

  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'gpu-particles-webgl2';
  scene.add(mesh);

  let head = 0;
  let hi = 0;

  function emit(pos, baseVel, count, preset = 0, opts = {}) {
    const p = typeof preset === 'string' ? (PRESETS[preset] ?? 0) : (preset | 0);
    const n = Math.min(count | 0, 512);
    const spread = opts.spread ?? 2.2;
    const col = opts.color ?? DEFAULT_COLOUR[p] ?? DEFAULT_COLOUR[0];
    const [lMin, lMax] = LIFE[p] ?? LIFE[0];
    const [sMin, sMax] = SIZE[p] ?? SIZE[0];
    const px = pos.x ?? pos[0] ?? 0, py = pos.y ?? pos[1] ?? 0, pz = pos.z ?? pos[2] ?? 0;
    const vx = baseVel?.x ?? baseVel?.[0] ?? 0, vy = baseVel?.y ?? baseVel?.[1] ?? 0, vz = baseVel?.z ?? baseVel?.[2] ?? 0;

    for (let i = 0; i < n; i++) {
      const slot = head;
      head = (head + 1) % cap;
      if (hi < cap) hi = Math.max(hi, slot + 1);
      const o4 = slot * 4, o3 = slot * 3, o2 = slot * 2;
      posLife[o4] = px; posLife[o4 + 1] = py; posLife[o4 + 2] = pz; posLife[o4 + 3] = 0;
      vel[o3] = vx + (Math.random() - 0.5) * spread;
      vel[o3 + 1] = vy + Math.random() * spread * 0.7;
      vel[o3 + 2] = vz + (Math.random() - 0.5) * spread;
      meta[o2] = lMin + Math.random() * (lMax - lMin);
      meta[o2 + 1] = p;
      colSize[o4] = col[0]; colSize[o4 + 1] = col[1]; colSize[o4 + 2] = col[2];
      colSize[o4 + 3] = (sMin + Math.random() * (sMax - sMin)) * (opts.sizeScale ?? 1);
    }
    if (p === PRESETS.sparks) mat.blending = AdditiveBlending;
  }

  function update(dt) {
    if (hi === 0) return;
    const h = Math.min(0.05, Math.max(0.001, dt || 0.016));
    let anyAlive = false;
    for (let i = 0; i < hi; i++) {
      const o4 = i * 4;
      const frac = posLife[o4 + 3];
      if (frac >= 1) continue;
      const o3 = i * 3, o2 = i * 2;
      const life = meta[o2] || 1;
      const p = meta[o2 + 1] | 0;
      const nextFrac = frac + h / life;
      if (nextFrac >= 1) { posLife[o4 + 3] = 1; continue; }
      anyAlive = true;
      const drag = Math.max(0, 1 - (DRAG[p] ?? 0.3) * h);
      vel[o3] *= drag;
      vel[o3 + 1] = (vel[o3 + 1] - (GRAVITY[p] ?? 9.8) * h) * drag;
      vel[o3 + 2] *= drag;
      posLife[o4] += vel[o3] * h;
      posLife[o4 + 1] += vel[o3 + 1] * h;
      posLife[o4 + 2] += vel[o3 + 2] * h;
      posLife[o4 + 3] = nextFrac;
    }
    geo.instanceCount = anyAlive ? hi : 0;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  return {
    mesh, capacity: cap, tier, PRESETS, grid: null, backend: 'webgl2',
    emit, update,
    clear() { for (let i = 0; i < hi; i++) posLife[i * 4 + 3] = 1; hi = 0; head = 0; geo.instanceCount = 0; posAttr.needsUpdate = true; },
    setVisible(v) { mesh.visible = !!v; },
    stats() { return { capacity: cap, used: hi, backend: 'webgl2' }; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
