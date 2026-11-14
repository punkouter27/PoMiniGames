using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace PoMiniGames.Integration;

/// <summary>
/// WebApplicationFactory running under the "Test" environment for player-identity middleware tests.
/// </summary>
public class LocalAuthWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Test");
    }
}
