// arena.js — the fight ring, breakable props, low-poly crowd and lighting.
import * as THREE from 'three-eco/webgpu';
import {
  Fn, Loop, abs, atan, attribute, cameraFar, cameraNear, cameraPosition, clamp, dot, exp, float, fract, instanceIndex,
  instancedArray, length, materialOpacity, max, mix, mod, modelWorldMatrixInverse, perspectiveDepthToViewZ,
  modelWorldMatrix, positionGeometry, positionLocal, positionView, screenCoordinate, select, sin, smoothstep, step,
  texture, uniform, vec2, vec3, vec4, viewportDepthTexture,
} from 'three-eco/tsl';
import { RectAreaLightTexturesLib } from 'three-eco/addons/lights/RectAreaLightTexturesLib.js';
import { createSoftGrid } from '../platform/softChain.js';
import { spawnBatch } from '../platform/debrisField.js';

export const RING_HALF = 5.2; // playable clamp radius (ring is 12x12, keep a margin)

/**
 * Teardown hook game.js calls before its scene.traverse() walk, for render targets
 * a geometry/material traverse cannot find. Currently nothing to release.
 */
export function disposeArenaReflector() { /* no reflector to dispose */ }

// Procedural ring-canvas texture: vinyl with a worn center, faint logo, scuff noise.
let _canvasTex = null;
function ringCanvasTexture() {
  if (_canvasTex) return _canvasTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // Event-blue canvas, lighter where the overhead lights pool in the middle.
  g.fillStyle = '#1f52c4';
  g.fillRect(0, 0, 256, 256);
  const wear = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  wear.addColorStop(0, 'rgba(215,230,255,0.16)');
  wear.addColorStop(1, 'rgba(215,230,255,0)');
  g.fillStyle = wear;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(128, 128, 42, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 2200; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5
      ? `rgba(255,255,255,${(v - 0.5) * 0.05})`
      : `rgba(0,0,20,${(0.5 - v) * 0.07})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1);
  }
  _canvasTex = new THREE.CanvasTexture(c);
  _canvasTex.colorSpace = THREE.SRGBColorSpace;
  return _canvasTex;
}

/**
 * @param {THREE.Scene} scene
 * @param {{rectAreaLights?: number}} [quality]
 *        rectAreaLights: how many of the two studio rig panels to build (0-2).
 *        Build-time only: light counts are shader #defines, so changing one live
 *        recompiles every lit material. See quality.js.
 */
// The hall, and the two lights that make the ring: values lighting.js re-applies every frame.
const HALL_COLOR = 0x070b1c;
export const KEY_INTENSITY = 4.1;
export const SPOT_INTENSITY = 2.4;

export function buildArena(scene, quality = {}) {
  // A big-event hall: dark, so the ring under its lights is the brightest thing in the
  // room. Deep blue, not black: an off-ring camera must not read as "the screen went black".
  scene.background = new THREE.Color(HALL_COLOR);
  // Exponential haze: fighters (4-6 m out) stay clean, crowd and hall melt away.
  scene.fog = new THREE.FogExp2(HALL_COLOR, 0.014);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardNodeMaterial({ color: 0x0b0e1c, roughness: 0.95, metalness: 0.0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(80, 40, 0x1a2040, 0x12162c);
  grid.position.y = -0.49;
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  scene.add(grid);

  // The apron: a strong blue skirt round the ring, as at a title fight.
  const ringMat = new THREE.MeshStandardNodeMaterial({
    color: 0x1b3aa6, roughness: 0.8, metalness: 0.05,
  });
  const ring = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 12), ringMat);
  ring.position.y = -0.25;
  ring.receiveShadow = true;
  scene.add(ring);

  // High roughness so the mat doesn't mirror the house lights.
  const canvasMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0,
    map: ringCanvasTexture(),
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.04, 11.6), canvasMat);
  top.position.y = 0.02;
  top.receiveShadow = true;
  scene.add(top);

  // Corner posts — breakable. The engine listens for collisions against these.
  const postMat = new THREE.MeshStandardNodeMaterial({
    color: 0x8a92c9, roughness: 0.7, metalness: 0.1,
  });
  const postGeo = new THREE.CylinderGeometry(0.08, 0.1, 1.5, 10);
  const posts = [];
  const half = 5.8;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.75, z);
      post.castShadow = true;
      post.receiveShadow = true;
      post.userData.breakable = true;
      post.userData.hp = 30;
      post.userData.maxHp = 30;
      post.userData.kind = 'post';
      post.userData.basePos = new THREE.Vector3(x, 0.75, z);
      scene.add(post);
      posts.push(post);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12),
        new THREE.MeshStandardNodeMaterial({ color: 0xd0d4f0, roughness: 0.85 })
      );
      cap.position.set(x, 1.55, z);
      cap.castShadow = true;
      cap.userData.attachedTo = post;
      scene.add(cap);

      // Turnbuckle pads in corner colour (red −X / blue +X): marks the corner hazard.
      const padColor = x < 0 ? 0xd23b30 : 0x3b6bff;
      const padMat = new THREE.MeshStandardNodeMaterial({
        color: padColor, roughness: 0.55, metalness: 0.05,
        emissive: padColor, emissiveIntensity: 0.12,
      });
      const padGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.26, 12);
      for (const py of [0.5, 0.9, 1.3]) {
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.position.set(x, py, z);
        pad.castShadow = true;
        pad.userData.turnbuckle = true;
        scene.add(pad);
      }
    }
  }

  // Ropes: spring-loaded bezier tubes (see updateRopes / twangRope).
  const ropeMat = new THREE.MeshStandardNodeMaterial({
    color: 0xd0d4f0, roughness: 0.85, metalness: 0.0,
  });
  const ropes = [];
  for (const y of [0.5, 0.9, 1.3]) {
    for (const axis of ['x', 'z']) {           // 'x' = runs along X (z = ±half)
      for (const sign of [-1, 1]) {
        const rope = {
          axis, sign, y, half,
          // The rope as a chain: how far each node is pushed outward, and how fast. The
          // two ends are the posts and never move. `offset` is the largest of them.
          d: new Float32Array(ROPE_NODES), v: new Float32Array(ROPE_NODES), shown: new Float32Array(ROPE_NODES),
          offset: 0,
          mesh: new THREE.Mesh(undefined, ropeMat),
        };
        rope.mesh.geometry = ropeGeometry(rope);
        scene.add(rope.mesh);
        ropes.push(rope);
      }
    }
  }

  // All light handles are returned so the engine can dim the house for the KO.
  // These are first-frame values; game.js _updateLighting's baselines must match.
  // Hemisphere fill kept low: much higher washes the frame into grey haze.
  const hemi = new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.22);
  scene.add(hemi);
  // The key comes down from the rig over the ring, nearly straight: the light of a big hall.
  const key = new THREE.DirectionalLight(0xfff6ea, KEY_INTENSITY);
  key.position.set(3, 14, 4);
  key.castShadow = true;
  // Build-time default = 'high' tier; _applyQuality retunes per tier. Over the ±6.5
  // frustum 2048 already exceeds what PCFSoft's kernel resolves, so 4096 buys nothing.
  key.shadow.mapSize.set(2048, 2048);
  // Frustum hugs the ring (fight area ±5.2, posts at ±5.8).
  key.shadow.camera.left = -6.5;
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 6.5;
  key.shadow.camera.bottom = -6.5;
  key.shadow.bias = -0.0005;
  // Too high and contact shadows detach from the feet (fighters look like they float).
  key.shadow.normalBias = 0.008;
  // PCFSoftShadowMap ignores shadow.radius; penumbra comes from mapSize vs frustum.
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6070ff, 1.0);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffe0a0, 0.6, 30, 1.4);
  fill.position.set(0, 6, 0);
  scene.add(fill);

  // Overhead spot; the KO cinematic brightens it and retargets it onto the loser.
  const spot = new THREE.SpotLight(0xfff4e0, SPOT_INTENSITY, 30, Math.PI / 4.5, 0.45, 1.2);
  spot.position.set(0, 11, 0);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  // Only matters for the KO push-in, where 1024 holds up. Build-time default =
  // 'high' tier; below high the spot stops casting. See quality.js.
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 6;
  scene.add(spot);
  scene.add(spot.target);

  // Studio RectAreaLights: broad soft speculars, no shadows. The costliest light
  // type (an LTC lookup on every physical fragment), so tiered 2/1/0. rectA goes
  // first: the cool back-right rectB is what separates fighters from the backdrop.
  const rectCount = quality.rectAreaLights ?? 2;
  let rectA = null;
  let rectB = null;
  if (rectCount > 0) {
    THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
    rectB = new THREE.RectAreaLight(0xdfe6ff, 2.6, 4.5, 3.2);
    rectB.position.set(3.6, 8.5, -3.6);
    rectB.lookAt(0, 0, 0);
    scene.add(rectB);
  }
  if (rectCount > 1) {
    rectA = new THREE.RectAreaLight(0xfff0d8, 3.4, 4.5, 3.2);
    rectA.position.set(-3.6, 8.5, 3.6);
    rectA.lookAt(0, 0, 0);
    scene.add(rectA);
  }

  // Corner identity lighting: red vs blue side, matching the HUD bars.
  const cornerA = new THREE.PointLight(0xff3b30, 1.7, 8, 1.8);
  cornerA.position.set(-6.2, 1.4, 0);
  scene.add(cornerA);
  const cornerB = new THREE.PointLight(0x3b6bff, 1.7, 8, 1.8);
  cornerB.position.set(6.2, 1.4, 0);
  scene.add(cornerB);

  // Unlit apron trim strips (red side / blue side / violet ends).
  const trimRed = new THREE.MeshBasicMaterial({ color: 0xff5a4a });
  const trimBlue = new THREE.MeshBasicMaterial({ color: 0x4a7dff });
  const trimEnd = new THREE.MeshBasicMaterial({ color: 0x584a9c });
  const trimZ = new THREE.BoxGeometry(0.08, 0.05, 11.6);
  const trimX = new THREE.BoxGeometry(11.6, 0.05, 0.08);
  for (const [geo, mat, x, z] of [
    [trimZ, trimRed, -5.82, 0],
    [trimZ, trimBlue, 5.82, 0],
    [trimX, trimEnd, 0, -5.82],
    [trimX, trimEnd, 0, 5.82],
  ]) {
    const strip = new THREE.Mesh(geo, mat);
    strip.position.set(x, 0.06, z);
    scene.add(strip);
  }

  const atmo = buildAtmosphere(scene, quality.renderer, spot);
  // The low tier (no area lights) gets the rig and its lamps but not the eight shafts.
  buildTruss(scene, (quality.rectAreaLights ?? 2) > 0);
  const backdrop = buildBackdrop(scene);
  const crowd = buildCrowd(scene, quality.renderer);
  scene.add(crowd);

  const flashes = buildCrowdFlashes(scene);
  // Held up for the last ten seconds and the result.
  const phones = buildPhoneLights(scene, crowd.userData.spots);

  return {
    posts, crowd, atmo, flashes, phones, ropes, backdrop,
    // For the engine's knockdown ripple; not findable by traversal without matching dimensions.
    canvasMat,
    lights: { hemi, key, rim, fill, spot, cornerA, cornerB, rectA, rectB },
  };
}

// ── Backdrop: overhead truss with rig lenses, hanging banners, jumbotrons ───
function buildBackdrop(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'backdrop';

  const steel = new THREE.MeshStandardNodeMaterial({
    color: 0x12141f, roughness: 0.7, metalness: 0.6,
  });

  // Sits above the spotlight so its shadow never matters.
  const trussY = 9.4;
  const trussHalf = 7.5;
  const beamLong = new THREE.BoxGeometry(trussHalf * 2, 0.22, 0.22);
  const beamSideGeo = new THREE.BoxGeometry(0.22, 0.22, trussHalf * 2);
  for (const z of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamLong, steel);
    beam.position.set(0, trussY, z);
    group.add(beam);
  }
  for (const x of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamSideGeo, steel);
    beam.position.set(x, trussY, 0);
    group.add(beam);
  }
  const braceGeo = new THREE.BoxGeometry(trussHalf * 2, 0.1, 0.1);
  for (const z of [-3.5, 0, 3.5]) {
    const brace = new THREE.Mesh(braceGeo, steel);
    brace.position.set(0, trussY - 0.15, z);
    group.add(brace);
  }

  // Decorative rig lenses (the real lights are in buildArena).
  const lensGeo = new THREE.BoxGeometry(0.3, 0.18, 0.3);
  const lensColors = [0xfff2d0, 0xbcd0ff, 0xfff2d0, 0xffd0d0];
  let li = 0;
  for (const x of [-5, -1.7, 1.7, 5]) {
    for (const z of [-trussHalf, trussHalf]) {
      const lens = new THREE.Mesh(lensGeo, new THREE.MeshStandardNodeMaterial({
        color: 0x0a0a0a, emissive: lensColors[li % lensColors.length],
        emissiveIntensity: 1.4, roughness: 0.4,
      }));
      lens.position.set(x, trussY - 0.28, z);
      // Tag for the engine's audio-reactive pulse; per-lens material so each pulses independently.
      lens.userData.rigLens = true;
      lens.userData.baseEmissive = 1.4;
      group.add(lens);
      li++;
    }
  }

  // Segmented so updateBanners can ripple each banner's own geometry clone.
  const bannerGeo = new THREE.PlaneGeometry(2.2, 4.0, 4, 12);
  const bannerRed = new THREE.MeshStandardNodeMaterial({
    color: 0x6a1f22, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x2a0a0c, emissiveIntensity: 0.4,
  });
  const bannerBlue = new THREE.MeshStandardNodeMaterial({
    color: 0x1f2f6a, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x0a1030, emissiveIntensity: 0.4,
  });
  const bannerSpots = [
    { x: -trussHalf + 0.3, z: 0, ry: Math.PI / 2, mat: bannerRed },
    { x: trussHalf - 0.3, z: 0, ry: Math.PI / 2, mat: bannerBlue },
    { x: 0, z: -trussHalf + 0.3, ry: 0, mat: bannerBlue },
    { x: 0, z: trussHalf - 0.3, ry: 0, mat: bannerRed },
  ];
  let bannerPhase = 0;
  for (const b of bannerSpots) {
    const geo = bannerGeo.clone();
    const banner = new THREE.Mesh(geo, b.mat);
    banner.position.set(b.x, trussY - 2.3, b.z);
    banner.rotation.y = b.ry;
    banner.userData.banner = true;
    banner.userData.phase = (bannerPhase += 1.7);
    // Rest pose for the ripple solve (local-space vertex positions).
    banner.userData.base = geo.attributes.position.array.slice();
    group.add(banner);
  }

  // Jumbotrons on the ±Z ends, high up.
  const screenTex = jumbotronTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, fog: true });
  const frameGeo = new THREE.BoxGeometry(6.4, 3.4, 0.3);
  const screenGeo = new THREE.PlaneGeometry(6.0, 3.0);
  for (const sign of [-1, 1]) {
    const frame = new THREE.Mesh(frameGeo, steel);
    frame.position.set(0, 6.4, sign * 14);
    group.add(frame);
    // 0.16 toward the ring so the frame never occludes it; faces inward.
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 6.4, sign * 13.84);
    screen.rotation.y = sign > 0 ? Math.PI : 0;
    group.add(screen);
  }

  group.userData.screenMat = screenMat;
  scene.add(group);
  return group;
}

// Procedural jumbotron feed: blocky colour smears plus scanlines.
let _jumboTex = null;
function jumbotronTexture() {
  if (_jumboTex) return _jumboTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1428';
  g.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 60; i++) {
    const hue = 200 + Math.random() * 60;
    g.fillStyle = `hsla(${hue}, 40%, ${30 + Math.random() * 30}%, 0.5)`;
    g.fillRect(Math.random() * 128, Math.random() * 64, 4 + Math.random() * 10, 3 + Math.random() * 8);
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 64; y += 2) g.fillRect(0, y, 128, 1);
  _jumboTex = new THREE.CanvasTexture(c);
  _jumboTex.colorSpace = THREE.SRGBColorSpace;
  return _jumboTex;
}

// ── Rope physics: quadratic-bezier tube, midpoint control on a damped spring ──
// A rope is a chain of ROPE_NODES points between two posts. Each point is pushed outward on
// its own, so the rope bends where a body leans into it and the bend travels along the rope
// to the posts and back, instead of the whole span bowing as one arc.
const ROPE_NODES = 17;
const ROPE_WAVE = 13;          // m/s a disturbance travels along the rope
const ROPE_PRESS_K = 160;      // how hard a leaning body holds the rope out
const ROPE_REST_K = 28;        // how hard the rope pulls itself straight
const ROPE_DAMP = 5.5;
const ROPE_REACH = 0.85;       // metres either side of a body that it presses
const _ropePts = Array.from({ length: ROPE_NODES }, () => new THREE.Vector3());

function ropeGeometry(rope) {
  const { axis, sign, y, half, d } = rope;
  for (let i = 0; i < ROPE_NODES; i++) {
    const along = -half + (2 * half * i) / (ROPE_NODES - 1);
    const out = sign * (half + d[i] * 1.6);
    // A pushed rope also dips a little: it is being stretched round the body.
    const drop = y - Math.abs(d[i]) * 0.18;
    if (axis === 'x') _ropePts[i].set(along, drop, out);
    else _ropePts[i].set(out, drop, along);
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(_ropePts.map((v) => v.clone())), 32, 0.022, 6);
}

// Per-frame rope solve. `fighters` is the engine's fighter list; a body
// leaning past the clamp margin presses the ropes on that side, where it is.
export function updateRopes(arena, dt, fighters, t = 0) {
  if (!arena.ropes) return;
  const pressStart = RING_HALF - 0.55; // bodies this far out start pressing
  const steps = 2, h = Math.min(dt, 1 / 30) / steps;
  for (const rope of arena.ropes) {
    const { d, v, half } = rope;
    const spacing = (2 * half) / (ROPE_NODES - 1);
    const tension = (ROPE_WAVE * ROPE_WAVE) / (spacing * spacing);
    // Tiny idle sway; the press response below dominates.
    const sway = 0.012 * Math.sin(t * 1.25 + rope.y * 3.1 + (rope.axis === 'x' ? 0 : 1.6));
    for (let step = 0; step < steps; step++) {
      for (let i = 1; i < ROPE_NODES - 1; i++) {
        const along = -half + spacing * i;
        let press = 0;
        if (fighters) {
          for (const f of fighters) {
            const p = f.rig.root.position;
            const at = rope.axis === 'x' ? p.x : p.z;
            const out = (rope.axis === 'x' ? p.z : p.x) * rope.sign - pressStart;
            if (out <= 0) continue;
            const gap = (at - along) / ROPE_REACH;
            // The middle rope (torso height) takes the most load.
            const w = rope.y === 0.9 ? 1.1 : 0.6;
            press = Math.max(press, Math.min(0.55, out * w) * Math.exp(-gap * gap));
          }
        }
        // A body only pushes: it holds the rope out, it never pulls it in.
        const hold = press > d[i] ? ROPE_PRESS_K * (press - d[i]) : 0;
        const acc = tension * (d[i - 1] + d[i + 1] - 2 * d[i]) + hold
          + ROPE_REST_K * (sway * Math.sin((Math.PI * i) / (ROPE_NODES - 1)) - d[i]) - ROPE_DAMP * v[i];
        v[i] += acc * h;
      }
      for (let i = 1; i < ROPE_NODES - 1; i++) d[i] += v[i] * h;
    }
    let moved = 0, peak = 0;
    for (let i = 1; i < ROPE_NODES - 1; i++) {
      moved = Math.max(moved, Math.abs(d[i] - rope.shown[i]));
      if (Math.abs(d[i]) > Math.abs(peak)) peak = d[i];
    }
    rope.offset = peak;
    if (moved > 0.004) {
      rope.mesh.geometry.dispose();
      rope.mesh.geometry = ropeGeometry(rope);
      rope.shown.set(d);
    }
  }
}

// One-shot twang from a rope-clamp event: a kick outward, strongest mid-span, that the
// chain then carries to the posts and back.
export function twangRope(arena, clampAxis, sign, power = 1) {
  if (!arena.ropes) return;
  for (const rope of arena.ropes) {
    // A clamp on world X hits the ropes that run along Z at x = sign*half.
    const runsAlong = clampAxis === 'x' ? 'z' : 'x';
    if (rope.axis === runsAlong && rope.sign === sign) {
      for (let i = 1; i < ROPE_NODES - 1; i++) rope.v[i] += 2.6 * power * Math.sin((Math.PI * i) / (ROPE_NODES - 1));
    }
  }
}

// ── Banner ripple: a driven traveling wave, amplitude growing toward the free
// bottom edge (top hem pinned). No solver.
// Each banner is a soft grid (platform/softChain.js) matching its 5 × 13 vertex layout:
// pinned along the top, shape memory pulling it back to hanging straight. The old sine
// sway stays as the idle draft; `kick` (a one-shot from the shared impulse profile — a
// KO, a heavy hit) gusts every banner outward and the soft grid carries the swing and
// the settle. Presentation only.
const _soft = { x: 0, y: 0, z: 0 };
export function updateBanners(backdrop, t, dt = 1 / 60, kick = 0) {
  if (!backdrop) return;
  let n = 0;
  backdrop.traverse((o) => {
    if (!o.userData || !o.userData.banner || !o.geometry) return;
    const pos = o.geometry.attributes.position;
    const base = o.userData.base;
    const ph = o.userData.phase || 0;
    let soft = o.userData.soft;
    if (!soft && pos.count === 65) {
      soft = o.userData.soft = createSoftGrid({ cols: 5, rows: 13, width: 2.2, height: 4, pin: 'top', memory: 0.04 });
    }
    if (soft) {
      // Alternate the push so the four banners read as blown OUT from the ring.
      if (kick > 0.01) soft.impulse(0, 0.4 * kick, (n % 2 ? 1 : -1) * 3.2 * kick, dt);
      soft.setForce(0, 0, 0.25 * Math.sin(t * 0.6 + ph));
      soft.step(dt);
    }
    n++;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      // by spans [-2, 2] (height 4); +2 is the pinned top, -2 the free bottom.
      const droop = (2.0 - by) / 4.0;            // 0 at top → 1 at bottom
      const amp = 0.22 * droop * droop;
      const z = amp * Math.sin(t * 1.7 + bx * 1.6 + by * 0.7 + ph);
      if (soft) soft.offset(i, _soft); else { _soft.x = 0; _soft.y = 0; _soft.z = 0; }
      pos.array[i * 3 + 2] = base[i * 3 + 2] + z + _soft.z;
      pos.array[i * 3] = bx + amp * 0.4 * Math.sin(t * 1.1 + by * 0.9 + ph) + _soft.x;
      pos.array[i * 3 + 1] = by + _soft.y;
    }
    pos.needsUpdate = true;
    // Normals deliberately not recomputed: a per-frame main-thread cost for dim banners.
  });
}

// ── The lighting rig: a truss over the ring, its lamps, and their beams ──
// What makes it a big-event hall is seeing where the light comes from: a square of truss
// hung over the ring, a lamp head every few metres burning far brighter than anything it
// lights (so the bloom catches each one), and a shaft from each down onto the canvas. The
// shafts are painted cones, not lights: eight more real lights would cost every lit pixel in
// the scene, and the key and the spot above already do the lighting.
const TRUSS_Y = 10.4;
const TRUSS_HALF = 4.7;
// Each lamp: where on the truss, where on the canvas it points, and its colour. The corners
// are white, the sides carry the two corners' colours and a cool pair.
const LAMPS = [
  [[-1, -1], [1.6, 1.2], 0xfff3df], [[1, -1], [-1.6, 1.2], 0xfff3df],
  [[-1, 1], [1.6, -1.2], 0xfff3df], [[1, 1], [-1.6, -1.2], 0xfff3df],
  [[-1, 0], [0.9, 0], 0xff6a55], [[1, 0], [-0.9, 0], 0x5f93ff],
  [[0, -1], [0, 1.4], 0xcfe2ff], [[0, 1], [0, -1.4], 0xcfe2ff],
];
let _shaftTex = null;
function shaftTexture() {
  if (_shaftTex) return _shaftTex;
  const c = document.createElement('canvas');
  c.width = 1; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');      // at the lamp
  grad.addColorStop(0.35, 'rgba(255,255,255,0.32)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');        // spent by the canvas
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  return (_shaftTex = new THREE.CanvasTexture(c));
}

function buildTruss(scene, shafts = true) {
  const group = new THREE.Group();
  group.userData.kind = 'truss';
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x1b1e2a, roughness: 0.55, metalness: 0.7 });
  const span = 2 * TRUSS_HALF + 0.3;
  for (const [x, z, w, d] of [[0, -TRUSS_HALF, span, 0.22], [0, TRUSS_HALF, span, 0.22], [-TRUSS_HALF, 0, 0.22, span], [TRUSS_HALF, 0, 0.22, span]]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), metal);
    beam.position.set(x, TRUSS_Y, z);
    group.add(beam);
  }
  const headGeo = new THREE.CylinderGeometry(0.17, 0.24, 0.34, 12);
  const lensGeo = new THREE.CircleGeometry(0.2, 16);
  const up = new THREE.Vector3(0, 1, 0);
  const from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
  for (const [[lx, lz], [tx, tz], hex] of LAMPS) {
    from.set(lx * TRUSS_HALF, TRUSS_Y - 0.3, lz * TRUSS_HALF);
    to.set(tx, 0.04, tz);
    dir.copy(from).sub(to);
    const length = dir.length();
    dir.normalize();
    const aim = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const head = new THREE.Mesh(headGeo, metal);
    head.position.copy(from);
    head.quaternion.copy(aim);
    group.add(head);
    // The lens: far brighter than white, so the bloom makes a lamp of it.
    const color = new THREE.Color(hex);
    const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicNodeMaterial({
      color: color.clone().multiplyScalar(5), side: THREE.DoubleSide, fog: false,
    }));
    lens.position.copy(from).addScaledVector(dir, -0.18);
    lens.quaternion.copy(aim).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    group.add(lens);
    if (!shafts) continue;
    // The shaft: narrow at the lamp, a couple of metres wide where it meets the canvas.
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 1.5, length, 14, 1, true),
      new THREE.MeshBasicMaterial({
        map: shaftTexture(), color, transparent: true, opacity: 0.06,
        // Front faces only: a shaft is seen from outside, and drawing its far side as well
        // doubles the pixels eight big cones fill.
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, fog: false,
      }));
    shaft.position.copy(from).addScaledVector(dir, -length / 2);
    shaft.quaternion.copy(aim);
    shaft.renderOrder = 2;
    group.add(shaft);
  }
  for (const o of group.children) { o.castShadow = false; o.receiveShadow = false; }
  scene.add(group);
  return group;
}

// ── Atmosphere: the spotlight's beam through the hall's haze ──
// Where the renderer can (WebGPU), the beam is a volume: each pixel marches the ray from the
// lens through the cone and adds up the lit haze along it, so the shaft has depth, is denser
// seen down its length than across it, brightens toward the lamp, and stops at whatever
// solid thing the ray meets first (a fighter standing in the beam is in front of the haze
// behind them, and behind the haze in front). While the lamp is casting shadows (the high
// tier), every step also asks its shadow map whether the lamp can see that point, so a
// fighter in the beam throws a dark shaft down through the haze below them.
// Elsewhere it is the painted cone below.
const BEAM_STEPS = 28;
const BEAM_TOP = 0.35, BEAM_BOTTOM = 4.2, BEAM_HALF = 5;      // the cone's own shape (see geometry)
const BEAM_GAIN = 0.62;

function beamMaterial(spot) {
  // The lamp's shadow map is made on its first shadow pass, after this material: a stand-in
  // depth texture with the same comparison holds the slot until `sync` can bind the real one.
  const standIn = new THREE.DepthTexture(1, 1);
  standIn.compareFunction = THREE.LessEqualCompare;
  const shadowMap = texture(standIn);
  const shadowOn = uniform(0);
  const shadowMatrix = uniform(spot ? spot.shadow.matrix : new THREE.Matrix4());
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false,
    // Back faces only, untested against depth: one fragment per pixel that the whole volume
    // lies in front of, even with the lens inside the cone. Occlusion is done below.
    side: THREE.BackSide, depthTest: false, fog: false,
  });
  material.colorNode = Fn(() => {
    // In the cone's own space, where it is an upright frustum whatever way the lamp points.
    const from = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const span = positionLocal.sub(from);
    // No further than the first solid surface on this ray.
    const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
    const reach = clamp(sceneZ.div(positionView.z), 0, 1);
    // A different start along the ray for every pixel turns the steps' banding into grain.
    const jitter = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));
    const lit = float(0).toVar();
    Loop(BEAM_STEPS, ({ i }) => {
      const p = from.add(span.mul(float(i).add(jitter).div(BEAM_STEPS).mul(reach)));
      const up = p.y.add(BEAM_HALF).div(2 * BEAM_HALF);                 // 0 at the canvas, 1 at the lamp
      const radial = length(p.xz).div(mix(BEAM_BOTTOM, BEAM_TOP, up));
      // Inside the frustum, soft toward its edge, and thicker toward the lamp.
      const inside = step(abs(p.y), BEAM_HALF).mul(smoothstep(0.5, 1, radial).oneMinus());
      // Can the lamp see this point? The same lookup the lit surfaces make (three's
      // ShadowNode): into the lamp's clip space, y flipped, compared against its depth map.
      const inLamp = shadowMatrix.mul(modelWorldMatrix.mul(vec4(p, 1)));
      const sc = inLamp.xyz.div(inLamp.w);
      const seen = shadowMap.sample(vec2(sc.x, sc.y.oneMinus())).compare(sc.z.sub(0.002));
      const inMap = step(0, sc.x).mul(step(sc.x, 1)).mul(step(0, sc.y)).mul(step(sc.y, 1)).mul(step(sc.z, 1));
      const unshadowed = mix(1, seen, shadowOn.mul(inMap));
      lit.addAssign(inside.mul(mix(0.3, 1, up.mul(up))).mul(unshadowed));
    });
    const depth = length(span).mul(reach);
    return vec3(1, 0.955, 0.88).mul(lit.div(BEAM_STEPS)).mul(depth).mul(materialOpacity).mul(BEAM_GAIN);
  })();
  /** Per frame: bind the lamp's shadow map once it exists, and follow whether it is casting. */
  material.userData.sync = () => {
    const depth = spot?.shadow?.map?.depthTexture;
    if (depth && shadowMap.value !== depth && depth.compareFunction === THREE.LessEqualCompare) shadowMap.value = depth;
    shadowOn.value = depth && shadowMap.value === depth && spot.castShadow ? 1 : 0;
  };
  return material;
}

function buildAtmosphere(scene, renderer = null, spot = null) {
  if (renderer?.backend?.isWebGPUBackend && !/[?&]brawlBeam=off/.test(globalThis.location?.search ?? '')) {
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(BEAM_TOP, BEAM_BOTTOM, 2 * BEAM_HALF, 24, 1, false), beamMaterial(spot));
    cone.position.y = 5.6;
    cone.renderOrder = 2;
    cone.frustumCulled = false;
    scene.add(cone);
    return { cone };
  }

  const c = document.createElement('canvas');
  c.width = 1; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,244,224,0.55)');
  grad.addColorStop(1, 'rgba(255,244,224,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  const tex = new THREE.CanvasTexture(c);

  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 4.2, 10, 24, 1, true),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.09,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    })
  );
  cone.position.y = 5.6;
  cone.renderOrder = 2;
  scene.add(cone);
  return { cone };
}

// Pooled crowd camera-flash sprites (also borrowed by pressBurst).
function buildCrowdFlashes(scene) {
  const group = new THREE.Group();
  const pool = [];
  // Round glow map: a mapless sprite is a hard square, obvious at press-row size.
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const glow = new THREE.CanvasTexture(c);
  for (let i = 0; i < 20; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, fog: false,
    }));
    s.scale.setScalar(0.14);
    s.visible = false;
    group.add(s);
    pool.push({ sprite: s, life: 0 });
  }
  scene.add(group);
  return pool;
}

// Phone lights above random heads: one shared material faded by updateAtmosphere's
// `phones` level; each sways on its own phase.
function buildPhoneLights(scene, spots) {
  const group = new THREE.Group();
  const pool = [];
  const mat = new THREE.SpriteMaterial({
    color: 0xdfe8ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  for (let i = 0; i < 36 && spots.length; i++) {
    const seat = (Math.random() * spots.length) | 0;
    const m = spots[seat];
    const s = new THREE.Sprite(mat);
    s.scale.set(0.06, 0.1, 1);
    // The seat it is held over, so setCrowdFill can put it away with an empty seat.
    s.userData.seat = seat;
    s.userData.base = new THREE.Vector3(m.x, m.y + 0.32 + Math.random() * 0.12, m.z);
    s.userData.phase = Math.random() * Math.PI * 2;
    s.position.copy(s.userData.base);
    group.add(s);
    pool.push(s);
  }
  group.visible = false;
  scene.add(group);
  return { group, pool, mat };
}

// Ringside press burst: bigger HDR flashes from the crowd-flash pool; `delay`
// staggers them so it reads as several photographers.
const PRESS_R = 6.6;
export function pressBurst(arena, n) {
  const flashes = arena?.flashes;
  if (!flashes) return;
  for (let i = 0; i < n; i++) {
    const free = flashes.find((f) => f.life <= 0 && !(f.delay > 0));
    if (!free) return;
    const a = Math.random() * Math.PI * 2;
    const r = PRESS_R + Math.random() * 0.5;
    free.sprite.position.set(Math.sin(a) * r, 0.9 + Math.random() * 0.7, Math.cos(a) * r);
    free.sprite.scale.setScalar(0.34 + Math.random() * 0.12);
    // > 1 is deliberate: the composer is HDR, so the bloom pass flares these.
    free.sprite.material.color.setScalar(2.4);
    free.dur = free.life = 0.12;
    free.delay = i === 0 ? 0.0001 : Math.random() * 0.35;
    free.sprite.visible = false;
  }
}

// Per-frame: crowd flashes (a storm while `excited` > 0); phone lights fade with `phones` (0..1).
export function updateAtmosphere(arena, dt, t, excited, phones = 0) {
  const { flashes, crowd } = arena;
  if (flashes && crowd) {
    const rate = 1.2 + excited * 22; // expected flashes per second
    if (Math.random() < rate * dt) {
      const free = flashes.find((f) => f.life <= 0 && !(f.delay > 0));
      // Only occupied seats take pictures (setCrowdFill thins the tournament's early rounds).
      const spots = crowd.userData.liveSpots || crowd.userData.spots;
      if (free && spots && spots.length) {
        const m = spots[(Math.random() * spots.length) | 0];
        free.sprite.position.set(
          m.x + (Math.random() - 0.5) * 0.3,
          m.y + 0.15 + Math.random() * 0.25,
          m.z + (Math.random() - 0.5) * 0.3
        );
        free.sprite.scale.setScalar(0.14);
        free.sprite.material.color.setScalar(1);
        free.dur = free.life = 0.09;
        free.sprite.visible = true;
      }
    }
    for (const f of flashes) {
      if (f.delay > 0) {
        f.delay -= dt;
        if (f.delay > 0) continue;
        f.sprite.visible = true;
      }
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / (f.dur || 0.09));
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
  }
  const ph = arena.phones;
  if (ph) {
    ph.group.visible = phones > 0.01;
    if (ph.group.visible) {
      ph.mat.opacity = Math.min(1, phones) * 0.9;
      for (const s of ph.pool) {
        const b = s.userData.base, q = s.userData.phase + t * 0.9;
        // dx/dz/lift: the beat sway and the stadium wave (ledBoards.js), 0 when idle.
      const u = s.userData;
      s.position.set(b.x + Math.sin(q) * 0.06 + (u.dx || 0), b.y + Math.sin(q * 1.3) * 0.03 + (u.lift || 0), b.z + (u.dz || 0));
      }
    }
  }
}

// Instanced crowd (torsos + heads = 2 draw calls), animated in the vertex stage.
// positionNode runs after the instance transform, so positionLocal here is already the
// seat's place in the stands: every offset is in metres and the seat's angle is its own XZ.
//
//   bounce   per-instance aPhase sway, larger as uExcited rises
//   wave     the stadium wave (ledBoards.js): uWave = (front angle, rise m, half-width rad, 0)
//   lean     everyone tips toward uFocus (the action's XZ; z = strength 0..1), heads most
//   react    a heavy hit at uImpact (x, z, seconds since, power) rolls out through the
//            stands: the nearest seats jump and rock back first, the far side a beat later
//
// `lift` is how much of the lean this mesh takes: a torso tips from its base (0 at the
// seat, 1 at the shoulders), a head rides the top of it.
function crowdBounceMaterial(uniforms, head = false, memory = null) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.9 });
  const { uTime, uExcited, uWave, uFocus, uImpact } = uniforms;
  const seat = positionLocal.xz;
  const crowdPhase = attribute('aPhase', 'float').add(uTime.mul(1.4));
  // With memory (WebGPU), each spectator's own on-their-feet level drives the bounce and
  // lifts them out of the seat; without it, everyone follows the one excitement value.
  const level = memory ? memory.state.toAttribute().x : uExcited;
  const stand = memory ? level.mul(0.26) : 0;
  const bounce = sin(crowdPhase).mul(0.025).add(sin(crowdPhase.mul(1.8)).mul(0.18).mul(level)).add(stand);
  // Seats stand as the band passes (an empty seat's zero matrix still collapses it).
  const dA = mod(atan(seat.x, seat.y).sub(uWave.x).add(3.14159265), 6.2831853).sub(3.14159265);
  const wave = uWave.y.mul(exp(dA.mul(dA).negate().div(uWave.z.mul(uWave.z))));

  const lift = head ? 1.15 : smoothstep(-0.45, 0.45, positionGeometry.y);
  const toFocus = uFocus.xy.sub(seat);
  const lean = toFocus.div(max(length(toFocus), 0.001)).mul(uFocus.z).mul(0.11).mul(lift);

  // The reaction travels outward at ~9 m/s and is spent after about a second.
  const toHit = seat.sub(uImpact.xy);
  const dist = length(toHit);
  const since = uImpact.z.sub(dist.div(9));
  const pulse = smoothstep(0, 0.07, since).mul(exp(since.mul(-4.2))).mul(uImpact.w)
    .mul(smoothstep(6, 22, dist).oneMinus().mul(0.75).add(0.25));
  const recoil = toHit.div(max(dist, 0.001)).mul(pulse).mul(0.16).mul(lift);
  const jump = pulse.mul(0.2).mul(sin(since.mul(13)).mul(0.5).add(0.5));

  const sway = vec2(lean.x.add(recoil.x), lean.y.add(recoil.y));
  mat.positionNode = positionLocal.add(vec3(sway.x, bounce.add(wave).add(jump), sway.y));
  return mat;
}

// Crowd with memory (WebGPU only): every spectator carries a level of their own, how far
// out of the seat they are, updated on the GPU each frame. A heavy hit or a rising crowd
// brings them to their feet at their own pace, the excitable ones first and highest, and
// they sit back down one by one afterwards instead of all dropping with the excitement value.
function createCrowdMemory(renderer, total, uniforms) {
  if (!renderer?.backend?.isWebGPUBackend) return null;
  const seats = instancedArray(total, 'vec4');     // x, z, temperament 0..1, spare
  const state = instancedArray(total, 'vec4');     // x: on-their-feet level 0..1
  const dt = uniform(1 / 60);
  const pass = Fn(() => {
    const seat = seats.element(instanceIndex), s = state.element(instanceIndex);
    const temper = seat.z;
    // The same travelling reaction the vertex stage uses for the flinch, held for longer here.
    const dist = length(seat.xy.sub(uniforms.uImpact.xy));
    const since = uniforms.uImpact.z.sub(dist.div(9));
    const pulse = smoothstep(0, 0.07, since).mul(exp(max(since, 0).mul(-1.4))).mul(uniforms.uImpact.w)
      .mul(smoothstep(6, 22, dist).oneMinus().mul(0.75).add(0.25));
    const want = clamp(
      uniforms.uExcited.mul(temper.mul(0.9).add(0.3)).add(pulse.mul(1.5)).sub(temper.oneMinus().mul(0.22)), 0, 1);
    // Up fast, down slowly, and each at their own speed.
    const rate = select(want.greaterThan(s.x), temper.mul(5).add(3), temper.oneMinus().mul(0.5).add(0.22));
    const level = s.x.add(want.sub(s.x).mul(exp(rate.mul(dt).negate()).oneMinus()));
    state.element(instanceIndex).assign(vec4(level, 0, 0, 0));
  })().compute(total);
  return {
    seats, state,
    step(seconds) { dt.value = Math.min(Math.max(seconds, 0), 0.1); renderer.compute(pass); },
    dispose() { pass.dispose?.(); },
  };
}

function buildCrowd(scene, renderer = null) {
  const group = new THREE.Group();
  group.userData.kind = 'crowd';

  const skins = [0xb88a6a, 0x6b4a32, 0xd8a67f, 0x8a5d3f];
  const shirts = [0x4a4a4a, 0x252540, 0x5a2f2f, 0x2f4a3a, 0x3a3a5c, 0x6b5a2f];

  const ring = 7.6;
  const rows = [
    { r: ring, count: 24 },
    { r: ring + 1.6, count: 32 },
    { r: ring + 3.4, count: 40 },
    { r: ring + 5.5, count: 48 },
  ];
  const total = rows.reduce((n, r) => n + r.count, 0);

  const uniforms = {
    uTime: uniform(0), uExcited: uniform(0), uWave: uniform(new THREE.Vector4(0, 0, 0.4, 0)),
    uFocus: uniform(new THREE.Vector3(0, 0, 0)),          // x, z, strength
    uImpact: uniform(new THREE.Vector4(0, 0, 99, 0)),     // x, z, seconds since, power
  };
  const memory = createCrowdMemory(renderer, total, uniforms);
  const torsoMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.42, 0.9, 0.28), crowdBounceMaterial(uniforms, false, memory), total);
  const headMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.24, 0.26, 0.24), crowdBounceMaterial(uniforms, true, memory), total);
  torsoMesh.castShadow = false;
  headMesh.castShadow = false;

  const phases = new Float32Array(total);
  const spots = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();

  let id = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const a = (i / row.count) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
      const x = Math.sin(a) * row.r + (Math.random() - 0.5) * 0.4;
      const z = Math.cos(a) * row.r + (Math.random() - 0.5) * 0.4;
      const y = -0.45;
      const heightJitter = 0.92 + Math.random() * 0.18;
      const yaw = Math.atan2(-x, -z) + (Math.random() - 0.5) * 0.6;
      q.setFromAxisAngle(up, yaw);

      // Torso: height jitter via Y scale (its box is 0.9 tall around origin).
      s.set(1, heightJitter, 1);
      p.set(x, y + 0.45 * heightJitter, z);
      m.compose(p, q, s);
      torsoMesh.setMatrixAt(id, m);
      torsoMesh.setColorAt(id, color.setHex(shirts[(Math.random() * shirts.length) | 0]));

      s.set(1, 1, 1);
      p.set(x, y + 1.05 * heightJitter, z);
      m.compose(p, q, s);
      headMesh.setMatrixAt(id, m);
      headMesh.setColorAt(id, color.setHex(skins[(Math.random() * skins.length) | 0]));

      phases[id] = Math.random() * Math.PI * 2;
      if (memory) memory.seats.value.array.set([x, z, Math.random(), 0], id * 4);
      spots.push({ x, y: y + 1.05 * heightJitter, z });
      id++;
    }
  }
  const phaseAttr = new THREE.InstancedBufferAttribute(phases, 1);
  torsoMesh.geometry.setAttribute('aPhase', phaseAttr);
  headMesh.geometry.setAttribute('aPhase', phaseAttr);
  torsoMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (torsoMesh.instanceColor) torsoMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  group.add(torsoMesh, headMesh);
  if (memory) memory.seats.value.needsUpdate = true;
  group.userData.memory = memory;
  group.userData.uniforms = uniforms;
  // Head positions for the camera-flash sprites (updateAtmosphere).
  group.userData.spots = spots;
  return group;
}

// ── Tournament: the hall fills in round by round ─────────────────────────
// `fill` 0..1 is the share of seats taken. Seats fill front rows first (a random
// order weighted by row), so a thin quarterfinal crowd reads as "doors just opened",
// not as a rendering hole. Empty seats get a zero matrix (degenerate, never drawn),
// so the crowd stays two draw calls; phones held over empty seats are put away and
// the camera flashes only pop over occupied ones (liveSpots). A one-off upload per
// bout, so every tier gets it.
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
export function setCrowdFill(arena, fill) {
  const crowd = arena?.crowd;
  const [torso, head] = crowd?.children || [];
  if (!torso?.isInstancedMesh || !head?.isInstancedMesh) return;
  const ud = crowd.userData;
  const total = torso.count;
  if (!ud.fillOrder) {
    ud.torsoBase = torso.instanceMatrix.array.slice();
    ud.headBase = head.instanceMatrix.array.slice();
    // Rows are built inner to outer (24, 32, 40, 48 seats), so the row is recoverable
    // from the index; the bias makes the front rows fill first.
    const rowOf = (i) => (i < 24 ? 0 : i < 56 ? 1 : i < 96 ? 2 : 3);
    ud.fillOrder = Array.from({ length: total }, (_, i) => i)
      .map((i) => ({ i, k: Math.random() + rowOf(i) * 0.45 }))
      .sort((a, b) => a.k - b.k)
      .map((e) => e.i);
  }
  const taken = Math.round(THREE.MathUtils.clamp(fill, 0, 1) * total);
  if (ud.fillTaken === taken) return;
  ud.fillTaken = taken;
  const on = new Uint8Array(total);
  for (let n = 0; n < taken; n++) on[ud.fillOrder[n]] = 1;
  for (let i = 0; i < total; i++) {
    if (on[i]) {
      torso.instanceMatrix.array.set(ud.torsoBase.subarray(i * 16, i * 16 + 16), i * 16);
      head.instanceMatrix.array.set(ud.headBase.subarray(i * 16, i * 16 + 16), i * 16);
    } else {
      torso.setMatrixAt(i, _zeroMat);
      head.setMatrixAt(i, _zeroMat);
    }
  }
  torso.instanceMatrix.needsUpdate = true;
  head.instanceMatrix.needsUpdate = true;
  // The culling bounds are derived from the instance matrices: re-derive them.
  torso.boundingSphere = head.boundingSphere = null;
  ud.liveSpots = ud.spots.filter((_, i) => on[i]);
  for (const s of arena.phones?.pool || []) s.visible = !!on[s.userData.seat];
}

// Camera flashbulbs all over the stands (the champion's ceremony): `n` small HDR
// sprites from the crowd-flash pool, staggered so it reads as a hundred cameras rather
// than one strobe. Local sprites only, never whole-frame brightness (the flicker rule).
export function flashbulbs(arena, n) {
  const flashes = arena?.flashes;
  const spots = arena?.crowd?.userData.liveSpots || arena?.crowd?.userData.spots;
  if (!flashes || !spots?.length) return;
  for (let i = 0; i < n; i++) {
    const free = flashes.find((f) => f.life <= 0 && !(f.delay > 0));
    if (!free) return;
    const m = spots[(Math.random() * spots.length) | 0];
    free.sprite.position.set(m.x + (Math.random() - 0.5) * 0.3, m.y + 0.2 + Math.random() * 0.3, m.z + (Math.random() - 0.5) * 0.3);
    free.sprite.scale.setScalar(0.17 + Math.random() * 0.1);
    free.sprite.material.color.setScalar(1.8);
    free.dur = free.life = 0.08 + Math.random() * 0.05;
    free.delay = 0.0001 + Math.random() * 0.12;
    free.sprite.visible = false;
  }
}

// ── Tournament lighting: undercard → co-main → main event ──────────────
// One look per round, as multipliers on _updateLighting's own baselines plus the colours,
// key-light angle, haze and hall tint. All three are a big hall lit from its rig; what
// changes is how much of the hall the lights hold. The engine eases between them under the
// bout's VS splash (cup.js), so the hall changes over a couple of seconds, never in one
// frame. Other modes never read this table.
//   0 quarterfinals — the house is up: a bright, even, white ring, the hall still visible.
//   1 semifinals    — the house comes down: cooler key, stronger rim and corner colour.
//   2 final         — the main event: the hall is black, one hot tight spot on the canvas.
export const ROUND_LOOKS = [
  {
    key: 0xfff6ea, keyMul: 1.0, keyPos: [3, 14, 4],
    hemiSky: 0xc4d4ff, hemiGround: 0x121830, hemiMul: 1.15,
    fill: 0xffecd2, fillMul: 1.1, rimMul: 1.0, spotMul: 1.0,
    spotAngle: Math.PI / 4.5, spotPenumbra: 0.45, cornerMul: 1.0, backMul: 1.0, rectMul: 1.0,
    hall: 0x0a1026, fog: 0.014, haze: 0.09,
  },
  {
    key: 0xeef2ff, keyMul: 0.9, keyPos: [2, 14, 2],
    hemiSky: 0x9cb2ff, hemiGround: 0x0c1028, hemiMul: 0.85,
    fill: 0xffdcb8, fillMul: 0.9, rimMul: 1.4, spotMul: 1.4,
    spotAngle: Math.PI / 5.2, spotPenumbra: 0.4, cornerMul: 1.3, backMul: 1.2, rectMul: 0.85,
    hall: 0x070b1e, fog: 0.018, haze: 0.13,
  },
  {
    key: 0xe2e9ff, keyMul: 0.7, keyPos: [1, 15, 1],
    hemiSky: 0x7f92e0, hemiGround: 0x05060f, hemiMul: 0.6,
    fill: 0xffd9a8, fillMul: 0.6, rimMul: 1.6, spotMul: 2.4,
    spotAngle: Math.PI / 8, spotPenumbra: 0.3, cornerMul: 1.4, backMul: 1.4, rectMul: 0.5,
    hall: 0x03050d, fog: 0.024, haze: 0.2,
  },
];

// Feeds the crowd shader's clock and excitement uniforms.
export function animateCrowd(crowd, dt, t, excited, focus = null) {
  const u = crowd?.userData.uniforms;
  if (!u) return;
  u.uTime.value = t;
  u.uExcited.value = excited;
  // Lean toward the action, eased so a fighter crossing the ring turns heads, not snaps them.
  // No focus (reduced motion, between bouts): the stands sit back up.
  const f = u.uFocus.value, k = 1 - Math.exp(-dt * 2.5);
  if (focus) { f.x += (focus.x - f.x) * k; f.y += (focus.z - f.y) * k; }
  f.z += ((focus ? 0.45 + 0.55 * Math.min(1, excited) : 0) - f.z) * k;
  u.uImpact.value.z += dt;
  crowd.userData.memory?.step(dt);
}

/**
 * A heavy hit lands at world (x, z): the stands flinch, nearest seats first. `power` 0..1.
 * A weaker hit never cuts a stronger reaction short.
 */
export function crowdReact(crowd, x, z, power = 1) {
  const u = crowd?.userData.uniforms;
  if (!u) return;
  const v = u.uImpact.value;
  const left = v.w * Math.exp(-Math.max(0, v.z) * 4.2);
  if (power < left) return;
  v.set(x, z, 0, Math.min(1, power));
}

// Knock chunks off a post on collision. Returns the debris meshes for the engine
// to integrate into its particle update list.
const _debrisGeo = new THREE.BoxGeometry(0.18, 0.06, 0.18);
const _debrisMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a92c9, roughness: 0.6 });
// `blast` (optional): { dir: {x,y,z}, momentum: {x,y,z}, seed } — the chunks leave in the
// direction the fighter hit the post and carry the fighter's momentum (platform/debrisField.js),
// instead of a random spray. Seeded, so the same break throws the same chunks.
export function damagePost(post, dmg, scene, blast = null) {
  if (!post || !post.userData.breakable) return [];
  post.userData.hp -= dmg;
  const debris = [];
  if (post.userData.hp <= 0 && post.userData.hp > -1000) {
    post.userData.hp = -1000; // sentinel to avoid re-spawning
    const bp = post.userData.basePos;
    const batch = spawnBatch({
      origin: { x: bp.x, y: bp.y, z: bp.z },
      dir: blast?.dir || { x: 0, y: 1, z: 0 },
      parentVelocity: blast?.momentum ? {
        x: blast.momentum.x * 0.35, y: Math.max(0, blast.momentum.y || 0) * 0.35, z: blast.momentum.z * 0.35,
      } : null,
      impulse: 70,
      material: 'metal',
      count: 5,
      seed: blast?.seed ?? 1,
      spread: blast?.dir ? 0.5 : 1,
      lift: 0.6,
      volume: 0.0009,
      maxSpeed: 7,
      life: 1.5,
    });
    for (const c of batch) {
      const chunk = new THREE.Mesh(_debrisGeo, _debrisMat.clone());
      chunk.position.copy(bp);
      chunk.userData.kind = 'debris';
      chunk.userData.vel = new THREE.Vector3(c.vx, c.vy, c.vz);
      chunk.userData.angVel = new THREE.Vector3(c.ax, c.ay, c.az);
      chunk.userData.life = c.life;
      scene.add(chunk);
      debris.push(chunk);
    }
    post.visible = false;
    post.parent && post.parent.traverse?.((o) => {
      if (o.userData && o.userData.attachedTo === post) o.visible = false;
    });
  }
  return debris;
}
