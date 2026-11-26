namespace PoMiniGames.Domain.Models;

/// <summary>
/// One ranked row in a normalized leaderboard. <see cref="Value"/> is the raw comparable number;
/// <see cref="DisplayValue"/> is the already-formatted string for the UI (e.g. "73%", "1,240", "8.4s"),
/// so the client never has to know whether a game is scored by win-rate, points, or survival time.
/// </summary>
public sealed record LeaderboardEntryDto(
    int Rank, string Name, double Value, string DisplayValue);

/// <summary>
/// A single game's leaderboard in a shape that is identical across every game. Collapses the
/// previously divergent per-game boards (win-rate stats, snake points, marble points, drop-square
/// survival) behind one contract so the client renders them with one component.
/// </summary>
public sealed record GameLeaderboardDto(
    string GameKey,
    string Title,
    string Unit,
    bool HigherIsBetter,
    IReadOnlyList<LeaderboardEntryDto> Entries);
