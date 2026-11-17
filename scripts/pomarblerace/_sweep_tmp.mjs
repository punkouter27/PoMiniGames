// TEMP: jittered-frame race (deleted before finishing)
import { bootRace } from './harness.mjs';
const tuning = await import('../../src/PoMiniGames.Client/wwwroot/js/pomarblerace/tuning.js');
const [mapId = '2', seed = '1', mode = 'jit'] = process.argv.slice(2);
let x = Number(seed) * 2654435761 >>> 0;
const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
const g = await bootRace(Number(mapId), Number(seed));
const ms = g.marbleSet.marbles;
const falls = [];
const elim = g.marbleSet.eliminate;
g.marbleSet.eliminate = (m) => {
  if (!m.eliminated && m.proj) { const p = m.body.position, v = m.body.velocity;
    falls.push({ i: m.index, s: Math.round(m.s), lane: m.proj.lane, ring: m.proj.ring, lat: +m.proj.lateral.toFixed(1), h: +m.proj.height.toFixed(1), clock: +g.raceClock.toFixed(2), pos: [p.x, p.y, p.z].map((a) => +a.toFixed(1)), vel: [v.x, v.y, v.z].map((a) => +a.toFixed(1)), trail: m._trail?.slice() }); }
  elim(m);
};
const gc = g._guardContainment.bind(g); g._guardContainment = () => { const pre = ms.map((m) => [m.body.position.x, m.body.position.y, m.body.position.z]); gc(); ms.forEach((m, i) => { m._g = m.body.position.x !== pre[i][0] || m.body.position.y !== pre[i][1] || m.body.position.z !== pre[i][2]; }); };
if (mode !== 'plain') for (const m of ms) { m.body.position.x += (rnd() - 0.5) * 0.4; m.body.position.z += (rnd() - 0.5) * 0.4; }
let frames = 0;
while (g.phase === 'racing' && frames < 60 * 260) {
  let dt = 1 / 60;
  if (mode !== 'plain') { const r = rnd(); dt = r < 0.7 ? 1 / 60 : r < 0.85 ? 1 / 30 : r < 0.95 ? 1 / 45 : 1 / 20; }
  g._frame(dt); frames++;
  if (process.env.TRAIL) for (const m of ms) { if (m.eliminated || m.finished) continue; const t = (m._trail ||= []); const p = m.body.position, v = m.body.velocity;
    t.push([+g.raceClock.toFixed(2), Math.round(m.s), m.proj?.lane, m.proj?.ring, +(m.proj?.height ?? 0).toFixed(1), +(m.proj?.lateral ?? 0).toFixed(1), +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), m._g ? 'G' : '', Math.round(Math.hypot(v.x, v.y, v.z))]); if (t.length > 120) t.shift(); }
  if (frames % 600 === 0 && process.env.EARLY && ms.filter((m) => !m.finished && !m.eliminated).every((m) => m.s > Number(process.env.EARLY))) break;
}
const lim = tuning.RACE_TIMEOUT - 1;
console.log(JSON.stringify({ map: Number(mapId), seed: Number(seed), clock: +g.raceClock.toFixed(1), finished: ms.filter((m) => m.finished && !m.eliminated && m.finishTime < lim).length, lost: ms.filter((m) => m.eliminated).length, stalled: ms.filter((m) => m.finished && !m.eliminated && m.finishTime >= lim).length, falls }));
process.exit(0);
