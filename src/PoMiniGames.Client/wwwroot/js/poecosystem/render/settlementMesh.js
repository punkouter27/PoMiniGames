// settlementMesh.js — 3D procedural structures for tribal settlements.
'use strict';

import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicNodeMaterial, MeshLambertNodeMaterial, Object3D } from 'three-eco/webgpu';
import { BUILDING_KIND } from '../sim/tribe/contracts.js';

// Okabe–Ito picks for the colour-blind palette (Settings): orange / blue / bluish green stay
// apart under all three common dichromacies, where amber and verdant green did not.
const PALETTES = Object.freeze({
  default: Object.freeze({ 0: 0xd48806, 1: 0x096dd9, 2: 0x389e0d }),
  cb: Object.freeze({ 0: 0xe69f00, 1: 0x0072b2, 2: 0x009e73 }),
});

/** A tribe's banner colour (hex) in the chosen palette — the territory borders use it too. */
export const bannerColour = (palette, tribeId) => (PALETTES[palette] ?? PALETTES.default)[tribeId] ?? 0xffffff;

export function createSettlementMeshes(scene, heightAt = () => 0, palette = 'default') {
  const group = new Group();
  group.name = 'settlement_structures';
  scene.add(group);

  const buildingMeshes = new Map(); // buildingId -> Object3D

  // Materials
  const woodMat = new MeshLambertNodeMaterial({ color: 0x8c5e3c });
  const thatchMat = new MeshLambertNodeMaterial({ color: 0xd4b26f });
  const stoneMat = new MeshLambertNodeMaterial({ color: 0x7a8288 });
  const scaffoldMat = new MeshBasicNodeMaterial({ color: 0xb8860b, wireframe: true });

  const BANNER_COLORS = PALETTES[palette] ?? PALETTES.default;   // Amber, Cobalt, Verdant

  function buildStructureObject(b) {
    const root = new Group();
    root.position.set(b.x, heightAt(b.x, b.z), b.z);

    const bannerColor = BANNER_COLORS[b.tribeId] || 0xffffff;
    const bannerMat = new MeshLambertNodeMaterial({ color: bannerColor });

    if (b.kind === BUILDING_KIND.HUT) {
      // Cylindrical hut base with conical thatch roof
      const baseGeo = new CylinderGeometry(1.6, 1.7, 1.5, 8);
      const baseMesh = new Mesh(baseGeo, woodMat);
      baseMesh.position.y = 0.75;
      root.add(baseMesh);

      const roofGeo = new ConeGeometry(2.1, 1.2, 8);
      const roofMesh = new Mesh(roofGeo, thatchMat);
      roofMesh.position.y = 2.1;
      root.add(roofMesh);
    } else if (b.kind === BUILDING_KIND.GRANARY) {
      // Raised box on stone stilts
      const stiltGeo = new BoxGeometry(0.3, 0.8, 0.3);
      for (const [sx, sz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
        const stilt = new Mesh(stiltGeo, stoneMat);
        stilt.position.set(sx, 0.4, sz);
        root.add(stilt);
      }
      const binGeo = new BoxGeometry(2.0, 1.6, 2.0);
      const binMesh = new Mesh(binGeo, woodMat);
      binMesh.position.y = 1.6;
      root.add(binMesh);
    } else if (b.kind === BUILDING_KIND.WATCHTOWER) {
      // Tall tower with top lookout
      const legGeo = new CylinderGeometry(0.12, 0.15, 4.2, 4);
      for (const [lx, lz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
        const leg = new Mesh(legGeo, woodMat);
        leg.position.set(lx, 2.1, lz);
        root.add(leg);
      }
      const platformGeo = new BoxGeometry(1.8, 0.2, 1.8);
      const platform = new Mesh(platformGeo, woodMat);
      platform.position.y = 4.2;
      root.add(platform);

      // Banner on top of watchtower
      const bannerGeo = new BoxGeometry(0.1, 0.8, 0.6);
      const banner = new Mesh(bannerGeo, bannerMat);
      banner.position.set(0, 5.0, 0);
      root.add(banner);
    } else if (b.kind === BUILDING_KIND.WAR_TOTEM) {
      // Carved wooden obelisk with tribal banner
      const pillarGeo = new BoxGeometry(0.8, 3.5, 0.8);
      const pillar = new Mesh(pillarGeo, woodMat);
      pillar.position.y = 1.75;
      root.add(pillar);

      const crestGeo = new ConeGeometry(0.7, 1.0, 4);
      const crest = new Mesh(crestGeo, bannerMat);
      crest.position.y = 4.0;
      root.add(crest);
    }

    // If still under construction, apply scaling/scaffolding indicator
    if (!b.isComplete) {
      root.scale.set(0.8, Math.max(0.2, b.progress), 0.8);
    }

    return root;
  }

  return {
    group,

    syncBuildings(buildingsList) {
      if (!buildingsList) return;

      const activeIds = new Set();

      for (const b of buildingsList) {
        activeIds.add(b.id);
        let obj = buildingMeshes.get(b.id);

        if (!obj) {
          obj = buildStructureObject(b);
          buildingMeshes.set(b.id, obj);
          group.add(obj);
        } else {
          // Update height or completion scale
          if (!b.isComplete) {
            obj.scale.y = Math.max(0.2, b.progress);
          } else {
            obj.scale.set(1, 1, 1);
          }
        }
      }

      // Remove destroyed or decayed structures
      for (const [id, obj] of buildingMeshes.entries()) {
        if (!activeIds.has(id)) {
          group.remove(obj);
          buildingMeshes.delete(id);
        }
      }
    },

    dispose() {
      scene.remove(group);
      woodMat.dispose();
      thatchMat.dispose();
      stoneMat.dispose();
      scaffoldMat.dispose();
    },
  };
}
