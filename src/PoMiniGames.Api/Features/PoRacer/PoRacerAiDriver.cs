namespace PoMiniGames.Features.PoRacer;

public sealed record PoRacerAiPersonality(
    string Name,
    string Trait,
    string PrimaryColor,
    double CorneringSkill,
    double MaxSpeed,
    double Acceleration,
    double Handling,
    double LateralOffsetRatio,
    double LookaheadFactor,
    double Aggression,
    bool PrefersDrafting);

public static class PoRacerAiDriver
{
    private static readonly IReadOnlyList<PoRacerAiPersonality> Personalities = new[]
    {
        new PoRacerAiPersonality("Apex Predator", "Apex Hugger", "#ff3366", 0.95, 310, 205, 1.10, -0.30, 1.2, 0.85, false),
        new PoRacerAiPersonality("Draft Hunter", "Draft Specialist", "#00f0ff", 0.85, 305, 200, 1.05, 0.00, 1.0, 0.60, true),
        new PoRacerAiPersonality("Aggressive Bumper", "Heavy Bumper", "#ff9900", 0.70, 315, 220, 0.95, 0.35, 0.9, 0.95, false),
        new PoRacerAiPersonality("Ghost Line", "Precision Racer", "#a855f7", 0.98, 300, 195, 1.15, 0.00, 1.3, 0.40, false),
        new PoRacerAiPersonality("Speed Demon", "Top-End Charger", "#eab308", 0.65, 325, 230, 0.90, -0.20, 1.1, 0.75, false),
        new PoRacerAiPersonality("Cautious Cruiser", "Defensive Cruiser", "#10b981", 0.80, 295, 190, 1.05, 0.25, 1.4, 0.30, false),
        new PoRacerAiPersonality("Slipstreamer", "Slingshot Overtaker", "#3b82f6", 0.88, 308, 205, 1.02, 0.10, 1.0, 0.65, true),
        new PoRacerAiPersonality("Vanguard", "All-Rounder", "#06b6d4", 0.75, 305, 200, 1.00, 0.00, 1.0, 0.50, false)
    };

    public static PoRacerAiPersonality GetPersonality(int index) =>
        Personalities[Math.Abs(index) % Personalities.Count];

    public static bool IsDrafting(Vec2 botPos, double botHeading, Vec2 targetPos)
    {
        double dx = targetPos.X - botPos.X;
        double dy = targetPos.Y - botPos.Y;
        double distSq = dx * dx + dy * dy;
        if (distSq is < 25 * 25 or > 140 * 140) return false;

        double angleToTarget = Math.Atan2(dy, dx);
        double angleDiff = Math.Abs(ShortAngleDiff(angleToTarget, botHeading));
        return angleDiff < 0.32; // within ~18 degrees cone ahead
    }

    public static double ShortAngleDiff(double a, double b)
    {
        var diff = (a - b) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        return diff;
    }
}
