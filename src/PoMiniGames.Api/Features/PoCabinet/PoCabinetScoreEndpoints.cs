using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// PoCabinet's score endpoint: authenticated best-lap submissions guarded by the
/// <c>pocabinet</c> rate-limit policy. There is no read of
/// the stored laps: the app has no Cabinet board.
///
/// <para>
/// <b>Every stored lap and place is server-computed.</b> A solo submission carries its
/// input log and <see cref="PoCabinetLapVerifier"/> re-runs the race; a multiplayer one is
/// looked up from the result the server's own sim produced
/// (<see cref="PoCabinetRaceRegistry.PeekVerifiedLapAsync"/>, spent only after the save). The claimed
/// <see cref="PoCabinetScoreDto.BestLapSeconds"/> is only compared and logged, and a claimed
/// place better than the server's is ignored. A submission with neither proof is refused with
/// 422, which the client treats as final (not parked).
/// </para>
/// <para>
/// <b>Cheap checks first.</b> Shape (track, game code, input-log length) and the play-session
/// preflight run before a replay; replays run a couple at a time (503 + <c>Retry-After</c> when
/// the slots stay busy), so a burst of submits cannot starve the race timer's thread pool.
/// </para>
/// </summary>
public static class PoCabinetScoreEndpoints
{
    public static void MapPoCabinetScoreEndpoints(this IEndpointRouteBuilder app)
    {
        // Mounted under gameApi (which has the /api prefix and requires authorization) — the
        // path is RELATIVE. Authenticated writes, bounded by pocabinet (10/min, same shape as highscores).
        app.MapPost("/pocabinet/scores", PostScoreAsync)
            .RequireRateLimiting("pocabinet");
    }

    private static async Task<IResult> PostScoreAsync(
        [FromBody] PoCabinetScoreDto dto,
        HttpContext http,
        StorageService storage,
        PoCabinetRaceRegistry races,
        ScoreIntegrityGuard integrity,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (!double.IsFinite(dto.BestLapSeconds) || dto.BestLapSeconds is <= 0 or > 3600)
            errors[nameof(dto.BestLapSeconds)] = ["Best lap must be between 0 and 3600 seconds."];
        if (dto.FinalPosition is < 1 or > PoCabinetCatalog.SoloCarCount)
            errors[nameof(dto.FinalPosition)] = [$"Final position must be between 1 and {PoCabinetCatalog.SoloCarCount}."];
        if (!PoCabinetCatalog.IsKnownTrack(dto.TrackId))
            errors[nameof(dto.TrackId)] = ["Choose a supported track."];
        if (!IsValidGameCode(dto.GameCode))
            errors[nameof(dto.GameCode)] = [$"Game code must be at most {MaxGameCodeLength} letters, digits, '-' or '_'."];
        if (dto.Inputs is { Length: > MaxInputsChars })
            errors[nameof(dto.Inputs)] = ["Input log is too long."];
        if (errors.Count > 0)
            return Results.ValidationProblem(errors);

        // Cheap before expensive: a submission that cannot pass the play-session check is
        // refused before a replay is spent on it (Inspect below still runs, and logs, once).
        var preflight = integrity.Preflight(http, GameKey.PoCabinet);
        if (!preflight.Allowed) return preflight.ToProblem();

        var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);
        var log = loggerFactory.CreateLogger("PoCabinetScores");
        var trackId = ResolveTrack(dto.TrackId);

        double verifiedLap;
        int verifiedPlace;
        PoCabinetRaceRegistry.VerifiedLap? onlineLap = null;
        if (!string.IsNullOrEmpty(dto.Inputs))
        {
            var inputs = PoCabinetLapVerifier.Decode(dto.Inputs);
            if (inputs is null)
                return Results.ValidationProblem(new Dictionary<string, string[]> { [nameof(dto.Inputs)] = ["Malformed input log."] });
            // A replay is up to eight minutes of a 100-car race, run synchronously. Only a few
            // at once, so a burst of submits cannot starve the thread pool the 30 Hz race
            // timer ticks on; a submit that cannot get a slot soon is told to retry (503).
            if (!await ReplaySlots.WaitAsync(ReplayQueueTimeout, ct))
            {
                log.LogWarning("PoCabinet score deferred: replay slots busy user={UserId}", userId);
                http.Response.Headers.RetryAfter = "5";
                return Results.Problem("The lap checker is busy. Please retry.", statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            try
            {
                (verifiedLap, verifiedPlace) = PoCabinetLapVerifier.Replay(trackId, dto.Wet, inputs);
            }
            finally
            {
                ReplaySlots.Release();
            }
        }
        else
        {
            // Read, not spent: the lap is forgotten only once the score below is stored, so a
            // failed save (503, parked by the client and retried) still finds it next time.
            onlineLap = await races.PeekVerifiedLapAsync(userId, ct);
            verifiedLap = onlineLap is not null && onlineLap.TrackId == trackId ? onlineLap.BestLapSeconds : -1;
            verifiedPlace = onlineLap?.Position ?? 0;
        }
        // The worse of the claim and the replay: the race after the log ends (a wreck, the field
        // still finishing) can only cost places, and a claim can never buy one.
        var place = Math.Max(dto.FinalPosition, verifiedPlace);
        if (verifiedLap <= 0)
        {
            log.LogWarning("PoCabinet score refused: unverifiable lap user={UserId} track={Track} claimed={T}s",
                userId, trackId, dto.BestLapSeconds);
            return Results.Problem("This lap could not be verified.", statusCode: StatusCodes.Status422UnprocessableEntity);
        }
        verifiedLap = Math.Round(verifiedLap, 3);
        // JS and .NET trig differ in the last ulp, so a small gap is honest drift; a big one is
        // a forged claim or a physics copy that has fallen out of step — either is worth seeing.
        if (Math.Abs(verifiedLap - dto.BestLapSeconds) > 0.05)
        {
            log.LogWarning("PoCabinet lap mismatch user={UserId} track={Track} claimed={Claimed}s verified={Verified}s",
                userId, trackId, dto.BestLapSeconds, verifiedLap);
        }

        var verdict = integrity.Inspect(http, GameKey.PoCabinet, verifiedLap);
        if (!verdict.Allowed) return verdict.ToProblem();

        log.LogInformation(
            "PoCabinet score POST user={UserId} guest={Guest} track={Track} t={T}s pos={Pos}",
            userId, isGuest, trackId, verifiedLap, place);

        PoCabinetHighScore saved;
        try
        {
            saved = await storage.SavePoCabinetHighScoreAsync(new PoCabinetHighScore
            {
                PlayerName = integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                UserId = userId,
                TrackId = trackId,
                BestLapSeconds = verifiedLap,
                FinalPosition = place,
                IsGuest = isGuest,
                Date = (dto.AchievedAtUtc == default ? DateTimeOffset.UtcNow : dto.AchievedAtUtc)
                    .ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture),
                GameCode = dto.GameCode ?? "",
            });
        }
        catch (IOException)
        {
            return Results.Problem(
                "Best lap could not be stored. Please retry.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        // Stored: now the online proof is spent, so the same lap cannot be posted twice.
        if (onlineLap is not null && verifiedLap > 0) await races.ForgetVerifiedLapAsync(userId, onlineLap);

        return Results.Created("/api/pocabinet/scores", new PoCabinetScoreDto
        {
            PlayerDisplayName = saved.PlayerName,
            UserId = saved.UserId,
            TrackId = saved.TrackId,
            BestLapSeconds = saved.BestLapSeconds,
            FinalPosition = saved.FinalPosition,
            AchievedAtUtc = DateTimeOffset.TryParse(saved.Date, out var d) ? d : DateTimeOffset.UtcNow,
            IsGuest = saved.IsGuest,
            GameCode = saved.GameCode,
        });
    }

    /// <summary>Longest accepted <see cref="PoCabinetScoreDto.GameCode"/> (race codes are 8 hex characters; "SOLO" offline).</summary>
    private const int MaxGameCodeLength = 32;

    /// <summary>
    /// Longest accepted input log: base64 of the verifier's eight minutes of six-byte ticks
    /// (the same cap <see cref="PoCabinetLapVerifier.Decode"/> applies), checked here before
    /// anything is decoded.
    /// </summary>
    private const int MaxInputsChars = (30 * 60 * 8 * 6 + 2) / 3 * 4;

    /// <summary>Lap replays allowed at once on this host. Each is CPU-bound and synchronous.</summary>
    private static readonly SemaphoreSlim ReplaySlots = new(Math.Clamp(Environment.ProcessorCount / 2, 1, 2));

    /// <summary>How long a submit waits for a replay slot before it is told to retry.</summary>
    private static readonly TimeSpan ReplayQueueTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Empty, or a short code of letters, digits, '-' and '_' (it is stored as-is).</summary>
    private static bool IsValidGameCode(string? code) =>
        string.IsNullOrEmpty(code)
        || (code.Length <= MaxGameCodeLength && code.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'));

    /// <summary>Normalise unknown / null / casing to the canonical default track id.</summary>
    private static string ResolveTrack(string? track)
    {
        if (string.IsNullOrWhiteSpace(track)) return PoCabinetCatalog.DefaultTrackId;
        var trimmed = track.Trim().ToLowerInvariant();
        return PoCabinetCatalog.IsKnownTrack(trimmed) ? trimmed : PoCabinetCatalog.DefaultTrackId;
    }
}

/// <summary>
/// Inbound score payload from the client. <see cref="TrackId"/> accepts any
/// casing; the server normalises to the canonical lower-case id before saving.
/// </summary>
public sealed class PoCabinetScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    /// <summary>Server-populated from auth cookie. Empty/zero on submit → server fills.</summary>
    public string UserId { get; set; } = "";
    public string TrackId { get; set; } = "capitol";
    public double BestLapSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
    /// <summary>Solo proof: base64 input log (see <see cref="PoCabinetLapVerifier.Decode"/>).
    /// Empty for a multiplayer race, whose laps the server already simulated.</summary>
    public string? Inputs { get; set; }
    /// <summary>Solo proof: the race ran in rain (grip <see cref="PoCabinetLapVerifier.WetGrip"/>).</summary>
    public bool Wet { get; set; }
}
