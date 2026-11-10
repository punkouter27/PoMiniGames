// Writes PoCapitol's rigged figure to wwwroot/models/pocapitol/figure.glb.
// Run after changing js/pocapitol/rig.js:  node scripts/pocapitol-figure.mjs
// tests/pocapitol-figure.test.mjs fails if the committed file and rig.js drift apart.
import { mkdirSync, writeFileSync } from 'node:fs';

const wwwroot = new URL('../src/PoMiniGames.Client/wwwroot/', import.meta.url);
const { buildFigure, toGlb } = await import(new URL('js/pocapitol/rig.js', wwwroot));
const out = new URL('models/pocapitol/figure.glb', wwwroot);
mkdirSync(new URL('.', out), { recursive: true });
const glb = toGlb(buildFigure());
writeFileSync(out, glb);
console.log(`figure.glb: ${glb.length} bytes`);
