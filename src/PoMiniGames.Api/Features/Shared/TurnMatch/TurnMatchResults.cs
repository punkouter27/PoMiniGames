using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>A finished two-seat match, as the server saw it. Ids are the sanitized principal ids of the seats.</summary>
public sealed record TurnMatchResult(
    string MatchId,
    string FirstId,
    string FirstName,
    string SecondId,
    string SecondName,
    TurnMatchStatus Status);

/// <summary>
/// Where a finished match is scored. The turn-match service calls it once per match, on the server,
/// so ratings can only come from a match the server itself adjudicated.
/// </summary>
public interface ITurnMatchResultSink
{
    /// <summary>Score the match; null when it is not rated (for example both seats are the same browser).</summary>
    Task<TurnMatchRatings?> RecordAsync(TurnMatchResult result, CancellationToken cancellationToken = default);
}
