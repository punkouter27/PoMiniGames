using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// Pins the anonymous surface. There is no fallback authorization policy here: the /api group and
/// the hubs opt in with RequireAuthorization, so an endpoint mapped outside them is public by
/// default and nothing else would notice.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public sealed class RoutingContractApiTests(PoMiniGamesE2EFixture factory)
{
    // Every route a signed-out caller may reach. A new public route fails this test until it is
    // added here on purpose. Static files and the Blazor host itself are public by design and
    // are identified by their metadata, not listed. The host runs as Test, so the routes only
    // that environment maps are listed too, and the Development-only ones (/api/logs/tail, an
    // anonymous /api/diag/ai) are not. /api/diag stays public: a masked, presence-only snapshot.
    private static readonly string[] AnonymousAllowList =
    [
        "/api/auth/antiforgery-token",
        "/api/auth/dev-login",
        "/api/auth/dev-logout",
        "/api/auth/handshake",
        "/api/diag/",
        "/api/ecosystem/gallery",
        "/api/ecosystem/gallery/{code}/data",
        "/api/health/",
        "/api/health/ping",
        "/api/leaderboards/",
        "/api/leaderboards/{game}",
        "/api/player/card/",
        "/api/player/card/svg",
        "/api/pobrawl/dossier",
        "/api/povoxelstrike/assets",
        "/api/povoxelstrike/assets/{hash}",
        "/api/{*rest:nonfile}",
        "/auth/login/fake",
        "/auth/login/microsoft",
        "/client-errors",
        "/health",
        "/health/live",
        "/openapi/{documentName}.json",
        "/scalar/favicon.svg",
        "/scalar/scalar.aspnetcore.js",
        "/scalar/scalar.js",
        "/scalar/{documentName?}",
        "/{*path:nonfile}",
    ];

    [Fact]
    public void Anonymous_surface_is_exactly_the_allow_list()
    {
        // Anonymous = no authorize metadata at all, or an explicit AllowAnonymous (which wins).
        var anonymous = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.Metadata.GetMetadata<IAllowAnonymous>() is not null || e.Metadata.GetMetadata<IAuthorizeData>() is null)
            .Where(e => !IsHostOrStaticAsset(e))
            .Select(e => "/" + e.RoutePattern.RawText!.TrimStart('/'))
            .Distinct()
            .Order(StringComparer.Ordinal);

        anonymous.Should().Equal(AnonymousAllowList);
    }

    private static bool IsHostOrStaticAsset(RouteEndpoint endpoint) =>
        endpoint.RoutePattern.RawText!.TrimStart('/').StartsWith("_framework", StringComparison.Ordinal)
        || endpoint.Metadata.Any(m => m.GetType().Name is "StaticAssetDescriptor" or "ComponentTypeMetadata" or "RootComponentMetadata");
}
