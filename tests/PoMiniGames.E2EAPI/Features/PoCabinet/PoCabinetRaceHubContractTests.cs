using System.Net;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// The lobby and race hubs are mapped: their <c>/negotiate</c> answers (a missing hub would answer
/// 404). There is no route-level gate; a connection without a player id is refused a seat by the
/// hub itself (<c>HubException</c>), which needs a live connection to show. The two-browser lobby → race
/// hand-off needs a live Kestrel host and is covered in the E2E-UI tier; the per-tick wire budget
/// is a Unit scenario.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public sealed class PoCabinetRaceHubContractTests(PoMiniGamesE2EFixture fixture)
{
    [Theory]
    [InlineData("/pocabinet/lobby-hub/negotiate")]
    [InlineData("/pocabinet/race-hub/negotiate")]
    public async Task HubNegotiate_IsMapped(string negotiateUrl)
    {
        using var client = fixture.CreateClient();
        var negotiate = await client.PostAsync(negotiateUrl, content: null);
        negotiate.StatusCode.Should().Be(HttpStatusCode.OK, $"the {negotiateUrl} endpoint must exist");
    }
}
