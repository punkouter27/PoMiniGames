using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>Source-generated log messages for the PoEcosystem slice (same shape as FunQuizLog).</summary>
internal static partial class EcosystemLog
{
    [LoggerMessage(EventId = 4604, Level = LogLevel.Warning,
        Message = "PoEcosystem: world store operation {Operation} failed; degrading to empty.")]
    public static partial void EcoStoreFailed(this ILogger logger, Exception ex, string operation);
}
