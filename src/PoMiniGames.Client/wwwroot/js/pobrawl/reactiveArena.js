// reactiveArena.js — the hall reacting to the match: the jumbotron (names, clock, HP, combos,
// the Cup bracket captions), the rig lenses and the ring mat's ripple and wear. Mixin
// (mixin.js), `this` is the live game; moved out of game.js unchanged.

import * as THREE from 'three-eco/webgpu';
import {
  Fn, If, exp, length, materialColor, materialRoughness, mix, output, positionWorld, sin, texture, uniform, vec4,
} from 'three-eco/tsl';
import { MAX_HP, TIME_LIMIT, COMBO_MIN_SHOWN, MAT_HALF } from './constants.js';
import { MatWear } from './matWear.js';
import { crowdReact } from './arena.js';

class ReactiveArenaMethods {
  // ══ Reactive arena ═══════════════════════════════════════════════════
  // The jumbotron, the rig lenses and the ring mat respond to the match.

  _initReactiveArena() {
    // ── Rig LEDs ──────────────────────────────────────────────────────
    this._rigLenses = [];
    this.arena.backdrop?.traverse((o) => {
      if (o.userData?.rigLens && o.material) this._rigLenses.push(o);
    });

    // ── Live jumbotron ────────────────────────────────────────────────
    // 256×128 — the screens are 14 m from the camera behind a fog falloff, so
    // anything sharper is texture upload cost nobody can resolve. Both screens
    // share one material (see arena.js buildBackdrop), hence one canvas.
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    this._jumboCanvas = c;
    this._jumboCtx = c.getContext('2d');
    this._jumboTex = new THREE.CanvasTexture(c);
    this._jumboTex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = this.arena.backdrop?.userData?.screenMat;
    if (screenMat) {
      // The outgoing map is arena.js's module-level cached singleton, shared
      // with any future arena build — replace the reference, never dispose it.
      screenMat.map = this._jumboTex;
      screenMat.needsUpdate = true;
    }
    this._jumboT = 0;
    this._jumboFlash = '';   // one-shot centre caption ('K.O.', 'FIGHT', …)
    this._jumboFlashT = 0;

    // ── Ring-mat ripple ───────────────────────────────────────────────
    // A SHADING ripple, not a displacement: the mat is a BoxGeometry with one
    // segment per face, so there are no interior vertices to push. Bands of
    // light and shadow racing out from the impact read as the canvas taking
    // the weight, for one branch in a fragment shader that already runs.
    this._ripple = {
      origin: new THREE.Vector2(0, 0),
      t: uniform(99),            // seconds since the strike; >2 = idle
      amp: uniform(0),
      originU: uniform(new THREE.Vector2(0, 0)),
    };
    const mat = this.arena.canvasMat;
    // ── Mat wear ────────────────────────────────────────────────────────
    // Built here because the canvas material below is the one place both the
    // ripple and the wear lookup are attached.
    this.matWear = new MatWear(MAT_HALF);
    if (mat) {
      const R = this._ripple;
      // World XZ of the fragment → the wear maps' UV. The mat is 2 * MAT_HALF square and
      // centred, so the lookup always lands inside the maps on the top face; the box's
      // side faces get the clamped edge texel, and at 4 cm tall nobody sees it.
      const matXZ = positionWorld.xz;
      const wuv = matXZ.div(2 * MAT_HALF).add(0.5);
      const wear = texture(this.matWear.wear.tex, wuv);
      const wet = texture(this.matWear.wet.tex, wuv).a;
      // Wear goes into the ALBEDO (before lighting), so scuffs sit in the
      // vinyl under the spots rather than being painted over the lit result.
      let colorNode = mix(materialColor.rgb, wear.rgb, wear.a).mul(wet.mul(0.38).oneMinus());
      // Wet vinyl is glossier: the sweat catches the spots as it dries off.
      let roughnessNode = mix(materialRoughness, 0.28, wet);
      // The simulated blood film lies over all of it (bloodFluid.js; WebGPU only).
      const fluid = this._ensureBloodFluid?.();
      if (fluid) ({ colorNode, roughnessNode } = fluid.over(colorNode, roughnessNode, matXZ));
      mat.colorNode = colorNode;
      mat.roughnessNode = roughnessNode;
      // A SHADING ripple over the lit result: bands of light and shadow racing out.
      mat.outputNode = Fn(() => {
        const col = output.rgb.toVar();
        If(R.amp.greaterThan(0.001), () => {
          const d = length(matXZ.sub(R.originU)).toVar();
          // Expanding wave front at ~4.5 m/s with a gaussian envelope, so
          // the disturbance is a moving band rather than the whole mat
          // pulsing at once.
          const edge = d.sub(R.t.mul(4.5)).mul(1.9);
          const band = exp(edge.mul(edge).negate());
          const wave = sin(d.mul(7).sub(R.t.mul(22)));
          // Falls off with distance travelled AND with age — a ripple that
          // only faded with time would still be visible at the ropes.
          const fade = R.amp.mul(exp(d.mul(-0.24))).mul(exp(R.t.mul(-1.7)));
          col.mulAssign(wave.mul(band).mul(fade).mul(0.55).add(1));
        });
        return vec4(col, output.a);
      })();
      mat.needsUpdate = true;
    }
  }

  /** Kick a ripple out from a world XZ point — a knockdown, a KO, a body slam. */
  _ringRipple(x, z, amp = 1) {
    if (!this._ripple) return;
    this._ripple.originU.value.set(x, z);
    this._ripple.t.value = 0;
    this._ripple.amp.value = Math.min(1.2, amp);
    // What shakes the canvas shakes the stands (not under reduced motion).
    if (!this._calm?.()) crowdReact(this.arena?.crowd, x, z, Math.min(1, amp * 0.85));
  }

  _updateReactiveArena(dt) {
    // Rig LEDs ride the audio envelope plus crowd excitement. The envelope is
    // the same signal the bloom pulse reads, so the lamps flare on the same
    // frame the impact is heard rather than a frame or two behind it.
    if (this._rigLenses && this._rigLenses.length) {
      const env = this.audio ? this.audio.getEnvelope() : 0;
      const exc = Math.min(1, this.excited || 0);
      for (let i = 0; i < this._rigLenses.length; i++) {
        const lens = this._rigLenses[i];
        // Per-lamp phase so the truss chases rather than strobing as one block
        // — eight lamps flashing in unison reads as a bug in the renderer.
        const phase = Math.sin(this.atmoT * 3.1 + i * 0.8) * 0.5 + 0.5;
        lens.material.emissiveIntensity =
          (lens.userData.baseEmissive || 1.4) * (1 + env * 1.6 + exc * 0.5 * phase);
      }
    }

    // Ripple clock. Parked at a high value when idle so the shader branch is
    // skipped via uRippleAmp rather than left running on a stale phase.
    if (this._ripple && this._ripple.amp.value > 0) {
      this._ripple.t.value += dt;
      if (this._ripple.t.value > 2.2) this._ripple.amp.value = 0;
    }

    // Jumbotron: redraw at ~8 Hz. Each redraw is a texture upload, so it stays
    // off the frame clock.
    this._jumboT = (this._jumboT || 0) + dt;
    if (this._jumboFlashT > 0) this._jumboFlashT -= dt;
    if (this._jumboT >= 0.125) { this._jumboT = 0; this._drawJumbotron(); }
  }

  /** One-shot big caption on the jumbotron. */
  _jumboCaption(text, secs = 1.6) {
    this._jumboFlash = text;
    this._jumboFlashT = secs;
    this._jumboT = 99; // force a redraw on the next update rather than waiting
  }

  _drawJumbotron() {
    const g = this._jumboCtx;
    if (!g || !this.fighters || !this.combat) return;
    const W = 256, H = 128;
    // Between tournament bouts the screens carry the bracket (cup.js) until the next count.
    if (this._drawCupBoard(g, W, H)) { this._jumboTex.needsUpdate = true; return; }
    g.fillStyle = '#08101f';
    g.fillRect(0, 0, W, H);

    // Header strip.
    g.fillStyle = 'rgba(90,124,250,0.18)';
    g.fillRect(0, 0, W, 18);
    g.font = 'bold 11px Impact, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#cfe0ff';
    g.textAlign = 'left';
    g.fillText('PO BRAWL', 8, 9);
    g.textAlign = 'right';
    g.fillText(this.training ? 'TRAINING'
      : `${Math.ceil(Math.max(0, TIME_LIMIT - (this.clock || 0)))}"`, W - 8, 9);

    // Two name plates with live HP.
    const names = this.fighters.map((f) => (f.rig.config.name || '').toUpperCase());
    const hps = this.fighters.map((f) => this._hp(f) / MAX_HP);
    for (let i = 0; i < 2; i++) {
      const y = 30 + i * 30;
      g.textAlign = 'left';
      g.font = 'bold 12px Impact, sans-serif';
      g.fillStyle = '#e8eeff';
      g.fillText(names[i].slice(0, 14), 10, y);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(10, y + 9, W - 20, 7);
      g.fillStyle = i === 0 ? '#22c55e' : '#ef4444';
      g.fillRect(10, y + 9, Math.max(0, (W - 20) * hps[i]), 7);
    }

    // Centre caption: an explicit one-shot beats a live combo, which beats
    // nothing. Combos are the common case, so they cost no extra state.
    let caption = this._jumboFlashT > 0 ? this._jumboFlash : '';
    if (!caption) {
      const best = this.fighters.reduce((a, b) => (b.comboN > a.comboN ? b : a));
      if (best.comboN >= COMBO_MIN_SHOWN) caption = `${best.comboN} HIT`;
    }
    if (caption) {
      g.textAlign = 'center';
      g.font = 'bold 30px Impact, sans-serif';
      g.fillStyle = 'rgba(255,214,102,0.92)';
      g.fillText(caption, W / 2, H - 22);
    }

    // Scanlines last, over everything — this is a screen being filmed, and the
    // banding is what stops the panel reading as a flat lit quad.
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);

    this._jumboTex.needsUpdate = true;
  }


}

export const ReactiveArena = ReactiveArenaMethods.prototype;
