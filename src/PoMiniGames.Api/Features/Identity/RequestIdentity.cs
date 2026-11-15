using System.Security.Claims;

namespace PoMiniGames.Features.Identity;

/// <summary>
/// Reads the caller's identity from the claims <c>UsePlayerIdentity</c> built out of the
/// player-id and initials headers, so leaderboard and match-history writes take the name and
/// owner from one place instead of from each request body. One helper, so every slice
/// classifies the caller the same way.
/// </summary>
/// <remarks>
/// The id claim is <c>oid</c> (also written as <c>nameidentifier</c>) and the display name is
/// <c>name</c>: the three initials, or three spaces when the player skipped the prompt. The
/// claim names are the ones the storage rows were first written under, kept so existing rows
/// still match their player. <c>sub</c> and <c>preferred_username</c> are read as fallbacks for
/// the same reason and are never issued today.
/// </remarks>
public static class RequestIdentity
{
    /// <param name="UserId">Stable id from the claims, or empty for a truly-anonymous caller.</param>
    /// <param name="DisplayName">Human-facing name from the claims, or empty when none is present.</param>
    /// <param name="IsGuest">True when the request carried no valid player id.</param>
    /// <param name="IsAuthenticated">True when a player id is present: the case where the server
    /// overrides any client-supplied name/owner with the claim value. It means "identified",
    /// not "proven": there is no sign-in to prove anything.</param>
    public readonly record struct Identity(string UserId, string DisplayName, bool IsGuest, bool IsAuthenticated);

    public static Identity Resolve(ClaimsPrincipal? user)
    {
        var userId = user?.FindFirstValue("oid")
                     ?? user?.FindFirstValue(ClaimTypes.NameIdentifier)
                     ?? user?.FindFirstValue("sub")
                     ?? "";
        var displayName = user?.FindFirstValue("name")
                          ?? user?.FindFirstValue("preferred_username")
                          ?? user?.Identity?.Name
                          ?? "";
        var isGuest = string.IsNullOrEmpty(userId) || (user?.IsInRole("guest") ?? true);
        // "Authenticated" here means identified: the request carried a player id.
        var isAuthenticated = !string.IsNullOrEmpty(userId) && !isGuest;
        return new Identity(userId, displayName, isGuest, isAuthenticated);
    }
}
