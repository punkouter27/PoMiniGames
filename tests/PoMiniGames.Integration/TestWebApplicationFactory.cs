using Testcontainers.Azurite;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PoMiniGames.Features.Auth;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// Custom <see cref="WebApplicationFactory{TEntryPoint}"/> that points SQLite storage at a
/// unique temp directory and starts an Azurite Table Storage container (when Docker is available)
/// so integration tests require no external services.
/// </summary>
public class TestWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private AzuriteContainer? _azurite;
    private string? _azuriteConnectionString;

    /// <summary>True when the Azurite container started — tests that REQUIRE table
    /// storage (rather than treating it as best-effort) guard on this.</summary>
    public bool DockerAvailable => _azuriteConnectionString is not null;

    public async Task InitializeAsync()
    {
        try
        {
            _azurite = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.33.0")
                .Build();

            await _azurite.StartAsync();

            _azuriteConnectionString = _azurite.GetConnectionString();
        }
        catch
        {
            // Docker not available — integration tests run without table storage.
        }
    }

    Task IAsyncLifetime.DisposeAsync() =>
        _azurite is null ? Task.CompletedTask : _azurite.DisposeAsync().AsTask();

    // Captured at app-configuration time so it reflects the FINAL resolved environment, even when
    // a test overrides it to Production via WithWebHostBuilder(builder => builder.UseEnvironment(...)).
    private bool _finalEnvIsProduction;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Integration tests run under "Test" so StartupSecretValidator's Test-skip branch activates.
        builder.UseEnvironment("Test");
        builder.ConfigureAppConfiguration((context, cfg) =>
        {
            _finalEnvIsProduction = string.Equals(
                context.HostingEnvironment.EnvironmentName, "Production", StringComparison.OrdinalIgnoreCase);

            var overrides = new Dictionary<string, string?>(TestBudgetGuard.Overrides);

            if (_azuriteConnectionString is not null)
            {
                // Mirror the Azurite connection string into BOTH the
                // TableService and BlobService sections so per-game blob repositories
                // bind to the emulator rather than falling through to DefaultAzureCredential.
                foreach (var (k, v) in TestBudgetGuard.StorageOverrides(_azuriteConnectionString, "pominigames"))
                {
                    overrides[k] = v;
                }
            }

            cfg.AddInMemoryCollection(overrides);
        });
    }

    /// <summary>
    /// Every test client sends default retro-arcade identity headers (<c>X-Player-Id</c> / <c>X-Player-Initials</c>).
    /// Individual tests can override or remove these headers to assert other identities.
    /// </summary>
    protected override void ConfigureClient(HttpClient client)
    {
        client.DefaultRequestHeaders.Add("X-Player-Id", "test-user");
        client.DefaultRequestHeaders.Add("X-Player-Initials", "TST");
        base.ConfigureClient(client);
    }
}
