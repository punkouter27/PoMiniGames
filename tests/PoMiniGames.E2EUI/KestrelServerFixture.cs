using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Testcontainers.Azurite;

namespace PoMiniGames.E2EUI;

/// <summary>
/// One hermetic Azurite container shared by every E2E-UI fixture for the lifetime of the
/// test process. Browser E2E is heavy; starting a separate container per fixture multiplied
/// Docker startup cost and starved WASM-boot timing. A single dedicated container (still NOT
/// the shared dev <c>pominigames</c> container, so cross-run state stays clean) keeps the tier
/// hermetic AND fast. Testcontainers' resource reaper removes it on process exit.
/// </summary>
internal static class E2EUiAzurite
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static AzuriteContainer? _container;
    private static string? _fallbackConnectionString;

    public static async Task<string> GetConnectionStringAsync()
    {
        if (_container is not null)
            return _container.GetConnectionString();
        if (_fallbackConnectionString is not null)
            return _fallbackConnectionString;

        await Gate.WaitAsync();
        try
        {
            if (_container is null && _fallbackConnectionString is null)
            {
                try
                {
                    var c = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.33.0").Build();
                    await c.StartAsync();
                    _container = c;
                }
                catch (DotNet.Testcontainers.Builders.DockerUnavailableException)
                {
                    _fallbackConnectionString = Environment.GetEnvironmentVariable("AZURITE_CONNECTION_STRING")
                        ?? "UseDevelopmentStorage=true";
                }
            }
        }
        finally
        {
            Gate.Release();
        }

        return _container?.GetConnectionString() ?? _fallbackConnectionString!;
    }
}

/// <summary>
/// Boots the real host on a live Kestrel port so Playwright can drive it over
/// HTTP. <see cref="WebApplicationFactory{TEntryPoint}"/>'s default TestServer is
/// in-memory (no socket), which a real browser cannot reach — so this fixture
/// uses the documented dual-host trick: it builds the in-memory test host the
/// base class expects, then builds and starts a second Kestrel host and exposes
/// its bound address via <see cref="ServerAddress"/>.
/// </summary>
/// <remarks>
/// <para>Pattern: Test Fixture (xUnit) + Server Façade. Storage is fully hermetic:
/// the fixture starts its <b>own</b> Azurite container via Testcontainers (like the
/// integration tier) rather than binding the shared host container on a fixed port.
/// This eliminates stale cross-run state and removes the manual "docker compose up"
/// precondition. Requires Docker and Playwright browsers installed
/// (<c>pwsh bin/Debug/net10.0/playwright.ps1 install</c>). See README.md.</para>
/// </remarks>
public class KestrelServerFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    /// <summary>
    /// Set to a <c>dotnet publish -c Release</c> output folder (scripts/run-e2eui.ps1 does) and the tier drives that
    /// trimmed Release build, the same bits the workflow deploys, in its own process instead of the in-process host.
    /// </summary>
    public const string AppDirVariable = "POMINIGAMES_E2EUI_APP_DIR";

    private string _azuriteConnectionString = string.Empty;
    private IHost? _kestrelHost;
    private Process? _published;
    private string? _publishedAddress;

    public async Task InitializeAsync()
    {
        _azuriteConnectionString = await E2EUiAzurite.GetConnectionStringAsync();
        var appDir = Environment.GetEnvironmentVariable(AppDirVariable);
        if (!string.IsNullOrWhiteSpace(appDir) && UiEnvironment.SkipReason is null)
            _publishedAddress = await StartPublishedAsync(appDir);
    }

    Task IAsyncLifetime.DisposeAsync()
    {
        if (_published is { HasExited: false })
        {
            _published.Kill(entireProcessTree: true);
            _published.WaitForExit(10_000);
        }
        _published?.Dispose();
        return Task.CompletedTask;
    }

    /// <summary>The base URL Playwright should navigate to (e.g. http://127.0.0.1:51234).</summary>
    public string ServerAddress
    {
        get
        {
            if (_publishedAddress is not null)
                return _publishedAddress;
            EnsureServer();
            return ClientOptions.BaseAddress.ToString();
        }
    }

    /// <summary>
    /// Runs the published app (<c>dotnet PoMiniGames.Api.dll</c>) in the Test environment with the same hermetic
    /// overrides as <see cref="ConfigureWebHost"/>, on a free port, and waits for <c>/health/live</c>.
    /// </summary>
    private async Task<string> StartPublishedAsync(string appDir)
    {
        var dll = Path.Combine(Path.GetFullPath(appDir), "PoMiniGames.Api.dll");
        if (!File.Exists(dll))
            throw new InvalidOperationException($"{AppDirVariable} points at '{appDir}', which has no PoMiniGames.Api.dll.");

        int port;
        using (var probe = new TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
        }
        var address = $"http://127.0.0.1:{port}/";
        var start = new ProcessStartInfo("dotnet", $"\"{dll}\"")
        {
            WorkingDirectory = Path.GetDirectoryName(dll)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        start.Environment["ASPNETCORE_ENVIRONMENT"] = "Test";
        start.Environment["ASPNETCORE_URLS"] = address.TrimEnd('/');
        foreach (var (key, value) in HermeticOverrides())
            start.Environment[key.Replace(":", "__", StringComparison.Ordinal)] = value ?? string.Empty;

        _published = Process.Start(start) ?? throw new InvalidOperationException("Could not start the published app.");
        _published.OutputDataReceived += (_, _) => { };
        _published.ErrorDataReceived += (_, _) => { };
        _published.BeginOutputReadLine();
        _published.BeginErrorReadLine();

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (DateTime.UtcNow < deadline)
        {
            if (_published.HasExited)
                throw new InvalidOperationException($"The published app exited with code {_published.ExitCode} before it answered.");
            try
            {
                using var live = await http.GetAsync(new Uri(new Uri(address), "health/live"));
                if (live.IsSuccessStatusCode)
                    return address;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            await Task.Delay(500);
        }
        throw new TimeoutException($"The published app did not answer /health/live on {address} within 90 s.");
    }

    /// <summary>Keep test hosts hermetic: no live Wikipedia or external quiz packs, a dry Racer track, no Key Vault, storage on Azurite.</summary>
    private Dictionary<string, string?> HermeticOverrides() => new()
    {
        ["PoMiniGames:PoBrawl:Dossier:FetchWikipedia"] = "false",
        ["PoCoupleQuiz:FetchExternalPacks"] = "false",
        ["PoMiniGames:PoRacer:Weather"] = "clear",
        ["KeyVault:Uri"] = "",
        // Mirror Azurite to BOTH TableService and BlobService sections.
        ["PoMiniGames:Storage:TableService:ConnectionString"] = _azuriteConnectionString,
        ["PoMiniGames:Storage:BlobService:ConnectionString"] = _azuriteConnectionString,
        ["PoMiniGames:Storage:TableService:TableName"] = "pominigames-e2eui",
    };

    private void EnsureServer()
    {
        if (_kestrelHost is null)
            _ = Server; // forces CreateHost() below
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // E2E-UI tests run under the "Test" environment so StartupSecretValidator skips its
        // secrets check. Identity needs no setup: the page itself sends the browser's player
        // id and initials with every request.
        builder.UseEnvironment("Test");

        builder.ConfigureAppConfiguration((_, cfg) => cfg.AddInMemoryCollection(HermeticOverrides()));

        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(_ => new TableServiceClient(_azuriteConnectionString));
            services.AddSingleton(_ => new BlobServiceClient(_azuriteConnectionString));
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        // The in-memory host the base class wires up (kept so DI/seed still runs).
        var testHost = builder.Build();

        // A second host bound to a real, OS-assigned (port 0) Kestrel port for the browser.
        // An explicit dynamic port avoids colliding on the host's default :5000 when multiple
        // fixtures boot in parallel collections.
        builder.ConfigureWebHost(webHostBuilder => webHostBuilder
            .UseKestrel()
            .UseUrls("http://127.0.0.1:0"));
        _kestrelHost = builder.Build();
        _kestrelHost.Start();

        var addresses = _kestrelHost.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!;
        ClientOptions.BaseAddress = new Uri(addresses.Addresses.First());

        testHost.Start();
        return testHost;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
            _kestrelHost?.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class KestrelServerCollection : ICollectionFixture<KestrelServerFixture>
{
    public const string Name = "PoMiniGames.E2EUI";
    // The namespace stays stable for cross-assembly refs.
}
