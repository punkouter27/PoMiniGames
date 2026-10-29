// propMeshes.js — physics props (ragdoll parts, logs, rocks, volcanic projectiles) as one
// InstancedMesh per PROP_SIZES entry. The frame carries a full quaternion per prop, so
// these are drawn exactly where cannon-es put them.
import { BoxGeometry, DynamicDrawUsage, IcosahedronGeometry, InstancedMesh, Object3D } from 'three-eco/webgpu';
import { PROP_KIND, PROP_SIZES } from '../sim/core/config.js';
import { FRAME } from '../sim/frame.js';
import { ecoLambert } from './materials.js';

const KIND_COLOUR = {
  [PROP_KIND.ragdollPart]: 0x8a6f5a,
  [PROP_KIND.log]: 0x6b4423,
  [PROP_KIND.rock]: 0x78716c,
  [PROP_KIND.projectile]: 0xb45309,
};

export function createPropMeshes(scene, propCap) {
  const buckets = [];
  const dummy = new Object3D();
  for (const kind of Object.values(PROP_KIND)) {
    const material = ecoLambert({ color: KIND_COLOUR[kind] ?? 0x888888, flatShading: true }, { rim: 0.3, mottle: 0.26, mottleScale: 0.5 });
    const perSize = PROP_SIZES.map((size, sizeIndex) => {
      const geo = kind === PROP_KIND.rock || kind === PROP_KIND.projectile
        ? new IcosahedronGeometry(size[0] * 0.6, 0)
        : new BoxGeometry(size[0], size[1], size[2]);
      const mesh = new InstancedMesh(geo, material, propCap);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true; mesh.count = 0; mesh.frustumCulled = false;
      mesh.name = `prop-${kind}-${sizeIndex}`;
      scene.add(mesh);
      return { mesh, geo };
    });
    buckets[kind] = { material, perSize };
  }

  return {
    draw(view, count) {
      const used = new Map();
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.PROP_STRIDE;
        const packed = view[o + 7] | 0;
        const kind = Math.floor(packed / 8); const sizeIndex = packed % 8;
        const bucket = buckets[kind]?.perSize[sizeIndex];
        if (!bucket) continue;
        const key = kind * 8 + sizeIndex;
        const i = used.get(key) ?? 0;
        used.set(key, i + 1);
        dummy.position.set(view[o], view[o + 1], view[o + 2]);
        dummy.quaternion.set(view[o + 3], view[o + 4], view[o + 5], view[o + 6]);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bucket.mesh.setMatrixAt(i, dummy.matrix);
      }
      for (const kind of Object.values(PROP_KIND)) {
        buckets[kind].perSize.forEach((entry, sizeIndex) => {
          entry.mesh.count = used.get(kind * 8 + sizeIndex) ?? 0;
          entry.mesh.instanceMatrix.needsUpdate = true;
        });
      }
    },
    dispose() {
      for (const kind of Object.values(PROP_KIND)) {
        for (const entry of buckets[kind].perSize) { scene.remove(entry.mesh); entry.geo.dispose(); entry.mesh.dispose(); }
        buckets[kind].material.dispose();
      }
    },
  };
}
