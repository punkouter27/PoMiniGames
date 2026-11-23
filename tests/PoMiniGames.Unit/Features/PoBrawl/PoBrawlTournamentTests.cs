using FluentAssertions;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.RenderTree;
using Microsoft.AspNetCore.Components.Rendering;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.JSInterop;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoBrawl;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// The CPU tournament's bracket: a rating-seeded 16-slot field with BYEs on the bottom seeds, winners walking
/// through to the final, and Elo moving like the fighter board.
/// </summary>
public sealed class PoBrawlTournamentTests
{
    [Theory]
    [InlineData(nameof(Draw_PicksAllPresidents_AndSeedsUnratedAtTheBoardSeed))]
    [InlineData(nameof(Byes_FillTheBracketAndAdvanceWithoutChangingElo))]
    [InlineData(nameof(Draw_SeedsByRating_InTheStandardOrder_WithByesOnTheBottomSeeds))]
    [InlineData(nameof(Winners_AdvanceIntoTheirSlots_UntilTheFinalCrownsAChampion))]
    [InlineData(nameof(Elo_IsZeroSum_AndAnUpsetPaysMoreThanAFavouriteWinning))]
    [InlineData(nameof(Results_AreRefused_WhenNotASide_OrOnceDecided))]
    [InlineData(nameof(Expectation_FavoursTheHigherRating_AndOnlyAnUnderdogWinIsAnUpset))]
    [InlineData(nameof(CampaignTrail_Crosses270_OnlyOnTheLastRung))]
    [InlineData(nameof(Progress_Merge_TakesTheNewerRung_TheFastestKo_AndTheMostClears))]
    [InlineData(nameof(Catalog_HasTwoDistinctDemoModesAndReelEntries))]
    [InlineData(nameof(Ffa_HumanRoundsRecordOnce_AndDemoDoesNotRecord))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static PoBrawlTournament NewCup(int seed = 7, IReadOnlyDictionary<string, int>? ratings = null) =>
        PoBrawlTournament.Draw(PoBrawlRoster.Fighters, new Random(seed), ratings);

    private static async Task Ffa_HumanRoundsRecordOnce_AndDemoDoesNotRecord()
    {
        var stats = new GameStatsService();
        var names = new PlayerNameService(new NoJs());
        await names.Initialized;
        names.SetPlayerName($"ffa-test-{Guid.NewGuid():N}");
        var results = new GameResultService(stats, null!, null!, null!, null!);
        await using var services = new ServiceCollection().BuildServiceProvider();
        await using var renderer = new FfaRenderer(services);
        var page = new FfaTestPage();
        typeof(PoBrawlFfaPage).GetProperty("Mode")!.SetValue(page, "play");
        typeof(PoBrawlFfaPage).GetProperty("PlayerNameService", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(page, names);
        typeof(PoBrawlFfaPage).GetProperty("GameResults", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(page, results);
        // The human champion pauses the engine behind the end card, which goes through JS interop.
        typeof(PoBrawlFfaPage).GetProperty("JSRuntime", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(page, new NoJs());
        renderer.Attach(page);

        await renderer.Dispatcher.InvokeAsync(async () =>
        {
            await page.OnFfaRoundStarted(1, 1);
            await page.OnFfaChampion("bob", 1);
            await page.OnFfaChampion("bob", 1);
            await page.OnFfaRoundStarted(2, 2);
            await page.OnFfaChampion("bob", 1);
            await page.OnFfaChampion("trump", 2);
            await page.OnFfaRoundStarted(1, 3); // season reset reuses the visible round number
            await page.OnFfaChampion("bob", 3);
            typeof(PoBrawlFfaPage).GetProperty("Mode")!.SetValue(page, null);
            await page.OnFfaRoundStarted(2, 4);
            await page.OnFfaChampion("trump", 4);
        });

        var bucket = stats.GetStats("pobrawl-ffa", names.GetPlayerName()).Medium;
        bucket.Wins.Should().Be(2);
        bucket.Losses.Should().Be(1);
    }

    private sealed class NoJs : IJSRuntime
    {
        public ValueTask<T> InvokeAsync<T>(string identifier, object?[]? args) => ValueTask.FromResult(default(T)!);
        public ValueTask<T> InvokeAsync<T>(string identifier, CancellationToken cancellationToken, object?[]? args) => ValueTask.FromResult(default(T)!);
    }

    private sealed class FfaTestPage : PoBrawlFfaPage
    {
        protected override void BuildRenderTree(RenderTreeBuilder builder) { }
    }

#pragma warning disable BL0006
    private sealed class FfaRenderer(IServiceProvider services) : Renderer(services, NullLoggerFactory.Instance)
    {
        public override Dispatcher Dispatcher { get; } = Dispatcher.CreateDefault();
        public void Attach(IComponent component) => AssignRootComponentId(component);
        protected override Task UpdateDisplayAsync(in RenderBatch renderBatch) => Task.CompletedTask;
        protected override void HandleException(Exception exception) => throw exception;
    }
#pragma warning restore BL0006

    private static void Catalog_HasTwoDistinctDemoModesAndReelEntries()
    {
        var game = GameCatalog.All.Single(g => g.Key == GameKeys.PoBrawl);
        var demos = game.Modes.Where(mode => mode.Mode == GameMode.Demo).ToArray();
        demos.Select(mode => mode.ChipLabel).Should().Equal("Demo · Tournament", "Demo · FFA");
        demos.Select(mode => mode.Url).Should().Equal("/pobrawl/demo", "/pobrawl/ffa");
        demos.Should().OnlyContain(mode => !mode.RequiresNetwork);
        var reel = GameCatalog.Demo.Where(entry => entry.Key == GameKeys.PoBrawl).ToArray();
        reel.Select(entry => entry.Url).Should().Equal(demos.Select(mode => mode.Url));
        reel.Select(entry => entry.Title).Should().Equal("Brawl Cup", "Brawl FFA");
        game.Primary.Mode.Should().Be(GameMode.OnePlayer);
    }

    private static void Draw_PicksAllPresidents_AndSeedsUnratedAtTheBoardSeed()
    {
        var cup = NewCup(ratings: new Dictionary<string, int> { ["fdr"] = 1400 });
        cup.Field.Should().HaveCount(PoBrawlRoster.Count).And.OnlyHaveUniqueItems(f => f.Id);
        cup.Field.Should().OnlyContain(f => PoBrawlRoster.IsRateable(f.Id), because: "BOB is never in a CPU bracket");
        PoBrawlRoster.Fighters.TakeLast(2).Select(f => f.Id).Should().Equal("fdr", "hoover");
        cup.Entrants.Should().HaveCount(PoBrawlTournament.Size);
        cup.Entrants.Should().OnlyContain(id => id != PoBrawlTournament.ByeId);
        cup.Bouts.Should().HaveCount(PoBrawlTournament.Size - 1);
        cup.Bouts.Take(8).Should().OnlyContain(b => b.P1Id != null && b.P2Id != null);
        cup.Bouts.Take(8).Should().OnlyContain(b => !b.IsBye);
        foreach (var f in cup.Field)
            cup.EloOf(f.Id).Should().Be(f.Id == "fdr" ? 1400 : PoBrawlTournament.SeedElo);

        // Same seed, same draw — the page rebuilds the draw when the board's ratings arrive.
        NewCup().Field.Select(f => f.Id).Should().Equal(NewCup().Field.Select(f => f.Id));
        NewCup(seed: 8).Field.Select(f => f.Id).Should().NotEqual(NewCup().Field.Select(f => f.Id));
    }

    private static void Draw_SeedsByRating_InTheStandardOrder_WithByesOnTheBottomSeeds()
    {
        PoBrawlTournament.SeedOrder.Should().Equal(1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11);

        // A full field with distinct ratings: the roster's last fighter rated best, its first worst.
        var roster = PoBrawlRoster.Fighters;
        var ratings = roster.Select((f, i) => (f.Id, Elo: 1000 + i * 10)).ToDictionary(x => x.Id, x => x.Elo);
        var bySeed = roster.Reverse().Select(f => f.Id).ToArray();
        foreach (var seed in new[] { 1, 99 })
        {
            var cup = NewCup(seed, ratings);
            cup.Entrants.Should().Equal(PoBrawlTournament.SeedOrder.Select(s => bySeed[s - 1]),
                because: "the rng only breaks ties; distinct ratings fix the draw");
            cup.BySeed.Select(f => f.Id).Should().Equal(bySeed);
            cup.SeedOf(bySeed[0]).Should().Be(1);
            cup.SeedOf(bySeed[15]).Should().Be(16);
            cup.Bouts[0].P1Id.Should().Be(bySeed[0], because: "1 meets 16 first");
            cup.Bouts[0].P2Id.Should().Be(bySeed[15]);
            cup.HigherSeedSide(cup.Bouts[0]).Should().Be(1);
        }

        // Five fighters: seeds 6-16 are BYEs. 1, 2 and 3 walk to the semifinals; 4 and 5 fight.
        var five = roster.Take(5).ToArray();
        var fiveRatings = five.Select((f, i) => (f.Id, Elo: 1400 - i * 50)).ToDictionary(x => x.Id, x => x.Elo);
        var small = PoBrawlTournament.Draw(five, new Random(3), fiveRatings);
        for (var i = 0; i < PoBrawlTournament.Size; i++)
        {
            var seed = PoBrawlTournament.SeedOrder[i];
            small.Entrants[i].Should().Be(seed <= 5 ? five[seed - 1].Id : PoBrawlTournament.ByeId, because: $"slot {i} holds seed {seed}");
        }
        small.Bouts[1].WinnerId.Should().Be(PoBrawlTournament.ByeId, because: "8 v 9 is BYE v BYE: a BYE goes on");
        small.Bouts[8].WinnerId.Should().Be(five[0].Id, because: "seed 1 meets that BYE and advances unfought");
        small.Bouts[12].P1Id.Should().Be(five[0].Id);
        small.Bouts[13].P1Id.Should().Be(five[1].Id);
        small.Bouts[13].P2Id.Should().Be(five[2].Id);
        small.Current.Should().BeSameAs(small.Bouts[9], because: "4 v 5 is the only quarterfinal with two fighters");
        (small.Current!.P1Id, small.Current.P2Id).Should().Be((five[3].Id, five[4].Id));
        small.HigherSeedSide(small.Current).Should().Be(1, because: "a level bout goes to the higher seed, seed 4");
        small.HigherSeedSide(small.Bouts[14]).Should().Be(0, because: "the final is not paired yet");
        small.SeedOf(PoBrawlTournament.ByeId).Should().Be(0);
    }

    private static void Byes_FillTheBracketAndAdvanceWithoutChangingElo()
    {
        var cup = PoBrawlTournament.Draw(PoBrawlRoster.Fighters.Take(5).ToArray(), new Random(2));
        cup.Entrants.Count(id => id == PoBrawlTournament.ByeId).Should().Be(11);
        cup.Bouts.Where(b => b.IsBye).Should().OnlyContain(b => b.WinnerId != null);
        foreach (var bye in cup.Bouts.Where(b => b.IsBye && b.WinnerId is not null && b.WinnerId != PoBrawlTournament.ByeId))
        {
            bye.WinnerId.Should().NotBe(PoBrawlTournament.ByeId);
            cup.RecordOf(bye.WinnerId!).Should().Be((0, 0));
            cup.EloOf(bye.WinnerId!).Should().Be(cup.StartEloOf(bye.WinnerId!));
        }

        var matches = 0;
        while (cup.Current is { } bout)
        {
            bout.IsBye.Should().BeFalse();
            cup.RecordResult(1, 30, knockout: true);
            matches++;
        }

        matches.Should().Be(cup.Field.Count - 1);
        cup.IsComplete.Should().BeTrue();
        cup.ChampionId.Should().NotBe(PoBrawlTournament.ByeId);
    }

    private static void Winners_AdvanceIntoTheirSlots_UntilTheFinalCrownsAChampion()
    {
        var cup = NewCup();
        var opening = cup.Bouts.Take(8).Where(b => !b.IsBye).ToArray();
        foreach (var (bout, side) in opening.Zip(Enumerable.Range(0, opening.Length).Select(i => i % 2 + 1)))
        {
            cup.Current.Should().BeSameAs(bout);
            cup.RecordResult(side, 30, knockout: true).WinnerId.Should().Be(side == 1 ? bout.P1Id : bout.P2Id);
        }
        var quarterfinals = cup.Bouts.Skip(8).Take(4).ToArray();
        quarterfinals[0].P1Id.Should().Be(cup.Bouts[0].WinnerId);
        quarterfinals[0].P2Id.Should().Be(cup.Bouts[1].WinnerId);
        quarterfinals[0].Label.Should().Be("Quarterfinal 1 of 4");

        foreach (var bout in quarterfinals) cup.RecordResult(1, 30, knockout: true);
        cup.Bouts[12].P1Id.Should().Be(quarterfinals[0].WinnerId);
        cup.Bouts[12].P2Id.Should().Be(quarterfinals[1].WinnerId);
        cup.Bouts[12].Label.Should().Be("Semifinal 1 of 2");
        cup.RecordResult(2, 60, knockout: false);
        cup.RecordResult(1, 12, knockout: true);
        cup.Bouts[14].P1Id.Should().Be(cup.Bouts[12].WinnerId);
        cup.Bouts[14].P2Id.Should().Be(cup.Bouts[13].WinnerId);
        cup.IsComplete.Should().BeFalse();

        var champion = cup.Bouts[14].P2Id;
        cup.RecordResult(2, 40, knockout: true);
        cup.ChampionId.Should().Be(champion);
        cup.Current.Should().BeNull();
        cup.Standings[0].Id.Should().Be(champion);
    }

    private static void Elo_IsZeroSum_AndAnUpsetPaysMoreThanAFavouriteWinning()
    {
        var even = NewCup();
        var b = even.Current!;
        var decided = even.RecordResult(1, 20, knockout: true);
        decided.P1Delta.Should().Be(16, because: "K 32 between two 1000s is ±16");
        decided.P2Delta.Should().Be(-16);
        (even.EloOf(b.P1Id!) + even.EloOf(b.P2Id!)).Should().Be(2 * PoBrawlTournament.SeedElo);

        var first = NewCup().Current!;
        var ratings = new Dictionary<string, int> { [first.P1Id!] = 1400, [first.P2Id!] = 1000 };
        var favourite = NewCup(ratings: ratings).RecordResult(1, 20, knockout: true).P1Delta;
        var upset = NewCup(ratings: ratings).RecordResult(2, 20, knockout: true).P2Delta;
        upset.Should().BeGreaterThan(favourite);
        (favourite + upset).Should().Be(32, because: "the two expectations sum to one");
    }

    private static void Expectation_FavoursTheHigherRating_AndOnlyAnUnderdogWinIsAnUpset()
    {
        var first = NewCup().Current!;
        var ratings = new Dictionary<string, int> { [first.P1Id!] = 1200, [first.P2Id!] = 1000 };
        var cup = NewCup(ratings: ratings);
        cup.ExpectedP1(cup.Current!).Should().BeApproximately(0.76, 0.01, because: "200 points up is a 76% favourite");
        cup.ExpectedP1(cup.Bouts[8]).Should().Be(0.5, because: "an unpaired bout has no favourite");

        var upset = cup.RecordResult(2, 20, knockout: true);
        upset.P1Expected.Should().BeApproximately(0.76, 0.01, because: "the expectation is the one going in");
        upset.IsUpset.Should().BeTrue();

        var chalk = NewCup(ratings: ratings).RecordResult(1, 20, knockout: true);
        chalk.IsUpset.Should().BeFalse(because: "the favourite winning is no story");
        NewCup().RecordResult(2, 20, knockout: true).IsUpset.Should().BeFalse(because: "two equal ratings can't upset each other");
        NewCup().Bouts[0].IsUpset.Should().BeFalse(because: "an undecided bout is no upset yet");
    }

    private static void Results_AreRefused_WhenNotASide_OrOnceDecided()
    {
        var cup = NewCup();
        FluentActions.Invoking(() => cup.RecordResult(0, 60, knockout: false))
            .Should().Throw<ArgumentOutOfRangeException>(because: "a knockout bracket cannot advance a draw");
        while (cup.Current is not null) cup.RecordResult(1, 30, knockout: true);
        FluentActions.Invoking(() => cup.RecordResult(1, 30, knockout: true)).Should().Throw<InvalidOperationException>();
        FluentActions.Invoking(() => PoBrawlTournament.Draw([], new Random(1)))
            .Should().Throw<ArgumentException>();
    }

    // The 1P ladder's campaign map (PoBrawlCampaign) shares this theory: one row, no new method.
    private static void CampaignTrail_Crosses270_OnlyOnTheLastRung()
    {
        PoBrawlCampaign.States.Should().HaveCount(51).And.OnlyHaveUniqueItems(s => s.Code)
            .And.OnlyHaveUniqueItems(s => (s.Row * 100) + s.Col);
        PoBrawlCampaign.States.Sum(s => s.Votes).Should().Be(PoBrawlCampaign.TotalVotes);
        PoBrawlCampaign.States.Should().OnlyContain(s => s.Col < PoBrawlCampaign.Columns && s.Row < PoBrawlCampaign.Rows);

        var rungs = PoBrawlRoster.Fighters.Count;
        PoBrawlCampaign.Batches.Should().HaveCount(rungs);
        PoBrawlCampaign.Batches.Should().OnlyContain(b => b.Count > 0, because: "every win flips something");
        PoBrawlCampaign.Batches.SelectMany(b => b).Should().OnlyHaveUniqueItems(because: "a state flips once");
        for (var r = 0; r < rungs; r++)
        {
            var home = PoBrawlCampaign.HomeOf(r).Code;
            PoBrawlCampaign.RungOf(home).Should().BeLessThanOrEqualTo(r, because: "a rung's home state is won by then");
            PoBrawlCampaign.VotesAfter(r + 1).Should().BeGreaterThan(PoBrawlCampaign.VotesAfter(r));
        }
        PoBrawlCampaign.VotesAfter(0).Should().Be(0);
        PoBrawlCampaign.VotesAfter(rungs - 1).Should().BeLessThan(PoBrawlCampaign.ToWin);
        PoBrawlCampaign.VotesAfter(rungs).Should().BeGreaterThanOrEqualTo(PoBrawlCampaign.ToWin);
    }

    /// <summary>The one merge rule the server store and the browser's PoBrawlProgressBook both use.</summary>
    private static void Progress_Merge_TakesTheNewerRung_TheFastestKo_AndTheMostClears()
    {
        var older = new PoBrawlProgressDto { Rung = 9, BestKoSeconds = 12.5, Clears = 3, UpdatedAtUnixMs = 1_000 };
        var newer = new PoBrawlProgressDto { Rung = 2, BestKoSeconds = 0, Clears = 1, UpdatedAtUnixMs = 2_000 };

        var merged = PoBrawlProgressDto.Merge(older, newer);
        (merged.Rung, merged.UpdatedAtUnixMs).Should().Be((2, 2_000L), "the newer copy wins the rung, however low");
        merged.BestKoSeconds.Should().Be(12.5, "a zero is 'no KO yet', never a record");
        merged.Clears.Should().Be(3);

        // Order-independent: an old tab saving late cannot roll anything back.
        var late = PoBrawlProgressDto.Merge(newer, older);
        (late.Rung, late.BestKoSeconds, late.Clears).Should().Be((merged.Rung, merged.BestKoSeconds, merged.Clears));
        PoBrawlProgressDto.Merge(null, older).Should().BeSameAs(older);
        PoBrawlProgressDto.Merge(older, new PoBrawlProgressDto { BestKoSeconds = 8.25, UpdatedAtUnixMs = 0 }).BestKoSeconds.Should().Be(8.25);
    }
}
