// Pack a 3DGS PLY into the .ksplat the PoCabinet scene streams (@mkkellogg/gaussian-splats-3d).
//
//   npm ci --prefix scripts/pocabinet                     (once: the pinned versions in package.json)
//   node scripts/pocabinet/ksplat.mjs <in.ply> <out.ksplat> [compressionLevel=1]
//
// Its node_modules stay in scripts/pocabinet/ (git-ignored); nothing here is part of the app
// build. Compression level 1 is 16-bit centres/scales/rotations and 8-bit
// colour; base colour only (degree 0), which is all the bedroom capture has.
import fs from 'node:fs';
import * as GS from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

const [input, output, level = '1'] = process.argv.slice(2);
if (!input || !output) {
    console.error('usage: node ksplat.mjs <in.ply> <out.ksplat> [compressionLevel]');
    process.exit(1);
}
const bytes = fs.readFileSync(input);
const array = GS.PlyParser.parseToUncompressedSplatArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 0);
const generator = GS.SplatBufferGenerator.getStandardGenerator(1, Number(level), 0, new THREE.Vector3(), 5.0, 256);
const buffer = generator.generateFromUncompressedSplatArray(array);
fs.writeFileSync(output, Buffer.from(buffer.bufferData));
console.log(`${output}: ${buffer.getSplatCount()} splats, ${(fs.statSync(output).size / 1e6).toFixed(2)} MB`);
