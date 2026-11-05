// fx-race.js — the race's extra GPU effects, layered on top of scene.js's pipeline. scene.js
// owns the renderer, camera and composer; this module only adds to them, and every part of it is
// switched off by the Settings drawer's Effects: Lite (store.js prefs.effects):
//
//   · GPU bursts (#24) — one pooled Points system for kicker rings, boost streaks and finish
//     fountains. Particles are simulated in the VERTEX shader from (origin, velocity, birth), so
//     the CPU writes a particle once at spawn and never again, and the whole pool is ONE draw call.
//   · Speed streak + lens dirt (#28) — a full-screen pass driven by the followed marble's speed and
//     boost: a radial smear and rim speed-lines at pace, and a dirty-lens glow off bright light.
//     The pass disables itself whenever both are idle, so cruising costs nothing.
//   · Screen-space reflections (#25) — three's SSRPass on the heavy tier, only where the track is
//     meant to shine: a map whose theme says `reflect` (Neon Chute) or a rainy race.
//
// The scene's own sparks/confetti (CPU, scene.js) stay as they were: these are additions.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── GPU bursts ────────────────────────────────────────────────────────────
// 2048 slots in a ring: the biggest single burst (your own finish) is ~140, and a lap of boost pads
// spawns a few dozen a second, so the ring never overwrites a particle that is still alive.
const POOL = 2048;
const GRAVITY = 26;           // matches scene.js's CPU sparks, so the two kinds of debris fall alike
const DRAG = 2.2;             // per-second exponential drag: bursts pop out then hang, rather than fly off

const BurstShader = {
  vertexShader: `
    attribute vec3 aVel;
    attribute vec4 aMeta;     // x birth (s), y life (s), z size (world units), w gravity scale
    attribute vec3 aColor;
    uniform float uTime;
    uniform float uScale;     // drawing-buffer pixels per world unit at depth 1
    varying vec3 vColor;
    varying float vFade;
    void main() {
      float t = uTime - aMeta.x;
      if (t < 0.0 || t > aMeta.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFade = 0.0; return; }
      // Closed-form motion: drag on the launch velocity, gravity on top. No per-frame state.
      float k = (1.0 - exp(-${DRAG.toFixed(1)} * t)) / ${DRAG.toFixed(1)};
      vec3 p = position + aVel * k;
      p.y -= 0.5 * ${GRAVITY.toFixed(1)} * aMeta.w * t * t;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float life = 1.0 - t / aMeta.y;
      vFade = life * life;
      vColor = aColor;
      gl_PointSize = clamp(aMeta.z * uScale / max(-mv.z, 1.0), 1.0, 64.0);
    }`,
  fragmentShader: `
    varying vec3 vColor;
    varying float vFade;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r = dot(d, d) * 4.0;
      if (r > 1.0) discard;
      // A hot core in a soft halo: reads as light, not as a flat dot.
      float a = (1.0 - r) * (1.0 - r);
      gl_FragColor = vec4(vColor * (0.7 + 1.6 * a), a * vFade);
    }`,
};

function createBursts(scene) {
  const origin = new Float32Array(POOL * 3);
  const vel = new Float32Array(POOL * 3);
  const meta = new Float32Array(POOL * 4);
  const color = new Float32Array(POOL * 3);
  for (let i = 0; i < POOL; i++) meta[i * 4] = -1e6;   // born long ago and long dead
  const geo = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(origin, 3),
    aVel: new THREE.BufferAttribute(vel, 3),
    aMeta: new THREE.BufferAttribute(meta, 4),
    aColor: new THREE.BufferAttribute(color, 3),
  };
  for (const [name, a] of Object.entries(attrs)) { a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); }
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 400 } },
    vertexShader: BurstShader.vertexShader,
    fragmentShader: BurstShader.fragmentShader,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;       // the particles move in the shader; the bounds never would
  points.userData.noAO = true;        // additive light, not a surface (scene.js GTAO filter)
  points.renderOrder = 2;
  scene.add(points);

  let head = 0;
  let lo = POOL, hi = -1;             // dirty range for this frame's upload
  let clock = 0;
  const _c = new THREE.Color();

  function emit(px, py, pz, vx, vy, vz, life, size, grav, hex) {
    const i = head; head = (head + 1) % POOL;
    origin[i * 3] = px; origin[i * 3 + 1] = py; origin[i * 3 + 2] = pz;
    vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
    meta[i * 4] = clock; meta[i * 4 + 1] = life; meta[i * 4 + 2] = size; meta[i * 4 + 3] = grav;
    _c.set(hex);
    color[i * 3] = _c.r; color[i * 3 + 1] = _c.g; color[i * 3 + 2] = _c.b;
    if (i < lo) lo = i;
    if (i > hi) hi = i;
  }

  const rnd = (a, b) => a + Math.random() * (b - a);

  // A horizontal shock ring plus an upward pop: the kicker's discharge.
  function kicker(p, hex = 0xe879f9) {
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const s = rnd(20, 26);
      emit(p.x, p.y + 0.4, p.z, Math.cos(a) * s, rnd(0, 2), Math.sin(a) * s, 0.5, 1.0, 0.15, hex);
    }
    for (let k = 0; k < 12; k++) emit(p.x, p.y, p.z, rnd(-5, 5), rnd(10, 18), rnd(-5, 5), 0.6, 0.8, 1, 0xffffff);
  }

  // A small pop on each marble a kicker actually hit.
  function pop(p, hex = 0xe879f9) {
    for (let k = 0; k < 8; k++) emit(p.x, p.y, p.z, rnd(-7, 7), rnd(4, 11), rnd(-7, 7), 0.4, 0.7, 1, hex);
  }

  // Chevron streaks shed backwards off a marble on a pad: they read as "this way, fast".
  function boost(p, dir, hex = 0x22d3ee) {
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : 1;
    for (let k = 0; k < 6; k++) {
      const s = rnd(14, 24);
      emit(p.x + rnd(-0.6, 0.6), p.y + rnd(0, 0.8), p.z + rnd(-0.6, 0.6),
        -dx * s + rnd(-2, 2), -dy * s + rnd(0, 2), -dz * s + rnd(-2, 2), 0.32, 0.65, 0, hex);
    }
  }

  // A fountain at the line; `big` (the winner, or your own finish) adds a gold shock ring.
  const FINISH = [0xfde047, 0xffffff, 0xfbbf24, 0x22d3ee, 0xe879f9];
  function finish(p, big) {
    const n = big ? 90 : 14;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, r = rnd(0, big ? 9 : 5);
      emit(p.x, p.y + 0.8, p.z, Math.cos(a) * r, rnd(14, big ? 30 : 20), Math.sin(a) * r,
        rnd(0.9, 1.4), big ? 1.0 : 0.7, 1, FINISH[(Math.random() * FINISH.length) | 0]);
    }
    if (!big) return;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      emit(p.x, p.y + 0.3, p.z, Math.cos(a) * 30, 1, Math.sin(a) * 30, 0.7, 1.2, 0, 0xfde047);
    }
  }

  function update(dt, camera, renderer) {
    clock += dt;
    mat.uniforms.uTime.value = clock;
    // World size → pixels: half the buffer height over tan(fov/2), divided by depth in the shader.
    const h = renderer.domElement.height || 540;
    mat.uniforms.uScale.value = (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    if (hi < lo) return;
    for (const a of Object.values(attrs)) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * a.itemSize, (hi - lo + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    lo = POOL; hi = -1;
  }

  return {
    points,
    spawn(kind, p, dir, big) {
      if (!p) return;
      if (kind === 'kicker') kicker(p);
      else if (kind === 'pop') pop(p);
      else if (kind === 'boost') boost(p, dir);
      else if (kind === 'finish') finish(p, !!big);
    },
    update,
    clear() { for (let i = 0; i < POOL; i++) meta[i * 4] = -1e6; lo = 0; hi = POOL - 1; },
    dispose() { scene.remove(points); geo.dispose(); mat.dispose(); },
  };
}

// ── Speed streak + lens dirt (#28) ────────────────────────────────────────
const StreakShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDirt: { value: null },
    uStreak: { value: 0 },
    uDirt: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tDirt;
    uniform float uStreak; uniform float uDirt; uniform float uTime; uniform float uAspect;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c * vec2(uAspect, 1.0));
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (uStreak > 0.001) {
        // Radial smear toward the frame centre, zero in the middle (where the marble is) and
        // strongest at the rim: the classic speed read without blurring what you steer.
        float amt = uStreak * 0.07 * smoothstep(0.12, 0.75, r);
        vec3 acc = col;
        for (int i = 1; i < 6; i++) acc += texture2D(tDiffuse, vUv - c * amt * (float(i) / 5.0)).rgb;
        col = acc / 6.0;
        // Speed lines: sparse angular lanes at the rim, rushing outward.
        float lane = floor(atan(c.y, c.x) * 48.0 / 6.2831853);
        float h = fract(sin(lane * 91.7) * 43758.5453);
        float line = step(0.8, h) * smoothstep(0.32, 0.78, r)
          * smoothstep(0.4, 1.0, sin(r * 26.0 - uTime * 38.0 + h * 6.2831853));
        col += vec3(0.75, 0.92, 1.0) * line * uStreak * 0.22;
      }
      if (uDirt > 0.001) {
        // Lens dirt lit by the frame's light: this pixel's brightness plus a coarse read of the
        // whole frame, so a bright pad or flash anywhere lights the smudges a little everywhere.
        float g = luma(texture2D(tDiffuse, vec2(0.5)).rgb + texture2D(tDiffuse, vec2(0.25, 0.3)).rgb
          + texture2D(tDiffuse, vec2(0.75, 0.3)).rgb + texture2D(tDiffuse, vec2(0.25, 0.7)).rgb
          + texture2D(tDiffuse, vec2(0.75, 0.7)).rgb) * 0.2;
        float lit = max(luma(col) - 0.75, 0.0) * 0.6 + max(g - 0.5, 0.0) * 0.5;
        col += texture2D(tDirt, vUv).rgb * lit * uDirt;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// A procedural smudge map: soft blobs and a few wipe streaks, generated once, 256² — no asset file.
function makeDirtTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S, y = rnd() * S, r = 4 + rnd() * 26;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rnd() * 0.18;
    grd.addColorStop(0, `rgba(255,248,235,${a})`);
    grd.addColorStop(1, 'rgba(255,248,235,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = `rgba(230,240,255,${0.04 + rnd() * 0.05})`;
    g.lineWidth = 6 + rnd() * 14;
    g.beginPath();
    const x = rnd() * S, y = rnd() * S;
    g.moveTo(x, y); g.quadraticCurveTo(x + rnd() * 80 - 40, y + rnd() * 80 - 40, x + rnd() * 140 - 70, y + rnd() * 140 - 70);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * @param {object} o { scene, camera, renderer, composer, renderPass, gradePass, heavy, level }
 *   gradePass is scene.js's colour-grade ShaderPass; the streak pass goes in just before it.
 */
export function createRaceFx({ scene, camera, renderer, composer, renderPass, gradePass, heavy, level }) {
  let full = level !== 'lite';
  const bursts = createBursts(scene);

  const dirtTex = makeDirtTexture();
  const streak = new ShaderPass(StreakShader);
  streak.uniforms.tDirt.value = dirtTex;
  streak.enabled = false;
  composer.insertPass(streak, Math.max(1, composer.passes.indexOf(gradePass)));

  let streakNow = 0, dirtNow = 0, boosting = false, flash = 0, time = 0;

  // ── SSR (#25) ──
  // Built lazily, the first time a reflective race starts, and only on the heavy tier: SSRPass
  // renders the scene itself (beauty + depth + normals) and blurs the result, roughly doubling the
  // geometry cost. While it is on, the composer's RenderPass stands down, since SSR draws the frame.
  let ssr = null;
  let reflectTheme = false;
  let weatherSeen = null;   // the weather is applied after the scene is built, so update() watches it
  // The live adaptive tier (visualRuntime.js publishes data-gfx): a machine that starts on 'high'
  // and then drops frames is demoted, and SSR, the most expensive thing here, goes with it.
  const tierHigh = () => typeof document === 'undefined' || (document.documentElement.getAttribute('data-gfx') || 'high') === 'high';
  let tierSeen = tierHigh();
  let tierCheck = 0;
  function wantSsr() {
    if (!heavy || !full || !tierSeen) return false;
    const wet = window.PoWeather?.current?.() === 'rain';
    return reflectTheme || wet;
  }
  function applySsr() {
    const on = wantSsr();
    if (on && !ssr) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      ssr = new SSRPass({ renderer, scene, camera, width: size.x, height: size.y, selects: null });
      // Grazing-angle reflections (the road seen from the chase cam) dominate through fresnel;
      // a wall seen head-on barely reflects. Thickness in world units: a marble is radius 1.
      ssr.fresnel = true;
      ssr.distanceAttenuation = true;
      // The march is per pixel and its cost scales with this reach; 40 units covers the road
      // ahead of a chase cam ~28 back, which is all a floor reflection needs to show.
      ssr.maxDistance = 40;
      ssr.thickness = 0.6;
      ssr.blur = true;
      composer.insertPass(ssr, composer.passes.indexOf(renderPass) + 1);
    }
    if (ssr) {
      ssr.enabled = on;
      ssr.opacity = window.PoWeather?.current?.() === 'rain' ? 0.45 : 0.32;
    }
    renderPass.enabled = !(ssr && ssr.enabled);
  }

  return {
    /** A theme with `reflect: true` asks for SSR (Neon Chute's wet-look neon floor). */
    setTheme(t) { reflectTheme = !!(t && t.reflect); applySsr(); },
    setLevel(l) {
      full = l !== 'lite';
      if (!full) { bursts.clear(); streakNow = dirtNow = 0; streak.enabled = false; }
      applySsr();
    },
    get full() { return full; },
    burst(kind, p, dir, big) { if (full) bursts.spawn(kind, p, dir, big); },
    setBoosting(b) { boosting = !!b; },
    flashDirt(amount = 1) { if (full) flash = Math.max(flash, amount); },
    /** Per frame, from scene.followTarget: `speed` is the followed marble's. */
    update(dt, speed) {
      time += dt;
      bursts.update(dt, camera, renderer);
      const w = window.PoWeather?.current?.() ?? null;
      if (w !== weatherSeen) { weatherSeen = w; applySsr(); }
      tierCheck -= dt;
      if (tierCheck <= 0) {
        tierCheck = 1;
        const hi = tierHigh();
        if (hi !== tierSeen) { tierSeen = hi; applySsr(); }
      }
      if (!full) return;
      const motionOk = !reducedMotion();
      const pace = Math.max(0, Math.min(1, ((speed || 0) - 50) / 60));
      const streakTo = motionOk ? pace * 0.6 + (boosting ? 0.5 : 0) : 0;
      const dirtTo = Math.min(1.4, pace * 0.5 + (boosting ? 0.6 : 0) + flash);
      flash = Math.max(0, flash - dt * 1.2);
      const k = 1 - Math.exp(-4 * dt);
      streakNow += (streakTo - streakNow) * k;
      dirtNow += (dirtTo - dirtNow) * k;
      const u = streak.uniforms;
      u.uStreak.value = streakNow;
      u.uDirt.value = dirtNow;
      u.uTime.value = time;
      u.uAspect.value = camera.aspect;
      // Off entirely when idle: a full-screen pass that does nothing still costs a fill.
      streak.enabled = streakNow > 0.01 || dirtNow > 0.01;
    },
    dispose() {
      bursts.dispose();
      dirtTex.dispose();
      streak.dispose?.();
      ssr?.dispose();
    },
  };
}
