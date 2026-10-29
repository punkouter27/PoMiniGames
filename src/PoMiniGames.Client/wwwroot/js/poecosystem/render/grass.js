// grass.js — a field of real blades over the grass tiles (GFX pass 2, idea 2).
//
// Until this the grass was a vertex colour: green where the biomass was high, straw where
// the rabbits had grazed it. That colour is still the ground under the blades; what this
// adds is height. A grazed meadow is now visibly SHORTER, a storm lays it over, and a herd
// walking through leaves a flattened wake (the FRESH channel of trails.js).
//
// ZERO CPU PER FRAME
// Every blade is one instance of a seven-vertex strip, placed in a square patch that rides
// the camera. The patch is not re-seeded as the god moves: each blade's world position is
// `camera + mod(seed - camera, patch)`, so a blade stays put in the world and simply
// wraps to the far side when the camera has moved a patch-width past it. The heightmap,
// the biomass mask and the trail texture are all sampled in the vertex shader. The CPU
// touches this module only on a tile sync (1 Hz), to repack the biomass mask.
//
// WHY A NODE LAMBERT RATHER THAN A HAND-ROLLED MATERIAL
// The blades have to sit in the ground they grow out of. A hand-rolled lighting model is
// always slightly wrong against the terrain's Lambert at some hour of the day, and the seam
// is exactly where the eye looks. GrassMaterial is a MeshLambertNodeMaterial with its own
// vertex stage (positionNode), so it gets the same lights, fog, shadows and tone mapping
// for free, on WebGPU and the WebGL2 fallback alike. The normal is forced to world-up so a
// blade is lit like the ground under it rather than like a vertical card.
//
// Low tier: not built at all.
import { Color, DataTexture, DoubleSide, Float32BufferAttribute, FloatType, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, MeshLambertNodeMaterial, NearestFilter, RedFormat, UnsignedByteType, Vector2, Vector3 } from 'three-eco/webgpu';
import {
  attribute, cameraPosition, cameraViewMatrix, clamp, cos, diffuseColor, dot, float, floor, ivec2, length, mix, mod,
  normalize, positionGeometry, positionWorld, pow, sin, smoothstep, step, texture, textureLoad, uniform, varying, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { cloudLight, materialClock, materialSeason, materialSnow } from './materials.js';
import { trailUniforms } from './trails.js';

const TIER = {
  high: { blades: 56000, patch: 64 },
  medium: { blades: 22000, patch: 46 },
};

// Strip profile: t (0 base → 1 tip) and side (-0.5 / +0.5). Three rungs and a tip.
const RUNGS = [0, 0.38, 0.72];

function bladeGeometry(count) {
  const positions = [];
  for (const t of RUNGS) positions.push(-0.5, t, 0, 0.5, t, 0);
  positions.push(0, 1, 0);
  const index = [];
  for (let r = 0; r < RUNGS.length - 1; r++) {
    const a = r * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const top = (RUNGS.length - 1) * 2;
  index.push(top, top + 1, top + 2);

  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  // Seeds are stratified on a jittered grid rather than pure random: pure random clumps,
  // and a clumped meadow reads as patchy at exactly the distance the blades are visible.
  const seeds = new Float32Array(count * 3);
  const side = Math.ceil(Math.sqrt(count));
  let s = 0x9e3779b9;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  for (let i = 0; i < count; i++) {
    const gx = i % side; const gz = Math.floor(i / side);
    seeds[i * 3] = (gx + rand()) / side;
    seeds[i * 3 + 1] = (gz + rand()) / side;
    seeds[i * 3 + 2] = rand();
  }
  geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 3));
  geo.instanceCount = count;
  return geo;
}

/**
 * The blade material: a node Lambert whose vertex stage places, sizes and bends every blade
 * from the patch seed, the heightmap, the biomass mask and the trail texture, with the
 * normal seated on world-up (a blade is lit like the ground it stands on) and a
 * translucency term added after the lighting sum.
 */
class GrassMaterial extends MeshLambertNodeMaterial {
  constructor(u, heightTex, maskTex) {
    super({ side: DoubleSide });
    this.u = u;
    this.ecoKey = 'grass';
    const seed = attribute('aSeed', 'vec3');
    const patch = vec2(u.uPatch);
    const seedPos = seed.xy.mul(u.uPatch);
    const wp = u.uCam.add(mod(seedPos.sub(u.uCam).add(patch.mul(0.5)), patch)).sub(patch.mul(0.5));
    const rnd = seed.z;
    const camDist = length(wp.sub(u.uCam));
    // Fade to nothing well inside the patch edge, so the wrap never shows as a line.
    const fade = float(1).sub(smoothstep(u.uPatch.mul(0.28), u.uPatch.mul(0.47), camDist));
    const muv = wp.div(u.uSize);
    const inside = step(0, muv.x).mul(step(muv.x, 1)).mul(step(0, muv.y)).mul(step(muv.y, 1));
    const biomass = texture(maskTex, muv).level(0).r.mul(inside);
    const tr = trailUniforms.uTrail.sample(wp.div(trailUniforms.uTrailSpan)).level(0).rg;
    const bladeH = rnd.mul(0.46).add(0.2).mul(smoothstep(0.06, 0.55, biomass)).mul(fade)
      .mul(float(1).sub(tr.x.mul(0.8))).mul(float(1).sub(clamp(materialSnow, 0, 1).mul(0.92)));
    const t = positionGeometry.y;
    const width = rnd.mul(0.6).add(0.7).mul(0.06).mul(float(1).sub(t.mul(0.85))).mul(step(0.02, bladeH));
    const yaw = rnd.mul(43);
    const across = vec2(cos(yaw), sin(yaw));
    const phase = materialClock.mul(rnd.mul(0.7).add(1.3)).add(wp.x.mul(0.35)).add(wp.y.mul(0.21));
    // A slow travelling gust front: the field moves in waves, not in unison.
    const gust = sin(materialClock.mul(0.6).add(wp.x.mul(0.07)).sub(wp.y.mul(0.05))).mul(0.45).add(0.55);
    const sway = u.uWind.mul(sin(phase).mul(0.55).add(0.45)).mul(gust).add(vec2(sin(phase.mul(1.3)), cos(phase.mul(0.9))).mul(0.03));
    // Trample: fresh tracks lay the blade down along its own facing.
    const laid = tr.y;
    const lay = vec2(across.y.negate(), across.x).mul(laid).mul(0.8);
    const bend = sway.add(lay).mul(t).mul(t).mul(bladeH).mul(2.4);
    const rise = t.mul(bladeH).mul(float(1).sub(laid.mul(0.7)));
    const transformed = vec3(
      wp.x.add(across.x.mul(positionGeometry.x).mul(width)).add(bend.x),
      heightAt(heightTex, wp, u.uSize).sub(0.03).add(rise),
      wp.y.add(across.y.mul(positionGeometry.x).mul(width)).add(bend.y),
    );
    this.positionNode = transformed;
    let tint = mix(u.uDry, u.uGreen, clamp(biomass.mul(1.2), 0, 1)).mul(rnd.mul(0.36).add(0.82));
    const autumn = step(1.5, materialSeason).mul(step(materialSeason, 2.5));
    tint = mix(tint, tint.mul(vec3(1.22, 0.86, 0.5)), autumn);
    this.colorNode = varying(tint.mul(mix(0.5, 1.18, t)).mul(cloudLight(transformed)), 'vGrassCol');
    this.bladeT = varying(t, 'vBladeT');
    // DoubleSide would flip the normal on the back face and light the far side of every
    // blade as if it faced the ground: seat it on world-up, in view space.
    this.normalNode = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  }

  customProgramCacheKey() { return super.customProgramCacheKey() + this.ecoKey; }

  setupLighting(builder) {
    const out = super.setupLighting(builder);
    // Translucency: a low sun behind the field lights the tips — the one term that makes
    // grass read as grass rather than green fur.
    const toFrag = normalize(positionWorld.sub(cameraPosition));
    const backlit = pow(clamp(dot(toFrag, normalize(this.u.uSunDir)), 0, 1), 3);
    return out.add(this.u.uSunCol.mul(diffuseColor.rgb).mul(backlit).mul(this.bladeT).mul(0.35));
  }
}

/** Bilinear height from the corner heightmap, with texel loads (the R32F map is unfilterable). */
function heightAt(heightTex, p, size) {
  const q = clamp(p, vec2(0), vec2(size.sub(0.001)));
  const i = ivec2(floor(q));
  const f = q.sub(floor(q));
  const h00 = textureLoad(heightTex, i).r;
  const h10 = textureLoad(heightTex, i.add(ivec2(1, 0))).r;
  const h01 = textureLoad(heightTex, i.add(ivec2(0, 1))).r;
  const h11 = textureLoad(heightTex, i.add(ivec2(1, 1))).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

export function createGrass(scene, terrain, { tier = 'high' } = {}) {
  const cfg = TIER[tier];
  if (!cfg) return null;
  const { size } = terrain;
  const cs = size + 1;

  const heights = new Float32Array(cs * cs);
  for (let i = 0; i < heights.length; i++) heights[i] = terrain.height[i];
  const heightTex = new DataTexture(heights, cs, cs, RedFormat, FloatType);
  heightTex.minFilter = heightTex.magFilter = NearestFilter;
  heightTex.unpackAlignment = 1;
  heightTex.needsUpdate = true;

  const mask = new Uint8Array(size * size);
  const maskTex = new DataTexture(mask, size, size, RedFormat, UnsignedByteType);
  maskTex.minFilter = maskTex.magFilter = LinearFilter;
  maskTex.unpackAlignment = 1;
  maskTex.needsUpdate = true;

  const uniforms = {
    uCam: uniform(new Vector2(size / 2, size / 2)),
    uPatch: uniform(cfg.patch),
    uWind: uniform(new Vector2(0.08, 0.03)),
    uSize: uniform(size),
    uGreen: uniform(new Color(0x5a9434)),
    uDry: uniform(new Color(0x9a8c52)),
    uSunDir: uniform(new Vector3(0, 1, 0)),
    uSunCol: uniform(new Color(0xfff2df)),
  };

  const material = new GrassMaterial(uniforms, heightTex, maskTex);

  const geometry = bladeGeometry(cfg.blades);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;       // positions are made in the shader; the box is meaningless
  mesh.receiveShadow = true;
  mesh.name = 'grass';
  scene.add(mesh);

  const windAngle = { value: 0.6 };

  return {
    mesh,
    /** Tile sync: repack biomass onto the tiles that can carry a meadow. */
    setTiles(tileState, grass) {
      if (!grass) return;
      for (let t = 0; t < mask.length; t++) {
        const type = terrain.type[t];
        const state = tileState ? tileState[t] : 0;
        const meadow = type === TILE.GRASS ? 1 : type === TILE.HILL ? 0.7 : 0;
        const open = state === TILE_STATE.NORMAL || state === TILE_STATE.FENCE;
        mask[t] = meadow && open ? grass[t] * meadow : 0;
      }
      maskTex.needsUpdate = true;
    },
    /** Per frame: the patch follows the camera; wind is 0..1 (calm → gale); sky lights the backlit tips. */
    update(dt, player, wind, sky = null) {
      uniforms.uCam.value.set(player.x, player.z);
      if (sky) { uniforms.uSunDir.value.copy(sky.sunDir); uniforms.uSunCol.value.copy(sky.sunColour); }
      // The wind veers slowly; a gale holds its direction better than a breeze.
      windAngle.value += dt * 0.012;
      const strength = 0.06 + wind * 0.34;
      uniforms.uWind.value.set(Math.cos(windAngle.value) * strength, Math.sin(windAngle.value) * strength);
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose(); material.dispose(); heightTex.dispose(); maskTex.dispose();
    },
  };
}
