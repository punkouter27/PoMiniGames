using System.Security.Claims;
using System.Text.RegularExpressions;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Populates <see cref="HttpContext.User"/> from the lightweight retro-arcade
/// player headers (<c>X-Player-Id</c>, <c>X-Player-Initials</c>) or SignalR query
/// parameters (<c>playerId</c>, <c>initials</c>) without OAuth or cookies.
/// </summary>
internal static partial class AuthExtensions
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
