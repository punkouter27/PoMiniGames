using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.PoBrawl;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Serialization;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Features.Health;

/// <summary>
/// <c>GET /api/diag</c>: the data behind the /diag "System status" page (Features/Health/DiagPage.razor), in the
/// Po web standard shape (<see cref="DiagReportDto"/>, AGENTS.md).
/// </summary>
/// <remarks>
/// Always on and anonymous, and safe to be: one row per dependency (the API itself and its multiplayer hubs, the
/// storage health checks, the tables and blob containers, and the live service probes in DiagLiveProbes), each
/// with plain words, a status and a latency; a service switched off on purpose reads "Off". Never a connection string, key, URI, path, id or exception message (an
/// exception TYPE name at most). DiagProjectionTests and HealthEndpointTests pin that.
/// </remarks>
public static class DiagEndpoints
{
    private const int MaxLogFileBytes = 512 * 1024;       // 512 KB upper bound on a log-tail response.
    private const int MaxTailLines = 500;                  // Cap rows per call to keep the response bounded.

    /// <summary>Registered health check name → section, label and purpose. Unknown checks land in Services.</summary>
    private static readonly Dictionary<string, (string Group, string Label, string Purpose)> CheckNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Storage"] = ("data", "Scores and leaderboards", "Azure Table Storage: high scores, ladders, ratings and player stats."),
        ["AzureTableStorage"] = ("data", "Table storage connection", "A direct round trip to Azure Table Storage, the store every board reads."),
    };

    /// <summary>
    /// The build version, UTC yyMMdd: the one <c>BuildVersion</c> assembly metadata key (PoBuildStamp in
    /// Directory.Build.props), the same value the client shows as <c>.po-version</c>.
    /// </summary>
    internal static string BuildVersion => PoPlatform.Version;

    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        var isDevelopment = app.ServiceProvider.GetRequiredService<IWebHostEnvironment>().IsDevelopment();

        async Task<IResult> diagHandler(HttpContext http, HealthSnapshotCache cache, CancellationToken ct)
        {
            var snapshot = await cache.GetAsync(_ => BuildSnapshotAsync(http.RequestServices, SelfUri(http.Request)), ct);
            return Results.Json(snapshot.Diag, DiagJsonContext.Default.DiagReportDto);
        }

        app.MapGet("/api/diag", diagHandler)
            .WithTags("Health")
            .WithName("GetDiagnostics")
            .WithSummary("Plain status of the API, its data and its services, for the /diag page (no secrets)")
            .Produces<DiagReportDto>(StatusCodes.Status200OK)
            .AllowAnonymous();

        // ─── Log tail endpoint for dev diagnostics ───────────────────────
        // Serilog's File sink acquires an exclusive handle
        // on the log file by default. Reading via `File.ReadAllLines` would throw
        // "The process cannot access the file …". We open with FileShare.ReadWrite
        // (and a tight 512 KB byte budget) so the tail endpoint can serve the rolling
        // log without taking a competing lock.
        async Task<IResult> logsTailHandler(IConfiguration config, IWebHostEnvironment environment, int? lines = 50)
        {
            var diagnosticsEnabled = config.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
                return Results.NotFound();

            try
            {
                var logsDir = Path.Combine(environment.ContentRootPath, "logs");
                if (!Directory.Exists(logsDir))
                    return Results.Ok(new { message = "No logs directory found", entries = Array.Empty<string>() });

                var latestLog = Directory.GetFiles(logsDir, "*.log")
                    .OrderByDescending(f => File.GetLastWriteTime(f))
                    .FirstOrDefault();

                if (latestLog == null)
                    return Results.Ok(new { message = "No log files found", entries = Array.Empty<string>() });

                var lineCount = Math.Clamp(lines ?? 50, 1, MaxTailLines);

                // Use FileStream with FileShare.ReadWrite so we can read while Serilog
                // is also writing to the file. Read from the end to stay within the
                // byte cap on large files.
                string[] entries;
                int totalLines;
                using (var fs = new FileStream(latestLog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length > MaxLogFileBytes)
                    {
                        fs.Seek(-MaxLogFileBytes, SeekOrigin.End);
                        // Skip the first (likely partial) line so we don't return a
                        // truncated row at the top of the tail.
                        var discard = new byte[1];
                        while (fs.Read(discard, 0, 1) == 1 && discard[0] != (byte)'\n') { }
                    }
                    using var sr = new StreamReader(fs);
                    var content = sr.ReadToEnd();
                    entries = content.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                                     .Select(l => l.TrimEnd('\r'))
                                     .TakeLast(lineCount)
                                     .ToArray();
                    totalLines = content.Count(c => c == '\n') + 1;
                }

                return Results.Ok(new
                {
                    file = Path.GetFileName(latestLog),
                    totalLines,
                    shownLines = entries.Length,
                    entries
                });
            }
            catch (FileNotFoundException)
            {
                // Serilog's rolling sink may have moved the file out from under us.
                return Results.Ok(new { message = "Log file rolled during read; retry." });
            }
            catch (IOException ex)
            {
                return Results.Ok(new { error = ex.Message, hint = "File is locked by another process; open with FileShare.ReadWrite." });
            }
            catch (Exception ex)
            {
                return Results.Ok(new { error = ex.Message });
            }
        }

        // Raw log tails are dev-only: unlike /api/diag (masked projection) this streams
        // unmasked log content, so outside Development the route is not mapped at all.
        if (!isDevelopment)
            return app;

        // The log-tail surface gets its own /api/logs group (distinct prefix from
        // /api/diag) so every route is registered via a group rather than a scattered
        // app.MapGet.
        var logs = app.MapGroup("/api/logs").WithTags("Health");
        logs.MapGet("/tail", logsTailHandler)
        .WithName("GetLogsTail")
        .WithSummary("Tail the latest development log file (dev-only)");

        return app;
    }

    /// <summary>This server's own base address (the hubs row negotiates against it).</summary>
    internal static Uri? SelfUri(HttpRequest request) =>
        Uri.TryCreate($"{request.Scheme}://{request.Host}{request.PathBase}/", UriKind.Absolute, out var u) ? u : null;

    /// <summary>
    /// One full health run: the registered checks, the storage listings and the live service probes, in parallel,
    /// each under its own timeout. <see cref="HealthSnapshotCache"/> holds the result for 60 s, and /health,
    /// /api/health and /api/diag all read that one snapshot.
    /// </summary>
    internal static async Task<HealthSnapshot> BuildSnapshotAsync(IServiceProvider services, Uri? self)
    {
        var ct = CancellationToken.None;
        var started = Stopwatch.GetTimestamp();
        var health = services.GetRequiredService<HealthCheckService>();
        var live = services.GetRequiredService<DiagLiveProbes>();
        var healthTask = health.CheckHealthAsync(ct);
        var storageTask = ProbeStorageAsync(services.GetRequiredService<TableServiceClient>(), services.GetRequiredService<BlobServiceClient>(), ct);
        var hubsTask = live.HubsAsync(self, ListHubs(services.GetRequiredService<EndpointDataSource>()), ct);
        var vaultTask = live.KeyVaultAsync(ct);
        var insightsTask = live.AppInsightsAsync(ct);
        var wikiTask = live.WikipediaAsync(ct);
        var pushTask = live.PushKeysAsync(ct);
        var report = await healthTask;
        var probe = await storageTask;
        DiagCheckDto[] rows = [await hubsTask, await vaultTask, await insightsTask, await pushTask, await wikiTask];
        var diag = BuildReport(report, services.GetRequiredService<IWebHostEnvironment>(), probe, rows, Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        return new HealthSnapshot(report, diag);
    }

    /// <summary>Names of the tables and containers the storage account listed (null when it could not be listed), and how long each list took.</summary>
    internal sealed record StorageProbe(IReadOnlySet<string>? Tables, IReadOnlySet<string>? Containers, double TablesMs = 0, double ContainersMs = 0);

    /// <summary>One mapped SignalR hub: class name and route.</summary>
    internal sealed record HubInfo(string Name, string Route);

    /// <summary>Every table the app uses, by name (the storage service's, the initializer's and the stores').</summary>
    internal static IReadOnlyList<string> TableNames { get; } =
        [.. StorageService.KnownTableNames.Concat(StorageInitializer.AdditionalTables).Append(PoBrawlProgressStore.TableName)
            .Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase)];

    /// <summary>Every blob container the app uses, by name.</summary>
    internal static IReadOnlyList<string> ContainerNames { get; } =
        [.. StorageInitializer.AdditionalBlobContainers.Append(EcosystemWorldStore.ContainerName)
            .Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase)];

    /// <summary>
    /// One list call per service. A failure of either is swallowed into "not reachable"; the
    /// exception (which can carry the account address) is never surfaced.
    /// </summary>
    internal static async Task<StorageProbe> ProbeStorageAsync(TableServiceClient tables, BlobServiceClient blobs, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(3));
        HashSet<string>? tableNames = null, containerNames = null;
        var started = Stopwatch.GetTimestamp();
        try
        {
            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            await foreach (var table in tables.QueryAsync(cancellationToken: cts.Token)) found.Add(table.Name);
            tableNames = found;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { }
        var tablesMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        started = Stopwatch.GetTimestamp();
        try
        {
            var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            await foreach (var container in blobs.GetBlobContainersAsync(cancellationToken: cts.Token)) found.Add(container.Name);
            containerNames = found;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { }
        return new StorageProbe(tableNames, containerNames, Math.Round(tablesMs, 1), Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1));
    }

    /// <summary>The SignalR hubs mapped on this host: class name and route (the /negotiate twin is folded in).</summary>
    internal static IReadOnlyList<HubInfo> ListHubs(EndpointDataSource endpoints) =>
    [
        .. endpoints.Endpoints.OfType<RouteEndpoint>()
            .Select(e => (Meta: e.Metadata.GetMetadata<HubMetadata>(), Route: e.RoutePattern.RawText))
            .Where(h => h.Meta is not null && h.Route is { Length: > 0 } && !h.Route.EndsWith("/negotiate", StringComparison.OrdinalIgnoreCase))
            .DistinctBy(h => h.Route, StringComparer.OrdinalIgnoreCase)
            .OrderBy(h => h.Route, StringComparer.OrdinalIgnoreCase)
            .Select(h => new HubInfo(h.Meta!.HubType.Name, h.Route!)),
    ];

    /// <summary>
    /// Assembles the /api/diag report: the API row (this request, measured), the live API-group rows (the hubs),
    /// the health checks, the storage listings, then the live service rows. Rows switched off on purpose
    /// (<see cref="DiagLiveProbes.Off"/>) never lower the overall status.
    /// </summary>
    internal static async Task<DiagReportDto> BuildReportAsync(
        HealthCheckService health, IWebHostEnvironment environment, CancellationToken ct,
        StorageProbe? storage = null, IReadOnlyList<DiagCheckDto>? live = null, double apiMs = 0)
    {
        var started = Stopwatch.GetTimestamp();
        var report = await health.CheckHealthAsync(ct);
        return BuildReport(report, environment, storage, live, apiMs + Stopwatch.GetElapsedTime(started).TotalMilliseconds);
    }

    /// <summary>The /api/diag report from a finished health run (see <see cref="BuildReportAsync"/>).</summary>
    internal static DiagReportDto BuildReport(
        HealthReport report, IWebHostEnvironment environment,
        StorageProbe? storage = null, IReadOnlyList<DiagCheckDto>? live = null, double apiMs = 0)
    {
        var started = Stopwatch.GetTimestamp();
        live ??= [];

        var checks = new List<DiagCheckDto>
        {
            new("api", "api", "PoMiniGames API", "Healthy", "Serves every page, the games' data and the score boards.",
                "Answered this request.", Math.Round(apiMs + Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1), null),
        };
        checks.AddRange(live.Where(c => c.Group == "api"));

        foreach (var (name, entry) in report.Entries)
        {
            var (group, label, purpose) = CheckNames.TryGetValue(name, out var known)
                ? known
                : ("service", name, "A dependency this app checks on every health probe.");
            checks.Add(new DiagCheckDto(
                name, group, label, entry.Status.ToString(), purpose, Plain(entry.Status),
                Math.Round(entry.Duration.TotalMilliseconds, 1),
                // Type name only: an exception MESSAGE can carry a host name or a key.
                entry.Status == HealthStatus.Healthy ? null : entry.Exception?.GetType().Name ?? "It did not answer as expected."));
        }

        if (storage is not null)
        {
            checks.Add(Listing("tables", "Tables", "Every Azure table the games read and write (a table is created on first use).", TableNames, storage.Tables, storage.TablesMs, missingIsNormal: true));
            checks.Add(Listing("blob-containers", "Blob containers", "Saved worlds and files (a container is created on first use).", ContainerNames, storage.Containers, storage.ContainersMs, missingIsNormal: true));
        }

        checks.AddRange(live.Where(c => c.Group != "api"));

        var counted = checks.Where(c => c.Status != DiagLiveProbes.Off).ToList();
        var overall = counted.Any(c => c.Status == "Unhealthy") ? "Unhealthy"
            : counted.Any(c => c.Status == "Degraded") ? "Degraded"
            : "Healthy";

        return new DiagReportDto(
            overall,
            environment.EnvironmentName,
            BuildVersion,
            DateTimeOffset.UtcNow,
            Math.Round(apiMs + Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1),
            [.. checks]);
    }

    /// <summary>A storage listing as one row: every expected name present, some missing, or the service unreachable.</summary>
    private static DiagCheckDto Listing(string name, string label, string purpose, IReadOnlyList<string> expected, IReadOnlySet<string>? found, double ms, bool missingIsNormal)
    {
        if (found is null)
        {
            return new DiagCheckDto(name, "data", label, "Unhealthy", purpose, $"Could not list the {expected.Count} {label.ToLowerInvariant()}.", ms,
                "The storage service did not answer the listing.");
        }

        var missing = expected.Where(n => !found.Contains(n)).ToList();
        if (missing.Count == 0)
        {
            return new DiagCheckDto(name, "data", label, "Healthy", purpose, $"All {expected.Count} present: {string.Join(", ", expected)}.", ms, null);
        }

        return missingIsNormal
            ? new DiagCheckDto(name, "data", label, "Healthy", purpose,
                $"{expected.Count - missing.Count} of {expected.Count} present; created on first use: {string.Join(", ", missing)}.", ms, null)
            : new DiagCheckDto(name, "data", label, "Degraded", purpose,
                $"{expected.Count - missing.Count} of {expected.Count} present.", ms, $"Missing: {string.Join(", ", missing)}.");
    }

    private static string Plain(HealthStatus status) => status switch
    {
        HealthStatus.Healthy => "Working normally.",
        HealthStatus.Degraded => "Answering, but not fully.",
        _ => "Not answering.",
    };
}
