// OpenStreetMap & GIS-derived 3D Surrounding Grounds for PoCapitol.
// Procedurally reconstructs authentic Capitol Hill campus surroundings:
// Library of Congress, Supreme Court, Capitol Reflecting Pool & Grant Memorial,
// surrounding avenues (Constitution, Independence, First St), and perimeter balustrades.

import * as THREE from 'three';

export function createCampus() {
    const group = new THREE.Group();
    group.name = 'capitol-campus-gis';

    // Shared materials
    const graniteMat = new THREE.MeshStandardMaterial({
        color: 0x9e9b94,
        roughness: 0.85,
        metalness: 0.1,
    });

    const marbleMat = new THREE.MeshStandardMaterial({
        color: 0xd8d4cc,
        roughness: 0.6,
        metalness: 0.05,
    });

    const copperDomeMat = new THREE.MeshStandardMaterial({
        color: 0x5a7865,
        roughness: 0.5,
        metalness: 0.3,
    });

    const asphaltMat = new THREE.MeshStandardMaterial({
        color: 0x36383b,
        roughness: 0.95,
        metalness: 0.05,
    });

    const waterMat = new THREE.MeshStandardMaterial({
        color: 0x223344,
        roughness: 0.15,
        metalness: 0.85,
    });

    const bronzeMat = new THREE.MeshStandardMaterial({
        color: 0x4a4338,
        roughness: 0.45,
        metalness: 0.7,
    });

    // 1. Capitol Reflecting Pool & Ulysses S. Grant Memorial (West Front Vista)
    // Located at the foot of Capitol Hill (z ~ 125m, x: 0)
    const poolGroup = new THREE.Group();
    // Basin water surface
    const poolGeo = new THREE.PlaneGeometry(28, 54);
    const poolMesh = new THREE.Mesh(poolGeo, waterMat);
    poolMesh.rotation.x = -Math.PI / 2;
    poolMesh.position.set(0, -0.15, 128);
    poolGroup.add(poolMesh);

    // Granite coping edge around reflecting pool
    const rimGeo = new THREE.BoxGeometry(30, 0.4, 56);
    const rimMesh = new THREE.Mesh(rimGeo, graniteMat);
    rimMesh.position.set(0, -0.25, 128);
    rimMesh.castShadow = true;
    rimMesh.receiveShadow = true;
    poolGroup.add(rimMesh);

    // Grant Memorial central bronze plinth & pedestal
    const pedestalGeo = new THREE.BoxGeometry(6, 4.5, 9);
    const pedestal = new THREE.Mesh(pedestalGeo, graniteMat);
    pedestal.position.set(0, 2.0, 100);
    pedestal.castShadow = true;
    poolGroup.add(pedestal);

    // Bronze equestrian silhouette representation
    const statueGeo = new THREE.BoxGeometry(2.2, 3.2, 4.2);
    const statue = new THREE.Mesh(statueGeo, bronzeMat);
    statue.position.set(0, 5.8, 100);
    statue.castShadow = true;
    poolGroup.add(statue);

    group.add(poolGroup);

    // 2. Library of Congress (Thomas Jefferson Building) - East / South-East
    // Authentic footprint: Beaux-Arts granite block with circular reading room dome
    const locGroup = new THREE.Group();
    locGroup.position.set(130, 0, -22);

    // Main rectangular block
    const locMainGeo = new THREE.BoxGeometry(48, 22, 42);
    const locMain = new THREE.Mesh(locMainGeo, graniteMat);
    locMain.position.y = 11;
    locMain.castShadow = true;
    locMain.receiveShadow = true;
    locGroup.add(locMain);

    // Corner projecting pavilions
    for (const sx of [-22, 22]) {
        for (const sz of [-19, 19]) {
            const pavGeo = new THREE.BoxGeometry(10, 24, 10);
            const pav = new THREE.Mesh(pavGeo, graniteMat);
            pav.position.set(sx, 12, sz);
            pav.castShadow = true;
            locGroup.add(pav);
        }
    }

    // Octagonal / circular copper reading room dome
    const domeBaseGeo = new THREE.CylinderGeometry(11, 12, 6, 16);
    const domeBase = new THREE.Mesh(domeBaseGeo, graniteMat);
    domeBase.position.y = 25;
    locGroup.add(domeBase);

    const domeGeo = new THREE.SphereGeometry(9.5, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const dome = new THREE.Mesh(domeGeo, copperDomeMat);
    dome.position.y = 28;
    locGroup.add(dome);

    group.add(locGroup);

    // 3. Supreme Court of the United States - East / North-East
    // Neoclassical temple facade with hexastyle Corinthian portico
    const scotusGroup = new THREE.Group();
    scotusGroup.position.set(125, 0, -82);

    // Main marble structure
    const scotusMainGeo = new THREE.BoxGeometry(42, 20, 34);
    const scotusMain = new THREE.Mesh(scotusMainGeo, marbleMat);
    scotusMain.position.y = 10;
    scotusMain.castShadow = true;
    scotusMain.receiveShadow = true;
    scotusGroup.add(scotusMain);

    // Front classical pediment and portico
    const porticoGeo = new THREE.BoxGeometry(24, 18, 8);
    const portico = new THREE.Mesh(porticoGeo, marbleMat);
    portico.position.set(-18, 9, 0);
    portico.castShadow = true;
    scotusGroup.add(portico);

    // Triangular pediment roof
    const pedimentGeo = new THREE.ConeGeometry(14, 5, 4);
    const pediment = new THREE.Mesh(pedimentGeo, marbleMat);
    pediment.rotation.y = Math.PI / 4;
    pediment.position.set(-18, 20.5, 0);
    scotusGroup.add(pediment);

    // Marble steps approach
    const stepsGeo = new THREE.BoxGeometry(12, 2.5, 26);
    const steps = new THREE.Mesh(stepsGeo, marbleMat);
    steps.position.set(-26, 1.25, 0);
    scotusGroup.add(steps);

    group.add(scotusGroup);

    // 4. Surrounding Avenues (Constitution Ave North, Independence Ave South)
    // Constitution Ave NW (North perimeter road)
    const constAveGeo = new THREE.BoxGeometry(16, 0.1, 230);
    const constAve = new THREE.Mesh(constAveGeo, asphaltMat);
    constAve.position.set(-68, -0.05, 30);
    constAve.receiveShadow = true;
    group.add(constAve);

    // Independence Ave SW (South perimeter road)
    const indepAveGeo = new THREE.BoxGeometry(16, 0.1, 230);
    const indepAve = new THREE.Mesh(indepAveGeo, asphaltMat);
    indepAve.position.set(68, -0.05, 30);
    indepAve.receiveShadow = true;
    group.add(indepAve);

    // First Street East linking Independence & Constitution behind East Plaza
    const firstStGeo = new THREE.BoxGeometry(150, 0.1, 16);
    const firstSt = new THREE.Mesh(firstStGeo, asphaltMat);
    firstSt.position.set(70, -0.05, -50);
    firstSt.receiveShadow = true;
    group.add(firstSt);

    // 5. Perimeter Sidewalks & Low Stone Retaining Wall
    for (const side of [-56, 56]) {
        const wallGeo = new THREE.BoxGeometry(1.2, 1.1, 140);
        const wall = new THREE.Mesh(wallGeo, graniteMat);
        wall.position.set(side, 0.5, 55);
        wall.castShadow = true;
        group.add(wall);
    }

    return group;
}
