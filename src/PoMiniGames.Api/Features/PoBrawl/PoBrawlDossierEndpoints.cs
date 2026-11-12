using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// <c>GET /api/pobrawl/dossier</c>: every fighter's dossier card in one call. Anonymous, like the
/// leaderboard reads — it is public reference text, and the fighter select is browsable before
/// sign-in. Always 200: Wikipedia trouble degrades to the static facts.
/// </summary>
public static class PoBrawlDossierEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlDossierEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/pobrawl/dossier",
            async (PoBrawlDossierService dossiers, HttpContext http, CancellationToken cancellationToken) =>
            {
                var list = await dossiers.GetAllAsync(cancellationToken);
                // The list changes at most daily; let the browser and the PWA reuse it for an hour.
                // Static facts served because Wikipedia was slow get five minutes, so the enriched
                // copy the background refresh is filling reaches the page soon after.
                http.Response.Headers.CacheControl = list.Any(d => d.FromWikipedia) ? "public, max-age=3600" : "public, max-age=300";
                return Results.Ok(list);
            })
            .WithTags("PoBrawl")
            .WithName("GetPoBrawlDossiers")
            .WithSummary("PoBrawl fighter dossiers (static facts + Wikipedia summary)")
            .Produces<IReadOnlyList<PoBrawlDossierDto>>(StatusCodes.Status200OK)
            .AllowAnonymous();

        return app;
    }
}
