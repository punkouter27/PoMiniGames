namespace PoMiniGames.Features.PoRacer;

/// <summary>How a bot behaves around the track and around other cars (PoRacerSim.UpdateAi).</summary>
public enum PoRacerAiStyle
{
    /// <summary>Holds its lane and goes round a blocked car.</summary>
    Steady,
    /// <summary>Moves to the inside of every bend: the shortest way round.</summary>
    ApexHugger,
    /// <summary>Steers into a car alongside and never goes round one ahead.</summary>
    Bruiser,
    /// <summary>Sees a bend late and lifts less for it, so it arrives hot and sometimes runs wide.</summary>
    LateBraker,
    /// <summary>Lifts behind a car instead of touching it and moves away from one alongside.</summary>
    Cautious,
    /// <summary>Lines up behind the car ahead for its tow.</summary>
    DraftHunter,
    /// <summary>Takes the tow, then pulls out of it to pass.</summary>
    Slingshot,
    /// <summary>Changes lane on a whim and now and then forgets to lift for a bend.</summary>
    Wildcard,
}

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
    bool PrefersDrafting,
    PoRacerAiStyle Style = PoRacerAiStyle.Steady,
    // Scales how much speed the bot gives up for a bend (the race's own caution is the base).
    double Caution = 1.0);

public static class PoRacerAiDriver
{
    // The eight styles average out at about the caution the solo tiers were measured with, so a
    // field's pace is where it was; what changed is that each car now gets there its own way.
    private static readonly IReadOnlyList<PoRacerAiPersonality> Personalities = new[]
    {
        new PoRacerAiPersonality("Apex Predator", "Apex Hugger", "#ff3366", 0.95, 310, 205, 1.10, 0.00, 1.2, 0.85, false, PoRacerAiStyle.ApexHugger, 0.94),
        new PoRacerAiPersonality("Draft Hunter", "Draft Specialist", "#00f0ff", 0.85, 305, 200, 1.05, 0.00, 1.0, 0.60, true, PoRacerAiStyle.DraftHunter),
        new PoRacerAiPersonality("Aggressive Bumper", "Heavy Bumper", "#ff9900", 0.70, 315, 220, 0.95, 0.35, 0.9, 0.95, false, PoRacerAiStyle.Bruiser),
        new PoRacerAiPersonality("Ghost Line", "Precision Racer", "#a855f7", 0.98, 300, 195, 1.15, 0.00, 1.3, 0.40, false, PoRacerAiStyle.Steady, 0.96),
        new PoRacerAiPersonality("Speed Demon", "Late Braker", "#eab308", 0.65, 325, 230, 0.90, -0.20, 1.1, 0.75, false, PoRacerAiStyle.LateBraker),
        new PoRacerAiPersonality("Cautious Cruiser", "Defensive Cruiser", "#10b981", 0.80, 295, 190, 1.05, 0.25, 1.4, 0.30, false, PoRacerAiStyle.Cautious, 1.10),
        new PoRacerAiPersonality("Slipstreamer", "Slingshot Overtaker", "#3b82f6", 0.88, 308, 205, 1.02, 0.10, 1.0, 0.65, true, PoRacerAiStyle.Slingshot),
        new PoRacerAiPersonality("Loose Cannon", "Wildcard", "#06b6d4", 0.75, 305, 200, 1.00, 0.00, 1.0, 0.50, false, PoRacerAiStyle.Wildcard, 1.04)
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
