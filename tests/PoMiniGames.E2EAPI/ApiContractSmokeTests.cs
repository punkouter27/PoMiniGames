using System.Net;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// API contract smoke tests. Verifies the public contract surface the
/// frontend and SignalR clients depend on, without requiring a live browser.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class ApiContractSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public ApiContractSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task HealthPing_ReturnsPong()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/health/ping");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("pong");
    }

    [Fact]
    public async Task AntiforgeryToken_Anonymous_ReturnsAToken()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/auth/antiforgery-token");

        // Anonymous: every browser fetches this before its first write, before anything else
        // is known about it, so it must never answer 401.
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("\"token\"");
    }
}
