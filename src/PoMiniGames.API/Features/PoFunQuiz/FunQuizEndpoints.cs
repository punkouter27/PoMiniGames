using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoFunQuiz.Storage;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Minimal-API endpoints for PoFunQuiz: question generation, leaderboard submit / fetch,
/// and per-game runtime status. Real-time multiplayer (lobby + score updates) is handled
/// by the SignalR hub (<see cref="FunQuizHub"/>) in a follow-up. This MVP serves the
/// Solo mode and the leaderboard.
/// </summary>
public static class FunQuizEndpoints
{
    public static IEndpointRouteBuilder MapFunQuizEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/funquiz").WithTags("PoFunQuiz");

        // ── Questions ────────────────────────────────────────────────────
        // Dealt at random from the question bank loaded once from Data/questions.json.
        //
        // Not cached here. Memoizing the finished, already-dealt list would give every game in
        // the same window a byte-identical quiz; the dealing happens per request.

        group.MapGet("/quiz/questions", async (
            [FromQuery] int count,
            [FromQuery] string? category,
            IFunQuizQuestionSource questionSource,
            CancellationToken cancellationToken) =>
        {
            if (count <= 0) count = 10;
            // A too-large count is a malformed request, not a rate-limit hit. Returning 429
            // would put a second, unrelated meaning on the one status code the rate limiter
            // owns — and the client surfaces 429 as "wait and retry", advice that would never
            // make count=500 succeed.
            if (count > 50) return Results.BadRequest(new { error = "count must be between 1 and 50." });

            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c)
                ? c
                : QuestionCategory.General;

            var questions = await questionSource.GetQuestionsAsync(cat, count, cancellationToken);
            return Results.Ok(questions);
        })
        .WithName("FunQuiz_GetQuestions")
        .WithSummary("PoFunQuiz questions dealt at random from the bundled bank");


        // ── Leaderboard ────────────────────────────────────────────────────────

        group.MapGet("/leaderboard", async (
            [FromQuery] string? category,
            [FromQuery] int? top,
            LeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c) ? c : QuestionCategory.General;
            var entries = await repo.GetTopAsync(cat, top ?? 10, cancellationToken);
            return Results.Ok(entries);
        })
        .WithName("FunQuiz_GetLeaderboard")
        .WithSummary("Top PoFunQuiz players for a category");

        group.MapPost("/leaderboard", async (
            [FromBody] LeaderboardEntry body,
            HttpContext ctx,
            LeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            // Anti-spoof: the stored name comes from the caller's claims, never the body.
            // The board is readable without signing in, so it must be a display name and
            // never an email: an address-shaped claim keeps only the part before the '@'.
            var claimed = RequestIdentity.Resolve(ctx.User).DisplayName;
            var at = claimed.IndexOf('@');
            body.PlayerName = DisplayNameSanitizer.Sanitize(at > 0 ? claimed[..at] : claimed, fallback: "Player").Value;
            body.Score = Math.Clamp(body.Score, 0, 10_000);
            // The row key is derived from the date, so a client-chosen one mints unlimited rows.
            body.DatePlayed = DateTime.UtcNow;
            await repo.SubmitAsync(body, cancellationToken);
            return Results.Created("/api/funquiz/leaderboard", body);
        })
        .RequireAuthorization()
        .RequireRateLimiting("highscores")
        .WithName("FunQuiz_SubmitLeaderboard");

        return app;
    }
}
