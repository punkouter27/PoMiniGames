// postProcess.js — the PoEcosystem post chain (GFX options 1, 2 and 6), as a three
// RenderPipeline: one node graph that runs on WebGPU and on the WebGL2 fallback alike.
//
//   pass(scene)  →  bloom  →  ATMOSPHERE  →  output transform (ACES tone map + sRGB)
//
// The scene pass carries MSAA on the high tier (it inherits the renderer's samples), which
// is what SMAA used to clean up after; there is no separate AA pass any more. On the low
// tier there is no pipeline at all: `render()` is a plain `renderer.render()` (see the null
// facade below), which is the whole of the low-tier story.
//
// WHY ONE "ATMOSPHERE" STAGE RATHER THAN THREE
// God rays, chromatic aberration, radial blur and the vignette all work from the same
// radial basis (a screen-space vector from the pixel to either the sun or the centre), and
// all four are cheap per tap and expensive per pass. Merged, they cost one full-screen
// draw instead of four and — more importantly — stay coherent: a lightning strike smears,
// fringes and darkens the frame on one curve rather than on three that drift apart.
//
// TONE MAPPING
// The scene pass renders into a HalfFloat target with no tone mapping, so the whole chain
// runs in linear HDR and the pipeline's output transform applies `renderer.toneMapping` at
// the very end. Clipping the scene to [0,1] before the bloom bright-pass would flatten
// exactly the highlights bloom exists to find.
//
// REFRACTION AND MOOD, STILL ONE STAGE
// Everything below bends or tints the SAME full-screen draw, so it costs a few ALU ops
// per pixel and no extra render target:
//
//   HEAT       up to four screen-space heat sources (fires, lava — projected by the
//              renderer) shimmer the air ABOVE them; a drought adds a faint whole-frame
//              haze. A UV offset applied before every texture read, so the shafts, the
//              fringe and the blur all see the same bent image.
//   SHOCKWAVE  two ring slots. An eruption or a near strike sends a refracting ring out
//              from its screen position; it is the one effect that tells you WHERE an
//              off-centre blast was before the sound arrives.
//   MOOD       a second grade on top of the day/night one: season, weather and sickness
//              tint the frame, plus a saturation control the chronicle uses to drain the
//              colour out of the frame when a species dies.
//
// SCREEN UV: the renderer hands every point (sun, heat, shock) in GL convention, y up.
// The pipeline's quad uv runs y down, so the graph works in y-up space (`up`) and flips
// once, in `at()`, where it reads a texture.
import { Color, RenderPipeline, Vector2, Vector4 } from 'three-eco/webgpu';
import {
  Fn, If, Loop, abs, clamp, cos, dot, exp, float, fract, length, luminance, max, mix, pass, sin, smoothstep,
  screenUV, uniform, vec2, vec3, vec4,
} from 'three-eco/tsl';
import { bloom } from 'three-eco/addons/tsl/display/BloomNode.js';
import { punchAberration, punchRadial } from './impact.js';

// Shaft taps per tier. The cost of the atmosphere stage is dominated by this loop, so it is
// the first thing to give way — the aberration/blur/vignette terms are a handful of taps
// and stay on at every tier that runs the pipeline at all.
const SHAFT_TAPS = { high: 28, medium: 14 };

function atmosphere(u, sceneTex, bloomTex, taps) {
  return Fn(() => {
    // Anything read both inside and outside a branch is a var declared up here: a bare
    // expression first built inside an If() is cached in that branch's scope, and every
    // later read outside it would see an unassigned zero.
    const q = screenUV;
    const up = vec2(q.x, float(1).sub(q.y)).toVar('up');
    const at = (p) => vec2(p.x, float(1).sub(p.y));
    const read = (p) => sceneTex.sample(at(p)).rgb.add(bloomTex.sample(at(p)).rgb);

    // ── refraction: every term bends the UV that all the reads below use ──
    const bend = vec2(0).toVar('bend');
    for (let i = 0; i < 4; i++) {
      const h = u.uHeat[i];
      If(h.w.greaterThan(0.001), () => {
        const rel = up.sub(h.xy).div(vec2(h.z.mul(0.7).div(u.uAspect), h.z.mul(2.4)));
        // Above the source only: heat rises. Strongest just over the flame.
        const above = smoothstep(-0.15, 0.1, rel.y).mul(float(1).sub(smoothstep(0.4, 1, rel.y)));
        const m = above.mul(float(1).sub(smoothstep(0.35, 1, abs(rel.x)))).mul(h.w);
        bend.addAssign(vec2(sin(up.y.mul(160).sub(u.uTime.mul(9)).add(sin(up.x.mul(70)).mul(2))), cos(up.x.mul(130).add(u.uTime.mul(7)))).mul(0.0024).mul(m));
      });
    }
    If(u.uHaze.greaterThan(0.001), () => {
      const low = float(1).sub(smoothstep(0.2, 0.62, up.y));
      bend.addAssign(vec2(sin(up.y.mul(220).sub(u.uTime.mul(6))), 0).mul(0.0009).mul(u.uHaze).mul(low));
    });
    for (let i = 0; i < 2; i++) {
      const s = u.uShock[i];
      If(s.w.greaterThan(0.001), () => {
        const away = up.sub(s.xy).mul(vec2(u.uAspect, 1));
        const dist = length(away);
        const k = dist.sub(s.z).div(0.045);
        const ring = exp(k.mul(k).negate()).mul(s.w);
        bend.addAssign(away.div(max(dist, 1e-4)).mul(vec2(float(1).div(u.uAspect), 1)).mul(ring).mul(0.028));
      });
    }
    // Underwater: the whole frame sways on a slow swell.
    If(u.uUnder.greaterThan(0.01), () => {
      bend.addAssign(vec2(sin(up.y.mul(22).add(u.uTime.mul(2.1))), cos(up.x.mul(18).add(u.uTime.mul(1.7)))).mul(0.0038).mul(u.uUnder));
    });
    const p = up.add(bend).toVar('p');
    const toCentre = p.sub(0.5).toVar('toCentre');
    const r = length(toCentre).toVar('r');

    // Zoom blur first: it defines the base colour the fringe is split from, so a hit that
    // triggers both reads as one smeared image rather than a blur with a sharp ghost in it.
    const col = vec3(0).toVar('col');
    If(u.uRadial.greaterThan(0.001), () => {
      for (let i = 0; i < 6; i++) col.addAssign(read(p.sub(toCentre.mul(i / 5).mul(u.uRadial).mul(0.06))));
      col.mulAssign(1 / 6);
    }).Else(() => { col.assign(read(p)); });

    // Chromatic aberration scales with r, so the centre of the frame — where the player is
    // actually looking — stays clean however hard the island is shaking.
    If(u.uAberration.greaterThan(0.0001), () => {
      const off = toCentre.mul(u.uAberration).mul(r);
      col.x.assign(read(p.add(off)).x);
      col.z.assign(read(p.sub(off)).z);
    });

    // Light shafts: march toward the sun accumulating whatever is bright enough to be sky.
    // There is no occlusion buffer — the threshold IS the occlusion test, which is why the
    // terrain (dark, and darker still under its own shadow) silhouettes correctly for free.
    If(u.uShaft.greaterThan(0.001), () => {
      const delta = p.sub(u.uSun).mul(0.92 / taps);
      const tap = p.toVar('tap');
      const decay = float(1).toVar('decay');
      const shaft = vec3(0).toVar('shaft');
      Loop(taps, () => {
        tap.subAssign(delta);
        const s = sceneTex.sample(at(tap)).rgb;
        shaft.addAssign(s.mul(smoothstep(u.uThreshold, u.uThreshold.add(0.4), luminance(s))).mul(decay));
        decay.mulAssign(0.955);
      });
      col.addAssign(shaft.mul(u.uShaftTint).mul(u.uShaft.div(taps)));
    });

    col.mulAssign(float(1).sub(u.uVignette.mul(smoothstep(0.34, 0.92, r))));

    // Grade, then grain. The grade is a plain per-channel multiply — enough to make night
    // read cool and dusk warm without a LUT. The grain is a per-pixel hash reseeded every
    // frame, scaled down in the highlights so the sky does not sizzle.
    col.mulAssign(u.uGrade.mul(u.uMood));
    col.assign(mix(vec3(luminance(col)), col, u.uSaturation));
    // Water takes the red first and the edges of the frame with it.
    If(u.uUnder.greaterThan(0.01), () => {
      col.assign(mix(col, col.mul(vec3(0.3, 0.8, 0.92)).add(vec3(0, 0.025, 0.045)), u.uUnder.mul(0.88)));
      col.mulAssign(float(1).sub(u.uUnder.mul(0.4).mul(smoothstep(0.18, 0.85, r))));
    });
    If(u.uGrain.greaterThan(0.0001), () => {
      const seed = up.mul(vec2(1213, 819)).add(fract(u.uTime).mul(7.31));
      const gr = fract(sin(dot(seed, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
      col.addAssign(gr.mul(u.uGrain).mul(float(1).sub(smoothstep(0.6, 1.4, luminance(col)).mul(0.7))));
    });
    return vec4(col, 1);
  })();
}

/**
 * @param {import('three-eco/webgpu').WebGPURenderer} renderer an initialised renderer
 * @param {import('three-eco/webgpu').Scene} scene
 * @param {import('three-eco/webgpu').PerspectiveCamera} camera
 * @param {{ tier?: string, width?: number, height?: number }} opts
 * @returns a post facade; on the low tier, a null facade that draws directly.
 */
export function createPostProcess(renderer, scene, camera, { tier = 'high', width = 1, height = 1 } = {}) {
  // The null facade exists so renderer.js has exactly one code path.
  if (tier === 'low') {
    return {
      enabled: false,
      render: () => renderer.render(scene, camera),
      setSize: () => {}, setPixelRatio: () => {}, update: () => {},
      setSun: () => {}, setNight: () => {}, rack: () => {}, dispose: () => {},
      setHeat: () => {}, setHaze: () => {}, shockwave: () => {},
      setMood: () => {}, dip: () => {}, setUnderwater: () => {},
    };
  }

  const u = {
    uSun: uniform(new Vector2(0.5, 0.8)),
    uShaftTint: uniform(new Color(1, 0.94, 0.82)),
    uShaft: uniform(0),
    uThreshold: uniform(0.55),
    uAberration: uniform(0),
    uRadial: uniform(0),
    uVignette: uniform(0.26),
    uGrade: uniform(new Color(1, 1, 1)),
    uGrain: uniform(tier === 'high' ? 0.004 : 0),
    uTime: uniform(0),
    uAspect: uniform(Math.max(0.1, width / Math.max(1, height))),
    uHeat: [0, 1, 2, 3].map(() => uniform(new Vector4(0, 0, 0, 0))),   // uv.x, uv.y, radius, strength
    uHaze: uniform(0),
    uShock: [0, 1].map(() => uniform(new Vector4(0, 0, 0, 0))),        // uv.x, uv.y, radius, strength
    uMood: uniform(new Color(1, 1, 1)),
    uSaturation: uniform(1),
    uUnder: uniform(0),
  };

  // MSAA in the scene pass on the high tier only (the renderer's samples: 4 with antialias,
  // 0 on a compatibility-mode WebGPU device); medium draws one sample, as it always did.
  // `undefined` reads renderer.samples when the pass renders, i.e. after init has settled.
  const scenePass = pass(scene, camera, { samples: tier === 'high' ? undefined : 0 });
  const sceneTex = scenePass.getTextureNode('output');
  // Bloom strength is driven from setNight(): daylight needs almost none (the sky is
  // already the brightest thing on screen, and blooming it just fogs the frame), while at
  // night lava, fire and the borders are the only bright pixels and should glow.
  const bloomNode = bloom(sceneTex, 0.32, 0.72, 0.85);
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = atmosphere(u, sceneTex, bloomNode.getTextureNode(), SHAFT_TAPS[tier] ?? 14);

  // Shockwaves in flight: { x, y, age, strength }. Two slots; a third replaces the oldest.
  const shocks = [];
  const SHOCK_SECONDS = 1.1;
  // The mood grade eases toward its target so a season turning, or an outbreak taking
  // hold, reads as a drift rather than a cut; the saturation dip is the one fast move.
  const moodTarget = new Color(1, 1, 1);
  let satTarget = 1; let dipAmount = 0; let dipHold = 0;
  const NIGHT_GRADE = new Color(0.84, 0.9, 1.1);
  const DUSK_GRADE = new Color(1.08, 0.97, 0.9);
  const DAY_GRADE = new Color(1, 1, 1);

  return {
    enabled: true,
    pipeline,
    scenePass,
    bloom: bloomNode,
    render: () => pipeline.render(),
    /**
     * Per-frame. Folds the shared impact envelope (impactBus) into the atmosphere
     * uniforms. Recomputed from scratch every frame, so there is never anything to unwind.
     */
    update(dt) {
      u.uAberration.value = punchAberration(1);
      u.uRadial.value = punchRadial(0.5);
      u.uTime.value += dt;
      for (let i = shocks.length - 1; i >= 0; i--) {
        shocks[i].age += dt;
        if (shocks[i].age >= SHOCK_SECONDS) shocks.splice(i, 1);
      }
      for (let i = 0; i < 2; i++) {
        const s = shocks[i]; const v = u.uShock[i].value;
        if (!s) { v.w = 0; continue; }
        const t = s.age / SHOCK_SECONDS;
        v.set(s.x, s.y, 0.04 + t * 0.9, s.strength * (1 - t) * (1 - t));
      }
      const k = Math.min(1, dt * 0.35);
      u.uMood.value.lerp(moodTarget, k);
      if (dipHold > 0) dipHold -= dt; else dipAmount = Math.max(0, dipAmount - dt * 0.12);
      const sat = satTarget * (1 - dipAmount * 0.85);
      u.uSaturation.value += (sat - u.uSaturation.value) * Math.min(1, dt * (dipHold > 0 ? 3 : 0.8));
    },

    /** Up to four heat sources: [{ x, y, radius, strength }] in screen UV (y up); the rest cleared. */
    setHeat(list) {
      for (let i = 0; i < 4; i++) {
        const h = list?.[i]; const v = u.uHeat[i].value;
        if (!h) v.w = 0; else v.set(h.x, h.y, h.radius, h.strength);
      }
    },
    setHaze(v) { u.uHaze.value = Math.max(0, Math.min(1, v)); },
    /** A refracting ring from a screen-UV point (y up); strength 0..1. */
    shockwave(x, y, strength) {
      if (strength <= 0.02) return;
      if (shocks.length >= 2) shocks.shift();
      shocks.push({ x, y, age: 0, strength: Math.min(1, strength) });
    },
    /** 0..1: how far under the waterline the camera is (the renderer eases it). */
    setUnderwater(v) { u.uUnder.value = Math.max(0, Math.min(1, v)); },
    /**
     * Mood grade (a Color multiplier) and saturation, eased toward. `snap` jumps there: a
     * lens being switched is the viewer's own act and should answer at once.
     */
    setMood(grade, saturation = 1, snap = false) {
      moodTarget.copy(grade); satTarget = saturation;
      if (snap) { u.uMood.value.copy(grade); u.uSaturation.value = saturation; }
    },
    /** Drain the colour out of the frame for `seconds`, then let it come back slowly. */
    dip(amount = 1, seconds = 4) { dipAmount = Math.max(dipAmount, Math.min(1, amount)); dipHold = Math.max(dipHold, seconds); },

    /**
     * @param {Vector2|null} screenUv sun position in UV (y up), or null when it is behind
     *   the camera / off screen — shafts are then skipped rather than marched to a point
     *   that is not there.
     * @param {number} strength 0..1
     * @param {Color} [tint]
     */
    setSun(screenUv, strength, tint) {
      if (!screenUv || strength <= 0) { u.uShaft.value = 0; return; }
      u.uSun.value.copy(screenUv);
      u.uShaft.value = strength;
      if (tint) u.uShaftTint.value.copy(tint);
    },

    /** dayFraction-driven look: bloom, vignette and the colour grade all lean on the hour. */
    setNight(night, dusk = 0) {
      const n = Math.max(0, Math.min(1, night));
      const d = Math.max(0, Math.min(1, dusk));
      bloomNode.strength.value = 0.32 + n * 0.5;
      bloomNode.threshold.value = 0.85 - n * 0.42;     // at night, far less has to be bright to glow
      u.uVignette.value = 0.22 + n * 0.2;
      u.uGrade.value.copy(DAY_GRADE).lerp(NIGHT_GRADE, n).lerp(DUSK_GRADE, d * 0.6);
    },

    // Keep the event facade compatible without changing camera focus.
    rack() {},

    // The pass and bloom targets follow the renderer's drawing-buffer size on their own;
    // only the aspect the refraction terms correct for is ours to keep.
    setSize(w, h) { u.uAspect.value = Math.max(0.1, w / Math.max(1, h)); },
    setPixelRatio() {},
    dispose() {
      bloomNode.dispose?.();
      scenePass.dispose?.();
      pipeline.dispose();
    },
  };
}
