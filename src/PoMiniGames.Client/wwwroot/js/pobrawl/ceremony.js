// ceremony.js — the champion's belt ceremony after the tournament final (PoBrawl.ceremony).
// Mixin (mixin.js), mode 'tournament' only.
//
// A procedural championship belt — black leather strap, gold trim, a PBR gold centre plate
// embossed with a presidential-style seal (canvas texture as albedo + bump + a faint
// emissive, so it reads under the night final's dim key) — lowers out of the rafters onto
// the champion's waist. Confetti cannons in the truss fire three volleys (the shared GPU
// particle pool, vfx.js), camera flashbulbs pop all over the stands (arena.js flashbulbs:
// small local sprites), the crowd roars and the PA calls the champion.
//
// Presentation only: Math.random, never the seeded match RNG. Flicker rule (spectacle.js):
// confetti and flashbulbs are local; nothing here changes whole-frame brightness.
// Reduced motion: a third of the confetti, no flashbulbs, no spin on the belt.
// The belt is built hidden at engine start so _warmupRender compiles its programs up front.
import * as THREE from 'three-eco/webgpu';
import { flashbulbs } from './arena.js';
import * as Quality from './quality.js';

const DROP_SEC = 2.0;                       // rafters to waist
const DROP_FROM = 4.8;                      // m above the mat
const VOLLEYS = [0.35, 1.5, 2.7];           // s after the start
const FLASH_FROM = 0.4, FLASH_TO = 6.5;     // s, the flashbulb storm
const CEREMONY_SEC = 8;                     // after this only the belt keeps following
const CANNONS = [[-5, 9.1, -7.3], [5, 9.1, -7.3], [-5, 9.1, 7.3], [5, 9.1, 7.3]];
const CONFETTI = [0xffd257, 0xfff3c4, 0xff4a3c, 0x4a7dff, 0xf5f2ec, 0xffb02e];
const BELT_R = 0.25;                        // strap radius at buildScale 1

const _hips = new THREE.Vector3();

class CeremonyMethods {
  _initCeremony() {
    this._cer = null;
    const seal = sealTexture();
    const gold = new THREE.MeshStandardNodeMaterial({
      color: 0xffc53d, metalness: 1, roughness: 0.26, envMapIntensity: 1.4,
      emissive: 0x3a2400, emissiveIntensity: 0.7,
    });
    const face = new THREE.MeshStandardNodeMaterial({
      map: seal, bumpMap: seal, bumpScale: 2.4, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.4,
      emissive: 0xffffff, emissiveMap: seal, emissiveIntensity: 0.28,
    });
    const leather = new THREE.MeshStandardNodeMaterial({
      color: 0x17110d, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide,
    });
    const belt = new THREE.Group();
    const H = 0.11;
    belt.add(new THREE.Mesh(new THREE.CylinderGeometry(BELT_R, BELT_R, H, 56, 1, true), leather));
    const trimGeo = new THREE.TorusGeometry(BELT_R + 0.003, 0.009, 6, 56);
    for (const y of [-H / 2, H / 2]) {
      const trim = new THREE.Mesh(trimGeo, gold);
      trim.rotation.x = Math.PI / 2;
      trim.position.y = y;
      belt.add(trim);
    }
    // The centre plate faces local +Z (turned toward the camera every frame), with a
    // smaller plate either side.
    const plate = (radius, angle) => {
      const pivot = new THREE.Group();
      pivot.rotation.y = angle;
      const back = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.022, 40), gold);
      back.rotation.x = Math.PI / 2;
      back.position.z = BELT_R + 0.012;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.94, 40), face);
      disc.position.z = BELT_R + 0.024;
      pivot.add(back, disc);
      belt.add(pivot);
    };
    plate(0.15, 0);
    plate(0.065, 1.0);
    plate(0.065, -1.0);
    belt.visible = false;
    this.scene.add(belt);
    this._belt = { group: belt, seal };
  }

  /** The final is decided: crown `charId` (falls back to the bout's winner). */
  ceremony(charId) {
    // The champion's voice (fighterVoice.js) in either show.
    this._show('champion', { charId });
    // Full show only (show.js): the Simple show ends the final on the result card.
    if (!this._fullShow()) return;
    if (!this._belt || !this.fighters || this.disposed) return;
    const f = this.fighters.find((x) => x.charId === charId && x.state !== 'ko')
      || (this.winner ? this.fighters[this.winner - 1] : null);
    if (!f) return;
    const calm = this._calm();
    const low = Quality.tier() === 'low';
    const cfg = f.rig.config || {};
    this._cer = {
      t: 0, f, volley: 0, flashAcc: 0, calm, landed: false,
      particles: calm ? 0.3 : low ? 0.5 : 1,
      flashRate: calm ? 0 : low ? 12 : 26,
      scale: (cfg.buildScale || 1) * Math.max(1, (cfg.belly || 1) * 0.92),
    };
    const g = this._belt.group;
    g.scale.setScalar(this._cer.scale);
    g.visible = true;
    this._placeBelt(0);
    this.excited = 1;
    this.audio?.crowdRoar(1, 4.5);
    this._caption(`Ladies and gentlemen... your tournament champion... ${cfg.name || 'the champion'}!`, 4);
  }

  _tickCeremony(dt) {
    const s = this._cer;
    if (!s) return;
    s.t += dt;
    this._placeBelt(dt);
    if (s.t > CEREMONY_SEC) return;
    while (s.volley < VOLLEYS.length && s.t >= VOLLEYS[s.volley]) this._confettiVolley(s.volley++);
    if (s.flashRate && s.t > FLASH_FROM && s.t < FLASH_TO) {
      s.flashAcc += dt * s.flashRate;
      const n = Math.floor(s.flashAcc);
      if (n > 0) { s.flashAcc -= n; flashbulbs(this.arena, n); }
    }
    this.excited = Math.max(this.excited, 0.85);
  }

  // The belt rides the champion's hips: down out of the rafters, then held at the waist
  // through the victory hops, the centre plate turned to the camera.
  _placeBelt(dt) {
    const s = this._cer;
    const g = this._belt?.group;
    if (!s || !g) return;
    s.f.rig.joints.hips.getWorldPosition(_hips);
    const restY = _hips.y + 0.1 * s.scale;
    const k = Math.min(1, s.t / DROP_SEC);
    const ease = 1 - Math.pow(1 - k, 3);
    const y = DROP_FROM + (restY - DROP_FROM) * ease;
    g.position.set(_hips.x, y, _hips.z);
    const cam = this.camera.position;
    const faceCam = Math.atan2(cam.x - _hips.x, cam.z - _hips.z);
    const spin = s.calm ? 0 : (1 - ease) * 7;
    const sway = s.calm || k < 1 ? 0 : Math.sin((s.t - DROP_SEC) * 1.3) * 0.16;
    g.rotation.set(0, faceCam + spin + sway, 0);
    if (k >= 1 && !s.landed) {
      s.landed = true;
      this.audio?.crowdSwell(1);
      // A local gold glint where it lands, and a ring of gold sparks.
      this._flashImpactLight?.(new THREE.Vector3(_hips.x, restY + 0.3, _hips.z), 7, 0xffd27a, 0.5);
      const n = Math.round(26 * s.particles);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        this._spawnParticle(_hips.x + Math.cos(a) * 0.3, restY, _hips.z + Math.sin(a) * 0.3,
          Math.cos(a) * 2.2, 1.2 + Math.random() * 1.4, Math.sin(a) * 2.2,
          Math.random() < 0.6 ? 0xffd257 : 0xfff3c4, 0.5 + Math.random() * 0.4, -6, 0.05);
      }
      // The champion celebrates (cinematics.js); harmless if they already are.
      if (this.celebrant !== s.f) this._startCelebration?.(s.f);
    }
    if (dt === 0) g.updateMatrixWorld();
  }

  // Four cannons in the truss fire inward and down; the paper flutters (heavy drag, light
  // gravity) over the ring. Booms on alternate cannons so a volley is two hits, not one wall.
  _confettiVolley(v) {
    const s = this._cer;
    const per = Math.round(140 * s.particles);
    CANNONS.forEach(([x, y, z], i) => {
      const dx = -x * 0.9, dy = 3 - y, dz = -z * 0.9;
      const len = Math.hypot(dx, dy, dz);
      if (this._confetti) {
        // Simulated: it carries across the ring, flutters down and litters the canvas.
        const sp = 9.5;
        this._confetti.emit({
          origin: [x, y, z], box: [0.1, 0.1, 0.1],
          velocity: [dx / len * sp, dy / len * sp, dz / len * sp], scatter: [3.2, 2.6, 3.2],
          count: Math.round(per * 2.2),
        });
      } else for (let n = 0; n < per; n++) {
        const sp = 6 + Math.random() * 7;
        this._spawnParticle(x, y, z,
          (dx / len + (Math.random() - 0.5) * 0.5) * sp,
          (dy / len + (Math.random() - 0.5) * 0.35) * sp,
          (dz / len + (Math.random() - 0.5) * 0.5) * sp,
          CONFETTI[(Math.random() * CONFETTI.length) | 0],
          4.5 + Math.random() * 2.5, -1.3, 0.08 + Math.random() * 0.07, 1.25);
      }
      // Muzzle smoke.
      for (let n = 0; n < Math.round(8 * s.particles) + 2; n++) {
        this._spawnParticle(x, y, z,
          dx / len * 2 + (Math.random() - 0.5), dy / len * 2 + (Math.random() - 0.5), dz / len * 2 + (Math.random() - 0.5),
          0x4a5260, 1 + Math.random() * 0.6, 0.4, 0.5 + Math.random() * 0.4, 2.5);
      }
      if ((i + v) % 2 === 0) this.audio?.cannonBoom(new THREE.Vector3(x, y, z));
    });
    this.audio?.crowdSwell(0.8);
  }

  _disposeCeremony() {
    this._cer = null;
    // Geometry and materials go with the scene traverse in dispose(); the map is ours.
    this._belt?.seal.dispose();
    this._belt = null;
  }
}

// The plate's face: a gold seal on blue enamel — "PO BRAWL" over the top, "WORLD CHAMPION"
// under it, thirteen stars, and a striped shield with spread wings in the middle. Used as the
// albedo, the bump (its luminance embosses the relief) and a faint emissive.
function sealTexture() {
  const S = 256, C = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const goldFill = (r0, r1) => {
    const grad = g.createRadialGradient(C - 30, C - 40, r0, C, C, r1);
    grad.addColorStop(0, '#fff4b8');
    grad.addColorStop(0.5, '#efb73e');
    grad.addColorStop(1, '#94600f');
    return grad;
  };
  g.fillStyle = goldFill(4, C);
  g.fillRect(0, 0, S, S);
  // Enamel band with the lettering.
  g.beginPath();
  g.arc(C, C, 122, 0, Math.PI * 2);
  g.arc(C, C, 88, 0, Math.PI * 2, true);
  g.fillStyle = '#1d2f7a';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#7a4c0c';
  for (const r of [124, 86]) { g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); g.stroke(); }
  g.font = 'bold 21px Impact, "Arial Black", sans-serif';
  g.fillStyle = '#ffd866';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  arcText(g, 'PO BRAWL', C, C, 105, -Math.PI / 2, true);
  arcText(g, 'WORLD CHAMPION', C, C, 105, Math.PI / 2, false);
  // Thirteen stars.
  for (let i = 0; i < 13; i++) {
    const a = -Math.PI / 2 + (i / 13) * Math.PI * 2;
    star(g, C + Math.cos(a) * 72, C + Math.sin(a) * 72, 6.5, '#fff1b0');
  }
  // Wings.
  g.fillStyle = '#b07a18';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(C + side * 14, C - 16);
    g.quadraticCurveTo(C + side * 58, C - 44, C + side * 62, C - 6);
    g.lineTo(C + side * 50, C - 2);
    g.lineTo(C + side * 56, C + 10);
    g.lineTo(C + side * 42, C + 10);
    g.lineTo(C + side * 46, C + 22);
    g.lineTo(C + side * 16, C + 18);
    g.closePath();
    g.fill();
    g.strokeStyle = '#6b420c';
    g.lineWidth = 2;
    g.stroke();
  }
  // Shield: blue chief over red and white stripes.
  g.save();
  g.beginPath();
  g.moveTo(C - 20, C - 26);
  g.lineTo(C + 20, C - 26);
  g.lineTo(C + 20, C + 6);
  g.quadraticCurveTo(C + 20, C + 26, C, C + 36);
  g.quadraticCurveTo(C - 20, C + 26, C - 20, C + 6);
  g.closePath();
  g.clip();
  for (let i = 0; i < 7; i++) {
    g.fillStyle = i % 2 ? '#f4ead2' : '#b3262c';
    g.fillRect(C - 20 + i * (40 / 7), C - 26, 40 / 7 + 0.5, 64);
  }
  g.fillStyle = '#1d2f7a';
  g.fillRect(C - 20, C - 26, 40, 13);
  g.restore();
  g.strokeStyle = '#6b420c';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(C - 20, C - 26);
  g.lineTo(C + 20, C - 26);
  g.lineTo(C + 20, C + 6);
  g.quadraticCurveTo(C + 20, C + 26, C, C + 36);
  g.quadraticCurveTo(C - 20, C + 26, C - 20, C + 6);
  g.closePath();
  g.stroke();
  star(g, C, C - 40, 8, '#fff1b0');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Letters centred on angle `mid` along a circle; `top` reads clockwise over the top,
// otherwise anticlockwise under the bottom, so both read upright.
function arcText(g, text, cx, cy, r, mid, top) {
  const step = 0.165;
  const start = mid - (step * (text.length - 1)) / 2 * (top ? 1 : -1);
  for (let i = 0; i < text.length; i++) {
    const a = start + i * step * (top ? 1 : -1);
    g.save();
    g.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.rotate(top ? a + Math.PI / 2 : a - Math.PI / 2);
    g.fillText(text[i], 0, 0);
    g.restore();
  }
}

function star(g, x, y, r, color) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

export const Ceremony = CeremonyMethods.prototype;
