import { bootRace } from './harness.mjs';
const g = await bootRace(3, 1);
for (const [i, L] of g.track._lanes.entries()) { const st = g.track.containment.find((c) => c.index === i); console.log(i, L.name, Math.round(L.s0), Math.round(L.s1), 'n', L.n, 'HW0', L.HW[0].toFixed(0), 'HWn', L.HW[L.n-1].toFixed(0), 'open', L.open, 'fedAir', st.fedFromAir, 'lidded', st.lidded, 'P0', [...L.P.slice(0,3)].map(Math.round), 'Pn', [...L.P.slice(L.n*3-3)].map(Math.round)); }
console.log('finish', g.track.finishS);
process.exit(0);
