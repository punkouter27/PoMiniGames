using System.Security.Claims;

namespace PoMiniGames.Features.Auth;

public sealed record AuthenticatedUser(string UserId, string DisplayName, string? Email)
{
    public static bool TryCreate(ClaimsPrincipal? principal, out AuthenticatedUser? user)
    {
        user = null;

        if (principal?.Identity?.IsAuthenticated != true)
        {
            return false;
        }

        var userId = principal.FindFirstValue("oid")
            ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? principal.FindFirstValue("sub");

        if (string.IsNullOrWhiteSpace(userId))
        {
            return false;
        }

        var displayName = principal.FindFirstValue("name")
            ?? principal.FindFirstValue(ClaimTypes.Name)
            ?? principal.Identity.Name
            ?? principal.FindFirstValue("preferred_username")
            ?? "Player";

        var email = principal.FindFirstValue("preferred_username")
            ?? principal.FindFirstValue(ClaimTypes.Email);

        user = new AuthenticatedUser(userId, displayName, email);
        return true;
    }
}
