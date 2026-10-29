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
import { BackSide, Color, DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SphereGeometry, Vector3 } from 'three-eco/webgpu';
import {
  Fn, If, abs, acos, cameraPosition, clamp, dot, exp, float, floor, fract, length, max, mix, normalize,
  positionLocal, positionWorld, pow, sin, smoothstep, step, uniform, vec2, vec3,
} from 'three-eco/tsl';
import { hash21, vnoise } from './materials.js';

const DOME_RADIUS = 560;
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
    col.addAssign(u.uSunColor.mul(disc.mul(3).add(halo).add(glow)).mul(float(1).sub(u.uNight.mul(0.85))));

    // Moon: opposite the sun, small, cool, only at night.
    const cosMoon = dot(d, normalize(u.uSunDir.negate().add(vec3(0, 0.35, 0))));
    const moon = smoothstep(0.99955, 0.9998, cosMoon).add(pow(max(cosMoon, 0), 400).mul(0.35));
    col.addAssign(vec3(0.86, 0.9, 1.0).mul(moon).mul(u.uNight).mul(1.4));

    // Stars: a hash on a quantised direction, thresholded so only a few cells light, with
    // a slow twinkle, above the horizon and only once the sky is dark enough.
    const cell = floor(d.xz.div(max(abs(d.y), 0.05)).mul(90));
    const s = hash21(cell);
    const star = step(0.986, s).mul(sin(u.uTime.mul(s.mul(3).add(1.5)).add(s.mul(40))).mul(0.4).add(0.6));
    col.addAssign(vec3(0.9, 0.95, 1.0).mul(star).mul(smoothstep(0.02, 0.2, up)).mul(smoothstep(0.35, 0.9, u.uNight)).mul(0.9));

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
    // The low tier keeps the gradient, sun, moon, stars and bow but builds the dome without
    // the aurora and meteor terms: the most expensive pixels in the sky, on the cheapest GPUs.
    spectacle: tier !== 'low',
  };
  const domeMat = domeMaterial(u);
  const dome = new Mesh(new SphereGeometry(DOME_RADIUS, 32, 18), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.name = 'sky';
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
    scene.add(plane);
    clouds = { plane, mat, u: c };
  }

  const zenith = new Color();
  const WHITE = new Color(0xffffff);
  const SLATE = new Color(0x6b7a8c);
  const STORM = new Color(0x4a5360);
  // Weather: 0 = the usual scattered clouds, 1 = a closed storm deck. Eased per frame so
  // a spell rolls in rather than switching the sky.
  let overcast = 0;
  let overcastTarget = 0;
  const spectacle = { aurora: 0, meteors: 0 };
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
      scene.remove(dome); dome.geometry.dispose(); domeMat.dispose();
      if (clouds) { scene.remove(clouds.plane); clouds.plane.geometry.dispose(); clouds.mat.dispose(); }
    },
  };
}
