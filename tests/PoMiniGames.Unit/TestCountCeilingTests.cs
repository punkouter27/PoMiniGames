using PoMiniGames.TestUtilities;

namespace PoMiniGames.Unit;

/// <summary>Unit tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class TestCountCeilingTests : TierCeilingGuard
{
    // Was 100 from 2026-10-17. Measured 81 on 2026-11-11, so the cap moved to 85: that
    // still leaves room to fold a one-off in, but a tier that starts growing by accident
    // fails the guard before it drifts back to 100.
    protected override int Ceiling => 85;
    protected override string TierName => "Unit";
    protected override string OverflowAdvice =>
        "fold facts into the class's Scenario theory (see Scenarios.cs), or move overflow to the Integration tier,";
}
