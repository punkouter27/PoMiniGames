using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoFighter;

/// <summary>
/// PoFighter's CPU-vs-CPU tournament fighter Elo board: <c>POST /api/pofighter/elo</c> records
/// one bout, <c>GET /api/pofighter/elo</c> reads the board. Rates characters, not players.
/// </summary>
public static class PoFighterEloEndpoints
{
    /// <summary>How many bouts the dossier reads: enough for a 20-point Elo sparkline.</summary>
    public const int BoutHistory = 20;

    public static IEndpointRouteBuilder MapPoFighterEloEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/pofighter/elo").WithTags("HighScores");

        group.MapGet("",
            async (IStorageService storage) => Results.Ok(await storage.GetPoFighterRatingsAsync()))
            .WithName("GetPoFighterElo")
            .WithSummary("PoFighter fighter Elo board, highest first")
            .Produces<IEnumerable<PoFighterFighterRating>>(StatusCodes.Status200OK);

        // The dossier: one fighter's last rated bouts, newest first (form, streak, Elo history).
        group.MapGet("/{fighterId}/bouts",
            async (string fighterId, IStorageService storage) =>
                PoFighterRoster.Canonicalize(fighterId) is { } id
                    ? Results.Ok(await storage.GetPoFighterBoutsAsync(id, BoutHistory))
                    : ApiValidation.BadRequestProblem("invalid_fighter", "The fighter must be on the PoFighter roster."))
            .WithName("GetPoFighterBouts")
            .WithSummary("A PoFighter fighter's last rated bouts, newest first")
            .Produces<IEnumerable<PoFighterBout>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest);

        group.MapPost("",
            async (PoFighterBoutResultRequest request, IStorageService storage) =>
            {
                // The server owns roster and arithmetic: an id off the roster is refused rather
                // than minting a row, and ids are compared canonically.
                var winner = PoFighterRoster.Canonicalize(request.WinnerFighterId);
                var loser = PoFighterRoster.Canonicalize(request.LoserFighterId);
                if (winner is null || loser is null)
                    return ApiValidation.BadRequestProblem("invalid_fighter", "Both fighters must be on the PoFighter roster.");

                if (string.Equals(winner, loser, StringComparison.Ordinal))
                    return ApiValidation.BadRequestProblem("fighter_self_match", "A fighter cannot fight itself.");

                var result = await storage.RecordPoFighterBoutAsync(winner, loser, request.IsDraw);
                return result is { } r
                    ? Results.Ok(new[] { r.Winner, r.Loser })
                    : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            })
            .WithName("RecordPoFighterBout")
            .WithSummary("Record one CPU-vs-CPU PoFighter bout")
            .Produces<PoFighterFighterRating[]>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .RequireRateLimiting("pobrawl-elo");

        return app;
    }
}
