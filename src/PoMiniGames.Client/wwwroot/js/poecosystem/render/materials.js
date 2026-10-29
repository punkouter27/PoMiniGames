// materials.js — the surface detail every creature, tree, hut and prop shares, as node
// materials (TSL), so the same graph compiles to WGSL on WebGPU and GLSL on three's WebGL2
// backend.
//
// The art direction is flat-shaded low-poly Lambert, and that stays. What a flat facet
// cannot say on its own is added by EcoLambertMaterial, a MeshLambertNodeMaterial that
// hooks the two places the old onBeforeCompile patch did — the diffuse colour before
// lighting and the outgoing light after it:
//
//   RIM     a Fresnel-weighted light on the silhouette, tinted by the sky. A rabbit on
//           grass is brown on green; the rim is what separates them at twenty metres.
//   MOTTLE  world-space value noise on the diffuse colour — fur, bark, stone grain — at
//           a scale the caller chooses. World space, so instances differ for free.
//   SWAY    a vertex displacement that grows with the mesh's own height, phased per
//           instance so a forest does not move in lockstep. Crowns and bushes only.
//   CLOUDS  the deck overhead, projected down the sun's ray (cloudLight below).
//   WEATHER wet surfaces darken and catch the sky on the rim; snow settles on faces that
//           point up; autumn warms everything a little.
//   LENS    the naturalist lenses draw a creature in its instance colour, lit or not.
//
// One set of uniforms. The renderer sets `.value` on these once per frame and every
// material reads the same node, so a new material never needs its own plumbing.
//
// LOW TIER: the material reads materialDetail when it is built (the renderer sets it before
// anything is created) and leaves rim, mottle and cloud shade out of the graph entirely —
// not a branch that costs nothing, a shader that never had them.
import { Color, MeshLambertNodeMaterial, Vector3 } from 'three-eco/webgpu';
import {
  Fn, clamp, diffuseColor, dot, float, floor, fract, instanceColor, instanceIndex, max, mix,
  normalView, normalWorldGeometry, positionGeometry, positionLocal, positionViewDirection,
  positionWorld, pow, sin, cos, smoothstep, step, uniform, vec2, vec3,
} from 'three-eco/tsl';

export const materialClock = uniform(0);
export const materialDetail = { value: 1 };        // read at build time: 0 on the low tier
export const materialSeason = uniform(0);          // 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter
export const materialSnow = uniform(0);            // 0..1 snow coverage factor
// Weather on surfaces: the sim's own ground wetness (weather.js), and the sky colour a wet
// surface reflects. Set once per frame by the renderer, like the clock.
export const materialWet = uniform(0);
export const materialSky = uniform(new Color(0x8ec5ff));
// The naturalist lenses: how far a creature's instance colour replaces its lit colour.
export const materialLens = uniform(0);

// Cloud shadows. The deck sky.js draws is a noise field anchored to the world, so the same
// field, sampled where the sun's ray through a surface point meets the deck, says whether
// that point is in shade. The renderer sets these once per frame from the sky it has just
// updated; the terrain and grass bind the same nodes.
export const materialCloud = {
  uCloudTime: uniform(0),
  uCloudCover: uniform(0.45),
  uCloudShade: uniform(0),                          // 0 = none (night, low tier, closed deck)
  uCloudSun: uniform(new Vector3(0, 1, 0)),
};

/** The hash every effect shares, so the cloud shadows match the clouds overhead. */
export const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)))
  .setLayout({ name: 'ecoHash', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/** 2D value noise, smoothstep-interpolated. One real function in the shader, not inlined. */
export const vnoise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1, 0)));
  const c = hash21(i.add(vec2(0, 1)));
  const d = hash21(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}).setLayout({ name: 'ecoNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/**
 * 1 in sunlight, down to 1 - shade under a cloud. 96 is sky.js CLOUD_Y; the scale and
 * drift are the cloud deck's own, so a shadow slides under the cloud that casts it.
 */
export const cloudLight = Fn(([world]) => {
  const { uCloudTime: t, uCloudCover: cover, uCloudShade: shade, uCloudSun: sun } = materialCloud;
  const at = world.xz.add(sun.xz.mul(float(96).sub(world.y).div(max(sun.y, 0.25))));
  const p = at.mul(0.006).add(vec2(t.mul(0.0045), t.mul(0.0018)));
  const n = vnoise(p).mul(0.55).add(vnoise(p.mul(2.3).add(7.1)).mul(0.3)).add(vnoise(p.mul(5.1).sub(3.3)).mul(0.15));
  const edge = mix(0.72, 0.42, cover);
  return float(1).sub(smoothstep(edge.sub(0.04), edge.add(0.26), n).mul(shade));
});
// (No setLayout here, unlike the noise: a layout function cannot reach the shared uniforms,
// so this one is inlined at its one call site per material.)

const SNOW = vec3(0.92, 0.95, 0.98);

/** Wet, snow and autumn on a base colour; `up` is how far the face points at the sky. */
export function weatherColour(base, up) {
  const wet = base.mul(materialWet.mul(-0.2).add(1));
  const snowing = step(0.05, materialSnow);
  const snowF = smoothstep(0.2, 0.75, up).mul(materialSnow).mul(snowing);
  const autumn = step(1.5, materialSeason).mul(step(materialSeason, 2.5)).mul(float(1).sub(snowing));
  const warm = mix(wet, wet.mul(vec3(1.25, 0.8, 0.45)), autumn.mul(0.35));
  return mix(warm, SNOW, snowF.mul(0.85));
}

/**
 * MeshLambertNodeMaterial plus the shared surface terms. `opts` as the old enhanceLambert:
 * rim strength (0 = off) · mottle amplitude 0..1 · mottleScale world units per cycle ·
 * sway metres at the top · swayHeight the mesh height over which sway ramps · lens follows
 * materialLens (only meshes that carry instanceColor — the creatures).
 */
export class EcoLambertMaterial extends MeshLambertNodeMaterial {
  constructor(params = {}, { rim = 0.35, rimColor = 0xbfd4ff, mottle = 0.18, mottleScale = 1.6, sway = 0, swayHeight = 3, lens = false } = {}) {
    super(params);
    this.detail = materialDetail.value > 0.5;
    this.eco = { rim, rimColor: new Color(rimColor), mottle, mottleInv: 1 / Math.max(0.05, mottleScale), lens };
    // three keys a compiled program on the material's node graph and its plain properties;
    // the constants baked in by the overrides below are neither, so they go in the key.
    this.ecoKey = `eco:${this.detail ? 1 : 0}:${rim}:${rimColor}:${mottle}:${mottleScale}:${sway}:${swayHeight}:${lens ? 1 : 0}`;
    if (sway > 0) {
      // positionLocal is already instance-transformed here; positionGeometry is the mesh's
      // own vertex, which is what the lift ramps over. The phase is per instance.
      const lift = clamp(positionGeometry.y.add(swayHeight * 0.5).div(Math.max(0.1, swayHeight)), 0, 1);
      const lift2 = lift.mul(lift);
      const phase = materialClock.mul(1.35).add(hash21(vec2(float(instanceIndex), 3.7)).mul(6.283));
      this.positionNode = positionLocal.add(vec3(sin(phase).mul(sway).mul(lift2), 0, cos(phase.mul(0.83).add(1.7)).mul(sway * 0.6).mul(lift2)));
    }
  }

  customProgramCacheKey() { return super.customProgramCacheKey() + this.ecoKey; }

  setupDiffuseColor(builder) {
    super.setupDiffuseColor(builder);
    let c = diffuseColor.rgb;
    if (this.detail) {
      c = c.mul(cloudLight(positionWorld));
      if (this.eco.mottle > 0) {
        // Two octaves in world space; the vertical term keeps the pattern from streaking
        // down a trunk or a leg.
        const w = positionWorld.mul(this.eco.mottleInv);
        const m = vnoise(w.xz.add(w.y.mul(0.7))).mul(0.6).add(vnoise(w.xz.mul(2.9).sub(w.y.mul(1.3))).mul(0.4));
        c = c.mul(m.mul(this.eco.mottle).add(1 - this.eco.mottle * 0.5));
      }
    }
    diffuseColor.rgb.assign(weatherColour(c, clamp(normalWorldGeometry.y, 0, 1)));
  }

  setupLighting(builder) {
    let out = super.setupLighting(builder);
    if (this.detail && this.eco.rim > 0) {
      const rimF = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3.2);
      out = out.add(uniformColour(this.eco.rimColor).mul(rimF).mul(this.eco.rim).mul(diffuseColor.g.mul(0.65).add(0.35)));
      // A wet surface mirrors the sky along its silhouette — the sheen that tells the eye
      // it has been raining before it sees a single drop.
      out = out.add(materialSky.mul(rimF).mul(materialWet).mul(0.35));
    }
    if (this.eco.lens && builder.object?.instanceColor) out = mix(out, instanceColor, materialLens);
    return out;
  }
}

const uniformColour = (c) => vec3(c.r, c.g, c.b);

/** The old call shape: params for the Lambert, opts for the surface terms. */
export function ecoLambert(params, opts) { return new EcoLambertMaterial(params, opts); }
