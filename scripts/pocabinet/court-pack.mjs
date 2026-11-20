// Repack the court scan's mesh for the browser: KTX2 (Basis Universal ETC1S) textures and
// Meshopt geometry instead of JPEG atlases and Draco.
//
//   npm ci --prefix scripts/pocabinet                     (once: the pinned versions in package.json)
//   node scripts/pocabinet/court-pack.mjs <in.glb> [out.glb] [--quality 255] [--effort 5] [--uastc [--rdo 2]] [--report dir]
//
// Run it on the GLB scripts/blender/pocabinet-court.py writes (Draco geometry, three JPEG
// atlases); out defaults to src/PoMiniGames.Client/wwwroot/models/court.glb. It refuses a file
// that is already packed: packing twice loses quality twice.
//
// Why: a JPEG is decoded to RGBA on the GPU (11 MB an atlas with its mips, 33 MB for the court),
// and the court's mesh is what the low tier and the "Lite" setting draw, on the devices with the
// least memory. A KTX2 texture stays compressed on the GPU (ETC1S transcodes to ETC2, BC1 or
// ASTC: about an eighth of the memory). The page transcodes it with wwwroot/lib/basis, built by
// basis-build.sh (three's own copy of the transcoder cannot run under this site's CSP).
//
// ETC1S is the default: the smallest file (2.27 MB, where the JPEG one was 2.51) and half the
// memory of UASTC on a phone. Its price is colour: a 4x4 block of it has one hue, so the scan's
// noise loses saturation, most in the small mips (the court seen from far off is a little
// paler: about 3% less chroma close up, 10 to 20% in the distance; 27 dB PSNR against the JPEG).
// --uastc keeps the colour (37 dB) for three times the download (7 MB, --rdo trims little).
// --report writes each source atlas as PNG and each packed one as .ktx2, to judge the loss.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 1)[0]; };
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const uastc = !!flag('--uastc');
const quality = Number(option('--quality') ?? 255);
const effort = Number(option('--effort') ?? 5);
const rdo = Number(option('--rdo') ?? 0);
const reportDir = option('--report');
const [input, output = path.join(here, '..', '..', 'src', 'PoMiniGames.Client', 'wwwroot', 'models', 'court.glb')] = args;
if (!input) {
    console.error('usage: node court-pack.mjs <in.glb> [out.glb] [--quality 1..255] [--effort 0..6] [--uastc [--rdo n]] [--report dir]');
    process.exit(1);
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'meshopt.encoder': MeshoptEncoder,
        'meshopt.decoder': MeshoptDecoder,
    });

const before = fs.statSync(input).size;
const doc = await io.read(input);
const sources = doc.getRoot().listTextures().map(t => ({ name: t.getName(), mime: t.getMimeType(), image: t.getImage() }));
if (sources.some(s => s.mime === 'image/ktx2')) {
    console.error(`${input} is already packed (KTX2 textures). Run this on the GLB the Blender script writes.`);
    process.exit(1);
}

const imageDecoder = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
};

await doc.transform(
    dedup(),
    prune(),
    // The atlases are colour (sRGB): perceptual error metrics, sRGB in the file's descriptor.
    ktx2({
        isUASTC: uastc, qualityLevel: quality, compressionLevel: effort, generateMipmap: true, enableDebug: false,
        ...(uastc && rdo > 0 ? { enableRDO: true, rdoQualityLevel: rdo } : {}),
        isPerceptual: true, isSetKTX2SRGBTransferFunc: true, needSupercompression: uastc, imageDecoder,
    }),
    // Reorders for the vertex cache, quantizes and packs. 14-bit positions over a 50 m court are
    // 3 mm steps; 12-bit UVs are a quarter of a texel.
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeTexcoord: 12 }),
);
// The source's Draco marker goes: the geometry is Meshopt's now, and the page loads no Draco decoder.
for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
}

const packed = doc.getRoot().listTextures();
if (packed.some(t => t.getMimeType() !== 'image/ktx2')) {
    console.error('A texture was not converted (see the warnings above); nothing was written.');
    process.exit(1);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
await io.write(output, doc);

const after = fs.statSync(output).size;
const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
console.log(`${path.basename(output)}: ${mb(before)} -> ${mb(after)} (${uastc ? 'UASTC' + (rdo > 0 ? ' rdo ' + rdo : '') : 'ETC1S q' + quality + ' effort ' + effort}, meshopt)`);
for (let i = 0; i < packed.length; i++) {
    const size = packed[i].getSize() || [0, 0];
    console.log(`  ${sources[i].name}: ${size[0]}x${size[1]}, ${mb(sources[i].image.byteLength)} ${sources[i].mime} -> ${mb(packed[i].getImage().byteLength)} KTX2`);
}

if (reportDir) {
    fs.mkdirSync(reportDir, { recursive: true });
    for (let i = 0; i < packed.length; i++) {
        await sharp(sources[i].image).png().toFile(path.join(reportDir, `atlas${i}-source.png`));
        fs.writeFileSync(path.join(reportDir, `atlas${i}.ktx2`), packed[i].getImage());
    }
    console.log(`report: ${reportDir}`);
}
