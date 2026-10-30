using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>Source-generated log messages for the PoJevArena slice (EventIds 4800-4899).</summary>
internal static partial class PoJevArenaLog
{
    [LoggerMessage(EventId = 4804, Level = LogLevel.Warning,
        Message = "PoJevArena: serving the deterministic Jev stub ({Environment}).")]
    public static partial void JevStubEnabled(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4806, Level = LogLevel.Warning,
        Message = "PoJevArena: creature library {Operation} failed; degrading.")]
    public static partial void LibraryFailed(this ILogger logger, Exception ex, string operation);

    [LoggerMessage(EventId = 4807, Level = LogLevel.Information,
        Message = "PoJevArena: match {MatchId} finished ({Winner}) after {Decisions} decisions.")]
    public static partial void MatchFinished(this ILogger logger, string matchId, string winner, int decisions);
}
