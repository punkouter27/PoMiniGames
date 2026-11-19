// postShader.js — the CA / vignette / radial-blur / broadcast-grade stage, as a TSL node.
// `_buildComposer` (sceneSetup.js) puts it last in the RenderPipeline, before the output
// transform, so it works on the linear HDR frame on WebGPU and on the WebGL2 backend alike.
//
// uCA and uRadial are pulsed by hits and the KO flash; uDesat rides the KO lights-down blend
// (drains color, keeps the reds); the teal-shadow / warm-highlight grade and vignette are
// constant. Every optional layer sits behind a uniform-only branch, so an idle effect costs
// one comparison.
//
// THE UNIFORM BAG. The engine writes plain `{ value }` slots, and vectors as arrays
// (`u.uShockC.value[0] = x`, `color.toArray(u.uInkA.value)`), exactly as it did when this was
// a ShaderPass. `sync()` copies the bag onto the node uniforms once per frame.
//
// SCREEN UV. Every point the engine hands over (shock centre, ink focus, smear centre) is in
// GL convention, y up. The pipeline's screenUV runs y down, so the graph works in y-up space
// and flips once, in `at()`, where it reads the frame.
import { Vector2, Vector3 } from 'three-eco/webgpu';
import {
  Fn, If, Loop, abs, atan, clamp, dot, exp, float, floor, fract, length, max, mix, mod, pow,
  screenUV, select, smoothstep, sqrt, uniform, vec2, vec3, vec4,
} from 'three-eco/tsl';

/** The engine-facing uniform bag: plain values and arrays, the defaults the look was tuned at. */
export function createFxUniforms() {
  return {
    uCA: { value: 0 },
    uVignette: { value: 0.5 },
    uRadial: { value: 0 },
    uGrade: { value: 1.0 },
    uDesat: { value: 0 },
    // Film grain amount (0 = off, branch skipped). Kept off: weighted into the
    // shadows, it reads as a crawling cross-hatch over the dark suits and hall.
    // uTime drives the per-frame hash.
    uGrain: { value: 0.0 },
    uTime: { value: 0 },
    // uGodrays     : intensity (0 = off). Drives the spotlight blade.
    // uGodraysOrig : screen-space origin of the shaft in UV (default 0.5,1.05 — top edge).
    // uGodraysDecay: per-step exponential falloff for the marching sample.
    // uGodraysTint : godray tint (warm yellow during KO).
    uGodrays: { value: 0 },
    uGodraysOrig: { value: [0.5, 1.05] },
    uGodraysDecay: { value: 0.94 },
    uGodraysTint: { value: [1.0, 0.94, 0.78] },
    // Radial manga speedlines, masked away from the frame centre so the
    // fighters are never behind them. 0 = off (branch skipped). Held up
    // through the super cinematic.
    uSpeed: { value: 0 },
    uSpeedTint: { value: [1.0, 0.97, 0.88] },
    // Danger edge: red tint from the screen edge on the SIDE of a fighter near
    // a KO (0..1 each), pulsing on game.js's heartbeat. Edge-only and capped
    // short of opaque so it is never a whole-frame luminance change. Calm mode
    // pins uHeart at a constant.
    uDangerL: { value: 0 },
    uDangerR: { value: 0 },
    uHeart: { value: 0 },
    // uShock    : ring strength (0 = off). A screen-space refraction ring racing
    //             out from uShockC (UV) to radius uShockR (in frame heights).
    //             It moves pixels, never brightens them.
    // uComic    : 0..1 halftone print + ink + posterise, the KO panel only.
    // uRewind   : 0..1 VHS tracking wobble + scanlines, under the rematch splash.
    // uAspect / uRes : frame shape, set per frame by game.js.
    uShock: { value: 0 },
    uShockC: { value: [0.5, 0.5] },
    uShockR: { value: 0 },
    uAspect: { value: 1.6 },
    uRes: { value: [1280, 720] },
    uComic: { value: 0 },
    uRewind: { value: 0 },
    // Online rollback smear (netplay.js): when a correction moves a fighter, its channels split
    // along the move for 2-3 frames, so a re-simulated position reads as a dash, not a pop.
    // uNetSmear  : strength (0 = off, branch skipped)
    // uNetSmearC : the fighter's centre (UV); uNetSmearR: blob radius (frame heights)
    // uNetSmearDir: the move's screen direction (UV, unit)
    // It moves samples, never brightens them.
    uNetSmear: { value: 0 },
    uNetSmearC: { value: [0.5, 0.5] },
    uNetSmearR: { value: 0.18 },
    uNetSmearDir: { value: [1, 0] },
    // Super-move comic-ink world shift (personalityEffects.js): for ~1 s while a signature super
    // fires, the frame prints as a two-tone comic page in the president's colours — luminance
    // kept per pixel, Ben-Day dots, paper grain, thick ink edges, radial speed lines.
    // uSuperInk : 0..1 blend, eased in and out by the caller (never a step)
    // uInkA/B   : shadow / highlight tones (linear RGB)
    // uInkC     : speed-line focus (UV) — the firing fighter
    // uInkCheap : 1 on the low tier — no edge taps, no grain
    // uInkMotion: 0 under reduced motion — still lines, no grain crawl
    uSuperInk: { value: 0 },
    uInkA: { value: [0.05, 0.06, 0.12] },
    uInkB: { value: [0.9, 0.8, 0.6] },
    uInkC: { value: [0.5, 0.5] },
    uInkCheap: { value: 0 },
    uInkMotion: { value: 1 },
  };
}

// Cheap hash for the grain and the lane picks — no texture fetch.
const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
});

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const LW = vec3(0.299, 0.587, 0.114);
const sq = (x) => x.mul(x);
const gammaOut = (c) => pow(max(c, vec3(0)), vec3(0.4545));

/**
 * The stage's uniforms plus `build(tex)`, which lays the stage over a texture node holding the
 * linear HDR frame. The pipeline builds one output per transient-pass combination (see
 * sceneSetup.js), and every one of them shares these uniforms.
 * @returns {{ uniforms: object, sync: () => void, build: (tex: object) => object }}
 */
export function createFxStage() {
  const bag = createFxUniforms();
  // One node uniform per slot, typed from the default's shape.
  const U = {};
  for (const [key, slot] of Object.entries(bag)) {
    const v = slot.value;
    U[key] = Array.isArray(v)
      ? uniform(v.length === 2 ? new Vector2(v[0], v[1]) : new Vector3(v[0], v[1], v[2]))
      : uniform(v);
  }
  const sync = () => {
    for (const key in bag) {
      const v = bag[key].value, n = U[key];
      if (typeof v === 'number') n.value = v;
      else if (v.length === 2) n.value.set(v[0], v[1]);
      else n.value.set(v[0], v[1], v[2]);
    }
  };
  return { uniforms: bag, sync, build: (tex) => buildFx(U, tex) };
}

function buildFx(U, tex) {
  const at = (p) => tex.sample(vec2(p.x, p.y.oneMinus()));
  const sqrtLuma = (p) => sqrt(max(dot(at(p).rgb, LW), 0));

  return Fn(() => {
    // Anything read both inside and outside a branch is a var declared up here: an
    // expression first built inside an If() is scoped to that branch.
    const vUv = vec2(screenUV.x, screenUV.y.oneMinus()).toVar();
    const uv = vUv.toVar();
    const ca = float(U.uCA).toVar();
    const aspect2 = vec2(U.uAspect, 1);

    // Tape rewind: each scanline band slides sideways on its own hash, and a
    // tracking band rolls up the frame. Displacement only.
    If(U.uRewind.greaterThan(0.003), () => {
      const band = floor(uv.y.mul(90));
      uv.x.addAssign(hash21(vec2(band, floor(U.uTime.mul(30)))).sub(0.5).mul(0.018).mul(U.uRewind));
      const roll = fract(U.uTime.mul(1.7));
      uv.x.addAssign(exp(sq(uv.y.sub(roll).mul(22)).negate()).mul(0.03).mul(U.uRewind));
      ca.addAssign(U.uRewind.mul(1.2));
    });

    // Shockwave: a gaussian ring pushes pixels outward; its edge also splits
    // the channels, so the ring reads as a lens being struck.
    If(U.uShock.greaterThan(0.003), () => {
      const sd = uv.sub(U.uShockC).mul(aspect2).toVar();
      const sdist = length(sd).toVar();
      const ring = exp(sq(sdist.sub(U.uShockR).mul(16)).negate()).mul(U.uShock).toVar();
      uv.subAssign(sd.div(max(sdist, 1e-4)).mul(vec2(float(1).div(U.uAspect), 1)).mul(ring).mul(0.035));
      ca.addAssign(ring.mul(3));
    });

    // Rollback smear: a gaussian blob around one fighter whose red channel is pulled back
    // along the correction and blue pushed ahead — the same split the global CA does, but
    // directional and local. Displacement only, so brightness holds.
    const smear = vec2(0).toVar();
    If(U.uNetSmear.greaterThan(0.003), () => {
      const nd = uv.sub(U.uNetSmearC).mul(aspect2).toVar();
      const nm = exp(dot(nd, nd).negate().div(max(sq(U.uNetSmearR), 1e-4))).mul(U.uNetSmear);
      smear.assign(U.uNetSmearDir.mul(nm).mul(0.022));
    });

    const off = uv.sub(0.5).mul(ca).mul(0.012).toVar();
    const col = vec3(
      at(uv.add(off).sub(smear)).r,
      at(uv.sub(smear.mul(0.35))).g,
      at(uv.sub(off).add(smear.mul(0.5))).b,
    ).toVar();

    // Radial impact blur: a short streak toward the frame center. 4 extra
    // taps is enough at pulse strengths — it reads as a punch, not a filter.
    If(U.uRadial.greaterThan(0.003), () => {
      const dir = vec2(0.5).sub(uv).mul(U.uRadial).mul(0.05).toVar();
      const acc = vec3(col).toVar();
      acc.addAssign(at(uv.add(dir)).rgb);
      acc.addAssign(at(uv.add(dir.mul(2))).rgb);
      acc.addAssign(at(uv.add(dir.mul(3))).rgb);
      acc.addAssign(at(uv.add(dir.mul(4))).rgb);
      col.assign(acc.mul(0.2));
    });

    // Godrays: sample along a line from each pixel toward the spotlight origin
    // (projected to screen space by the JS side). Each tap decays by
    // uGodraysDecay, so bright pixels near the origin smear outward as
    // the blade of light. 16 taps is cheap and reads as proper cinema.
    If(U.uGodrays.greaterThan(0.003), () => {
      const dir = U.uGodraysOrig.sub(vUv).div(16).toVar();
      const weight = float(0).toVar();
      const acc = vec3(0).toVar();
      const w = float(1).toVar();
      const p = vec2(vUv).toVar();
      Loop(16, () => {
        p.addAssign(dir);
        const s = at(p).rgb.toVar();
        // Threshold the sample so the lit pixels (spotlight + ring trim)
        // contribute most; the dim arena walls contribute little.
        const mask = smoothstep(0.78, 1.05, max(max(s.r, s.g), s.b));
        acc.addAssign(s.mul(w).mul(mask));
        weight.addAssign(w.mul(mask));
        w.mulAssign(U.uGodraysDecay);
      });
      If(weight.greaterThan(0.0001), () => {
        col.addAssign(acc.div(weight).mul(U.uGodrays).mul(U.uGodraysTint));
      });
    });

    // Speedlines: radial streaks fanning out from the frame centre. The
    // angle is quantised into lanes, each lane hashed for its own brightness
    // and phase, so the fan is irregular the way an inked one is rather than
    // a clean starburst. Added BEFORE the grade so the grade's shoulder rolls
    // the hot ends of the lines off instead of leaving them clipped white.
    If(U.uSpeed.greaterThan(0.003), () => {
      const sd = vUv.sub(0.5).toVar();
      const srad = length(sd).mul(2);
      const sang = atan(sd.y, sd.x).mul(0.15915494).add(0.5);   // 0..1
      const lane = floor(sang.mul(110));
      const n = hash21(vec2(lane, 3)).toVar();
      // ~40% of lanes carry a line; the rest stay empty so the fan breathes.
      const streak = smoothstep(0.58, 0.98, n);
      // Nothing inside 0.3 of centre (that is where the fighters are) and
      // nothing past the corners, so the lines read as framing, not overlay.
      const radMask = smoothstep(0.30, 0.92, srad).mul(smoothstep(1.24, 1.72, srad).oneMinus());
      // Each lane drifts outward on its own phase — static lines read as a
      // texture laid over the frame instead of speed through it.
      const phase = fract(n.mul(13).add(U.uTime.mul(2.4)));
      col.addAssign(U.uSpeedTint.mul(streak).mul(radMask).mul(U.uSpeed).mul(phase.mul(0.70).add(0.30)));
    });

    // Broadcast grade: teal-pushed shadows, warm highlights, +saturation. Saturation is the
    // lever that keeps the hall looking painted rather than washed out — it costs no contrast,
    // unlike exposure, and it is the one number to raise for a brighter, more vibrant frame.
    const lum = dot(col, LUMA).toVar();
    col.addAssign(vec3(0.005, 0.013, 0.026).mul(smoothstep(0.0, 0.4, lum).oneMinus()).mul(U.uGrade));
    col.mulAssign(mix(vec3(1), vec3(1.06, 1.0, 0.92), smoothstep(0.3, 1.0, lum).mul(U.uGrade)));
    col.assign(mix(vec3(lum), col, U.uGrade.mul(0.3).add(1)));
    // Filmic S-curve contrast: crush the toe a touch and roll the shoulder so
    // the grade reads like a graded LUT rather than a flat colour shift. Only
    // the amount is dialled by uGrade — the shape is fixed.
    // The curve is only a curve inside 0..1: past 1.5 it turns negative, and a highlight
    // that bright (a fighter under the impact light) came out of the grade black with a
    // coloured fringe. So it bends the displayable range and leaves the overshoot alone.
    const inRange = clamp(col, 0, 1);
    const sc = inRange.mul(inRange).mul(inRange.mul(-2).add(3));   // smoothstep-shaped contrast
    col.addAssign(sc.sub(inRange).mul(U.uGrade.mul(0.18)));

    // KO drain: desaturate except strong reds (blood-red trim, red corner).
    If(U.uDesat.greaterThan(0.003), () => {
      const keepRed = smoothstep(0.1, 0.4, col.r.sub(max(col.g, col.b)));
      const drained = mix(vec3(dot(col, LUMA)), col, keepRed);
      col.assign(mix(col, drained, U.uDesat));
    });

    // Comic KO panel: posterised colour, ink where luminance steps, and a
    // 45-degree Ben-Day dot screen. Inside a dot the colour is lifted and
    // outside it is dropped by about the same amount, so the frame's average
    // brightness stays put — a print texture, not a flash or a blackout.
    // All of it in gamma space: this stage sees the LINEAR frame, where the
    // dark hall and the suits sit under 0.1 and a linear posterise rounds
    // them straight to black.
    If(U.uComic.greaterThan(0.003), () => {
      const px = vec2(1).div(U.uRes).toVar();
      const l0 = sqrtLuma(uv).toVar();
      const lx = sqrtLuma(uv.add(vec2(px.x.mul(1.5), 0)));
      const ly = sqrtLuma(uv.add(vec2(0, px.y.mul(1.5))));
      const ink = smoothstep(0.1, 0.24, abs(l0.sub(lx)).add(abs(l0.sub(ly))));
      const poster = floor(gammaOut(col).mul(5).add(0.5)).div(5).toVar();
      const pxy = uv.mul(U.uRes).toVar();
      const cell = vec2(pxy.x.add(pxy.y), pxy.y.sub(pxy.x)).mul(0.7071 / 7);
      const dotR = clamp(dot(poster, vec3(0.333)).oneMinus(), 0, 1).mul(0.45).add(0.2).toVar();
      const inDot = smoothstep(dotR.sub(0.08), dotR.add(0.08), length(fract(cell).sub(0.5))).oneMinus();
      const comic = mix(poster.mul(mix(0.86, 1.14, inDot)), vec3(0.1, 0.08, 0.12), ink.mul(0.85));
      col.assign(mix(col, pow(comic, vec3(2.2)), U.uComic));
    });

    // Super ink: the world prints as a two-tone comic page while a signature super fires.
    // Flicker rule: every layer is brightness-neutral on average — the two-tone map keeps each
    // pixel's own luminance, the dots lift inside and drop outside by the same amount, the
    // grain is zero-mean, the speed lines alternate ink and paper lanes — and uSuperInk itself
    // eases in and out over 150 ms or more (personalityEffects.js). Gamma space, as above.
    If(U.uSuperInk.greaterThan(0.003), () => {
      const l = dot(gammaOut(col), LW).toVar();
      const ga = gammaOut(U.uInkA).toVar();
      const gb = gammaOut(U.uInkB);
      // Two tones, stepped like a two-plate print, then rescaled to this pixel's brightness.
      const tone = mix(ga, gb, smoothstep(0.3, 0.42, l).mul(0.6).add(smoothstep(0.55, 0.68, l).mul(0.4))).toVar();
      tone.mulAssign(l.div(max(dot(tone, LW), 0.03)));
      // Ben-Day dots: coarser than the KO panel's, on a 30-degree screen, bigger in the shadows.
      const pxy = uv.mul(U.uRes).toVar();
      const cell = vec2(pxy.x.mul(0.866).add(pxy.y.mul(0.5)), pxy.y.mul(0.866).sub(pxy.x.mul(0.5))).div(9);
      const dotR = clamp(l.oneMinus(), 0, 1).mul(0.4).add(0.16).toVar();
      const inDot = smoothstep(dotR.sub(0.07), dotR.add(0.07), length(fract(cell).sub(0.5))).oneMinus();
      const page = tone.mul(mix(0.88, 1.12, inDot)).toVar();
      const inkCol = ga.mul(0.22).toVar();
      If(U.uInkCheap.lessThan(0.5), () => {
        // Paper grain: a fibre-sized, zero-mean speckle (held still under reduced motion).
        const pg = hash21(floor(pxy.mul(0.5)).add(floor(U.uTime.mul(12)).mul(U.uInkMotion)));
        page.mulAssign(pg.mul(0.07).add(0.965));
        // Thick ink: luminance steps measured 2.5 px out (the KO panel uses 1.5).
        const px = vec2(2.5).div(U.uRes).toVar();
        const lx = sqrtLuma(uv.add(vec2(px.x, 0)));
        const ly = sqrtLuma(uv.add(vec2(0, px.y)));
        const lxm = sqrtLuma(uv.sub(vec2(px.x, 0)));
        const lym = sqrtLuma(uv.sub(vec2(0, px.y)));
        const ink = smoothstep(0.09, 0.22, abs(lx.sub(lxm)).add(abs(ly.sub(lym))));
        page.assign(mix(page, inkCol, ink.mul(0.88)));
      });
      // Radial speed lines out of the firing fighter: thin lanes, ink and paper alternating.
      const kd = uv.sub(U.uInkC).mul(aspect2).toVar();
      const krad = length(kd).toVar();
      const kang = atan(kd.y, kd.x).mul(0.15915494).add(0.5);
      const klane = floor(kang.mul(150)).toVar();
      const kn = hash21(vec2(klane, 11)).toVar();
      const kstreak = smoothstep(0.7, 0.95, kn).mul(smoothstep(0.28, 0.75, krad))
        .mul(fract(kn.mul(7).add(U.uTime.mul(2.6).mul(U.uInkMotion)).sub(krad.mul(0.6))).mul(0.55).add(0.45));
      const lanes = select(mod(klane, 2).lessThan(1), inkCol, vec3(1.0, 0.96, 0.88).mul(max(l.mul(1.6), 0.35)));
      page.assign(mix(page, lanes, kstreak.mul(0.6)));
      col.assign(mix(col, pow(max(page, vec3(0)), vec3(2.2)), U.uSuperInk));
    });

    const d = length(vUv.sub(0.5));
    col.mulAssign(smoothstep(0.55, 0.95, d).mul(U.uVignette).oneMinus());

    // Rewind scanlines: every other line of the band dimmed a touch, plus a
    // faint bright roll bar. Small both ways, so the average holds.
    If(U.uRewind.greaterThan(0.003), () => {
      const sl = mod(floor(vUv.y.mul(U.uRes.y).mul(0.5)), 2);
      col.mulAssign(sl.mul(U.uRewind).mul(0.12).oneMinus());
      col.addAssign(vec3(0.05).mul(exp(sq(vUv.y.sub(fract(U.uTime.mul(1.7))).mul(22)).negate())).mul(U.uRewind));
    });

    // Danger edge: skipped outright unless a fighter is in the red.
    If(U.uDangerL.add(U.uDangerR).greaterThan(0.003), () => {
      const edge = smoothstep(0.0, 0.3, vUv.x).oneMinus().mul(U.uDangerL)
        .add(smoothstep(0.7, 1.0, vUv.x).mul(U.uDangerR))
        // Strongest at mid-height, easing off into the corners the vignette owns.
        .mul(abs(vUv.y.sub(0.5)).mul(2).oneMinus().mul(0.45).add(0.55));
      const m = clamp(edge.mul(U.uHeart.mul(0.38).add(0.62)), 0, 1).mul(0.5);
      col.assign(mix(col, col.mul(vec3(1.2, 0.6, 0.56)).add(vec3(0.045, 0.0, 0.004)), m));
    });

    // Film grain: animated monochrome noise, strongest in the shadows (where sensor
    // noise actually lives) and fading out of the highlights so bright speculars stay clean.
    If(U.uGrain.greaterThan(0.0001), () => {
      const grain = hash21(vUv.mul(vec2(1920, 1080)).add(fract(U.uTime).mul(71.7))).sub(0.5);
      const shadowW = smoothstep(0.0, 0.55, lum).oneMinus();   // more grain in darks
      col.addAssign(grain.mul(U.uGrain).mul(shadowW.mul(0.65).add(0.35)));
    });

    return vec4(max(col, vec3(0)), 1);
  })();
}
