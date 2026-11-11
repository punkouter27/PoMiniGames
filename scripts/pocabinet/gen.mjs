// Regenerates tests/Shared/Fixtures/pocabinet-lap-proofs.txt from the browser physics.
// PoCabinetScoreStorageTests needs capitol messy < clean < wild; the field is chaotic, so the
// wild driver's swerve period and the messy driver's line offset are searched until that holds.
import fs from 'node:fs';
import { race } from './harness.mjs';

const out = process.argv[2];
const line = (name, r) => `${name} ${r.id} ${r.wet ? 1 : 0} ${r.inputs} ${r.playerBest}`;
const clean = race('capitol', 'clean');
let wild = null;
for (const period of [8, 6, 5, 7, 4, 9, 10, 3]) {
    const r = race('capitol', 'wild', false, { wildPeriod: period });
    console.log('wild period', period, r.playerBest);
    if (r.playerBest > clean.playerBest) { wild = r; break; }
}
if (!wild) throw new Error(`no wild swerve period is slower than clean ${clean.playerBest}`);
let messy = null;
for (const off of [0.3, 0.2, 0.4, 0.1, 0.5, 0.6, -0.1, -0.2, 0.7, 0.15, 0.25, 0.35, 0.45, -0.3, 0.05]) {
    const r = race('capitol', 'messy', false, { messyOffset: off });
    console.log('messy offset', off, r.playerBest);
    if (r.playerBest > 0 && r.playerBest < clean.playerBest) { messy = r; break; }
}
if (!messy) throw new Error('no messy offset beats clean');
const maralago = race('maralago', 'clean');
const playground = race('playground', 'clean');
for (const r of [clean, messy, wild, maralago, playground]) if (!(r.playerBest > 0)) throw new Error(`no lap: ${r.id} ${r.driver}`);
const lines = [
    line('capitol-clean', clean),
    line('capitol-messy', messy),
    line('capitol-wild', wild),
    line('maralago-clean', maralago),
    line('playground-run', playground),
];
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log({ clean: clean.playerBest, messy: messy.playerBest, wild: wild.playerBest, maralago: maralago.playerBest, playground: playground.playerBest });
