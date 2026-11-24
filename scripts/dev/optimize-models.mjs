#!/usr/bin/env node
// Offline CC0 3D asset optimizer for Kenney / Quaternius GLB packs.
// Usage: node scripts/dev/optimize-models.mjs <input-dir> <output-dir>
// Requires `@gltf-transform/cli` (npx @gltf-transform/cli) to apply meshopt + KTX2 compression
// so every hero prop stays under 80-150 KB before upload to Blob Storage (ModelsBaseUrl).
import { readdirSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error('Usage: node scripts/dev/optimize-models.mjs <input-dir> <output-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(inDir)) {
  if (!['.glb', '.gltf'].includes(extname(file).toLowerCase())) continue;
  const src = join(inDir, file);
  const dst = join(outDir, basename(file, extname(file)) + '.glb');
  console.log(`Optimizing ${file} -> ${dst}`);
  execFileSync('npx', [
    '--yes', '@gltf-transform/cli', 'optimize', src, dst,
    '--compress', 'meshopt',
    '--texture-compress', 'ktx2',
    '--simplify', 'false',
  ], { stdio: 'inherit' });
}
