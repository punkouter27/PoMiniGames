import { race } from './harness.mjs';
const log = new Map();
const r = await race(Number(process.env.MAP || 3), 1, (g) => {
  const f = g._frame.bind(g); let n = 0;
  g._frame = (dt) => { f(dt); if (++n % 30) return; for (const m of g.marbleSet.marbles) { if (m.finished || m.eliminated) continue; const t = log.get(m.index) || []; const p = m.body.position, v = m.body.velocity; t.push([+g.raceClock.toFixed(1), Math.round(m.s), m.proj?.lane, m.proj?.ring, +(m.proj?.lateral ?? 0).toFixed(1), +(m.proj?.height ?? 0).toFixed(1), Math.round(Math.hypot(v.x, v.y, v.z)), m.nudges || 0, +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)]); if (t.length > 300) t.shift(); log.set(m.index, t); } };
});
console.log(JSON.stringify(r));
for (const [i, t] of log) if (t[t.length - 1][0] > 175) { console.log('#' + i); for (const e of t) console.log(' ', e.join(' ')); }
process.exit(0);
