using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;

namespace PoMiniGames.Infrastructure;

/// <summary>Registers the rate-limiter policies used by the API's write and read endpoints.</summary>
/// <remarks>
/// Every policy is the same shape — a fixed one-minute window on the compound
/// <c>{ip}|{identity}</c> partition (see <see cref="BuildPartitionKey"/>) — and only the
/// per-window budget differs. <see cref="FixedWindow"/> is that shape, so a policy is one
/// line and its comment is about the number, which is the only thing that is a decision.
/// </remarks>
internal static class RateLimitingExtensions
{
    public static IServiceCollection AddPoMiniGamesRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(opts =>
        {
            opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            // Score submissions. A round ends with one post, so ten a minute is a
            // generous ceiling for a human and a hard cap for a script.
            opts.AddPolicy("highscores", ctx => FixedWindow(ctx, permitLimit: 10));

            // Anonymous leaderboard READS. A read is cheaper than a write (one bounded
            // partition query, no read-modify-write) and shares no bucket with "highscores",
            // so a page that reads a board before submitting to it cannot starve its own
            // write. 60/min still caps an unauthenticated flood at ~1 rps per partition,
            // which matters because these endpoints carry AllowAnonymous and Table Storage
            // on an F1 plan is the thing behind them.
            opts.AddPolicy("leaderboard-read", ctx => FixedWindow(ctx, permitLimit: 60));

            // Play-session minting: one mint per game the player opens, so a normal session
            // spends a handful. Not unlimited on purpose — a signed session is the only
            // credential a score submission carries.
            opts.AddPolicy("play-session", ctx => FixedWindow(ctx, permitLimit: 30));

            // Account export / erase: the tightest budget in the app, because each call is a
            // full cross-table scan of every board's partition. A human does this once.
            opts.AddPolicy("account-data", ctx => FixedWindow(ctx, permitLimit: 5));

            // PoCabinet best laps: one submission per finish, the same budget as "highscores".
            opts.AddPolicy("pocabinet", ctx => FixedWindow(ctx, permitLimit: 10));

            // PoBrawl demo fighter Elo, in its own bucket so a kiosk (or a 4x tournament)
            // reporting bouts cannot starve the same player's KO and ladder posts. The real
            // per-identity limits are PoBrawlDemoEloGate's; this only caps a burst at the
            // gate's own pace.
            opts.AddPolicy("pobrawl-elo", ctx => FixedWindow(ctx, permitLimit: 20));

            // Browser error reports: anonymous and outside the antiforgery scope, so this
            // limit is what stops the sink being used to fill the log. A page sends at most
            // ten per load, deduplicated.
            opts.AddPolicy("client-errors", ctx => FixedWindow(ctx, permitLimit: 20));

            // Game invites: each one is a write plus an outbound push to someone else's
            // device, so the recipient is the one who pays for a flood.
            opts.AddPolicy("invites", ctx => FixedWindow(ctx, permitLimit: 6));

            // QueueLimit = 0 everywhere, so a rejected caller has to guess how long to wait
            // and the client's retry handler deliberately does not replay a 429. Hand back
            // the window's remaining time as Retry-After so the UI can say "in 12s" rather
            // than fail blind. The metadata is only present on limiters that know their
            // replenishment schedule; absent it, say nothing rather than invent a number.
            opts.OnRejected = (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                {
                    context.HttpContext.Response.Headers.RetryAfter =
                        ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(
                            System.Globalization.CultureInfo.InvariantCulture);
                }

                return ValueTask.CompletedTask;
            };
        });

        return services;
    }

    /// <summary>One fixed one-minute window on the caller's compound partition key.</summary>
    private static RateLimitPartition<string> FixedWindow(HttpContext ctx, int permitLimit) =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: BuildPartitionKey(ctx),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                Window = TimeSpan.FromMinutes(1),
                PermitLimit = permitLimit,
                AutoReplenishment = true,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0,
            });

    /// <summary>
    /// Compound partition key: <c>{ip}|{identity-or-anon}</c>. An IP-only partition would let
    /// one attacker behind a corporate NAT — or one browser on a shared connection — saturate
    /// the bucket for every legitimate user behind that NAT, so the player id is appended to
    /// it. That id is the <c>oid</c> claim <c>UsePlayerIdentity</c> puts on the principal from
    /// the <c>X-Player-Id</c> header; <c>anon</c> when the caller carried none.
    /// </summary>
    private static string BuildPartitionKey(HttpContext ctx)
    {
        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var identity = ctx.User?.Identity?.IsAuthenticated == true
            ? (ctx.User.FindFirst("oid")?.Value
               ?? ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
               ?? ctx.User.Identity.Name
               ?? "auth")
            : "anon";
        return $"{ip}|{identity}";
    }
}
