// platform/ai/pidDirector.js — PID Flow-Channel Dynamic Difficulty Adjustment (#9).
// Tracks rolling player performance with a 16-sample EMA and nudges cognitive/tactical
// AI parameters (reaction delay, feint rate, prediction threshold, mistake rate) inside
// clamped per-rung bounds — never rubber-banding physics. CPU, 1 Hz, <0.02 ms.

const EMA_ALPHA = 2 / (16 + 1);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PidDifficultyDirector {
  constructor(opts = {}) {
    this.minSkill = clamp(opts.minSkill ?? 0.15, 0, 1);
    this.maxSkill = clamp(opts.maxSkill ?? 0.95, this.minSkill, 1);
    this.skill = clamp(opts.initialSkill ?? 0.5, this.minSkill, this.maxSkill);
    this.target = clamp(opts.targetPerformance ?? 0.52, 0.1, 0.9);
    this.kp = opts.kp ?? 0.35;
    this.ki = opts.ki ?? 0.08;
    this.kd = opts.kd ?? 0.12;
    this.ema = this.target;
    this.integral = 0;
    this.prevError = 0;
    this.samples = 0;
  }

  /**
   * Feed a normalized performance sample in [0, 1] (0 = struggling, 0.5 = even, 1 = dominating).
   * @returns {{ skillLevel: number, reactionDelayScale: number, feintRate: number, predictionThreshold: number, mistakeRate: number }}
   */
  update(performanceSample, dtSeconds = 1.0) {
    const sample = clamp(performanceSample, 0, 1);
    const dt = clamp(dtSeconds, 0.05, 30);
    this.ema = this.samples === 0 ? sample : this.ema + EMA_ALPHA * (sample - this.ema);
    this.samples++;

    const error = this.ema - this.target;
    const candidateI = clamp(this.integral + error * dt, -1.5, 1.5);
    const deriv = (error - this.prevError) / dt;
    this.prevError = error;

    const delta = this.kp * error + this.ki * candidateI + this.kd * deriv;
    const nextSkill = this.skill + clamp(delta * 0.25, -0.08, 0.08);
    if ((nextSkill > this.minSkill && nextSkill < this.maxSkill) || Math.sign(error) !== Math.sign(this.integral)) {
      this.integral = candidateI;
    }
    this.skill = clamp(nextSkill, this.minSkill, this.maxSkill);
    return this.profile();
  }

  profile() {
    const s = this.skill;
    return {
      skillLevel: s,
      reactionDelayScale: 1.45 - 0.85 * s,
      feintRate: 0.05 + 0.45 * s,
      predictionThreshold: 0.78 - 0.36 * s,
      mistakeRate: 0.32 * (1 - s),
    };
  }

  reset(skill = this.skill) {
    this.ema = this.target;
    this.integral = 0;
    this.prevError = 0;
    this.samples = 0;
    this.skill = clamp(skill, this.minSkill, this.maxSkill);
  }
}
