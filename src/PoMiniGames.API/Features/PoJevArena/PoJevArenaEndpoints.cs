using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoJevArena.Jev;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>
/// The PoJevArena server surface. Mapped on the authenticated <c>/api</c> group
/// (EndpointRouteExtensions), so every route is signed-in only (guests included) and every write
/// is inside the antiforgery scope. The browser owns physics and the Black Box; the server owns
/// only what must not be forged cheaply: the prompt text, the match rosters and the result gate.
/// Every match runs on the free local brain (<see cref="LocalJevClient"/>).
/// </summary>
public static class PoJevArenaEndpoints
{
    /// <summary>Largest decision batch: 20 units in 4 staggered slots is 5; 8 leaves slack.</summary>
    public const int MaxBatch = 8;

    public static IEndpointRouteBuilder MapPoJevArenaEndpoints(this IEndpointRouteBuilder app)
    {
        ReportJevMode(app.ServiceProvider);

        var group = app.MapGroup("/pojevarena").WithTags("PoJevArena");

        group.MapGet("/status", StatusAsync)
            .WithName("PoJevArenaStatus")
            .WithSummary("Whether the arena runs")
            .Produces<ArenaStatus>()
            .RequireRateLimiting("pojevarena");

        group.MapPost("/matches", RegisterMatchAsync)
            .WithName("PoJevArenaRegisterMatch")
            .WithSummary("Freeze two 10-creature rosters into a match and issue its id and seed")
            .Produces<ArenaMatchTicket>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        group.MapPost("/matches/{matchId}/decisions", DecideAsync)
            .WithName("PoJevArenaDecide")
            .WithSummary("Ask the local brain for 1-8 units' decisions; per-unit failures hold the unit's last intent")
            .Produces<ArenaDecideResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting("pojevarena-decide");

        group.MapPost("/matches/{matchId}/result", ReportResultAsync)
            .WithName("PoJevArenaReportResult")
            .WithSummary("Report a finished match once; updates each library creature's win/loss record")
            .Produces<ArenaResultReceipt>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        // ── Shared creature library ───────────────────────────────────────
        group.MapGet("/creatures", ListCreaturesAsync)
            .WithName("PoJevArenaListCreatures")
            .WithSummary("The public creature library (sort=new|used|winrate|rating, q=name filter)")
            .Produces<ArenaCreature[]>()
            .RequireRateLimiting("leaderboard-read");

        group.MapPost("/creatures", CreateCreatureAsync)
            .WithName("PoJevArenaCreateCreature")
            .WithSummary("Save a creature to the public library")
            .Produces<ArenaCreature>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        group.MapPut("/creatures/{id}", UpdateCreatureAsync)
            .WithName("PoJevArenaUpdateCreature")
            .WithSummary("Edit one of your own creatures")
            .Produces<ArenaCreature>()
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        group.MapDelete("/creatures/{id}", DeleteCreatureAsync)
            .WithName("PoJevArenaDeleteCreature")
            .WithSummary("Delete one of your own creatures")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("pojevarena");

        return app;
    }

    private static async Task<IResult> ListCreaturesAsync(
        HttpContext http, CreatureLibraryStore library, string? sort, string? q, CancellationToken ct)
    {
        var owner = Owner(http);
        var viewer = owner is null ? null : CreatureLibraryStore.OwnerKeyFor(owner.Value.UserId);
        // Null is a storage failure, reported as such so the page can say "offline" rather than
        // showing an outage as an empty library.
        var creatures = await library.ListAsync(viewer, sort, q, ct);
        return creatures is null ? LibraryOffline() : Results.Ok(creatures);
    }

    private static async Task<IResult> CreateCreatureAsync(
        ArenaCreatureDraft draft, HttpContext http, CreatureLibraryStore library, CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        var validation = PoJevArenaRules.Validate(draft);
        if (!validation.IsValid) return Invalid(validation.Error);

        var ownerName = DisplayNameSanitizer.Sanitize(owner.Value.DisplayName, fallback: "Player").Value;
        var (result, creature) = await library.CreateAsync(
            CreatureLibraryStore.OwnerKeyFor(owner.Value.UserId), ownerName, validation.Creature!, ct);
        return result switch
        {
            LibraryWrite.Ok => Results.Created($"/api/pojevarena/creatures/{creature!.Id}", creature),
            LibraryWrite.LimitReached => Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "library-limit",
                detail: $"You can keep {PoJevArenaRules.MaxCreaturesPerOwner} creatures; delete one to save another."),
            _ => LibraryOffline(),
        };
    }

    private static async Task<IResult> UpdateCreatureAsync(
        string id, ArenaCreatureDraft draft, HttpContext http, CreatureLibraryStore library, CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        var validation = PoJevArenaRules.Validate(draft);
        if (!validation.IsValid) return Invalid(validation.Error);

        var (result, creature) = await library.UpdateAsync(
            CreatureLibraryStore.OwnerKeyFor(owner.Value.UserId), id, validation.Creature!, ct);
        return WriteResult(result, () => Results.Ok(creature));
    }

    private static async Task<IResult> DeleteCreatureAsync(
        string id, HttpContext http, CreatureLibraryStore library, CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        var result = await library.DeleteAsync(CreatureLibraryStore.OwnerKeyFor(owner.Value.UserId), id, ct);
        return WriteResult(result, Results.NoContent);
    }

    private static async Task<IResult> ReportResultAsync(
        string matchId,
        ArenaMatchResult result,
        HttpContext http,
        ArenaMatchRegistry registry,
        TimeProvider clock,
        CreatureLibraryStore library,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        if (result.Winner is not ("blue" or "red" or "draw") || !double.IsFinite(result.DurationSeconds) || result.DurationSeconds < 0
            || result.Units is { Length: > PoJevArenaCatalog.TeamSize * 2 } || result.Mvp is < -1 or >= PoJevArenaCatalog.TeamSize * 2)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "result",
                detail: "Winner must be blue, red or draw, with at most one stats row per unit.");
        }

        var match = registry.Find(matchId, owner.Value.UserId);
        if (match is null)
        {
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "match-expired",
                detail: "This match is not live on the server any more, so its result cannot be recorded.");
        }

        switch (match.TryClaimResult(result.DurationSeconds, clock.GetUtcNow()))
        {
            case ArenaResultGate.AlreadyReported:
                return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "already-reported");
            case ArenaResultGate.TooFewDecisions:
                return Results.Problem(statusCode: StatusCodes.Status422UnprocessableEntity, title: "too-few-decisions",
                    detail: "This match did not make enough decisions for its length to count.");
            case ArenaResultGate.Implausible:
                return Results.Problem(statusCode: StatusCodes.Status422UnprocessableEntity, title: "implausible-result",
                    detail: "That result does not fit how long this match has been running.");
        }

        if (!await library.ApplyResultAsync(match.Roster.Blue, match.Roster.Red, result.Winner, result.Units, result.Mvp, ct))
        {
            // Hand the claim back: the write failed, so a retry must be able to land.
            match.ReleaseResultClaim();
            return LibraryOffline();
        }

        loggers.CreateLogger(typeof(PoJevArenaEndpoints)).MatchFinished(match.MatchId, result.Winner, match.Decisions);
        return Results.Ok(new ArenaResultReceipt(true));
    }

    private static IResult WriteResult(LibraryWrite result, Func<IResult> ok) => result switch
    {
        LibraryWrite.Ok => ok(),
        LibraryWrite.NotFound => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "creature-not-found"),
        LibraryWrite.Forbidden => Results.Problem(statusCode: StatusCodes.Status403Forbidden, title: "not-your-creature"),
        _ => LibraryOffline(),
    };

    private static IResult Invalid(string? error) =>
        Results.Problem(statusCode: StatusCodes.Status422UnprocessableEntity, title: error ?? "invalid",
            detail: "The creature breaks a library rule.");

    private static IResult LibraryOffline() =>
        Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "library-offline",
            detail: "The creature library is unreachable right now.");

    private static IResult StatusAsync(HttpContext http)
    {
        if (Owner(http) is null) return Results.Unauthorized();

        // The arena always runs: the local brain needs nothing.
        return Results.Ok(new ArenaStatus(true));
    }

    private static async Task<IResult> RegisterMatchAsync(
        ArenaMatchRequest request,
        HttpContext http,
        ArenaMatchRegistry registry,
        CreatureLibraryStore library,
        CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        if (request.BlueIds is not { Length: PoJevArenaCatalog.TeamSize }
            || request.RedIds is not { Length: PoJevArenaCatalog.TeamSize }
            || request.BlueIds.Concat(request.RedIds).Any(string.IsNullOrWhiteSpace))
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "roster-size",
                detail: $"Each team needs exactly {PoJevArenaCatalog.TeamSize} creatures.");
        }

        var libraryIds = request.BlueIds.Concat(request.RedIds)
            .Where(id => !id.StartsWith(PoJevArenaCatalog.PresetPrefix, StringComparison.Ordinal));
        var fromLibrary = await library.GetManyAsync(libraryIds, ct);
        if (fromLibrary is null) return LibraryOffline();

        var blue = Resolve(request.BlueIds, fromLibrary);
        var red = Resolve(request.RedIds, fromLibrary);
        if (blue is null || red is null)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "unknown-creature",
                detail: "A roster slot names a creature that does not exist.");
        }

        var match = registry.Register(owner.Value.UserId, new ArenaRoster(blue, red), request.Mode);
        return Results.Ok(new ArenaMatchTicket(match.MatchId, match.Seed, blue, red));
    }

    private static async Task<IResult> DecideAsync(
        string matchId,
        ArenaDecideRequest request,
        HttpContext http,
        IJevClient brain,
        ArenaMatchRegistry registry,
        CancellationToken ct)
    {
        var owner = Owner(http);
        if (owner is null) return Results.Unauthorized();

        var match = registry.Find(matchId, owner.Value.UserId);
        if (match is null)
        {
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "match-expired",
                detail: "This match is not live on the server any more; redeploy to start a new one.");
        }

        var units = request.Units ?? [];
        if (units.Length is 0 or > MaxBatch
            || units.Any(u => u is null || u.Unit is null)
            || units.Select(u => u.Unit).Distinct(StringComparer.Ordinal).Count() != units.Length)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "batch",
                detail: $"Send 1-{MaxBatch} distinct units per batch.");
        }

        // Validate and build every prompt first: a unit whose numbers are invalid never reaches the brain.
        var prompts = units.Select(u => (Unit: u, Built: JevPromptBuilder.Build(match.Roster, u))).ToArray();

        var decisions = await Task.WhenAll(prompts.Select(async p => p.Built.Prompt is null
            ? Failed(p.Unit.Unit, "invalid:" + p.Built.Error, 0)
            : ToDecision(p.Unit.Unit, await brain.EvaluateAsync(p.Built.Prompt, match.MatchId, "", ct))));
        match.RecordDecisions(decisions.Count(d => d.Ok));
        return Results.Ok(new ArenaDecideResponse(decisions));
    }

    /// <summary>Presets from the catalog, everything else from the library snapshot; null if any id is unknown.</summary>
    private static ArenaCreature[]? Resolve(string[] ids, Dictionary<string, ArenaCreature> fromLibrary)
    {
        var resolved = new ArenaCreature[ids.Length];
        for (var i = 0; i < ids.Length; i++)
        {
            var creature = PoJevArenaCatalog.FindPreset(ids[i]) ?? fromLibrary.GetValueOrDefault(ids[i] ?? "");
            if (creature is null) return null;
            resolved[i] = creature;
        }
        return resolved;
    }

    private static ArenaUnitDecision ToDecision(string unit, JevOutcome outcome)
    {
        if (!outcome.Ok || outcome.Answers is not { } a) return Failed(unit, outcome.Failure ?? "unknown", outcome.LatencyMs);

        return new ArenaUnitDecision(
            unit, true, null,
            a.Action, a.ActionConfidence, a.ActionProbabilities,
            a.Focus, a.FocusConfidence, a.FocusProbabilities,
            a.Panic, outcome.LatencyMs);
    }

    private static ArenaUnitDecision Failed(string unit, string failure, int latencyMs) =>
        new(unit, false, failure, null, 0, null, null, 0, null, 0, latencyMs);


    /// <summary>The caller's stable identity, or null when there is nothing to bind a match to.</summary>
    private static RequestIdentity.Identity? Owner(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        if (!string.IsNullOrEmpty(identity.UserId)) return identity;
        // Same fallback as the PoEcosystem slice: a cookie session without a stable id partitions by name.
        return string.IsNullOrEmpty(identity.DisplayName) ? null : identity with { UserId = "name:" + identity.DisplayName };
    }

    private static void ReportJevMode(IServiceProvider services)
    {
        var options = services.GetRequiredService<IOptions<JevOptions>>().Value;
        var environment = services.GetRequiredService<IHostEnvironment>();
        var logger = services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(PoJevArenaEndpoints));

        if (options.UseStub && environment.IsEnvironment("Test")) logger.JevStubEnabled(environment.EnvironmentName);
    }
}
