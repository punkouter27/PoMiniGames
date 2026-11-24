// Unified automated asset pipeline & F1 bandwidth budget validator for PoCabinet (#14 & #16).
//
// Usage:
//   node scripts/pocabinet/asset-pipeline.mjs --check          validate court GLB/splats, CSP-safe Basis, radio clips & budget
//   node scripts/pocabinet/asset-pipeline.mjs --pack <in.glb>  repack raw Blender court GLB (KTX2 + Meshopt) via court-pack.mjs
//
// Checks:
//   1. wwwroot/models/court.glb exists and is under the F1 mesh budget (<= 3.5 MB)
//   2. wwwroot/models/court-low.ksplat (<= 3.0 MB) and court.ksplat (<= 11.0 MB) exist
//   3. wwwroot/lib/basis/basis_transcoder.{js,wasm} exist (CSP-safe DYNAMIC_EXECUTION=0 build)
//   4. wwwroot/audio/pocabinet/radio.json matches PoCabinetDialogue.cs (via radio-voices.mjs --check)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const www = path.join(repo, 'src', 'PoMiniGames.Client', 'wwwroot');

const args = process.argv.slice(2);
const packIdx = args.indexOf('--pack');

if (packIdx >= 0) {
    const input = args[packIdx + 1];
    if (!input) {
        console.error('usage: node scripts/pocabinet/asset-pipeline.mjs --pack <in.glb>');
        process.exit(1);
    }
    execFileSync(process.execPath, [path.join(here, 'court-pack.mjs'), input], { stdio: 'inherit' });
}

const checks = [
    { rel: 'models/court.glb', maxMB: 3.5, label: 'Court photogrammetry mesh (KTX2 + Meshopt)' },
    { rel: 'models/court-low.ksplat', maxMB: 3.0, label: 'Court progressive low splat (100k)' },
    { rel: 'models/court.ksplat', maxMB: 11.0, label: 'Court full splat (400k)' },
    { rel: 'lib/basis/basis_transcoder.js', maxMB: 0.4, label: 'CSP-safe Basis transcoder JS' },
    { rel: 'lib/basis/basis_transcoder.wasm', maxMB: 0.8, label: 'CSP-safe Basis transcoder WASM' },
    { rel: 'audio/pocabinet/radio.json', maxMB: 0.1, label: 'Offline radio voice manifest' },
];

let problems = 0;
let totalBytes = 0;
for (const c of checks) {
    const full = path.join(www, c.rel);
    if (!fs.existsSync(full)) {
        console.error(`MISSING: ${c.rel} (${c.label})`);
        problems++;
        continue;
    }
    const bytes = fs.statSync(full).size;
    totalBytes += bytes;
    const mb = bytes / (1024 * 1024);
    const ok = mb <= c.maxMB;
    console.log(`${ok ? 'OK  ' : 'OVER'} ${c.rel.padEnd(36)} ${mb.toFixed(2).padStart(6)} MB / ${c.maxMB.toFixed(1)} MB  (${c.label})`);
    if (!ok) problems++;
}

try {
    execFileSync(process.execPath, [path.join(here, 'radio-voices.mjs'), '--check'], { stdio: 'inherit' });
} catch {
    problems++;
}

console.log(`asset-pipeline: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB checked, ${problems} problem(s).`);
process.exit(problems ? 1 : 0);
