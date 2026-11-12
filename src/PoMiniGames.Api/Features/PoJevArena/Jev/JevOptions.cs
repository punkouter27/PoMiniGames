namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// Configuration for the arena's decision brain, bound from <c>PoMiniGames:Jev</c>. The brain is the
/// free rule-based <see cref="LocalJevClient"/>; <see cref="UseStub"/> exists for the test hosts only
/// and is honoured solely under the <c>Test</c> environment (see <c>tests/Shared/TestBudgetGuard.cs</c>).
/// </summary>
public sealed class JevOptions
{
    public const string SectionName = "PoMiniGames:Jev";

    /// <summary>Test hosts only; ignored outside the <c>Test</c> environment.</summary>
    public bool UseStub { get; set; }
}
