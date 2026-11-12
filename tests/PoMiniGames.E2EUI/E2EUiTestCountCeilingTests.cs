using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EUI;

/// <summary>E2E-UI tier ceiling (the most expensive tier: real Chromium, real WASM cold
/// boot, real Kestrel). Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class E2EUiTestCountCeilingTests : TierCeilingGuard
{
    protected override int Ceiling => 22;
    protected override string TierName => "E2E-UI";
    protected override string OverflowAdvice => "consolidate, or move overflow to a cheaper tier,";
}
