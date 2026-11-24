// lens.js — the camera lens of the race: everything that happens to the image between the scene
// pass and the colour grade, as ONE TSL node graph (WGSL on WebGPU, GLSL on the WebGL2 fallback).
//
//   · water on the lens (#15): after the flume the camera wears drops that bead, slide and run off,
//     each one a little ball lens that magnifies and flips what is behind it, with a dark meniscus;
//   · shockwaves (#12): a kicker discharge or a boost pad bends the frame in a ring that runs out
//     from where it happened on screen;
//   · edge fringe (#17): on a boost the red and blue split apart at the edges, never in the middle
//     where your marble is;
//   · motion blur (#13): per-pixel, along the scene pass's own motion vectors (the velocity MRT
//     attachment TRAA already writes on medium and high), so things smear along how THEY moved;
//   · light shafts (#14, high tier): a radial blur of the sky toward a low sun, at half resolution,
//     so whatever stands against the sky throws rays; strongest in the final stretch;
//   · the leader cam (#9): a second camera on the race leader, rendered to its own small target
//     and composited here as a rounded inset with a glowing rim.
//
// The drops and the ripples are simulated here on the CPU (a few dozen numbers) and handed over as
// uniforms; the shader does the per-pixel optics. Every effect has a strength uniform, so nothing
// ever recompiles mid-race, and all of them rest at zero under reduced motion.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, uniform, rtt, convertToTexture, texture,
  smoothstep, clamp, mix, dot, max, min, abs, exp, length, normalize, select,
} from 'three-eco/tsl';

const DROPS = 18;          // lens drops alive at once
const RIPPLES = 4;         // shockwaves alive at once
const BLUR_TAPS = 6;       // motion-blur samples per pixel
const RAY_TAPS = 28;       // light-shaft samples per (half-res) pixel
const PIP_W = 384, PIP_H = 216;   // leader-cam target, 16:9

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {{ stack: object|null, tier: string, heavy: boolean }} opts the shared post stack (for the
 *   depth and velocity attachments), the quality tier and whether the device can afford heavy passes.
 */
export function createLens({ stack, tier, heavy }) {
  // `?mrLensOff=pip,rays,blur,drops` drops single effects, for frame-time A/B.
  const off = new Set((new URLSearchParams(location.search).get('mrLensOff') || '').split(','));
  // ── uniforms ──
  const uAspect = uniform(16 / 9);
  const uRes = uniform(new THREE.Vector2(1280, 720));
  const drops = Array.from({ length: DROPS }, () => ({ u: uniform(new THREE.Vector4(0, 0, 0, 0)), x: 0, y: 0, r: 0, a: 0, vy: 0, life: 0, stick: 0 }));
  const ripples = Array.from({ length: RIPPLES }, () => ({ u: uniform(new THREE.Vector4(0, 0, 1, 0)), age: 1, k: 0 }));
  const uFringe = uniform(0);
  const uBlur = uniform(0);
  const uRays = uniform(0);
  const uSun = uniform(new THREE.Vector2(0.5, -0.2));
  const uSunTint = uniform(new THREE.Color(1, 0.86, 0.62));
  const uPipA = uniform(0);
  const uPipRect = uniform(new THREE.Vector4(0.7, 0.05, 0.97, 0.3));   // x0, y0, x1, y1 in uv
  const uPipRim = uniform(new THREE.Color(0.98, 0.8, 0.2));

  const pipTarget = new THREE.RenderTarget(PIP_W, PIP_H, { type: THREE.HalfFloatType, samples: 0 });
  // A short far plane: the inset is a close chase shot, and culling the rest of the course is
  // most of what keeps a second scene render affordable.
  const pipCam = new THREE.PerspectiveCamera(52, PIP_W / PIP_H, 1, 120);

  // The velocity attachment exists only where TRAA asked the scene pass for one.
  let velTex = null;
  try {
    if (!off.has('blur') && stack?.mrt && stack.scenePass && stack.mrt.has?.('velocity')) velTex = stack.scenePass.getTextureNode('velocity');
  } catch { velTex = null; }
  const depthTex = stack?.depthNode ?? null;
  const withRays = !!depthTex && heavy && tier === 'high' && !off.has('rays');
  const withDrops = !off.has('drops');
  const withPip = !off.has('pip');
  const disposables = [];

  /** Wrap the HDR scene colour (linear) in the lens. Returns a vec4 node, still linear HDR. */
  function build(combined) {
    const src = convertToTexture(combined);
    disposables.push(src);

    // Light shafts: sky mask × a sun glow, blurred radially toward the sun, at half resolution.
    let raysTex = null;
    if (withRays) {
      const rays = Fn(() => {
        const p0 = uv();
        const delta = uSun.sub(p0).mul(0.9 / RAY_TAPS);
        const acc = float(0).toVar();
        const coord = p0.toVar();
        let w = 1;
        for (let i = 0; i < RAY_TAPS; i++) {
          coord.addAssign(delta);
          const d = depthTex.sample(coord).r;
          const sky = select(d.greaterThan(0.99995), float(1), float(0));
          const toSun = length(coord.sub(uSun).mul(vec2(uAspect, 1)));
          const glow = exp(toSun.mul(-3.2)).add(exp(toSun.mul(-14)).mul(1.5));
          acc.addAssign(sky.mul(glow).mul(w));
          w *= 0.955;
        }
        return vec4(vec3(acc.mul(1 / RAY_TAPS)), 1);
      })();
      raysTex = rtt(rays, null, null, { resolutionScale: 0.5 });
      disposables.push(raysTex);
    }

    const pip = texture(pipTarget.texture);

    return Fn(() => {
      const p = uv().toVar();
      const asp = vec2(uAspect, 1);

      // ── drops: a ball lens each — magnify + flip what is behind, darken the meniscus ──
      const off = vec2(0).toVar();
      const rim = float(0).toVar();
      const glint = float(0).toVar();
      for (const d of withDrops ? drops : []) {
        const dv = p.sub(d.u.xy).mul(asp);
        const q = length(dv).div(max(d.u.z, 0.0001));
        const inside = smoothstep(1.0, 0.86, q).mul(d.u.w);
        off.subAssign(dv.div(asp).mul(inside).mul(1.35));
        rim.addAssign(smoothstep(0.62, 0.98, q).mul(inside));
        // the highlight sits up-left on the cap, where the sky reflects
        glint.addAssign(smoothstep(0.32, 0.0, length(dv.div(max(d.u.z, 0.0001)).add(vec2(0.38, 0.42)))).mul(d.u.w));
      }

      // ── shockwaves: a ring that bends the image outward as it runs ──
      for (const r of ripples) {
        const dv = p.sub(r.u.xy).mul(asp);
        const dist = length(dv);
        const radius = r.u.z.mul(0.42);
        const x = dist.sub(radius).div(0.035);
        const band = exp(x.mul(x).negate()).mul(r.u.w).mul(float(1).sub(r.u.z));
        off.addAssign(normalize(dv.add(vec2(0.00001, 0))).div(asp).mul(band).mul(0.022));
      }

      const q = p.add(off).toVar();

      // ── motion blur along each pixel's own motion vector ──
      let col;
      if (velTex) {
        const v = velTex.sample(q).xy.mul(0.5).mul(uBlur).toVar();
        const vl = length(v);
        v.assign(select(vl.greaterThan(0.018), v.mul(float(0.018).div(vl)), v));
        const acc = vec3(0).toVar();
        for (let i = 0; i < BLUR_TAPS; i++) {
          const t = i / (BLUR_TAPS - 1) - 0.5;
          acc.addAssign(src.sample(q.add(v.mul(t))).rgb);
        }
        col = acc.mul(1 / BLUR_TAPS).toVar();
      } else {
        col = src.sample(q).rgb.toVar();
      }

      // ── edge fringe: R out, B in, only toward the frame edge ──
      const c = q.sub(0.5);
      const edge = smoothstep(0.18, 0.72, length(c.mul(asp).div(uAspect.max(1))));
      const fo = c.mul(edge).mul(uFringe).mul(0.016);
      const fk = min(uFringe.mul(4), 1);
      col.assign(vec3(mix(col.x, src.sample(q.add(fo)).r, fk), col.y, mix(col.z, src.sample(q.sub(fo)).b, fk)));

      // drops: meniscus darkening and a cool glint
      col.mulAssign(float(1).sub(clamp(rim, 0, 1).mul(0.42)));
      col.addAssign(vec3(0.85, 0.93, 1.0).mul(clamp(glint, 0, 1)).mul(0.9));

      // ── light shafts ──
      if (raysTex) col.addAssign(vec3(uSunTint).mul(raysTex.sample(p).r).mul(uRays).mul(1.6));

      // ── leader cam inset: rounded rect in CSS pixels, rim glow round it ──
      const px = p.mul(uRes);
      const r0 = vec2(uPipRect.x, uPipRect.y).mul(uRes);
      const r1 = vec2(uPipRect.z, uPipRect.w).mul(uRes);
      const half = r1.sub(r0).mul(0.5);
      const ctr = r0.add(half);
      const RAD = 14;
      const qd = abs(px.sub(ctr)).sub(half).add(RAD);
      const sd = length(max(qd, 0)).add(min(max(qd.x, qd.y), 0)).sub(RAD);
      const inBox = smoothstep(1.0, -1.0, sd).mul(uPipA);
      const local = clamp(px.sub(r0).div(r1.sub(r0)), 0.001, 0.999);
      const shot = pip.sample(local).rgb;
      // a soft dark drop shadow under the card, then the card, then a 2px glowing rim
      const shadow = smoothstep(18, 0, sd).mul(float(1).sub(inBox)).mul(uPipA).mul(0.45);
      col.mulAssign(float(1).sub(shadow));
      col.assign(mix(col, shot, inBox));
      const ring = exp(abs(sd).mul(-0.9)).mul(uPipA);
      col.addAssign(vec3(uPipRim).mul(ring).mul(1.4));

      return vec4(col, 1);
    })();
  }

  // ── CPU side: drops, ripples, eased strengths ──
  let fringe = 0, rays = 0, pipA = 0, sheet = 0;
  let wetUntil = 0, clock = 0;

  /** Throw `n` drops on the lens (the camera just came out of the water). */
  function splash(n = 14) {
    if (reducedMotion()) return;
    for (let k = 0; k < n; k++) {
      const d = drops.find((x) => x.a <= 0.01) || drops.reduce((a, b) => (a.life < b.life ? a : b));
      d.x = 0.06 + Math.random() * 0.88;
      d.y = 0.08 + Math.random() * 0.8;
      d.r = 0.012 + Math.pow(Math.random(), 2.2) * 0.05;
      d.a = 1;
      d.vy = 0;
      d.life = 1.6 + Math.random() * 2.2;
      d.stick = Math.random() * 0.6;
    }
    wetUntil = clock + 4;
  }

  /** A shockwave at a screen position (uv, 0..1 top-left) with strength 0..1. */
  function shockwave(x, y, k = 1) {
    if (reducedMotion() || x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return;
    const r = ripples.reduce((a, b) => (a.age > b.age ? a : b));
    r.age = 0; r.k = Math.min(1, k);
    r.u.value.set(x, y, 0, r.k);
  }

  /**
   * Per frame. `s`: { w, h (CSS px), boost 0..1, final 0..1, blur bool, pip bool, pipRect [x0,y0,x1,y1],
   * sun {x, y, on} in uv }.
   */
  function update(dt, s) {
    clock += dt;
    const rm = reducedMotion();
    uRes.value.set(s.w, s.h);
    uAspect.value = s.w / Math.max(1, s.h);
    const ease = (cur, to, rate) => cur + (to - cur) * (1 - Math.exp(-rate * dt));

    for (const d of drops) {
      if (d.a <= 0) { d.u.value.w = 0; continue; }
      d.life -= dt;
      // a drop clings for a moment, then gravity wins: bigger drops run sooner and faster
      if (d.stick > 0) d.stick -= dt;
      else d.vy = Math.min(0.9, d.vy + (0.05 + d.r * 9) * dt);
      d.y += d.vy * dt;
      // small ones evaporate, the rest run off the bottom
      d.a = Math.max(0, Math.min(1, d.life / 0.7)) * (d.y > 1.1 ? 0 : 1);
      if (rm) d.a = 0;
      d.u.value.set(d.x, d.y, d.r * (1 + d.vy * 0.4), d.a);
    }
    for (const r of ripples) {
      if (r.age >= 1) { r.u.value.w = 0; continue; }
      r.age = Math.min(1, r.age + dt / 0.75);
      r.u.value.z = r.age;
    }
    fringe = ease(fringe, rm ? 0 : s.boost, 7);
    uFringe.value = fringe;
    uBlur.value = rm || !s.blur ? 0 : 0.6;
    const raysTo = withRays && s.sun && s.sun.on && !rm ? 0.18 + 0.82 * s.final : 0;
    rays = ease(rays, raysTo, 1.5);
    uRays.value = rays;
    if (s.sun) uSun.value.set(s.sun.x, s.sun.y);
    pipA = s.racing === false || !withPip ? 0 : ease(pipA, s.pip ? 1 : 0, 6);   // gone at once when the race ends
    uPipA.value = pipA < 0.002 ? 0 : pipA;
    if (s.pipRect) uPipRect.value.set(s.pipRect[0], s.pipRect[1], s.pipRect[2], s.pipRect[3]);
    sheet = clock < wetUntil ? 1 : 0;
  }

  return {
    build,
    update,
    splash,
    shockwave,
    pipTarget,
    pipCam,
    /** How visible the leader cam is right now (0..1): the scene skips rendering it at 0. */
    get pipAlpha() { return pipA; },
    get wet() { return sheet > 0; },
    get hasBlur() { return !!velTex; },
    get hasRays() { return withRays; },
    dispose() {
      pipTarget.dispose();
      for (const d of disposables) { try { d.dispose?.(); } catch { /* already gone */ } }
    },
  };
}
