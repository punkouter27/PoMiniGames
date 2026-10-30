// filepath: tests/Shared/TestBudgetGuard.cs
namespace PoMiniGames.TestUtilities;

/// <summary>
/// Zero-Waste guardrail for the entire automated test suite.
/// Every fixture (Unit harness, Integration <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/>,
/// E2E-API host, E2E-UI Kestrel host) MUST apply <see cref="Overrides"/> before any HTTP
/// request is served. The intent is structural: the app has no paid services, and the
/// overrides keep every test host off live network calls and real Key Vault.
/// </summary>
/// <remarks>
/// <para><b>Single source of truth.</b> The override dictionary is not duplicated inline in
/// <c>TestWebApplicationFactory.ConfigureWebHost</c>, <c>KestrelServerFixture.ConfigureWebHost</c>,
/// or <c>PoMiniGamesE2EFixture.ConfigureWebHost</c>: drift between copies would let a live
/// boundary be missed in one of them.</para>
/// <para><b>Pattern:</b> Immutable shared dictionary. Adding a new external boundary requires
/// exactly one edit here; the next build of any fixture picks it up automatically.</para>
/// </remarks>
public static class TestBudgetGuard
{
    /// <summary>
    /// Required configuration overrides every test host MUST apply before serving traffic.
    /// Keys are case-insensitive; values are written verbatim into an in-memory
    /// <see cref="Microsoft.Extensions.Configuration.IConfigurationProvider"/> stacked ABOVE
    /// <c>appsettings*.json</c>.
    /// </summary>
    public static IReadOnlyDictionary<string, string?> Overrides { get; } = new Dictionary<string, string?>
    {
        // PoJevArena: honoured only when the host environment is "Test"; swaps in the
        // deterministic StubJevClient for the local brain.
        ["PoMiniGames:Jev:UseStub"] = "true",
        // PoBrawl dossiers: free, but a live call to en.wikipedia.org. Tests serve the static facts.
        ["PoMiniGames:PoBrawl:Dossier:FetchWikipedia"] = "false",
        ["KeyVault:Uri"] = "",
    };

    /// <summary>
    /// Storage connection-string overrides applied alongside <see cref="Overrides"/> when
    /// a fixture provides an Azurite connection string. Mirrors the same value to BOTH the
    /// table-service and blob-service sections so per-game repositories that constructor-
    /// inject <c>BlobServiceClient</c> (e.g. <c>BlobImageRepository</c>) bind to the
    /// emulator instead of falling through to <c>DefaultAzureCredential</c>.
    /// </summary>
    public static IReadOnlyDictionary<string, string?> StorageOverrides(string connectionString, string tableName) =>
        new Dictionary<string, string?>
        {
            ["PoMiniGames:Storage:TableService:ConnectionString"] = connectionString,
            ["PoMiniGames:Storage:BlobService:ConnectionString"] = connectionString,
            ["PoMiniGames:Storage:TableService:TableName"] = tableName,
        };
}
