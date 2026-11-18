using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Source-generated <see cref="ILogger"/> extension methods for PoCoupleQuiz. Using
/// <c>[LoggerMessage]</c> means the format string is emitted at compile time, the
/// delegate is cached, and disabled levels cost zero allocations — vs the legacy
/// <c>LogInformation("foo {Bar}", bar)</c> shape which boxes arguments and rebuilds
/// the message template on every call.
/// </summary>
internal static partial class CoupleQuizLog
{
    [LoggerMessage(EventId = 5107, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: the round timer callback threw; the lobby is left recoverable.")]
    public static partial void RoundTimerFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 5108, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: could not generate the next question; the match will end early.")]
    public static partial void RoundAdvanceFailed(this ILogger logger, Exception ex);
}
