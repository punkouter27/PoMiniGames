// Packs the naked-eye stars for PoEcosystem's night sky:
//
//   node scripts/poecosystem/stars.mjs                  write wwwroot/models/poecosystem/stars.bin
//   node scripts/poecosystem/stars.mjs --check          rebuild in memory, exit 1 if the file differs
//   node scripts/poecosystem/stars.mjs --from bsc5.dat  rebuild data/bright-stars.tsv from the catalogue first
//
// The island's stars were a hash: dots where a random number came up high. These are the
// real ones, the 1,630 stars of magnitude 5 or brighter, each where it is in the sky and the
// colour it is, so Orion and the Plough are there to find.
//
// SOURCE: the Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren, 1991),
// which is in the public domain. `data/bright-stars.tsv` is the part of it this needs (HR
// number, right ascension in hours and declination in degrees at J2000, visual magnitude,
// B-V colour index, name), kept in the repository so this script needs no network. To
// rebuild it, download http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz, unpack it and pass
// the file with --from.
//
// WHAT COMES OUT (little-endian): a uint32 count, then eight bytes a star:
//   int16 x, y, z   the star's direction, times 32767, in the equatorial frame with +Y at the
//                   north celestial pole: (cos dec cos ra, sin dec, cos dec sin ra)
//   uint8 bright    0..255: 255 is Sirius, 0 is magnitude 5.2 (linear in magnitude)
//   uint8 colour    0..255 over B-V -0.4 .. 2.0 (blue-white to orange-red)
// Brightest first, so a tier that draws fewer simply stops early.
// The game (render/sky.js) turns the frame with the hour and tilts it to a latitude.
//
// No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TSV = path.join(here, 'data', 'bright-stars.tsv');
const OUT = path.resolve(here, '../../src/PoMiniGames.Client/wwwroot/models/poecosystem/stars.bin');
const FAINTEST = 5.0;          // visual magnitude kept
const BRIGHT_ZERO = 5.2;       // magnitude that packs to 0
const SIRIUS = -1.46;

const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

/** The catalogue's fixed columns (1-based, from its ReadMe): 76-83 RA, 84-90 Dec, 103-107 V, 110-114 B-V. */
function fromCatalogue(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    const hr = parseInt(line.slice(0, 4), 10);
    const rah = parseInt(line.slice(75, 77), 10); const ram = parseInt(line.slice(77, 79), 10); const ras = parseFloat(line.slice(79, 83));
    const ded = parseInt(line.slice(84, 86), 10); const dem = parseInt(line.slice(86, 88), 10); const des = parseInt(line.slice(88, 90), 10);
    const v = parseFloat(line.slice(102, 107));
    if (![hr, rah, ram, ras, ded, dem, des, v].every(Number.isFinite) || v > FAINTEST) continue;   // 14 entries are novae and clusters with no place
    const bv = parseFloat(line.slice(109, 114));
    const ra = rah + ram / 60 + ras / 3600;
    const dec = (line[83] === '-' ? -1 : 1) * (ded + dem / 60 + des / 3600);
    rows.push([hr, ra.toFixed(5), dec.toFixed(4), v.toFixed(2), (Number.isFinite(bv) ? bv : 0.6).toFixed(2), line.slice(4, 14).trim().replace(/\s+/g, ' ')]);
  }
  rows.sort((a, b) => a[3] - b[3] || a[0] - b[0]);
  const text = '# The Yale Bright Star Catalogue, 5th rev. ed. (public domain), stars of visual magnitude 5.0 or brighter.\n'
    + '# hr\tra_hours\tdec_degrees\tvmag\tb_v\tname\n' + rows.map(r => r.join('\t')).join('\n') + '\n';
  fs.mkdirSync(path.dirname(TSV), { recursive: true });
  fs.writeFileSync(TSV, text);
  console.log(`wrote data/bright-stars.tsv  ${rows.length} stars`);
}
if (from) fromCatalogue(from);

const stars = fs.readFileSync(TSV, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map((l) => {
  const [hr, ra, dec, v, bv, name] = l.split('\t');
  return { hr: +hr, ra: +ra, dec: +dec, v: +v, bv: +bv, name };
});
stars.sort((a, b) => a.v - b.v || a.hr - b.hr);

const bin = Buffer.alloc(4 + stars.length * 8);
bin.writeUInt32LE(stars.length, 0);
stars.forEach((s, i) => {
  const a = (s.ra / 24) * Math.PI * 2; const d = (s.dec / 180) * Math.PI;
  const o = 4 + i * 8;
  bin.writeInt16LE(Math.round(Math.cos(d) * Math.cos(a) * 32767), o);
  bin.writeInt16LE(Math.round(Math.sin(d) * 32767), o + 2);
  bin.writeInt16LE(Math.round(Math.cos(d) * Math.sin(a) * 32767), o + 4);
  bin.writeUInt8(Math.max(0, Math.min(255, Math.round(((BRIGHT_ZERO - s.v) / (BRIGHT_ZERO - SIRIUS)) * 255))), o + 6);
  bin.writeUInt8(Math.max(0, Math.min(255, Math.round(((s.bv + 0.4) / 2.4) * 255))), o + 7);
});

// The catalogue is only worth shipping if it is the sky: check three stars anyone can find.
const find = (hr) => stars.find(s => s.hr === hr);
const known = [[2491, 'Sirius', 6.7525, -16.716, -1.46], [424, 'Polaris', 2.5302, 89.264, 2.02], [7001, 'Vega', 18.6156, 38.784, 0.03]];
for (const [hr, name, ra, dec, v] of known) {
  const s = find(hr);
  if (!s || Math.abs(s.ra - ra) > 0.001 || Math.abs(s.dec - dec) > 0.005 || Math.abs(s.v - v) > 0.011) throw new Error(`${name} (HR ${hr}) is not where it should be: ${JSON.stringify(s)}`);
}

const summary = `stars.bin  ${stars.length} stars to magnitude ${FAINTEST}, brightest ${stars[0].name} (${stars[0].v})  ${(bin.length / 1024).toFixed(1)} KB`;
if (args.includes('--check')) {
  const same = fs.existsSync(OUT) && Buffer.compare(fs.readFileSync(OUT), bin) === 0;
  console.log(`${same ? 'ok   ' : 'STALE'} ${summary}`);
  if (!same) { console.error('stars.bin differs from this script: run it without --check'); process.exit(1); }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bin);
  console.log(`wrote ${summary}`);
}
