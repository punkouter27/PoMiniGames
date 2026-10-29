// floraMeshes.js — trees, stumps, berry bushes, huts and fire/lava markers. All static
// per tile-sync (once a second), so each is one InstancedMesh rebuilt only when the tile
// message says something changed.
import { BoxGeometry, InstancedBufferAttribute, Color, ConeGeometry, CylinderGeometry, DynamicDrawUsage, IcosahedronGeometry, InstancedMesh, Object3D } from 'three-eco/webgpu';
import { TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';
import { TREE_STATE } from '../sim/flora/trees.js';
import { FLORA } from '../sim/core/config.js';
import { ecoLambert } from './materials.js';

// Per-instance colour jitter: a hash of the index picks a point between two tones, so a
// forest is many greens rather than one. Applied through instanceColor when placing.
const jitterColour = (() => {
  const a = new Color(); const b = new Color(); const out = new Color();
  return (k, hexA, hexB) => {
    const h = Math.abs(Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1;
    return out.copy(a.setHex(hexA)).lerp(b.setHex(hexB), h);
  };
})();

function instanced(scene, geo, colour, cap, name, { emissive = 0, enhance = { rim: 0.22, mottle: 0.12, mottleScale: 1.0 } } = {}) {
  const material = ecoLambert({ color: colour, flatShading: true, emissive }, enhance);
  const mesh = new InstancedMesh(geo, material, Math.max(1, cap));
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // White instance colours from the start. A node material is compiled for the mesh as it
  // is on its first draw, and one that only gained instanceColor later (the first
  // setColorAt) would keep drawing the untinted white crown.
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 3).fill(1), 3);
  mesh.castShadow = true; mesh.count = 0; mesh.frustumCulled = false; mesh.name = name;
  scene.add(mesh);
  return { mesh, geo, material };
}

export function createFloraMeshes(scene, terrain, { trees = [], bushes = [] } = {}) {
  const size = terrain.size;
  const treeCap = Math.max(1, trees.length);
  // Farming plants bushes at runtime (behavior/tech.js), so the bush meshes are sized to
  // the sim's cap rather than to the count the island started with.
  let bushList = Array.from(bushes);
  const bushCap = Math.max(1, FLORA.maxBushes);
  // Crowns sway (materials.js), trunks carry bark grain, bushes rustle a little. Crowns
  // and bushes are white so the per-instance tint below is the whole colour.
  const trunk = instanced(scene, new CylinderGeometry(0.18, 0.24, 2.6, 5), 0x6b4423, treeCap, 'tree-trunk', { enhance: { rim: 0.18, mottle: 0.3, mottleScale: 0.45 } });
  const crown = instanced(scene, new ConeGeometry(1.5, 3.2, 6), 0xffffff, treeCap, 'tree-crown', { enhance: { rim: 0.3, mottle: 0.22, mottleScale: 1.3, sway: 0.16, swayHeight: 3.2 } });
  const stump = instanced(scene, new CylinderGeometry(0.26, 0.3, 0.5, 5), 0x4a3520, treeCap, 'tree-stump');
  const bush = instanced(scene, new IcosahedronGeometry(0.55, 0), 0xffffff, bushCap, 'bush', { enhance: { rim: 0.3, mottle: 0.2, mottleScale: 0.7, sway: 0.05, swayHeight: 1.1 } });
  const berry = instanced(scene, new IcosahedronGeometry(0.6, 0), 0x9f1239, bushCap, 'bush-ripe', { enhance: { rim: 0.3, mottle: 0.2, mottleScale: 0.7, sway: 0.05, swayHeight: 1.1 } });
  const hutBase = instanced(scene, new BoxGeometry(2.2, 1.6, 2.2), 0xa8a29e, 32, 'hut');
  const hutRoof = instanced(scene, new ConeGeometry(1.9, 1.4, 4), 0x7c2d12, 32, 'hut-roof');
  const flame = instanced(scene, new ConeGeometry(0.5, 1.4, 5), 0xf97316, 4096, 'fire', { emissive: 0xf97316 });
  const lava = instanced(scene, new BoxGeometry(1, 0.3, 1), 0xef4444, 512, 'lava', { emissive: 0x991b1b });
  const carcass = instanced(scene, new BoxGeometry(0.7, 0.3, 1.0), 0x57534e, 256, 'carcass');
  // The tribe's works (behavior/tech.js): fence posts and rails, the campfire's stone
  // ring (its flame reuses `flame`), tilled field plots, and the watchtower.
  const fencePost = instanced(scene, new BoxGeometry(0.22, 1.5, 0.22), 0x8b5a2b, 320, 'fence-post');
  const fenceRail = instanced(scene, new BoxGeometry(1.0, 0.14, 0.14), 0xa16207, 320, 'fence-rail');
  const hearth = instanced(scene, new CylinderGeometry(0.7, 0.8, 0.25, 8), 0x57534e, 4, 'campfire');
  const field = instanced(scene, new BoxGeometry(0.92, 0.16, 0.92), 0x6b4f2a, 32, 'field');
  const tower = instanced(scene, new BoxGeometry(1.1, 4.2, 1.1), 0x7c5c3a, 4, 'tower');
  const towerTop = instanced(scene, new BoxGeometry(1.9, 0.35, 1.9), 0x5c4326, 4, 'tower-top');
  const all = [trunk, crown, stump, bush, berry, hutBase, hutRoof, flame, lava, carcass, fencePost, fenceRail, hearth, field, tower, towerTop];
  const dummy = new Object3D();

  const place = (entry, i, x, y, z, scale = 1, rotY = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    entry.mesh.setMatrixAt(i, dummy.matrix);
  };
  const centre = (tile) => [tileX(tile, size) + 0.5, tileZ(tile, size) + 0.5];

  return {
    /** msg: the runtime's `tiles` message (tileState, treeState, bushRipe, huts, carcasses). */
    update(msg, time = 0) {
      if (msg.bushes) bushList = Array.from(msg.bushes);
      const bushes = bushList;
      let nTrunk = 0; let nStump = 0;
      for (let k = 0; k < trees.length; k++) {
        const [x, z] = centre(trees[k]);
        const y = terrain.heightAt(x, z);
        if ((msg.treeState?.[k] ?? TREE_STATE.STANDING) === TREE_STATE.STANDING) {
          place(trunk, nTrunk, x, y + 1.3, z, 1, (k % 7) * 0.4);
          place(crown, nTrunk, x, y + 3.4, z, 0.85 + (k % 5) * 0.06, (k % 7) * 0.4);
          crown.mesh.setColorAt(nTrunk, jitterColour(k, 0x1a4f26, 0x4c8a2f));
          nTrunk++;
        } else { place(stump, nStump++, x, y + 0.25, z); }
      }
      trunk.mesh.count = nTrunk; crown.mesh.count = nTrunk; stump.mesh.count = nStump;

      let nBush = 0; let nBerry = 0;
      for (let k = 0; k < bushes.length; k++) {
        const [x, z] = centre(bushes[k]);
        const y = terrain.heightAt(x, z);
        if ((msg.bushRipe?.[k] ?? 0) >= 128) place(berry, nBerry++, x, y + 0.5, z);
        else { bush.mesh.setColorAt(nBush, jitterColour(k + 977, 0x25602c, 0x4f8a3a)); place(bush, nBush++, x, y + 0.45, z); }
      }
      bush.mesh.count = nBush; berry.mesh.count = nBerry;
      if (crown.mesh.instanceColor) crown.mesh.instanceColor.needsUpdate = true;
      if (bush.mesh.instanceColor) bush.mesh.instanceColor.needsUpdate = true;

      const huts = msg.huts ?? [];
      huts.forEach((h, k) => {
        const y = terrain.heightAt(h.x, h.z);
        place(hutBase, k, h.x, y + 0.8, h.z, 1, (k % 4) * 0.3);
        place(hutRoof, k, h.x, y + 2.2, h.z, 1, Math.PI / 4);
      });
      hutBase.mesh.count = huts.length; hutRoof.mesh.count = huts.length;

      let nFlame = 0; let nLava = 0; let nPost = 0; let nHearth = 0; let nField = 0; let nTower = 0;
      const state = msg.tileState;
      if (state) {
        for (let t = 0; t < state.length; t++) {
          const s = state[t];
          if (s === TILE_STATE.NORMAL) continue;
          if (s === TILE_STATE.FIRE && nFlame < 4096) {
            const [x, z] = centre(t);
            place(flame, nFlame++, x, terrain.heightAt(x, z) + 0.7 + Math.sin(time * 6 + t) * 0.15, z, 0.8 + Math.sin(time * 8 + t) * 0.2);
          } else if (s === TILE_STATE.LAVA && nLava < 512) {
            const [x, z] = centre(t);
            place(lava, nLava++, x, terrain.heightAt(x, z) + 0.15, z);
          } else if (s === TILE_STATE.FENCE && nPost < 320) {
            const [x, z] = centre(t);
            const y = terrain.heightAt(x, z);
            // The rail runs toward a fenced neighbour, east–west when there is one, else north–south.
            const ew = state[t + 1] === TILE_STATE.FENCE || state[t - 1] === TILE_STATE.FENCE;
            place(fencePost, nPost, x, y + 0.7, z);
            place(fenceRail, nPost, x, y + 1.05, z, 1, ew ? 0 : Math.PI / 2);
            nPost++;
          } else if (s === TILE_STATE.CAMPFIRE && nHearth < 4) {
            const [x, z] = centre(t);
            const y = terrain.heightAt(x, z);
            place(hearth, nHearth++, x, y + 0.1, z);
            if (nFlame < 4096) place(flame, nFlame++, x, y + 0.55 + Math.sin(time * 7 + t) * 0.08, z, 0.45 + Math.sin(time * 9 + t) * 0.08);
          } else if (s === TILE_STATE.FIELD && nField < 32) {
            const [x, z] = centre(t);
            place(field, nField++, x, terrain.heightAt(x, z) + 0.05, z);
          } else if (s === TILE_STATE.TOWER && nTower < 4) {
            const [x, z] = centre(t);
            const y = terrain.heightAt(x, z);
            place(tower, nTower, x, y + 2.1, z);
            place(towerTop, nTower, x, y + 4.3, z, 1, Math.PI / 4);
            nTower++;
          }
        }
      }
      flame.mesh.count = nFlame; lava.mesh.count = nLava;
      fencePost.mesh.count = nPost; fenceRail.mesh.count = nPost; hearth.mesh.count = nHearth;
      field.mesh.count = nField; tower.mesh.count = nTower; towerTop.mesh.count = nTower;

      const carcasses = msg.carcasses ?? [];
      carcasses.slice(0, 256).forEach((c, k) => place(carcass, k, c.x, terrain.heightAt(c.x, c.z) + 0.15, c.z, 0.6 + c.species * 0.2));
      carcass.mesh.count = Math.min(256, carcasses.length);

      for (const entry of all) entry.mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const entry of all) { scene.remove(entry.mesh); entry.geo.dispose(); entry.mesh.dispose(); entry.material.dispose(); }
    },
  };
}
