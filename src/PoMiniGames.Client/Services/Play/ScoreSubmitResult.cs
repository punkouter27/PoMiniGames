using System.Net;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>Why a score submission ended the way it did — and therefore whether replaying it can ever help.</summary>
public enum ScoreSubmitOutcome
{
    /// <summary>The server accepted and persisted the score.</summary>
    Saved,

    /// <summary>
    /// The server refused the payload (4xx). Replaying it is guaranteed to fail again, so it must be
    /// dropped rather than parked — a queued entry that can never succeed blocks nothing but wastes
    /// every future flush and lies to the player about syncing "later".
    /// </summary>
    Rejected,

    /// <summary>
    /// The server could not be reached, or failed (5xx). The payload is fine, so parking it in the
    /// offline queue and retrying is the right move.
    /// </summary>
    Unavailable,
}

/// <summary>
/// The result of a board submission. Replaces a bare <c>T?</c>, which forced callers to treat a
/// server error and a dead network as the same thing.
/// </summary>
/// <param name="Outcome">What happened.</param>
/// <param name="Value">The persisted row, when <see cref="ScoreSubmitOutcome.Saved"/>.</param>
/// <param name="StatusCode">The response status, when there was a response at all.</param>
public readonly record struct ScoreSubmitResult<T>(ScoreSubmitOutcome Outcome, T? Value, HttpStatusCode? StatusCode)
    where T : class
{
    public bool IsSaved => Outcome == ScoreSubmitOutcome.Saved;

    /// <summary>True when parking the payload for a later retry could plausibly succeed.</summary>
    public bool ShouldRetry => Outcome == ScoreSubmitOutcome.Unavailable;

#pragma warning disable CA1000 // Convenience factory helpers mirror Result<T> creation pattern.
#pragma warning disable CA1000 // Convenience factory helpers mirror Result<T> creation pattern.
    public static ScoreSubmitResult<T> Saved(T? value) => new(ScoreSubmitOutcome.Saved, value, HttpStatusCode.Created);
    public static ScoreSubmitResult<T> Rejected(HttpStatusCode status) => new(ScoreSubmitOutcome.Rejected, null, status);
    public static ScoreSubmitResult<T> Unavailable(HttpStatusCode? status) => new(ScoreSubmitOutcome.Unavailable, null, status);
}
