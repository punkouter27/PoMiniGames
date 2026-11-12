using FluentAssertions;
using PoMiniGames.Features.PoMule;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// Whole matches: the month cycle, determinism, saving between months, the renderer feed, and
/// the balance targets from SPEC.md §13.
/// </summary>
public sealed class PoMuleMatchTests
{
    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(AMonth_RunsItsPhasesInOrder_WithAnAuctionOnlyOnEvenMonths_ForTwelveMonths))]
    [InlineData(nameof(TheSameSeed_PlaysTheSameMatch_AndADifferentSeedDoesNot))]
    [InlineData(nameof(ASaveTakenAtTheStartOfAMonth_RestoresItExactly_AndPlaysOnIdentically))]
    [InlineData(nameof(OverAHundredSeededMatches_NothingGoesNegative_TheStoreKeepsMules_AndNoPersonalityDominates))]
    [InlineData(nameof(TheLandGrant_SweepsAHighlighterRowByRow_AndGivesThePlotToWhoeverPressesOnIt))]
    [InlineData(nameof(LuckTheMeteorTheWampusAndThePlotByPlotCount_WorkAsInTheOriginal))]
    [InlineData(nameof(WithARenderer_TheMatchWaitsForArrivals_AndFeedsOneFlatSnapshot))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static void AMonth_RunsItsPhasesInOrder_WithAnAuctionOnlyOnEvenMonths_ForTwelveMonths()
    {
        var match = PoMuleMatch.New(seed: 42, humanSpecies: null, headless: true, fast: true);
        var phases = new Dictionary<int, List<Phase>>();
        var ticks = 0;
        while (match.State.Phase != Phase.Finished && ticks < 100_000)
        {
            var month = match.State.Month;
            if (!phases.TryGetValue(month, out var seen)) phases[month] = seen = [];
            if (seen.Count == 0 || seen[^1] != match.State.Phase) seen.Add(match.State.Phase);
            match.Advance(1);
            ticks++;
        }

        match.State.Phase.Should().Be(Phase.Finished);
        phases.Keys.Should().Equal(Enumerable.Range(1, 12));
        phases[1].Should().Equal(Phase.Land, Phase.Development, Phase.Production, Phase.Event, Phase.Market, Phase.Standings);
        phases[2].Should().Equal(Phase.Land, Phase.Auction, Phase.Development, Phase.Production, Phase.Event, Phase.Market, Phase.Standings);
        match.State.History.Should().HaveCount(12);

        // A demo runs at four times speed: 5 to 8 minutes on the wall clock.
        var demoMinutes = ticks / (double)PoMuleTuning.TicksPerSecond / 4 / 60;
        demoMinutes.Should().BeInRange(5, 8);
    }

    private static void TheSameSeed_PlaysTheSameMatch_AndADifferentSeedDoesNot()
    {
        var first = PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1234).State);

        PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1234).State).Should().Be(first);
        PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1235).State).Should().NotBe(first);
    }

    /// <summary>Pins one whole match, so an accidental rules change shows up as a diff.</summary>
    [Fact]
    public Task Seed42_DemoMatch_FinalStandings()
    {
        var match = PoMuleMatch.RunToEnd(42);
        return Verifier.Verify(new
        {
            Standings = PoMuleScoring.Standings(match.State).Select(s => $"{s.Rank}. {s.Name} {s.NetWorth}"),
            match.State.CrisisMonths,
            StoreMules = match.State.Store.Mules,
            StorePrices = match.State.Store.Price,
        });
    }

    private static void ASaveTakenAtTheStartOfAMonth_RestoresItExactly_AndPlaysOnIdentically()
    {
        var original = PoMuleMatch.New(seed: 77, humanSpecies: Species.Humanoid, headless: true, fast: true);
        var stops = 0;
        while (original.State.Month < 3)
            if (original.Advance(500)) stops++;
        stops.Should().Be(2, "Advance stops at the start of each new month so it can be saved there");
        var json = PoMuleSave.ToJson(original.State);

        var restored = PoMuleSave.FromJson(json)!;
        restored.Month.Should().Be(3);
        restored.Phase.Should().Be(Phase.Land);
        restored.Players.Select(p => p.Cash).Should().Equal(original.State.Players.Select(p => p.Cash));
        restored.Players.SelectMany(p => p.Goods).Should().Equal(original.State.Players.SelectMany(p => p.Goods));
        restored.Owner.Should().Equal(original.State.Owner);
        restored.Installed.Should().Equal(original.State.Installed);
        restored.Store.Stock.Should().Equal(original.State.Store.Stock);
        restored.Map.Plots.Should().Equal(original.State.Map.Plots);

        var resumed = new PoMuleMatch(restored) { Headless = true, Fast = true };
        original.Advance(3000);
        resumed.Advance(3000);
        PoMuleSave.ToJson(resumed.State).Should().Be(PoMuleSave.ToJson(original.State));

        PoMuleSave.FromJson(null).Should().BeNull();
        PoMuleSave.FromJson("{ not json").Should().BeNull();
        PoMuleSave.FromJson(json.Replace("\"Version\":1", "\"Version\":0")).Should().BeNull("an older rules version is discarded");
    }

    private static void OverAHundredSeededMatches_NothingGoesNegative_TheStoreKeepsMules_AndNoPersonalityDominates()
    {
        var wins = new Dictionary<Archetype, int>();
        var survived = 0;
        for (ulong seed = 1; seed <= 100; seed++)
        {
            var match = PoMuleMatch.New(seed, humanSpecies: null, headless: true, fast: true);
            var mulesAfterMonthOne = -1;
            while (match.State.Phase != Phase.Finished)
            {
                match.Advance(50);
                var s = match.State;
                s.Players.Should().OnlyContain(p => p.Cash >= 0 && p.Goods.All(g => g >= 0), $"seed {seed} month {s.Month}");
                (s.Store.Mules >= 0 && s.Store.Stock.All(g => g >= 0)).Should().BeTrue($"seed {seed} month {s.Month}");
                if (mulesAfterMonthOne < 0 && s.Month == 2) mulesAfterMonthOne = s.Store.Mules;
            }

            mulesAfterMonthOne.Should().BeGreaterThanOrEqualTo(1, $"seed {seed}: the Store must not sell out in month 1");
            var standings = PoMuleScoring.Standings(match.State);
            var winner = match.State.Players[standings[0].Seat].Archetype;
            wins[winner] = wins.GetValueOrDefault(winner) + 1;
            if (PoMuleScoring.ColonySurvives(standings.Sum(x => x.NetWorth), match.State.CrisisMonths)) survived++;
        }

        var summary = $"colonies survived: {survived}; wins by personality: {string.Join(", ", wins.Select(w => $"{w.Key} {w.Value}"))}";
        survived.Should().BeInRange(40, 90, $"the colony should usually, but not always, pull through ({summary})");
        wins.Values.Max().Should().BeLessThanOrEqualTo(40, summary);
    }

    private static void TheLandGrant_SweepsAHighlighterRowByRow_AndGivesThePlotToWhoeverPressesOnIt()
    {
        var match = PoMuleMatch.New(seed: 8, humanSpecies: Species.Humanoid);
        var state = match.State;
        match.Advance(1);
        state.Phase.Should().Be(Phase.Land);

        // Top left first, then along the row and down, never backwards, skipping towns and owned plots.
        var visited = new List<int>();
        var wanted = -1;
        while (state.Phase == Phase.Land)
        {
            var cursor = state.LandCursor;
            if (cursor >= 0 && (visited.Count == 0 || visited[^1] != cursor)) visited.Add(cursor);
            // Row 3 has the towns; the player waits for the first plot of row 4 and presses there.
            if (cursor >= PoMuleMap.Index(0, 4) && wanted < 0 && !match.HasClaimed(0))
            {
                wanted = cursor;
                state.LandPicks[0] = cursor;
            }
            match.Advance(1);
        }

        visited[0].Should().Be(0, "the sweep starts at the top left");
        visited.Should().BeInAscendingOrder("left to right along a row, then the next row down");
        visited.Should().OnlyContain(i => state.Map.Plots[i].Terrain != Terrain.Town);
        visited.Zip(visited.Skip(1), (a, b) => b - a).Take(20).Should().OnlyContain(step => step >= 1 && step <= 3,
            "it moves one plot at a time, hopping only over plots that cannot be claimed");
        state.Owner[wanted].Should().Be((sbyte)0, "pressing while a plot is lit claims it");
        state.Owner.Count(o => o == 0).Should().Be(1, "one plot a month");
        state.Owner.Count(o => o != MatchState.Nobody).Should().Be(PoMuleTuning.Seats, "every AI pressed on the plot it was waiting for");
        (state.LandCursor, state.LandPicks.All(p => p == -1)).Should().Be((-1, true), "nothing carries into next month");

        // A press on a plot the highlighter left more than a step ago is too late.
        var late = PoMuleMatch.New(seed: 8, humanSpecies: Species.Humanoid);
        late.Advance(1);
        while (late.State.LandCursor < 12) late.Advance(1);
        late.State.LandPicks[0] = 2;
        late.Advance(1);
        late.State.Owner[2].Should().NotBe((sbyte)0);
    }

    /// <summary>The touches carried over from the 1983 game.</summary>
    private static void LuckTheMeteorTheWampusAndThePlotByPlotCount_WorkAsInTheOriginal()
    {
        // Personal luck: good luck never finds the leader, bad luck never the colonist in
        // last place, nobody is ever pushed below zero, and every line fits the message bar.
        var luck = MatchState.New(seed: 5, humanSpecies: null);
        for (var roll = 0; roll < 300; roll++)
        {
            for (var seat = 0; seat < 8; seat++) luck.Players[seat].Cash = roll < 150 ? 1000 + seat * 100 : 10;
            var rank = PoMuleScoring.Standings(luck).ToDictionary(s => s.Seat, s => s.Rank);
            var (lucky, kind, amount) = PoMuleEvents.Luck(luck);
            if (kind < LuckKind.Elves) rank[lucky].Should().BeGreaterThan(1, "good luck never finds the leader");
            else rank[lucky].Should().BeLessThan(8, "bad luck never finds last place");
            luck.Players[lucky].Cash.Should().BeGreaterThanOrEqualTo(0);
            luck.Players[lucky].Goods.Should().OnlyContain(units => units >= 0);
            PoMuleEvents.LuckText(kind, "Industrialist", amount).Length.Should().BeLessThanOrEqualTo(63);
        }

        // The meteor digs a rich crater in open, unowned ground.
        var meteor = MatchState.New(seed: 6, humanSpecies: null);
        PoMuleEvents.Aftermath(meteor, ColonyEvent.Meteor);
        meteor.EventPlot.Should().BeGreaterThanOrEqualTo(0);
        meteor.Map.Plots[meteor.EventPlot].Should().Be(new Plot(Terrain.Crater, 0, 4));
        meteor.Owner[meteor.EventPlot].Should().Be(MatchState.Nobody);

        // Production reports each plot's units, for the dot-by-dot count on the map.
        var farm = MatchState.New(seed: 7, humanSpecies: Species.Humanoid);
        farm.Map.Plots[0] = new Plot(Terrain.River, 0, 0);
        farm.Map.Plots[1] = new Plot(Terrain.Plains, 0, 0);
        (farm.Owner[0], farm.Owner[1]) = (0, 0);
        (farm.Installed[0], farm.Installed[1]) = ((sbyte)Good.Food, (sbyte)Good.Energy);
        var report = PoMuleProduction.Run(farm, ColonyEvent.None, vary: false);
        (report.PlotOutput[0], report.PlotOutput[1], report.PlotOutput.Sum()).Should().Be((4, 3, 7));

        // Radiation sends one working M.U.L.E. crazy and leaves its plot empty.
        PoMuleEvents.Aftermath(farm, ColonyEvent.Radiation);
        farm.EventPlot.Should().BeOneOf(0, 1);
        farm.Installed[farm.EventPlot].Should().Be(MatchState.Nobody);
        farm.Installed.Count(i => i != MatchState.Nobody).Should().Be(1);

        // The wampus shows on a mountain for part of every ten seconds and pays once a month.
        var match = PoMuleMatch.New(seed: 8, humanSpecies: Species.Humanoid);
        var state = match.State;
        while (state.Phase != Phase.Development) match.Advance(1);
        match.Advance(1);
        match.CatchWampus(0).Should().Be(0, "it is not showing yet");
        var waited = 0;
        while (state.WampusPlot < 0 && waited++ < PoMuleTuning.WampusCycleTicks) match.Advance(1);
        state.Map.Plots[state.WampusPlot].Terrain.Should().Be(Terrain.Mountain);
        match.Snapshot()[20].Should().Be(state.WampusPlot);
        var cash = state.Players[0].Cash;
        match.CatchWampus(0).Should().Be(PoMuleTuning.WampusBounty(1));
        state.Players[0].Cash.Should().Be(cash + 100);
        match.Notices.Should().Contain(new Notice(NoticeKind.WampusCaught, 0, 100));
        match.CatchWampus(0).Should().Be(0, "one wampus a month");
        match.Advance(200);
        state.WampusPlot.Should().Be(-1, "caught, it does not come back this month");
        (PoMuleTuning.WampusBounty(5), PoMuleTuning.WampusBounty(12)).Should().Be((200, 300));
    }

    /// <summary>
    /// F10: the server replays a played match from its seed and action log (PoMuleRunVerifier),
    /// across a save and resume too, and only the true result verifies.
    /// </summary>
    [Theory]
    [InlineData("honest", true)]
    [InlineData("resumed", true)]
    [InlineData("empty-log", false)]
    [InlineData("wrong-seed", false)]
    [InlineData("garbage", null)]
    [InlineData("bad-species", null)]
    public void APlayedMatch_ReplaysFromItsSeedAndLog_AndOnlyTheTrueResultVerifies(string variant, bool? matches)
    {
        const ulong seed = 31;
        var rng = new Random(5);
        var match = PoMuleMatch.New(seed, Species.Humanoid);
        while (match.State.Phase != Phase.Finished)
        {
            var s = match.State;
            var me = s.Players[0];
            // The renderer's reports, and a human pressing things at irregular moments.
            switch (s.Phase)
            {
                case Phase.Land when s.LandCursor >= 0 && rng.Next(8) == 0: match.PickLand(s.LandCursor); break;
                case Phase.Auction or Phase.Market when rng.Next(12) == 0: match.HumanMarketInput = rng.Next(3) - 1; break;
                case Phase.Standings when rng.Next(20) == 0: match.SkipStandings(); break;
                case Phase.Development:
                    if (rng.Next(25) == 0) for (var seat = 1; seat < PoMuleTuning.Seats; seat++) match.Arrive(seat);
                    if (rng.Next(60) == 0) match.Bump(rng.Next(PoMuleTuning.Seats), dashing: true);
                    if (s.WampusPlot >= 0 && rng.Next(10) == 0) match.CatchWampus(0);
                    var mine = Array.IndexOf(s.Owner, (sbyte)0);
                    if (!me.HasMule && rng.Next(40) == 0) { match.BuyMule(); match.Outfit((Good)rng.Next(4)); }
                    else if (me.HasMule && me.Outfit >= 0 && mine >= 0 && rng.Next(30) == 0) match.Install(mine);
                    else if (rng.Next(200) == 0) { match.VisitAssay(); match.Survey(rng.Next(s.Owner.Length)); }
                    break;
            }
            if (s.Phase == Phase.Market && rng.Next(40) == 0) match.SetRole((sbyte)(rng.Next(3) - 1));
            // The browser saves at a month start; "resumed" carries on from the reloaded save.
            if (match.Advance(1 + rng.Next(3)) && variant == "resumed" && s.Month == 5)
                match = new PoMuleMatch(PoMuleSave.FromJson(PoMuleSave.ToJson(s))!);
        }

        var standings = PoMuleScoring.Standings(match.State);
        var played = new PoMuleReplayed(standings.First(x => x.Seat == 0).NetWorth,
            PoMuleScoring.ColonySurvives(standings.Sum(x => x.NetWorth), match.State.CrisisMonths));
        var log = match.ActionLog;
        log.Should().MatchRegex("^[0-9a-z]+[A-M]-?[0-9a-z]+(\\.[0-9a-z]+[A-M]-?[0-9a-z]+)+$");
        match.State.Recorded.Should().BeTrue();

        var replayed = variant switch
        {
            "empty-log" => PoMuleRunVerifier.Replay(seed, (int)Species.Humanoid, false, ""),
            "wrong-seed" => PoMuleRunVerifier.Replay(seed + 1, (int)Species.Humanoid, false, log),
            "garbage" => PoMuleRunVerifier.Replay(seed, (int)Species.Humanoid, false, "3kB2.zz!"),
            "bad-species" => PoMuleRunVerifier.Replay(seed, PoMuleSpecies.All.Count, false, log),
            _ => PoMuleRunVerifier.Replay(seed, (int)Species.Humanoid, false, log),
        };
        if (matches is null) replayed.Should().BeNull();
        else (replayed == played).Should().Be(matches.Value, $"{variant}: played {played}, replayed {replayed}");
    }

    private static void WithARenderer_TheMatchWaitsForArrivals_AndFeedsOneFlatSnapshot()
    {
        var match = PoMuleMatch.New(seed: 8, humanSpecies: Species.Humanoid);
        var state = match.State;
        while (state.Phase != Phase.Development) match.Advance(1);
        match.Advance(1);
        var ai = state.Players.First(p => p.Archetype == Archetype.Farmer).Seat;
        var plot = Array.IndexOf(state.Owner, (sbyte)ai);
        plot.Should().BeGreaterThanOrEqualTo(0, "every AI claimed land in month 1");

        // Nothing happens to an AI until the renderer says it got there.
        match.Advance(100);
        state.Installed[plot].Should().Be(MatchState.Nobody);
        match.Goals[ai].Kind.Should().Be(GoalKind.Outfitter);
        match.Arrive(ai);
        match.Advance(1);
        match.Goals[ai].Should().Be(new Goal(GoalKind.Install, plot, (Good)state.Players[ai].Outfit));
        match.Arrive(ai);
        state.Installed[plot].Should().NotBe(MatchState.Nobody);

        var snap = match.Snapshot();
        snap.Should().HaveCount(PoMuleMatch.SnapshotHeader + PoMuleMatch.SnapshotPerSeat * PoMuleTuning.Seats);
        (snap[0], snap[1], snap[2]).Should().Be((1d, (double)(int)Phase.Development, (double)state.ClockTicks));
        var o = PoMuleMatch.SnapshotHeader + ai * PoMuleMatch.SnapshotPerSeat;
        snap[o].Should().Be(state.Players[ai].Cash);
        snap[o + 5].Should().Be(PoMuleDevelopment.Speed(state, ai));
        snap[o + 15].Should().Be(PoMuleDevelopment.TimeLeft(state, ai));

        // A dash bump from the renderer costs the victim its M.U.L.E.; the human's pub visit ends the wait.
        PoMuleDevelopment.BuyMule(state, 0).Should().Be(Outcome.Ok);
        match.Bump(victim: 0, dashing: true).Should().BeTrue();
        match.Notices.Should().Contain(new Notice(NoticeKind.MuleRanAway, 0));
        match.HumanPub().Should().BeGreaterThan(0);
        state.Players[0].InPub.Should().BeTrue();
    }
}
