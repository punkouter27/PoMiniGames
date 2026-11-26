namespace PoMiniGames.Shared.Games;

/// <summary>
/// Bounded skill-parameter adjustments produced by <see cref="PidDifficultyDirector"/>.
/// Nudges cognitive/tactical parameters (never physics or rubber-band stats).
/// </summary>
public readonly record struct DifficultyProfile(
    double SkillLevel,
    double ReactionDelayScale,
    double FeintRate,
    double PredictionThreshold,
    double MistakeRate);

/// <summary>
/// PID Flow-Channel Dynamic Difficulty Adjustment (DDA) director (#9).
/// Tracks rolling player performance with a 16-sample EMA and adjusts skill parameters
/// inside clamped bounds so leaderboard/rung integrity stays intact.
/// CPU target, &lt;0.02 ms at 1 Hz or per round/lap boundary, zero heap allocations.
/// </summary>
public sealed class PidDifficultyDirector
{
    private const double EmaAlpha = 2.0 / (16.0 + 1.0); // 16-sample EMA
    private readonly double _kp;
    private readonly double _ki;
    private readonly double _kd;
    private readonly double _minSkill;
    private readonly double _maxSkill;
    private readonly double _targetPerformance;

    private double _emaPerformance;
    private double _integral;
    private double _prevError;
    private double _skill;
    private int _samples;

    public PidDifficultyDirector(
        double initialSkill = 0.5,
        double minSkill = 0.15,
        double maxSkill = 0.95,
        double targetPerformance = 0.52,
        double kp = 0.35,
        double ki = 0.08,
        double kd = 0.12)
    {
        _minSkill = Math.Clamp(minSkill, 0.0, 1.0);
        _maxSkill = Math.Clamp(maxSkill, _minSkill, 1.0);
        _skill = Math.Clamp(initialSkill, _minSkill, _maxSkill);
        _targetPerformance = Math.Clamp(targetPerformance, 0.1, 0.9);
        _emaPerformance = _targetPerformance;
        _kp = kp;
        _ki = ki;
        _kd = kd;
    }

    public double SkillLevel => _skill;
    public double RollingPerformance => _emaPerformance;
    public int Samples => _samples;

    /// <summary>
    /// Feed a normalized player performance sample in [0, 1] (0 = struggling, 0.5 = even, 1 = dominating)
    /// and step the PID controller with anti-windup clamping.
    /// </summary>
    public DifficultyProfile Update(double performanceSample, double dtSeconds = 1.0)
    {
        double clamped = Math.Clamp(performanceSample, 0.0, 1.0);
        double dt = Math.Clamp(dtSeconds, 0.05, 30.0);

        _emaPerformance = _samples == 0
            ? clamped
            : _emaPerformance + EmaAlpha * (clamped - _emaPerformance);
        _samples++;

        double error = _emaPerformance - _targetPerformance;
        double candidateIntegral = Math.Clamp(_integral + error * dt, -1.5, 1.5);
        double derivative = (error - _prevError) / dt;
        _prevError = error;

        double delta = _kp * error + _ki * candidateIntegral + _kd * derivative;
        double nextSkill = _skill + Math.Clamp(delta * 0.25, -0.08, 0.08);

        // Anti-windup: only commit integral if we are not saturated in the same direction.
        if ((nextSkill > _minSkill && nextSkill < _maxSkill) || Math.Sign(error) != Math.Sign(_integral))
        {
            _integral = candidateIntegral;
        }

        _skill = Math.Clamp(nextSkill, _minSkill, _maxSkill);
        return CurrentProfile();
    }

    public DifficultyProfile CurrentProfile()
    {
        double s = _skill;
        return new DifficultyProfile(
            SkillLevel: s,
            ReactionDelayScale: 1.45 - 0.85 * s,   // 1.45x slower at low skill -> 0.60x at high skill
            FeintRate: 0.05 + 0.45 * s,            // 5% -> 50%
            PredictionThreshold: 0.78 - 0.36 * s,  // harder to trigger reads at low skill
            MistakeRate: 0.32 * (1.0 - s));        // 32% -> 0%
    }

    public void Reset(double? skill = null)
    {
        _emaPerformance = _targetPerformance;
        _integral = 0;
        _prevError = 0;
        _samples = 0;
        if (skill.HasValue) _skill = Math.Clamp(skill.Value, _minSkill, _maxSkill);
    }
}
