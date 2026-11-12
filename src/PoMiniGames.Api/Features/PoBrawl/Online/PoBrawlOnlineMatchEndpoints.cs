using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Result ingest for live PoBrawl 1v1. The match service hands each client its
/// own <see cref="PoBrawlMatchResult"/> when the fight ends; this endpoint is
/// what the client POSTs that result to.
/// </summary>
/// <remarks>
/// <para>
/// <b>Everything the result depends on is server-derived.</b> The request body
/// is only consulted for the match id; outcome, opponent and duration come from the still-held
/// <see cref="PoBrawlMatchService"/> via <see cref="PoBrawlMatchService.BuildResultForPrincipal"/>.
/// Pricing Elo off the client's own claim of who won would let a hand-crafted POST
/// mint arbitrary rating swings for, or against, any principal.
/// </para>
/// <para>
/// <b>Both corners POST the same match, so the Elo increment is claimed once per MATCH</b>
/// (<see cref="MatchHistoryRepository.TryClaimEloIncrementAsync"/>) — not per owner. The
/// history dedup is per-owner and invisible to callers, so before this claim existed each
/// fight's zero-sum rating pair-write ran twice: once per corner that reported it.
/// </para>
/// </remarks>
public static class PoBrawlOnlineMatchEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlOnlineMatchEndpoints(this IEndpointRouteBuilder app)
    {
        // POST — record a finished 1v1 match and increment both players' Elo. Answers 204 once
        // the swing is applied (or was already); 503 + Retry-After when the rating write did not
        // land, so the client posts again. The ratings surface on the Online MMR board.
        app.MapPost("/pobrawl/matches",
            async (
                [FromBody] PoBrawlMatchResultDto dto,
                HttpContext http,
                IStorageService storage,
                ScoreIntegrityGuard integrity,
                MatchHistoryRepository matchHistory,
                PoBrawlMatchRegistry registry,
                ILoggerFactory loggerFactory,
                CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(dto.MatchId))
                {
                    return Results.ValidationProblem(
                        new Dictionary<string, string[]> { [nameof(dto.MatchId)] = ["MatchId is required."] });
                }

                // Authoritative identity — never trust the client-supplied owner id
                // or display name. The auth cookie is the only source of truth for
                // who the submitting player actually is.
                var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);
                if (string.IsNullOrWhiteSpace(userId))
                {
                    return Results.Problem(
                        title: "Sign in required",
                        detail: "Live 1v1 matches require an authenticated identity so Elo can be attributed.",
                        statusCode: StatusCodes.Status401Unauthorized);
                }

                // The fight this id names must still be held, finished, and the caller must be
                // one of its two corners. Anything else — a fabricated id, a replay past the
                // FinishedLinger sweep, a spectator, a caller who is not in the fight — is a
                // rejection, because the server, not the POST body, decides what happened.
                var match = registry.FindByMatchId(dto.MatchId);
                if (match is null)
                {
                    return Results.Problem(
                        title: "Match not held",
                        detail: "No finished fight with that id is still held. Results must be reported before the fight is swept.",
                        statusCode: StatusCodes.Status404NotFound);
                }
                if (match.FinishedAtUtc is null)
                {
                    return Results.Problem(
                        title: "Match not finished",
                        detail: "That fight is still running — results arrive when the bell rings.",
                        statusCode: StatusCodes.Status409Conflict);
                }
                var truth = match.BuildResultForPrincipal(userId);
                if (truth is null)
                {
                    return Results.Problem(
                        title: "Not a corner of this fight",
                        detail: "Only the two players in the match may report its result.",
                        statusCode: StatusCodes.Status403Forbidden);
                }

                var log = loggerFactory.CreateLogger("PoBrawlOnlineMatches");
                log.LogInformation(
                    "PoBrawl online match POST user={UserId} matchId={MatchId} outcome={Outcome} duration={Duration}s forfeit={Forfeit} abandoned={Abandoned}",
                    userId, dto.MatchId, truth.Outcome, truth.DurationSeconds, truth.Forfeit, truth.Abandoned);

                // A fight one corner never arrived at (or both walked out of) was never fought:
                // nothing to record, no rating to move.
                if (truth.Abandoned)
                {
                    return Results.NoContent();
                }

                var localLost = truth.Outcome == PoBrawlOutcome.Loss;
                var isDraw = truth.Outcome == PoBrawlOutcome.Draw;
                var winnerPid = localLost ? truth.OpponentId : userId;
                var loserPid = localLost ? userId : truth.OpponentId;

                // Before any write. The lobby gives one principal one seat, but a roster made any
                // other way must still be a 400 here, not a history row and a rating fighting itself.
                if (string.Equals(PrincipalIds.Sanitize(winnerPid), PrincipalIds.Sanitize(loserPid), StringComparison.Ordinal))
                {
                    return Results.BadRequest(new { error = "opponent_is_self" });
                }

                // The moderated names, like every other board — the raw claim name and the lobby's
                // copy of the opponent's never reach the Online MMR board as typed.
                var ownName = BoardName(integrity, displayName, isGuest);
                var opponentName = BoardName(integrity, truth.OpponentDisplayName, isGuest: false);

                // History row per corner (per-owner idempotency inside). A retried POST lands
                // here as a duplicate and is a no-op.
                await matchHistory.RecordAsync(new MatchRecordRequest(
                    Owner: ownName,
                    Game: GameKey.PoBrawl.Value,
                    Mode: "multiplayer",
                    OpponentName: opponentName,
                    OpponentType: "guest",
                    Outcome: truth.Outcome.ToString().ToLowerInvariant(),
                    OwnerType: isGuest ? "guest" : "microsoft",
                    MatchId: dto.MatchId), ct);

                // The zero-sum Elo pair-write, exactly once per match. The winner/loser pair is
                // mapped from the server's own result — the corner that happens to win the claim
                // is irrelevant, both corners report the same outcome pair.
                switch (await matchHistory.TryClaimEloIncrementAsync(dto.MatchId, ct))
                {
                    case EloClaim.AlreadyClaimed:
                        // The other corner (or a retry of ours) already applied the swing.
                        return Results.NoContent();
                    case EloClaim.Unavailable:
                        return RetryLater(http);
                }

                var written = await storage.RecordPoBrawlOnlineMatchAsync(
                    winnerPrincipalId: PrincipalIds.Sanitize(winnerPid),
                    loserPrincipalId: PrincipalIds.Sanitize(loserPid),
                    winnerDisplayName: localLost ? opponentName : ownName,
                    loserDisplayName: localLost ? ownName : opponentName,
                    isDraw: isDraw);
                if (!written)
                {
                    // The claim is held but the ratings never moved (storage down, or a pair-write
                    // that failed and was rolled back). Give the claim back so the retry this
                    // answer asks for — or the other corner's POST — can apply it.
                    await matchHistory.ReleaseEloIncrementAsync(dto.MatchId, ct);
                    log.LogWarning("PoBrawl online Elo for {MatchId} did not land; claim released for a retry.", dto.MatchId);
                    return RetryLater(http);
                }

                return Results.NoContent();
            })
            .RequireAuthorization()
            .RequireRateLimiting("highscores");

        return app;
    }

    /// <summary>
    /// 503 with a Retry-After: the fight is still held (until FinishedLinger sweeps it), so the
    /// same POST can land later. The history row is idempotent per corner, so a retry only adds
    /// the rating swing.
    /// </summary>
    private static IResult RetryLater(HttpContext http)
    {
        http.Response.Headers.RetryAfter = "5";
        return Results.Problem(
            title: "Rating not recorded",
            detail: "The rating store is unavailable right now; post the same result again shortly.",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    /// <summary>A display name as the public boards store it: moderated, at most 24 characters.</summary>
    private static string BoardName(ScoreIntegrityGuard integrity, string? name, bool isGuest)
    {
        var resolved = integrity.ResolveDisplayName(name, isGuest ? "Guest" : "Player").Trim();
        return resolved.Length > 24 ? resolved[..24].TrimEnd() : resolved;
    }
}
