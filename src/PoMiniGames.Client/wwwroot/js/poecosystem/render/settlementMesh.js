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

  const buildingMeshes = new Map(); // buildingId -> { root, tier }
  const caravanMeshes = new Map();  // caravanKey -> Object3D

  // Shared materials (#12: zero per-building material allocations)
  const woodMat = new MeshLambertNodeMaterial({ color: 0x8c5e3c });
  const darkWoodMat = new MeshLambertNodeMaterial({ color: 0x5d3d26 });
  const thatchMat = new MeshLambertNodeMaterial({ color: 0xd4b26f });
  const stoneMat = new MeshLambertNodeMaterial({ color: 0x7a8288 });
  const slateMat = new MeshLambertNodeMaterial({ color: 0x4f565c });
  const clothMat = new MeshLambertNodeMaterial({ color: 0xe6dec8 });
  const scaffoldMat = new MeshBasicNodeMaterial({ color: 0xb8860b, wireframe: true });

  const BANNER_COLORS = PALETTES[palette] ?? PALETTES.default;
  const bannerMats = new Map();
  const getBannerMat = (tribeId) => {
    const key = tribeId ?? -1;
    let m = bannerMats.get(key);
    if (!m) {
      m = new MeshLambertNodeMaterial({ color: BANNER_COLORS[key] || 0xffffff });
      bannerMats.set(key, m);
    }
    return m;
  };

  // Shared geometries (#12: created once per renderer lifecycle, disposed cleanly)
  const geo = {
    hutBase: new CylinderGeometry(1.6, 1.7, 1.5, 8),
    hutPlinth: new CylinderGeometry(1.85, 1.95, 0.35, 8),
    hutRoof: new ConeGeometry(2.1, 1.2, 8),
    hutRoofWide: new ConeGeometry(2.35, 1.35, 8),
    stilt: new BoxGeometry(0.3, 0.8, 0.3),
    bin: new BoxGeometry(2.0, 1.6, 2.0),
    binTrim: new BoxGeometry(2.2, 0.25, 2.2),
    leg: new CylinderGeometry(0.12, 0.15, 4.2, 4),
    stoneLeg: new BoxGeometry(0.32, 4.2, 0.32),
    platform: new BoxGeometry(1.8, 0.2, 1.8),
    parapet: new BoxGeometry(2.1, 0.45, 2.1),
    banner: new BoxGeometry(0.1, 0.8, 0.6),
    pillar: new BoxGeometry(0.8, 3.5, 0.8),
    crest: new ConeGeometry(0.7, 1.0, 4),
    cartBody: new BoxGeometry(1.4, 0.65, 2.1),
    cartCargo: new BoxGeometry(1.1, 0.55, 1.2),
    cartWheel: new CylinderGeometry(0.36, 0.36, 0.14, 10),
    cartPole: new CylinderGeometry(0.05, 0.05, 1.4, 6),
    cartFlag: new BoxGeometry(0.06, 0.45, 0.55),
  };

  function buildStructureObject(b, tier = 0) {
    const root = new Group();
    root.position.set(b.x, heightAt(b.x, b.z), b.z);
    const bannerMat = getBannerMat(b.tribeId);

    if (b.kind === BUILDING_KIND.HUT) {
      if (tier >= 2) {
        const plinth = new Mesh(geo.hutPlinth, stoneMat);
        plinth.position.y = 0.18;
        root.add(plinth);
      }
      const wallMat = tier >= 3 ? stoneMat : woodMat;
      const baseMesh = new Mesh(geo.hutBase, wallMat);
      baseMesh.position.y = tier >= 2 ? 0.95 : 0.75;
      root.add(baseMesh);

      const roofGeo = tier >= 2 ? geo.hutRoofWide : geo.hutRoof;
      const roofMat = tier >= 3 ? slateMat : thatchMat;
      const roofMesh = new Mesh(roofGeo, roofMat);
      roofMesh.position.y = tier >= 2 ? 2.3 : 2.1;
      root.add(roofMesh);

      if (tier >= 1) {
        const pennant = new Mesh(geo.cartFlag, bannerMat);
        pennant.position.set(0, tier >= 2 ? 3.15 : 2.9, 0);
        root.add(pennant);
      }
    } else if (b.kind === BUILDING_KIND.GRANARY) {
      for (const [sx, sz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
        const stilt = new Mesh(geo.stilt, stoneMat);
        stilt.position.set(sx, 0.4, sz);
        root.add(stilt);
      }
      const binMesh = new Mesh(geo.bin, tier >= 3 ? stoneMat : woodMat);
      binMesh.position.y = 1.6;
      root.add(binMesh);
      if (tier >= 1) {
        const trim = new Mesh(geo.binTrim, tier >= 2 ? thatchMat : darkWoodMat);
        trim.position.y = 2.45;
        root.add(trim);
      }
    } else if (b.kind === BUILDING_KIND.WATCHTOWER) {
      const legGeo = tier >= 3 ? geo.stoneLeg : geo.leg;
      const legMat = tier >= 3 ? stoneMat : woodMat;
      for (const [lx, lz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
        const leg = new Mesh(legGeo, legMat);
        leg.position.set(lx, 2.1, lz);
        root.add(leg);
      }
      const platform = new Mesh(geo.platform, woodMat);
      platform.position.y = 4.2;
      root.add(platform);
      if (tier >= 2) {
        const parapet = new Mesh(geo.parapet, tier >= 3 ? stoneMat : darkWoodMat);
        parapet.position.y = 4.55;
        root.add(parapet);
      }
      const banner = new Mesh(geo.banner, bannerMat);
      banner.position.set(0, 5.1, 0);
      root.add(banner);
    } else if (b.kind === BUILDING_KIND.WAR_TOTEM) {
      const pillar = new Mesh(geo.pillar, tier >= 3 ? stoneMat : darkWoodMat);
      pillar.position.y = 1.75;
      root.add(pillar);
      const crest = new Mesh(geo.crest, bannerMat);
      crest.position.y = 4.0;
      root.add(crest);
    }

    if (!b.isComplete) {
      const scaf = new Mesh(geo.binTrim, scaffoldMat);
      scaf.position.y = 0.8;
      root.add(scaf);
      root.scale.set(0.85, Math.max(0.25, b.progress), 0.85);
    }
    return root;
  }

  function buildCaravanObject(tribeId) {
    const root = new Group();
    const bannerMat = getBannerMat(tribeId);
    const body = new Mesh(geo.cartBody, woodMat);
    body.position.y = 0.55;
    root.add(body);
    const cargo = new Mesh(geo.cartCargo, clothMat);
    cargo.position.set(0, 1.0, -0.15);
    root.add(cargo);
    for (const [wx, wz] of [[-0.78, -0.65], [0.78, -0.65], [-0.78, 0.65], [0.78, 0.65]]) {
      const wheel = new Mesh(geo.cartWheel, darkWoodMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.36, wz);
      root.add(wheel);
    }
    const pole = new Mesh(geo.cartPole, darkWoodMat);
    pole.position.set(0.55, 1.35, 0.8);
    root.add(pole);
    const flag = new Mesh(geo.cartFlag, bannerMat);
    flag.position.set(0.55, 1.85, 0.55);
    root.add(flag);
    return root;
  }

  return {
    group,

    syncBuildings(buildingsList, tribesList = null) {
      if (!buildingsList) return;
      const techByTribe = new Map();
      if (Array.isArray(tribesList)) {
        for (const t of tribesList) techByTribe.set(t.id, t.tech | 0);
      }

      const activeIds = new Set();
      for (const b of buildingsList) {
        activeIds.add(b.id);
        const tier = techByTribe.get(b.tribeId) ?? 0;
        const entry = buildingMeshes.get(b.id);
        if (!entry || entry.tier !== tier || (b.isComplete && entry.incomplete)) {
          if (entry) group.remove(entry.root);
          const root = buildStructureObject(b, tier);
          buildingMeshes.set(b.id, { root, tier, incomplete: !b.isComplete });
          group.add(root);
        } else if (!b.isComplete) {
          entry.root.scale.y = Math.max(0.25, b.progress);
        } else {
          entry.root.scale.set(1, 1, 1);
        }
      }

      for (const [id, entry] of buildingMeshes.entries()) {
        if (!activeIds.has(id)) {
          group.remove(entry.root);
          buildingMeshes.delete(id);
        }
      }
    },

    /** Render animated 3D trade caravans gliding along active tribal trade routes (#6). */
    syncCaravans(caravansList, tribesList) {
      if (!Array.isArray(caravansList) || !Array.isArray(tribesList)) return;
      const tribeById = new Map(tribesList.map(t => [t.id, t]));
      const activeKeys = new Set();
      for (let idx = 0; idx < caravansList.length; idx++) {
        const c = caravansList[idx];
        const a = tribeById.get(c.fromTribeId);
        const b = tribeById.get(c.toTribeId);
        if (!a || !b) continue;
        const key = `${c.fromTribeId}_${c.toTribeId}_${idx}`;
        activeKeys.add(key);
        let obj = caravanMeshes.get(key);
        if (!obj) {
          obj = buildCaravanObject(c.fromTribeId);
          caravanMeshes.set(key, obj);
          group.add(obj);
        }
        const p = Math.max(0, Math.min(1, c.progress ?? 0));
        const x = a.centerX + (b.centerX - a.centerX) * p;
        const z = a.centerZ + (b.centerZ - a.centerZ) * p;
        obj.position.set(x, heightAt(x, z), z);
        obj.rotation.y = Math.atan2(b.centerX - a.centerX, b.centerZ - a.centerZ);
      }
      for (const [k, obj] of caravanMeshes.entries()) {
        if (!activeKeys.has(k)) {
          group.remove(obj);
          caravanMeshes.delete(k);
        }
      }
    },

    dispose() {
      scene.remove(group);
      buildingMeshes.clear();
      caravanMeshes.clear();
      for (const g of Object.values(geo)) g.dispose();
      for (const m of bannerMats.values()) m.dispose();
      bannerMats.clear();
      woodMat.dispose();
      darkWoodMat.dispose();
      thatchMat.dispose();
      stoneMat.dispose();
      slateMat.dispose();
      clothMat.dispose();
      scaffoldMat.dispose();
    },
  };
}
