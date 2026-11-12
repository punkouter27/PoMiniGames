using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Features.PoMule;

/// <summary>
/// PoMule's Net Worth board. The match itself runs in the browser; the server replays it from
/// the seed and action log that come with the score (<see cref="PoMuleRunVerifier"/>), rejects a
/// result the replay does not reach, stamps the identity and keeps each player's best.
/// </summary>
/// <remarks>
/// A client from before the log (a tab open across the deploy, or a match resumed from an older
/// save) sends neither seed nor log. Its score is still range-checked and kept, as before, and
/// logged as unverified: the board row has no verified flag to carry that.
/// </remarks>
internal static class PoMuleEndpoints
{
    public static IEndpointRouteBuilder MapPoMuleScoreEndpoints(this IEndpointRouteBuilder app)
    {
        var scores = app.MapGroup("/pomule/highscores").WithTags("HighScores");

        scores.MapGet("", async (IStorageService storage, int count = 10) =>
            {
                count = Math.Clamp(count, 1, 100);
                return Results.Ok(await storage.GetPoMuleHighScoresAsync(count));
            })
            .WithName("GetPoMuleHighScores")
            .Produces<IEnumerable<PoMuleHighScore>>(StatusCodes.Status200OK);

        scores.MapPost("", async (PoMuleRunRequest request, HttpContext http,
                IStorageService storage, ScoreIntegrityGuard integrity, ILoggerFactory loggerFactory) =>
            {
                var log = loggerFactory.CreateLogger("PoMiniGames.Features.PoMule");
                var errors = new Dictionary<string, string[]>();
                if (request.NetWorth is < PoMuleHighScore.MinNetWorth or > PoMuleHighScore.MaxNetWorth)
                    errors[nameof(request.NetWorth)] =
                        [$"Net Worth must be between {PoMuleHighScore.MinNetWorth:N0} and {PoMuleHighScore.MaxNetWorth:N0}."];
                if (request.Species < 0 || request.Species >= PoMuleSpecies.All.Count)
                    errors[nameof(request.Species)] = ["Unknown species."];
                if ((request.Seed is null) != (request.Log is null))
                    errors[nameof(request.Log)] = ["A replay needs both the seed and the action log."];
                if (errors.Count > 0) return Results.ValidationProblem(errors);

                var verdict = integrity.Inspect(http, GameKey.PoMule, request.NetWorth);
                if (!verdict.Allowed)
                {
                    PoMuleLog.ScoreRejected(log, request.NetWorth, verdict.Code ?? "integrity");
                    return verdict.ToProblem();
                }

                if (request is { Seed: { } seed, Log: { } actions })
                {
                    var replayed = PoMuleRunVerifier.Replay(seed, request.Species, request.Classic, actions);
                    if (replayed is not { } truth
                        || truth.NetWorth != request.NetWorth || truth.ColonySurvived != request.ColonySurvived)
                    {
                        PoMuleLog.ScoreRejected(log, request.NetWorth, replayed is null ? "replay-invalid" : $"replay-mismatch:{replayed.Value.NetWorth}");
                        return Results.ValidationProblem(new Dictionary<string, string[]>
                        {
                            [nameof(request.Log)] = ["The match replay does not reach this result."],
                        });
                    }
                }
                else
                {
                    PoMuleLog.ScoreUnverified(log, request.NetWorth);
                }

                // Server-authoritative identity: the body carries no name to forge.
                var identity = RequestIdentity.Resolve(http.User);
                var name = integrity.ResolveDisplayName(
                    identity.DisplayName,
                    identity.IsAuthenticated ? "Player" : "Guest");

                var saved = await storage.SavePoMuleHighScoreAsync(new PoMuleHighScore
                {
                    PlayerName = name,
                    UserId = identity.UserId,
                    IsGuest = identity.IsGuest,
                    NetWorth = request.NetWorth,
                    Species = PoMuleSpecies.All[request.Species].Name,
                    ColonySurvived = request.ColonySurvived,
                    AchievedAtUtc = DateTimeOffset.UtcNow,
                });
                PoMuleLog.ScoreSaved(log, identity.UserId, identity.IsGuest, request.NetWorth);
                return Results.Created("/api/pomule/highscores", saved);
            })
            .WithName("SavePoMuleHighScore")
            .Produces<PoMuleHighScore>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .RequireRateLimiting("highscores");

        return app;
    }
}

/// <summary>
/// A finished match as the client posts it. <c>Species</c> is the roster index. <c>Seed</c>,
/// <c>Classic</c> and <c>Log</c> are what the replay needs; an older client omits them.
/// </summary>
public sealed record PoMuleRunRequest(int NetWorth, int Species, bool ColonySurvived,
    ulong? Seed = null, bool Classic = false, string? Log = null);

internal static partial class PoMuleLog
{
    [LoggerMessage(Level = LogLevel.Information,
        Message = "PoMule match saved user={UserId} guest={IsGuest} netWorth={NetWorth}")]
    public static partial void ScoreSaved(ILogger logger, string userId, bool isGuest, int netWorth);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "PoMule match rejected: netWorth={NetWorth} ({Reason})")]
    public static partial void ScoreRejected(ILogger logger, int netWorth, string reason);

    [LoggerMessage(Level = LogLevel.Information,
        Message = "PoMule match without a replay log: netWorth={NetWorth} range-checked only")]
    public static partial void ScoreUnverified(ILogger logger, int netWorth);
}
