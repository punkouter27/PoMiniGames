using FluentAssertions;
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoCabinet;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

/// <summary>PoCabinet's scripted talk, its one circuit's features, the AI and the physics under
/// it, the one lobby, and the per-tick wire budget.</summary>
/// <remarks>In the time-budget collection: its full-field replays and laps load the machine for
/// seconds, and the board AI's tests there time their moves (BoardAiTests.HardBeatsEasy failed
/// beside them about one run in three).</remarks>
[Collection(PoMiniGames.Unit.Features.BoardAi.TimeBudgetGroup.Name)]
public class PoCabinetTests
{
    private static readonly string[] ExpectedMoments = ["finish", "lead", "passed", "preRace"];
    private static readonly System.Text.Json.JsonSerializerOptions SnapshotJsonOptions = CreateSnapshotOptions();

    private static System.Text.Json.JsonSerializerOptions CreateSnapshotOptions()
    {
        var o = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
        o.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase));
        return o;
    }
    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers))]
    [InlineData(nameof(TheCircuitShipsItsFeatures_AndTheServerReadsTheSameRoad))]
    [InlineData(nameof(TheCatalogHasTwoTracks_AndRetiredIdsStayUnknown))]
    [InlineData(nameof(TheHouseWorld_IsAnIndoorClosedLoopOnTheScan))]
    [InlineData(nameof(EachOfficial_LapsOnItsOwnLine_AndAHumanCarObeysInputsAndTheBarrier))]
    [InlineData(nameof(TheLapVerifier_ReplaysOnTheSubmittedTrack_AndTheHouseIsAlwaysDry))]
    [InlineData(nameof(EachTrackHasItsOwnPartitionAndBoard_AndAnUnknownIdHasNone))]
    [InlineData(nameof(Contacts_AreImpulsesBetweenCarShapedHulls))]
    [InlineData(nameof(Lobby_FirstArrivalHosts_LaterArrivalsShareIt_AndBouncesAtCap))]
    [InlineData(nameof(PerTickSnapshot_FitsTwoKilobytes_AtEightCars))]
    [InlineData(nameof(TheRadioSpeaksUnlessSwitchedOff_AndAnOlderStoreStillSpeaks))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    /// <summary>
    /// "Radio voices" (the officials' lines, spoken) is on by default, a store written before the
    /// setting existed reads as on, and off survives the round trip under the key the engine reads.
    /// </summary>
    private static void TheRadioSpeaksUnlessSwitchedOff_AndAnOlderStoreStillSpeaks()
    {
        new PoCabinetUiSettings().RadioVoice.Should().BeTrue();
        PoCabinetUiSettings.FromJson("""{"music":false}""").RadioVoice.Should().BeTrue("an older store has no radioVoice key");

        var off = PoCabinetUiSettings.FromJson("""{"radioVoice":false}""");
        off.RadioVoice.Should().BeFalse();
        off.ToJs().GetProperty("radioVoice").GetBoolean().Should().BeFalse("audio.js reads the camelCase key");
        PoCabinetUiSettings.FromJson(off.ToJson()).RadioVoice.Should().BeFalse();
    }

    /// <summary>
    /// The scripted pool covers every official and every race.js moment, a line is picked
    /// deterministically by (official, kind, tick), and the debrief turns the numbers into the
    /// tips they justify.
    /// </summary>
    private static void ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers()
    {
        PoCabinetTalk.Banter.Keys.Should().BeEquivalentTo(PoCabinetCatalog.Officials.Select(o => o.Id));
        PoCabinetTalk.Banter.Values.Should().OnlyContain(byMoment =>
            byMoment.Keys.Order().SequenceEqual(ExpectedMoments) && byMoment.Values.All(lines => lines.Count > 0));

        var line = PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12);
        Enumerable.Range(0, 50).Should().OnlyContain(_ => PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12) == line,
            "the same (official, kind, raceTick) always plays the same line");
        PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 0).Should().NotBe(PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 999));
        PoCabinetDialogue.PickLine("unknown-official", DialogueKind.PreRace, 0).Should().BeEmpty("no line, no bubble");

        var slow = PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts(
            "Cabinet Grand Prix", 4, [0.1, 0.9, -0.2], FullThrottlePct: 40, BrakePct: 10, SlowestKmh: 150, WorstPointPct: 45, WallHits: 2));
        slow.Tips.Should().HaveCount(3);
        slow.Tips[0].Should().Contain("Sector 2").And.Contain("0.90");
        slow.Tips[1].Should().Contain("Sector 3").And.Contain("quicker");
        slow.Tips[2].Should().Contain("2 barrier hits");
        slow.Headline.Should().Contain("P4");

        // No reference lap: the tip says where the time went instead.
        PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts("Cabinet Grand Prix", 1, [], 80, 10, 120, 45, 0))
            .Tips.Should().ContainSingle().Which.Should().Contain("45%");

        // A wreck is never "a clean race", even with no barrier hit (car contact did it).
        var wreck = PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts("Cabinet Grand Prix", 29, [], 90, 5, 120, -1, 0, Wrecked: true));
        wreck.Tips[0].Should().Contain("wrecked");
        wreck.Tips.Should().NotContain(t => t.Contains("clean race"));
        wreck.Headline.Should().Contain("WRECK");
    }

    /// <summary>
    /// The circuit's world carries a value per centerline sample for each feature (width,
    /// run-off, kerbs, racing line, heights), it has the features its lap is built from (hills,
    /// apex kerbs with raised ones at the chicane, a gravel trap, tarmac run-off, one divider
    /// with a tapered nose: the joker lane), and the server's runtime track reads the very same
    /// values the browser is handed.
    /// </summary>
    private static void TheCircuitShipsItsFeatures_AndTheServerReadsTheSameRoad()
    {
        var def = PoCabinetTrackGeometry.Get();
        var world = PoCabinetTrackGeometry.BuildStaticWorld(def);
        int n = world.CenterXY.Count / 2;
        new[] { world.HalfWidths.Count, world.RunoffLeft.Count, world.RunoffRight.Count, world.Kerbs.Count, world.RacingLine.Count, world.CenterZ.Count }
            .Should().AllBeEquivalentTo(n, "every feature ships per sample");
        world.HalfWidths.Should().OnlyContain(hw => hw > 25);
        world.CenterZ.Should().Contain(z => z != 0, "the circuit has hills");
        world.Kerbs.Should().Contain(k => Math.Abs(k) == 1, "apex kerbs").And.Contain(k => Math.Abs(k) == 2, "the chicane has raised kerbs");
        var runoff = world.RunoffLeft.Concat(world.RunoffRight).ToList();
        runoff.Should().Contain((int)PoCabinetRunoff.Gravel, "gravel and sand traps").And.Contain((int)PoCabinetRunoff.Tarmac, "tarmac run-off");
        world.TotalLaps.Should().Be(def.Laps).And.BeGreaterThan(0);
        world.TrackId.Should().Be(PoCabinetCatalog.DefaultTrackId);
        world.TrackName.Should().Be(PoCabinetCatalog.Track.Name);

        var track = PoCabinetTrack.Get();
        track.Laps.Should().Be(def.Laps);
        Enumerable.Range(0, n).Should().OnlyContain(i =>
            track.HalfWidthAt(i) == world.HalfWidths[i] && track.KerbAt(i) == world.Kerbs[i]
            && track.RunoffAt(i, -1) == world.RunoffLeft[i] && track.RunoffAt(i, 1) == world.RunoffRight[i],
            "the server races the road the browser draws");

        // The divider: its own lane either side, a point at each end, and the AI and the physics
        // both know where it stands.
        track.Islands.Should().ContainSingle("one joker lane");
        var isl = track.Islands[0];
        track.IslandIndexAt(isl.From).Should().Be(0);
        (track.IslandHi(isl.From) - track.IslandLo(isl.From)).Should().BeLessThan(isl.LatTo - isl.LatFrom, "the nose tapers");
        int mid = (isl.From + isl.To) / 2;
        (track.IslandHi(mid) - track.IslandLo(mid)).Should().Be(isl.LatTo - isl.LatFrom);
        track.IslandIndexAt((isl.To + 1) % track.Count).Should().Be(-1);

        // The scenery zones cover the lap once each sample, and all four are there.
        var zoned = new int[n];
        foreach (var z in world.Zones)
        {
            for (int i = z.From; i != z.To; i = (i + 1) % n) zoned[i]++;
        }
        zoned.Should().OnlyContain(c => c == 1, "every sample is in exactly one zone");
        world.Zones.Select(z => z.Theme).Distinct().Should().BeEquivalentTo(["capitol", "senate", "court", "maralago"]);

        // The scanned court: the lap crosses the part of it that is drawn, level and a hand over
        // its floor (the scan's floor is lumpy), clear of both hoop poles (14.5 m out on its axis),
        // on tarmac run-off; and no other stretch of the lap comes near it, because inside that
        // rectangle the scene's own ground steps down.
        var scan = world.Scan!;
        scan.Should().NotBeNull();
        double hx = scan.HalfLength * scan.Scale, hy = scan.HalfWidth * scan.Scale;
        var on = Enumerable.Range(0, n)
            .Where(i => Math.Abs(world.CenterXY[i * 2] - scan.X) < hx && Math.Abs(world.CenterXY[i * 2 + 1] - scan.Y) < hy)
            .ToList();
        on.Should().NotBeEmpty("the lap drives across the scan");
        on.Should().BeInAscendingOrder().And.HaveCount(on[^1] - on[0] + 1, "it crosses the scan once");
        var court = world.Zones.Single(z => z.Theme == "court");
        on.Should().OnlyContain(i => i >= court.From && i < court.To, "the court zone holds the whole crossing");
        on.Should().OnlyContain(i => world.CenterZ[i] == scan.FloorZ + 10 && world.CenterBank[i] == 0, "the road over the court is level");
        on.Should().OnlyContain(i => world.RunoffLeft[i] == (int)PoCabinetRunoff.Tarmac && world.RunoffRight[i] == (int)PoCabinetRunoff.Tarmac);
        const double BarrierFace = 40 + 3;   // tarmac run-off and the barrier's thickness
        foreach (int side in new[] { -1, 1 })
        {
            double poleX = scan.X + side * 14.5 * scan.Scale;
            on.Should().OnlyContain(
                i => Math.Sqrt(Math.Pow(world.CenterXY[i * 2] - poleX, 2) + Math.Pow(world.CenterXY[i * 2 + 1] - scan.Y, 2)) > world.HalfWidths[i] + BarrierFace + 25,
                "the barrier stands clear of the hoop's pole");
        }
    }

    /// <summary>
    /// The catalog has two tracks, the Grand Prix first. Only their ids are tracks a lap may be
    /// posted on (any casing, canonical id back), so a lap parked on a track the game used to
    /// have is refused; every geometry lookup of any other id returns the Grand Prix.
    /// </summary>
    private static void TheCatalogHasTwoTracks_AndRetiredIdsStayUnknown()
    {
        var track = PoCabinetCatalog.Track;
        PoCabinetCatalog.Tracks.Select(t => t.Id).Should().Equal("grandprix", "house");
        track.Id.Should().Be(PoCabinetCatalog.DefaultTrackId).And.Be(PoCabinetTrackGeometry.TrackId);
        track.Name.Should().Be("Cabinet Grand Prix");
        PoCabinetCatalog.House.Id.Should().Be(PoCabinetCatalog.HouseTrackId).And.Be("house");
        PoCabinetCatalog.House.Name.Should().Be("House Party");
        PoCabinetCatalog.GetTrack("capitol").Should().BeSameAs(track);
        PoCabinetCatalog.GetTrack(null).Should().BeSameAs(track);
        PoCabinetCatalog.GetTrack(" HOUSE ").Should().BeSameAs(PoCabinetCatalog.House);

        PoCabinetCatalog.IsKnownTrack(track.Id).Should().BeTrue();
        PoCabinetCatalog.IsKnownTrack(" " + track.Id.ToUpperInvariant() + " ").Should().BeTrue();
        PoCabinetCatalog.KnownTrackId(" House ").Should().Be("house");
        PoCabinetCatalog.KnownTrackId("GRANDPRIX").Should().Be("grandprix");
        foreach (var gone in new[] { "capitol", "maralago", "pressbriefing", "playground", "senate", "bedroom", "court", "daily-20261019", "daily-20261101", "", null })
        {
            PoCabinetCatalog.IsKnownTrack(gone).Should().BeFalse($"'{gone}' is not a track any more");
            PoCabinetCatalog.KnownTrackId(gone).Should().BeNull();
        }

        PoCabinetTrackGeometry.Get("capitol").Should().BeSameAs(PoCabinetTrackGeometry.Get());
        PoCabinetTrackGeometry.Get().Id.Should().Be(track.Id);
        PoCabinetTrackGeometry.Get("HOUSE").Id.Should().Be("house");
        PoCabinetTrack.Get().Id.Should().Be("grandprix", "online races ask for no track");
        PoCabinetTrack.Get("house").Id.Should().Be("house");
        PoCabinetTrack.Get("house").Should().BeSameAs(PoCabinetTrack.Get("HOUSE"), "one runtime track per id");
        PoCabinetTrack.Get("capitol").Should().BeSameAs(PoCabinetTrack.Get());
        new PoCabinetScoreDto().TrackId.Should().Be(track.Id, "a client that sends no track means the circuit");
    }

    /// <summary>
    /// The house: its own id and name, two laps, the house theme and scan, a road that climbs from
    /// the floor to six feet (1464 units) and never dips below it, and a centerline that closes.
    /// </summary>
    private static void TheHouseWorld_IsAnIndoorClosedLoopOnTheScan()
    {
        var def = PoCabinetTrackGeometry.Get("house");
        def.Laps.Should().Be(2);
        var world = PoCabinetTrackGeometry.BuildStaticWorld("house");
        world.TrackId.Should().Be("house");
        world.TrackName.Should().Be(PoCabinetCatalog.House.Name);
        world.TotalLaps.Should().Be(2);
        world.Theme.Should().Be("house");
        world.Scan.Should().NotBeNull();
        world.Scan!.Id.Should().Be("house");
        PoCabinetTrackGeometry.BuildStaticWorld("grandprix").Scan!.Id.Should().Be("court");

        // A 100-second lap, so running wide costs speed there, not the lap; the Grand Prix keeps its limits.
        world.TrackLimits.Should().BeFalse();
        PoCabinetTrack.Get("house").TrackLimits.Should().BeFalse();
        PoCabinetPhysics.Beyond(PoCabinetTrack.Get("house"), 0, 500).Should().BeFalse("no lap is voided for running wide in the house");
        PoCabinetTrackGeometry.BuildStaticWorld("grandprix").TrackLimits.Should().BeTrue();
        PoCabinetPhysics.Beyond(PoCabinetTrack.Get(), 0, 500).Should().BeTrue();

        int n = world.CenterXY.Count / 2;
        world.CenterZ.Should().HaveCount(n).And.OnlyContain(z => z >= 0, "the road never dips below the floor");
        world.CenterZ.Max().Should().BeInRange(1450, 1480, "the road climbs to six feet (1464 units)");
        world.Zones.Should().OnlyContain(z => z.Theme == "house");

        // Closed: the gap from the last sample back to the first is one more step of the road.
        double Gap(int a, int b) => Math.Sqrt(Math.Pow(world.CenterXY[a * 2] - world.CenterXY[b * 2], 2) + Math.Pow(world.CenterXY[a * 2 + 1] - world.CenterXY[b * 2 + 1], 2));
        double meanStep = Enumerable.Range(0, n - 1).Average(i => Gap(i, i + 1));
        Gap(n - 1, 0).Should().BeLessThan(meanStep * 2, "the loop closes on itself");
    }

    /// <summary>
    /// Each of the four officials, alone on the circuit, completes a lap through the real physics
    /// on its own line (every pair's mean lateral offset over the lap differs by ≥ 8 units); on
    /// the house each completes a lap unwrecked in 70 to 200 s; a
    /// human car flat out on full right lock ends up pinned at the barrier, never through it, and
    /// every applied input's sequence number is acknowledged.
    /// </summary>
    private static void EachOfficial_LapsOnItsOwnLine_AndAHumanCarObeysInputsAndTheBarrier()
    {
        const double dt = 1.0 / 30.0;
        var laterals = new Dictionary<string, double>();
        foreach (var o in PoCabinetPersonality.Roster)
        {
            var house = new PoCabinetSim(seed: 42,
                [new PoCabinetDriver("bot", PoCabinetCatalog.OfficialName(o.Id), IsPlayer: false, o.Color, o.Personality, o.MaxSpeed, o.CorneringSkill, o.Id)],
                PoCabinetCatalog.HouseTrackId);
            house.TrackId.Should().Be("house");
            var hcar = house.SnapshotCars()[0];
            for (var i = 0; i < 30 * 300 && hcar.LapsDone < 1; i++) house.Tick(dt, new Dictionary<string, PoCabinetInput>());
            hcar.LapsDone.Should().Be(1, $"{o.Id} completes the house lap");
            hcar.Wrecked.Should().BeFalse($"{o.Id} does not wreck on the house");
            hcar.LapStartTime.Should().BeInRange(70, 200, $"{o.Id}'s house lap is a sane time");

            var sim = new PoCabinetSim(seed: 42,
                [new PoCabinetDriver("bot", PoCabinetCatalog.OfficialName(o.Id), IsPlayer: false, o.Color, o.Personality, o.MaxSpeed, o.CorneringSkill, o.Id)]);
            var car = sim.SnapshotCars()[0];
            var series = new List<double>();
            // A lap at a crawl (40 units/s) is the longest this waits.
            double lap = sim.Track.LapLength;
            for (var i = 0; i < 30 * lap / 40 && car.LapsDone < 1; i++)
            {
                sim.Tick(dt, new Dictionary<string, PoCabinetInput>());
                // The settled part of the lap, past the grid and the first turn-in.
                if (car.Distance > 150) series.Add(car.Lateral);
            }
            car.LapsDone.Should().Be(1, $"{o.Id} completes a lap under the real physics");
            // A wild lap may break track limits (no best lap), but the clock still ran: slower
            // than flat out all the way round, quicker than half that pace.
            car.LapStartTime.Should().BeInRange(lap / PoCabinetPhysics.MaxSpeed, lap / (PoCabinetPhysics.MaxSpeed * 0.5),
                $"{o.Id}'s lap is a plausible arcade lap");
            laterals[o.Id] = series.Average();
        }
        foreach (var a in laterals)
        {
            foreach (var b in laterals.Where(b => string.CompareOrdinal(a.Key, b.Key) < 0))
                Math.Abs(a.Value - b.Value).Should().BeGreaterThanOrEqualTo(8, $"{a.Key} and {b.Key} hold visibly different lines");
        }

        var human = new PoCabinetSim(seed: 1, [new PoCabinetDriver("me", "Me", IsPlayer: true, "#fff", null)]);
        var me = human.SnapshotCars()[0];
        for (var seq = 1; seq <= 150; seq++)
        {
            human.Tick(dt, new Dictionary<string, PoCabinetInput> { ["me"] = new() { Throttle = 1, Steer = 1, Seq = seq } });
            var wall = PoCabinetPhysics.WallAt(human.Track, me.SegHint, me.Lateral > 0 ? 1 : -1);
            Math.Abs(me.Lateral).Should().BeLessThanOrEqualTo(wall + 0.5, "no car passes through the barrier");
        }
        me.AckSeq.Should().Be(150, "every applied input is acknowledged");
        me.Speed.Should().BeGreaterThan(0, "throttle moves the car");
    }

    /// <summary>
    /// A solo lap replays on the track it was submitted for, and the house never rains: a wet
    /// replay there is the dry one, and an id no track has races the Grand Prix.
    /// </summary>
    private static void TheLapVerifier_ReplaysOnTheSubmittedTrack_AndTheHouseIsAlwaysDry()
    {
        // One second of race, not a lap: each replay steps all 64 cars, and a longer one here
        // (600 ticks, then 150) made the board AI's test beside it fail: its "hard" player has
        // 15 ms a move, and loses when this is using the machine.
        var inputs = Enumerable.Repeat(new PoCabinetControls(1, 0, 0), 30).ToArray();
        var dry = PoCabinetLapVerifier.Replay("house", false, inputs);
        PoCabinetLapVerifier.Replay("house", true, inputs).Should().Be(dry, "indoors the wet flag is ignored");
        PoCabinetLapVerifier.Replay("HOUSE", false, inputs).Should().Be(dry, "ids are matched in any casing");
        dry.BestLapSeconds.Should().Be(-1, "a second of throttle is not a lap");
        dry.Position.Should().BeInRange(1, PoCabinetCatalog.SoloCarCount);

        var grandPrix = PoCabinetLapVerifier.Replay(PoCabinetCatalog.DefaultTrackId, false, inputs);
        PoCabinetLapVerifier.Replay(null, false, inputs).Should().Be(grandPrix, "no track id is the Grand Prix");
        grandPrix.BestLapSeconds.Should().Be(-1);
    }

    /// <summary>
    /// Each track's laps live in a partition of their own ("pocabinet_grandprix", "pocabinet_house"),
    /// no id is the Grand Prix, an id no track has is no partition at all, and the leaderboard's
    /// board ids and titles follow the track ("pocabinet" stays the Grand Prix's).
    /// </summary>
    private static void EachTrackHasItsOwnPartitionAndBoard_AndAnUnknownIdHasNone()
    {
        StorageService.PoCabinetTrackPartition(null).Should().Be("pocabinet_grandprix");
        StorageService.PoCabinetTrackPartition("grandprix").Should().Be("pocabinet_grandprix");
        StorageService.PoCabinetTrackPartition(" HOUSE ").Should().Be("pocabinet_house");
        foreach (var gone in new[] { "capitol", "bedroom", "daily-20261101", "pocabinet" })
            StorageService.PoCabinetTrackPartition(gone).Should().BeNull($"'{gone}' never gets a partition");

        UnifiedLeaderboardEndpoints.PoCabinetBoardKey("grandprix").Should().Be("pocabinet");
        UnifiedLeaderboardEndpoints.PoCabinetBoardKey("house").Should().Be("pocabinet-house");
        UnifiedLeaderboardEndpoints.PoCabinetBoardTitle("grandprix").Should().Be("Cabinet");
        UnifiedLeaderboardEndpoints.PoCabinetBoardTitle("house").Should().Be("Cabinet: House Party");
    }

    /// <summary>
    /// A contact is an impulse between car-shaped hulls: momentum is kept, a centred hit moves
    /// nobody sideways, an off-centre one shoves and turns both cars, and cars on different
    /// levels of a crossing do not touch.
    /// </summary>
    private static void Contacts_AreImpulsesBetweenCarShapedHulls()
    {
        var track = PoCabinetTrack.Get();
        static PoCabinetCarBody Car(double x, double y, double speed) => new() { X = x, Y = y, Speed = speed };

        // Nose to tail, dead centre: equal masses and restitution 0.2 turn 100 into 60 as 76 and
        // 84. The hulls are 39 long, so 36 apart is already a hit.
        var rear = Car(0, 0, 100);
        var front = Car(36, 0, 60);
        PoCabinetPhysics.ResolveContacts(track, [rear, front]);
        rear.Speed.Should().BeApproximately(76, 1e-9);
        front.Speed.Should().BeApproximately(84, 1e-9);
        (rear.Slip, rear.Spin, front.Slip, front.Spin).Should().Be((0d, 0d, 0d, 0d), "a centred hit shoves nobody sideways");

        var tapper = Car(0, 0, 100);
        var tapped = Car(30, 14, 60);
        PoCabinetPhysics.ResolveContacts(track, [tapper, tapped]);
        (tapper.Speed + tapped.Speed).Should().BeApproximately(160, 1e-9);
        (tapper.Slip + tapped.Slip).Should().BeApproximately(0, 1e-9);
        tapped.Slip.Should().BeGreaterThan(1, "the car hit on its left rear corner is pushed right");
        tapped.Spin.Should().NotBe(0, "an off-centre hit turns the car");
        tapper.Spin.Should().NotBe(0);

        var above = Car(0, 0, 100);
        var below = Car(36, 0, 60);
        below.Along = 500;
        PoCabinetPhysics.ResolveContacts(track, [above, below]);
        (above.Speed, below.Speed).Should().Be((100d, 60d), "two levels of a crossing never touch");

        // Heavier van (style 3, mass 1.35) vs lighter hatchback (style 1, mass 0.90): momentum conserved, van loses less speed.
        var van = Car(0, 0, 100);
        PoCabinetPhysics.SetStyle(van, 3);
        var hatch = Car(36, 0, 60);
        PoCabinetPhysics.SetStyle(hatch, 1);
        double momentumBefore = van.Mass * van.Speed + hatch.Mass * hatch.Speed;
        PoCabinetPhysics.ResolveContacts(track, [van, hatch]);
        (van.Mass * van.Speed + hatch.Mass * hatch.Speed).Should().BeApproximately(momentumBefore, 1e-6);
        (100 - van.Speed).Should().BeLessThan(hatch.Speed - 60, "heavier style transfers more delta-v to lighter style");

        // Continuous 2-substep integration keeps a flat-out car inside barrier limits without tunneling.
        var wallCar = Car(0, 0, PoCabinetPhysics.MaxSpeed);
        PoCabinetPhysics.GridSlot(track, wallCar, 0);
        wallCar.Speed = PoCabinetPhysics.MaxSpeed;
        for (int t = 0; t < 90; t++)
        {
            PoCabinetPhysics.Step(track, wallCar, new PoCabinetControls(1, 0, 1), PoCabinetPhysics.TickSeconds, 1);
            double limit = PoCabinetPhysics.WallAt(track, wallCar.SegHint, wallCar.Lateral > 0 ? 1 : -1);
            Math.Abs(wallCar.Lateral).Should().BeLessThanOrEqualTo(limit + 1e-6, "2-substep CCD stops barrier clipping");
        }
    }

    /// <summary>
    /// There is one lobby and no join codes: the first arrival hosts, the next arrivals share it,
    /// the ninth is bounced. Ready toggling, the start rule, host migration, the AI filling the grid
    /// to 64 cars, the generic host kick, the rematch loop with its ready timeout, and AI
    /// officials filling free seats so a lone host can race all hold, on the shared LobbyRoom.
    /// </summary>
    private static void Lobby_FirstArrivalHosts_LaterArrivalsShareIt_AndBouncesAtCap()
    {
        var clock = new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.UtcNow);
        var room = new PoCabinetLobbyService(clock);
        room.State.Players.Should().BeEmpty("nobody has arrived yet");
        room.Open("c-h", "Alice", false, "host");
        room.HostConnectionId.Should().Be("c-h", "the first arrival hosts");
        room.Open("c-2", "Bob", false, "p2");
        room.State.Players.Should().HaveCount(2);
        for (var i = 3; i <= 8; i++) room.Open($"c-{i}", $"Player{i}", false, $"p{i}").state.Players.Should().Contain(p => p.ConnectionId == $"c-{i}");
        room.Open("c-9", "Eve", false, "p9").message.Should().Be("Lobby is full");
        room.State.Players.Should().HaveCount(PoCabinetCatalog.CarCount, "eight seats, no more");

        System.Text.Json.JsonSerializer.Serialize(room.State.Players[0]).Should().NotContainEquivalentOf("trackId", "there is no track to pick");

        room.TryStart("c-h").Should().BeFalse("nobody has readied");
        for (var i = 2; i <= 8; i++) room.ToggleReady($"c-{i}");
        room.TryStart("c-2").Should().BeFalse("only the host starts");
        var roster = room.TryStartWithRoster("c-h")!;
        roster.Should().HaveCount(8);
        room.TryStart("c-h").Should().BeFalse("a started lobby cannot start again");
        room.Kick("c-h", "c-2").ok.Should().BeFalse("no kicking while a race runs");
        var code = room.BeginRace();
        code.Should().MatchRegex("^[0-9a-f]{8}$");
        room.State.Should().Match<LobbyState<PoCabinetLobbyPlayer>>(s => s.InProgress && s.GameCode == code, "a latecomer sees the race in progress and can Watch by its code");
        room.Open("c-late", "Latecomer", false, "late").state.Players.Should().NotContain(p => p.ConnectionId == "c-late");
        var grid = room.BuildGrid(roster);
        grid.Should().HaveCount(PoCabinetCatalog.OnlineGridSize, "eight humans plus AI make 64 cars");
        grid.Count(d => !d.IsPlayer).Should().Be(64 - 8);
        grid.Take(8).Select(d => d.OwnerId).Should().Equal(roster.Select(p => p.UserId));
        System.Text.Json.JsonSerializer.Serialize(roster[0]).Should().NotContainEquivalentOf("userId", "the claim id never leaves the server");

        room.MarkRaceFinished("stale-code").Should().BeFalse("another race's finish changes nothing");
        room.MarkRaceFinished(code).Should().BeTrue("the lobby reopens for a rematch with the same roster");
        room.State.Should().Match<LobbyState<PoCabinetLobbyPlayer>>(s => !s.InProgress && s.GameCode == PoCabinetLobbyService.GlobalCode && s.Players.Count == 8);
        room.State.Players.Where(p => p.ConnectionId != "c-h").Should().OnlyContain(p => !p.IsReady, "guests ready up again");

        // The host's generic kick: never themselves, never as a guest, one seat freed.
        room.Kick("c-2", "c-3").ok.Should().BeFalse("only the host kicks");
        room.Kick("c-h", "c-h").ok.Should().BeFalse("the host cannot kick themselves");
        room.Kick("c-h", "c-3").Should().Be((true, "Player3"));
        room.State.Players.Should().HaveCount(7);

        // Seats left not ready past the timeout are freed after a race; the host never is.
        room.ToggleReady("c-4");
        clock.Advance(PoCabinetLobbyService.ReadyTimeout - TimeSpan.FromSeconds(1));
        room.SweepUnready().Should().BeEmpty();
        clock.Advance(TimeSpan.FromSeconds(2));
        room.SweepUnready().Select(u => u.ConnectionId).Should().BeEquivalentTo(["c-2", "c-5", "c-6", "c-7", "c-8"]);
        room.State.Players.Select(p => p.ConnectionId).Should().BeEquivalentTo(["c-h", "c-4"]);

        // A lone host races the AI officials; a lone host with none cannot; a drained room starts fresh.
        var solo = new PoCabinetLobbyService(clock);
        solo.Open("s", "Hana", false, "solo");
        solo.TryStartWithRoster("s").Should().NotBeNull("a lone host races the default AI officials");
        solo.End();
        solo.Open("g", "Gil", false, "g1");
        solo.ToggleReady("g");
        var soloRoster = solo.TryStartWithRoster("s")!;
        // A full AI grid: the four officials, then field racers under the names and paint they
        // have in a solo race, and never more cars than the online grid holds.
        var fullGrid = solo.BuildGrid(soloRoster);
        fullGrid.Should().HaveCount(PoCabinetCatalog.OnlineGridSize, "two humans plus 62 AI: always 64 cars");
        fullGrid.Select(d => d.Name).Should().OnlyHaveUniqueItems();
        fullGrid.Skip(2).Take(4).Select(d => d.OfficialId).Should().Equal(PoCabinetCatalog.Officials.Select(o => o.Id));
        fullGrid[6].Should().Match<PoCabinetDriver>(d => d.Name == "Dana K." && d.OfficialId == PoCabinetCatalog.FieldRacerId && d.Color.StartsWith("hsl("));
        solo.Leave("s");
        solo.Leave("g");
        solo.IsEmpty.Should().BeTrue();
        new PoCabinetSim(1, fullGrid).SnapshotCars().Should().HaveCount(fullGrid.Count);
    }

    /// <summary>
    /// The 30 Hz race broadcast fits its frame in the hub's JSON (camelCase, string enums):
    /// 2 KB at eight cars (the humans-only tick), 16 KB for the whole 64-car field (every third tick). The static world goes once, on
    /// join, not per tick.
    /// </summary>
    private static void PerTickSnapshot_FitsTwoKilobytes_AtEightCars()
    {
        foreach (var (count, budget) in new[] { (PoCabinetCatalog.CarCount, 2048), (PoCabinetCatalog.OnlineGridSize, 16384) })
        {
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(TickSnapshot(count), SnapshotJsonOptions);
            bytes.Length.Should().BeLessThanOrEqualTo(budget, $"the per-tick broadcast fits one frame at {count} cars; measured {bytes.Length} bytes");
        }
    }

    private static PoCabinetRaceSnapshot TickSnapshot(int carCount) =>
        new PoCabinetRaceSnapshot
        {
            GameCode = "cabinet",
            ServerTimeMs = 1_700_000_000_000,
            ElapsedRaceTime = 95.42,
            Started = true,
            LocalCarId = 0,
            Cars = Enumerable.Range(0, carCount).Select(i => new PoCabinetCarState
            {
                Id = i,
                Name = "Player " + i,
                OfficialId = i == 0 ? "player" : PoCabinetCatalog.Officials[i % 4].Id,
                Color = "#3470d8",
                AckSeq = 123_456,
                X = 12 + i * 1.7,
                Y = -8 + i * 0.5,
                Heading = Math.PI / 2 - i * 0.04,
                SpeedKmh = 220 - i * 6,
                Lap = i % 4 + 1,
                LapProgress = 0.42 + i * 0.005,
                Position = i + 1,
                IsPlayer = i == 0,
            }).ToList(),
            // The steady-state tick: a radio line rides only the occasional one (and takes it
            // just past 2 KB at eight full-precision-looking cars).
            LatestDialogue = null,
        };
}
