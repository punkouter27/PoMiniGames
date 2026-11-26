namespace PoMiniGames.Domain.Models;

/// <summary>
/// One rated PoFighter tournament bout as stored with the Elo board: who won, and both
/// fighters' ratings right after it. The fighter dossier reads these for its form and Elo history.
/// </summary>
public sealed record PoFighterBout
{
    public string WinnerId { get; init; } = string.Empty;
    public string LoserId { get; init; } = string.Empty;
    public bool IsDraw { get; init; }

    /// <summary>The winner's Elo after this bout (with a draw: the first-named fighter's).</summary>
    public int WinnerElo { get; init; }

    /// <summary>The loser's Elo after this bout.</summary>
    public int LoserElo { get; init; }

    /// <summary>ISO-8601 timestamp of the bout.</summary>
    public string At { get; init; } = string.Empty;
}
