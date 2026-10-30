using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Source-generated, zero-allocation log messages for PoFunQuiz. The
/// <c>[LoggerMessage]</c> source generator emits strongly-typed, cached delegates so these
/// high-frequency call sites avoid the boxing and template-parsing cost of the
/// <c>ILogger.LogX(string, params object[])</c> overloads.
/// </summary>
internal static partial class FunQuizLog
{
    [LoggerMessage(EventId = 4104, Level = LogLevel.Information,
        Message = "PoFunQuiz game {Code} created by {Host}")]
    public static partial void GameCreated(this ILogger logger, string code, string host);

    [LoggerMessage(EventId = 4105, Level = LogLevel.Information,
        Message = "PoFunQuiz {Code}: {Name} joined")]
    public static partial void PlayerJoined(this ILogger logger, string code, string name);

    [LoggerMessage(EventId = 4106, Level = LogLevel.Warning,
        Message = "PoFunQuiz: serving {Served} of {Requested} requested questions; {Rejected} item(s) failed validation. A partial batch still plays, but a rising count here means the deployment is drifting off the schema.")]
    public static partial void PartialQuestionBatch(this ILogger logger, int served, int requested, int rejected);

    [LoggerMessage(EventId = 4107, Level = LogLevel.Error,
        Message = "PoFunQuiz: JoinLobby failed for {Player} (category {Category}).")]
    public static partial void JoinLobbyFailed(this ILogger logger, Exception ex, string player, QuestionCategory category);
}
