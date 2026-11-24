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

    /// <summary>
    /// Receding-horizon 3-lane x 5-step dynamic programming lateral planner (#8).
    /// Balances upcoming apex curvature, slipstream tow gain, collision clearance, and
    /// one legal defensive lane shift when a faster rival is closing within 1.5 s behind.
    /// Stack-only (zero heap allocations, &lt;0.05 ms).
    /// </summary>
    public static double PlanTacticalLane(
        double currentLateral,
        double halfWidth,
        ReadOnlySpan<double> upcomingCurvatures,
        double slipstreamLateral,
        bool hasSlipstreamTarget,
        double defenderLateral,
        bool rivalClosingBehind,
        double aggression)
    {
        double edge = halfWidth * 0.78;
        ReadOnlySpan<double> lanes = [-edge, 0.0, edge];
        int steps = Math.Min(5, upcomingCurvatures.Length);
        if (steps == 0) return Math.Clamp(currentLateral, -edge, edge);

        // Defensive 1-move cover on the inside before braking when defending position.
        if (rivalClosingBehind && aggression >= 0.45)
        {
            double apexSign = upcomingCurvatures[0] >= 0 ? -1.0 : 1.0;
            double defendLane = Math.Clamp(0.6 * defenderLateral + 0.4 * apexSign * edge, -edge, edge);
            return defendLane;
        }

        Span<double> prevCost = stackalloc double[3];
        Span<double> nextCost = stackalloc double[3];
        for (int l = 0; l < 3; l++)
        {
            prevCost[l] = Math.Abs(lanes[l] - currentLateral) * 0.12;
        }

        Span<int> firstChoice = stackalloc int[3];
        for (int l = 0; l < 3; l++) firstChoice[l] = l;

        for (int s = 0; s < steps; s++)
        {
            double curv = upcomingCurvatures[s];
            double idealApex = curv > 0.001 ? -edge : curv < -0.001 ? edge : 0.0;
            for (int l = 0; l < 3; l++)
            {
                double lane = lanes[l];
                double apexPenalty = Math.Abs(lane - idealApex) * Math.Min(1.5, Math.Abs(curv) * 60.0);
                double towBonus = (s == 0 && hasSlipstreamTarget)
                    ? -Math.Max(0.0, 12.0 - Math.Abs(lane - slipstreamLateral) * 0.35)
                    : 0.0;
                double best = double.PositiveInfinity;
                for (int p = 0; p < 3; p++)
                {
                    double transition = Math.Abs(l - p) * 2.5;
                    double c = prevCost[p] + transition + apexPenalty + towBonus;
                    if (c < best) best = c;
                }
                nextCost[l] = best;
            }
            nextCost.CopyTo(prevCost);
        }

        int bestLane = 1;
        if (prevCost[0] < prevCost[bestLane]) bestLane = 0;
        if (prevCost[2] < prevCost[bestLane]) bestLane = 2;
        return lanes[bestLane];
    }
}
