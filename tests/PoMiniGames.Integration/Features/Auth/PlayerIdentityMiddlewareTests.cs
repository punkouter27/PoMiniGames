using System.Net;
using FluentAssertions;

namespace PoMiniGames.Integration;

public class PlayerIdentityMiddlewareTests : IClassFixture<LocalAuthWebApplicationFactory>
{
    private readonly LocalAuthWebApplicationFactory _factory;

    public PlayerIdentityMiddlewareTests(LocalAuthWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task PlaySession_WithPlayerHeaders_SucceedsWithoutOAuth()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Player-Id", "arcade-p1-001");
        client.DefaultRequestHeaders.Add("X-Player-Initials", "POM");
        await client.ArmAntiforgeryAsync();

        var response = await client.PostAsync("/api/play/sessions/pobrawl", content: null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task PlaySession_WithSkippedThreeSpaceInitials_SucceedsWithoutOAuth()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Player-Id", "arcade-p1-002");
        client.DefaultRequestHeaders.Add("X-Player-Initials", "   ");
        await client.ArmAntiforgeryAsync();

        var response = await client.PostAsync("/api/play/sessions/pobrawl", content: null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task PlaySession_WithNoIdentityHeaders_IsNotBlockedByAuthGate()
    {
        var client = _factory.CreateClient();
        await client.ArmAntiforgeryAsync();

        var response = await client.PostAsync("/api/play/sessions/pobrawl", content: null);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
