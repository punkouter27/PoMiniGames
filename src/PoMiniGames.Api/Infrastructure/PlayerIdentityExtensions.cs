using System.Security.Claims;
using System.Text.RegularExpressions;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// The app's whole identity model: there is no sign-in. Each browser keeps a random player id
/// and the player's three initials, and sends them as the <c>X-Player-Id</c> and
/// <c>X-Player-Initials</c> headers (SignalR: the <c>playerId</c> and <c>initials</c> query
/// parameters). This middleware turns them into <see cref="HttpContext.User"/> so every slice
/// reads the caller through <c>RequestIdentity</c>. The id is a handle, not a credential: it
/// separates one browser's rows from another's and proves nothing about who is holding it.
/// </summary>
internal static partial class PlayerIdentityExtensions
{
    [GeneratedRegex("^[a-zA-Z0-9_-]{1,64}$", RegexOptions.Compiled)]
    private static partial Regex PlayerIdPattern();

    public static IApplicationBuilder UsePlayerIdentity(this IApplicationBuilder app)
    {
        return app.Use(async (context, next) =>
        {
            var rawId = context.Request.Headers["X-Player-Id"].FirstOrDefault()
                        ?? context.Request.Query["playerId"].FirstOrDefault();

            var rawInitials = context.Request.Headers["X-Player-Initials"].FirstOrDefault()
                              ?? context.Request.Query["initials"].FirstOrDefault();

            var initials = NormalizeInitials(rawInitials);

            if (!string.IsNullOrWhiteSpace(rawId) && PlayerIdPattern().IsMatch(rawId.Trim()))
            {
                var playerId = rawId.Trim();
                var claims = new List<Claim>
                {
                    new("oid", playerId),
                    new(ClaimTypes.NameIdentifier, playerId),
                    new("name", initials),
                    new(ClaimTypes.Name, initials),
                };
                context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "ArcadeInitials"));
            }
            else if (rawInitials is not null)
            {
                var claims = new List<Claim>
                {
                    new("name", initials),
                    new(ClaimTypes.Name, initials),
                };
                context.User = new ClaimsPrincipal(new ClaimsIdentity(claims));
            }

            await next(context);
        });
    }

    internal static string NormalizeInitials(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return "   ";
        }

        Span<char> buffer = stackalloc char[3];
        var count = 0;
        foreach (var ch in raw)
        {
            if (ch is >= 'a' and <= 'z')
            {
                buffer[count++] = (char)(ch - 'a' + 'A');
            }
            else if (ch is >= 'A' and <= 'Z')
            {
                buffer[count++] = ch;
            }

            if (count == 3)
            {
                break;
            }
        }

        return count == 3 ? new string(buffer) : "   ";
    }
}
