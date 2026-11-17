import { bootRace } from './harness.mjs';
const g = await bootRace(Number(process.env.MAP || 3), 1);
let bowl = [];
g.track.group.traverse((o) => { if (o.isMesh && /Bowl/.test(o.name)) { o.updateMatrixWorld(true); const p = o.geometry.attributes.position; const v = new (o.position.constructor)(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); bowl.push([v.x, v.y, v.z]); } } });
const xs = bowl.map((b) => b[0]), ys = bowl.map((b) => b[1]), zs = bowl.map((b) => b[2]);
const mn = (a) => Math.min(...a).toFixed(0), mx = (a) => Math.max(...a).toFixed(0);
const cx = xs.reduce((a, b) => a + b) / xs.length, cz = zs.reduce((a, b) => a + b) / zs.length;
console.log('n', bowl.length, 'x', mn(xs), mx(xs), 'y', mn(ys), mx(ys), 'z', mn(zs), mx(zs), 'centre', cx.toFixed(0), cz.toFixed(0));
const ymax = Math.max(...ys);
for (let y = Math.min(...ys); y <= ymax + 1; y += (ymax - Math.min(...ys)) / 8) { const r = bowl.filter((b) => Math.abs(b[1] - y) < 2).map((b) => Math.hypot(b[0] - cx, b[2] - cz)); if (r.length) console.log('y', y.toFixed(0), 'r', Math.min(...r).toFixed(0), Math.max(...r).toFixed(0)); }
console.log('rim', g.track.rimDebug, g.track.rimSegments);
// rim wall angular coverage: list glass mesh rim wall verts angles
const angs = [];
g.track.group.traverse((o) => { if (o.isMesh && o.name === 'ContainmentGlass') { const p = o.geometry.attributes.position; if (p.count === g.track.rimSegments * 6) { for (let i = 0; i < p.count; i += 3) angs.push(Math.round(Math.atan2(p.getZ(i) - cz, p.getX(i) - cx) * 180 / Math.PI)); } } });
const s = [...new Set(angs)].sort((a, b) => a - b); console.log('rim wall angles', s.join(','));
// TerraceB end relative angle
const L = g.track._lanes[14]; const k = (L.n - 1) * 3;
for (const arr of ['B', 'P', 'C']) { const x = L[arr][k], z = L[arr][k + 2]; console.log('TerraceB end', arr, Math.round(Math.atan2(z - cz, x - cx) * 180 / Math.PI), 'r', Math.hypot(x - cx, z - cz).toFixed(0), 'y', L[arr][k + 1].toFixed(0)); }
process.exit(0);
