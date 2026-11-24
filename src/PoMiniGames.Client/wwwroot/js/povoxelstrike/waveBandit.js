// povoxelstrike/waveBandit.js — Adaptive Contextual Bandit Wave & Boss Composer (#18).
// Uses a lightweight LinUCB contextual bandit (pure client-side, $0, zero external API needed)
// polled 5 seconds ahead of the next spawn budget to counter player habits (e.g. wall camping,
// high debris-crush ratio, or low-ammo bursts) while preserving smooth escalation.

const ARMS = [
  { id: 'swarmer_flank', weights: { swarmer: 0.7, brute: 0.1, spitter: 0.2 }, name: 'Flanking Pack' },
  { id: 'siege_breakers', weights: { swarmer: 0.2, brute: 0.55, spitter: 0.25 }, name: 'Wall Breakers' },
  { id: 'artillery_pin', weights: { swarmer: 0.25, brute: 0.15, spitter: 0.6 }, name: 'Spitter Battery' },
  { id: 'mixed_assault', weights: { swarmer: 0.45, brute: 0.3, spitter: 0.25 }, name: 'Combined Siege' },
];
const DIM = 4; // [wallIntegrity, crushKillShare, playerHpRatio, elapsedMinutesNorm]

export class AdaptiveWaveBandit {
  constructor(alpha = 0.6) {
    this.alpha = alpha;
    this.weights = ARMS.map(() => new Float32Array(DIM));
    this.counts = new Uint32Array(ARMS.length);
    this.lastArmIdx = 0;
    this.lastFeatures = new Float32Array(DIM);
    this.pendingSpec = null;
  }

  /** Record reward in [0, 1] peaking when the wave created exciting tension without instant death. */
  recordOutcome(damageDealtRatio, waveDurationSec) {
    const tension = Math.exp(-Math.pow((damageDealtRatio - 0.3) / 0.25, 2));
    const pace = Math.min(1, waveDurationSec / 25);
    const reward = 0.7 * tension + 0.3 * pace;
    const w = this.weights[this.lastArmIdx];
    const lr = 0.18 / Math.sqrt(1 + this.counts[this.lastArmIdx]);
    let pred = 0;
    for (let i = 0; i < DIM; i++) pred += w[i] * this.lastFeatures[i];
    const err = reward - pred;
    for (let i = 0; i < DIM; i++) w[i] += lr * err * this.lastFeatures[i];
    this.counts[this.lastArmIdx]++;
  }

  /**
   * Async non-blocking pre-composition called ~5 s before the next wave budget refills.
   */
  scheduleNextWave(telemetry) {
    const f = new Float32Array([
      Math.max(0, Math.min(1, telemetry.wallIntegrity ?? 0.8)),
      Math.max(0, Math.min(1, telemetry.crushKillShare ?? 0.2)),
      Math.max(0, Math.min(1, telemetry.playerHpRatio ?? 1.0)),
      Math.max(0, Math.min(1, (telemetry.elapsedSec ?? 0) / 300)),
    ]);

    Promise.resolve().then(() => {
      let bestIdx = 0;
      let bestUcb = -Infinity;
      const totalN = this.counts.reduce((a, b) => a + b, 0) + 1;

      for (let a = 0; a < ARMS.length; a++) {
        const w = this.weights[a];
        let mean = 0;
        for (let i = 0; i < DIM; i++) mean += w[i] * f[i];
        // Domain heuristic prior so early waves immediately react to wall camping
        if (a === 1 && f[0] > 0.75) mean += 0.25;
        if (a === 2 && f[1] > 0.45) mean += 0.2;
        const bonus = this.alpha * Math.sqrt(Math.log(totalN + 1) / (this.counts[a] + 1));
        if (mean + bonus > bestUcb) {
          bestUcb = mean + bonus;
          bestIdx = a;
        }
      }

      this.lastArmIdx = bestIdx;
      this.lastFeatures.set(f);
      this.pendingSpec = ARMS[bestIdx];
    });
  }

  /** Instant synchronous read with fallback to balanced mixed assault. */
  consumeWaveSpec() {
    const spec = this.pendingSpec ?? ARMS[3];
    this.pendingSpec = null;
    return spec;
  }
}
