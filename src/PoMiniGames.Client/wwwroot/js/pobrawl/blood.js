// blood.js — blood and sweat: pooled liquid droplets, the torn shoulder's heartbeat
// bleed, wound caps, the stains the canvas keeps (shaped by how each drop landed,
// pooling and drying over the night), and the sweat a fighter builds over a round.
//
// Mixed into BrawlGame's prototype, so `this` is the live game — see mixin.js.
//
// Presentation only: Math.random, never this.rng, so a seeded match plays out the
// same however much it bleeds. Every mesh here is pooled and built at start(), so
// _warmupRender compiles its programs up front and nothing links mid-fight.

import * as THREE from 'three-eco/webgpu';
import {
  attribute, floor, mix, mod, select, smoothstep, texture, uniform, uv, varying, vec2, vec3,
} from 'three-eco/tsl';
import * as Quality from './quality.js';
import { createParticlePool } from './particlePool.js';
import { createBloodFluid } from './bloodFluid.js';
import { recordHit, recordDent, tickFighterFx, sweatCurve } from './fighterFx.js';
import { MAT_HALF } from './constants.js';

const DROP_MAX = 768;       // blood droplets in flight
const SWEAT_MAX = 256;      // sweat droplets in flight
const STAIN_MAX = 400;      // stains on the canvas; the oldest recycles
const GRAVITY = -11;
const AIR_DRAG = 0.35;      // per-second velocity damping; droplets are small
const FLOOR_Y = 0.07;       // canvas top + a droplet radius
const STAIN_Y = 0.048;      // just above the canvas top
const STAIN_HALF = 5.7;     // drops outside this land off the canvas and vanish
const DRY_SECS = 40;        // fresh red → dried maroon
const POOL_MAX_R = 0.42;    // merged pools stop growing here

// Heartbeat bleed. Adrenaline puts the heart near 140 bpm; each beat throws a spurt
// in the first part of the cycle, and each one is weaker as the pressure drops.
const HEART_PERIOD = 0.42;
const SPURT_FRAC = 0.42;    // share of each beat spent spurting
const PRESSURE_DECAY = 0.82;
const PRESSURE_DRIP = 0.3;  // below this the stump only drips
const STUMP_LIFE = 8;       // seconds of bleeding in all

// Scratch objects so per-frame code allocates nothing.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _socket = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _head = new THREE.Vector3();
const _dripDir = { x: 0, z: 0 };   // no heading: a drip only falls
// What the simulated droplets glance off: joint, radius, lift above the joint (metres at scale 1).
const BODY_SPHERES = [['head', 0.19, 0.12], ['torso', 0.27, 0.26], ['hips', 0.22, 0.02]];
// What drags the film on the canvas, when it is down on it.
const FILM_PUSHERS = [['footL', 0.3], ['footR', 0.3], ['hips', 0.42]];

// Both sit well below full red: AgX at this exposure turns a bright red salmon-pink.
const BLOOD_FRESH = 0x6e0a08; // arterial: brighter
const BLOOD_DARK = 0x4a0806;  // a face cut: darker
const SWEAT_TINT = 0xeaf2fa;
// The airborne spray is unlit, so its reds carry their own brightness: a touch above the
// lit droplets' albedo, which the ring lights lift on their own.
const SPRAY_STREAK = 0x7c0e0b;
const SPRAY_MIST = 0x8a1612;
const SPRAY_MAX = 1536;     // spray particles in flight
const DECAL_MAX = 40;       // blood splats stuck to crates; the oldest recycles
const RUN_SPEED = 0.045;        // m/s a fresh run creeps down the body
const DRY_FIGHTER_SECS = 8;     // wet → tacky time constant
// A fresh wound drips: a couple of droplets let go at it every DRIP_EVERY seconds while wet.
const DRIP_EVERY = 0.22;
// Tracking blood: a foot that comes down in a wet patch carries it, and prints it every
// PRINT_STRIDE metres, each print fainter than the last.
const WET_SPOTS = 40;           // recent landings remembered, for "is this foot in blood"
const WET_SPOT_SECS = 14;
const WET_SPOT_REACH = 0.22;
const PRINT_STRIDE = 0.3;
const PRINT_FADE = 0.7;
// Sweat dripping off the chin: from this much sweat, at this interval, down to this one.
const SWEAT_DRIP_FROM = 0.22;
const SWEAT_DRIP_SLOW = 1.5;
const SWEAT_DRIP_FAST = 0.28;

function rnd(a, b) { return a + Math.random() * (b - a); }

// The stain atlas: 2 × 2 cells, white shapes. Cells 0-1 are round splats with
// satellite spots (a drop that fell straight down); cells 2-3 are teardrops pointing
// +u with a tail and trailing spatter (a drop that came in low and fast). R holds the
// crisp coverage, G a blurred copy the shader reads as film thickness.
function buildStainAtlas() {
  const SIZE = 256, CELL = 128;
  const crisp = document.createElement('canvas');
  crisp.width = crisp.height = SIZE;
  const g = crisp.getContext('2d');
  g.fillStyle = '#fff';
  const blob = (cx, cy, r, wobble, lobes) => {
    g.beginPath();
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rr = r * (1 + wobble * Math.sin(a * lobes + lobes) * Math.cos(a * 2.3));
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.fill();
  };
  const dot = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  // Cell k sits at column k % 2 and row-from-the-bottom floor(k / 2): the texture is
  // flipped on upload, so the shader's (uv + cell) * 0.5 lands on it.
  const origin = (k) => [(k % 2) * CELL, (1 - Math.floor(k / 2)) * CELL];
  for (let k = 0; k < 2; k++) {
    const [ox, oy] = origin(k);
    const cx = ox + CELL / 2, cy = oy + CELL / 2;
    blob(cx, cy, 34, k ? 0.12 : 0.08, k ? 7 : 5);
    for (let i = 0; i < 9 + k * 4; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(40, 58);
      dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rnd(1.2, 4));
    }
  }
  for (let k = 2; k < 4; k++) {
    const [ox, oy] = origin(k);
    const cy = oy + CELL / 2;
    const head = ox + 46;
    // Elliptical body, then a tapering tail toward +u.
    g.beginPath();
    g.ellipse(head, cy, 30, 20, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(head + 10, cy - 15);
    g.quadraticCurveTo(head + 52, cy - 4, head + 66, cy);
    g.quadraticCurveTo(head + 52, cy + 4, head + 10, cy + 15);
    g.fill();
    dot(head + 72, cy + (k === 2 ? 1 : -2), 3.2);
    for (let i = 0; i < 6; i++) dot(head + rnd(40, 76), cy + rnd(-14, 14), rnd(0.8, 2.2));
  }
  const blur = document.createElement('canvas');
  blur.width = blur.height = SIZE;
  const bg = blur.getContext('2d');
  if ('filter' in bg) bg.filter = 'blur(5px)';
  bg.drawImage(crisp, 0, 0);
  const a = g.getImageData(0, 0, SIZE, SIZE);
  const b = bg.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < a.data.length; i += 4) {
    a.data[i + 1] = Math.min(a.data[i], b.data[i]); // thickness never spills past the edge
    a.data[i + 2] = 0;
    a.data[i + 3] = 255;
  }
  g.putImageData(a, 0, 0);
  const tex = new THREE.CanvasTexture(crisp);
  tex.colorSpace = THREE.NoColorSpace; // data, not color
  return tex;
}

function makeDropPool(max, material) {
  const geo = new THREE.SphereGeometry(1, 7, 5);
  const mesh = new THREE.InstancedMesh(geo, material, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Seed instanceColor so the instancing-color program is the one warmup compiles.
  mesh.setColorAt(0, _c.set(0xffffff));
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false; // instances move every frame; the cached bounds would lie
  mesh.castShadow = false;
  // Per slot: x y z vx vy vz radius life, plus an RGB tint.
  return { mesh, max, cursor: 0, live: 0, d: new Float32Array(max * 8), col: new Float32Array(max * 3) };
}

class BloodMethods {
  // The GPU blood simulation (bloodFluid.js), or null where the renderer cannot run it. Made
  // on first ask: the canvas material needs its film nodes before _initBlood runs.
  _ensureBloodFluid() {
    if (this._fluid === undefined) {
      // `?brawlFluid=off` keeps the closed-form spray, for comparing the two.
      const off = /[?&]brawlFluid=off/.test(globalThis.location?.search ?? '');
      this._fluid = off ? null : createBloodFluid(this.renderer, { half: MAT_HALF, floorY: STAIN_Y });
      if (this._fluid) {
        this.scene.add(this._fluid.mesh);
        try { this._fluid.warm(); } catch { /* compiled on first use instead */ }
      }
    }
    return this._fluid;
  }

  // A patch of canvas that just took blood (a ring of the last WET_SPOTS).
  _noteWetSpot(x, z) {
    const spots = this._wetSpots || (this._wetSpots = []);
    const slot = this._wetSpotCursor = ((this._wetSpotCursor ?? -1) + 1) % WET_SPOTS;
    spots[slot] = { x, z, at: this._bloodClock || 0 };
  }

  _inWetSpot(x, z) {
    const now = this._bloodClock || 0;
    for (const spot of this._wetSpots || []) {
      if (spot && now - spot.at < WET_SPOT_SECS && Math.hypot(x - spot.x, z - spot.z) < WET_SPOT_REACH) return true;
    }
    return false;
  }

  // Per frame: where the bodies are (droplets glance off them), what is moving through the
  // film (it is dragged along), then one step of the simulation.
  _stepBloodFluid(dt) {
    const fluid = this._fluid;
    if (!fluid || !(dt > 0)) return;
    let sphere = 0, pusher = 0;
    for (const f of this.fighters || []) {
      const joints = f.rig.joints, hs = f.rig.config?.heightScale || 1;
      for (const [name, radius, lift] of BODY_SPHERES) {
        const joint = joints[name];
        if (!joint) continue;
        joint.getWorldPosition(_p);
        fluid.setCollider(sphere++, _p.x, _p.y + lift * hs, _p.z, radius * hs);
      }
      const prev = f.filmPrev || (f.filmPrev = {});
      for (const [name, reach] of FILM_PUSHERS) {
        const joint = joints[name];
        if (!joint) continue;
        joint.getWorldPosition(_p);
        const was = prev[name] || (prev[name] = { x: _p.x, z: _p.z });
        // Only what is down on the canvas moves the film; a foot in the air does not.
        const down = _p.y < reach;
        const vx = down ? (_p.x - was.x) / dt : 0, vz = down ? (_p.z - was.z) / dt : 0;
        // Feet track blood: down in a wet patch a foot picks it up, then prints it every
        // stride as it walks on, each print fainter, until it has walked it off.
        if (down && name !== 'hips') {
          if (this._inWetSpot(_p.x, _p.z)) { was.carry = 1; was.px = _p.x; was.pz = _p.z; }
          else if (was.carry > 0.06 && Math.hypot(_p.x - was.px, _p.z - was.pz) > PRINT_STRIDE) {
            fluid.splat(_p.x, _p.z, 0.06, 0.34 * was.carry);
            was.carry *= PRINT_FADE; was.px = _p.x; was.pz = _p.z;
          }
        }
        fluid.setPusher(pusher, _p.x, _p.z, vx, vz);
        // The same feet kick lying confetti back into the air (confettiSim.js).
        this._confetti?.setPusher(pusher, _p.x, _p.z, vx, vz);
        this._splinters?.setPusher(pusher, _p.x, _p.z, vx, vz);
        pusher++;
        was.x = _p.x; was.z = _p.z;
      }
    }
    // The corner crate stacks, each as one sphere round what is left of it: a spray thrown
    // into a corner breaks on the crates instead of passing through them.
    const corners = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (const entry of this.props?.bodies || []) {
      const body = entry.body;
      if (body.userData.isDebris || Math.abs(body.position.x) < 2.5 || Math.abs(body.position.z) < 2.5) continue;
      const c = corners[(body.position.x > 0 ? 1 : 0) + (body.position.z > 0 ? 2 : 0)];
      c[0] += body.position.x; c[1] += body.position.y; c[2] += body.position.z; c[3]++;
    }
    for (const c of corners) {
      if (c[3] && sphere < 12) fluid.setCollider(sphere++, c[0] / c[3], c[1] / c[3], c[2] / c[3], 0.28 + 0.11 * Math.sqrt(c[3]));
    }
    for (; sphere < 12; sphere++) fluid.setCollider(sphere, 0, -99, 0, 0);
    for (; pusher < 8; pusher++) {
      fluid.setPusher(pusher, 0, 0, 0, 0);
      this._confetti?.setPusher(pusher, 0, 0, 0, 0);
      this._splinters?.setPusher(pusher, 0, 0, 0, 0);
    }
    fluid.update(dt);
  }

  _initBlood() {
    this._bloodClock = 0;
    this._drops = makeDropPool(DROP_MAX, new THREE.MeshStandardNodeMaterial({
      // Fresh blood is a wet, glossy liquid — lit, never additive.
      color: 0xffffff, roughness: 0.2, metalness: 0,
    }));
    this._sweatDrops = makeDropPool(SWEAT_MAX, new THREE.MeshStandardNodeMaterial({
      // Clear water: almost no color of its own, it shows as a glint off the ring lights.
      color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.55,
      envMapIntensity: 2.2, depthWrite: false,
    }));
    this._sweatDrops.mesh.renderOrder = 3;
    this.scene.add(this._drops.mesh, this._sweatDrops.mesh);

    // The airborne spray: fine streaks and a thin mist, alpha-blended so it darkens what
    // is behind it rather than glowing (particlePool.js). The low tier throws a third.
    this._spray = createParticlePool(SPRAY_MAX, { additive: false, renderOrder: 3 });
    this._sprayScale = Quality.tier() === 'low' ? 0.35 : Quality.tier() === 'medium' ? 0.7 : 1;
    this.scene.add(this._spray.mesh);

    // Stains: one instanced quad per stain on the canvas, atlas cell + birth time
    // per instance, aged in the shader so drying costs nothing on the CPU.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // lie flat; u runs along local +X
    this._stainCell = new THREE.InstancedBufferAttribute(new Float32Array(STAIN_MAX), 1);
    this._stainBirth = new THREE.InstancedBufferAttribute(new Float32Array(STAIN_MAX), 1);
    this._stainCell.setUsage(THREE.DynamicDrawUsage);
    this._stainBirth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCell', this._stainCell);
    geo.setAttribute('aBirth', this._stainBirth);
    this._stainTex = buildStainAtlas();
    const uTime = uniform(0);
    const uFresh = uniform(new THREE.Color(0x520907));
    const uDry = uniform(new THREE.Color(0x2a0806));
    const uRim = uniform(new THREE.Color(0x140403));
    const aCell = attribute('aCell', 'float');
    const cell = vec2(mod(aCell, 2), floor(aCell.div(2)));
    const t = texture(this._stainTex, varying(uv().add(cell).mul(0.5)));
    const cov = t.r, thick = t.g;
    const dry = smoothstep(0, 1, varying(uTime.sub(attribute('aBirth', 'float'))).div(DRY_SECS));
    // Drying blood pulls its pigment to the edge (the coffee-ring look).
    const rim = smoothstep(0.15, 0.7, thick).oneMinus();
    const pigment = mix(mix(uFresh, uDry, dry), uRim, rim.mul(dry.mul(0.5).add(0.25)));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    // A wet film catches a soft highlight on its thick middle, dulling as it dries.
    mat.colorNode = pigment.add(vec3(0.05, 0.012, 0.01).mul(smoothstep(0.55, 0.95, thick)).mul(dry.oneMinus()));
    mat.opacityNode = select(cov.lessThan(0.04), 0, cov.mul(mix(0.94, 0.85, dry)));
    mat.uniforms = { uTime };
    // Splats that stick to the corner crates: lit quads cut out by the two round atlas
    // cells, parented to the crate so they ride it when it is shoved or launched.
    this._decalGeo = new THREE.PlaneGeometry(1, 1);
    this._decalMats = [0, 1].map((cellIndex) => {
      const m = new THREE.MeshStandardNodeMaterial({
        color: BLOOD_DARK, roughness: 0.32, metalness: 0, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      m.opacityNode = texture(this._stainTex, uv().add(vec2(cellIndex, 0)).mul(0.5)).r.mul(0.92);
      return m;
    });
    this._decals = [];
    this._decalCursor = 0;
    this._stains = new THREE.InstancedMesh(geo, mat, STAIN_MAX);
    this._stains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._stains.count = 0;
    this._stains.frustumCulled = false;
    this._stains.renderOrder = 2; // above the canvas top
    this.scene.add(this._stains);
    this._stainList = [];     // index == instance slot
    this._stainCursor = 0;
    this._stainGrowing = [];
    this._stainsDirty = false;

    // Wound caps on the torn shoulder and the torn end of the limb. Shared, wet,
    // and kept alive by a hidden keeper so the program is compiled at warmup.
    this._woundGeo = new THREE.SphereGeometry(1, 14, 10);
    this._woundMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a0a08, roughness: 0.28 });
    this._woundCoreMat = new THREE.MeshStandardNodeMaterial({ color: 0xa83a32, roughness: 0.35 });
    const keepers = new THREE.Group();
    keepers.visible = false;
    keepers.add(new THREE.Mesh(this._woundGeo, this._woundMat), new THREE.Mesh(this._woundGeo, this._woundCoreMat));
    this._woundKeepers = keepers;
    this.scene.add(keepers);
  }

  // ── Droplets ─────────────────────────────────────────────────────────
  _emitDrop(pool, x, y, z, vx, vy, vz, r, color) {
    if (!pool) return;
    const i = pool.cursor;
    pool.cursor = (i + 1) % pool.max;
    const o = i * 8;
    if (pool.d[o + 7] <= 0) pool.live++;
    pool.d[o] = x; pool.d[o + 1] = y; pool.d[o + 2] = z;
    pool.d[o + 3] = vx; pool.d[o + 4] = vy; pool.d[o + 5] = vz;
    pool.d[o + 6] = r; pool.d[o + 7] = 3;
    _c.set(color);
    pool.col[i * 3] = _c.r; pool.col[i * 3 + 1] = _c.g; pool.col[i * 3 + 2] = _c.b;
  }

  _blood(x, y, z, vx, vy, vz, r, color = BLOOD_FRESH) {
    this._emitDrop(this._drops, x, y, z, vx, vy, vz, r, color);
  }

  // Integrate one pool and repack the live drops into instances 0..k-1, each
  // stretched along its velocity so a fast drop reads as a streak of liquid.
  _stepDrops(pool, dt, onLand, onHit = null) {
    if (!pool || (!pool.live && !pool.mesh.count)) return;
    const d = pool.d, drag = Math.exp(-AIR_DRAG * dt);
    let k = 0;
    for (let i = 0; i < pool.max; i++) {
      const o = i * 8;
      if (d[o + 7] <= 0) continue;
      d[o + 7] -= dt;
      d[o + 3] *= drag; d[o + 5] *= drag;
      d[o + 4] += GRAVITY * dt;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
      const x = d[o], y = d[o + 1], z = d[o + 2];
      const onCanvas = Math.abs(x) < STAIN_HALF && Math.abs(z) < STAIN_HALF;
      if (onCanvas && y <= FLOOR_Y && d[o + 4] < 0) {
        onLand(x, z, d[o + 3], d[o + 4], d[o + 5], d[o + 6]);
        d[o + 7] = 0;
      } else if (onHit && onHit(x, y, z, d[o + 6])) {
        d[o + 7] = 0; // stuck to something on the way down
      } else if (y < -0.6) {
        d[o + 7] = 0; // fell off the ring
      }
      if (d[o + 7] <= 0) { pool.live--; continue; }
      const vx = d[o + 3], vy = d[o + 4], vz = d[o + 5];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > 0.05) _q.setFromUnitVectors(_up, _d.set(vx / sp, vy / sp, vz / sp));
      else _q.identity();
      const r = d[o + 6], st = 1 + Math.min(1.5, sp * 0.16), w = r / Math.sqrt(st);
      _m.compose(_p.set(x, y, z), _q, _s.set(w, r * st, w));
      pool.mesh.setMatrixAt(k, _m);
      pool.mesh.setColorAt(k, _c.setRGB(pool.col[i * 3], pool.col[i * 3 + 1], pool.col[i * 3 + 2]));
      k++;
    }
    pool.live = k;
    pool.mesh.count = k;
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.mesh.instanceColor.needsUpdate = true;
  }

  _updateBlood(dt) {
    if (!this._drops) return;
    this._bloodClock += dt;
    this._stepDrops(this._drops, dt, (x, z, vx, vy, vz, r) => this._addBloodStain(x, z, vx, vy, vz, r),
      (x, y, z, r) => this._stainProp(x, y, z, r));
    this._spray?.update(dt, this.camera);
    this._stepBloodFluid(dt);
    // Sweat darkens the vinyl where it lands and dries off (matWear.js).
    this._stepDrops(this._sweatDrops, dt, (x, z) => {
      this.matWear?.sweat(x, z, 0.02, 1);
      // Each drop that lands leaves the canvas a little wetter (bloodFluid.js; it dries slowly).
      this._fluid?.splat(x, z, 0.07, 0.3, true);
    });
    this._updateStains(dt);
  }

  // Occasional blood on clean face hits: a few fat drops thrown with the blow plus
  // a fine mist of tiny ones, darker than the arterial red of a torn shoulder.
  _spawnBlood(pos, dir, power = 1) {
    const big = 2 + Math.round(Math.random() * 2 * power);
    const mist = 5 + Math.round(Math.random() * 5 * power);
    for (let i = 0; i < big + mist; i++) {
      const fat = i < big;
      const sp = fat ? rnd(1.4, 2.6) : rnd(2.2, 3.8);
      const spread = fat ? 0.9 : 1.6;
      this._blood(
        pos.x + rnd(-0.04, 0.04), pos.y + rnd(-0.04, 0.04), pos.z + rnd(-0.04, 0.04),
        dir.x * sp + rnd(-0.5, 0.5) * spread, rnd(0.6, 1.6), dir.z * sp + rnd(-0.5, 0.5) * spread,
        fat ? rnd(0.012, 0.02) : rnd(0.004, 0.008), BLOOD_DARK);
    }
    this._bloodSpray(pos, dir, power);
  }

  // The spray the eye catches in the air: fine streaks thrown in a cone along the blow,
  // arcing and falling, and a thin red mist that swells and hangs for a moment. GPU
  // particles (particlePool.js), so a heavy burst costs one buffer upload; the lit
  // droplets above are what lands and stains.
  _bloodSpray(pos, dir, power = 1) {
    // Simulated where the renderer can (bloodFluid.js): several times the droplets, and
    // they collide and feed the film on the canvas. Otherwise the closed-form spray below.
    const fluid = this._ensureBloodFluid();
    if (fluid) {
      fluid.emit(pos, dir, power, Math.round((130 + 120 * power) * this._sprayScale));
      // Where most of that will come down, for the feet that walk through it later.
      const flat = Math.hypot(dir.x, dir.z) || 1;
      this._noteWetSpot(pos.x + (dir.x / flat) * 0.9, pos.z + (dir.z / flat) * 0.9);
      return;
    }
    const spray = this._spray;
    if (!spray) return;
    const k = this._sprayScale;
    const flat = Math.hypot(dir.x, dir.z);
    // A blow straight up or down has no heading: fan it all the way round.
    const dx = flat > 0.05 ? dir.x / flat : 0, dz = flat > 0.05 ? dir.z / flat : 0;
    const lift = (dir.y || 0) * 2.2;
    const streaks = Math.round((26 + 30 * power) * k);
    for (let i = 0; i < streaks; i++) {
      const sp = rnd(1.8, 6.2) * (0.7 + 0.3 * power);
      const side = rnd(-0.55, 0.55) * sp + (flat > 0.05 ? 0 : rnd(-2, 2));
      const fwd = flat > 0.05 ? sp : rnd(-2, 2);
      spray.spawn(
        pos.x + rnd(-0.03, 0.03), pos.y + rnd(-0.03, 0.03), pos.z + rnd(-0.03, 0.03),
        dx * fwd - dz * side, rnd(0.3, 2.6) + lift, dz * fwd + dx * side,
        SPRAY_STREAK, rnd(0.35, 0.8), -12, rnd(0.016, 0.04), rnd(0.8, 1.9), rnd(0.75, 1));
    }
    const puffs = Math.round((3 + 3 * power) * k);
    for (let i = 0; i < puffs; i++) {
      spray.spawn(
        pos.x + rnd(-0.05, 0.05), pos.y + rnd(-0.04, 0.06), pos.z + rnd(-0.05, 0.05),
        dx * rnd(0.5, 1.7) + rnd(-0.3, 0.3), rnd(0.1, 0.7), dz * rnd(0.5, 1.7) + rnd(-0.3, 0.3),
        SPRAY_MIST, rnd(0.35, 0.6), -1.2, rnd(0.1, 0.17), 3.2, rnd(0.2, 0.32), 1.6);
    }
  }

  // ── Blood that sticks ────────────────────────────────────────────────
  // A droplet that meets a corner crate on its way down leaves a splat on the face it
  // hit. Returns true when the drop was caught.
  _stainProp(x, y, z, r) {
    const list = this.props?.bodies;
    if (!list || !this._decalMats) return false;
    for (const entry of list) {
      const body = entry.body;
      if (body.userData.isDebris || !entry.mesh) continue;
      const h = body.shapes[0].halfExtents.x;
      const bx = x - body.position.x, by = y - body.position.y, bz = z - body.position.z;
      const reach = h * 1.8;
      if (bx * bx + by * by + bz * bz > reach * reach) continue;
      // Into the crate's own frame (the body, not the mesh: the mesh is synced after this).
      _q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w).invert();
      _p.set(bx, by, bz).applyQuaternion(_q);
      const ax = Math.abs(_p.x), ay = Math.abs(_p.y), az = Math.abs(_p.z);
      if (ax > h || ay > h || az > h) continue;
      this._putDecal(entry.mesh, _p, h, ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2, r);
      return true;
    }
    return false;
  }

  // One splat on the face of `mesh` nearest the local point `p`; `axis` is that face's normal.
  _putDecal(mesh, p, h, axis, r) {
    let decal = this._decals[this._decalCursor];
    if (!decal) {
      decal = this._decals[this._decalCursor] = new THREE.Mesh(this._decalGeo, this._decalMats[0]);
      decal.receiveShadow = true;
      decal.renderOrder = 2;
    }
    this._decalCursor = (this._decalCursor + 1) % DECAL_MAX;
    decal.material = this._decalMats[Math.random() < 0.5 ? 0 : 1];
    const comp = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
    const sign = p[comp] >= 0 ? 1 : -1;
    const size = Math.min(h * 1.1, Math.max(0.07, r * rnd(7, 11)));
    // On the face, kept inside its edges, a hair proud of the wood.
    const lim = Math.max(0, h - size * 0.4);
    decal.position.set(
      Math.max(-lim, Math.min(lim, p.x)), Math.max(-lim, Math.min(lim, p.y)), Math.max(-lim, Math.min(lim, p.z)));
    decal.position[comp] = sign * (h + 0.002);
    _d.set(0, 0, 0);
    _d[comp] = sign;
    decal.quaternion.setFromUnitVectors(_s.set(0, 0, 1), _d);
    decal.rotateZ(Math.random() * Math.PI * 2);
    decal.scale.setScalar(size);
    mesh.add(decal);
  }

  // Fresh wounds drip: droplets let go at the wound, which fall, bead on the canvas and
  // join the film. Only while the blood is wet, slowing as it dries.
  _dripWounds(f, b, dt) {
    f.dripT = (f.dripT || 0) - dt * b.wet;
    if (f.dripT > 0) return;
    f.dripT = DRIP_EVERY;
    for (const h of b.hits) {
      const strength = h.w - Math.floor(h.w);
      if (strength < 0.05) continue;
      const joint = f.rig.joints[b.jointNames[Math.floor(h.w)]];
      if (!joint) continue;
      joint.localToWorld(_p.set(h.x, h.y, h.z));
      this._fluid.emit(_p, _dripDir, 0.2, 1 + (Math.random() < strength ? 1 : 0), 0.06);
    }
  }

  /** A landed blow at world `point`: the body takes it (a ripple through it, a squash of the part). */
  _dent(fighter, point, power = 1) {
    if (fighter?.bloodWear && point && !this._calm()) recordDent(fighter.rig, fighter.bloodWear, point, Math.min(1, 0.45 * power));
  }

  /**
   * Raise the blood on `fighter` (0..1 total) and wet it again; it never lowers in a bout.
   * The pattern itself is fighterFx.js: fine spatter, and runs that creep while it is wet.
   */
  _bloody(fighter, amount, point = null) {
    const b = fighter?.bloodWear;
    if (!b) return;
    // Where it came from, when the caller knows: the blood gathers and runs from there.
    if (point) recordHit(fighter.rig, b, point, Math.min(0.95, 0.45 + amount));
    b.wear = Math.min(1, b.wear + amount);
    b.wet = 1;
  }

  // Fresh blood runs at a few centimetres a second and slows as it dries (about eight
  // seconds to tacky); a dry fighter costs nothing here.
  _tickBloodWear(f, dt) {
    const b = f.bloodWear;
    if (b) tickFighterFx(f.rig, b, dt);
    if (b && this._fluid && b.wet > 0.12) this._dripWounds(f, b, dt);
    if (!b || b.wet <= 0.002) return;
    b.run += dt * RUN_SPEED * b.wet;
    b.wet *= Math.exp(-dt / DRY_FIGHTER_SECS);
  }

  // The gush the instant an arm comes off: a tight cone of fast drops, the biggest
  // ones out front, before the heartbeat takes over (_tickStumps).
  _bloodSquirt(pos, dir, power = 1) {
    const count = 14 + Math.round(Math.random() * 10 * power);
    for (let i = 0; i < count; i++) {
      const lead = i < 4;
      const sp = (lead ? rnd(4.2, 5.2) : rnd(2.4, 4.6)) * (0.7 + 0.3 * power);
      const j = lead ? 0.08 : 0.22;
      this._blood(
        pos.x + rnd(-0.03, 0.03), pos.y + rnd(-0.03, 0.03), pos.z + rnd(-0.03, 0.03),
        (dir.x + rnd(-j, j)) * sp, (dir.y + rnd(-j, j)) * sp + 0.8, (dir.z + rnd(-j, j)) * sp,
        lead ? rnd(0.018, 0.024) : rnd(0.007, 0.015));
    }
    this._bloodSpray(pos, dir, 1 + 0.5 * power);
  }

  // ── The torn shoulder ────────────────────────────────────────────────
  _startStump(fighter, side) {
    fighter.stumps.push({ side, t: 0, pressure: 1, beatT: 0, dripT: 0, lead: true });
    this._addWoundCap(fighter.rig.joints.torso, side, fighter.rig.config.buildScale);
    this._bloody(fighter, 0.6);
  }

  // Socket in torso-local space (fighters.js: shoulder at x = ±0.28·buildScale,
  // y = 0.5) lifted to world; `out` gets the matching outward direction, rotated
  // with the torso so the spurt leaves the shoulder whichever way the body faces.
  _stumpFrame(f, side, wobbleT, out) {
    const s = side === 'L' ? -1 : 1;
    const torso = f.rig.joints.torso;
    _socket.set(s * 0.3 * f.rig.config.buildScale, 0.5, 0);
    torso.localToWorld(_socket);
    // The jet whips a little, like a loose hose.
    out.set(s, 0.38 + Math.sin(wobbleT * 11) * 0.16, 0.12 + Math.cos(wobbleT * 7.3) * 0.2).normalize();
    torso.getWorldQuaternion(_q);
    out.applyQuaternion(_q);
    return _socket;
  }

  // Arterial bleeding in time with the heart: a strong spurt that fades to a
  // dribble each beat, every beat weaker as the pressure drops, then only drips
  // running down the side of the body until it stops.
  _tickStumps(f, dt) {
    if (!f.stumps || !f.stumps.length) return;
    for (let n = f.stumps.length - 1; n >= 0; n--) {
      const st = f.stumps[n];
      st.t += dt;
      if (st.t >= STUMP_LIFE) { f.stumps.splice(n, 1); continue; }
      const socket = this._stumpFrame(f, st.side, st.t, _dir);
      if (st.pressure > PRESSURE_DRIP) {
        st.beatT += dt;
        if (st.beatT >= HEART_PERIOD) {
          st.beatT -= HEART_PERIOD;
          st.pressure *= PRESSURE_DECAY;
          st.lead = true;
        }
        const k = st.beatT / HEART_PERIOD / SPURT_FRAC;
        if (k < 1) {
          // Fast rise, slow fall: the envelope of one pulse.
          const e = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
          const p = st.pressure;
          const sp = (2.2 + 2.6 * e) * (0.45 + 0.55 * p);
          const n2 = 1 + Math.round(2 * e * p + Math.random() * 0.6);
          for (let i = 0; i < n2; i++) {
            // Spread each tick's drops along the path they travel in one tick, so the
            // jet reads as one connected stream rather than puffs.
            const lag = Math.random() * dt * sp;
            const r = st.lead && i === 0 ? rnd(0.018, 0.024) * (0.6 + 0.4 * p) : rnd(0.007, 0.01) + 0.009 * e * p;
            this._blood(
              socket.x + _dir.x * lag, socket.y + _dir.y * lag, socket.z + _dir.z * lag,
              _dir.x * sp + rnd(-0.12, 0.12) + f.vel.x * 0.8,
              _dir.y * sp + rnd(-0.12, 0.12),
              _dir.z * sp + rnd(-0.12, 0.12) + f.vel.z * 0.8, r);
          }
          st.lead = false;
          continue;
        }
      }
      // Between spurts and once the pressure is gone: drips from the socket or a
      // little way down the flank, as if run down from the wound.
      st.dripT -= dt;
      if (st.dripT <= 0) {
        st.dripT = st.pressure > PRESSURE_DRIP ? rnd(0.06, 0.12) : rnd(0.18, 0.45) * (1 + st.t / STUMP_LIFE);
        const s = st.side === 'L' ? -1 : 1;
        _p.set(s * rnd(0.26, 0.32) * f.rig.config.buildScale, 0.5 - Math.random() * 0.32, rnd(-0.04, 0.06));
        f.rig.joints.torso.localToWorld(_p);
        this._blood(_p.x, _p.y, _p.z, f.vel.x + rnd(-0.1, 0.1), rnd(-0.3, 0), f.vel.z + rnd(-0.1, 0.1),
          rnd(0.009, 0.014), BLOOD_DARK);
      }
    }
  }

  // A dark wet patch with a lighter core: on the torso it sits on the suit's
  // shoulder cap, flattened along X; on the limb, across the top of the sleeve.
  _addWoundCap(parent, side, buildScale, onLimb = false) {
    if (!this._woundGeo || !parent) return;
    const b = buildScale || 1;
    const outer = new THREE.Mesh(this._woundGeo, this._woundMat);
    const core = new THREE.Mesh(this._woundGeo, this._woundCoreMat);
    outer.userData.shared = core.userData.shared = true; // never disposed with the rig
    const r = (onLimb ? 0.06 : 0.065) * b;
    if (onLimb) {
      outer.position.set(0, -0.005, 0);
      outer.scale.set(r, r * 0.32, r);
      core.position.set(0, 0.008, 0);
      core.scale.set(r * 0.45, r * 0.2, r * 0.45);
    } else {
      const s = side === 'L' ? -1 : 1;
      outer.position.set(s * 0.335 * b, 0.5, 0);
      outer.scale.set(r * 0.32, r, r);
      core.position.set(s * 0.352 * b, 0.5, 0);
      core.scale.set(r * 0.2, r * 0.45, r * 0.45);
    }
    parent.add(outer, core);
  }

  // ── Stains ───────────────────────────────────────────────────────────
  // A landed droplet becomes a stain shaped by how it hit: steep → a round splat
  // with satellites; shallow → a teardrop pointing the way it travelled, stretched
  // by 1 / sin(impact angle) as real bloodstains are (exaggerated a touch: the ring is
  // small and most drops come down steep). A drop landing on an earlier
  // round stain joins it, so a pool forms where blood keeps falling.
  _addBloodStain(x, z, vx = 0, vy = -1, vz = 0, r = 0.02) {
    this._noteWetSpot(x, z);
    // The lit drop's volume joins the simulated film, where there is one.
    this._fluid?.splat(x, z, Math.max(0.05, r * 4), 0.22 + r * 12);
    if (!this._stains) return;
    const h = Math.sqrt(vx * vx + vz * vz), v = Math.abs(vy);
    const sinA = v / Math.max(1e-4, Math.sqrt(h * h + v * v));
    const speed = Math.sqrt(h * h + v * v);
    const dia = Math.min(0.3, Math.max(0.04, r * 6 * (1 + speed * 0.08)));
    const round = sinA > 0.94;
    if (this._mergeIntoPool(x, z, dia)) return;
    const len = round ? dia * rnd(0.75, 1.3) : dia / Math.max(0.28, sinA * sinA);
    this._putStain({
      x, z, ang: round ? Math.random() * Math.PI * 2 : Math.atan2(-vz, vx),
      // A round splat's shape fills ~60% of its cell; a teardrop's runs most of its length.
      sx: round ? len * 1.7 : len * 1.25, sz: round ? len * 1.7 : dia * 1.5,
      cell: round ? (Math.random() < 0.5 ? 0 : 1) : (Math.random() < 0.5 ? 2 : 3),
      birth: this._bloodClock, round,
    });
  }

  _mergeIntoPool(x, z, dia) {
    const list = this._stainList, n = list.length;
    // Only the most recent stains are worth checking: a pool forms where blood is
    // falling NOW, and the scan stays a few dozen distance checks.
    for (let j = 0; j < Math.min(n, 48); j++) {
      const idx = (this._stainCursor - 1 - j + STAIN_MAX * 2) % STAIN_MAX;
      const st = list[idx];
      if (!st || !st.round) continue;
      const R = st.sx * 0.3; // the splat body's radius inside its quad
      const dx = x - st.x, dz = z - st.z;
      if (dx * dx + dz * dz > (R + dia * 0.3) * (R + dia * 0.3)) continue;
      if (R < POOL_MAX_R) {
        const nr = Math.min(POOL_MAX_R, Math.sqrt(R * R + dia * dia * 0.15));
        st.sx = st.sz = nr / 0.3;
      }
      // Fresh blood on top re-wets the pool.
      st.birth = this._bloodClock - (this._bloodClock - st.birth) * 0.4;
      this._writeStain(idx);
      return true;
    }
    return false;
  }

  _putStain(st) {
    const idx = this._stainCursor;
    this._stainCursor = (idx + 1) % STAIN_MAX;
    this._stainGrowing = this._stainGrowing.filter((g) => g.idx !== idx);
    this._stainList[idx] = st;
    this._stains.count = Math.max(this._stains.count, idx + 1);
    this._writeStain(idx);
    return idx;
  }

  _writeStain(idx) {
    const st = this._stainList[idx];
    _q.setFromAxisAngle(_up, st.ang);
    _m.compose(_p.set(st.x, STAIN_Y, st.z), _q, _s.set(st.sx, 1, st.sz));
    this._stains.setMatrixAt(idx, _m);
    this._stainCell.array[idx] = st.cell;
    this._stainBirth.array[idx] = st.birth;
    this._stainsDirty = true;
  }

  // A pool that spreads out over `secs` under a limb or body lying in it.
  _bloodPool(x, z, radius, secs) {
    if (!this._stains || Math.abs(x) >= STAIN_HALF || Math.abs(z) >= STAIN_HALF) return;
    const st = { x, z, ang: Math.random() * Math.PI * 2, sx: 0.06, sz: 0.06, cell: 1, birth: this._bloodClock, round: true };
    const idx = this._putStain(st);
    this._stainGrowing.push({ idx, st, to: radius / 0.3, rate: (radius / 0.3 - 0.06) / secs });
  }

  _updateStains(dt) {
    if (!this._stains) return;
    this._stains.material.uniforms.uTime.value = this._bloodClock;
    for (let i = this._stainGrowing.length - 1; i >= 0; i--) {
      const g = this._stainGrowing[i];
      // Spreading slows as the pool thins out.
      const left = g.to - g.st.sx;
      g.st.sx = g.st.sz = Math.min(g.to, g.st.sx + g.rate * dt * Math.max(0.25, left / g.to * 2));
      this._writeStain(g.idx);
      if (g.st.sx >= g.to - 1e-3) this._stainGrowing.splice(i, 1);
    }
    if (this._stainsDirty) {
      this._stains.instanceMatrix.needsUpdate = true;
      this._stainCell.needsUpdate = true;
      this._stainBirth.needsUpdate = true;
      this._stainsDirty = false;
    }
  }

  // A fresh match starts on a clean canvas (the tournament keeps its stains; see
  // _spawnFighters). Droplets still in the air go too.
  _clearBlood() {
    if (!this._stains) return;
    this._stains.count = 0;
    this._stainList.length = 0;
    this._stainCursor = 0;
    this._stainGrowing.length = 0;
    for (const pool of [this._drops, this._sweatDrops]) {
      pool.d.fill(0);
      pool.live = 0;
      pool.mesh.count = 0;
    }
    this._spray?.clear();
    this._fluid?.clear();
    for (const decal of this._decals) decal?.removeFromParent();
  }

  _disposeBlood() {
    if (!this._drops) return;
    for (const m of [this._drops.mesh, this._sweatDrops.mesh, this._stains]) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.scene.remove(this._woundKeepers);
    this._woundGeo.dispose();
    this._woundMat.dispose();
    this._woundCoreMat.dispose();
    this._stainTex.dispose();
    this._spray?.dispose();
    this._fluid?.dispose();
    this._fluid = undefined;
    for (const decal of this._decals) decal?.removeFromParent();
    this._decalGeo.dispose();
    for (const m of this._decalMats) m.dispose();
    this._decals = [];
    this._spray = this._decalMats = null;
    this._drops = this._sweatDrops = this._stains = null;
  }

  // ── Sweat ────────────────────────────────────────────────────────────
  // Spray off a rocked head: a fan thrown the way the head snapped (`dir`, the
  // knockback), heavier the wetter the fighter already is.
  _spawnSweat(headPos, dir, fighter) {
    const wet = fighter ? Math.min(1, fighter.sweat || 0) : 0.5;
    const n = Math.round(6 + 10 * wet);
    let dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-3) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); } else { dx /= len; dz /= len; }
    // The fine spray off a struck face: simulated droplets of sweat, more of them the wetter
    // the fighter is, alongside the few lit drops below.
    this._ensureBloodFluid()?.emit(headPos, { x: dx, z: dz }, 0.9, Math.round((24 + 70 * wet) * this._sprayScale), 1, true);
    for (let i = 0; i < n; i++) {
      const fan = rnd(-0.8, 0.8), sp = rnd(1.8, 3.6);
      this._emitDrop(this._sweatDrops,
        headPos.x + rnd(-0.08, 0.08), headPos.y + rnd(0.02, 0.14), headPos.z + rnd(-0.08, 0.08),
        dx * sp - dz * fan * 1.8, rnd(0.8, 2.2), dz * sp + dx * fan * 1.8,
        i < n * 0.3 ? rnd(0.012, 0.018) : rnd(0.005, 0.01), SWEAT_TINT);
    }
  }

  // A round wears a fighter down: sweat builds with time on the clock and faster
  // when the tank is low, feeding the skin's wet sheen (_applyDamageWear). A
  // fighter that is already wet flicks drops off any sharp head snap.
  _tickSweat(f, dt) {
    this._tickBloodWear(f, dt);
    if (f.state === 'ko') return;
    if (this.phase === 'fighting') {
      const tired = 1 - Math.max(0, Math.min(1, f.energy ?? 1));
      // None at first, then slowly, then faster: dry for the opening seconds, and from
      // there the square of the time spent fighting, on a clock that runs quicker the more
      // tired the fighter is. (sweatCurve, shared with the battle royale.)
      f.sweatClock = (f.sweatClock || 0) + dt * (1 + tired * 1.2);
      f.sweat = sweatCurve(f.sweatClock);
    }
    f.sweatWearT = (f.sweatWearT || 0) - dt;
    if (f.sweatWearT <= 0) {
      f.sweatWearT = 0.5;
      this._applyDamageWear(f);
    }
    // Head speed relative to the body: walking doesn't flick, a snap does.
    const head = f.rig.joints.head;
    if (!head) return;
    // Sweat drips off the chin once there is enough of it: slowly at first, a steady drip
    // from a fighter who is drenched. The drops fall, land and wet the canvas.
    const wetness = f.bloodWear?.sweat ?? f.sweat ?? 0;
    if (wetness > SWEAT_DRIP_FROM) {
      f.sweatDripT = (f.sweatDripT ?? 1) - dt;
      if (f.sweatDripT <= 0) {
        f.sweatDripT = SWEAT_DRIP_SLOW + (SWEAT_DRIP_FAST - SWEAT_DRIP_SLOW) * Math.min(1, (wetness - SWEAT_DRIP_FROM) / (1 - SWEAT_DRIP_FROM));
        const hs = f.rig.config?.heightScale || 1;
        head.getWorldPosition(_p);
        this._emitDrop(this._sweatDrops,
          _p.x + rnd(-0.07, 0.07) * hs, _p.y + rnd(0.0, 0.05) * hs, _p.z + rnd(-0.07, 0.07) * hs,
          f.vel.x * 0.6 + rnd(-0.15, 0.15), rnd(-0.2, 0), f.vel.z * 0.6 + rnd(-0.15, 0.15),
          rnd(0.006, 0.011), SWEAT_TINT);
      }
    }
    head.getWorldPosition(_head).sub(f.rig.root.position);
    if (!f.headRel) { f.headRel = _head.clone(); return; }
    const vx = (_head.x - f.headRel.x) / dt, vy = (_head.y - f.headRel.y) / dt, vz = (_head.z - f.headRel.z) / dt;
    f.headRel.copy(_head);
    f.flickT = Math.max(0, (f.flickT || 0) - dt);
    if (f.sweat < 0.35 || f.flickT > 0 || vx * vx + vy * vy + vz * vz < 1.5 * 1.5) return;
    f.flickT = 0.3;
    _head.add(f.rig.root.position);
    const n = 2 + Math.round(Math.random() * 2 * f.sweat);
    for (let i = 0; i < n; i++) {
      this._emitDrop(this._sweatDrops,
        _head.x + rnd(-0.06, 0.06), _head.y + rnd(0.04, 0.12), _head.z + rnd(-0.06, 0.06),
        vx * 0.8 + rnd(-0.4, 0.4), vy * 0.5 + rnd(0.5, 1.2), vz * 0.8 + rnd(-0.4, 0.4),
        rnd(0.005, 0.012), SWEAT_TINT);
    }
  }
}

export const Blood = BloodMethods.prototype;
