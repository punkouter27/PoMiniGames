// water.js — the ocean and lakes as a real surface (GFX option 5).
//
// What was here before: one `PlaneGeometry` with a `MeshLambertMaterial` at opacity 0.75.
// Flat, uniformly cyan, no horizon, and the shoreline was a hard line where the terrain
// mesh stopped. It read as coloured paper, which is a shame on an island game where water
// is a third of every frame.
//
// THE LAKES MIRROR THE ISLAND (high tier on WebGPU). The reflection below is the sky's two
// colours along the mirrored ray, so a mountain never appeared in the lake at its foot. With
// a mirror attached (setMirror), a second camera, flipped about the water level, draws the
// scene at half resolution into a texture (three's reflector node) and a LAKE shows that
// instead: the treeline upside down, the deer drinking, bent by the same wave and ring
// normals that bend everything else here. The sea keeps the cheap sky reflection.
//
// It is a second pass over the scene and the most expensive thing on the island, so:
//   • the renderer switches it on only while a lake is near and in front of a low camera
//     (mirror(on) swaps between two ready-made materials; off, the pass does not run);
//   • the mirror camera leaves the grass out (materials.js MAIN_ONLY_LAYER);
//   • the sun's shadow maps are NOT drawn again for it: they were drawn for this frame
//     already and a shadow does not depend on who is looking.
//
// What it is now, one node material (TSL — the same graph on WebGPU and the WebGL2
// fallback) with no textures beyond a 201x201 depth bake:
//   • Three crossed sine trains displace the surface and their analytic derivatives give
//     the normal — no normal map, and the waves are the same maths on both sides.
//   • Depth-graded colour: the shallows over the beach shelf go turquoise, the deep ocean
//     goes near-black blue. The depth comes from the terrain heightmap the sim already
//     transferred, baked once into a DataTexture at world load.
//   • Fresnel: the water is transparent looking down and mirror-bright at grazing angles.
//     This is the single term that makes a flat plane stop looking flat. What it mirrors
//     is the sky dome's own gradient along the reflected ray (horizon colour low, the
//     zenith high), so a steep wave face shows deeper blue than the swell beside it.
//   • A sun specular lobe on the wave normals, tinted by whatever colour the sun is at
//     that hour, so the water carries the day/night cycle rather than ignoring it.
//   • Foam where the depth ramps to zero, modulated by the wave crest and drifting noise,
//     so the shoreline moves.
//
// GFX pass 2 adds two things the weather and the night now drive:
//   • Rain rings: while rain is falling, every cell of the surface carries an expanding
//     ring at a hashed phase, perturbing the normal — so a squall is visible on the sea
//     from a distance, not only as streaks in front of the camera.
//   • Bioluminescent surf: on the nights the world picks (renderer.js, seeded by the
//     world and the date, so it is the island's night and not the viewer's), the foam and
//     the wave crests glow cyan. It only ADDS light — mild nights stay a user call.
//
// The depth bake is why this takes a `terrain`: the shader needs to know how deep the
// water is at a point, and the CPU already has that. Sampling a baked texture is one tap;
// re-deriving it in the shader would mean shipping the heightfield to the GPU anyway.
//
// LAKES ARE PLAIN BLUE. The bake's second channel marks inland
// lakes, and on a lake nothing that whitens the surface is drawn: no foam, no caustics,
// no sun glint, no sun-warmed reflection. Body colour, the sky's Fresnel reflection and
// the fog are all a lake gets. The sea keeps every term.
import { ClampToEdgeWrapping, Color, DataTexture, DoubleSide, LinearFilter, Mesh, MeshBasicNodeMaterial, PlaneGeometry, RGFormat, UnsignedByteType, Vector3 } from 'three-eco/webgpu';
import {
  Fn, If, cameraPosition, clamp, cos, dot, exp, float, floor, fract, length, max, mix, modelWorldMatrix, normalize,
  positionGeometry, positionLocal, positionWorld, pow, reflect, reflector, screenUV, sin, smoothstep, step, texture, uniform, varying, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { MAIN_ONLY_LAYER, hash21, vnoise } from './materials.js';

const MIRROR_SCALE = 0.5;        // the mirror pass's share of the frame's resolution
const MIRROR_BEND = 0.035;       // how far a wave's slope pushes the mirrored image, in screen widths

// Three trains at incommensurable angles and speeds. Two look like a grid; four costs more
// than it adds at this wave height.
const A_DIR = [0.86, 0.51];
const B_DIR = [-0.41, 0.91];
const C_DIR = [0.62, -0.78];
const RIPPLE_RELIEF = 9;

/**
 * @param ripples the ripple field (ripples.js) or null. With it, the field's slope bends the
 *   surface normal and its crests catch a little light.
 */
function buildMaterial(u, depthTex, size, ripples = null, mirror = null) {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: true });

  // ── vertex: the wave sum and its exact derivative ──
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const a = dot(world.xz, vec2(...A_DIR)).mul(0.42).add(u.uTime.mul(0.85));
  const b = dot(world.xz, vec2(...B_DIR)).mul(0.71).add(u.uTime.mul(1.31));
  const c = dot(world.xz, vec2(...C_DIR)).mul(1.30).add(u.uTime.mul(2.10));
  // Each train's height is its own times how well it runs with the wind (uTrain, set by
  // the renderer): the sea heads the way the weather does without the pattern ever turning.
  const ha = u.uTrain.x.mul(0.20); const hb = u.uTrain.y.mul(0.11); const hc = u.uTrain.z.mul(0.05);
  const h = sin(a).mul(ha).add(sin(b).mul(hb)).add(sin(c).mul(hc));
  material.positionNode = positionLocal.add(vec3(0, h, 0));
  // dh/dx and dh/dz of the same sum — the normal is exact rather than sampled, which is
  // what keeps the specular from crawling as the camera moves.
  const ka = cos(a).mul(0.42).mul(ha); const kb = cos(b).mul(0.71).mul(hb); const kc = cos(c).mul(1.30).mul(hc);
  const dx = ka.mul(A_DIR[0]).add(kb.mul(B_DIR[0])).add(kc.mul(C_DIR[0]));
  const dz = ka.mul(A_DIR[1]).add(kb.mul(B_DIR[1])).add(kc.mul(C_DIR[1]));
  const waveNormal = varying(vec3(dx.negate(), 1, dz.negate()), 'vWaveNormal');

  // ── fragment: one Fn, so the vars and branches have a stack to live on ──
  const surface = Fn(() => {
    const P = positionWorld;
    const depthUv = P.xz.div(size);
    // Outside the island's footprint there is no bake — that is open ocean, so clamp to full
    // depth rather than letting the sampler wrap a shoreline round the horizon.
    const inside = smoothstep(0, 0.015, depthUv.x).mul(float(1).sub(smoothstep(0.985, 1, depthUv.x)))
      .mul(smoothstep(0, 0.015, depthUv.y)).mul(float(1).sub(smoothstep(0.985, 1, depthUv.y))).toVar();
    const bake = texture(depthTex, clamp(depthUv, 0, 1)).rg.toVar();
    const depth = mix(float(1), bake.x, inside).toVar();
    // 0 on a lake, 1 on the sea. A step, not the filtered value: the mask fades across the
    // one tile of land round the lake, and the lake's own rim has to be fully inside it.
    const open = float(1).sub(step(0.004, bake.y).mul(inside)).toVar();

    const view = normalize(cameraPosition.sub(P)).toVar();
    const n = normalize(waveNormal).toVar();
    // Ripple detail: a fine drifting noise gradient on the normal, so the sun glint breaks
    // into sparkle instead of one smooth lobe. Calmer at night.
    const rp = P.xz.mul(3.1).add(vec2(u.uTime.mul(0.6), u.uTime.mul(-0.45)));
    const re = 0.08;
    const rgx = vnoise(rp.add(vec2(re, 0))).sub(vnoise(rp.sub(vec2(re, 0))));
    const rgz = vnoise(rp.add(vec2(0, re))).sub(vnoise(rp.sub(vec2(0, re))));
    n.assign(normalize(n.add(vec3(rgx, 0, rgz).mul(u.uNight.mul(-0.5).add(1).mul(0.35)))));

    // Rings from whatever touched the water (ripples.js). The slope is in metres per metre
    // and a ring is a few centimetres high, so it is exaggerated to be seen from the air.
    const ring = float(0).toVar();
    const ringShade = float(0).toVar();
    if (ripples) {
      const r = ripples.sample(P.xz).toVar();
      n.assign(normalize(n.add(vec3(r.x.negate(), 0, r.z.negate()).mul(RIPPLE_RELIEF))));
      // The steep face of a ring, not its height: a raised dome of water is not white.
      ring.assign(smoothstep(0.02, 0.1, length(r.xz)));
      // A wave face turned to the sun is lighter than one turned away. Seen from straight
      // above, where the water reflects almost nothing, this is all that draws a ring.
      ringShade.assign(clamp(dot(r.xz, u.uSunDir.xz).mul(-9), -0.45, 0.9));
    }

    If(u.uRain.greaterThan(0.02), () => {
      const cell = floor(P.xz.mul(0.9));
      const local = fract(P.xz.mul(0.9)).sub(0.5);
      const hc = hash21(cell);
      const ph = fract(u.uTime.mul(1.1).add(hc.mul(9)));
      const away = local.sub(vec2(hash21(cell.add(4.1)), hash21(cell.add(8.3))).sub(0.5).mul(0.5));
      const k = length(away).sub(ph.mul(0.45)).mul(26);
      const ring = exp(k.mul(k).negate()).mul(float(1).sub(ph)).mul(step(hc, u.uRain.mul(0.9)));
      n.assign(normalize(n.add(vec3(away.x, 0, away.y).mul(ring).mul(2.2))));
    });

    // Fresnel (Schlick). F0 for water is ~0.02: almost perfectly transparent head-on and
    // almost perfectly reflective at the horizon, which is the whole look.
    const fres = pow(float(1).sub(clamp(dot(n, view), 0, 1)), 5).mul(0.98).add(0.02).toVar();
    const body = mix(u.uShallow, u.uDeep, smoothstep(0.02, 0.55, depth)).toVar();
    body.mulAssign(ringShade.add(1));

    // Caustics: two counter-drifting noise fields multiplied. Strongest where the bed is
    // closest to the surface, and by day only.
    const c1 = vnoise(P.xz.mul(2.4).add(vec2(u.uTime.mul(0.31), u.uTime.mul(0.17))));
    const c2 = vnoise(P.xz.mul(2.1).sub(vec2(u.uTime.mul(0.23), u.uTime.mul(-0.29))));
    const caustic = pow(c1.mul(c2), 1.6).mul(float(1).sub(smoothstep(0, 0.3, depth))).mul(inside).mul(open);
    body.addAssign(u.uSunColor.mul(caustic).mul(0.9).mul(float(1).sub(u.uNight)));

    // The reflection is the sky along the reflected ray: horizon colour low, zenith high.
    const refl = reflect(view.negate(), n);
    const skyRefl = mix(u.uSkyColor, u.uZenith, smoothstep(0.02, 0.55, refl.y)).toVar();
    const shine = fres.toVar();
    if (mirror) {
      // On a lake, what the water shows is the island: the mirror pass, pushed about by the
      // surface's slope. Still water also mirrors at steeper angles than a sea does.
      const lake = float(1).sub(open);
      const image = mirror.sample(screenUV.flipX().add(vec2(n.x, n.z).mul(MIRROR_BEND))).rgb;
      skyRefl.assign(mix(skyRefl, image, lake));
      shine.assign(max(fres, lake.mul(0.28)));
    }
    const col = mix(body, skyRefl, shine.mul(0.85)).toVar();

    // The reflection warms toward the sun: looking sunward across the water, the grazing
    // band takes the sun's colour rather than the zenith's.
    const vh = normalize(vec3(view.x, 0, view.z).add(1e-5));
    const sh = normalize(vec3(u.uSunDir.x, 0, u.uSunDir.z).add(1e-5));
    const sunward = pow(max(dot(vh.negate(), sh), 0), 3);
    col.assign(mix(col, u.uSunColor, fres.mul(sunward).mul(0.35).mul(open)));

    // Blinn-Phong sun glint, tightened at night so the moonlit sheen is a line, not a wash.
    const halfway = normalize(u.uSunDir.add(view));
    const spec = pow(max(dot(n, halfway), 0), mix(90, 220, u.uNight));
    col.addAssign(u.uSunColor.mul(spec).mul(u.uNight.mul(-0.55).add(1)).mul(1.6).mul(open));

    // Foam: a band where the bed rises to meet the surface, cut up by drifting noise and
    // pushed by the wave crest so the line advances and retreats.
    const crest = smoothstep(0.02, 0.16, float(1).sub(n.y).mul(6));
    const shore = float(1).sub(smoothstep(0, 0.085, depth));
    const grain = vnoise(P.xz.mul(1.7).add(vec2(u.uTime.mul(0.35), u.uTime.mul(-0.22))));
    const foam = clamp(shore.mul(grain.mul(0.75).add(0.55)).add(crest.mul(shore).mul(0.9)), 0, 1).mul(inside).mul(open).toVar();
    col.assign(mix(col, vec3(0.93, 0.97, 1.0), foam.mul(0.85)));
    // The face of a ring is a thin line of broken water.
    col.assign(mix(col, vec3(0.93, 0.97, 1.0), ring.mul(0.2)));

    // Bioluminescence: dinoflagellates light where the water is disturbed — the breaking
    // shore and the crests — in pulses that travel with the surf.
    If(u.uBio.greaterThan(0.01).and(u.uNight.greaterThan(0.05)), () => {
      const spark = vnoise(P.xz.mul(2.6).add(vec2(u.uTime.mul(0.8), u.uTime.mul(-0.5))));
      const pulse = sin(u.uTime.mul(1.7).add(P.x.mul(0.4)).add(P.z.mul(0.25))).mul(0.45).add(0.55);
      const glow = foam.mul(spark.mul(0.8).add(0.6)).add(crest.mul(0.25).mul(spark)).mul(pulse);
      col.assign(mix(col, col.mul(0.4), u.uBio.mul(u.uNight).mul(foam).mul(0.5)));
      col.addAssign(vec3(0.1, 0.75, 0.95).mul(glow).mul(u.uBio).mul(smoothstep(0.05, 0.6, u.uNight)).mul(1.6));
    });

    // Alpha: see the bed in the shallows, opaque in the deep, and never fully transparent
    // at a grazing angle however shallow it is (that is where the reflection lives).
    const alpha = clamp(mix(0.34, 0.94, smoothstep(0, 0.3, depth)).add(fres.mul(0.5)).add(foam.mul(0.6)), 0, 1);
    return vec4(col, alpha);
  })();
  material.colorNode = surface.rgb;
  material.opacityNode = surface.a;
  return material;
}

/**
 * Bake the water depth at every terrain corner into an RG8 texture. R: 0 where the bed is
 * at or above the surface, 1 at the heightmap's -3 m floor. G: 255 on a lake's corners.
 */
function bakeDepth(terrain) {
  const cs = terrain.size + 1;
  const data = new Uint8Array(cs * cs * 2);
  for (let i = 0; i < cs * cs; i++) {
    data[i * 2] = Math.max(0, Math.min(255, Math.round((-terrain.height[i] / 3) * 255)));
    data[i * 2 + 1] = terrain.lake[i] ? 255 : 0;
  }
  const tex = new DataTexture(data, cs, cs, RGFormat, UnsignedByteType);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @param {{size:number, height:Float32Array, lake:Uint8Array}} terrain corner
 *   heights AS DRAWN and the lake corner mask, both from terrainMesh.js (not terrainApi:
 *   the sim's lake bed is at sea level, the drawn one is not)
 * @param {{ tier?: string }} [opts] segment count follows the tier — the waves are vertex
 *   work, so this is the one dial that matters for cost.
 */
export function createWater(terrain, { tier = 'high' } = {}) {
  const size = terrain.size;
  const segments = tier === 'high' ? 192 : tier === 'medium' ? 96 : 48;
  const geometry = new PlaneGeometry(size * 3, size * 3, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const depth = bakeDepth(terrain);
  // Hex-constructed Colors are already in three's linear working space (ColorManagement is
  // on by default) — converting again would wash them out.
  const u = {
    uTime: uniform(0),
    uShallow: uniform(new Color(0x2fb6c8)),
    uDeep: uniform(new Color(0x062f4a)),
    uSunDir: uniform(new Vector3(0.4, 0.8, 0.4)),
    uSunColor: uniform(new Color(0xfff2df)),
    uSkyColor: uniform(new Color(0x8ec5ff)),
    uZenith: uniform(new Color(0x2f6fd0)),
    uNight: uniform(0),
    uRain: uniform(0),
    uBio: uniform(0),
    uTrain: uniform(new Vector3(1, 1, 1)),
  };
  const train = new Vector3(1, 1, 1);
  // The surface must not occlude the bed it is meant to reveal (no depth write), and the
  // camera can dive: from below, the surface is a ceiling (double-sided). The scene's
  // FogExp2 applies through the node material's own fog stage.
  let material = buildMaterial(u, depth, size);
  // The lakes' mirror: made by setMirror, drawn only while `mirrorOn`.
  let reflection = null; let mirrorMaterial = null; let mirrorOn = false; let field = null;
  let mirrorScene = null;

  const mesh = new Mesh(geometry, material);
  mesh.position.set(size / 2, 0, size / 2);
  mesh.renderOrder = 4;     // after the island, before the particle pools
  mesh.name = 'water';

  return {
    mesh,
    /**
     * @param {number} time seconds
     * @param {{ sunDir: THREE.Vector3, sunColour: THREE.Color, sky: THREE.Color, night: number, fogDensity: number }} sky
     *   the `info` object lighting.update() returns — same object every frame, by design.
     */
    update(time, sky, surface = null) {
      u.uTime.value = time;
      if (surface) {
        u.uRain.value = surface.rain; u.uBio.value = surface.bio ?? 0;
        // A train's phase is k.x + wt, so it travels against its DIR: the ones heading
        // downwind stand taller. `swell` scales the lot (a calm sea 0.5, a gale past 1.5).
        const wl = Math.hypot(surface.windX ?? 0, surface.windZ ?? 0);
        if (wl > 1e-4) {
          const wx = surface.windX / wl; const wz = surface.windZ / wl;
          const run = (d) => 0.55 + 0.9 * Math.max(0, -(d[0] * wx + d[1] * wz));
          train.set(run(A_DIR), run(B_DIR), run(C_DIR)).multiplyScalar(surface.swell ?? 1);
        } else train.set(1, 1, 1).multiplyScalar(surface.swell ?? 1);
        u.uTrain.value.lerp(train, 0.02);
      }
      if (!sky) return;
      u.uSunDir.value.copy(sky.sunDir);
      u.uSunColor.value.copy(sky.sunColour);
      u.uSkyColor.value.copy(sky.sky);
      if (sky.zenith) u.uZenith.value.copy(sky.zenith);
      u.uNight.value = sky.night;
    },
    /**
     * Rebuild the surface with a ripple field in it. Done once, after the renderer's backend
     * is known: the field lives in storage buffers, which only WebGPU has.
     */
    attachRipples(ripples) {
      field = ripples;
      const old = material;
      material = buildMaterial(u, depth, size, ripples);
      old.dispose();
      if (reflection) { const was = mirrorMaterial; mirrorMaterial = buildMaterial(u, depth, size, ripples, reflection); was?.dispose(); }
      mesh.material = mirrorOn && mirrorMaterial ? mirrorMaterial : material;
    },
    /**
     * Give the lakes a mirror. `scene` and `camera` are the main view's; `shadows` the sun's
     * shadow maps (lighting.shadows), held still while the mirror is drawn. Returns false if
     * the reflector cannot be built (the lakes then keep the sky).
     */
    setMirror({ scene, camera, shadows = [] }) {
      if (reflection) return true;
      try {
        reflection = reflector({ resolutionScale: MIRROR_SCALE, bounces: false });
        // The reflector's own +Z is the mirror's normal: turn it to face up, at sea level.
        reflection.target.rotateX(-Math.PI / 2);
        reflection.target.position.set(size / 2, 0, size / 2);
        scene.add(reflection.target);
        mirrorScene = scene;
        const base = reflection.reflector;
        // The mirror's camera, made here so it can leave the grass out.
        const eye = camera.clone();
        eye.layers.disable(MAIN_ONLY_LAYER);
        base.virtualCameras.set(camera, eye);
        // A shadow map is the light's view, not the viewer's: this frame's are already drawn.
        const draw = base.updateBefore.bind(base);
        base.updateBefore = (frame) => {
          // Asked for each time: the high tier's second map does not exist until first drawn.
          const maps = typeof shadows === 'function' ? shadows() : shadows;
          const was = maps.map(s => s.autoUpdate);
          for (const s of maps) s.autoUpdate = false;
          try { return draw(frame); } finally { maps.forEach((s, i) => { s.autoUpdate = was[i]; }); }
        };
        mirrorMaterial = buildMaterial(u, depth, size, field, reflection);
        return true;
      } catch (err) {
        console.warn('[poecosystem] lake mirror unavailable', err);
        reflection = null; mirrorMaterial = null;
        return false;
      }
    },
    /** Draw the mirror pass (true) or not: the renderer says when a lake is worth it. */
    mirror(on) {
      const next = !!on && !!mirrorMaterial;
      if (next === mirrorOn) return;
      mirrorOn = next;
      mesh.material = mirrorOn ? mirrorMaterial : material;
    },
    get mirroring() { return mirrorOn; },
    dispose() {
      geometry.dispose(); material.dispose(); depth.dispose();
      mirrorMaterial?.dispose();
      if (reflection) { mirrorScene?.remove(reflection.target); try { reflection.dispose(); } catch { /* targets already gone */ } }
    },
  };
}
