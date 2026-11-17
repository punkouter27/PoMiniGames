import { bootRace } from './harness.mjs';
const g = await bootRace(3, 1);
for (const li of [14, 0, 5]) { const L = g.track._lanes[li]; for (const r of li === 14 ? [L.n - 3, L.n - 2, L.n - 1] : [0, 1, 2, 4, 8]) { if (r >= L.n) continue; const k = r * 3; const U = [L.U[k], L.U[k+1], L.U[k+2]]; const hA = (L.A[k]-L.B[k])*U[0]+(L.A[k+1]-L.B[k+1])*U[1]+(L.A[k+2]-L.B[k+2])*U[2]; console.log(L.name, r, Math.round(L.S[r]), 'P', [L.P[k], L.P[k+1], L.P[k+2]].map(Math.round), 'R', [L.R[k], L.R[k+1], L.R[k+2]].map((v) => v.toFixed(2)), 'HW', L.HW[r].toFixed(0), 'REACH', L.REACH[r].toFixed(0), 'hA', hA.toFixed(1), 'HLID', L.HLID[r].toFixed(1)); } }
console.log(JSON.stringify(g.track.containment.filter((c) => [0, 5, 14].includes(c.index))));
process.exit(0);
