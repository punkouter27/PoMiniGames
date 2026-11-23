using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Extensions.Options;
using PoMiniGames.Features.Invites;
using PoMiniGames.Features.PoBrawl;
using PoMiniGames.Infrastructure;
using PoMiniGames.Shared.Diagnostics;

namespace PoMiniGames.Features.Health;

/// <summary>
/// The live rows of <c>/api/diag</c> (Po web standard: config-only checks do not count). Every row here makes a
/// real call: the multiplayer hubs' negotiate round trip on this server, a Key Vault secret listing, the App
/// Insights ingestion profile, the free web services Brawl and Couple Quiz enrich their content with, and the
/// push-invite keys in storage. A service this environment switches off on purpose (the test hosts, a missing
/// connection string, a feature flag set to false) is reported as <see cref="Off"/>: neutral, never Degraded,
/// and left out of the overall status.
/// </summary>
/// <remarks>
/// Results are cached (<see cref="CacheFor"/>) so a busy /diag page does not hammer free third-party APIs. The
/// rows carry plain words only: no address, key or exception message (an exception TYPE name at most).
/// </remarks>
public sealed class DiagLiveProbes(
    IHttpClientFactory httpFactory,
    IConfiguration configuration,
    IHostEnvironment environment,
    IOptionsMonitor<PoBrawlDossierOptions> dossier,
    InviteStore invites)
{
    /// <summary>The neutral status of a service switched off on purpose.</summary>
    public const string Off = "Off";

    /// <summary>The named HttpClient the probes use (short timeout, the app's User-Agent).</summary>
    public const string HttpClientName = "Diag.Probes";

    internal static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ThirdPartyCacheFor = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, DiagCheckDto Row)> _cache = new();
    private SecretClient? _vault;

    /// <summary>The multiplayer hubs answer a SignalR negotiate on this very server (a real HTTP round trip).</summary>
    internal Task<DiagCheckDto> HubsAsync(Uri? self, IReadOnlyList<DiagEndpoints.HubInfo> hubs, CancellationToken ct) =>
        CachedAsync("multiplayer", CacheFor, async () =>
        {
            const string label = "Multiplayer hubs";
            const string purpose = "SignalR lobbies and live matches; they run inside this server.";
            if (hubs.Count == 0)
                return new DiagCheckDto("multiplayer", "api", label, "Unhealthy", purpose, "No hub is mapped.", 0, "No multiplayer hub is mapped on this server.");
            if (self is null)
                return new DiagCheckDto("multiplayer", "api", label, "Degraded", purpose, $"{hubs.Count} hubs mapped; this request had no address to call back.", 0, "Could not reach a hub to test it.");

            var hub = hubs[0];
            var (ok, ms, problem) = await SendAsync(HttpMethod.Post, new Uri(self, hub.Route.TrimStart('/') + "/negotiate?negotiateVersion=1"),
                async r => r.IsSuccessStatusCode && (await r.Content.ReadAsStringAsync(ct)).Contains("connectionToken", StringComparison.Ordinal), ct);
            return ok
                ? new DiagCheckDto("multiplayer", "api", label, "Healthy", purpose,
                    $"{hub.Route} answered a negotiate; {hubs.Count} hubs mapped: {string.Join(", ", hubs.Select(h => h.Route))}.", ms, null)
                : new DiagCheckDto("multiplayer", "api", label, "Unhealthy", purpose,
                    $"{hub.Route} did not answer a negotiate.", ms, problem ?? "The hub did not answer as expected.");
        });

    /// <summary>Key Vault: list one page of secret names with the app's own identity.</summary>
    public Task<DiagCheckDto> KeyVaultAsync(CancellationToken ct) =>
        CachedAsync("key-vault", CacheFor, async () =>
        {
            const string label = "Azure Key Vault";
            const string purpose = "Holds the production secrets; read at startup.";
            var uri = configuration["PoMiniGames:KeyVault:Uri"] ?? configuration["KeyVault:Uri"];
            if (string.IsNullOrWhiteSpace(uri))
                return new DiagCheckDto("key-vault", "service", label, Off, purpose, "Not used in this environment.", 0, null);

            var started = Stopwatch.GetTimestamp();
            try
            {
                _vault ??= new SecretClient(new Uri(uri), Credential());
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                cts.CancelAfter(TimeSpan.FromSeconds(8));
                await foreach (var page in _vault.GetPropertiesOfSecretsAsync(cts.Token).AsPages(pageSizeHint: 1))
                {
                    _ = page.Values.Count;
                    break;
                }
                return new DiagCheckDto("key-vault", "service", label, "Healthy", purpose, "Listed its secrets with this app's identity.", Elapsed(started), null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                return new DiagCheckDto("key-vault", "service", label, "Unhealthy", purpose, "Could not list its secrets.", Elapsed(started), ex.GetType().Name);
            }
        });

    /// <summary>App Insights: the ingestion service knows this app's instrumentation key (its profile answers).</summary>
    public Task<DiagCheckDto> AppInsightsAsync(CancellationToken ct) =>
        CachedAsync("app-insights", CacheFor, async () =>
        {
            const string label = "Application Insights";
            const string purpose = "Receives request telemetry and errors for troubleshooting.";
            var parts = ParseConnectionString(TelemetryExtensions.AppInsightsConnectionString(configuration));
            if (!parts.TryGetValue("InstrumentationKey", out var key) || !Guid.TryParse(key, out _))
                return new DiagCheckDto("app-insights", "service", label, Off, purpose, "Telemetry is not switched on here.", 0, null);

            var ingestion = parts.TryGetValue("IngestionEndpoint", out var e) && Uri.TryCreate(e, UriKind.Absolute, out var u)
                ? u : new Uri("https://dc.services.visualstudio.com/");
            var (ok, ms, problem) = await SendAsync(HttpMethod.Get, new Uri(ingestion, $"api/profiles/{key}/appId"),
                async r => r.IsSuccessStatusCode && (await r.Content.ReadAsStringAsync(ct)).Trim('"', ' ').Length > 0, ct);
            return ok
                ? new DiagCheckDto("app-insights", "service", label, "Healthy", purpose, "The ingestion service knows this app.", ms, null)
                : new DiagCheckDto("app-insights", "service", label, "Degraded", purpose, "The ingestion service did not confirm this app.", ms, problem ?? "Telemetry may not be arriving.");
        });

    /// <summary>Wikipedia, which Brawl's fighter dossiers are enriched from (the static facts are served without it).</summary>
    public Task<DiagCheckDto> WikipediaAsync(CancellationToken ct) =>
        ThirdPartyAsync("wikipedia", "Wikipedia", "Enriches Brawl's fighter dossiers with a summary and portrait (static facts otherwise).",
            dossier.CurrentValue.FetchWikipedia, PoBrawlDossierService.HttpClientName, new Uri("page/summary/Abraham_Lincoln", UriKind.Relative),
            json => json.TryGetProperty("title", out _), ct);

    /// <summary>The push-invite key pair is readable from storage (pushes go to each player's browser push service).</summary>
    public Task<DiagCheckDto> PushKeysAsync(CancellationToken ct) =>
        CachedAsync("push", CacheFor, async () =>
        {
            const string label = "Push invites";
            const string purpose = "Sends a game invite to a friend's device through their browser's push service.";
            var started = Stopwatch.GetTimestamp();
            var keys = await invites.GetVapidKeysAsync(ct);
            return keys is { PublicKey.Length: > 0 }
                ? new DiagCheckDto("push", "service", label, "Healthy", purpose, "The signing keys are ready in storage.", Elapsed(started), null)
                : new DiagCheckDto("push", "service", label, "Degraded", purpose, "The signing keys could not be read.", Elapsed(started), "Invites cannot be pushed until storage answers.");
        });

    private Task<DiagCheckDto> ThirdPartyAsync(string name, string label, string purpose, bool enabled, string client, Uri url,
        Func<JsonElement, bool> looksRight, CancellationToken ct) =>
        CachedAsync(name, ThirdPartyCacheFor, async () =>
        {
            if (!enabled)
                return new DiagCheckDto(name, "service", label, Off, purpose, "Switched off in this environment.", 0, null);
            var (ok, ms, problem) = await SendAsync(HttpMethod.Get, url, async r =>
            {
                if (!r.IsSuccessStatusCode) return false;
                using var doc = JsonDocument.Parse(await r.Content.ReadAsStreamAsync(ct));
                return looksRight(doc.RootElement);
            }, ct, client);
            // Optional enrichment: the game falls back to its own content, so a failure is Degraded, not Unhealthy.
            return ok
                ? new DiagCheckDto(name, "service", label, "Healthy", purpose, "Answered with real data.", ms, null)
                : new DiagCheckDto(name, "service", label, "Degraded", purpose, "Did not answer with real data; the game uses its own content.", ms, problem ?? "It did not answer as expected.");
        });

    private async Task<DiagCheckDto> CachedAsync(string key, TimeSpan ttl, Func<Task<DiagCheckDto>> probe)
    {
        if (_cache.TryGetValue(key, out var hit) && DateTimeOffset.UtcNow - hit.At < ttl)
            return hit.Row;
        var row = await probe();
        _cache[key] = (DateTimeOffset.UtcNow, row);
        return row;
    }

    private async Task<(bool Ok, double Ms, string? Problem)> SendAsync(HttpMethod method, Uri url,
        Func<HttpResponseMessage, Task<bool>> check, CancellationToken ct, string client = HttpClientName)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(6));
            using var request = new HttpRequestMessage(method, url);
            if (method == HttpMethod.Post) request.Content = new StringContent("");
            using var response = await httpFactory.CreateClient(client).SendAsync(request, cts.Token);
            var ok = await check(response);
            return (ok, Elapsed(started), ok ? null : $"It answered HTTP {(int)response.StatusCode} without the expected data.");
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            return (false, Elapsed(started), ex is OperationCanceledException ? "It did not answer in time." : ex.GetType().Name);
        }
    }

    private TokenCredential Credential() => environment.IsDevelopment()
        ? new AzureCliCredential(new AzureCliCredentialOptions { ProcessTimeout = TimeSpan.FromSeconds(10) })
        : new DefaultAzureCredential(new DefaultAzureCredentialOptions { Retry = { MaxRetries = 1, NetworkTimeout = TimeSpan.FromSeconds(3) } });

    private static Dictionary<string, string> ParseConnectionString(string? value) =>
        (value ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(p => p.Split('=', 2))
            .Where(p => p.Length == 2)
            .GroupBy(p => p[0], StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First()[1], StringComparer.OrdinalIgnoreCase);

    private static double Elapsed(long started) => Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1);
}
