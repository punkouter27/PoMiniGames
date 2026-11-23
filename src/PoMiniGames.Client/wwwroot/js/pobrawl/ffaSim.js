// ffaSim.js — the free-for-all with no renderer, for the FFA dashboard's strategy benchmark and
// agent lab (ffaMode.js runBenchmark / evaluateAgent). The ring the player watches runs on the
// 1v1 engine (game.js + ffaMode.js); this only has to rank styles against each other, fast and
// reproducibly: seeded, fixed 60 Hz steps, range-and-facing strikes, flat circle bodies.
//
// Same rule as the live ring: the first time a fighter goes down they are out.
import * as THREE from 'three-eco/webgpu';
import { CHARACTERS } from './fighters.js';
import { guardCovers } from './hitboxes.js';
import { MAX_HP } from './constants.js';
import { FFA_PROFILES, seededRandom } from './ffaSeason.js';
import { moveFighters, impactImpulse } from './ffaPhysics.js';
import { getFfaAgentStrategy } from './ffaAgents.js';

const ENGAGE_RANGE = 0.95;
const ATTACK_RANGE = 1.05;
const SWINGS = {
  punch: { contact: 0.1, total: 0.24, lunge: 1.4 },
  kick: { contact: 0.18, total: 0.36, lunge: 1.6 },
};
const OVERTIME_AT = 55;

export class FfaSim {
  /**
   * @param {{ fighters: {id:string,name:string}[], seed?: number, profile?: string,
   *           candidate?: string, agentPresets?: Record<string,string> }} options
   */
  constructor(options) {
    this.options = options;
    this.random = seededRandom(options.seed ?? 1);
    this.profile = options.profile || 'balanced';
    this.elapsed = 0;
    this.phase = 'fighting';
    const n = options.fighters.length;
    const slots = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    this.fighters = options.fighters.map((entry, index) => {
      const root = new THREE.Object3D();
      const angle = (2 * Math.PI * slots[index]) / n;
      const radius = 4.0 + (index % 2) * 0.28;
      root.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      root.rotation.set(0, angle + Math.PI, 0);
      return {
        id: entry.id, name: entry.name, index,
        rig: { root, config: CHARACTERS[entry.id], joints: {} },
        velocity: new THREE.Vector3(),
        target: null, retargetIn: this.random() * 0.4, attackIn: 0.5 + this.random() * 1.5,
        swing: null, blocking: false, guardRemaining: 0, guardCooldown: 0, stun: 0,
        hp: MAX_HP, alive: true, place: 0, damage: 0, knockouts: 0, rearHitsTaken: 0, lastAttacker: null,
      };
    });
  }

  _strategy(f) {
    const profile = this.options.candidate && f.id !== this.options.candidate ? 'balanced' : this.profile;
    const global = FFA_PROFILES[profile] || FFA_PROFILES.balanced;
    const style = getFfaAgentStrategy(f.id, this.options.agentPresets?.[f.id] || 'native');
    return { ...style, pace: style.pace * global.pace, guard: style.guard * global.guard,
      weak: style.weak * global.weak / FFA_PROFILES.balanced.weak };
  }

  _nearest(f, alive) {
    let best = null, score = Infinity;
    for (const o of alive) {
      if (o === f || !o.alive) continue;
      const d = Math.hypot(o.rig.root.position.x - f.rig.root.position.x, o.rig.root.position.z - f.rig.root.position.z);
      const s = d * (0.85 + (o.hp / MAX_HP) * this._strategy(f).weak);
      if (s < score) { score = s; best = o; }
    }
    return best;
  }

  step(dt) {
    if (this.phase !== 'fighting') return;
    this.elapsed += dt;
    const alive = this.fighters.filter((f) => f.alive);
    if (alive.length <= 1) { this._finish(alive[0]); return; }
    const overtime = this.elapsed >= OVERTIME_AT;
    for (const f of alive) {
      const st = this._strategy(f);
      f.attackIn -= dt;
      f.stun = Math.max(0, f.stun - dt);
      f.guardRemaining = Math.max(0, f.guardRemaining - dt);
      f.guardCooldown = Math.max(0, f.guardCooldown - dt);
      f.retargetIn -= dt;
      if (!f.target?.alive || f.retargetIn <= 0) {
        f.target = this._nearest(f, alive);
        f.retargetIn = (0.35 + this.random() * 0.2) * st.retarget;
      }
      const t = f.target;
      if (!t) continue;
      const root = f.rig.root;
      const dx = t.rig.root.position.x - root.position.x, dz = t.rig.root.position.z - root.position.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      if (!f.swing && f.stun <= 0) root.rotation.y = Math.atan2(dx, dz);
      if (!overtime && !f.swing && f.stun <= 0 && t.swing && f.guardCooldown <= 0
          && guardCovers(f.rig, t.rig.root.position)) {
        f.guardRemaining = 0.24;
        f.guardCooldown = st.guard;
      }
      f.blocking = !overtime && !f.swing && f.stun <= 0 && f.guardRemaining > 0;
      let mx = 0, mz = 0;
      const standoff = ENGAGE_RANGE * Math.max(0.84, Math.min(0.9, 0.82 / st.aggression));
      if (!f.swing && f.stun <= 0 && dist > standoff) { mx = dx / dist; mz = dz / dist; }
      for (const o of alive) {
        if (o === f || o === t) continue;
        const ox = root.position.x - o.rig.root.position.x, oz = root.position.z - o.rig.root.position.z;
        const sep = Math.hypot(ox, oz);
        if (sep > 0.001 && sep < 0.9) {
          const push = (0.9 - sep) / 0.9;
          mx += (ox / sep) * push * 1.15;
          mz += (oz / sep) * push * 1.15;
        }
      }
      const ml = Math.hypot(mx, mz);
      if (ml > 0.001 && f.stun <= 0) { mx /= ml; mz /= ml; } else { mx = 0; mz = 0; }
      const speed = (1.4 + Math.max(0, (f.rig.config.moveAccel || 12) - 10) * 0.08) * st.move;
      const blend = Math.min(1, dt * (f.stun > 0 ? 1.5 : 5));
      f.velocity.x += (mx * speed - f.velocity.x) * blend;
      f.velocity.z += (mz * speed - f.velocity.z) * blend;
    }
    moveFighters(this.fighters, dt, null);
    for (const f of alive) {
      if (this.phase !== 'fighting') break;
      if (!f.alive) continue;
      if (f.swing) this._tickSwing(f, dt);
      const t = f.target;
      if (!t?.alive) continue;
      const dist = Math.hypot(t.rig.root.position.x - f.rig.root.position.x, t.rig.root.position.z - f.rig.root.position.z);
      if (dist <= ENGAGE_RANGE && f.stun <= 0 && !f.blocking && !f.swing && f.attackIn <= 0) this._attack(f, t);
    }
  }

  _attack(a, t) {
    const kick = this.random() < 0.35;
    a.attackIn = (0.72 + this.random() * 0.32) * this._strategy(a).pace;
    const timing = SWINGS[kick ? 'kick' : 'punch'];
    a.swing = { target: t, kick, elapsed: 0, remaining: timing.total, resolved: false };
    const dx = t.rig.root.position.x - a.rig.root.position.x, dz = t.rig.root.position.z - a.rig.root.position.z;
    const dist = Math.hypot(dx, dz);
    const gap = Math.max(0, Math.min(1, (dist - 0.78) / 0.2));
    if (dist > 0.001 && gap > 0) {
      a.velocity.x += dx / dist * timing.lunge * gap;
      a.velocity.z += dz / dist * timing.lunge * gap;
    }
  }

  _tickSwing(f, dt) {
    const s = f.swing;
    const timing = SWINGS[s.kick ? 'kick' : 'punch'];
    s.elapsed += dt;
    s.remaining -= dt;
    if (!s.resolved && f.stun <= 0 && s.elapsed >= timing.contact) {
      s.resolved = true;
      this._land(f, s.target, s.kick);
    }
    if (f.swing === s && s.remaining <= 0) f.swing = null;
  }

  _land(a, t, kick) {
    if (!a.alive || !t.alive || a.stun > 0 || this.phase !== 'fighting') return;
    const dx = t.rig.root.position.x - a.rig.root.position.x, dz = t.rig.root.position.z - a.rig.root.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > ATTACK_RANGE) return;
    const yaw = a.rig.root.rotation.y;
    if (dist > 0.001 && (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / dist < 0.5) return;
    if (t.blocking && guardCovers(t.rig, a.rig.root.position)) return;
    const overtime = this.elapsed > OVERTIME_AT ? 1.45 : 1;
    const damage = Math.round((18 + this.random() * 14) * (a.rig.config.attackPower || 1) * overtime);
    impactImpulse(a, t, kick, damage);
    a.damage += Math.min(t.hp, damage);
    if (!guardCovers(t.rig, a.rig.root.position)) t.rearHitsTaken++;
    t.lastAttacker = a.id;
    t.hp = Math.max(0, t.hp - damage);
    t.stun = Math.max(t.stun, 0.24);
    t.swing = null;
    t.blocking = false;
    t.guardRemaining = 0;
    if (t.hp <= 0) {
      a.knockouts++;
      this._eliminate(t);
    }
  }

  _eliminate(f) {
    if (!f.alive) return;
    f.alive = false;
    f.swing = null;
    f.velocity.set(0, 0, 0);
    const remaining = this.fighters.filter((x) => x.alive).length;
    f.place = remaining + 1;
    if (remaining === 1) this._finish(this.fighters.find((x) => x.alive));
  }

  _finish(champion) {
    if (this.phase !== 'fighting' || !champion) return;
    champion.place = 1;
    this.phase = 'result';
  }

  results() {
    return this.fighters.map(({ id, place, damage, knockouts, rearHitsTaken }) =>
      ({ id, place, damage, knockouts, rearHitsTaken }));
  }
}
