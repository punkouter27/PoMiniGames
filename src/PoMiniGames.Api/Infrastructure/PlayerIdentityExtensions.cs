using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// The app's whole identity model: there is no sign-in. Each browser keeps a random player id
/// and the player's three initials, and sends them as the <c>X-Player-Id</c> and
/// <c>X-Player-Initials</c> headers (SignalR: the <c>playerId</c> and <c>initials</c> query
/// parameters). This middleware turns them into <see cref="HttpContext.User"/> and binds the
/// player id to an HttpOnly Data-Protection-signed cookie (<see cref="BindingCookieName"/>)
/// issued at antiforgery bootstrap so a caller cannot spoof another player's id.
/// </summary>
internal static partial class PlayerIdentityExtensions
{
    internal const string BindingCookieName = "PoMiniGames.PlayerBinding";
    internal const string BoundClaimType = "po:bound";
    internal const string SpoofedContextItem = "po:spoofed-identity";
    private const string ProtectorPurpose = "PoMiniGames.PlayerIdentity.v1";

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
            var boundId = TryReadBoundPlayerId(context);

            if (!string.IsNullOrWhiteSpace(rawId) && PlayerIdPattern().IsMatch(rawId.Trim()))
            {
                var playerId = rawId.Trim();
                if (boundId is not null && !string.Equals(playerId, boundId, StringComparison.Ordinal))
                {
                    // A caller holding a signed binding cookie attempted to present a different
                    // X-Player-Id / playerId. Refuse to authenticate the spoofed identity.
                    context.Items[SpoofedContextItem] = true;
                }
                else
                {
                    var claims = new List<Claim>
                    {
                        new("oid", playerId),
                        new(ClaimTypes.NameIdentifier, playerId),
                        new("name", initials),
                        new(ClaimTypes.Name, initials),
                    };
                    if (boundId is not null)
                    {
                        claims.Add(new Claim(BoundClaimType, "1"));
                    }
                    context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "ArcadeInitials"));
                }
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

    internal static void EnsureBindingCookie(HttpContext context, string playerId)
    {
        if (string.IsNullOrEmpty(playerId) || TryReadBoundPlayerId(context) is not null)
        {
            return;
        }

        var protector = context.RequestServices
            .GetService<IDataProtectionProvider>()
            ?.CreateProtector(ProtectorPurpose);
        if (protector is null)
        {
            return;
        }

        context.Response.Cookies.Append(BindingCookieName, protector.Protect(playerId), new CookieOptions
        {
            HttpOnly = true,
            IsEssential = true,
            Path = "/",
            SameSite = SameSiteMode.Lax,
            Secure = context.Request.IsHttps,
            MaxAge = TimeSpan.FromDays(365),
        });
    }

    private static string? TryReadBoundPlayerId(HttpContext context)
    {
        if (!context.Request.Cookies.TryGetValue(BindingCookieName, out var protectedValue)
            || string.IsNullOrEmpty(protectedValue))
        {
            return null;
        }

        var protector = context.RequestServices
            .GetService<IDataProtectionProvider>()
            ?.CreateProtector(ProtectorPurpose);
        if (protector is null)
        {
            return null;
        }

        try
        {
            var id = protector.Unprotect(protectedValue);
            return PlayerIdPattern().IsMatch(id) ? id : null;
        }
        catch
        {
            return null;
        }
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
