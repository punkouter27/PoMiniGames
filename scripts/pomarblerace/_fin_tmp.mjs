import { bootRace } from './harness.mjs';
const g = await bootRace(3, 1);
const Ls = g.track._lanes;
for (const li of [8, 9, 10, 11, 12]) { const L = Ls[li], k = (L.n - 1) * 3; console.log(L.name, 'end B', [L.B[k], L.B[k+1], L.B[k+2]].map(Math.round), 'C', [L.C[k], L.C[k+1], L.C[k+2]].map(Math.round), 'T', [L.P[k]-L.P[k-3], L.P[k+1]-L.P[k-2], L.P[k+2]-L.P[k-1]].map((v) => v.toFixed(1))); }
const F = Ls[1];
for (let r = 0; r < 8; r++) { const k = r * 3; console.log('Finish', r, Math.round(F.S[r]), 'B', [F.B[k], F.B[k+1], F.B[k+2]].map(Math.round), 'C', [F.C[k], F.C[k+1], F.C[k+2]].map(Math.round), 'A', [F.A[k], F.A[k+1], F.A[k+2]].map(Math.round), 'D', [F.D[k], F.D[k+1], F.D[k+2]].map(Math.round), 'HLID', F.HLID[r].toFixed(1)); }
process.exit(0);
