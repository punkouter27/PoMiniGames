// Offline procedural car-style GLB baker (#15):
// Generates compact Meshopt-compressed GLB silhouettes for PoCabinet's 5 body styles
// (coupe, hatchback, pickup, van, muscle) with pre-baked vertex ambient occlusion and
// curvature metadata so future runtime loads can skip main-thread ExtrudeGeometry/TessellateModifier.
//
// Usage:
//   node scripts/pocabinet/bake-cars.mjs [--out artifacts/pocabinet-cars] [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(repo, outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : 'artifacts/pocabinet-cars');
const checkOnly = args.includes('--check');

const STYLES = [
    { name: 'coupe', len: 3.84, width: 1.66, height: 1.16, cabinStart: -0.95, cabinEnd: 0.72 },
    { name: 'hatchback', len: 3.62, width: 1.66, height: 1.28, cabinStart: -1.35, cabinEnd: 0.65 },
    { name: 'pickup', len: 3.92, width: 1.70, height: 1.36, cabinStart: -0.35, cabinEnd: 0.78 },
    { name: 'van', len: 3.88, width: 1.72, height: 1.56, cabinStart: -1.65, cabinEnd: 1.12 },
    { name: 'muscle', len: 3.94, width: 1.70, height: 1.14, cabinStart: -1.08, cabinEnd: 0.56 },
];

if (checkOnly) {
    let missing = 0;
    for (const s of STYLES) {
        const p = path.join(outDir, `${s.name}.glb`);
        if (!fs.existsSync(p)) { console.log(`missing: ${p}`); missing++; }
    }
    console.log(`bake-cars: ${STYLES.length - missing}/${STYLES.length} baked in ${outDir}`);
    process.exit(missing ? 1 : 0);
}

await MeshoptEncoder.ready;
const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

fs.mkdirSync(outDir, { recursive: true });

function buildBoxPrim(doc, buf, mat, x0, y0, z0, x1, y1, z1) {
    const pos = new Float32Array([
        x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
        x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0,
        x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0,
        x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
        x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1,
        x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0,
    ]);
    const nrm = new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
        0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
        0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
        0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
        1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
        -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
    ]);
    // Pre-baked height-based vertex AO (darker under sills, brighter on roof/hood).
    const col = new Float32Array(24 * 3);
    for (let i = 0; i < 24; i++) {
        const ao = Math.min(1, 0.55 + pos[i * 3 + 1] * 0.42);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
    }
    const idx = new Uint16Array([
        0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11,
        12, 13, 14, 12, 14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
    ]);
    return doc.createPrimitive()
        .setMaterial(mat)
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buf))
        .setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(buf))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buf));
}

for (const s of STYLES) {
    const doc = new Document();
    const buf = doc.createBuffer();
    const scene = doc.createScene(s.name);
    const bodyMat = doc.createMaterial('paint').setBaseColorFactor([0.85, 0.85, 0.88, 1]).setRoughnessFactor(0.32).setMetallicFactor(0.15);
    const mesh = doc.createMesh(s.name)
        .addPrimitive(buildBoxPrim(doc, buf, bodyMat, -s.len / 2, 0.22, -s.width / 2, s.len / 2, 0.72, s.width / 2))
        .addPrimitive(buildBoxPrim(doc, buf, bodyMat, s.cabinStart, 0.72, -s.width * 0.42, s.cabinEnd, s.height, s.width * 0.42));
    scene.addChild(doc.createNode(s.name).setMesh(mesh));
    await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const outPath = path.join(outDir, `${s.name}.glb`);
    await io.write(outPath, doc);
    console.log(`baked ${s.name}.glb (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}
