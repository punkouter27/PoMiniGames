using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// HTTP contract for the PoMule slice: the score routes are auth-gated, a finished match is
/// range-checked and stored under the server's idea of who posted it, and the unified
/// leaderboard serves the board anonymously. One method: this tier is at its ceiling.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoMuleEndpointsTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoMuleEndpointsTests(PoMiniGamesE2EFixture factory) => _factory = factory;

    [Fact]
    public async Task ScoreRoutes_RefuseAnUnarmedWrite_RangeChecked_AndFeedTheUnifiedBoard()
    {
        using var client = _factory.CreateClient();
        object Run(int netWorth, int species = 7) => new { netWorth, species, colonySurvived = true };

        (await client.GetAsync("/api/pomule/highscores"))
            .StatusCode.Should().Be(HttpStatusCode.OK, "the board is a public read");
        (await client.PostAsJsonAsync("/api/pomule/highscores", Run(15_000)))
            .StatusCode.Should().Be(HttpStatusCode.Forbidden, "a write needs the antiforgery token");

        var player = $"Mule{Guid.NewGuid().ToString("N")[..8]}";
        client.AsPlayer($"{player}");
        await client.ArmAntiforgeryAsync();

        var saved = await client.PostAsJsonAsync("/api/pomule/highscores", Run(15_000));
        saved.StatusCode.Should().Be(HttpStatusCode.Created, await saved.Content.ReadAsStringAsync());
        using var row = JsonDocument.Parse(await saved.Content.ReadAsStringAsync());
        row.RootElement.GetProperty("netWorth").GetInt32().Should().Be(15_000);
        row.RootElement.GetProperty("species").GetString().Should().Be("Humanoid Settler");

        (await client.PostAsJsonAsync("/api/pomule/highscores", Run(500_001)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest, "above the sanity ceiling");
        (await client.PostAsJsonAsync("/api/pomule/highscores", Run(-1)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await client.PostAsJsonAsync("/api/pomule/highscores", Run(15_000, species: 8)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest, "there are eight species, numbered 0 to 7");

        using var anonymous = _factory.CreateClient();
        var board = await anonymous.GetAsync("/api/leaderboards/pomule");
        board.StatusCode.Should().Be(HttpStatusCode.OK);
        (await board.Content.ReadAsStringAsync()).Should().Contain("pomule").And.Contain("Mule");
    }
}
