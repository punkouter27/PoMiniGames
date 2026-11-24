// backdrop.js — the far scenery as Gaussian splats (#19), grown from the course itself.
//
// The race used to sit in a flat fog colour. Now each dealt course gets a backdrop: canyon walls,
// glacier peaks, mesas, jungle canopy, basalt columns or a neon skyline (the theme's `splat.kind`,
// composer.js), standing a couple of hundred units off both sides of the road and following it
// all the way down. It is made of gaussians rather than meshes because that is what reads as
// distant, soft, photographic scenery — and the platform already draws splats on both GPU
// backends (platform/3d/splats.js: covariance projection, depth sorting in a worker).
//
// No scan is downloaded: the splats are generated here from the course centerline, the theme and
// the seed (so a seed always grows the same scenery). Every splat is kept clear of the road, the
// tier sets the budget, and colours are pre-blended toward the sky a little with distance, since
// the splat material is drawn without scene fog.
import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { packSplats, createSplatCloud } from '../platform/3d/splats.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D value noise in 0..1 over a seeded lattice; two octaves. */
function noise1(rnd) {
  const lat = Float32Array.from({ length: 1024 }, () => rnd());
  const at = (i) => lat[((i % 1024) + 1024) % 1024];
  const one = (x) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return at(i) + (at(i + 1) - at(i)) * u;
  };
  return (x) => one(x) * 0.7 + one(x * 2.7 + 91) * 0.3;
}

const CLEAR = 95;          // units kept free of scenery either side of the road's edge
const LAYERS = 3;          // depth layers per wall
const CLOUDS = 700;

/**
 * @param spec { pts: [{x,y,z,rx,rz,hw}] every `step` units, theme, seed }
 * @param budget splats to spend
 * @returns {{ object: THREE.Mesh, dispose() }}
 */
export function buildBackdrop(spec, budget) {
  const { pts, theme, seed } = spec;
  const S = theme.splat;
  const rnd = mulberry32((seed ^ 0xbacd0f) >>> 0);
  const nD = noise1(rnd), nH = noise1(rnd), nC = noise1(rnd);
  const bg = new THREE.Color(theme.bg);
  const rock0 = new THREE.Color(S.rock[0]), rock1 = new THREE.Color(S.rock[1]), top = new THREE.Color(S.top);
  const accents = S.accent.map((h) => new THREE.Color(h));

  // Extend the centerline past both ends along its heading, so the walls run on beyond the
  // start gate and the finish tray instead of stopping square.
  const ext = [];
  const head = (a, b) => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  const step = pts.length > 1 ? Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) : 20;
  const [h0x, h0z] = head(pts[1], pts[0]);
  for (let k = 14; k >= 1; k--) ext.push({ ...pts[0], x: pts[0].x + h0x * step * k, z: pts[0].z + h0z * step * k, y: pts[0].y + 6 * k });
  ext.push(...pts);
  const n = pts.length - 1;
  const [h1x, h1z] = head(pts[n - 1], pts[n]);
  for (let k = 1; k <= 14; k++) ext.push({ ...pts[n], x: pts[n].x + h1x * step * k, z: pts[n].z + h1z * step * k, y: pts[n].y - 6 * k });

  // Is (x, y, z) too close to the road? The road is a function of z here (the procedural course
  // runs strictly down +Z), so look at the samples around that z.
  const z0 = pts[0].z, dz = (pts[n].z - z0) / n;
  const nearRoad = (x, y, z) => {
    const i = Math.round((z - z0) / dz);
    for (let k = i - 4; k <= i + 4; k++) {
      const p = pts[Math.max(0, Math.min(n, k))];
      if (Math.abs(x - p.x) < p.hw + CLEAR && y > p.y - 80 && Math.abs(z - p.z) < 120) return true;
    }
    return false;
  };

  // Pass 1: the wall columns (where, how tall), so the budget can be spread over their height.
  const kind = S.kind;
  const cols = [];
  let tall = 0;
  for (let i = 0; i < ext.length; i++) {
    const p = ext[i];
    for (const side of [-1, 1]) {
      const t = i * 0.035 + (side > 0 ? 0 : 50);
      let D = p.hw + 170 + 150 * nD(t);
      let H;
      if (kind === 'peaks') H = 120 + 300 * Math.pow(nH(t * 1.3), 1.6);
      else if (kind === 'mesa') H = 90 + 150 * (nH(t * 0.6) > 0.45 ? 1 : 0.35) + 20 * nH(t * 4);
      else if (kind === 'canopy') { H = 50 + 90 * nH(t * 1.5); D -= 40; }
      else if (kind === 'city') H = 60 + 260 * Math.pow(nH(Math.floor(i / 3) * 0.37 + side * 11), 2);
      else H = 80 + 200 * Math.pow(nH(t * 2.2), 1.3);                          // basalt
      const base = p.y - 150;
      cols.push({ p, side, D, H, base });
      tall += (H + 150) * LAYERS;
    }
  }
  const main = Math.max(1000, budget - CLOUDS);
  const vstep = Math.max(3.5, tall / main);
  const sigma = Math.max(vstep * 0.8, 4);

  const pos = [], scale = [], quat = [], rgba = [];
  const col = new THREE.Color();
  const push = (x, y, z, sx, sy, sz, qy, qw, c, a) => {
    pos.push(x, y, z); scale.push(sx, sy, sz); quat.push(0, qy, 0, qw);
    // getHex() is sRGB (THREE.Color holds linear values); the splat format stores sRGB bytes.
    const hx = c.getHex();
    rgba.push((hx >> 16) & 255, (hx >> 8) & 255, hx & 255, Math.round(a * 255));
  };

  for (const c of cols) {
    const { p, side, D, H, base } = c;
    // Face the road: local z along the inward normal (a yaw about +Y).
    const nx = -side * p.rx, nz = -side * p.rz;
    const yaw = Math.atan2(nx, nz);
    const qy = Math.sin(yaw / 2), qw = Math.cos(yaw / 2);
    const tx = -p.rz, tz = p.rx;   // along the course, horizontally
    for (let L = 0; L < LAYERS; L++) {
      const depth = D + L * 38;
      const fog = 0.22 + 0.4 * Math.min(1, (depth - 170) / 320) + L * 0.06;
      for (let h = 0; h < H + 150; h += vstep) {
        const f = h / (H + 150);
        // Walls lean back as they rise (a canyon, not a fence); peaks lean more.
        const lean = (kind === 'peaks' ? 0.55 : kind === 'city' ? 0.02 : 0.22) * h;
        const along = (rnd() - 0.5) * step * 1.1;
        const off = depth + lean + (rnd() - 0.5) * 10;
        const x = p.x + side * p.rx * off + tx * along;
        const z = p.z + side * p.rz * off + tz * along;
        const y = base + h + (rnd() - 0.5) * vstep;
        if (nearRoad(x, y, z)) continue;
        // Colour: rock banded by noise and height, the theme's top colour on the upper part.
        col.copy(rock0).lerp(rock1, 0.5 * nC(y * 0.02 + side * 7) + 0.5 * rnd() * 0.5);
        const topAt = kind === 'peaks' ? 0.62 : kind === 'canopy' ? 0.45 : kind === 'mesa' ? 0.9 : 0.8;
        if (f > topAt) col.lerp(top, Math.min(1, (f - topAt) / 0.08));
        if (kind === 'mesa') col.multiplyScalar(0.85 + 0.3 * Math.sin(y * 0.18 + nC(y * 0.01) * 3) * 0.5);
        let a = 0.9, sx = sigma * 1.25, sy = sigma, sz = 2.5;
        if (kind === 'canopy' && f > 0.35) { sx *= 1.6; sy *= 1.5; }
        if (rnd() < S.accentShare && (kind !== 'basalt' || f < 0.4)) {
          // A light: neon window, ember, sunlit crystal, flower. Small, bright, not fogged much.
          col.copy(accents[Math.floor(rnd() * accents.length)]);
          sx = sy = 1.6 + rnd() * 1.6; a = 1;
          col.lerp(bg, fog * 0.35);
        } else {
          col.lerp(bg, fog);
        }
        push(x, y, z, sx, sy, sz, qy, qw, col, a);
      }
    }
  }

  // Clouds: big, flat, faint, high over the whole course.
  const cloud = new THREE.Color(theme.bg).lerp(new THREE.Color(0xffffff), 0.28);
  for (let k = 0; k < CLOUDS; k++) {
    const p = ext[Math.floor(rnd() * ext.length)];
    const x = p.x + (rnd() - 0.5) * 1400, z = p.z + (rnd() - 0.5) * 300, y = p.y + 230 + rnd() * 160;
    if (nearRoad(x, y, z)) continue;
    push(x, y, z, 40 + rnd() * 60, 9 + rnd() * 8, 40 + rnd() * 60, 0, 1, cloud, 0.2);
  }

  const count = pos.length / 3;
  const data = {
    count,
    pos: Float32Array.from(pos), scale: Float32Array.from(scale),
    quat: Float32Array.from(quat), rgba: Uint8Array.from(rgba),
  };
  const cloudObj = createSplatCloud(THREE, TSL, packSplats(data), { name: 'mr-backdrop', renderOrder: -1 });
  cloudObj.object.material.fog = false;
  return { object: cloudObj.object, count, dispose: () => cloudObj.dispose() };
}
