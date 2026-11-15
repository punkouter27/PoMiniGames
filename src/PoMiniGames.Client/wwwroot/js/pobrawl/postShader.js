// postShader.js — the CA / vignette / radial-blur / broadcast-grade pass. Pure
// shader data; `_buildComposer` wraps it in a ShaderPass.
//
// Runs after bloom, before OutputPass (so it operates on the linear HDR
// frame). uCA and uRadial are pulsed by hits and the KO flash; uDesat rides
// the KO lights-down blend (drains color, keeps the reds); the teal-shadow /
// warm-highlight grade and vignette are constant.
export const CAVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
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
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCA;
    uniform float uVignette;
    uniform float uRadial;
    uniform float uGrade;
    uniform float uDesat;
    uniform float uGodrays;
    uniform vec2 uGodraysOrig;
    uniform float uGodraysDecay;
    uniform vec3 uGodraysTint;
    uniform float uGrain;
    uniform float uTime;
    uniform float uSpeed;
    uniform vec3 uSpeedTint;
    uniform float uDangerL;
    uniform float uDangerR;
    uniform float uHeart;
    uniform float uShock;
    uniform vec2 uShockC;
    uniform float uShockR;
    uniform float uAspect;
    uniform vec2 uRes;
    uniform float uComic;
    uniform float uRewind;
    uniform float uNetSmear;
    uniform vec2 uNetSmearC;
    uniform float uNetSmearR;
    uniform vec2 uNetSmearDir;
    uniform float uSuperInk;
    uniform vec3 uInkA;
    uniform vec3 uInkB;
    uniform vec2 uInkC;
    uniform float uInkCheap;
    uniform float uInkMotion;
    varying vec2 vUv;
    // Cheap hash for the film grain — no texture fetch.
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      vec2 uv = vUv;
      float ca = uCA;
      // Tape rewind: each scanline band slides sideways on its own hash, and a
      // tracking band rolls up the frame. Displacement only.
      if (uRewind > 0.003) {
        float band = floor(uv.y * 90.0);
        uv.x += (hash21(vec2(band, floor(uTime * 30.0))) - 0.5) * 0.018 * uRewind;
        float roll = fract(uTime * 1.7);
        uv.x += exp(-pow((uv.y - roll) * 22.0, 2.0)) * 0.03 * uRewind;
        ca += 1.2 * uRewind;
      }
      // Shockwave: a gaussian ring pushes pixels outward; its edge also splits
      // the channels, so the ring reads as a lens being struck.
      float ring = 0.0;
      if (uShock > 0.003) {
        vec2 sd = (uv - uShockC) * vec2(uAspect, 1.0);
        float sdist = length(sd);
        ring = exp(-pow((sdist - uShockR) * 16.0, 2.0)) * uShock;
        uv -= (sd / max(sdist, 1e-4)) * vec2(1.0 / uAspect, 1.0) * ring * 0.035;
        ca += ring * 3.0;
      }
      // Rollback smear: a gaussian blob around one fighter whose red channel is pulled back
      // along the correction and blue pushed ahead — the same split the global CA does, but
      // directional and local. Displacement only, so brightness holds.
      vec2 smear = vec2(0.0);
      if (uNetSmear > 0.003) {
        vec2 nd = (uv - uNetSmearC) * vec2(uAspect, 1.0);
        float nm = exp(-dot(nd, nd) / max(uNetSmearR * uNetSmearR, 1e-4)) * uNetSmear;
        smear = uNetSmearDir * nm * 0.022;
      }
      vec2 off = (uv - 0.5) * ca * 0.012;
      float r = texture2D(tDiffuse, uv + off - smear).r;
      float g = texture2D(tDiffuse, uv - smear * 0.35).g;
      float b = texture2D(tDiffuse, uv - off + smear * 0.5).b;
      vec3 col = vec3(r, g, b);

      // Radial impact blur: a short streak toward the frame center. 4 extra
      // taps is enough at pulse strengths — it reads as a punch, not a filter.
      if (uRadial > 0.003) {
        vec2 dir = (vec2(0.5) - uv) * uRadial * 0.05;
        vec3 acc = col;
        acc += texture2D(tDiffuse, uv + dir * 1.0).rgb;
        acc += texture2D(tDiffuse, uv + dir * 2.0).rgb;
        acc += texture2D(tDiffuse, uv + dir * 3.0).rgb;
        acc += texture2D(tDiffuse, uv + dir * 4.0).rgb;
        col = acc * 0.2;
      }

      // Godrays: sample along a line from each pixel toward the spotlight origin
      // (projected to screen space by the JS side). Each tap decays by
      // uGodraysDecay, so bright pixels near the origin smear outward as
      // the blade of light. 16 taps is cheap and reads as proper cinema.
      if (uGodrays > 0.003) {
        const int STEPS = 16;
        vec2 dir = (uGodraysOrig - vUv) / float(STEPS);
        float weight = 0.0;
        vec3 acc = vec3(0.0);
        float w = 1.0;
        vec2 p = vUv;
        for (int i = 0; i < STEPS; i++) {
          p += dir;
          vec3 s = texture2D(tDiffuse, p).rgb;
          // Threshold the sample so the lit pixels (spotlight + ring trim)
          // contribute most; the dim arena walls contribute little.
          float l = max(max(s.r, s.g), s.b);
          float mask = smoothstep(0.78, 1.05, l);
          acc += s * w * mask;
          weight += w * mask;
          w *= uGodraysDecay;
        }
        if (weight > 0.0001) {
          vec3 blade = acc / weight;
          col += blade * uGodrays * uGodraysTint;
        }
      }

      // Speedlines: radial streaks fanning out from the frame centre. The
      // angle is quantised into lanes, each lane hashed for its own brightness
      // and phase, so the fan is irregular the way an inked one is rather than
      // a clean starburst. Added BEFORE the grade so the grade's shoulder rolls
      // the hot ends of the lines off instead of leaving them clipped white.
      if (uSpeed > 0.003) {
        vec2 sd = vUv - 0.5;
        float srad = length(sd) * 2.0;
        float sang = atan(sd.y, sd.x) * 0.15915494 + 0.5;   // 0..1
        float lane = floor(sang * 110.0);
        float n = hash21(vec2(lane, 3.0));
        // ~40% of lanes carry a line; the rest stay empty so the fan breathes.
        float streak = smoothstep(0.58, 0.98, n);
        // Nothing inside 0.3 of centre (that is where the fighters are) and
        // nothing past the corners, so the lines read as framing, not overlay.
        float radMask = smoothstep(0.30, 0.92, srad) * (1.0 - smoothstep(1.24, 1.72, srad));
        // Each lane drifts outward on its own phase — static lines read as a
        // texture laid over the frame instead of speed through it.
        float phase = fract(n * 13.0 + uTime * 2.4);
        col += uSpeedTint * streak * radMask * uSpeed * (0.30 + 0.70 * phase);
      }

      // Broadcast grade: teal-pushed shadows, warm highlights, +saturation. Saturation is the
      // lever that keeps the hall looking painted rather than washed out — it costs no contrast,
      // unlike exposure, and it is the one number to raise for a brighter, more vibrant frame.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(0.005, 0.013, 0.026) * (1.0 - smoothstep(0.0, 0.4, lum)) * uGrade;
      col *= mix(vec3(1.0), vec3(1.06, 1.0, 0.92), smoothstep(0.3, 1.0, lum) * uGrade);
      col = mix(vec3(lum), col, 1.0 + 0.3 * uGrade);
      // Filmic S-curve contrast: crush the toe a touch and roll the shoulder so
      // the grade reads like a graded LUT rather than a flat colour shift. Only
      // the amount is dialled by uGrade — the shape is fixed.
      vec3 sc = col * col * (3.0 - 2.0 * col);   // smoothstep-shaped contrast
      col = mix(col, sc, 0.18 * uGrade);

      // KO drain: desaturate except strong reds (blood-red trim, red corner).
      if (uDesat > 0.003) {
        float keepRed = smoothstep(0.1, 0.4, col.r - max(col.g, col.b));
        vec3 drained = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, keepRed);
        col = mix(col, drained, uDesat);
      }

      // Comic KO panel: posterised colour, ink where luminance steps, and a
      // 45-degree Ben-Day dot screen. Inside a dot the colour is lifted and
      // outside it is dropped by about the same amount, so the frame's average
      // brightness stays put — a print texture, not a flash or a blackout.
      // All of it in gamma space: this pass sees the LINEAR frame, where the
      // dark hall and the suits sit under 0.1 and a linear posterise rounds
      // them straight to black.
      if (uComic > 0.003) {
        vec2 px = 1.0 / uRes;
        const vec3 LW = vec3(0.299, 0.587, 0.114);
        float l0 = sqrt(max(dot(texture2D(tDiffuse, uv).rgb, LW), 0.0));
        float lx = sqrt(max(dot(texture2D(tDiffuse, uv + vec2(px.x * 1.5, 0.0)).rgb, LW), 0.0));
        float ly = sqrt(max(dot(texture2D(tDiffuse, uv + vec2(0.0, px.y * 1.5)).rgb, LW), 0.0));
        float ink = smoothstep(0.1, 0.24, abs(l0 - lx) + abs(l0 - ly));
        vec3 gcol = pow(max(col, vec3(0.0)), vec3(0.4545));
        vec3 poster = floor(gcol * 5.0 + 0.5) / 5.0;
        vec2 cell = mat2(0.7071, -0.7071, 0.7071, 0.7071) * (uv * uRes) / 7.0;
        float dotR = 0.2 + 0.45 * clamp(1.0 - dot(poster, vec3(0.333)), 0.0, 1.0);
        float inDot = 1.0 - smoothstep(dotR - 0.08, dotR + 0.08, length(fract(cell) - 0.5));
        vec3 comic = poster * mix(0.86, 1.14, inDot);
        comic = mix(comic, vec3(0.1, 0.08, 0.12), ink * 0.85);
        col = mix(col, pow(comic, vec3(2.2)), uComic);
      }

      // Super ink: the world prints as a two-tone comic page while a signature super fires.
      // Flicker rule: every layer is brightness-neutral on average — the two-tone map keeps each
      // pixel's own luminance, the dots lift inside and drop outside by the same amount, the
      // grain is zero-mean, the speed lines alternate ink and paper lanes — and uSuperInk itself
      // eases in and out over 150 ms or more (personalityEffects.js). Gamma space, as above.
      if (uSuperInk > 0.003) {
        const vec3 LW2 = vec3(0.299, 0.587, 0.114);
        vec3 gc = pow(max(col, vec3(0.0)), vec3(0.4545));
        float l = dot(gc, LW2);
        vec3 ga = pow(max(uInkA, vec3(0.0)), vec3(0.4545));
        vec3 gb = pow(max(uInkB, vec3(0.0)), vec3(0.4545));
        // Two tones, stepped like a two-plate print, then rescaled to this pixel's brightness.
        vec3 tone = mix(ga, gb, smoothstep(0.3, 0.42, l) * 0.6 + smoothstep(0.55, 0.68, l) * 0.4);
        tone *= l / max(dot(tone, LW2), 0.03);
        // Ben-Day dots: coarser than the KO panel's, on a 30-degree screen, bigger in the shadows.
        vec2 cell = mat2(0.866, -0.5, 0.5, 0.866) * (uv * uRes) / 9.0;
        float dotR = 0.16 + 0.4 * clamp(1.0 - l, 0.0, 1.0);
        float inDot = 1.0 - smoothstep(dotR - 0.07, dotR + 0.07, length(fract(cell) - 0.5));
        vec3 page = tone * mix(0.88, 1.12, inDot);
        vec3 inkCol = ga * 0.22;
        if (uInkCheap < 0.5) {
          // Paper grain: a fibre-sized, zero-mean speckle (held still under reduced motion).
          float pg = hash21(floor(uv * uRes * 0.5) + floor(uTime * 12.0) * uInkMotion);
          page *= 0.965 + 0.07 * pg;
          // Thick ink: luminance steps measured 2.5 px out (the KO panel uses 1.5).
          vec2 px = 2.5 / uRes;
          float lx = sqrt(max(dot(texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb, LW2), 0.0));
          float ly = sqrt(max(dot(texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb, LW2), 0.0));
          float lxm = sqrt(max(dot(texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb, LW2), 0.0));
          float lym = sqrt(max(dot(texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb, LW2), 0.0));
          float ink = smoothstep(0.09, 0.22, abs(lx - lxm) + abs(ly - lym));
          page = mix(page, inkCol, ink * 0.88);
        }
        // Radial speed lines out of the firing fighter: thin lanes, ink and paper alternating.
        vec2 kd = (uv - uInkC) * vec2(uAspect, 1.0);
        float krad = length(kd);
        float kang = atan(kd.y, kd.x) * 0.15915494 + 0.5;
        float klane = floor(kang * 150.0);
        float kn = hash21(vec2(klane, 11.0));
        float kstreak = smoothstep(0.7, 0.95, kn) * smoothstep(0.28, 0.75, krad);
        kstreak *= 0.45 + 0.55 * fract(kn * 7.0 + uTime * 2.6 * uInkMotion - krad * 0.6);
        vec3 lanes = mod(klane, 2.0) < 1.0 ? inkCol : vec3(1.0, 0.96, 0.88) * max(l * 1.6, 0.35);
        page = mix(page, lanes, kstreak * 0.6);
        col = mix(col, pow(max(page, vec3(0.0)), vec3(2.2)), uSuperInk);
      }

      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.55, 0.95, d) * uVignette;

      // Rewind scanlines: every other line of the band dimmed a touch, plus a
      // faint bright roll bar. Small both ways, so the average holds.
      if (uRewind > 0.003) {
        float sl = mod(floor(vUv.y * uRes.y * 0.5), 2.0);
        col *= 1.0 - 0.12 * sl * uRewind;
        col += vec3(0.05) * exp(-pow((vUv.y - fract(uTime * 1.7)) * 22.0, 2.0)) * uRewind;
      }

      // Danger edge: skipped outright unless a fighter is in the red.
      if (uDangerL + uDangerR > 0.003) {
        float edge = (1.0 - smoothstep(0.0, 0.3, vUv.x)) * uDangerL
                   + smoothstep(0.7, 1.0, vUv.x) * uDangerR;
        // Strongest at mid-height, easing off into the corners the vignette owns.
        edge *= 0.55 + 0.45 * (1.0 - abs(vUv.y - 0.5) * 2.0);
        float m = clamp(edge * (0.62 + 0.38 * uHeart), 0.0, 1.0) * 0.5;
        col = mix(col, col * vec3(1.2, 0.6, 0.56) + vec3(0.045, 0.0, 0.004), m);
      }

      // Film grain (idea #10): animated monochrome noise, strongest in the
      // shadows (where sensor noise actually lives) and fading out of the
      // highlights so bright speculars stay clean. Two hashed samples offset
      // by the frame time keep it crawling rather than static-dithering.
      if (uGrain > 0.0001) {
        float g1 = hash21(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 71.7);
        float grain = (g1 - 0.5);
        float shadowW = 1.0 - smoothstep(0.0, 0.55, lum); // more grain in darks
        col += grain * uGrain * (0.35 + 0.65 * shadowW);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};
