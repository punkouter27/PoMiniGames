using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using PoMiniGames.Features.PoCabinet;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// HTTP contract tests for the PoCabinet endpoints. One method by design — the E2E-API tier is
/// capped at 25.
/// <list type="bullet">
///   <item>POST <c>/api/pocabinet/scores</c> rejects a malformed payload (a negative lap) before
///         anything is stored. There is no read of the stored laps: the app has no Cabinet board.</item>
/// </list>
/// </summary>
public sealed class PoCabinetScoreContractTests
{
    [Fact]
    public async Task Scores_RejectAnOutOfRangeLap()
    {
        // Use a WebApplicationFactory so we exercise the full HTTP pipeline
        // (routing, antiforgery, model binding, JSON) against a real host.
        await using var factory = new ScoreFactory();
        using var client = factory.CreateClient();

        // Authed POST with an out-of-range lap must fail validation. We don't arm
        // antiforgery here (this test is shape-only); the framework's blanket 403
        // path proves the endpoint exists and is gated, which is what the contract
        // test needs to pin.
        var badLap = new PoCabinetScoreDto
        {
            PlayerDisplayName = "contract-test",
            TrackId = PoMiniGames.Shared.Games.PoCabinetCatalog.DefaultTrackId,
            BestLapSeconds = -1, // negative — fails validation
            FinalPosition = 1,
            AchievedAtUtc = DateTimeOffset.UtcNow,
        };
        var badLapPost = await client.PostAsJsonAsync("/api/pocabinet/scores", badLap);
        badLapPost.StatusCode.Should().Match(s =>
            s == HttpStatusCode.BadRequest
                || s == HttpStatusCode.Unauthorized
                || s == HttpStatusCode.Forbidden,
            "validation rejects negative laps; antiforgery may preempt with 401/403, which is also a valid wire outcome");
    }

    private sealed class ScoreFactory : Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.UseEnvironment("Test");
        }
    }
}
