using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>Integration tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class IntegrationTestCountCeilingTests : TierCeilingGuard
{
    protected override int Ceiling => 34;
    protected override string TierName => "Integration";
    protected override string OverflowAdvice =>
        "consolidate, or move overflow to the Unit or E2E-API tier,";
}
