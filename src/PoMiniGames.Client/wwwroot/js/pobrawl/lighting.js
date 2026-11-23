// lighting.js — the house-light choreography (the swinging ring spot, backlights, personality
// rim pulses), the posture lean and the fighters' blob and AO shadows. Mixin (mixin.js), `this`
// is the live game; moved out of game.js unchanged.

import * as THREE from 'three-eco/webgpu';
import { PERSONALITIES } from './personalities.js';

// The ring spotlight sweeps an ellipse (mostly along Z, with a vertical bob)
// aimed at the fighters' midpoint, so the light pool, shadows and shaft swing
// like a hanging studio fixture. See "Room light swing" in _updateLighting.
import { KEY_INTENSITY, SPOT_INTENSITY } from './arena.js';
const HOUSE_LIGHT_RADIUS = 4.4;              // Z swing
const HOUSE_LIGHT_RADIUS_X = 1.6;            // narrower X swing for an ellipse, not a circle
const HOUSE_LIGHT_BOB = 1.8;                 // vertical bobbing amplitude
const HOUSE_LIGHT_HEIGHT = 11;
const HOUSE_LIGHT_SPEED = (Math.PI * 2) / 12; // rad/s — one lap per ~12 s

// Scratch vectors (this module's own; game.js keeps its own set).
const _blobPos = new THREE.Vector3();
const _spotTarget = new THREE.Vector3();
const _blDir = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _upY = new THREE.Vector3(0, 1, 0);
const _lookA = new THREE.Vector3();
const _lookB = new THREE.Vector3();

class LightingMethods {
  // House-light choreography. Backlights track their fighters every frame for
  // rim separation. `lightsDim` is pinned to 0 (a KO lights-down went black on
  // most displays), so every consumer collapses to its lights-up value.
  _updateLighting(dt) {
    const L = this.arena && this.arena.lights;
    if (!L) return;
    this.lightsDim = 0;
    const d = this.lightsDim;
    L.hemi.intensity = 0.22 * (1 - d * 0.85);
    L.key.intensity = KEY_INTENSITY * (1 - d * 0.75);
    L.rim.intensity = 1.0 * (1 - d * 0.5);
    L.fill.intensity = 0.6 * (1 - d * 0.85);

    // ── Personality-driven rim pulses ─────────────────────────────
    // Active modes (Reagan morningInAmerica, Bush decider, FDR fourTerm, etc.)
    // tint the rim light. The key/fill stay neutral; only the rim breathes.
    // Multiple personalities can pulse — pick the strongest tint and lerp
    // toward the warm/cool midpoint so the rim never goes wild.
    let rimTint = new THREE.Color(0x6070ff);   // default cool blue rim
    let rimMul = 1.0;
    if (this.fighters) {
      for (const f of this.fighters) {
        const per = f.personality;
        if (!per) continue;
        const mode = per.activeMode;
        const t = per.modeExpiresAt ? Math.max(0, per.modeExpiresAt - this.t) : 0;
        if (mode === 'morningInAmerica' && PERSONALITIES.reagan) {
          // Pulse gold every ~0.5 s.
          const pulse = 0.5 + 0.5 * Math.sin(this.t * 6.0);
          rimTint = new THREE.Color(0xffd66b).lerp(rimTint, 1 - pulse);
          rimMul = Math.max(rimMul, 1.0 + 0.35 * pulse);
        } else if (mode === 'decider' && PERSONALITIES.bush) {
          // Magenta steady-burn — Bush's "decision moment".
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff59a8), 0.65);
          rimMul = Math.max(rimMul, 1.05);
        } else if (mode === 'fourTerm' && PERSONALITIES.fdr) {
          // Warm amber for FDR's warm-up; settles back to blue at expiry.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xffb056), 0.6);
        } else if (mode === 'malaiseSpeech' && PERSONALITIES.carter) {
          // Cool teal — Carter's "wake up" call.
          rimTint = rimTint.clone().lerp(new THREE.Color(0x6cd6c4), 0.5);
        } else if (mode === 'dayOfInfamy' && PERSONALITIES.fdr) {
          // Crimson — FDR rises at 30% HP. Strong + sustained, not pulsing.
          rimTint = rimTint.clone().lerp(new THREE.Color(0xff3232), 0.7);
          rimMul = Math.max(rimMul, 1.15);
        }
        // Per-fighter single-fire person pulses that aren't activeModes.
        if (f.charId === 'jfk' && per.jfkProfileIframesUntil && this.t < per.jfkProfileIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff7c2), 0.55);
        }
        if (f.charId === 'eisenhower' && per.eisenhowerIframesUntil && this.t < per.eisenhowerIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0x9edcff), 0.55);
        }
        if (f.charId === 'fdr' && per.fdrIframesUntil && this.t < per.fdrIframesUntil) {
          rimTint = rimTint.clone().lerp(new THREE.Color(0xfff0c0), 0.5);
        }
      }
    }
    L.rim.color.copy(rimTint);
    L.rim.intensity *= rimMul;
    L.cornerA.intensity = 1.7 * (1 - d * 0.9);
    L.cornerB.intensity = 1.7 * (1 - d * 0.9);
    L.spot.intensity = SPOT_INTENSITY + d * 1.6;
    // Studio rig panels dim with the house lights.
    if (L.rectA) L.rectA.intensity = 3.4 * (1 - d * 0.85);
    if (L.rectB) L.rectB.intensity = 2.6 * (1 - d * 0.85);
    // The volumetric shaft brightens as the hall goes dark — the classic
    // "single spotlight through smoky air" KO moment.
    const atmo = this.arena.atmo;
    if (atmo && atmo.cone) {
      atmo.cone.material.opacity = 0.09 + d * 0.14;
    }

    // ── Room light swing ──────────────────────────────────────────────
    // See HOUSE_LIGHT_*: an ellipse plus vertical bob, one cycle per ~12 s.
    this._houseT = (this._houseT || 0) + dt;
    const orbit = this._houseT * HOUSE_LIGHT_SPEED;
    // Plus the pendulum a heavy landing knocks into it (spectacle.js _kickRig).
    L.spot.position.set(
      Math.cos(orbit) * HOUSE_LIGHT_RADIUS_X + (this._rigKick?.x || 0),
      HOUSE_LIGHT_HEIGHT + Math.sin(orbit * 1.4) * HOUSE_LIGHT_BOB,
      Math.sin(orbit) * HOUSE_LIGHT_RADIUS + (this._rigKick?.z || 0));

    // Spotlight target: the midpoint between the fighters normally, the loser
    // during the KO.
    const loser = this.fighters && !this.ffa && this.fighters.find((f) => f.state === 'ko');
    if (loser && d > 0.01) {
      const lp = loser.rig.root.position;
      _spotTarget.set(lp.x, 0, lp.z);
    } else if (this.fighters && this.fighters.length >= 2) {
      const [fa, fb] = this._duo();
      const a = fa.rig.root.position;
      const b = fb.rig.root.position;
      _spotTarget.set((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5);
    } else {
      _spotTarget.set(0, 0, 0);
    }
    L.spot.target.position.lerp(_spotTarget, Math.min(1, dt * 3));
    L.spot.target.updateMatrixWorld();

    // Keep the fake volumetric shaft glued to the beam: the cylinder's +Y
    // points back up at the lamp, and its centre sits 5.4 units down the beam
    // — the same offset it had baked in when the lamp hung fixed at y = 11.
    if (atmo && atmo.cone) {
      _beamDir.copy(L.spot.position).sub(L.spot.target.position);
      if (_beamDir.lengthSq() < 1e-6) _beamDir.set(0, 1, 0); else _beamDir.normalize();
      atmo.cone.quaternion.setFromUnitVectors(_upY, _beamDir);
      atmo.cone.position.copy(L.spot.position).addScaledVector(_beamDir, -5.4);
      // The volumetric beam reads the lamp's shadow map (arena.js beamMaterial).
      atmo.cone.material.userData.sync?.();
    }

    // Backlights: behind each fighter, opposite the camera.
    if (this.fighters && this._backlights) {
      for (let i = 0; i < this.fighters.length; i++) {
        const fp = this.fighters[i].rig.root.position;
        const bl = this._backlights[i];
        if (!bl) continue;
        _blDir.copy(fp).sub(this.camera.position);
        _blDir.y = 0;
        if (_blDir.lengthSq() < 1e-6) _blDir.set(0, 0, -1);
        _blDir.normalize();
        bl.position.set(fp.x + _blDir.x * 3, 3.2, fp.z + _blDir.z * 3);
        bl.target.position.set(fp.x, 1.0, fp.z);
        bl.intensity = 3.0 * (1 - d * 0.5);
      }
    }

    // ── KO Limelight ─────────────────────────────────────────────────
    // Sits above and sweeps horizontally across the loser during the KO
    // cinematic. Decreases each frame; intensity rises as house lights dim
    // so the contrast between dark hall and tight white slash is dramatic.
    if (this._limelightActive > 0 && this._limelight) {
      this._limelightActive -= dt;
      const lf = this.fighters.find((f) => f.state === 'ko');
      if (lf) {
        // Lerp the target over the body — tracks the falling hips smoothly.
        const ft = lf.rig.joints.torso.getWorldPosition(_blDir);
        _blDir.copy(ft);
        this._limelightTarget.lerp(_blDir, Math.min(1, dt * 4));
        this._limelight.target.position.copy(this._limelightTarget);
      }
      // Spotlight lives off-screen-ish, brushes the loser from above-right.
      const tx = this._limelightTarget.x;
      const tz = this._limelightTarget.z;
      this._limelight.position.set(tx + 2.5, 6.5, tz - 1.2);
      // Fades 0→6 over the first 0.4 s, holds, fades on expiring.
      const t = THREE.MathUtils.clamp(
        Math.min(this._limelightActive, 3.5 - this._limelightActive + 0.5) / 0.6, 0, 1);
      this._limelight.intensity = Math.max(0, 6.0 * t);
      // Cool the colour as we ramp — warm at start, white at peak (looks
      // cinematic vs. the warm key).
      this._limelight.color.setHex(this._limelightActive > 3.0 ? 0xfff0d0 : 0xffffff);
    } else if (this._limelight && this._limelight.intensity !== 0) {
      this._limelight.intensity = 0;
    }

    // ── KO Victor Halo ─────────────────────────────────────────────
    // Contrasting cooler spotlight follows the WINNER (not the loser). The
    // tight white-on-loser + cool halo-on-winner reads as "the audience
    // sees both fighters in their final moments" — cinematic.
    if (this.phase === 'ko' && this.winner && this.fighters) {
      const wf = this.fighters[this.winner - 1];
      if (wf && this._victorHalo) {
        const wpos = wf.rig.root.position;
        this._victorHalo.position.set(wpos.x - 1.4, 3.4, wpos.z - 0.8);
        this._victorHalo.target.position.set(wpos.x, 1.0, wpos.z);
        // Halo rises with house-dim, then fades as the result screen takes
        // over (the result modal flips cameraMode to 'result' and we drop
        // the halo there).
        const cam = this.cameraMode;
        const haloT = THREE.MathUtils.clamp(cam === 'ko' ? d * 1.4 : 0, 0, 1);
        this._victorHalo.intensity = 2.6 * haloT;
        this._victorHalo.color.setHex(0xa0c4ff);
      }
    } else if (this._victorHalo) {
      this._victorHalo.intensity = 0;
    }
    // Tournament: the round's time of day on top of these baselines (cup.js).
    this._applyCupLook(L, dt);
  }

  // Shared radial-gradient texture for the fighters' contact-shadow blobs.
  // Override `opts.inner` / `opts.outer` to tint variants (e.g. AO discs
  // want a harder black inner). One cached texture PER variant: a single-slot
  // cache asked for the blob and the AO disc in turn missed every time, so each
  // spawn built four fresh CanvasTextures that nothing ever disposed. Shared by
  // every spawn, so materials never dispose their .map; _disposeBlobTextures does.
  _makeBlobTexture(opts = {}) {
    const inner = opts.inner || 'rgba(0,0,0,0.9)';
    const mid = opts.mid || 'rgba(0,0,0,0.45)';
    const outer = opts.outer || 'rgba(0,0,0,0)';
    const cacheKey = `${inner}|${mid}|${outer}`;
    this._blobTexCache ??= new Map();
    const hit = this._blobTexCache.get(cacheKey);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this._blobTexCache.set(cacheKey, tex);
    return tex;
  }

  _disposeBlobTextures() {
    for (const tex of this._blobTexCache?.values() || []) tex.dispose();
    this._blobTexCache = null;
  }

  // Per-tick posture: head tracking toward the opponent, momentum lean from
  // the fighter's own velocity/acceleration, and the clinch-frame blend at
  // chest-to-chest range. All feed overlay targets on the animator.
  _updatePosture(f, opp, dt) {
    if (!opp || f.state === 'ko') return;
    const anim = f.animator;

    // ── Head tracking: look at the opponent's upper body ─────────────
    f.rig.joints.head.getWorldPosition(_lookA);
    opp.rig.joints.hips.getWorldPosition(_lookB);
    _lookB.y += 0.55; // chest height
    const dx = _lookB.x - _lookA.x, dz = _lookB.z - _lookA.z;
    const horiz = Math.hypot(dx, dz);
    let yawLocal = Math.atan2(dx, dz) - f.rig.root.rotation.y;
    while (yawLocal > Math.PI) yawLocal -= Math.PI * 2;
    while (yawLocal < -Math.PI) yawLocal += Math.PI * 2;
    // Pitch: negative x rotation looks up; a downed opponent pulls the gaze down.
    const pitch = -Math.atan2(_lookB.y - _lookA.y, Math.max(horiz, 0.4));
    anim.setLook(yawLocal, pitch);

    // ── Momentum lean: into acceleration, counter-lean when braking ──
    const vx = f.vel.x + f.knockback.x, vz = f.vel.z + f.knockback.z;
    const ax = (vx - (f._pvx ?? vx)) / dt, az = (vz - (f._pvz ?? vz)) / dt;
    f._pvx = vx; f._pvz = vz;
    const yaw = f.rig.root.rotation.y;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const lvz = vx * sin + vz * cos, lvx = vx * cos - vz * sin;   // local fwd/side vel
    const laz = ax * sin + az * cos, lax = ax * cos - az * sin;   // local fwd/side accel
    anim.setMoveLean(lvz * 0.06 + laz * 0.006, -(lvx * 0.05 + lax * 0.005));

    // ── Clinch frame: arms brace when chest-to-chest, nobody swinging ─
    const dist = f.rig.root.position.distanceTo(opp.rig.root.position);
    const passive = (s) => s === 'idle' || s === 'block';
    anim.setClinch(dist < 1.05 && passive(f.state) && passive(opp.state));
  }

  // Track each fighter's hips; widen + darken the blob as the body drops
  // (knockdown/KO) so the lying pose still reads as grounded. The AO disc
  // is a separate, tighter patch that stays anchored under the planted
  // feet — sells "not floating".
  _updateBlobShadows() {
    if (!this.fighters) return;
    for (const f of this.fighters) {
      if (!f.blob) continue;
      f.rig.joints.hips.getWorldPosition(_blobPos);
      f.blob.position.x = _blobPos.x;
      f.blob.position.z = _blobPos.z;
      const standing = THREE.MathUtils.clamp((_blobPos.y - 0.15) / 0.85, 0, 1);
      const s = THREE.MathUtils.lerp(1.5, 1.0, standing);
      f.blob.scale.set(s, s, 1);
      f.blob.material.opacity = THREE.MathUtils.lerp(0.5, 0.34, standing);

      // AO disc: tracks the planted foot rather than the hips. While
      // standing the disc stays tight; as the body drops it slides out a
      // bit but never balloons like the contact blob.
      if (f.aoDisc) {
        f.rig.joints.footR.getWorldPosition(_blobPos);
        f.aoDisc.position.x = _blobPos.x;
        f.aoDisc.position.z = _blobPos.z;
        const aos = THREE.MathUtils.lerp(1.4, 1.0, standing);
        f.aoDisc.scale.set(aos, aos, 1);
        // AO fades when the body is upright (where the blob does the work)
        // and goes pitch-black when prone (where it sells the lie-down).
        f.aoDisc.material.opacity = THREE.MathUtils.lerp(0.8, 0.25, standing);
      }
    }
  }

}

export const Lighting = LightingMethods.prototype;
