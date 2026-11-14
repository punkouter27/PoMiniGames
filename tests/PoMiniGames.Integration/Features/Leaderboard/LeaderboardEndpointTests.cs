using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// Integration tests for endpoints not already covered by HomePageApiTests:
/// player-stats 404 path, PoBrawl high-score ranking, and the diag mask endpoint.
/// Snake and PoDropSquare high-score endpoints have been removed together with
/// those games; the remaining boards (PoBrawl, marble race) live under
/// UnifiedLeaderboardEndpoints and are exercised elsewhere.
/// </summary>
public sealed class LeaderboardEndpointTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public LeaderboardEndpointTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    // The high-score and ladder POSTs are state-changing /api/* calls and are
    // refused without a synchroniser token. Arming lives in InitializeAsync rather than
    // the constructor because fetching the token is an HTTP round trip.
    public Task InitializeAsync() => _client.ArmAntiforgeryAsync();

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    // ── Player stats – 404 path ────────────────────────────────────────────

    [Fact]
    public async Task GetPlayerStats_Returns404OrOk_WhenPlayerNotFound()
    {
        var response = await _client.GetAsync("/api/tictactoe/players/nonexistent_player_xyz/stats");
        response.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NotFound);
    }

    // ── PoBrawl fastest-KO high scores ────────────────────────────────────

    /// <summary>A client identified by <paramref name="user"/> via X-Player-Id / X-Player-Initials, armed.</summary>
    private async Task<HttpClient> SignedInAsync(string user)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Remove("X-Player-Id");
        client.DefaultRequestHeaders.Remove("X-Player-Initials");
        client.DefaultRequestHeaders.Add("X-Player-Id", user);
        client.DefaultRequestHeaders.Add("X-Player-Initials", user.Length >= 3 ? user[..3].ToUpperInvariant() : "TST");
        await client.ArmAntiforgeryAsync();
        return client;
    }

    [Fact]
    public async Task PoBrawlHighScores_PostRanksAscending_AndRejectsBadInput()
    {
        if (!_factory.DockerAvailable) return;

        // Two players; the faster KO should rank ahead of the slower one. The stored name is the
        // claim name, so each needs its own identity.
        var slowName = $"ko_slow_{Guid.NewGuid():N}"[..20];
        var fastName = $"ko_fast_{Guid.NewGuid():N}"[..20];
        using var slowClient = await SignedInAsync(slowName);
        using var fastClient = await SignedInAsync(fastName);
        var slow = new { PlayerInitials = "SLW", KoTimeSeconds = 42.5, Character = "trump", Date = DateTime.UtcNow.ToString("o") };
        var fast = new { PlayerInitials = "FST", KoTimeSeconds = 7.25, Character = "obama", Date = DateTime.UtcNow.ToString("o") };

        (await slowClient.PostAsJsonAsync("/api/pobrawl/highscores", slow)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await fastClient.PostAsJsonAsync("/api/pobrawl/highscores", fast)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        // One row per player: a slower KO later must not add a row or replace the best.
        (await slowClient.PostAsJsonAsync("/api/pobrawl/highscores", slow with { KoTimeSeconds = 55.0 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        var scores = await _client.GetFromJsonAsync<List<System.Text.Json.JsonElement>>("/api/pobrawl/highscores?count=100000");
        scores.Should().NotBeNull();
        scores!.Should().NotBeEmpty();

        // Ranked ascending by KO time, so times are non-decreasing down the board.
        var times = scores!.Select(s => s.GetProperty("koTimeSeconds").GetDouble()).ToList();
        times.Should().BeInAscendingOrder(because: "the fastest KO must rank first");
        times.Should().Contain(7.25).And.Contain(42.5);
        scores.Where(s => s.GetProperty("playerInitials").GetString() == slowName)
            .Select(s => s.GetProperty("koTimeSeconds").GetDouble())
            .Should().Equal([42.5], "the board keeps each player's best KO, once");

        // A signed-in caller's typed name is only a fallback (the claim name is stored), so a
        // blank one is accepted; a non-positive KO time is still rejected, and so is one faster
        // than the engine's quickest possible KO (ScoreRules' 1.5 s floor).
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "", KoTimeSeconds = 5.0 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "ABC", KoTimeSeconds = 0.0 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "ABC", KoTimeSeconds = 1.2 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
    }

    // ── PoBrawl presidents-ladder leaderboard ─────────────────────────────

    [Fact]
    public async Task PoBrawlLadder_KeepsBestRunPerPlayer_RanksByPresidentsBeaten_AndRejectsBadInput()
    {
        if (!_factory.DockerAvailable) return;

        var name = $"ladder_test_{Guid.NewGuid():N}"[..24];
        var rival = $"ladder_riva_{Guid.NewGuid():N}"[..24];
        using var nameClient = await SignedInAsync(name);
        using var rivalClient = await SignedInAsync(rival);

        async Task<System.Text.Json.JsonElement> Post(HttpClient client, object body, HttpStatusCode expected)
        {
            var response = await client.PostAsJsonAsync("/api/pobrawl/ladder", body);
            response.StatusCode.Should().Be(expected);
            return expected == HttpStatusCode.Created
                ? await response.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()
                : default;
        }

        // The claim is not taken on trust: a first post claiming rung 4 is credited ONE rung (a
        // run is won one fight at a time, and every win posts), and the Elo is clamped.
        var first = await Post(nameClient, new { PlayerName = name, PresidentsBeaten = 4, Elo = 99_999 }, HttpStatusCode.Created);
        first.GetProperty("presidentsBeaten").GetInt32().Should().Be(1, "one rung past the stored count, at most");
        first.GetProperty("elo").GetInt32().Should().Be(3000, "the client's rating is clamped to a sane range");

        // The next rung arrives sooner than any real fight could be won: refused, nothing moves.
        await Post(nameClient, new { PlayerName = name, PresidentsBeaten = 2, Elo = 1250 }, HttpStatusCode.TooManyRequests);

        // A worse run (an older count) never overwrites the best, and is not "too fast" either.
        var held = await Post(nameClient, new { PlayerName = name, PresidentsBeaten = 0, Elo = 1250 }, HttpStatusCode.Created);
        held.GetProperty("presidentsBeaten").GetInt32().Should().Be(1);

        // A full-clear claim from a fresh identity is credited one rung too. The ceiling is the
        // roster size, never a literal 10 (that froze the board one rung short of the roster).
        (await Post(rivalClient, new { PlayerName = rival, PresidentsBeaten = PoBrawlRoster.Count, Elo = 1700 }, HttpStatusCode.Created))
            .GetProperty("presidentsBeaten").GetInt32().Should().Be(1);

        // Read back through the UNIFIED board, not a PoBrawl-specific GET. That is the
        // only route the ladder is ever read over: /api/pobrawl/ladder is write-only
        // (see PoBrawlLeaderboardEndpoints), and GameOverModal's "Top 3 / Best rung"
        // panel and the leaderboards list are both fed from here.
        var board = await _client.GetFromJsonAsync<System.Text.Json.JsonElement>(
            "/api/leaderboards/pobrawl?limit=50");
        var entries = board.GetProperty("entries").EnumerateArray().ToList();
        entries.Should().NotBeEmpty();

        var mine = entries.Single(e => e.GetProperty("name").GetString() == name);
        mine.GetProperty("value").GetDouble().Should().Be(1, "the server's own count of climbs, not the claim");
        entries.Should().ContainSingle(e => e.GetProperty("name").GetString() == name,
            because: "the ladder keeps one row per player");
        mine.GetProperty("displayValue").GetString()
            .Should().Be($"1/{PoBrawlRoster.Count}",
                because: "the rung denominator tracks the roster, never a literal");

        // Ranked by presidents beaten, descending.
        var beaten = entries.Select(e => e.GetProperty("value").GetDouble()).ToList();
        beaten.Should().BeInDescendingOrder(because: "most presidents beaten ranks first");

        // Same rule as the KO board: a signed-in caller's blank typed name is fine (the claim
        // name is stored); an out-of-range count is still rejected.
        using var blankClient = await SignedInAsync($"ladder_blank_{Guid.NewGuid():N}"[..24]);
        await Post(blankClient, new { PlayerName = "", PresidentsBeaten = 3 }, HttpStatusCode.Created);
        await Post(blankClient, new { PlayerName = "abc", PresidentsBeaten = PoBrawlRoster.Count + 1 }, HttpStatusCode.BadRequest);
    }
}
