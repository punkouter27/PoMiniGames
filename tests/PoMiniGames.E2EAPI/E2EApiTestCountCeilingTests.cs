using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>E2E-API tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class E2EApiTestCountCeilingTests : TierCeilingGuard
{
    protected override int Ceiling => 18;
    protected override string TierName => "E2E-API";
    protected override string OverflowAdvice =>
        "consolidate, or move overflow to the Unit or Integration tier,";
}
