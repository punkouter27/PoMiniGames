// lighting.js — sun, sky, atmosphere and the day/night cycle (120 s per cycle).
// The shadow camera follows the player, so a 2048 map covers the ~80 m the god can
// actually see rather than the whole 200 m island (the trick from povoxelstrike/game.js).
//
// Publishes the sun and fog settings shared by water and post-processing.
//
// MIST. The haze is one density everywhere. On top of it, at dawn and after rain, mist lies
// in the LOW GROUND: thick where a point is below the land around it (hollows, lake basins,
// the shore), thinning to nothing up the slopes, so the hills stand out of it. It is a term
// in the scene's own fog (a fog node: every fogged surface gets it for nothing, on either
// backend, with no extra pass and no depth buffer to read), and it is tied to the ground.
// A mist PLANE that followed the camera was tried and removed, because its patches hid the
// island; this one is thin, low, brief, capped well short of opaque, and the renderer
// thins it further while a creature is being followed or inspected.
//
// HIGH TIER ON WEBGPU (`twoMaps`): the sun casts through two maps instead of one
// (shadows.js): a sharp one for the ground in front of the camera and this module's
// whole-island one for the rest.
import { AmbientLight, ClampToEdgeWrapping, Color, DataTexture, DirectionalLight, HemisphereLight, LinearFilter, RedFormat, UnsignedByteType, Vector3 } from 'three-eco/webgpu';
import { cameraPosition, clamp, densityFogFactor, exp, float, fog as sceneFog, length, max, mix, positionWorld, smoothstep, texture, uniform } from 'three-eco/tsl';
import { createIslandShadow } from './shadows.js';
import { VIEW_ONLY_LAYER, materialWind, vnoise } from './materials.js';

const SHADOW_HALF = 120; // Encloses the full 200m island (plus margins) to eliminate frustum clipping lines
// Night is deliberately mild — the sky darkens slightly and the
// sun dims, but light floors stay high enough that creatures and terrain remain clearly
// observable around the clock. The scene must never become a dark screen.
const DAY_SKY = new Color(0x8ec5ff);
const NIGHT_SKY = new Color(0x2a3c5a);
const DUSK_SKY = new Color(0xf59e0b);
const DAY_SUN = new Color(0xfff2df);
const NIGHT_SUN = new Color(0x9db4d8);
// A closed storm deck greys the sky and the haze together (weather).
const OVERCAST_SKY = new Color(0x7d8894);
// Mist: the height it thins over, how thick it is at its thickest, the most of the frame it
// may ever take, and the grid its "land around here" map is kept on.
const MIST_HEIGHT = 3.4;
const MIST_DENSITY = 0.022;
const MIST_CAP = 0.5;
const MIST_REACH = 130;           // metres of mist a ray can cross: past this it gets no thicker
const MIST_CELL = 4;
const MIST_BLUR = 5;             // cells either side: the land within about 20 m
const MIST_LOW = -4; const MIST_SPAN = 51;   // metres the byte map covers: -4 .. 47
const MIST_WHITE = new Color(0xe9eef2);

export function createLighting(scene, { shadows = true, shadowMapSize = 2048, twoMaps = false, mist = true } = {}) {
  const hemi = new HemisphereLight(0xbfd4ff, 0x2f3a2a, 1.1);
  const ambient = new AmbientLight(0xc8d4e8, 0.35);
  const sun = new DirectionalLight(0xfff2df, 2.0);
  sun.castShadow = shadows;
  if (shadows) {
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.camera.left = -SHADOW_HALF; sun.shadow.camera.right = SHADOW_HALF;
    sun.shadow.camera.top = SHADOW_HALF; sun.shadow.camera.bottom = -SHADOW_HALF;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 420;
    sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.04;
    // Node shadows filter with PCF; the radius is what softens the edge now that the
    // separate soft-PCF mode is gone.
    sun.shadow.radius = 2;
  }
  // Built from the sun's shadow as it stands here, so it comes after the block above.
  const csm = shadows && twoMaps ? createIslandShadow(sun) : null;
  // The lights belong to the main view alone: the occlusion pass wants depth, not shading.
  for (const light of [hemi, ambient, sun]) light.layers.set(VIEW_ONLY_LAYER);
  scene.add(hemi, ambient, sun, sun.target);

  // The fog is owned here rather than by the renderer: its colour and density both track
  // the same `elevation` the sun does, and splitting that across two files is how a sky
  // and its haze end up disagreeing about what time it is.
  //
  // It is a fog NODE rather than a FogExp2 so the mist can be a term of it. `fog` keeps the
  // shape the renderer already writes to (a colour and a density, which it bends when the
  // camera goes under water): the node reads the same two values.
  const uFogColor = uniform(new Color(DAY_SKY));
  const uFogDensity = uniform(0.0045);
  const uMist = uniform(0);
  const uMistColor = uniform(new Color(MIST_WHITE));
  const uMistTime = uniform(0);
  const uMistSize = uniform(200);
  const fog = {
    color: uFogColor.value,
    get density() { return uFogDensity.value; },
    set density(v) { uFogDensity.value = v; },
  };
  // The land around each point, blurred: what a hollow is lower than. One byte a cell.
  let mistTex = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat, UnsignedByteType);
  mistTex.needsUpdate = true;
  const mistMap = texture(mistTex);
  const haze = densityFogFactor(uFogDensity);
  if (mist) {
    const P = positionWorld;
    const muv = P.xz.div(uMistSize);
    const around = mistMap.sample(clamp(muv, 0, 1)).r.mul(MIST_SPAN).add(MIST_LOW);
    // The island's mist, not the ocean's: it thins to nothing toward the edge of the map,
    // so the open sea keeps its horizon.
    const island = smoothstep(0, 0.1, muv.x).mul(smoothstep(0, 0.1, muv.y)).mul(float(1).sub(smoothstep(0.9, 1, muv.x))).mul(float(1).sub(smoothstep(0.9, 1, muv.y)));
    // 1 in a hollow, falling away with height above the land round about (a metre of grace).
    const low = exp(max(P.y.sub(around.sub(1)), 0).div(-MIST_HEIGHT)).mul(island);
    const toP = P.sub(cameraPosition);
    const far = length(toP);
    // The mist is a layer: a ray that looks down through it crosses little of it.
    const through = far.min(float(MIST_HEIGHT * 2.6).div(max(toP.y.abs().div(max(far, 1e-3)), 0.035))).min(MIST_REACH);
    // Drifting, broken: it moves down the wind and has gaps in it.
    const drift = P.xz.mul(0.04).sub(materialWind.mul(uMistTime.mul(0.6)));
    const broken = smoothstep(0.22, 0.7, vnoise(drift).mul(0.65).add(vnoise(drift.mul(2.7).add(4.1)).mul(0.35))).mul(1.25);
    const mistF = float(1).sub(exp(low.mul(through).mul(broken).mul(uMist).mul(-MIST_DENSITY))).mul(MIST_CAP);
    const total = float(1).sub(float(1).sub(haze).mul(float(1).sub(mistF)));
    // Mist is whiter than haze: the colour is each one's share of what is in the way.
    scene.fogNode = sceneFog(mix(uFogColor, uMistColor, mistF.div(max(total, 1e-4)).clamp(0, 1)), total);
  } else scene.fogNode = sceneFog(uFogColor, haze);
  let mistNow = 0; let mistTarget = 0;

  const islandCenter = new Vector3(100, 0, 100);
  const sky = new Color();
  const sunColour = new Color();
  const sunDir = new Vector3(0, 1, 0);
  // Reused so update() allocates nothing at 60 fps — it is called every frame.
  const info = { sky, sunColour, sunDir, night: 0, day: 1, dusk: 0, fogDensity: 0.0045 };

  return {
    sun, hemi, ambient, fog, csm,

    /** Every shadow the sun casts through (one map, or the two of the high tier). */
    get shadows() { return csm?.lights?.length ? [sun.shadow, ...csm.lights.map(l => l.shadow)] : [sun.shadow]; },

    /** The camera's projection changed (resize, field of view): the cascades are cut from it. */
    cameraChanged() { if (csm?.camera) csm.updateFrustums(); },

    /**
     * The island's ground, for the mist: `terrain` is the renderer's ({ size, heightAt }).
     * Each cell of the map is the mean height of the land within about twenty metres.
     */
    setTerrain(terrain) {
      if (!mist || !terrain?.size) return;
      const size = terrain.size; const side = Math.ceil(size / MIST_CELL) + 1;
      const h = new Float32Array(side * side);
      for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) h[z * side + x] = Math.max(MIST_LOW, terrain.heightAt(Math.min(size, x * MIST_CELL), Math.min(size, z * MIST_CELL)));
      // A box blur in two passes.
      const pass = (src, dx, dz) => {
        const out = new Float32Array(side * side);
        for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
          let sum = 0; let n = 0;
          for (let k = -MIST_BLUR; k <= MIST_BLUR; k++) {
            const sx = x + dx * k; const sz = z + dz * k;
            if (sx < 0 || sz < 0 || sx >= side || sz >= side) continue;
            sum += src[sz * side + sx]; n++;
          }
          out[z * side + x] = sum / n;
        }
        return out;
      };
      const blurred = pass(pass(h, 1, 0), 0, 1);
      const bytes = new Uint8Array(side * side);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(((blurred[i] - MIST_LOW) / MIST_SPAN) * 255)));
      const next = new DataTexture(bytes, side, side, RedFormat, UnsignedByteType);
      next.minFilter = LinearFilter; next.magFilter = LinearFilter;
      next.wrapS = ClampToEdgeWrapping; next.wrapT = ClampToEdgeWrapping;
      next.unpackAlignment = 1;
      next.needsUpdate = true;
      mistMap.value = next;
      mistTex.dispose();
      mistTex = next;
      // The map's last cell sits on the island's far edge.
      uMistSize.value = (side - 1) * MIST_CELL;
    },
    /** How much mist the low ground should hold, 0..1 (the renderer decides; this eases to it). */
    setMist(amount) { mistTarget = Math.max(0, Math.min(1, amount)); },
    get mist() { return mistNow; },

    setWorldSize(size) {
      if (!size || size <= 0) return;
      islandCenter.set(size / 2, 0, size / 2);
      if (sun.shadow?.camera) {
        const half = size * 0.6;
        sun.shadow.camera.left = -half;
        sun.shadow.camera.right = half;
        sun.shadow.camera.top = half;
        sun.shadow.camera.bottom = -half;
        sun.shadow.camera.updateProjectionMatrix();
        csm?.islandChanged();
      }
    },

    /**
     * dayFraction 0..1 (0 = midnight). Returns the shared sky description: the renderer
     * uses `sky` for the clear colour, the water shader takes the sun and the night
     * factor, and the god-ray pass takes the sun's world position off `sun`.
     */
    update(dayFraction, player, time = 0, overcast = 0, moonlight = 0.5) {
      const angle = (dayFraction - 0.25) * Math.PI * 2;      // 0.25 = sunrise
      const elevation = Math.sin(angle);
      const dist = 180;
      sun.position.set(islandCenter.x + Math.cos(angle) * dist, Math.max(12, elevation * dist), islandCenter.z + 60);
      sun.target.position.set(islandCenter.x, 0, islandCenter.z);
      sun.target.updateMatrixWorld();
      sunDir.set(sun.position.x - islandCenter.x, sun.position.y, sun.position.z - islandCenter.z).normalize();

      const day = Math.max(0, elevation);
      const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);  // brief warm band at the horizon
      const night = 1 - day;
      sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.5).lerp(OVERCAST_SKY, overcast * 0.55);
      sunColour.copy(NIGHT_SUN).lerp(DAY_SUN, day);
      sun.color.copy(sunColour);
      // Cloud cover takes the sun first and the sky light barely: under a storm the island
      // goes flat and grey, never dark (the night floor rule above still holds).
      // The night's light follows the moon (0 none up, 1 a full one high), a little: a new
      // moon is a darker night, never a dark screen (the floor rule above).
      const moonK = 0.86 + 0.2 * Math.max(0, Math.min(1, moonlight));
      const nightK = 1 + (moonK - 1) * night;
      sun.intensity = (0.55 + day * 1.6) * (1 - 0.5 * overcast) * nightK;
      hemi.intensity = (0.55 + day * 0.6) * (1 + (moonK - 1) * night * 0.6);
      ambient.intensity = 0.34 + day * 0.12;

      // Haze thickens at both ends of the day. The dusk term dominates because that is
      // when the shafts are longest and the fog is what they scatter through.
      fog.density = 0.0040 + dusk * 0.0085 + night * 0.0035 + overcast * 0.0055;
      fog.color.copy(sky);
      // Mist gathers and lifts over half a minute, never in a blink.
      mistNow += (mistTarget - mistNow) * 0.004;
      if (mistNow < 0.002 && mistTarget === 0) mistNow = 0;
      uMist.value = mistNow;
      uMistTime.value = time;
      uMistColor.value.copy(MIST_WHITE).lerp(sunColour, 0.25).lerp(sky, 0.3 + night * 0.4);

      info.night = night; info.day = day; info.dusk = dusk; info.fogDensity = fog.density;
      return info;
    },

    dispose() {
      csm?.dispose();
      scene.remove(hemi, ambient, sun, sun.target);
      sun.dispose?.();
      scene.fogNode = null;
      mistTex.dispose();
    },
  };
}
