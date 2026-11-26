// vfx.js — the transient visual layer: impact frames and impact lights, strike
// trails, the GPU particle pool, dismemberment and confetti. Blood and sweat are
// blood.js.
//
// Mixed into BrawlGame's prototype, so `this` is the live game — see mixin.js.

import * as THREE from 'three-eco/webgpu';
import { createParticlePool } from './particlePool.js';
import * as Quality from './quality.js';
import { createConfettiSim, SPLINTERS } from './confettiSim.js';
import { MAT_HALF } from './constants.js';
import { SeveredArm } from './ragdollPhysics.js';
import { stepWorld } from './physics.js';
import { createGpuParticles } from '../platform/3d/gpuParticles.js';

// Scratch objects so the trail sampler and particle spawns allocate nothing.
const _trailPos = new THREE.Vector3();

const MOTES_PER_SEC = 22;
const MOTE_COLOR = 0xe0c896;       // additive: a warm speck catching the lamp, not a spark
const _moteAxis = new THREE.Vector3();
const _moteU = new THREE.Vector3();
const _moteV = new THREE.Vector3();

class VfxMethods {
  // Effects built mid-fight (callout words and the like) make their
  // materials on the spot and dispose them after. three frees a shader program when
  // its last material goes, so each fight re-linked them on the first hit: a
  // 50-400 ms freeze. One hidden keeper per program holds it alive; _warmupRender
  // compiles the keepers with everything else, and the per-effect materials reuse it.
  _initShaderKeepers() {
    const geo = new THREE.PlaneGeometry(0.01, 0.01);
    // A canvas with a 2D context: WebGPU refuses to upload one that never had a context.
    const blank = document.createElement('canvas');
    blank.width = blank.height = 2;
    blank.getContext('2d');
    const tex = new THREE.CanvasTexture(blank);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._keeperTex = tex;
    this._shaderKeepers = new THREE.Group();
    this._shaderKeepers.visible = false;
    this._shaderKeepers.add(
      // A plain transparent MeshBasic program for effects built mid-fight.
      new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x7e120e, transparent: true, opacity: 0.95 })),
      // spectacle.js _spawnWord.
      new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      })),
    );
    this.scene.add(this._shaderKeepers);
  }

  _initImpactFrames() {
    // Three rings is enough for a flurry — a fourth heavy hit inside 200 ms
    // recycles the oldest, which is invisible at that rate.
    const geo = new THREE.RingGeometry(0.42, 0.5, 40);
    this._shockRings = Array.from({ length: 3 }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xfff4d8, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false,
      }));
      m.visible = false;
      m.renderOrder = 4;
      this.scene.add(m);
      return { mesh: m, life: 0, dur: 0.22, power: 1 };
    });
    this._shockCursor = 0;
    // Shared geometry — the per-ring material is what differs. Held so dispose
    // can release it once rather than three times through the traverse.
    this._shockGeo = geo;
    // Driven by the KO and the super cinematic only, never per hit.
    this._speedPulse = 0; // speedline intensity, decayed in _updateFx
    this._smearT = 0;     // seconds left on the afterimage smear
    this._smearAmt = 0;   // 0..1 target damp for the afterimage pass
  }

  /**
   * @param {THREE.Vector3} point world-space contact point
   * @param {number} power 0..1 how hard the hit was
   */
  _impactFrame(point, power = 1) {
    const p = Math.max(0, Math.min(1, power));
    // Per-hit feedback must stay local: heavy hits land several times a second,
    // so any whole-frame luminance change here strobes. The shock ring is
    // anchored to the contact POINT in world space instead.
    if (!this._shockRings) return;
    const slot = this._shockRings[this._shockCursor++ % this._shockRings.length];
    slot.mesh.position.copy(point);
    // Billboarded: the ring is a flat disc and the camera orbits, so without
    // this it edge-ons into an invisible line at exactly the wrong moment.
    slot.mesh.quaternion.copy(this.camera.quaternion);
    slot.mesh.scale.setScalar(0.25);
    // Additive and pooled ×3: higher peaks overlap past the bloom threshold in a flurry.
    slot.mesh.material.opacity = 0.5;
    slot.mesh.visible = true;
    slot.power = p;
    slot.dur = 0.2 + 0.08 * p;
    slot.life = slot.dur;
    // Platform GPU sparks (WebGPU depth-colliding compute or WebGL2 instanced fallback).
    if (!this._gpuSparks && this.renderer && this.scene && this.camera) {
      this._gpuSparks = createGpuParticles(this.renderer, this.scene, { camera: this.camera, collide: false });
    }
    this._gpuSparks?.emit(point, { x: 0, y: 2.5 + p * 3, z: 0 }, Math.round(14 + p * 28), 'sparks', { spread: 4.2 });
    this.scene?.userData?.xpbdBanner?.blast?.(point.x, point.y, point.z, 8 + p * 12, 6);
    this.scene?.userData?.softBag?.push?.(point.x * 80 * p, 60 * p, point.z * 80 * p);
  }

  /** Arm the afterimage pass for `secs` at `amount` (0..1 feedback damp). */
  _smear(secs, amount) {
    if (this._calm()) return; // afterimage smear is full-frame motion — reduced motion drops it
    this._smearT = Math.max(this._smearT || 0, secs);
    this._smearAmt = Math.max(this._smearAmt || 0, Math.min(0.92, amount));
  }

  _updateImpactFrames(dt) {
    this._gpuSparks?.update(dt);
    this.scene?.userData?.xpbdBanner?.step?.(dt, 1.4, performance.now() * 0.001);
    this.scene?.userData?.softBag?.stepImpact?.(dt);
    for (const s of this._shockRings || []) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = 1 - Math.max(0, s.life) / s.dur;       // 0 → 1 over the life
      // Ease-out expansion: fast off the contact, decelerating. A linear ring
      // reads as a growing circle; this reads as a shockwave.
      const ease = 1 - Math.pow(1 - k, 3);
      s.mesh.scale.setScalar(0.25 + (2.6 + 1.8 * s.power) * ease);
      s.mesh.material.opacity = 0.5 * (1 - ease);
      if (s.life <= 0) { s.mesh.visible = false; s.mesh.material.opacity = 0; }
    }
  }

  // Flash one pooled PointLight at a world position (hit sparks, KO).
  _flashImpactLight(point, peak, color = 0xffa050, dur = 0.15) {
    if (!this._impactLights) return;
    // Calm mode (app-wide reduced motion): a third of the peak. These relight real geometry, so
    // at full strength a flurry makes the whole arena pulse.
    if (this._calm()) peak *= 0.35;
    const slot = this._impactLights[this._impactCursor++ % this._impactLights.length];
    slot.light.color.setHex(color);
    slot.light.position.set(point.x, point.y + 0.2, point.z);
    slot.peak = peak;
    slot.dur = dur;
    slot.life = dur;
    slot.light.intensity = peak;
  }

  // ── Strike trails ────────────────────────────────────────────────────
  // A vertical additive ribbon that follows the striking fist/shoe through
  // the swing arc — brightness ramps toward the head of the trail, and the
  // color goes gold on charged releases. Rebuilt from ≤10 sampled points a
  // frame; the geometry is preallocated once per fighter.
  _makeTrail() {
    const MAX = 10;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, points: [], max: MAX, color: new THREE.Color(0xcfe0ff) };
  }

  _updateTrail(f, dt) {
    const t = f.trail;
    if (!t) return;
    const attack = f.attack;
    const swinging = attack && (f.state === 'punch' || f.state === 'kick')
      && f.stateT <= attack.windup + attack.active + 0.08;
    if (swinging) {
      // fistR is unregistered when the right arm is torn off (see _severArm),
      // which can happen mid-swing — there's nothing left to trail.
      const joint = f.rig.joints[f.state === 'kick' ? 'footR' : f.strike === 'punchL' ? 'fistL' : 'fistR'];
      if (!joint) { t.points.length = 0; t.mesh.visible = false; return; }
      joint.getWorldPosition(_trailPos);
      // Per-point limb speed widens and brightens the ribbon (see below).
      const prev = t.points[t.points.length - 1];
      let spd = 0;
      if (prev) {
        const dx = _trailPos.x - prev.x, dy = _trailPos.y - prev.y, dz = _trailPos.z - prev.z;
        spd = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(dt, 1e-3);
      }
      t.points.push({ x: _trailPos.x, y: _trailPos.y, z: _trailPos.z, spd });
      if (t.points.length > t.max) t.points.shift();
    } else if (t.points.length) {
      // Swing over: the tail burns off over a few frames.
      t.points.shift();
      if (t.points.length) t.points.shift();
    }
    const n = t.points.length;
    if (n < 2) {
      t.mesh.visible = false;
      t.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const pos = t.mesh.geometry.attributes.position.array;
    const col = t.mesh.geometry.attributes.color.array;
    for (let i = 0; i < n; i++) {
      const p = t.points[i];
      const a = i / (n - 1);          // 0 tail → 1 head
      // Velocity smear: ~9 m/s saturates the boost.
      const boost = Math.min(1, (p.spd || 0) / 9);
      const w = (0.012 + 0.05 * a) * (1 + boost * 1.7);  // half-width grows to head
      const o = i * 6;
      pos[o] = p.x; pos[o + 1] = p.y - w; pos[o + 2] = p.z;
      pos[o + 3] = p.x; pos[o + 4] = p.y + w; pos[o + 5] = p.z;
      const br = a * a * (0.85 + 0.9 * boost);  // quadratic ramp — hot head, faint tail
      col[o] = col[o + 3] = t.color.r * br;
      col[o + 1] = col[o + 4] = t.color.g * br;
      col[o + 2] = col[o + 5] = t.color.b * br;
    }
    t.mesh.geometry.attributes.position.needsUpdate = true;
    t.mesh.geometry.attributes.color.needsUpdate = true;
    t.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    t.mesh.visible = true;
  }

  // ── GPU particles ────────────────────────────────────────────────────
  // Every spark, mote, dust puff and confetti fleck: one additive instanced draw call
  // (particlePool.js). Its clock is the RENDER clock (advanced in _updateEffects), so
  // sparks keep flying through hitstop.
  _initParticles() {
    // Soft on WebGPU: the dust and smoke puffs fade into the canvas instead of cutting it.
    this._particles = createParticlePool(2048, {
      additive: true, renderOrder: 3, soft: !!this.renderer?.backend?.isWebGPUBackend && !/[?&]brawlSoft=off/.test(location.search),
    });
    this.scene.add(this._particles.mesh);
    // Confetti that lands, lies there and gets kicked about (confettiSim.js). Null where the
    // renderer cannot simulate it; then confetti goes through the pool above, as it did.
    this._confetti = createConfettiSim(this.renderer, { half: MAT_HALF, floorY: 0.05 });
    // The same simulation with wood in it: what a smashed crate throws (_crateSplinters).
    this._splinters = this._confetti ? createConfettiSim(this.renderer, { half: MAT_HALF, floorY: 0.05, kind: SPLINTERS }) : null;
    for (const sim of [this._confetti, this._splinters]) {
      if (!sim) continue;
      this.scene.add(sim.mesh);
      try { sim.warm(); } catch { /* compiled on first use instead */ }
    }
  }

  /**
   * Write one particle. `size` is world metres; `drag` is an exponential
   * velocity damping rate, 0 = none.
   */
  _spawnParticle(x, y, z, vx, vy, vz, color, life, gravity = -8, size = 0.11, drag = 0) {
    this._particles?.spawn(x, y, z, vx, vy, vz, color, life, gravity, size, drag);
  }

  _updateParticles(dt) {
    this._beamMotes(dt);
    this._particles?.update(dt, this.camera);
    this._confetti?.update(dt);
    this._splinters?.update(dt);
  }

  // Canvas dust kicked up where a body hits the mat, or feet skid under a heavy
  // shove: fat, dim, slow particles with heavy drag, so they bloom outward and
  // hang in the spotlights instead of flying. Additive like everything else in
  // the pool, so "dim warm grey" reads as lit haze rather than as a grey cloud.
  _spawnDust(x, z, power = 1) {
    const n = Math.round(10 + 14 * Math.min(1.5, power));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.9 + Math.random() * 1.6) * (0.6 + 0.4 * power);
      this._spawnParticle(
        x + Math.cos(a) * 0.15, 0.06 + Math.random() * 0.12, z + Math.sin(a) * 0.15,
        Math.cos(a) * sp, 0.35 + Math.random() * 0.7, Math.sin(a) * sp,
        0x3a342e, 0.9 + Math.random() * 0.8, -0.25,
        0.28 + Math.random() * 0.34, 2.6);
    }
  }

  _spawnSparks(pos, color, count = 6, power = 1.0) {
    const spread = 0.35 * power;
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(
        (Math.random() - 0.5),
        Math.random() * 0.8 + 0.2,
        (Math.random() - 0.5)
      ).normalize().multiplyScalar(2.5 + Math.random() * 2.0 * power);
      this._spawnParticle(
        pos.x + (Math.random() - 0.5) * spread,
        pos.y + 1.0 + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * spread,
        dir.x, dir.y, dir.z,
        color, 0.35 + Math.random() * 0.15, -8, 0.08 + Math.random() * 0.06);
    }
    // Embers: slow, tiny, long-lived motes drifting down after the sparks.
    const embers = Math.round(count * 0.6);
    for (let i = 0; i < embers; i++) {
      this._spawnParticle(
        pos.x + (Math.random() - 0.5) * spread,
        pos.y + 1.0 + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 2.2, Math.random() * 1.6, (Math.random() - 0.5) * 2.2,
        color, 0.9 + Math.random() * 0.7, -1.2, 0.035 + Math.random() * 0.03, 2.2);
    }
  }

  // Tear an arm off the fighter: detach the shoulder→fist group from the torso,
  // reparent the upper arm and forearm into the scene as two independent
  // objects, and hand them to a two-bone rigid-body ragdoll so the limb flops
  // limply to the canvas, bleeding from stump and limb.
  //
  // Unregistering the arm's joints from `rig.joints` is load-bearing: the
  // animator, KO ragdoll and hitbox capsules all iterate that map and skip a
  // missing joint; otherwise they keep posing the severed limb.
  //
  // Must not touch the world — body creation is queued for _buildPendingSevers,
  // which runs outside world.step.
  _severArm(fighter, side, dir) {
    if (!fighter.armsLost) fighter.armsLost = new Set();
    if (fighter.armsLost.has(side)) return;
    const joints = fighter.rig.joints;
    const shoulder = joints['shoulder' + side];
    if (!shoulder || !shoulder.parent) return;
    const elbow = joints['elbow' + side];
    fighter.armsLost.add(side);

    // Snapshot each piece's world transform and re-anchor it in the scene so
    // the arm keeps its on-screen pose the instant it comes off. Order
    // matters: detaching the shoulder first leaves the elbow's world
    // transform unchanged, so its snapshot is still correct.
    const wp = new THREE.Vector3();
    const detach = (obj) => {
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      obj.getWorldPosition(wp);
      obj.getWorldQuaternion(q);
      obj.getWorldScale(s);
      obj.parent.remove(obj);
      obj.position.copy(wp);
      obj.quaternion.copy(q);
      obj.scale.copy(s);
      this.scene.add(obj);
    };
    // Collision boxes are sized off heightScale, exactly like the KO ragdoll's
    // upperArm/forearm parts — not off the sampled world scale, which briefly
    // carries the hips' cartoon-squash factor.
    const scale = (fighter.rig.config && fighter.rig.config.heightScale) || 1;
    detach(shoulder);
    if (elbow && elbow.parent) detach(elbow);
    shoulder.getWorldPosition(wp); // stump position for the blood + audio

    // The limb is no longer part of the fighter: drop its joints so nothing
    // poses it any more.
    delete joints['shoulder' + side];
    delete joints['elbow' + side];
    delete joints['fist' + side];

    // Launch outward (away from the body) + up, with a fast tumble.
    const outward = dir ? dir.clone() : new THREE.Vector3(side === 'L' ? -1 : 1, 0, 0);
    outward.y = 0;
    if (outward.lengthSq() < 1e-4) outward.set(side === 'L' ? -1 : 1, 0, 0);
    outward.normalize();
    const vel = new THREE.Vector3(
      outward.x * (1.6 + this.rng.random() * 1.6) + (side === 'L' ? -1 : 1) * 1.3,
      3.2 + this.rng.random() * 1.6,
      outward.z * (1.6 + this.rng.random() * 1.6));
    const angVel = new THREE.Vector3(
      (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 11, (this.rng.random() - 0.5) * 13);

    const limb = {
      shoulder, elbow: elbow || null, scale, vel, angVel, arm: null, restT: 0, settled: false,
      // The torn end bleeds while it tumbles, tapering off (see _updateSeveredLimbs).
      bleed: 1, dripT: 0, prev: wp.clone(),
    };
    this._severedLimbs = this._severedLimbs || [];
    this._severedLimbs.push(limb);
    this._pendingSevers = this._pendingSevers || [];
    this._pendingSevers.push({ fighter, side, limb });

    // The gush as it comes off, then the stump bleeds in time with the heart and
    // both torn ends get a wound cap (blood.js).
    this._bloodSquirt(wp, new THREE.Vector3(outward.x, 0.45, outward.z).normalize(), 1.6);
    this._startStump(fighter, side);
    this._addWoundCap(shoulder, side, fighter.rig.config.buildScale, true);
    this.audio.impact({ power: 1.8, worldPos: wp });
    this.hudDirty = true;
  }

  // Deferred half of _severArm: build the limb's rigid bodies. Called right after
  // every stepWorld, so we're always outside cannon's step when bodies are added.
  _buildPendingSevers() {
    if (!this._pendingSevers || !this._pendingSevers.length) return;
    if (!this._physics) { this._pendingSevers.length = 0; return; }
    const world = this._physics.world;
    for (const p of this._pendingSevers) {
      p.limb.arm = new SeveredArm(world, this._physics.materials.ragdoll, {
        shoulder: p.limb.shoulder,
        elbow: p.limb.elbow,
        scale: p.limb.scale,
        velocity: p.limb.vel,
        angularVelocity: p.limb.angVel,
      });
    }
    this._pendingSevers.length = 0;
  }

  // Drive each severed arm from its rigid bodies; once at rest, retire the
  // bodies and leave the meshes where they landed (the world has
  // allowSleep = false, so a settled limb would jitter forever). Limbs linger
  // until _spawnFighters clears them.
  _updateSeveredLimbs(dt) {
    if (!this._severedLimbs || !this._severedLimbs.length) return;
    for (const l of this._severedLimbs) {
      if (l.settled || !l.arm || !l.arm.active) continue;
      l.arm.drive();
      const p = l.shoulder.position; // the torn end: the shoulder pivot
      // Drips trail off the torn end, carrying some of its tumble.
      l.bleed = Math.max(0, l.bleed - dt / 2.5);
      l.dripT -= dt;
      if (l.bleed > 0 && l.dripT <= 0 && dt > 0) {
        l.dripT = 0.03 + (1 - l.bleed) * 0.08;
        const k = 0.5 / dt;
        this._blood(p.x, p.y, p.z,
          (p.x - l.prev.x) * k + (Math.random() - 0.5) * 0.4, (p.y - l.prev.y) * k,
          (p.z - l.prev.z) * k + (Math.random() - 0.5) * 0.4, 0.007 + 0.008 * l.bleed);
      }
      l.prev.copy(p);
      l.restT = l.arm.speed < 0.4 ? l.restT + dt : 0;
      if (l.restT > 0.4) {
        l.settled = true;
        l.arm.dispose();
        // What is left in the limb seeps out into a pool around the torn end.
        this._bloodPool(p.x, p.z, 0.2, 3.5);
      }
    }
  }

  // Celebration confetti glitter over the ring at the K.O.
  // Dust in the spotlight: a few motes always adrift in the beam, each a dim warm speck that
  // lives a few seconds. It is what tells the eye the light is passing through air, and it
  // costs a handful of particles from the pool. None on the low tier; they hold still-ish
  // (no swirl) so reduced motion keeps them.
  _beamMotes(dt) {
    const spot = this.arena?.lights?.spot;
    if (!spot || !this._particles || Quality.tier() === 'low') return;
    this._moteAcc = (this._moteAcc || 0) + dt * MOTES_PER_SEC;
    if (this._moteAcc < 1) return;
    _moteAxis.copy(spot.target.position).sub(spot.position);
    const reach = Math.min(_moteAxis.length(), 10);
    if (reach < 0.5) return;
    _moteAxis.normalize();
    // Any two directions across the beam.
    _moteU.set(1, 0, 0).cross(_moteAxis);
    if (_moteU.lengthSq() < 1e-4) _moteU.set(0, 0, 1).cross(_moteAxis);
    _moteU.normalize();
    _moteV.copy(_moteAxis).cross(_moteU);
    while (this._moteAcc >= 1) {
      this._moteAcc -= 1;
      // Somewhere in the cone: further down the beam it is wider.
      // The lower two thirds: the top of the beam is above every camera.
      const along = 0.4 + Math.random() * 0.6;
      const radius = (0.35 + 3.4 * along) * Math.sqrt(Math.random());
      const angle = Math.random() * Math.PI * 2;
      const cx = Math.cos(angle) * radius, cy = Math.sin(angle) * radius;
      this._spawnParticle(
        spot.position.x + _moteAxis.x * reach * along + _moteU.x * cx + _moteV.x * cy,
        spot.position.y + _moteAxis.y * reach * along + _moteU.y * cx + _moteV.y * cy,
        spot.position.z + _moteAxis.z * reach * along + _moteU.z * cx + _moteV.z * cy,
        (Math.random() - 0.5) * 0.09, (Math.random() - 0.4) * 0.06, (Math.random() - 0.5) * 0.09,
        MOTE_COLOR, 3.5 + Math.random() * 3.5, -0.012, 0.03 + Math.random() * 0.03, 0);
    }
  }

  /**
   * A crate went to pieces at `pos`: a burst of slivers that scatter, drop and lie where
   * they fall (WebGPU only). The few big fragments props.js spawns are physics bodies and
   * are capped; these are what makes it read as a crate that actually splintered.
   */
  _crateSplinters(pos) {
    this._splinters?.emit({
      origin: [pos.x, pos.y, pos.z], box: [0.16, 0.14, 0.16],
      velocity: [0, 2.6, 0], scatter: [3.6, 2.4, 3.6], count: 90,
    });
  }

  _spawnConfetti() {
    if (this._confetti) {
      // Let go from the rafters over the whole ring; it drifts down and stays where it lands.
      this._confetti.emit({
        origin: [0, 6.7, 0], box: [3.6, 1.25, 3.6], velocity: [0, -0.6, 0], scatter: [0.5, 0.3, 0.5], count: 420,
      });
      return;
    }
    const colors = [0xff4a3c, 0x4a7dff, 0xffd257, 0xf5f2ec];
    for (let i = 0; i < 80; i++) {
      this._spawnParticle(
        (Math.random() - 0.5) * 7, 5.5 + Math.random() * 2.5, (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 0.8, -0.4 - Math.random() * 0.5, (Math.random() - 0.5) * 0.8,
        colors[(Math.random() * colors.length) | 0],
        2.2 + Math.random() * 1.4, -0.35, 0.09 + Math.random() * 0.07);
    }
  }
}

export const Vfx = VfxMethods.prototype;
