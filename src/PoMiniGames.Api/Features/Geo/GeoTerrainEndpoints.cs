using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Geo;

/// <summary>Configuration for optional real-world terrain elevation queries (Open-Elevation).</summary>
public sealed class GeoTerrainOptions
{
    public const string SectionName = "PoMiniGames:Geo";

    /// <summary>Disabled in hermetic test hosts; falls back to synthetic elevation when off or unreachable.</summary>
    public bool FetchTerrain { get; set; } = true;
}

/// <summary>
/// Cached real-world terrain heightmap proxy (<c>GET /api/geo/terrain?lat=&amp;lon=</c>).
/// Samples an 8x8 grid via Open-Elevation (cached 24h per rounded coordinate) so PoEcosystem
/// and PoMarbleRace can generate islands/courses from real-world geography.
/// </summary>
public static class GeoTerrainEndpoints
{
    public const string HttpClientName = "Geo.Elevation";
    private const int GridSize = 8;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(24);
    private static readonly ConcurrentDictionary<string, (DateTimeOffset At, double[] Elevations)> Cache = new();

    public static IEndpointRouteBuilder MapGeoTerrainEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/geo/terrain", async (
            double lat,
            double lon,
            IHttpClientFactory httpFactory,
            IOptionsMonitor<GeoTerrainOptions> options,
            TimeProvider timeProvider,
            CancellationToken ct) =>
        {
            if (lat is < -85 or > 85 || lon is < -180 or > 180 || double.IsNaN(lat) || double.IsNaN(lon))
                return Results.BadRequest(new { error = "Invalid coordinates." });

            var rLat = Math.Round(lat, 2);
            var rLon = Math.Round(lon, 2);
            var key = $"{rLat.ToString("F2", CultureInfo.InvariantCulture)},{rLon.ToString("F2", CultureInfo.InvariantCulture)}";
            var now = timeProvider.GetUtcNow();

            if (Cache.TryGetValue(key, out var hit) && now - hit.At < CacheTtl)
                return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "cache", elevations = hit.Elevations });

            if (!options.CurrentValue.FetchTerrain)
                return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "synthetic", elevations = SyntheticGrid(rLat, rLon) });

            try
            {
                const double span = 0.04;
                var locs = new List<string>(GridSize * GridSize);
                for (var r = 0; r < GridSize; r++)
                {
                    for (var c = 0; c < GridSize; c++)
                    {
                        var la = rLat + ((r / (double)(GridSize - 1)) - 0.5) * span;
                        var lo = rLon + ((c / (double)(GridSize - 1)) - 0.5) * span;
                        locs.Add($"{la.ToString("F4", CultureInfo.InvariantCulture)},{lo.ToString("F4", CultureInfo.InvariantCulture)}");
                    }
                }

                var client = httpFactory.CreateClient(HttpClientName);
                using var resp = await client.GetAsync($"api/v1/lookup?locations={string.Join('|', locs)}", ct);
                if (!resp.IsSuccessStatusCode)
                    return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "synthetic", elevations = SyntheticGrid(rLat, rLon) });

                using var doc = await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.GetArrayLength() != GridSize * GridSize)
                    return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "synthetic", elevations = SyntheticGrid(rLat, rLon) });

                var heights = new double[GridSize * GridSize];
                var idx = 0;
                foreach (var pt in results.EnumerateArray())
                    heights[idx++] = pt.TryGetProperty("elevation", out var el) ? el.GetDouble() : 0;

                Cache[key] = (now, heights);
                return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "open-elevation", elevations = heights });
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return Results.Ok(new { lat = rLat, lon = rLon, size = GridSize, source = "synthetic", elevations = SyntheticGrid(rLat, rLon) });
            }
        })
        .WithTags("Geo")
        .WithName("GetGeoTerrain")
        .AllowAnonymous();

        return app;
    }

    private static double[] SyntheticGrid(double lat, double lon)
    {
        var heights = new double[GridSize * GridSize];
        for (var r = 0; r < GridSize; r++)
        {
            for (var c = 0; c < GridSize; c++)
            {
                var u = (r + 0.5) / GridSize;
                var v = (c + 0.5) / GridSize;
                heights[r * GridSize + c] = Math.Round(40 + 35 * Math.Sin(u * Math.PI + lat) * Math.Cos(v * Math.PI + lon), 1);
            }
        }
        return heights;
    }
}
