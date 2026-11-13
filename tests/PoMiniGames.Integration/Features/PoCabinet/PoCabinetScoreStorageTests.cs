using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration.Features.PoCabinet;

/// <summary>
/// PoCabinet score round-trip against a real Azurite container: submitted through the full HTTP
/// path, read back from storage and from the unified leaderboard's per-track boards. Five claims:
/// <list type="number">
///   <item>Only verified laps are stored: a bare claim with no input log is refused (422),
///         and a proof's stored time and place are the server's replay, whatever the claim says.</item>
///   <item>A best lap submitted on <c>capitol</c> is in the table the descriptor declared.</item>
///   <item>Track partitioning is real: the same player on Capitol and Mar-a-Lago
///         gets two distinct rows; a Capitol submission does not appear in the
///         Mar-a-Lago board.</item>
///   <item>ETag-update overwrite is ratcheting: a worse later lap does not erase a
///         better PB, and a faster lap does.</item>
///   <item>The stored laps are what <c>GET /api/leaderboards/pocabinet-{track}</c> ranks:
///         fastest first, in m:ss.fff; an unknown track has no board (404).</item>
/// </list>
/// <para>
/// <b>Test identity.</b> The test signs in as a fresh FakeAuth user per run, and the server
/// overwrites the wire-supplied <c>PlayerDisplayName</c> with the resolved
/// identity. The assertions match on that resolved name,
/// not the randomized wire name — the wire name is the issue PoRacer had to
/// fix for the same reason (see PoRacerScoreEndpoints.cs header comment).
/// </para>
/// One method, five claims. The Integration tier is at its 50 cap (per
/// <see cref="IntegrationTestCountCeilingTests"/>) and the rule is to consolidate
/// rather than raise.
/// </summary>
public sealed class PoCabinetScoreStorageTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoCabinetScoreStorageTests(TestWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task SubmitAndReadRoundTrips_TrackPartitionsHold_AndOverwriteIsRatcheting()
    {
        if (!_factory.DockerAvailable) return;
        // The POSTs below are state-changing /api/* calls and are refused without
        // the synchroniser token. Arm up front so the ratcheting assertions at the end
        // exercise a real 200 rather than collapsing into a blanket 403.
        // A fresh identity per run: this tier writes to the developer's local Azurite, and a
        // PB left behind by an earlier run under a shared "test-user" would out-ratchet this
        // run's first lap. The token is bound to identity, so arm after switching.
        var resolvedPlayer = $"pocab-int-{Guid.NewGuid():N}"[..24];
        var raw = _factory.CreateClient();
        raw.DefaultRequestHeaders.Remove(FakeAuthHandler.UserHeader);
        raw.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, resolvedPlayer);
        var client = await raw.ArmAntiforgeryAsync();

        // The server resolves identity from FakeAuth, never the wire player name; the wire
        // name differs on purpose so a match can only come from the resolved identity.
        var wirePlayer = $"pocabinet-int-{Guid.NewGuid():N}";
        // Laps are server-timed from their input logs (PoCabinetLapVerifier), so each submit
        // carries a real browser-recorded proof and the claim is only logged. The fixtures'
        // own times drive the assertions: clean ≈ 26.43 s, messy ≈ 24.10 s (faster), wild ≈
        // 30.93 s (slower: it ends the race badly bent), all on Capitol; maralago-clean ≈ 27.32 s.
        // (The generator checks that ordering before it writes the file.)
        PoCabinetScoreDto Submit(string proofName, int position)
        {
            var proof = PoCabinetLapProofs.Get(proofName);
            return new PoCabinetScoreDto
            {
                PlayerDisplayName = wirePlayer,
                TrackId = proof.TrackId,
                BestLapSeconds = proof.JsBestLap,
                FinalPosition = position,
                AchievedAtUtc = DateTimeOffset.UtcNow,
                IsGuest = true,
                GameCode = "SOLO",
                Inputs = proof.Inputs,
                Wet = proof.Wet,
            };
        }
        double Lap(string proofName) => Math.Round(PoCabinetLapProofs.Get(proofName).JsBestLap, 3);
        var storage = _factory.Services.GetRequiredService<IStorageService>();
        async Task<List<PoCabinetHighScore>> BoardAsync(string track) =>
            await storage.GetPoCabinetHighScoresAsync(limit: 1000, trackId: track);
        async Task<PoCabinetHighScore> RowAsync(string track) => (await BoardAsync(track)).First(s => s.PlayerName == resolvedPlayer);
        async Task<double> StoredAsync(string track) => (await RowAsync(track)).BestLapSeconds;

        // ── No proof: a bare claimed time is refused, not stored ─────────────
        var bare = Submit("capitol-clean", 1);
        bare.Inputs = null;
        bare.BestLapSeconds = 1.0;
        (await client.PostAsJsonAsync("/api/pocabinet/scores", bare)).StatusCode
            .Should().Be(HttpStatusCode.UnprocessableEntity, "a solo lap with no input log can't be verified");

        // ── Submit a Capitol best lap; the claim is a lie, the stored time is the replay's ─
        var lying = Submit("capitol-clean", 1);
        lying.BestLapSeconds = 5.0;
        var firstPost = await client.PostAsJsonAsync("/api/pocabinet/scores", lying);
        firstPost.StatusCode.Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-clean"), 0.001,
            "the server stores the lap it re-timed, and resolves identity from auth, not the wire name");
        var clean = PoCabinetLapProofs.Get("capitol-clean");
        var replayedPlace = PoCabinetLapVerifier.Replay(clean.TrackId, clean.Wet, PoCabinetLapVerifier.Decode(clean.Inputs)!).Position;
        (await RowAsync("capitol")).FinalPosition.Should().Be(Math.Max(1, replayedPlace),
            "a claimed P1 is stored as the place the replay finished in");

        // ── Mar-a-Lago lap for the same player (no partition leak) ─────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("maralago-clean", 2))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("maralago")).Should().BeApproximately(Lap("maralago-clean"), 0.001);
        var marBoard = await BoardAsync("maralago");
        var capitolLap = Lap("capitol-clean");
        marBoard!.Should().NotContain(s => Math.Abs(s.BestLapSeconds - capitolLap) < 0.001,
            "the Capitol lap must not appear on the Mar-a-Lago board");

        // ── A worse later Capitol lap must NOT overwrite the PB ────────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("capitol-wild", 4))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-clean"), 0.001,
            "a worse lap must not erase a stored PB");

        // ── A faster Capitol lap overwrites the PB ─────────────────────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("capitol-messy", 1))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-messy"), 0.001,
            "a faster lap must replace the stored PB");

        // ── The boards: one per track, read anonymously through the unified leaderboard ──
        foreach (var (key, track) in new[] { ("pocabinet", "capitol"), ("pocabinet-maralago", "maralago") })
        {
            var board = await client.GetFromJsonAsync<GameLeaderboardDto>($"/api/leaderboards/{key}?limit=100");
            board!.GameKey.Should().Be(key);
            board.Unit.Should().Be("Best lap");
            board.HigherIsBetter.Should().BeFalse("the fastest lap is rank 1");
            var real = board.Entries.Where(e => e.Name != "XXX").ToList();
            real.Should().NotBeEmpty().And.BeInAscendingOrder(e => e.Value);
            real.Should().OnlyContain(e => System.Text.RegularExpressions.Regex.IsMatch(e.DisplayValue, @"^\d+:\d\d\.\d{3}$"));
            // This tier's Azurite can hold rows from earlier runs: only a board short enough
            // to show every row is sure to show this run's.
            if ((await BoardAsync(track)).Count <= 100)
            {
                var expected = Lap(track == "capitol" ? "capitol-messy" : "maralago-clean");
                real.Should().Contain(e => e.Name == resolvedPlayer && Math.Abs(e.Value - expected) < 0.001);
            }
        }
        (await client.GetAsync("/api/leaderboards/pocabinet-daily")).StatusCode.Should().Be(HttpStatusCode.OK, "today's circuit always has a board");
        (await client.GetAsync("/api/leaderboards/pocabinet-nosuchtrack")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
