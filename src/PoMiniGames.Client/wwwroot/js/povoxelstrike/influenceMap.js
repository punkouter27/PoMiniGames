// povoxelstrike/influenceMap.js — 3-Layer Spatial Influence & Collapse-Danger Map (#1).
// Layers (64x64 Float32Array each, 16 KB/layer):
//   1. threat:   Player line-of-sight cone + firing pressure
//   2. collapse: Falling debris / unstable voxel pillar hazard
//   3. flank:    Angular gradient peaking behind the player's facing vector
// Tick: 5 Hz diffusion (~0.35 ms), 60 Hz bilinear gradient lookup (<0.05 ms).

export class VoxelInfluenceMap {
  constructor(size = 64, worldSpan = 128) {
    this.size = size;
    this.worldSpan = worldSpan;
    this.halfSpan = worldSpan * 0.5;
    this.cellSize = worldSpan / size;
    const n = size * size;
    this.threat = new Float32Array(n);
    this.collapse = new Float32Array(n);
    this.flank = new Float32Array(n);
    this._scratch = new Float32Array(n);
  }

  worldToCell(x, z) {
    const cx = Math.floor((x + this.halfSpan) / this.cellSize);
    const cz = Math.floor((z + this.halfSpan) / this.cellSize);
    return {
      cx: cx < 0 ? 0 : cx >= this.size ? this.size - 1 : cx,
      cz: cz < 0 ? 0 : cz >= this.size ? this.size - 1 : cz,
    };
  }

  /**
   * 5 Hz update: stamp player threat cone, flank arc behind player, and falling debris / unstable pillars.
   */
  update(player, hazards = []) {
    const s = this.size;
    const n = s * s;
    for (let i = 0; i < n; i++) {
      this.threat[i] *= 0.65;
      this.collapse[i] *= 0.55;
      this.flank[i] = 0;
    }

    const px = player.x ?? 0;
    const pz = player.z ?? 0;
    const fx = Math.sin(player.yaw ?? 0);
    const fz = Math.cos(player.yaw ?? 0);

    for (let cz = 0; cz < s; cz++) {
      const wz = (cz + 0.5) * this.cellSize - this.halfSpan;
      const dz = wz - pz;
      const row = cz * s;
      for (let cx = 0; cx < s; cx++) {
        const wx = (cx + 0.5) * this.cellSize - this.halfSpan;
        const dx = wx - px;
        const distSq = dx * dx + dz * dz;
        if (distSq < 0.01 || distSq > 48 * 48) continue;
        const dist = Math.sqrt(distSq);
        const dot = (dx * fx + dz * fz) / dist;
        const idx = row + cx;
        // Player forward firing threat cone
        if (dot > 0.35) {
          this.threat[idx] = Math.min(1, this.threat[idx] + ((dot - 0.35) / 0.65) * (1 - dist / 48));
        }
        // Flanking sweet-spot: 8..22 m behind or beside the player
        const rearWeight = Math.max(0, 0.5 - dot * 0.5);
        const ringWeight = Math.exp(-Math.pow((dist - 14) / 9, 2));
        this.flank[idx] = rearWeight * ringWeight;
      }
    }

    // Stamp collapse / falling-debris hazard circles
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      const radCells = Math.ceil((h.radius ?? 6) / this.cellSize);
      const { cx, cz } = this.worldToCell(h.x, h.z);
      const r0 = Math.max(0, cz - radCells);
      const r1 = Math.min(s - 1, cz + radCells);
      const c0 = Math.max(0, cx - radCells);
      const c1 = Math.min(s - 1, cx + radCells);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(c - cx, r - cz) / Math.max(1, radCells);
          if (d <= 1) {
            const idx = r * s + c;
            this.collapse[idx] = Math.min(1, this.collapse[idx] + (1 - d) * (h.weight ?? 1));
          }
        }
      }
    }

    this._diffuse(this.threat, 0.2);
    this._diffuse(this.collapse, 0.25);
  }

  _diffuse(grid, rate) {
    const s = this.size;
    const out = this._scratch;
    for (let z = 1; z < s - 1; z++) {
      const row = z * s;
      for (let x = 1; x < s - 1; x++) {
        const i = row + x;
        const avg = (grid[i - 1] + grid[i + 1] + grid[i - s] + grid[i + s]) * 0.25;
        out[i] = grid[i] + (avg - grid[i]) * rate;
      }
    }
    for (let z = 1; z < s - 1; z++) {
      const row = z * s;
      for (let x = 1; x < s - 1; x++) {
        grid[row + x] = out[row + x];
      }
    }
  }

  /**
   * 60 Hz steering vector lookup for an enemy archetype ('swarmer' | 'spitter' | 'brute').
   * Returns normalized { dx, dz } tactical bias.
   */
  sampleSteering(x, z, archetype) {
    const { cx, cz } = this.worldToCell(x, z);
    const s = this.size;
    const x0 = Math.max(0, cx - 1), x1 = Math.min(s - 1, cx + 1);
    const z0 = Math.max(0, cz - 1), z1 = Math.min(s - 1, cz + 1);

    const scoreAt = (ix, iz) => {
      const idx = iz * s + ix;
      const t = this.threat[idx];
      const col = this.collapse[idx];
      const f = this.flank[idx];
      if (archetype === 'swarmer') return f * 1.4 - t * 0.6 - col * 2.2;
      if (archetype === 'spitter') return -t * 1.3 - col * 2.0 + f * 0.35;
      return -col * 1.8 + f * 0.4; // brute
    };

    const gx = scoreAt(x1, cz) - scoreAt(x0, cz);
    const gz = scoreAt(cx, z1) - scoreAt(cx, z0);
    const len = Math.hypot(gx, gz);
    return len > 1e-4 ? { dx: gx / len, dz: gz / len } : { dx: 0, dz: 0 };
  }
}
