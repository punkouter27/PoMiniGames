// balloons.js — showtime module (see show.js). Mixin, `this` is the live game.
//
// It is a presidential fight, so it ends like a convention:
//
// BALLOON DROP. A net of glossy red/white/blue balloons (one InstancedMesh of 60; a full drop is 60 high / 30 medium
// / 12 low) waits above the ring, out of the fight framing. Released:
//   • on the 'result' of a KO win — about half the net;
//   • on the 'result' of the tournament final (cup round 2) or the 1P ladder's last rung — all;
//   • a handful on the 'fight' bell of those same title bouts, so they litter the canvas.
// Each balloon is a tiny body in our own sim: buoyant slow fall with drag and a gentle sway,
// bounces on the canvas, the ring's sides and the arena floor, the ropes as a loose wall,
// sphere-sphere separation through a small spatial hash, shoved by the fighters' rig capsules
// (live or ragdolled) and by the KO shockwave. A landed hit, or a limb moving fast through it,
// pops it: the instance hides, rubber shreds spray from the particle pool, audio.balloonPop.
// The net is restocked at each 'countdown' (the tournament leaves a few lying outside the ropes).
//
// BUNTING. Pleated half-moon fan swags along the truss and pennant strings from the corner
// posts out to the stands: Verlet cloth (positions written into fixed BufferGeometries in
// place), idling in a draft, kicked by nearby hits and hard by the KO.
//
// Built at init (the warm-up compiles every program); no per-frame allocation. Presentation
// only: Math.random, never the match RNG. Reduced motion: half the balloons, slower, no kicks.
import * as THREE from 'three';
import * as Quality from './quality.js';

const NET_Y = 7.7;            // the net's floor, above the fight framing
const NET_R = 3.7;            // radius of the net's footprint over the ring
const RING = 6;               // the ring box's half size (arena.js: 12 x 12)
const ROPE = 5.8;             // the ropes' line (corner posts at ±5.8)
const ROPE_LO = 0.32, ROPE_HI = 1.45;
const CANVAS_Y = 0.04, FLOOR_Y = -0.5;
const BAL_COLORS = [0xc4142c, 0xf3efe6, 0x1f46ab];
const POP_SPEED = 6.5;        // m/s: a limb this fast through a balloon pops it
const LADDER_TOP = 16;        // 1P ladder rungs (PoBrawlRoster.Fighters)
const POOL = 60;              // balloons in the net (high tier); see dropCap
const KEEP_MAX = 10;          // tournament: balloons left lying outside the ropes between bouts

const JOINTS = ['hips', 'torso', 'head', 'shoulderL', 'elbowL', 'fistL', 'shoulderR', 'elbowR', 'fistR',
  'hipL', 'kneeL', 'footL', 'hipR', 'kneeR', 'footR'];
const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
// Body capsules (the same shapes as hitboxes.js hurt capsules): [jointA, jointB, radius].
const CAPS = [
  [J.hips, J.torso, 0.34], [J.torso, J.head, 0.3],
  [J.shoulderL, J.elbowL, 0.12], [J.elbowL, J.fistL, 0.12],
  [J.shoulderR, J.elbowR, 0.12], [J.elbowR, J.fistR, 0.12],
  [J.hipL, J.kneeL, 0.16], [J.kneeL, J.footL, 0.14],
  [J.hipR, J.kneeR, 0.16], [J.kneeR, J.footR, 0.14],
];

const HASH = 128;             // spatial hash buckets (power of two)
const CELL = 0.5;             // hash cell, >= a balloon's diameter

// Bunting cloth.
const FAN_NA = 12, FAN_NR = 4;   // fan: angular segments x radial rings
const PEN_K = 16;                // pennant string: rope points
const CLOTH_H = 1 / 60;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

class BalloonsMethods {
  _initBalloons() {
    // The pool is built for the high tier whatever the boot tier is (the tier moves live, and a
    // zero-scaled instance costs next to nothing); each drop sizes itself to the live tier.
    const n = POOL;
    const b = {
      n, t: 0, live: 0, dirty: true,
      px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
      hx: new Float32Array(n), hy: new Float32Array(n), hz: new Float32Array(n),
      r: new Float32Array(n), ph: new Float32Array(n), delay: new Float32Array(n),
      tilt: new Float32Array(n * 2), col: new Uint8Array(n),
      st: new Uint8Array(n),      // 0 in the net, 1 released (waiting its delay), 2 live, 3 popped
      drag: 1, grav: -3.6,
      head: new Int16Array(HASH), next: new Int16Array(n), stamp: new Int32Array(n),
      fs: [0, 1].map(() => ({
        f: null, cur: new Float32Array(JOINTS.length * 3), prev: new Float32Array(JOINTS.length * 3),
        ok: new Uint8Array(JOINTS.length), hs: 1,
      })),
    };
    // Net homes: a loose disc of balloons, rejection-sampled for spacing.
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0;
      for (let tries = 0; tries < 200; tries++) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * NET_R;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr;
        let okay = true;
        for (let k = 0; k < i && okay; k++) {
          const dx = b.hx[k] - x, dz = b.hz[k] - z;
          if (dx * dx + dz * dz < 0.42 * 0.42) okay = Math.abs(b.hy[k] - NET_Y) > 0.3 && tries > 60;
        }
        if (okay) break;
      }
      b.hx[i] = x; b.hz[i] = z; b.hy[i] = NET_Y + Math.random() * 0.45;
      b.r[i] = 0.16 + Math.random() * 0.05;
      b.ph[i] = Math.random() * Math.PI * 2;
      b.col[i] = i % 3;
    }

    const geo = balloonGeometry();
    const physical = Quality.settings().physicalMaterials;
    const mat = physical
      ? new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.38, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.22,
        envMapIntensity: 1.3, emissive: 0x000000,
      })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0, envMapIntensity: 1.3 });
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) mesh.setColorAt(i, c.setHex(BAL_COLORS[b.col[i]]));
    mesh.frustumCulled = false;
    // No shadow: the waiting net sits over the ring and would spot the canvas with blobs.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.scene.add(mesh);
    b.mesh = mesh;
    this._bal = b;
    this._balRestock(false);
    this._initBunting();

    this._onShow((type, d) => this._balloonShow(type, d));
    this._onShowUpdate((dt) => {
      this._updateBalloons(dt);
      this._updateBunting(dt);
    });
    this._onShowDispose(() => {
      const bb = this._bal;
      if (bb) {
        this.scene?.remove(bb.mesh);
        bb.mesh.geometry.dispose();
        bb.mesh.material.dispose();
        bb.mesh.dispose();
      }
      this._bal = null;
      const bu = this._bunt;
      if (bu) {
        for (const m of [bu.fanMesh, bu.penMesh]) {
          if (!m) continue;
          this.scene?.remove(m);
          m.geometry.dispose();
          m.material.dispose();
        }
        bu.fanTex?.dispose();
      }
      this._bunt = null;
    });
  }

  // ── Events ───────────────────────────────────────────────────────────
  _balloonShow(type, d) {
    const b = this._bal;
    if (!b) return;
    const mode = this.options?.mode;
    const titleBout = (mode === 'tournament' && this._cup?.round === 2)
      || (mode === '1p' && !this.training && Number(this.options?.difficulty) >= LADDER_TOP);
    if (type === 'countdown') {
      this._balRestock(mode === 'tournament');
    } else if (type === 'fight') {
      if (titleBout) this._balloonDrop(Quality.tier() === 'low' ? 4 : 8, 0.8);
    } else if (type === 'result') {
      if (!d.winner) return;
      const ladderWin = mode === '1p' && d.winner === 1 && titleBout;
      const finalWin = mode === 'tournament' && this._cup?.round === 2;
      if (ladderWin || finalWin) this._balloonDrop(dropCap(), 2.2);
      else if (d.ko) this._balloonDrop(Math.ceil(dropCap() * 0.5), 1.4);
    } else if (type === 'hit') {
      if (d.point) this._balloonBlast(d.point.x, d.point.y, d.point.z, 0.8, 2.4 * (0.4 + (d.power || 0)), 2.2);
      if (d.point && !this._calm()) this._buntingKick(d.point.x, d.point.y, d.point.z, 2.2 * (0.3 + (d.power || 0)), 0.05);
    } else if (type === 'ko') {
      const loser = this.fighters?.find((f) => f.state === 'ko') || null;
      const p = loser?.rig?.root?.position;
      const x = p ? p.x : 0, z = p ? p.z : 0;
      this._balloonBlast(x, 0.6, z, 0, 7, 9);
      if (!this._calm()) this._buntingKick(x, 1, z, 9, 0.02);
    }
  }

  /** Release `count` balloons from the net over `spread` seconds (also a probe hook). */
  _balloonDrop(count, spread = 1.5) {
    const b = this._bal;
    if (!b) return 0;
    const calm = this._calm();
    if (calm) count = Math.ceil(count * 0.5);
    b.drag = calm ? 1.8 : 1;
    b.grav = calm ? -2.2 : -3.6;
    let dropped = 0;
    // Random picks over the balloons still in the net.
    for (let tries = 0; dropped < count && tries < b.n * 4; tries++) {
      const i = (Math.random() * b.n) | 0;
      if (b.st[i] !== 0) continue;
      b.st[i] = 1;
      b.delay[i] = Math.random() * spread;
      dropped++;
    }
    if (dropped < count) {
      for (let i = 0; i < b.n && dropped < count; i++) {
        if (b.st[i] !== 0) continue;
        b.st[i] = 1; b.delay[i] = Math.random() * spread; dropped++;
      }
    }
    if (dropped) b.live += dropped;
    return dropped;
  }

  // Back into the net. The tournament leaves up to KEEP_MAX lying outside the ropes.
  _balRestock(keepOutside) {
    const b = this._bal;
    let kept = 0;
    b.live = 0;
    for (let i = 0; i < b.n; i++) {
      const outside = Math.abs(b.px[i]) > RING || Math.abs(b.pz[i]) > RING;
      if (keepOutside && b.st[i] === 2 && outside && kept < KEEP_MAX && b.py[i] < 1) {
        kept++; b.live++;
        continue;
      }
      b.st[i] = 0;
      b.px[i] = b.hx[i]; b.py[i] = b.hy[i]; b.pz[i] = b.hz[i];
      b.vx[i] = b.vy[i] = b.vz[i] = 0;
      b.tilt[i * 2] = b.tilt[i * 2 + 1] = 0;
    }
    b.dirty = true;
  }

  // A blast at a point: pop everything within `popR` (+ the balloon's radius) and shove the
  // rest within `reach` away with `impulse` m/s at the centre, falling off with distance.
  _balloonBlast(x, y, z, popR, impulse, reach) {
    const b = this._bal;
    if (!b || !b.live) return;
    for (let i = 0; i < b.n; i++) {
      if (b.st[i] !== 2) continue;
      const dx = b.px[i] - x, dy = b.py[i] - y, dz = b.pz[i] - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      if (d < popR + b.r[i]) { this._balloonPop(i); continue; }
      if (d > reach) continue;
      const k = impulse * (1 - d / reach) / d;
      b.vx[i] += dx * k; b.vy[i] += dy * k + impulse * 0.25 * (1 - d / reach); b.vz[i] += dz * k;
    }
  }

  _balloonPop(i) {
    const b = this._bal;
    if (b.st[i] !== 2) return;
    b.st[i] = 3;
    b.live--;
    b.dirty = true;
    const x = b.px[i], y = b.py[i], z = b.pz[i], r = b.r[i];
    const color = BAL_COLORS[b.col[i]];
    const nShred = Quality.tier() === 'low' ? 4 : 9;
    for (let k = 0; k < nShred; k++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const sp = 2 + Math.random() * 3;
      this._spawnParticle(x + s * Math.cos(th) * r, y + u * r, z + s * Math.sin(th) * r,
        s * Math.cos(th) * sp, u * sp + 1, s * Math.sin(th) * sp,
        color, 0.45 + Math.random() * 0.35, -7, 0.025 + Math.random() * 0.02, 3);
    }
    // A pinch of light at the burst, local and tiny (flicker rule).
    this._spawnParticle(x, y, z, 0, 0, 0, 0xfff6e0, 0.08, 0, r * 1.6, 0);
    this.audio?.balloonPop?.(x, r);
  }

  // ── Simulation ───────────────────────────────────────────────────────
  _updateBalloons(dtIn) {
    const b = this._bal;
    if (!b) return;
    const dt = Math.min(dtIn, 1 / 30);
    b.t += dt;
    if (b.live > 0 && dt > 0) {
      this._balSampleFighters(dt);
      this._balIntegrate(dt);
      this._balCollide();
      this._balFighterPush(dt);
      b.dirty = true;
    }
    if (b.dirty) this._balWrite();
  }

  _balIntegrate(dt) {
    const b = this._bal;
    const damp = Math.exp(-b.drag * dt);
    const rest = Math.exp(-1.6 * dt);
    for (let i = 0; i < b.n; i++) {
      const st = b.st[i];
      if (st === 1) {
        b.delay[i] -= dt;
        if (b.delay[i] > 0) continue;
        b.st[i] = 2;
        b.vx[i] = (Math.random() - 0.5) * 0.8;
        b.vy[i] = -(2.2 + Math.random() * 1.6) * (b.drag > 1 ? 0.6 : 1);
        b.vz[i] = (Math.random() - 0.5) * 0.8;
      } else if (st !== 2) continue;
      const r = b.r[i];
      const x0 = b.px[i], z0 = b.pz[i];
      let x = x0, y = b.py[i], z = z0, vx = b.vx[i], vy = b.vy[i], vz = b.vz[i];
      const inRing0 = Math.abs(x0) < RING && Math.abs(z0) < RING;
      const ground = inRing0 ? CANVAS_Y : FLOOR_Y;
      vy += b.grav * dt;
      if (y - r > ground + 0.08) {
        // Sway on the way down: each balloon on its own slow phase.
        const ph = b.ph[i];
        vx += Math.sin(b.t * 1.3 + ph) * 0.8 * dt;
        vz += Math.cos(b.t * 1.05 + ph * 1.7) * 0.8 * dt;
      }
      vx *= damp; vy *= damp; vz *= damp;
      x += vx * dt; y += vy * dt; z += vz * dt;

      // The ring's top and sides, then the arena floor.
      const inRing = Math.abs(x) < RING && Math.abs(z) < RING;
      if (inRing && y - r < CANVAS_Y) {
        if (y > CANVAS_Y - 0.3 || inRing0) {
          y = CANVAS_Y + r;
          if (vy < 0) vy = vy < -0.35 ? -vy * 0.45 : 0;
          vx *= rest; vz *= rest;
        } else {
          // Came in under the canvas edge from outside: back out through the nearer side.
          const pxn = RING + r - Math.abs(x), pzn = RING + r - Math.abs(z);
          if (pxn < pzn) { x = Math.sign(x) * (RING + r); vx = -vx * 0.4; } else { z = Math.sign(z) * (RING + r); vz = -vz * 0.4; }
        }
      } else if (!inRing && y < CANVAS_Y && Math.abs(x) < RING + r && Math.abs(z) < RING + r) {
        const pxn = RING + r - Math.abs(x), pzn = RING + r - Math.abs(z);
        if (pxn < pzn) { x = Math.sign(x || 1) * (RING + r); vx = Math.abs(vx) * Math.sign(x) * 0.4; } else { z = Math.sign(z || 1) * (RING + r); vz = Math.abs(vz) * Math.sign(z) * 0.4; }
      }
      if (y - r < FLOOR_Y) {
        y = FLOOR_Y + r;
        if (vy < 0) vy = vy < -0.35 ? -vy * 0.45 : 0;
        vx *= rest; vz *= rest;
      }
      // The ropes, loosely: a wall band at the rope line from the bottom rope to the top.
      if (y > ROPE_LO - r && y < ROPE_HI + r) {
        if (Math.abs(z) < ROPE + r) {
          const a0 = Math.abs(x0), a = Math.abs(x);
          if (a0 <= ROPE && a > ROPE - r) { x = Math.sign(x) * (ROPE - r); vx = -vx * 0.35; } else if (a0 > ROPE && a < ROPE + r) { x = Math.sign(x) * (ROPE + r); vx = -vx * 0.35; }
        }
        if (Math.abs(x) < ROPE + r) {
          const a0 = Math.abs(z0), a = Math.abs(z);
          if (a0 <= ROPE && a > ROPE - r) { z = Math.sign(z) * (ROPE - r); vz = -vz * 0.35; } else if (a0 > ROPE && a < ROPE + r) { z = Math.sign(z) * (ROPE + r); vz = -vz * 0.35; }
        }
      }
      if (x > 11) { x = 11; vx = -Math.abs(vx); } else if (x < -11) { x = -11; vx = Math.abs(vx); }
      if (z > 11) { z = 11; vz = -Math.abs(vz); } else if (z < -11) { z = -11; vz = Math.abs(vz); }
      b.px[i] = x; b.py[i] = y; b.pz[i] = z;
      b.vx[i] = vx; b.vy[i] = vy; b.vz[i] = vz;
    }
  }

  // Sphere-sphere separation through a spatial hash (buckets + linked lists in typed arrays).
  _balCollide() {
    const b = this._bal;
    const { head, next, stamp, px, py, pz, vx, vy, vz, r } = b;
    head.fill(-1);
    const cell = (v) => Math.floor(v / CELL);
    const hash = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (HASH - 1);
    for (let i = 0; i < b.n; i++) {
      if (b.st[i] !== 2) continue;
      const h = hash(cell(px[i]), cell(py[i]), cell(pz[i]));
      next[i] = head[h];
      head[h] = i;
    }
    stamp.fill(-1);
    for (let i = 0; i < b.n; i++) {
      if (b.st[i] !== 2) continue;
      const cx = cell(px[i]), cy = cell(py[i]), cz = cell(pz[i]);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        for (let j = head[hash(cx + ox, cy + oy, cz + oz)]; j !== -1; j = next[j]) {
          // Aliased buckets can list a pair twice; the stamp resolves each pair once.
          if (j <= i || stamp[j] === i) continue;
          stamp[j] = i;
          const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
          const rr = r[i] + r[j];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-8) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
          const push = (rr - d) * 0.5;
          px[i] -= nx * push; py[i] -= ny * push; pz[i] -= nz * push;
          px[j] += nx * push; py[j] += ny * push; pz[j] += nz * push;
          const rel = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny + (vz[j] - vz[i]) * nz;
          if (rel < 0) {
            const k = rel * 0.85;
            vx[i] += nx * k; vy[i] += ny * k; vz[i] += nz * k;
            vx[j] -= nx * k; vy[j] -= ny * k; vz[j] -= nz * k;
          }
        }
      }
    }
  }

  // Joint world positions (and last frame's, for limb speed) per corner.
  _balSampleFighters() {
    const b = this._bal;
    for (let s = 0; s < 2; s++) {
      const slot = b.fs[s];
      const f = this.fighters?.[s] || null;
      const fresh = slot.f !== f;
      slot.f = f;
      if (!f) continue;
      const joints = f.rig?.joints;
      slot.hs = f.rig?.config?.heightScale || 1;
      if (!fresh) slot.prev.set(slot.cur);
      for (let j = 0; j < JOINTS.length; j++) {
        const o = joints?.[JOINTS[j]];
        slot.ok[j] = o ? 1 : 0;
        if (!o) continue;
        o.getWorldPosition(_v);
        slot.cur[j * 3] = _v.x; slot.cur[j * 3 + 1] = _v.y; slot.cur[j * 3 + 2] = _v.z;
      }
      if (fresh) slot.prev.set(slot.cur);
    }
  }

  // Shove balloons out of the fighters' capsules; a fast limb pops instead.
  _balFighterPush(dt) {
    const b = this._bal;
    const inv = 1 / Math.max(dt, 1e-3);
    for (let s = 0; s < 2; s++) {
      const slot = b.fs[s];
      if (!slot.f) continue;
      const c = slot.cur, p = slot.prev, ok = slot.ok;
      const hx = c[0], hy = c[1], hz = c[2];
      for (let i = 0; i < b.n; i++) {
        if (b.st[i] !== 2) continue;
        let x = b.px[i], y = b.py[i], z = b.pz[i];
        const ddx = x - hx, ddy = y - hy, ddz = z - hz;
        if (ddx * ddx + ddy * ddy + ddz * ddz > 2.6 * 2.6) continue;
        const r = b.r[i];
        for (let k = 0; k < CAPS.length; k++) {
          const ja = CAPS[k][0], jb = CAPS[k][1];
          if (!ok[ja] || !ok[jb]) continue;
          const ax = c[ja * 3], ay = c[ja * 3 + 1], az = c[ja * 3 + 2];
          const sx = c[jb * 3] - ax, sy = c[jb * 3 + 1] - ay, sz = c[jb * 3 + 2] - az;
          const len2 = sx * sx + sy * sy + sz * sz;
          let t = len2 > 1e-8 ? ((x - ax) * sx + (y - ay) * sy + (z - az) * sz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + sx * t, qy = ay + sy * t, qz = az + sz * t;
          const dx = x - qx, dy = y - qy, dz = z - qz;
          const R = CAPS[k][2] * slot.hs + r;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R * R) continue;
          // Segment velocity at the contact, from last frame's joints.
          const svx = ((c[ja * 3] - p[ja * 3]) * (1 - t) + (c[jb * 3] - p[jb * 3]) * t) * inv;
          const svy = ((c[ja * 3 + 1] - p[ja * 3 + 1]) * (1 - t) + (c[jb * 3 + 1] - p[jb * 3 + 1]) * t) * inv;
          const svz = ((c[ja * 3 + 2] - p[ja * 3 + 2]) * (1 - t) + (c[jb * 3 + 2] - p[jb * 3 + 2]) * t) * inv;
          if (svx * svx + svy * svy + svz * svz > POP_SPEED * POP_SPEED) { this._balloonPop(i); break; }
          const d = Math.sqrt(d2) || 1e-4;
          const nx = d2 > 1e-8 ? dx / d : 0, ny = d2 > 1e-8 ? dy / d : 1, nz = d2 > 1e-8 ? dz / d : 0;
          x = qx + nx * R; y = qy + ny * R; z = qz + nz * R;
          // Light as air: it takes the limb's normal speed and then some.
          const rel = (b.vx[i] - svx) * nx + (b.vy[i] - svy) * ny + (b.vz[i] - svz) * nz;
          if (rel < 0) {
            b.vx[i] -= nx * rel * 1.4; b.vy[i] -= ny * rel * 1.4; b.vz[i] -= nz * rel * 1.4;
          }
        }
        if (b.st[i] !== 2) continue;
        if (y < CANVAS_Y + r && Math.abs(x) < RING && Math.abs(z) < RING) y = CANVAS_Y + r;
        b.px[i] = x; b.py[i] = y; b.pz[i] = z;
      }
    }
  }

  // Instance matrices: a small tilt into the drift plus a lazy wobble; hidden ones zero-scaled.
  _balWrite() {
    const b = this._bal;
    const mesh = b.mesh;
    for (let i = 0; i < b.n; i++) {
      const st = b.st[i];
      if (st === 3) { mesh.setMatrixAt(i, _zero); continue; }
      const r = b.r[i];
      let ax = 1, az = 0, ang = 0.05 * Math.sin(b.t * 1.7 + b.ph[i]);
      if (st === 2) {
        const h = Math.hypot(b.vx[i], b.vz[i]);
        // Eased so a bounce does not snap the balloon's lean.
        const tx = h > 0.05 ? b.vz[i] / h : b.tilt[i * 2], tz = h > 0.05 ? -b.vx[i] / h : b.tilt[i * 2 + 1];
        b.tilt[i * 2] += (tx - b.tilt[i * 2]) * 0.1;
        b.tilt[i * 2 + 1] += (tz - b.tilt[i * 2 + 1]) * 0.1;
        const l = Math.hypot(b.tilt[i * 2], b.tilt[i * 2 + 1]);
        if (l > 1e-3) { ax = b.tilt[i * 2] / l; az = b.tilt[i * 2 + 1] / l; }
        ang += Math.min(0.45, h * 0.3);
      }
      _axis.set(ax, 0, az);
      _q.setFromAxisAngle(_axis, ang);
      _v.set(b.px[i], b.py[i], b.pz[i]);
      _s.set(r, r, r);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    b.dirty = false;
  }

  // ── Bunting ──────────────────────────────────────────────────────────
  _initBunting() {
    const P = [];        // particle rest positions (x, y, z)
    const inv = [];      // inverse mass: 0 pinned
    const C = [];        // constraint pairs
    const slack = [];    // per constraint: rest-length multiplier
    const add = (x, y, z, pinned) => { P.push(x, y, z); inv.push(pinned ? 0 : 1); return inv.length - 1; };
    const link = (a, b, k = 1) => { C.push(a, b); slack.push(k); };

    // Fans: half-moons hung along the truss beams, pleated (accordion offsets out of plane).
    const TRUSS_Y = 9.27, TRUSS = 7.5;
    const along = [-5.7, -3.4, 3.4, 5.7];
    const fanV = [];     // render vertices → particle index, uv, fallback normal, neighbours
    for (const side of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const [sx, sz] = side;
      // Tangent along the beam, normal toward the ring.
      const tx = sz !== 0 ? 1 : 0, tz = sx !== 0 ? 1 : 0;
      const nx = -sx, nz = -sz;
      for (const a of along) {
        const R = Math.abs(a) > 5 ? 0.85 : 1.0;
        const cx = sx * (TRUSS - 0.16) + tx * a, cz = sz * (TRUSS - 0.16) + tz * a;
        const center = add(cx, TRUSS_Y, cz, true);
        const grid = [];
        for (let j = 1; j <= FAN_NR; j++) {
          const row = [];
          for (let i = 0; i <= FAN_NA; i++) {
            const th = Math.PI * i / FAN_NA, rr = R * j / FAN_NR;
            const u = -Math.cos(th) * rr, v = -Math.sin(th) * rr;
            const w = (i === 0 || i === FAN_NA) ? 0 : (i % 2 ? 0.055 : -0.02) * (j / FAN_NR);
            row.push(add(cx + tx * u + nx * w, TRUSS_Y + v, cz + tz * u + nz * w, i === 0 || i === FAN_NA));
          }
          grid.push(row);
        }
        const at = (j, i) => (j === 0 ? center : grid[j - 1][i]);
        for (let j = 1; j <= FAN_NR; j++) {
          for (let i = 0; i <= FAN_NA; i++) {
            link(at(j - 1, i), at(j, i));                           // radial
            if (i < FAN_NA) link(at(j, i), at(j, i + 1));            // arc
            if (i < FAN_NA && j > 1) { link(at(j - 1, i), at(j, i + 1)); link(at(j - 1, i + 1), at(j, i)); }
            if (i < FAN_NA - 1) link(at(j, i), at(j, i + 2));        // bend across a pleat
          }
        }
        const base = fanV.length;
        for (let j = 0; j <= FAN_NR; j++) {
          for (let i = 0; i <= FAN_NA; i++) {
            fanV.push({
              p: at(j, i), u: i / FAN_NA, v: j / FAN_NR, n: [nx, 0, nz],
              l: at(j, Math.max(0, i - 1)), r: at(j, Math.min(FAN_NA, i + 1)),
              up: at(Math.max(0, j - 1), i), dn: at(Math.min(FAN_NR, j + 1), i),
              base,
            });
          }
        }
      }
    }
    const fanCount = fanV.length / ((FAN_NR + 1) * (FAN_NA + 1));

    // Pennant strings: from each corner post's cap out over the stands, a flag per segment.
    const penFlags = [];  // [ropeA, ropeB, tip]
    const PEN_COLORS = [0xc4142c, 0xf3efe6, 0x1f46ab];
    const kRope = PEN_K;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const ax = sx * 5.8, ay = 1.66, az = sz * 5.8;
      const bx = sx * 10.2, by = 5.4, bz = sz * 10.2;
      const rope = [];
      for (let k = 0; k < kRope; k++) {
        const t = k / (kRope - 1);
        rope.push(add(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, k === 0 || k === kRope - 1));
      }
      for (let k = 0; k < kRope - 1; k++) {
        link(rope[k], rope[k + 1], 1.035);   // a little slack: the string sags into a catenary
        const ia = rope[k] * 3, ib = rope[k + 1] * 3;
        const tip = add((P[ia] + P[ib]) / 2, (P[ia + 1] + P[ib + 1]) / 2 - 0.3, (P[ia + 2] + P[ib + 2]) / 2, false);
        link(rope[k], tip);
        link(rope[k + 1], tip);
        penFlags.push([rope[k], rope[k + 1], tip]);
      }
    }

    const N = inv.length;
    const pos = new Float32Array(P);
    const bu = {
      N, pos, prev: new Float32Array(P), inv: new Float32Array(inv),
      ca: new Uint32Array(C.length / 2), cb: new Uint32Array(C.length / 2), rest: new Float32Array(C.length / 2),
      acc: 0, t: 0,
    };
    for (let c = 0; c < C.length / 2; c++) {
      const a = C[c * 2], b2 = C[c * 2 + 1];
      bu.ca[c] = a; bu.cb[c] = b2;
      const dx = pos[a * 3] - pos[b2 * 3], dy = pos[a * 3 + 1] - pos[b2 * 3 + 1], dz = pos[a * 3 + 2] - pos[b2 * 3 + 2];
      bu.rest[c] = Math.sqrt(dx * dx + dy * dy + dz * dz) * slack[c];
    }

    // Fan mesh: one geometry for every fan, written in place.
    const FV = fanV.length;
    const fanGeo = new THREE.BufferGeometry();
    const fpos = new THREE.BufferAttribute(new Float32Array(FV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const fnor = new THREE.BufferAttribute(new Float32Array(FV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const fuv = new Float32Array(FV * 2);
    bu.fanMap = new Uint32Array(FV * 5);        // particle, left, right, up, down
    bu.fanN = new Float32Array(FV * 3);
    fanV.forEach((fv, k) => {
      fuv[k * 2] = fv.u; fuv[k * 2 + 1] = fv.v;
      bu.fanMap.set([fv.p, fv.l, fv.r, fv.up, fv.dn], k * 5);
      bu.fanN.set(fv.n, k * 3);
    });
    fanGeo.setAttribute('position', fpos);
    fanGeo.setAttribute('normal', fnor);
    fanGeo.setAttribute('uv', new THREE.BufferAttribute(fuv, 2));
    const idx = [];
    const per = (FAN_NR + 1) * (FAN_NA + 1);
    for (let f = 0; f < fanCount; f++) {
      const o = f * per;
      for (let j = 0; j < FAN_NR; j++) {
        for (let i = 0; i < FAN_NA; i++) {
          const a = o + j * (FAN_NA + 1) + i, b2 = a + 1, c = a + FAN_NA + 1, d = c + 1;
          if (j > 0) idx.push(a, c, b2);
          idx.push(b2, c, d);
        }
      }
    }
    fanGeo.setIndex(idx);
    bu.fanTex = fanTexture();
    bu.fanMesh = new THREE.Mesh(fanGeo, new THREE.MeshStandardMaterial({
      map: bu.fanTex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      emissive: 0xffffff, emissiveMap: bu.fanTex, emissiveIntensity: 0.14,
    }));
    bu.fanMesh.frustumCulled = false;
    this.scene.add(bu.fanMesh);

    // Pennant mesh: three unshared vertices per flag, so each keeps its own flat colour.
    const PV = penFlags.length * 3;
    const penGeo = new THREE.BufferGeometry();
    const ppos = new THREE.BufferAttribute(new Float32Array(PV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const pnor = new THREE.BufferAttribute(new Float32Array(PV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const pcol = new Float32Array(PV * 3);
    const cc = new THREE.Color();
    bu.penMap = new Uint32Array(PV);
    penFlags.forEach((fl, k) => {
      cc.setHex(PEN_COLORS[k % 3]);
      for (let v = 0; v < 3; v++) {
        bu.penMap[k * 3 + v] = fl[v];
        pcol.set([cc.r, cc.g, cc.b], (k * 3 + v) * 3);
      }
    });
    penGeo.setAttribute('position', ppos);
    penGeo.setAttribute('normal', pnor);
    penGeo.setAttribute('color', new THREE.BufferAttribute(pcol, 3));
    bu.penMesh = new THREE.Mesh(penGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0,
    }));
    bu.penMesh.frustumCulled = false;
    this.scene.add(bu.penMesh);
    this._bunt = bu;
    // Settle the cloth under gravity before the first frame, then publish it.
    for (let s = 0; s < 90; s++) this._clothStep(CLOTH_H, 0);
    this._buntingWrite();
  }

  // A push on the cloth from a point: `power` m/s at the centre, `fall` the distance falloff.
  _buntingKick(x, y, z, power, fall) {
    const bu = this._bunt;
    if (!bu) return;
    const { pos, prev, inv } = bu;
    for (let i = 0; i < bu.N; i++) {
      if (!inv[i]) continue;
      const dx = pos[i * 3] - x, dy = pos[i * 3 + 1] - y, dz = pos[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2) || 1;
      const k = power / (1 + fall * d2) * CLOTH_H;
      const j = 0.6 + Math.random() * 0.8;
      prev[i * 3] -= (dx / d) * k * j;
      prev[i * 3 + 1] -= ((dy / d) * 0.5 + 0.4) * k * j;
      prev[i * 3 + 2] -= (dz / d) * k * j;
    }
  }

  _clothStep(h, t) {
    const bu = this._bunt;
    const { pos, prev, inv, ca, cb, rest } = bu;
    const calm = this._calm();
    const amp = calm ? 0.5 : 1.3;
    const gx = Math.sin(t * 0.37) * 0.6 * amp, gz = Math.cos(t * 0.29) * 0.6 * amp;
    const h2 = h * h;
    for (let i = 0; i < bu.N; i++) {
      if (!inv[i]) continue;
      const o = i * 3;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      // The hall's draft: a slow drifting breeze plus position-varying turbulence.
      const ax = gx + Math.sin(t * 1.7 + x * 0.9 + z * 0.4) * 0.8 * amp;
      const az = gz + Math.cos(t * 1.4 + z * 0.8 - x * 0.3) * 0.8 * amp;
      const ay = -9.8 + Math.sin(t * 2.3 + x * 0.5 + z * 0.6) * 0.5 * amp;
      const vx = (x - prev[o]) * 0.985, vy = (y - prev[o + 1]) * 0.985, vz = (z - prev[o + 2]) * 0.985;
      prev[o] = x; prev[o + 1] = y; prev[o + 2] = z;
      pos[o] = x + vx + ax * h2; pos[o + 1] = y + vy + ay * h2; pos[o + 2] = z + vz + az * h2;
    }
    const iters = Quality.tier() === 'low' ? 2 : 4;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < ca.length; c++) {
        const a = ca[c] * 3, b = cb[c] * 3;
        const wa = inv[ca[c]], wb = inv[cb[c]];
        const w = wa + wb;
        if (!w) continue;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const k = (d - rest[c]) / (d * w);
        pos[a] += dx * k * wa; pos[a + 1] += dy * k * wa; pos[a + 2] += dz * k * wa;
        pos[b] -= dx * k * wb; pos[b + 1] -= dy * k * wb; pos[b + 2] -= dz * k * wb;
      }
    }
  }

  _updateBunting(dt) {
    const bu = this._bunt;
    if (!bu) return;
    bu.acc = Math.min(bu.acc + dt, CLOTH_H * 3);
    let stepped = false;
    while (bu.acc >= CLOTH_H) {
      bu.acc -= CLOTH_H;
      bu.t += CLOTH_H;
      this._clothStep(CLOTH_H, bu.t);
      stepped = true;
    }
    if (stepped) this._buntingWrite();
  }

  _buntingWrite() {
    const bu = this._bunt;
    const pos = bu.pos;
    // Fans: positions plus grid normals from the neighbours (pleats shade as creases).
    const fp = bu.fanMesh.geometry.attributes.position, fn = bu.fanMesh.geometry.attributes.normal;
    const fa = fp.array, na = fn.array, map = bu.fanMap, fb = bu.fanN;
    const FV = fa.length / 3;
    for (let k = 0; k < FV; k++) {
      const m = k * 5;
      const p = map[m] * 3, l = map[m + 1] * 3, r = map[m + 2] * 3, u = map[m + 3] * 3, d = map[m + 4] * 3;
      fa[k * 3] = pos[p]; fa[k * 3 + 1] = pos[p + 1]; fa[k * 3 + 2] = pos[p + 2];
      const ux = pos[r] - pos[l], uy = pos[r + 1] - pos[l + 1], uz = pos[r + 2] - pos[l + 2];
      const vx = pos[d] - pos[u], vy = pos[d + 1] - pos[u + 1], vz = pos[d + 2] - pos[u + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-6) { nx = fb[k * 3]; ny = fb[k * 3 + 1]; nz = fb[k * 3 + 2]; len = 1; }
      // Keep the normal on the ring side so the lit face is the one the camera sees.
      const s = (nx * fb[k * 3] + nz * fb[k * 3 + 2]) < 0 ? -1 / len : 1 / len;
      na[k * 3] = nx * s; na[k * 3 + 1] = ny * s; na[k * 3 + 2] = nz * s;
    }
    fp.needsUpdate = true;
    fn.needsUpdate = true;
    // Pennants: flat normal per flag.
    const pp = bu.penMesh.geometry.attributes.position, pn = bu.penMesh.geometry.attributes.normal;
    const pa = pp.array, qa = pn.array, pm = bu.penMap;
    for (let f = 0; f < pm.length; f += 3) {
      const a = pm[f] * 3, b = pm[f + 1] * 3, c = pm[f + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let v = 0; v < 3; v++) {
        const src = pm[f + v] * 3, dst = (f + v) * 3;
        pa[dst] = pos[src]; pa[dst + 1] = pos[src + 1]; pa[dst + 2] = pos[src + 2];
        qa[dst] = nx; qa[dst + 1] = ny; qa[dst + 2] = nz;
      }
    }
    pp.needsUpdate = true;
    pn.needsUpdate = true;
  }
}

// Balloons a full drop releases at the live tier.
function dropCap() {
  const t = Quality.tier();
  return t === 'high' ? POOL : t === 'medium' ? 30 : 12;
}

// A unit balloon: a sphere stretched tall, tapered toward the bottom, with a knot.
function balloonGeometry() {
  const geo = new THREE.SphereGeometry(1, 20, 14);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y < 0) {
      const k = 1 - 0.3 * y * y;
      x *= k; z *= k;
    }
    y *= 1.14;
    if (y < -1.1) y -= 0.16;  // the bottom pole becomes the tied knot
    p.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

// The fan's face: u runs around the half-moon, v from the centre out. A starred blue centre,
// then white / red / white / red bands, a gold hem, faint pleat creases.
function fanTexture() {
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // flipY: v = 0 (the centre) is the canvas bottom.
  const band = (v0, v1, color) => { g.fillStyle = color; g.fillRect(0, H * (1 - v1), W, H * (v1 - v0) + 1); };
  band(0, 0.42, '#1b3c8f');
  band(0.42, 0.56, '#f4f0e6');
  band(0.56, 0.7, '#c01a2e');
  band(0.7, 0.84, '#f4f0e6');
  band(0.84, 0.97, '#c01a2e');
  band(0.97, 1, '#e3b54a');
  g.fillStyle = '#f7f3ea';
  for (let k = 0; k < 7; k++) {
    const x = (k + 0.5) / 7 * W, y = H * (1 - 0.3);
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 2.6 : 6;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = 1; i < FAN_NA; i++) g.fillRect(i / FAN_NA * W - 1, 0, 2, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export const Balloons = BalloonsMethods.prototype;
