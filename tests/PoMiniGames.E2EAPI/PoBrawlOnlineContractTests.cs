using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;
using PoMiniGames.Shared.Games;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// Contract tests for the live 1v1 surface. The result ingest is write only and auth-gated, so an
/// anonymous POST must return 401 (NOT 403, which would leak existence); a signed-in POST is judged
/// against the server's own copy of the match. The match hub (the rollback fight's input relay) is
/// auth-gated the same way, and its messages keep the wire shape the browser's rollback session reads.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoBrawlOnlineContractTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoBrawlOnlineContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    /// <summary>
    /// The body carries only a match id and the server decides everything else, so an identified
    /// caller cannot mint a result: a blank id is a 400 and an id the registry does not hold is a
    /// 404 — neither reaches MatchHistory or the Elo table.
    /// </summary>
    [Fact]
    public async Task PostMatch_Identified_RejectsBlankAndUnheldMatchIds()
    {
        using var client = _factory.CreateClient();
        // Identify the client the way a browser does, then arm: the antiforgery token is bound
        // to the identity's claims.
        client.AsPlayer($"Brawl{Guid.NewGuid().ToString("N")[..8]}");
        await client.ArmAntiforgeryAsync();

        var blank = await client.PostAsJsonAsync("/api/pobrawl/matches", new PoBrawlMatchResultDto { MatchId = " " });
        blank.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var unheld = await client.PostAsJsonAsync("/api/pobrawl/matches", new PoBrawlMatchResultDto { MatchId = Guid.NewGuid().ToString("N") });
        unheld.StatusCode.Should().Be(HttpStatusCode.NotFound, "a match the server does not hold has no result to report");
    }

    /// <summary>
    /// The PoBrawl online routes answer an unidentified, unarmed caller as contracted: the result
    /// ingest refuses a write without the antiforgery token, and the match hub is mapped. One theory
    /// over the routes rather than a method each (the E2E-API tier sits at its ceiling), bundled
    /// with the hub's wire contract.
    /// </summary>
    [Theory]
    [InlineData("/api/pobrawl/matches", HttpStatusCode.Forbidden)]
    [InlineData("/pobrawl/match-hub/negotiate", HttpStatusCode.OK)]
    public async Task PoBrawlRoutes_AnswerAnUnarmedCaller(string path, HttpStatusCode expected)
    {
        using var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync(path, new PoBrawlMatchResultDto { MatchId = "anon-test" });

        response.StatusCode.Should().Be(expected);

        AssertMatchHubWireShape();
    }

    /// <summary>
    /// The rollback protocol on the hub's own JSON options: a snapshot carries the 26-int packed sim
    /// and its checksum and round-trips to the same state, an input echo names its frame, and both
    /// stay small (the snapshot goes out 10 times a second, an echo on every key change).
    /// </summary>
    private void AssertMatchHubWireShape()
    {
        var json = _factory.Services.GetRequiredService<IOptions<JsonHubProtocolOptions>>().Value.PayloadSerializerOptions;
        var roster = new[]
        {
            new PoBrawlLobbyPlayer("c1", "alice", "Alice", IsGuest: false, IsReady: true, PoBrawlRoster.Bob),
            new PoBrawlLobbyPlayer("c2", "bob", "Bob", IsGuest: false, IsReady: true, PoBrawlRoster.Bob),
        };
        var match = new PoBrawlMatchService(Guid.NewGuid().ToString("N"), "WIRE1", roster);
        match.RegisterConnection("c1", PoBrawlSide.Player1);
        var echo = match.SubmitInput("c1", new PoBrawlMatchInput { Frame = 3, Held = PoBrawlMatchAction.MoveForward, Press = PoBrawlMatchAction.Punch, Sequence = 1 });
        match.AdvanceTo(30);

        var snapshotJson = JsonSerializer.Serialize(match.Snapshot(), json);
        snapshotJson.Length.Should().BeLessThan(1_024, $"a 10 Hz snapshot must stay small; measured {snapshotJson.Length} bytes");
        var back = JsonSerializer.Deserialize<PoBrawlMatchState>(snapshotJson, json)!;
        back.Sim.Should().HaveCount(PoBrawlRollbackSim.PackedLength);
        PoBrawlRollbackSim.Unpack(back.Sim).Should().Be(match.SimState);
        back.Checksum.Should().Be(PoBrawlRollbackSim.Checksum(match.SimState));

        var echoJson = JsonSerializer.Serialize(echo, json);
        echoJson.Length.Should().BeLessThan(200, $"an input echo must stay small; measured {echoJson.Length} bytes");
        echoJson.Should().Contain("\"frame\":3").And.Contain("\"held\":\"moveForward\"").And.Contain("\"press\":\"punch\"");
    }
}
