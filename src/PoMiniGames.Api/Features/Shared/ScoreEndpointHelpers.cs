using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.Shared;

/// <summary>
/// Shared score-submission plumbing across game slices: integrity inspection, server-canonical
/// display name resolution, and 503 mapping on storage failure.
/// </summary>
internal static class ScoreEndpointHelpers
{
    public static (RequestIdentity.Identity Identity, string DisplayName) ResolvePlayer(
        HttpContext http,
        ScoreIntegrityGuard integrity,
        string authenticatedFallback = "Player",
        string guestFallback = "Guest")
    {
        var identity = RequestIdentity.Resolve(http.User);
        var fallback = identity.IsAuthenticated ? authenticatedFallback : guestFallback;
        var name = integrity.ResolveDisplayName(identity.DisplayName, fallback);
        return (identity, name);
    }

    public static IResult? InspectOrProblem(
        HttpContext http,
        ScoreIntegrityGuard integrity,
        GameKey game,
        double score,
        out string? failureCode)
    {
        var verdict = integrity.Inspect(http, game, score);
        if (verdict.Allowed)
        {
            failureCode = null;
            return null;
        }

        failureCode = verdict.Code ?? "integrity";
        return verdict.ToProblem();
    }

    public static async Task<(T? Saved, IResult? Error)> TrySaveAsync<T>(
        Func<Task<T>> save,
        string unavailableMessage = "Score could not be stored. Please retry.")
        where T : class
    {
        try
        {
            return (await save(), null);
        }
        catch (IOException)
        {
            return (null, Results.Problem(unavailableMessage, statusCode: StatusCodes.Status503ServiceUnavailable));
        }
    }
}
