using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Games.PoBrawl;
using PoMiniGamesClient.Models;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// The CPU tournament's bracket: a random 16-slot field with automatic BYEs, winners walking
/// through to the final, and Elo moving like the fighter board.
/// </summary>
public sealed class PoBrawlTournamentTests
{
    [Theory]
    [InlineData(nameof(Draw_PicksAllPresidents_AndSeedsUnratedAtTheBoardSeed))]
    [InlineData(nameof(Byes_FillTheBracketAndAdvanceWithoutChangingElo))]
    [InlineData(nameof(Winners_AdvanceIntoTheirSlots_UntilTheFinalCrownsAChampion))]
    [InlineData(nameof(Elo_IsZeroSum_AndAnUpsetPaysMoreThanAFavouriteWinning))]
    [InlineData(nameof(Results_AreRefused_WhenNotASide_OrOnceDecided))]
    [InlineData(nameof(Expectation_FavoursTheHigherRating_AndOnlyAnUnderdogWinIsAnUpset))]
    [InlineData(nameof(CampaignTrail_Crosses270_OnlyOnTheLastRung))]
    [InlineData(nameof(Progress_Merge_TakesTheNewerRung_TheFastestKo_AndTheMostClears))]
    [InlineData(nameof(Catalog_HasTwoDistinctDemoModesAndReelEntries))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static PoBrawlTournament NewCup(int seed = 7, IReadOnlyDictionary<string, int>? ratings = null) =>
        PoBrawlTournament.Draw(PoBrawlRoster.Fighters, new Random(seed), ratings);

    private void Catalog_HasTwoDistinctDemoModesAndReelEntries()
    {
        var game = GameCatalog.All.Single(g => g.Key == GameKeys.PoBrawl);
        var demos = game.Modes.Where(mode => mode.Mode == GameMode.Demo).ToArray();
        demos.Select(mode => mode.ChipLabel).Should().Equal("DEMO · Tournament", "DEMO · FFA");
        demos.Select(mode => mode.Url).Should().Equal("/pobrawl/demo?autoGuest=1", "/pobrawl/ffa");
        demos.Should().OnlyContain(mode => !mode.RequiresNetwork);
        var reel = GameCatalog.Demo.Where(entry => entry.Key == GameKeys.PoBrawl).ToArray();
        reel.Select(entry => entry.Url).Should().Equal(demos.Select(mode => mode.Url));
        reel.Select(entry => entry.Title).Should().Equal("Brawl Cup", "Brawl FFA");
        game.Primary.Mode.Should().Be(GameMode.OnePlayer);
    }

    private void Draw_PicksAllPresidents_AndSeedsUnratedAtTheBoardSeed()
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

    private void Byes_FillTheBracketAndAdvanceWithoutChangingElo()
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

    private void Winners_AdvanceIntoTheirSlots_UntilTheFinalCrownsAChampion()
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

    private void Elo_IsZeroSum_AndAnUpsetPaysMoreThanAFavouriteWinning()
    {
        var even = NewCup();
        var b = even.Current!;
        var decided = even.RecordResult(1, 20, knockout: true);
        decided.P1Delta.Should().Be(12, because: "K 24 between two 1000s is ±12");
        decided.P2Delta.Should().Be(-12);
        (even.EloOf(b.P1Id!) + even.EloOf(b.P2Id!)).Should().Be(2 * PoBrawlTournament.SeedElo);

        var first = NewCup().Current!;
        var ratings = new Dictionary<string, int> { [first.P1Id!] = 1400, [first.P2Id!] = 1000 };
        var favourite = NewCup(ratings: ratings).RecordResult(1, 20, knockout: true).P1Delta;
        var upset = NewCup(ratings: ratings).RecordResult(2, 20, knockout: true).P2Delta;
        upset.Should().BeGreaterThan(favourite);
        (favourite + upset).Should().Be(24, because: "the two expectations sum to one");
    }

    private void Expectation_FavoursTheHigherRating_AndOnlyAnUnderdogWinIsAnUpset()
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

    private void Results_AreRefused_WhenNotASide_OrOnceDecided()
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
    private void CampaignTrail_Crosses270_OnlyOnTheLastRung()
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
    private void Progress_Merge_TakesTheNewerRung_TheFastestKo_AndTheMostClears()
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
