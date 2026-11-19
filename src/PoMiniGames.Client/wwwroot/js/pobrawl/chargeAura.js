// chargeAura.js — showtime module (see show.js). Mixin, `this` is the live game.
//
// While a fighter holds an attack (f.state === 'charge') the striking fist (punch) or shoe
// (kick) wears an aura that fills with f.chargeAmt:
//   • an additive fresnel energy shell with a swirling band pattern, white → gold,
//   • a larger, fainter heat-shimmer shell (wobbling rings), not on low tier,
//   • motes spiralling in, written to the shared GPU particle pool (vfx.js), not on low tier,
//   • a four-point star glint that flashes once at full charge and then twinkles, not on low.
// On 'release' the shell flares out over a fifth of a second (scaled by chargeAmt) with a
// burst of gold motes; on any other exit (hit, block, KO) it fades in a few frames.
//
// One slot per corner (fighters[0] / fighters[1]), so both can charge at once. Every mesh is
// built hidden at init: _warmupRender compiles the programs up front, nothing links mid-fight.
// Presentation only: Math.random, never the match RNG. Local light only (flicker rule).
import * as THREE from 'three-eco/webgpu';
import {
  abs, atan, dot, mix, normalView, positionGeometry, positionLocal, positionViewDirection, pow, sin,
  smoothstep, uniform, vec3,
} from 'three-eco/tsl';
import * as Quality from './quality.js';

const _p = new THREE.Vector3();
const _gold = new THREE.Color(0xffd257);
const _white = new THREE.Color(0xe6f0ff);
const _c = new THREE.Color();

const FLARE_SEC = 0.22;

// One aura shell material. `shimmer` picks the heat-haze variant: its surface wobbles, so
// its rings read as heat haze, not a ball. Additive, so the colour IS the contribution.
function shellMaterial(shimmer) {
  const uTime = uniform(0), uAmt = uniform(0), uFade = uniform(0);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const vP = positionGeometry;
  if (shimmer) {
    const wobble = sin(vP.y.mul(9).add(uTime.mul(11))).mul(sin(vP.x.mul(7).sub(uTime.mul(8)))).mul(0.09).add(1);
    mat.positionNode = positionLocal.mul(wobble);
  }
  const fr = abs(dot(normalView, positionViewDirection)).oneMinus();
  const a = atan(vP.z, vP.x);
  const col = mix(vec3(0.82, 0.9, 1.0), vec3(1.0, 0.7, 0.2), smoothstep(0, 1, uAmt));
  let k;
  if (shimmer) {
    // Heat shimmer: thin travelling rings, bent by a slow swirl, faint at the rim.
    const bands = sin(vP.y.mul(26).sub(uTime.mul(13)).add(sin(a.mul(3).add(uTime.mul(3))).mul(2.2)));
    k = smoothstep(0.55, 1.0, bands).mul(pow(fr, 1.4)).mul(0.2);
  } else {
    // Energy shell: two counter-rotating swirls over a fresnel rim.
    const s1 = sin(a.mul(4).add(vP.y.mul(6)).sub(uTime.mul(uAmt.mul(7).add(6)))).mul(0.5).add(0.5);
    const s2 = sin(a.mul(7).sub(vP.y.mul(9)).add(uTime.mul(9))).mul(0.5).add(0.5);
    const energy = mix(s1, s1.mul(s2), 0.5);
    k = pow(fr, 2).mul(energy.mul(0.95).add(0.35)).add(pow(fr, 6).mul(0.55))
      // A hot core seen through the face, so it reads as energy, not a soap bubble.
      .add(pow(fr.oneMinus(), 3).mul(uAmt.mul(0.5).add(0.12)).mul(energy.mul(0.4).add(0.6)));
  }
  mat.colorNode = col.mul(k).mul(uFade).mul(uAmt.mul(0.95).add(0.3));
  mat.uniforms = { uTime, uAmt, uFade };
  return mat;
}

class ChargeAuraMethods {
  _initChargeAura() {
    const geo = new THREE.SphereGeometry(1, 24, 16);
    const glintTex = starTexture();
    const slots = [0, 1].map(() => {
      const shell = new THREE.Mesh(geo, shellMaterial(false));
      const shimmer = new THREE.Mesh(geo, shellMaterial(true));
      const glint = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glintTex, color: 0xfff1c0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
      }));
      shell.renderOrder = shimmer.renderOrder = 3;
      glint.renderOrder = 4;
      for (const o of [shell, shimmer, glint]) {
        o.visible = false;
        o.frustumCulled = false;
        this.scene.add(o);
      }
      return {
        shell, shimmer, glint, f: null, joint: 'fistR',
        amt: 0, fade: 0, flare: 0, flareAmt: 0, full: false, glintT: 0, moteAcc: 0, time: 0,
      };
    });
    this._aura = { geo, glintTex, slots };

    this._onShow((type, d) => {
      if (type === 'chargeStart') {
        const s = this._auraSlot(d.f);
        if (!s) return;
        s.f = d.f;
        s.joint = d.name === 'kick' ? 'footR' : 'fistR';
        s.amt = 0; s.full = false; s.glintT = 0; s.moteAcc = 0; s.flare = 0;
      } else if (type === 'release') {
        const s = this._auraSlot(d.f);
        if (!s || !(d.chargeAmt > 0.06)) return;
        s.f = d.f;
        s.joint = d.name === 'kick' ? 'footR' : 'fistR';
        s.flare = FLARE_SEC;
        s.flareAmt = d.chargeAmt;
        s.fade = Math.max(s.fade, 1);
        this._auraBurst(s, d.chargeAmt);
      } else if (type === 'reset' || type === 'countdown') {
        for (const s of this._aura.slots) this._auraHide(s);
      }
    });
    this._onShowUpdate((dt) => this._updateChargeAura(dt));
    this._onShowDispose(() => {
      const a = this._aura;
      if (!a) return;
      for (const s of a.slots) {
        for (const o of [s.shell, s.shimmer, s.glint]) { this.scene?.remove(o); o.material.dispose(); }
      }
      a.geo.dispose();
      a.glintTex.dispose();
      this._aura = null;
    });
  }

  _auraSlot(f) {
    const i = this.fighters ? this.fighters.indexOf(f) : -1;
    return i === 0 || i === 1 ? this._aura?.slots[i] : null;
  }

  _auraHide(s) {
    s.f = null; s.fade = 0; s.flare = 0; s.amt = 0; s.full = false; s.glintT = 0;
    s.shell.visible = s.shimmer.visible = s.glint.visible = false;
  }

  // The release flare: a ring of gold motes thrown off the fist, and the star flashed big.
  _auraBurst(s, amt) {
    if (Quality.tier() === 'low') return;
    const joint = s.f?.rig?.joints[s.joint];
    if (!joint) return;
    joint.getWorldPosition(_p);
    const calm = this._calm();
    const n = Math.round((6 + 22 * amt) * (calm ? 0.4 : 1));
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u), sp = 2.2 + Math.random() * 3.2 * amt;
      _c.copy(_white).lerp(_gold, 0.4 + 0.6 * amt);
      this._spawnParticle(_p.x, _p.y, _p.z, r * Math.cos(th) * sp, u * sp + 0.6, r * Math.sin(th) * sp,
        _c, 0.25 + Math.random() * 0.15, -2, 0.035 + 0.03 * Math.random(), 4.5);
    }
    if (!calm && amt > 0.5) s.glintT = Math.max(s.glintT, 0.18 + 0.12 * amt);
  }

  _updateChargeAura(dt) {
    const a = this._aura;
    if (!a) return;
    const low = Quality.tier() === 'low';
    const calm = this._calm();
    for (let i = 0; i < 2; i++) {
      const s = a.slots[i];
      const f = this.fighters?.[i];
      if (s.f && s.f !== f) this._auraHide(s);
      const charging = !!f && f.state === 'charge';
      if (charging && s.f !== f) {
        // A charge whose chargeStart this slot missed (a rebuilt rig): adopt it.
        s.f = f;
        s.joint = f.chargeName === 'kick' ? 'footR' : 'fistR';
        s.full = false;
      }
      if (charging) {
        s.amt = f.chargeAmt || 0;
        s.fade = Math.min(1, s.fade + dt * 8);
      } else if (s.flare > 0) {
        s.flare = Math.max(0, s.flare - dt);
      } else {
        s.fade = Math.max(0, s.fade - dt * 12);
      }
      const joint = s.f?.rig?.joints[s.joint];
      if (!joint || (s.fade <= 0 && s.flare <= 0 && s.glintT <= 0)) {
        if (s.shell.visible || s.glint.visible) this._auraHide(s);
        continue;
      }
      joint.getWorldPosition(_p);
      s.time += dt * (calm ? 0.45 : 1);
      const hs = s.f.rig.config?.heightScale || 1;
      const flareK = s.flare > 0 ? s.flare / FLARE_SEC : 0;     // 1 → 0 over the flare
      const amt = s.flare > 0 ? s.flareAmt : s.amt;
      const fade = s.flare > 0 ? flareK * flareK : s.fade;
      const pulse = amt >= 1 && !calm ? 1 + 0.06 * Math.sin(s.time * 34) : 1;
      const grow = s.flare > 0 ? 1 + (1 - flareK) * (1.2 + 1.4 * amt) : 1;

      const su = s.shell.material.uniforms;
      su.uTime.value = s.time; su.uAmt.value = amt; su.uFade.value = fade;
      s.shell.position.copy(_p);
      s.shell.scale.setScalar(hs * (0.1 + 0.06 * amt) * pulse * grow);
      s.shell.visible = true;

      const shim = !low && s.flare <= 0 && amt > 0.08;
      s.shimmer.visible = shim;
      if (shim) {
        const mu = s.shimmer.material.uniforms;
        mu.uTime.value = s.time; mu.uAmt.value = amt; mu.uFade.value = fade;
        s.shimmer.position.copy(_p);
        s.shimmer.position.y += 0.04;
        s.shimmer.scale.set(hs * (0.17 + 0.07 * amt), hs * (0.22 + 0.1 * amt), hs * (0.17 + 0.07 * amt));
      }

      // Motes: spawned on a ring around the fist with tangential + inward velocity and heavy
      // drag, so each one curls in toward the knuckles and dies there.
      if (!low && charging && s.amt > 0.1) {
        s.moteAcc += dt * (14 + 46 * s.amt) * (calm ? 0.35 : 1);
        while (s.moteAcc >= 1) {
          s.moteAcc -= 1;
          const th = Math.random() * Math.PI * 2;
          const R = hs * (0.3 + 0.12 * Math.random());
          const ox = Math.cos(th), oz = Math.sin(th), oy = (Math.random() - 0.5) * 0.7;
          const tan = 1.6 + 1.6 * s.amt, inward = 1.4 + s.amt;
          _c.copy(_white).lerp(_gold, s.amt);
          this._spawnParticle(_p.x + ox * R, _p.y + oy * R, _p.z + oz * R,
            -oz * tan - ox * inward, -oy * inward + 0.35, ox * tan - oz * inward,
            _c, 0.28 + Math.random() * 0.14, 0, 0.03 + 0.025 * Math.random(), 3.2);
        }
      }

      // The star: one flash as the coil tops out, then a slow twinkle while it is held.
      if (charging && s.amt >= 1 && !s.full) {
        s.full = true;
        if (!calm) s.glintT = Math.max(s.glintT, 0.3);
      }
      s.glintT = Math.max(0, s.glintT - dt);
      const twinkle = charging && s.amt >= 1 ? 0.35 + 0.15 * Math.sin(s.time * 9) : 0;
      const flash = s.glintT > 0 ? Math.sin(Math.min(1, s.glintT / 0.3) * Math.PI) : 0;
      const gOn = !low && (twinkle > 0 || flash > 0);
      s.glint.visible = gOn;
      if (gOn) {
        s.glint.position.copy(_p);
        s.glint.material.opacity = Math.min(1, twinkle + flash) * Math.max(fade, flash);
        s.glint.material.rotation = s.time * 1.6;
        s.glint.scale.setScalar(hs * (0.45 + 1.3 * flash));
      }
    }
  }
}

// A four-point star with two shorter diagonal rays and a soft core.
function starTexture() {
  const S = 128, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const core = g.createRadialGradient(C, C, 0, C, C, C * 0.35);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);
  const ray = (angle, len, w) => {
    g.save();
    g.translate(C, C);
    g.rotate(angle);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  };
  for (let i = 0; i < 4; i++) ray(i * Math.PI / 2, C, 4);
  for (let i = 0; i < 4; i++) ray(Math.PI / 4 + i * Math.PI / 2, C * 0.55, 2.5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const ChargeAura = ChargeAuraMethods.prototype;
