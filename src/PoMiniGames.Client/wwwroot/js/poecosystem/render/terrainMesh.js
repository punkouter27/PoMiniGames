// terrainMesh.js — the island as one vertex-coloured mesh plus the water surface.
//
// Colours come from the biome and the live grass biomass, so grazing, fire and lava show
// up without rebuilding geometry: only the colour attribute is rewritten (per tile-sync).
//
// GFX option 7 keeps that contract and adds a surface to it. The material is still Lambert —
// the flat-shaded low-poly look is the art direction, not a limitation — as a node material
// (TerrainMaterial below, TSL: one graph for WebGPU and the WebGL2 fallback) that adds the
// terms the vertex colours cannot express (the low tier builds it without GRAIN..BUMP and the cloud shade):
//
//   GRAIN    two octaves of value noise in world space, so a tile is no longer one flat
//            facet of colour when the god stands on it.
//   STRATA   the same noise sampled without a vertical term, which smears into horizontal
//            banding on steep faces. On a cliff that reads as rock strata; on flat ground
//            it is invisible because the surface is already being grained.
//   ROCK     slope-blended grey. Anything past ~40° stops being soil regardless of biome,
//            which is what gives the mountains an edge the vertex palette never had.
//   WET      a darkening band either side of the waterline, so the beach meets the sea in
//            a damp margin instead of at a hard colour boundary.
//   SNOW     above a line set from the island's own peak height, jittered by noise and
//            held only by gentle faces — the mountains get a cap, the cliffs stay bare.
//   RIPPLES  wind lines on the beach shelf, a metre-scale sine bent by noise.
//   BUMP     a noise-gradient perturbation of the fragment normal (the node Lambert lights
//            per fragment), so light rakes across ground that used to be one flat
//            facet per triangle. Cheap: four noise taps, high tier only.
//
// Lava and fire additionally get a real EMISSIVE channel, via a per-vertex `aGlow`
// attribute written by paint(). That is what makes them bloom in postProcess.js — before
// this they were flat orange vertex colours, which no bright-pass can find.
//
// GFX pass 2 lets the ground answer to what happens ON it:
//
//   PATHS    the WEAR channel of trails.js packs grass into bare earth along the routes
//            creatures actually walk; the FRESH channel darkens sand and cuts tracks
//            through snow.
//   WEATHER  the sim's own ground wetness (weather.js) darkens the soil, puts a sky sheen
//            on it and opens puddles on flat ground that mirror the sky and the sun, with
//            rain rings while it is still falling. Snow cover (a weather spell, or winter)
//            settles on every gentle face, not only the peaks.
//   BORDERS  each tribe's territory edge as a faint ground-projected line of its banner
//            colour that brightens after dark — the island's politics, drawn on the land.
import { BufferAttribute, Color, DynamicDrawUsage, Mesh, MeshLambertNodeMaterial, PlaneGeometry, Vector3, Vector4 } from 'three-eco/webgpu';
import {
  If, abs, attribute, cameraPosition, cameraViewMatrix, clamp, diffuseColor, distance, dot, exp, float, floor,
  fract, length, max, mix, normalGeometry, normalViewGeometry, normalize, positionWorld, pow, reflect,
  sin, smoothstep, step, uniform, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { TILE, TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';
import { createWater } from './water.js';
import { trailUniforms } from './trails.js';
import { cloudLight, hash21, vnoise } from './materials.js';
const MAX_TRIBES = 4;

// Base colours per tile type (linear-ish sRGB hex, picked to read at a distance).
const BIOME = {
  [TILE.OCEAN]: 0x0c4a6e, [TILE.BEACH]: 0xd8c48f, [TILE.GRASS]: 0x4e7f2f, [TILE.FOREST]: 0x1f5c2a,
  [TILE.HILL]: 0x6b7a4a, [TILE.MOUNTAIN]: 0x7a736b, [TILE.LAKE]: 0x0ea5e9, [TILE.VOLCANO]: 0x44403c,
};
const STATE_COLOUR = {
  [TILE_STATE.FIRE]: 0xf97316, [TILE_STATE.BURNT]: 0x2a2724, [TILE_STATE.LAVA]: 0xef4444,
  [TILE_STATE.COOLED]: 0x3f3a36, [TILE_STATE.BOULDER]: 0x8a8378,
  // The tribe's works: sooted hearth, tilled earth, a packed-earth tower footing. A fence
  // keeps the grass under it.
  [TILE_STATE.CAMPFIRE]: 0x5a4030, [TILE_STATE.FIELD]: 0x7a5a32, [TILE_STATE.TOWER]: 0x6b5a45,
};
// How hard each state glows. Fire flickers (the renderer drives uGlowPulse); lava is
// steady and hot; everything else is 0 and costs the shader a multiply.
const STATE_GLOW = { [TILE_STATE.FIRE]: 1.0, [TILE_STATE.LAVA]: 0.85, [TILE_STATE.CAMPFIRE]: 0.45 };
const DRY = new Color(0x8a7f4a);   // grass at zero biomass
// How far under the surface the middle of a lake's bed is DRAWN. The sim flattens a lake
// to exactly sea level (island.js), which is the water plane's own height: every wave
// trough dipped under the bed and showed it, and the rest of the lake was a zero-depth
// shoreline (full foam, full caustics) — a white sheet with a ragged blue edge. Two
// limits: deeper than the wave sum in water.js (0.36), and no steeper than the rock blend
// below starts at (a 1 m rim tile dropping 0.8 is just under it), or the bank turns grey.
// Render-only: terrain.height and heightAt still say sea level.
const LAKE_BED = -0.8;

/**
 * The island's material: MeshLambertNodeMaterial with the ground terms folded into the
 * diffuse colour (before lighting), the bump into the normal, lava/fire and the borders
 * into the emissive, and the puddles' reflection mixed in after the lighting sum — the same
 * four places the old onBeforeCompile patch reached into.
 */
class TerrainMaterial extends MeshLambertNodeMaterial {
  constructor(u, detail) {
    super({ vertexColors: true, flatShading: true });
    this.u = u;
    this.detail = detail;
    this.ecoKey = `terrain:${detail ? 1 : 0}`;
    const xz = positionWorld.xz;
    if (detail) {
      // Bump: the gradient of a world-space noise field, rotated into view space (where the
      // Lambert normal lives), so the ground catches light unevenly.
      const e = 0.35;
      const hx = vnoise(xz.add(vec2(e, 0)).mul(1.9)).sub(vnoise(xz.sub(vec2(e, 0)).mul(1.9)));
      const hz = vnoise(xz.add(vec2(0, e)).mul(1.9)).sub(vnoise(xz.sub(vec2(0, e)).mul(1.9)));
      const bump = cameraViewMatrix.mul(vec4(hx.negate(), 0, hz.negate(), 0)).xyz;
      this.normalNode = normalize(normalViewGeometry.add(bump.mul(0.55)));
    }
    // aGlow is 0 for all but burning and molten tiles, so this is a multiply-add for the
    // whole island and a real light source for the handful of tiles that are lit.
    const glow = attribute('aGlow', 'float');
    let emissive = diffuseColor.rgb.mul(glow).mul(u.uGlowPulse).mul(2.4);
    // Territory borders: a soft line at each tribe's radius, breathing slowly, faint by day
    // and a real glow after dark (0.3: seen through the night bloom, more washes the frame).
    const steep = smoothstep(0.22, 0.62, float(1).sub(clamp(normalize(normalGeometry).y, 0, 1)));
    for (let k = 0; k < MAX_TRIBES; k++) {
      const t = u.uTribe[k];
      const edge = abs(distance(xz, t.xy).sub(t.z));
      const line = exp(edge.mul(edge).mul(-1.4));
      const pulse = sin(u.uTerrainTime.mul(0.9).add(k * 2.1).add(positionWorld.x.mul(0.05))).mul(0.25).add(0.75);
      emissive = emissive.add(u.uTribeCol[k].mul(line).mul(pulse).mul(u.uNight.mul(0.3).add(0.05)).mul(float(1).sub(steep.mul(0.5))).mul(step(0.5, t.w)));
    }
    this.emissiveNode = emissive;
  }

  customProgramCacheKey() { return super.customProgramCacheKey() + this.ecoKey; }

  setupDiffuseColor(builder) {
    super.setupDiffuseColor(builder);
    const u = this.u;
    const P = positionWorld;
    const xz = P.xz;
    const glow = attribute('aGlow', 'float');
    const wn = normalize(normalGeometry);            // the mesh sits at the origin: local = world
    const steep = smoothstep(0.22, 0.62, float(1).sub(clamp(wn.y, 0, 1))).toVar('tSteep');
    const c = diffuseColor.rgb.toVar('tCol');
    if (this.detail) {
      // Grain: two octaves, the second at a prime-ish ratio so the pattern does not beat
      // against the 1 m tile grid.
      const g = vnoise(xz.mul(0.65)).mul(0.62).add(vnoise(xz.mul(2.7)).mul(0.38)).toVar('tGrain');
      c.mulAssign(g.mul(0.28).add(0.86));
      // Strata: no vertical term in the sample, so on a cliff this smears into bands.
      const bands = vnoise(vec2(P.y.mul(3.1), P.x.add(P.z).mul(0.18)));
      c.assign(mix(c, vec3(0.36, 0.34, 0.32).mul(bands.mul(0.5).add(0.72)), steep.mul(0.72)));
      // Wet margin: darker where the tide would reach.
      c.mulAssign(float(1).sub(float(1).sub(smoothstep(-0.15, 1.1, P.y)).mul(0.34)));
      // Snow: a noise-jittered line, held only where the face is gentle enough.
      const snowLine = u.uSnowLine.add(vnoise(xz.mul(0.21)).mul(4));
      const snow = smoothstep(snowLine, snowLine.add(3.5), P.y).mul(float(1).sub(steep.mul(0.85)));
      c.assign(mix(c, vec3(0.93, 0.95, 0.98).mul(g.mul(0.1).add(0.9)), snow));
      // Sand ripples: wind lines on the flat of the beach, bent by the same noise.
      const beach = smoothstep(-0.2, 0.4, P.y).mul(float(1).sub(smoothstep(1.2, 2.4, P.y))).mul(float(1).sub(steep));
      const ripple = sin(P.x.mul(0.9).add(P.z.mul(0.35)).add(vnoise(xz.mul(0.5)).mul(2)).mul(6)).mul(0.5).add(0.5);
      c.mulAssign(float(1).sub(beach.mul(ripple).mul(0.09)));
      // Cloud shadows; lava and fire are their own light and stay bright.
      c.mulAssign(mix(cloudLight(P), float(1), step(0.01, glow)));
    }

    // Paths, tracks, wet ground, lowland snow (every tier).
    const dry = smoothstep(0.1, 0.7, P.y).mul(float(1).sub(step(0.01, glow))).toVar('tDry');
    const trail = trailUniforms.uTrail.sample(xz.div(trailUniforms.uTrailSpan)).rg.toVar('tTrail');
    // Worn earth only where the ground is vegetated (greener than it is red).
    const veg = smoothstep(0, 0.08, c.g.sub(c.r));
    const worn = smoothstep(0.06, 0.55, trail.x).mul(veg).mul(float(1).sub(steep)).mul(dry).toVar('tWorn');
    c.assign(mix(c, vec3(0.31, 0.24, 0.16).mul(vnoise(xz.mul(3)).mul(0.2).add(0.9)), worn.mul(0.78)));
    c.mulAssign(float(1).sub(trail.y.mul(0.16).mul(dry)));

    const snowCov = float(0).toVar('tSnowCov');
    If(u.uSnowCover.greaterThan(0.01), () => {
      const drift = vnoise(xz.mul(0.33)).mul(0.6).add(vnoise(xz.mul(1.7)).mul(0.4));
      // The threshold walks down the noise as cover grows: a dusting is a few drifts in
      // the hollows, a full winter a blanket with the odd bare patch.
      const line = float(1.02).sub(u.uSnowCover.mul(1.1));
      snowCov.assign(smoothstep(line, line.add(0.16), drift).mul(float(1).sub(steep.mul(0.9))).mul(dry)
        .mul(float(1).sub(trail.y.mul(0.85))).mul(float(1).sub(trail.x.mul(0.6))));
      c.assign(mix(c, vec3(0.9, 0.93, 0.97), snowCov.mul(0.9)));
    });

    const puddle = float(0).toVar('tPuddle');
    If(u.uWet.greaterThan(0.01), () => {
      c.mulAssign(float(1).sub(u.uWet.mul(0.26).mul(dry).mul(float(1).sub(snowCov))));
      const flatness = pow(clamp(wn.y, 0, 1), 12);
      // Puddles are the hollows of a finer noise; a drier island needs a deeper hollow.
      const hollow = vnoise(xz.mul(0.6).add(11)).mul(0.7).add(vnoise(xz.mul(1.9).sub(4)).mul(0.3));
      const pool = smoothstep(0.7, 0.75, hollow.sub(float(1).sub(u.uWet).mul(0.3)));
      puddle.assign(pool.mul(flatness).mul(u.uWet).mul(dry).mul(float(1).sub(snowCov)).mul(float(1).sub(worn.mul(0.5))));
    });
    diffuseColor.rgb.assign(c);
    this._stash = { dry, puddle };
  }

  setupLighting(builder) {
    const lit = super.setupLighting(builder).toVar('tLit');
    const u = this.u;
    const { dry, puddle } = this._stash;
    const P = positionWorld;
    // Puddles and wet sheen are reflections, so they go after the lighting sum.
    If(puddle.greaterThan(0.001).or(u.uWet.greaterThan(0.01)), () => {
      const view = normalize(cameraPosition.sub(P));
      const fres = pow(float(1).sub(clamp(view.y, 0, 1)), 5).mul(0.96).add(0.04);
      const n = vec3(0, 1, 0).toVar('tPuddleN');
      If(u.uRain.greaterThan(0.02).and(puddle.greaterThan(0.001)), () => {
        // Rain rings: one expanding ring per cell, at a hashed phase.
        const cell = floor(P.xz.mul(1.6));
        const local = fract(P.xz.mul(1.6)).sub(0.5);
        const ph = fract(u.uTerrainTime.mul(0.9).add(hash21(cell).mul(7)));
        const ringD = length(local.sub(vec2(hash21(cell.add(3.1)), hash21(cell.add(7.7))).sub(0.5).mul(0.5)));
        const k = ringD.sub(ph.mul(0.5)).mul(22);
        const ring = exp(k.mul(k).negate()).mul(float(1).sub(ph)).mul(step(hash21(cell.add(1.3)), u.uRain));
        n.assign(normalize(n.add(vec3(local.x, 0, local.y).mul(ring).mul(1.5))));
      });
      const refl = reflect(view.negate(), n);
      const sunSpec = pow(max(dot(refl, normalize(u.uSunDirW)), 0), 220);
      const mirror = u.uSkyCol.mul(0.85).add(u.uSunCol.mul(sunSpec).mul(3));
      lit.assign(mix(lit, mirror, puddle.mul(fres.mul(0.5).add(0.45))));
      lit.addAssign(u.uSkyCol.mul(fres).mul(u.uWet).mul(0.1).mul(dry));
    });
    return lit;
  }
}

export function createTerrainMesh(terrain, { tier = 'high' } = {}) {
  const { size, height } = terrain;
  const cs = size + 1;
  const drawn = Float32Array.from(height);
  // Lake tiles touching each corner, 0..4. Non-zero is the lake mask water.js bakes; only a
  // corner with lake on all four sides is sunk. The rim stays where the sim put it, because
  // it is shared with land tiles, and creatures, trees and huts stand at the sim's height.
  const lake = new Uint8Array(cs * cs);
  for (let t = 0; t < size * size; t++) {
    if (terrain.type[t] !== TILE.LAKE) continue;
    const o = tileZ(t, size) * cs + tileX(t, size);
    lake[o]++; lake[o + 1]++; lake[o + cs]++; lake[o + cs + 1]++;
  }
  for (let k = 0; k < drawn.length; k++) if (lake[k] === 4) drawn[k] = Math.min(drawn[k], LAKE_BED);
  const geometry = new PlaneGeometry(size, size, size, size);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  // PlaneGeometry rows run +x then -z; translate so tile (0,0) sits at world (0,0).
  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < cs; i++) {
      const v = j * cs + i;
      pos.setX(v, i);
      pos.setZ(v, j);
      pos.setY(v, drawn[v]);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(cs * cs * 3), 3));
  const glowAttr = new BufferAttribute(new Float32Array(cs * cs), 1);
  glowAttr.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aGlow', glowAttr);

  // The snow line follows the island's own relief: a low island gets none, a tall one gets
  // a cap on its top fifth. 1e6 disables the term without a branch in the shader.
  let peak = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > peak) peak = height[i];
  // Uniform nodes the renderer drives per frame (update / setTribes below).
  const uniforms = {
    uGlowPulse: uniform(1),
    uSnowLine: uniform(peak > 16 ? peak * 0.78 : 1e6),
    uWet: uniform(0),
    uRain: uniform(0),
    uSnowCover: uniform(0),
    uSkyCol: uniform(new Color(0x8ec5ff)),
    uSunDirW: uniform(new Vector3(0, 1, 0)),
    uSunCol: uniform(new Color(0xfff2df)),
    uNight: uniform(0),
    uTerrainTime: uniform(0),
    uTribe: Array.from({ length: MAX_TRIBES }, () => uniform(new Vector4(0, 0, 0, 0))),  // x, z, territory radius, 1 = present
    uTribeCol: Array.from({ length: MAX_TRIBES }, () => uniform(new Color(0xffffff))),
  };
  const material = new TerrainMaterial(uniforms, tier !== 'low');

  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'island';

  const water = createWater({ size, height: drawn, lake }, { tier });

  const colour = new Color();

  /** Recolour every vertex from the tile type, its state and the grass biomass (0..255). */
  function paint(tileState, grass) {
    const colours = geometry.attributes.color;
    const glow = geometry.attributes.aGlow;
    for (let j = 0; j < cs; j++) {
      for (let i = 0; i < cs; i++) {
        // A corner takes the colour of the tile down-right of it (clamped at the edges).
        const t = Math.min(size - 1, i) + Math.min(size - 1, j) * size;
        const state = tileState?.[t] ?? 0;
        const stateColour = STATE_COLOUR[state];
        if (stateColour !== undefined) colour.setHex(stateColour);
        else {
          colour.setHex(BIOME[terrain.type[t]] ?? 0x555555);
          // lerp does not mutate its argument, so the constant can be passed directly.
          if (grass && (terrain.type[t] === TILE.GRASS || terrain.type[t] === TILE.HILL)) colour.lerp(DRY, 1 - grass[t] / 255);
        }
        const v = j * cs + i;
        colours.setXYZ(v, colour.r, colour.g, colour.b);
        glow.setX(v, STATE_GLOW[state] ?? 0);
      }
    }
    colours.needsUpdate = true;
    glow.needsUpdate = true;
  }
  paint(null, null);

  return {
    mesh,
    water: water.mesh,
    paint,
    /**
     * Per frame. `time` drives the fire flicker on the emissive channel and the water's
     * wave clock; `sky` is the object lighting.update() returns.
     */
    update(time, sky, surface = null) {
      // One shared flicker for every burning tile: fires on an island genuinely do pulse
      // together at a distance, and a per-tile phase would need a second attribute upload.
      uniforms.uGlowPulse.value = 0.78 + Math.sin(time * 7.3) * 0.14 + Math.sin(time * 11.9) * 0.08;
      uniforms.uTerrainTime.value = time;
      if (sky) {
        uniforms.uSkyCol.value.copy(sky.sky);
        uniforms.uSunDirW.value.copy(sky.sunDir);
        uniforms.uSunCol.value.copy(sky.sunColour);
        uniforms.uNight.value = sky.night;
      }
      if (surface) {
        uniforms.uWet.value = surface.wet;
        uniforms.uRain.value = surface.rain;
        uniforms.uSnowCover.value = surface.snow;
      }
      water.update(time, sky, surface);
    },
    /** Tribe territories: [{ id, centerX, centerZ, territoryRadius }] with a banner colour each. */
    setTribes(tribes, colourOf) {
      for (let k = 0; k < MAX_TRIBES; k++) {
        const t = tribes?.[k];
        const v = uniforms.uTribe[k].value;
        if (!t || !(t.territoryRadius > 0)) { v.w = 0; continue; }
        v.set(t.centerX, t.centerZ, t.territoryRadius, 1);
        uniforms.uTribeCol[k].value.setHex(colourOf(t.id));
      }
    },
    dispose() { geometry.dispose(); material.dispose(); water.dispose(); },
    tileAt: (x, z) => Math.min(size - 1, Math.max(0, x | 0)) + Math.min(size - 1, Math.max(0, z | 0)) * size,
    tileX: (i) => tileX(i, size), tileZ: (i) => tileZ(i, size),
  };
}
