using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// GET/PUT /api/pobrawl/progress — the 1P ladder run, per claim identity, so it follows a player
/// to another device (localStorage alone is keyed by display name and stays on one browser).
/// </summary>
public static class PoBrawlProgressEndpoints
{
    /// <summary>Mapped on the authenticated <c>/api</c> group: both verbs need an identity to key the row.</summary>
    public static IEndpointRouteBuilder MapPoBrawlProgressEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/pobrawl/progress").WithTags("PoBrawl");

        group.MapGet("", async (HttpContext http, PoBrawlProgressStore store, CancellationToken ct) =>
            {
                var userId = RequestIdentity.Resolve(http.User).UserId;
                if (string.IsNullOrEmpty(userId)) return Results.Unauthorized();
                var progress = await store.GetAsync(userId, ct);
                return progress is null ? Results.NoContent() : Results.Ok(progress);
            })
            .WithName("GetPoBrawlProgress")
            .Produces<PoBrawlProgressDto>()
            .RequireRateLimiting("leaderboard-read");

        group.MapPut("", async (PoBrawlProgressDto body, HttpContext http, PoBrawlProgressStore store, CancellationToken ct) =>
            {
                var identity = RequestIdentity.Resolve(http.User);
                if (string.IsNullOrEmpty(identity.UserId)) return Results.Unauthorized();
                // The rung is the index of the next opponent, so it tops out one short of the roster
                // size — read from PoBrawlRoster, never a literal (the ladder board's frozen-at-10 bug).
                if (body.Rung < 0 || body.Rung >= PoBrawlRoster.Count || body.BestKoSeconds is < 0 or > 600 || body.Clears is < 0 or > 100_000)
                    return Results.BadRequest(new { error = "progress_out_of_range" });
                // The merge lets the newer timestamp win the rung, so a stamp from the future would
                // pin this save over every later one from any device. Never later than now.
                body.UpdatedAtUnixMs = Math.Clamp(body.UpdatedAtUnixMs, 0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                var saved = await store.SaveAsync(identity.UserId, body, ct);
                return saved is null ? Results.StatusCode(StatusCodes.Status503ServiceUnavailable) : Results.Ok(saved);
            })
            .WithName("SavePoBrawlProgress")
            .Produces<PoBrawlProgressDto>()
            .RequireRateLimiting("highscores");

        return app;
    }
}
