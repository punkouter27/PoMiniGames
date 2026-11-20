// sky.js — a sky you can look at, instead of a clear colour.
//
// Until now `scene.background` was a flat colour picked by lighting.js: correct at the
// horizon, wrong everywhere else. Looking up gave the same blue as looking out to sea,
// dusk was an orange wall, and night was a slightly darker wall with no stars in it. On a
// game where the god spends half the time flying, the sky is most of the frame.
//
// Two meshes, both node materials (TSL: one graph for WebGPU and the WebGL2 fallback),
// both centred on the camera position so they never run out:
//
//   DOME   an inverted sphere with a gradient from zenith to horizon, a sun disc with a
//          soft halo along the sun direction, a moon opposite it, and hash-based stars
//          that fade in with the night factor, and a faint bright haze line right on the
//          horizon. Depth-tested off and drawn first, so it is strictly behind everything
//          and costs one full-screen-ish draw.
//   CLOUDS a high plane carrying two octaves of drifting value noise, coverage-thresholded
//          so it reads as separate clouds rather than haze, lit from the sun side and
//          darkened at night. Fades with distance so the plane never shows its edge.
//
// Everything is driven from the same `info` object lighting.update() returns, so the sky,
// the fog, the water and the shafts never disagree about the time of day.
//
// NIGHT SPECTACLE (GFX pass 2, idea 10). Two more terms in the dome, both additive, so a
// mild night stays mild — they bring light, they never take it away:
//
//   AURORA    curtains projected onto three stacked sheets above the island, rippled by
//             drifting noise and streaked with vertical rays; green at the foot, violet at
//             the crown. Its strength is decided by the renderer from the world's seed and
//             the date, so it is the ISLAND's aurora — two people watching the same world
//             on the same night see it together, and nothing the viewer does summons it.
//   METEORS   one potential streak per 2.6 s slot, hashed from the slot; the rate is the
//             renderer's (a shower night is again a property of the world and the date).
//             Each is a short great-circle segment with a fading tail.
//
// A REAL NIGHT (the high and medium tiers):
//
//   STARS     the 1,630 stars of magnitude 5 or brighter from the Yale Bright Star Catalogue
//             (wwwroot/models/poecosystem/stars.bin, packed by scripts/poecosystem/stars.mjs),
//             each where it is and the colour it is, as one instanced sprite. The frame turns
//             with the hour and with the seasons and is tilted to a latitude, so the sky over
//             the island is a sky: Orion is there to find. Until the file has loaded, and on
//             the low tier, the dome's own hash stars are drawn instead.
//   MOON      it waxes and wanes. Its place on the sun's path trails the sun by its phase
//             (new beside the sun, full opposite it) and the lit part of the disc is the part
//             that faces the sun. The renderer says what phase it is: the island's own month,
//             or tonight's real moon when Live Sky is on.
import { AdditiveBlending, BackSide, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, Matrix3, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SphereGeometry, Sprite, SpriteNodeMaterial, Vector3 } from 'three-eco/webgpu';
import {
  Fn, If, abs, acos, cameraPosition, clamp, cross, dot, exp, float, floor, fract, instancedDynamicBufferAttribute, length, max, mix, normalize,
  positionLocal, positionWorld, pow, sin, smoothstep, sqrt, step, uniform, uv, varying, vec2, vec3,
} from 'three-eco/tsl';
import { VIEW_ONLY_LAYER, hash21, vnoise } from './materials.js';

const DOME_RADIUS = 560;
const STAR_RADIUS = 470;         // inside the dome, inside the camera's far plane
const STAR_COUNT = { high: 1630, medium: 900, low: 0 };
const MOON_SIZE = 0.0245;        // the sine of the moon's angular radius as drawn (about 1.4 degrees)
const DEFAULT_LATITUDE = 20;     // degrees north: where the island sits when Live Sky has no city

/** A star's colour from its B-V index (0..1 over -0.4 .. 2.0): blue-white, white, yellow, orange. */
function starColour(k, out) {
  const bv = k * 2.4 - 0.4;
  if (bv < 0.3) { const t = Math.max(0, (bv + 0.4) / 0.7); return out.setRGB(0.68 + 0.32 * t, 0.8 + 0.2 * t, 1); }
  if (bv < 0.9) { const t = (bv - 0.3) / 0.6; return out.setRGB(1, 1 - 0.08 * t, 1 - 0.3 * t); }
  const t = Math.min(1, (bv - 0.9) / 1.1); return out.setRGB(1, 0.92 - 0.24 * t, 0.7 - 0.28 * t);
}

/**
 * The catalogue as one instanced sprite, or null if the file is empty. Each star is a
 * direction (equatorial frame, +Y the north celestial pole); `u.uStarTurn` carries it into
 * the world, and the sprite sits STAR_RADIUS out along it from the camera.
 */
function buildStars(scene, bytes, cap, u) {
  const view = new DataView(bytes);
  const n = Math.min(cap, view.getUint32(0, true), Math.floor((bytes.byteLength - 4) / 8));
  if (!(n > 0)) return null;
  const dir = new Float32Array(n * 3); const look = new Float32Array(n * 4);
  const c = new Color();
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    dir[i * 3] = view.getInt16(o, true) / 32767; dir[i * 3 + 1] = view.getInt16(o + 2, true) / 32767; dir[i * 3 + 2] = view.getInt16(o + 4, true) / 32767;
    starColour(view.getUint8(o + 7) / 255, c);
    look[i * 4] = c.r; look[i * 4 + 1] = c.g; look[i * 4 + 2] = c.b; look[i * 4 + 3] = view.getUint8(o + 6) / 255;
  }
  const dirAttr = new InstancedBufferAttribute(dir, 3); const lookAttr = new InstancedBufferAttribute(look, 4);
  for (const a of [dirAttr, lookAttr]) a.setUsage(DynamicDrawUsage);
  const aDir = instancedDynamicBufferAttribute(dirAttr, 'vec3');
  const aLook = instancedDynamicBufferAttribute(lookAttr, 'vec4');
  const world = normalize(u.uStarTurn.mul(aDir));
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, fog: false, blending: AdditiveBlending });
  material.positionNode = cameraPosition.add(world.mul(STAR_RADIUS));
  // Brightness is size first and light second, as it is to the eye: Sirius is a small disc,
  // a fifth-magnitude star a point.
  const size = aLook.w.pow(1.3).mul(3.1).add(0.95);
  material.scaleNode = vec2(size, size);
  const d = uv().sub(0.5);
  const round = float(1).sub(smoothstep(0.1, 1, dot(d, d).mul(4)));
  // A slow twinkle, each star on its own beat, stronger low in the sky where the air is thick.
  const beat = sin(u.uTime.mul(aLook.w.mul(2.3).add(1.4)).add(aDir.x.mul(91)).add(aDir.z.mul(57)));
  const twinkle = beat.mul(mix(0.3, 0.08, smoothstep(0.05, 0.6, world.y))).add(0.9);
  const seen = smoothstep(0.0, 0.1, world.y).mul(smoothstep(0.3, 0.85, u.uNight)).mul(float(1).sub(u.uOvercast));
  material.colorNode = varying(aLook.rgb.mul(aLook.w.mul(0.75).add(0.5)).mul(1.5), 'vStarColour');
  material.opacityNode = varying(seen.mul(twinkle), 'vStarSeen').mul(round);
  material.alphaTest = 0.002;
  const sprite = new Sprite(material);
  sprite.count = n;
  sprite.frustumCulled = false;
  sprite.name = 'stars';
  sprite.renderOrder = -9;          // over the dome, under the clouds
  sprite.layers.set(VIEW_ONLY_LAYER);
  scene.add(sprite);
  return { sprite, material, count: n };
}
const CLOUD_Y = 96;
const CLOUD_SPAN = 1400;

/** Curtains on three stacked sheets: green at the foot, violet at the crown. */
const aurora = (d, t) => {
  let acc = vec3(0);
  for (let i = 0; i < 3; i++) {
    const q = d.xz.div(d.y.add(0.12)).mul((1 + i * 0.35) * 0.55);
    // The curtain line itself: a slow sinuous band across the sky.
    const wave = q.x.mul(1.3).add(vnoise(q.mul(0.9).add(vec2(t.mul(0.02), i * 3.1))).mul(2.6)).add(sin(q.y.mul(0.8).add(t.mul(0.05))).mul(0.8));
    const s = sin(wave).mul(2.2);
    const band = exp(s.mul(s).negate());
    // Vertical rays: noise stretched along the curtain, flickering slowly.
    const rays = vnoise(vec2(wave.mul(9), t.mul(0.35).add(i * 5))).mul(0.55).add(0.45);
    const tint = [vec3(0.12, 1.0, 0.45), vec3(0.37, 0.62, 0.72), vec3(0.62, 0.25, 1.0)][i];
    acc = acc.add(tint.mul(band).mul(rays).mul(0.55 - i * 0.12));
  }
  const lift = smoothstep(0.03, 0.25, d.y).mul(float(1).sub(smoothstep(0.75, 1, d.y)));
  return acc.mul(lift).mul(step(0.03, d.y));
};

/** One potential streak per 2.6 s slot, hashed from the slot; `rate` is the chance it fires. */
const meteor = (d, t, rate) => {
  const slot = floor(t.div(2.6));
  const fires = step(hash21(vec2(slot, 17)), rate);
  const p = fract(t.div(2.6)).div(0.32);              // lives for the first third of its slot
  const alive = step(p, 1);
  const az = hash21(vec2(slot, 3)).mul(6.2831);
  const el = hash21(vec2(slot, 5)).mul(0.4).add(0.35);
  const a = normalize(vec3(az.cos().mul(el.cos()), el.sin(), az.sin().mul(el.cos())));
  const b = normalize(a.add(vec3(az.sin().negate(), -0.55, az.cos()).mul(0.35)));
  const head = normalize(mix(a, b, p.min(1)));
  const tail = normalize(mix(a, b, max(p.sub(0.35), 0)));
  const seg = head.sub(tail);
  const k = clamp(dot(d.sub(tail), seg).div(max(dot(seg, seg), 1e-6)), 0, 1);
  const dist = length(d.sub(tail.add(seg.mul(k))));
  const line = exp(dist.mul(dist).mul(-2.2e5)).mul(k).mul(k);
  return vec3(0.85, 0.92, 1.0).mul(line).mul(float(1).sub(p.mul(0.6))).mul(2.4).mul(fires).mul(alive);
};

function domeMaterial(u) {
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false, fog: false });
  material.colorNode = Fn(() => {
    // The dome rides the camera, so its own vertex direction is the view ray.
    const d = normalize(positionLocal);
    const up = clamp(d.y, -1, 1);
    // Gradient: the horizon band is wider at dusk, when the warm light sits low.
    const h = pow(float(1).sub(clamp(up, 0, 1)), mix(2.6, 1.6, u.uDusk));
    const col = mix(u.uZenith, u.uHorizon, h).toVar();
    // A brighter haze line right on the horizon, the way thick air glows edge-on.
    col.addAssign(u.uHorizon.mul(exp(abs(up).mul(-18))).mul(0.12).mul(float(1).sub(u.uNight.mul(0.7))));
    // Below the horizon there is only sea; keep the horizon colour so the dome never shows
    // a seam where the water plane ends.
    col.assign(mix(col, u.uHorizon.mul(0.92), smoothstep(0, -0.08, up)));

    // Sun: a hard disc, a tight halo, and a wide warm glow that carries the dusk.
    const cosSun = dot(d, normalize(u.uSunDir));
    const disc = smoothstep(0.9993, 0.9997, cosSun);
    const halo = pow(max(cosSun, 0), 220).mul(0.9);
    const glow = pow(max(cosSun, 0), 6).mul(u.uDusk.mul(0.5).add(0.22));
    // Gone by full night: the light that is left then is the moon's, and `uSunDir` (which
    // lighting.js keeps above the horizon so the island is never unlit) is no longer where a sun is.
    col.addAssign(u.uSunColor.mul(disc.mul(3).add(halo).add(glow)).mul(float(1).sub(u.uNight.mul(0.85))).mul(float(1).sub(smoothstep(0.55, 0.85, u.uNight))));

    // Moon: small, cool, and lit on the side that faces the sun. `uMoonCos` is the cosine of
    // how far round from the sun it is: 1 new, -1 full. Across the disc, the edge of the
    // light is the ellipse x = cos * sqrt(1 - y^2), x measured toward the sun.
    const m = normalize(u.uMoonDir);
    const cosMoon = dot(d, m);
    const moonDisc = smoothstep(0.99955, 0.9998, cosMoon);
    const toSun = normalize(u.uTrueSun.sub(m.mul(dot(u.uTrueSun, m))).add(vec3(1e-5, 0, 0)));
    const px = dot(d, toSun).div(MOON_SIZE);
    const py = dot(d, cross(m, toSun)).div(MOON_SIZE);
    const edge = u.uMoonCos.mul(sqrt(max(float(1).sub(py.mul(py)), 0)));
    // The dark part is not black: earthshine, faint.
    const lit = smoothstep(edge.sub(0.07), edge.add(0.07), px).mul(0.94).add(0.06);
    const full = float(1).sub(u.uMoonCos).mul(0.5);
    const moon = moonDisc.mul(lit).add(pow(max(cosMoon, 0), 400).mul(0.35).mul(full));
    col.addAssign(vec3(0.86, 0.9, 1.0).mul(moon).mul(u.uNight).mul(1.4).mul(smoothstep(-0.04, 0.03, m.y)));

    // Stars: a hash on a quantised direction, thresholded so only a few cells light, with
    // a slow twinkle, above the horizon and only once the sky is dark enough. These are the
    // stand-ins: once the catalogue is up (uCatalog), the real stars are drawn instead.
    const cell = floor(d.xz.div(max(abs(d.y), 0.05)).mul(90));
    const s = hash21(cell);
    const star = step(0.986, s).mul(sin(u.uTime.mul(s.mul(3).add(1.5)).add(s.mul(40))).mul(0.4).add(0.6));
    col.addAssign(vec3(0.9, 0.95, 1.0).mul(star).mul(smoothstep(0.02, 0.2, up)).mul(smoothstep(0.35, 0.9, u.uNight)).mul(0.9).mul(float(1).sub(u.uCatalog)));

    // Rainbow: the primary bow, 42 degrees out from the antisolar point, red outside. Only
    // above the horizon, so a high sun (bow centre far below it) shows none.
    If(u.uRainbow.greaterThan(0.01).and(up.greaterThan(0)), () => {
      const ang = acos(clamp(dot(d, normalize(u.uSunDir).negate()), -1, 1));
      const x = ang.sub(0.733).div(0.03);
      const band = exp(x.mul(x).mul(-0.45));
      const hue = clamp(float(0.5).sub(x.mul(0.27)), 0, 1).mul(0.76);
      const spectrum = clamp(abs(hue.mul(6).add(vec3(0, 4, 2)).mod(6).sub(3)).sub(1), 0, 1);
      col.addAssign(spectrum.mul(band).mul(u.uRainbow).mul(0.3).mul(smoothstep(0, 0.14, up))
        .mul(float(1).sub(smoothstep(0.45, 0.72, u.uNight))));
    });

    const dark = smoothstep(0.3, 0.85, u.uNight);
    if (u.spectacle) {
      If(u.uAurora.greaterThan(0.01).and(dark.greaterThan(0)), () => { col.addAssign(aurora(d, u.uTime).mul(u.uAurora).mul(dark).mul(0.9)); });
      If(u.uMeteors.greaterThan(0.001).and(dark.greaterThan(0)), () => { col.addAssign(meteor(d, u.uTime, u.uMeteors).mul(dark)); });
    }
    return col;
  })();
  return material;
}

function cloudMaterial(c) {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: false, alphaTest: 0.003 });
  const P = positionWorld;
  const p = P.xz.mul(0.006).add(vec2(c.uTime.mul(0.0045), c.uTime.mul(0.0018)));
  const n = vnoise(p).mul(0.55).add(vnoise(p.mul(2.3).add(7.1)).mul(0.3)).add(vnoise(p.mul(5.1).sub(3.3)).mul(0.15));
  const edge = mix(0.72, 0.42, c.uCover);
  const body = smoothstep(edge, edge.add(0.22), n);
  // The sun side of a cloud is where the noise slopes toward the sun: a gradient of the
  // same noise is a cheap normal, and enough to give the tops a lit rim.
  const e = 0.02;
  const g = vec2(vnoise(p.add(vec2(e, 0))).sub(vnoise(p.sub(vec2(e, 0)))), vnoise(p.add(vec2(0, e))).sub(vnoise(p.sub(vec2(0, e)))));
  const lit = clamp(dot(normalize(g.add(1e-5)), normalize(c.uSunDir.xz.add(1e-5))).mul(0.6).add(0.5), 0, 1);
  material.colorNode = mix(c.uShade, c.uLit, lit).mul(float(1).sub(c.uNight.mul(0.75)));
  const far = float(1).sub(smoothstep(380, 640, length(cameraPosition.xz.sub(P.xz))));
  material.opacityNode = body.mul(0.86).mul(far);
  return material;
}

export function createSky(scene, { tier = 'high' } = {}) {
  const u = {
    uZenith: uniform(new Color(0x3b7dd8)),
    uHorizon: uniform(new Color(0x8ec5ff)),
    uSunColor: uniform(new Color(0xfff2df)),
    uSunDir: uniform(new Vector3(0, 1, 0)),
    uNight: uniform(0),
    uDusk: uniform(0),
    uTime: uniform(0),
    uAurora: uniform(0),
    uMeteors: uniform(0),
    uRainbow: uniform(0),
    uMoonDir: uniform(new Vector3(0, 0.6, -0.8)),
    uMoonCos: uniform(-1),
    uTrueSun: uniform(new Vector3(0, -1, 0)),     // where the sun really is, below the horizon at night
    uCatalog: uniform(0),
    uStarTurn: uniform(new Matrix3()),
    uOvercast: uniform(0),
    // The low tier keeps the gradient, sun, moon, stars and bow but builds the dome without
    // the aurora and meteor terms: the most expensive pixels in the sky, on the cheapest GPUs.
    spectacle: tier !== 'low',
  };
  const domeMat = domeMaterial(u);
  const dome = new Mesh(new SphereGeometry(DOME_RADIUS, 32, 18), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.name = 'sky';
  dome.layers.set(VIEW_ONLY_LAYER);
  scene.add(dome);

  let clouds = null;
  if (tier !== 'low') {
    const c = {
      uLit: uniform(new Color(0xffffff)),
      uShade: uniform(new Color(0x9fb3c8)),
      uSunDir: uniform(new Vector3(0, 1, 0)),
      uTime: uniform(0),
      uCover: uniform(0.45),
      uNight: uniform(0),
    };
    const mat = cloudMaterial(c);
    const geo = new PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const plane = new Mesh(geo, mat);
    plane.position.y = CLOUD_Y;
    plane.renderOrder = -5;
    plane.frustumCulled = false;
    plane.name = 'clouds';
    plane.layers.set(VIEW_ONLY_LAYER);
    scene.add(plane);
    clouds = { plane, mat, u: c };
  }

  // The catalogue, fetched in the background; the dome's hash stars stand in until it is up.
  let stars = null; let disposed = false;
  let latitude = DEFAULT_LATITUDE;
  const starCap = STAR_COUNT[tier] ?? 0;
  if (starCap > 0 && typeof fetch === 'function') {
    fetch(new URL('../../../models/poecosystem/stars.bin', import.meta.url).href)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((bytes) => {
        if (!bytes || disposed) return;
        stars = buildStars(scene, bytes, starCap, u);
        if (stars) u.uCatalog.value = 1;
      })
      .catch(() => { /* the hash stars stay */ });
  }
  const moon = { dir: new Vector3(0, 0.6, -0.8), cos: -1 };

  const zenith = new Color();
  const WHITE = new Color(0xffffff);
  const SLATE = new Color(0x6b7a8c);
  const STORM = new Color(0x4a5360);
  // Weather: 0 = the usual scattered clouds, 1 = a closed storm deck. Eased per frame so
  // a spell rolls in rather than switching the sky.
  let overcast = 0;
  let overcastTarget = 0;
  const spectacle = { aurora: 0, meteors: 0 };
  let yearTurn = 0;
  let rainbow = 0;
  const DAY_ZENITH = new Color(0x2f6fd0);
  const NIGHT_ZENITH = new Color(0x0b1326);
  const DUSK_ZENITH = new Color(0x4a3a7a);

  return {
    dome,
    get clouds() { return clouds?.plane ?? null; },
    /** 0..1 cloud deck from the weather (renderer.js). */
    setOvercast(v) { overcastTarget = Math.max(0, Math.min(1, v)); },
    /** Tonight's spectacle (renderer.js decides it from the world): 0..1 each. Eased. */
    setSpectacle(auroraLevel, meteorRate) {
      spectacle.aurora = Math.max(0, Math.min(1, auroraLevel));
      spectacle.meteors = Math.max(0, Math.min(1, meteorRate));
    },
    get overcast() { return overcast; },
    /** Cloud coverage as the cloud shader has it (the cloud shadows sample the same field). */
    get cover() { return 0.45 + overcast * 0.45; },
    /** 0..1 rainbow strength (renderer.js: rain easing off over wet ground, in daylight). */
    setRainbow(v) { rainbow = Math.max(0, Math.min(1, v)); },
    get rainbow() { return u.uRainbow.value; },
    /** How many catalogue stars are drawn (0 until the file is up, and on the low tier). */
    get starCount() { return stars?.count ?? 0; },
    /** Degrees north the sky is tilted to (Live Sky passes its city's; null puts it back). */
    setLatitude(deg) { latitude = Number.isFinite(deg) ? Math.max(-80, Math.min(80, deg)) : DEFAULT_LATITUDE; },
    /**
     * The moon tonight: `phase` 0..1 round the month (0 new, 0.5 full) and `dayFraction` the
     * hour. Returns `{ dir, lit, up }`: where it is, how much of its face is lit (0..1), and
     * how far above the horizon it stands (0..1), which is what the night's light follows.
     */
    setMoon(phase, dayFraction) {
      const turn = phase * Math.PI * 2;
      // The sun's own path (lighting.js), trailed by the phase.
      const a = (dayFraction - 0.25) * Math.PI * 2 - turn;
      moon.dir.set(Math.cos(a) * 180, Math.sin(a) * 180, 60).normalize();
      moon.cos = Math.cos(turn);
      u.uMoonDir.value.copy(moon.dir);
      const s = (dayFraction - 0.25) * Math.PI * 2;
      u.uTrueSun.value.set(Math.cos(s) * 180, Math.sin(s) * 180, 60).normalize();
      u.uMoonCos.value = moon.cos;
      // The stars turn once a day and once more a year, about the pole the latitude sets.
      const lat = (latitude * Math.PI) / 180;
      const tilt = -(Math.PI / 2 - lat);
      const spin = -(dayFraction * Math.PI * 2 + yearTurn);
      const cs = Math.cos(spin); const sn = Math.sin(spin); const ct = Math.cos(tilt); const st = Math.sin(tilt);
      // Rx(tilt) * Ry(spin), row-major into Matrix3.set.
      u.uStarTurn.value.set(
        cs, 0, sn,
        st * sn, ct, -st * cs,
        -ct * sn, st, ct * cs,
      );
      return { dir: moon.dir, lit: (1 - moon.cos) / 2, up: Math.max(0, Math.min(1, moon.dir.y * 3)) };
    },
    /** How far round the year it is, 0..1: the night sky of spring is not autumn's. */
    setYear(fraction) { yearTurn = (fraction % 1) * Math.PI * 2; },
    /**
     * @param {{ sky: Color, sunColour: Color, sunDir: Vector3, night: number, day: number, dusk: number }} sky
     *   the object lighting.update() returns; this adds `zenith` to it, which the water
     *   reflects along steep rays
     * @param {{x:number, y:number, z:number}} player the camera's position: the dome is
     *   centred on it, so its own vertex direction is the view ray
     * @param {number} time seconds
     */
    update(sky, player, time) {
      overcast += (overcastTarget - overcast) * 0.02;
      zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, sky.day).lerp(DUSK_ZENITH, sky.dusk * 0.6).lerp(STORM, overcast * 0.6);
      sky.zenith = zenith;
      dome.position.set(player.x, player.y, player.z);
      u.uZenith.value.copy(zenith);
      u.uHorizon.value.copy(sky.sky);
      u.uSunColor.value.copy(sky.sunColour);
      u.uSunDir.value.copy(sky.sunDir);
      u.uNight.value = sky.night;
      u.uDusk.value = sky.dusk;
      u.uTime.value = time;
      // A closed cloud deck hides both; the aurora also fades in over a minute or so rather
      // than switching on at dusk.
      const clear = 1 - overcast;
      u.uAurora.value += (spectacle.aurora * clear - u.uAurora.value) * 0.004;
      u.uMeteors.value = spectacle.meteors * clear;
      u.uRainbow.value += (rainbow - u.uRainbow.value) * 0.02;
      u.uOvercast.value = Math.min(1, overcast * 1.15);
      if (clouds) {
        const c = clouds.u;
        c.uSunDir.value.copy(sky.sunDir);
        c.uTime.value = time;
        c.uNight.value = sky.night;
        // The lit side takes the sun's colour, so dusk clouds go pink without a special case.
        c.uLit.value.copy(sky.sunColour).lerp(WHITE, 0.35).lerp(SLATE, overcast * 0.55);
        c.uShade.value.copy(sky.sky).lerp(SLATE, 0.45).lerp(STORM, overcast * 0.6);
        c.uCover.value = 0.45 + overcast * 0.45;
        clouds.plane.position.set(player.x, CLOUD_Y, player.z);
      }
    },
    dispose() {
      disposed = true;
      if (stars) { scene.remove(stars.sprite); stars.material.dispose(); stars = null; }
      scene.remove(dome); dome.geometry.dispose(); domeMat.dispose();
      if (clouds) { scene.remove(clouds.plane); clouds.plane.geometry.dispose(); clouds.mat.dispose(); }
    },
  };
}
