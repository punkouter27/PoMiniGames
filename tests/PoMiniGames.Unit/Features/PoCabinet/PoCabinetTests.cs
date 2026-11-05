using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Games.PoCabinet;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

/// <summary>PoCabinet's scripted talk, its track features, the daily circuit, the AI and the
/// physics under it, the one lobby, and the per-tick wire budget.</summary>
public class PoCabinetTests
{
    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers))]
    [InlineData(nameof(EveryTrackShipsItsFeatures_AndTheServerReadsTheSameRoad))]
    [InlineData(nameof(DailyCircuit_IsTheSameTrackFromTheSameDate_RacesForThreeDays_AndChangesDaily))]
    [InlineData(nameof(EachOfficial_LapsOnItsOwnLine_AndAHumanCarObeysInputsAndTheBarrier))]
    [InlineData(nameof(Contacts_AreImpulsesBetweenCarShapedHulls))]
    [InlineData(nameof(Lobby_FirstArrivalHosts_LaterArrivalsShareIt_AndBouncesAtCap))]
    [InlineData(nameof(PerTickSnapshot_FitsTwoKilobytes_AtEightCars))]
    [InlineData(nameof(EveryTrack_IsDefinedAndThemed_AnOfficialFinishesALap_AndTheBlenderRouteIsTheRaceRoad))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    /// <summary>
    /// The scripted pool covers every official and every race.js moment, a line is picked
    /// deterministically by (official, kind, tick), and the debrief turns the numbers into the
    /// tips they justify.
    /// </summary>
    private static void ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers()
    {
        PoCabinetTalk.Banter.Keys.Should().BeEquivalentTo(PoCabinetCatalog.Officials.Select(o => o.Id));
        PoCabinetTalk.Banter.Values.Should().OnlyContain(byMoment =>
            byMoment.Keys.Order().SequenceEqual(new[] { "finish", "lead", "passed", "preRace" }) && byMoment.Values.All(lines => lines.Count > 0));

        var line = PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12);
        Enumerable.Range(0, 50).Should().OnlyContain(_ => PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12) == line,
            "the same (official, kind, raceTick) always plays the same line");
        PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 0).Should().NotBe(PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 999));
        PoCabinetDialogue.PickLine("unknown-official", DialogueKind.PreRace, 0).Should().BeEmpty("no line, no bubble");

        var slow = PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts(
            "Capitol Speedway", 4, [0.1, 0.9, -0.2], FullThrottlePct: 40, BrakePct: 10, SlowestKmh: 150, WorstPointPct: 45, WallHits: 2));
        slow.Tips.Should().HaveCount(3);
        slow.Tips[0].Should().Contain("Sector 2").And.Contain("0.90");
        slow.Tips[1].Should().Contain("Sector 3").And.Contain("quicker");
        slow.Tips[2].Should().Contain("2 barrier hits");
        slow.Headline.Should().Contain("P4");

        // No reference lap: the tip says where the time went instead.
        PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts("Senate Hill", 1, [], 80, 10, 120, 45, 0))
            .Tips.Should().ContainSingle().Which.Should().Contain("45%");

        // A wreck is never "a clean race", even with no barrier hit (car contact did it).
        var wreck = PoCabinetTalk.DebriefFor(new PoCabinetTalk.Facts("Capitol Speedway", 29, [], 90, 5, 120, -1, 0, Wrecked: true));
        wreck.Tips[0].Should().Contain("wrecked");
        wreck.Tips.Should().NotContain(t => t.Contains("clean race"));
        wreck.Headline.Should().Contain("WRECK");
    }

    /// <summary>
    /// Every track's world carries a value per centerline sample for each feature (width,
    /// run-off, kerbs, racing line, heights), the hand-built tracks have the features they were
    /// built around (raised kerbs, gravel, tarmac run-off, a divider with a tapered nose), and
    /// the server's runtime track reads the very same values the browser is handed.
    /// </summary>
    private static void EveryTrackShipsItsFeatures_AndTheServerReadsTheSameRoad()
    {
        foreach (var info in PoCabinetCatalog.Tracks)
        {
            var world = PoCabinetTrackGeometry.BuildStaticWorld(info.Id);
            int n = world.CenterXY.Count / 2;
            new[] { world.HalfWidths.Count, world.RunoffLeft.Count, world.RunoffRight.Count, world.Kerbs.Count, world.RacingLine.Count, world.CenterZ.Count }
                .Should().AllBeEquivalentTo(n, $"{info.Id} ships every feature per sample");
            world.HalfWidths.Should().OnlyContain(hw => hw > 25, info.Id);
            if (info.Id != "playground") world.Kerbs.Should().Contain(k => k != 0, $"{info.Id} has apex kerbs (the marble run's chute bends are too gentle for any)");

            var track = PoCabinetTrack.Get(info.Id);
            Enumerable.Range(0, n).Should().OnlyContain(i =>
                track.HalfWidthAt(i) == world.HalfWidths[i] && track.KerbAt(i) == world.Kerbs[i]
                && track.RunoffAt(i, -1) == world.RunoffLeft[i] && track.RunoffAt(i, 1) == world.RunoffRight[i],
                $"{info.Id}: the server races the road the browser draws");
        }

        PoCabinetTrackGeometry.BuildStaticWorld("capitol").Kerbs.Should().Contain(k => Math.Abs(k) == 2, "the bus stop has raised kerbs");
        PoCabinetTrackGeometry.BuildStaticWorld("maralago").RunoffRight.Should().Contain((int)PoCabinetRunoff.Gravel, "sand traps");
        PoCabinetTrackGeometry.BuildStaticWorld("pressbriefing").RunoffLeft.Should().OnlyContain(k => k == (int)PoCabinetRunoff.Tarmac, "a plaza");

        // Senate Hill's divider: its own lane either side, a point at each end, and the AI and the
        // physics both know where it stands.
        var senate = PoCabinetTrack.Get("senate");
        senate.Islands.Should().ContainSingle();
        var isl = senate.Islands[0];
        senate.IslandIndexAt(isl.From).Should().Be(0);
        (senate.IslandHi(isl.From) - senate.IslandLo(isl.From)).Should().BeLessThan(isl.LatTo - isl.LatFrom, "the nose tapers");
        int mid = (isl.From + isl.To) / 2;
        (senate.IslandHi(mid) - senate.IslandLo(mid)).Should().Be(isl.LatTo - isl.LatFrom);
        senate.IslandIndexAt((isl.To + 1) % senate.Count).Should().Be(-1);
    }

    /// <summary>
    /// The daily circuit is built from the date alone, so the browser and the server (and two
    /// builds) agree on every value; laps post for yesterday's, today's and tomorrow's, not a
    /// stale one; and tomorrow is a different track.
    /// </summary>
    private static void DailyCircuit_IsTheSameTrackFromTheSameDate_RacesForThreeDays_AndChangesDaily()
    {
        var day = new DateOnly(2026, 10, 19);
        var id = PoCabinetDailyTrack.IdFor(day);
        id.Should().Be("daily-20261019");
        var a = PoCabinetTrackGeometry.BuildStaticWorld(id);
        var b = PoCabinetTrackGeometry.BuildStaticWorld("DAILY-20261019");
        a.CenterXY.Should().Equal(b.CenterXY);
        a.HalfWidths.Should().Equal(b.HalfWidths);
        a.Kerbs.Should().Equal(b.Kerbs);
        a.TrackName.Should().Be("Daily Circuit · Oct 19");
        a.TotalLaps.Should().Be(3);
        a.CenterZ.Should().HaveCount(a.CenterXY.Count / 2).And.Contain(z => z != 0, "the daily circuit has hills");
        PoCabinetTrack.Get(id).Length.Should().BeApproximately(3200, 5);

        var tomorrow = PoCabinetTrackGeometry.BuildStaticWorld(PoCabinetDailyTrack.IdFor(day.AddDays(1)));
        tomorrow.CenterXY.Should().NotEqual(a.CenterXY);

        var noon = new DateTime(2026, 10, 19, 12, 0, 0, DateTimeKind.Utc);
        PoCabinetDailyTrack.IsCurrent("daily-20261018", noon).Should().BeTrue("a race that ran over midnight still posts");
        PoCabinetDailyTrack.IsCurrent("daily-20261020", noon).Should().BeTrue();
        PoCabinetDailyTrack.IsCurrent("daily-20261010", noon).Should().BeFalse("a stale daily board is closed");
        PoCabinetDailyTrack.IsCurrent("daily-2026101", noon).Should().BeFalse();
        PoCabinetCatalog.IsKnownTrack(PoCabinetDailyTrack.TodayId(DateTime.UtcNow)).Should().BeTrue();
    }

    /// <summary>
    /// Each of the four officials, alone on Capitol, completes a lap through the real physics on
    /// its own line (every pair's mean lateral offset over the lap differs by ≥ 8 units); a human
    /// car flat out on full right lock ends up pinned at the barrier, never through it, and every
    /// applied input's sequence number is acknowledged.
    /// </summary>
    /// <summary>
    /// Every catalog track (and today's daily circuit) has its own geometry, not the fallback,
    /// and a theme the scene dresses (terrain.js THEMES); an AI official drives one full lap of
    /// each under the server physics; and the bedroom's centerline is the one
    /// scripts/blender/pocabinet-bedroom.py checked against the room scan (its --fixture output),
    /// so the road the script cleared of furniture is the road the race is run on.
    /// </summary>
    private static void EveryTrack_IsDefinedAndThemed_AnOfficialFinishesALap_AndTheBlenderRouteIsTheRaceRoad()
    {
        string[] sceneThemes = ["capitol", "maralago", "pressbriefing", "senate", "playground", "bedroom"];
        var ids = PoCabinetCatalog.Tracks.Select(t => t.Id).Append(PoCabinetDailyTrack.TodayId(DateTime.UtcNow)).ToList();
        var official = PoCabinetPersonality.Roster[0];
        foreach (var id in ids)
        {
            var def = PoCabinetTrackGeometry.Get(id);
            def.Id.Should().Be(id, $"{id} has its own geometry, not the default track's");
            sceneThemes.Should().Contain(def.Theme ?? def.Id, $"{id}'s theme is one the scene can dress");

            var sim = new PoCabinetSim(id, seed: 7,
                [new PoCabinetDriver("bot", PoCabinetCatalog.OfficialName(official.Id), IsPlayer: false, official.Color, official.Personality, official.MaxSpeed, official.CorneringSkill, official.Id)]);
            var car = sim.SnapshotCars()[0];
            for (var i = 0; i < 30 * 300 && car.LapsDone < 1; i++)
                sim.Tick(1.0 / 30.0, new Dictionary<string, PoCabinetInput>());
            car.LapsDone.Should().BeGreaterThanOrEqualTo(1, $"an official completes a full lap of {id}");
        }

        using var fixture = System.Text.Json.JsonDocument.Parse(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "pocabinet-bedroom-centerline.json")));
        var script = fixture.RootElement.GetProperty("centerXY").EnumerateArray().Select(e => e.GetDouble()).ToArray();
        var game = PoCabinetTrackGeometry.BuildCenterlineXY(PoCabinetTrackGeometry.Get("bedroom"));
        game.Should().HaveSameCount(script, "the script and the game sample the same knots at the same steps");
        // The knots are printed to 0.1 sim unit, so the two splines agree to well under a unit.
        Enumerable.Range(0, game.Length).Max(i => Math.Abs(game[i] - script[i])).Should().BeLessThan(0.5,
            "the bedroom route the Blender script checked is the road PoCabinet races");
    }

    private static void EachOfficial_LapsOnItsOwnLine_AndAHumanCarObeysInputsAndTheBarrier()
    {
        const double dt = 1.0 / 30.0;
        var laterals = new Dictionary<string, double>();
        foreach (var o in PoCabinetPersonality.Roster)
        {
            var sim = new PoCabinetSim("capitol", seed: 42,
                [new PoCabinetDriver("bot", PoCabinetCatalog.OfficialName(o.Id), IsPlayer: false, o.Color, o.Personality, o.MaxSpeed, o.CorneringSkill, o.Id)]);
            var car = sim.SnapshotCars()[0];
            var series = new List<double>();
            for (var i = 0; i < 30 * 60 && car.LapsDone < 1; i++)
            {
                sim.Tick(dt, new Dictionary<string, PoCabinetInput>());
                // The settled part of the lap, past the grid and the first turn-in.
                if (car.Distance > 150) series.Add(car.Lateral);
            }
            car.LapsDone.Should().Be(1, $"{o.Id} completes a lap under the real physics");
            // A wild lap may break track limits (no best lap), but the clock still ran.
            car.LapStartTime.Should().BeInRange(12, 60, $"{o.Id}'s lap is a plausible arcade lap");
            laterals[o.Id] = series.Average();
        }
        foreach (var a in laterals)
        {
            foreach (var b in laterals.Where(b => string.CompareOrdinal(a.Key, b.Key) < 0))
                Math.Abs(a.Value - b.Value).Should().BeGreaterThanOrEqualTo(8, $"{a.Key} and {b.Key} hold visibly different lines");
        }

        var human = new PoCabinetSim("capitol", seed: 1, [new PoCabinetDriver("me", "Me", IsPlayer: true, "#fff", null)]);
        var me = human.SnapshotCars()[0];
        var wall = human.Track.HalfWidth + PoCabinetPhysics.RunOff - PoCabinetPhysics.CarRadius * 0.5;
        for (var seq = 1; seq <= 150; seq++)
        {
            human.Tick(dt, new Dictionary<string, PoCabinetInput> { ["me"] = new() { Throttle = 1, Steer = 1, Seq = seq } });
            Math.Abs(me.Lateral).Should().BeLessThanOrEqualTo(wall + 0.5, "no car passes through the barrier");
        }
        me.AckSeq.Should().Be(150, "every applied input is acknowledged");
        me.Speed.Should().BeGreaterThan(0, "throttle moves the car");
    }

    /// <summary>
    /// A contact is an impulse between car-shaped hulls: momentum is kept, a centred hit moves
    /// nobody sideways, an off-centre one shoves and turns both cars, and cars on different
    /// levels of a crossing do not touch.
    /// </summary>
    private static void Contacts_AreImpulsesBetweenCarShapedHulls()
    {
        var track = PoCabinetTrack.Get("capitol");
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
    }

    /// <summary>
    /// There is one lobby and no join codes: the first arrival hosts, the next arrivals share it,
    /// the ninth is bounced. Ready toggling, the start rule the clients are sent, host migration,
    /// the rematch loop, AI officials filling free seats so a lone host can race, and seats that
    /// survive a dropped connection all hold.
    /// </summary>
    private static void Lobby_FirstArrivalHosts_LaterArrivalsShareIt_AndBouncesAtCap()
    {
        var service = new PoCabinetLobbyService();
        service.View().Should().BeNull("nobody has arrived yet");

        var lobby = service.Join("host", "Alice", trackId: "capitol");
        lobby!.HostId.Should().Be("host", "the first arrival hosts");
        lobby.Players[0].IsReady.Should().BeTrue("the host is auto-ready");
        var second = service.Join("p2", "Bob", trackId: "maralago");
        second.Should().BeSameAs(lobby, "there is one lobby");
        second!.TrackId.Should().Be("capitol", "a later arrival's track choice is ignored");
        second.Players[1].IsReady.Should().BeFalse("guests ready up themselves");
        for (var i = 3; i <= 8; i++) service.Join($"p{i}", $"Player{i}").Should().NotBeNull();
        service.Join("p9", "Eve").Should().BeNull("eight seats, no more");
        service.View()!.Players.Should().HaveCount(PoCabinetCatalog.CarCount);

        service.ToggleReady("p2").Should().BeTrue();
        service.View()!.Startable.Should().BeFalse("not everyone is ready");
        service.Start("host").Should().BeNull();
        for (var i = 3; i <= 8; i++) service.ToggleReady($"p{i}");
        service.View()!.Startable.Should().BeTrue();
        service.Start("p2").Should().BeNull("only the host starts");
        service.Start("host").Should().NotBeNull();
        service.Start("host").Should().BeNull("a started lobby cannot start again");
        service.Join("late", "Latecomer").Should().BeNull();
        service.View()!.InRace.Should().BeTrue("a latecomer sees the race in progress");

        service.Leave("host");
        service.View()!.Players.Should().ContainSingle(p => p.IsHost).Which.DisplayName.Should().Be("Bob", "the next player is promoted");
        foreach (var id in new[] { "p2", "p3", "p4", "p5", "p6", "p7", "p8" }) service.Leave(id);
        service.View().Should().NotBeNull("a running race keeps its lobby, so no second race starts under the same id");
        service.MarkRaceFinished().Should().BeNull();
        service.View().Should().BeNull("an empty lobby is purged");

        service.Join("solo", "Hana", trackId: "maralago", connectionId: "c-solo")!.HostId.Should().Be("solo");
        service.View()!.Startable.Should().BeTrue("a lone host races the default AI officials");
        service.SetBots("solo", 0).Should().BeTrue();
        service.View()!.Startable.Should().BeFalse("one car is not a race");
        service.SetBots("solo", 2);
        service.SetBots("someone-else", 4).Should().BeFalse("only the host changes the grid");
        service.Join("g1", "Gil", connectionId: "c-g1").Should().NotBeNull();
        service.ToggleReady("g1");
        service.View()!.BotSeats.Should().Be(2);
        service.Start("solo").Should().NotBeNull();
        var grid = service.BuildGrid();
        grid.Should().HaveCount(4, "two humans plus the two officials asked for");
        grid.Skip(2).Select(d => d.Name).Should().Equal("Sean S.", "Steve B.");
        service.DropConnection("c-g1").Should().BeTrue();
        service.View()!.Players.Should().HaveCount(2, "a drop mid-race keeps the seat until the race ends");
        service.Join("g1", "Gil", connectionId: "c-g1b").Should().NotBeNull("rejoining your own seat works mid-race");

        var reopened = service.MarkRaceFinished();
        reopened!.IsStarted.Should().BeFalse();
        reopened.Players.Single(p => p.PlayerId == "g1").IsReady.Should().BeFalse("guests ready up again for the rematch");
        service.View("g1")!.YourSeatId.Should().Be(PoCabinetLobbyService.SeatIdFor("g1")).And.NotContain("g1", "seat ids never expose the claim id");

        // Every race has its own code, a stale race's finish cannot reopen the next one, and a
        // race that could not be created rolls the lobby back to idle.
        var clock = new Microsoft.Extensions.Time.Testing.FakeTimeProvider(DateTimeOffset.UtcNow);
        var rematch = new PoCabinetLobbyService(clock);
        rematch.Join("h", "Host", connectionId: "c-h");
        rematch.Join("afk", "Afk", connectionId: "c-afk");
        rematch.Join("k", "Kicked", connectionId: "c-k");
        rematch.ToggleReady("afk");
        rematch.ToggleReady("k");
        var first = rematch.Start("h")!.RaceCode;
        first.Should().MatchRegex("^[0-9a-f]{8}$");
        rematch.View()!.Code.Should().Be(first, "Watch joins the running race by its code");
        rematch.MarkRaceFinished("stale-code").Should().BeNull();
        rematch.View()!.InRace.Should().BeTrue("another race's finish changes nothing");
        rematch.MarkRaceFinished(first).Should().NotBeNull();
        rematch.ToggleReady("afk");
        rematch.ToggleReady("k");
        var next = rematch.Start("h")!.RaceCode;
        next.Should().NotBe(first);
        rematch.AbortStart(next!);
        rematch.View()!.InRace.Should().BeFalse("a race that failed to start leaves the lobby idle");

        // The host frees an AFK seat between races (never their own, never as a guest), and a
        // reopened lobby frees seats left not ready for the timeout.
        rematch.Kick("afk", PoCabinetLobbyService.SeatIdFor("k")).Should().BeNull("only the host kicks");
        rematch.Kick("h", PoCabinetLobbyService.SeatIdFor("h")).Should().BeNull("the host cannot kick themselves");
        rematch.Kick("h", PoCabinetLobbyService.SeatIdFor("k"))!.ConnectionIds.Should().Equal("c-k");
        rematch.View()!.Players.Should().HaveCount(2);
        rematch.Start("h");
        rematch.MarkRaceFinished(rematch.View()!.Code);
        clock.Advance(PoCabinetLobbyService.ReadyTimeout - TimeSpan.FromSeconds(1));
        rematch.SweepUnready().Should().BeEmpty();
        clock.Advance(TimeSpan.FromSeconds(2));
        rematch.SweepUnready().Should().ContainSingle().Which.DisplayName.Should().Be("Afk");
        rematch.View()!.Players.Should().ContainSingle(p => p.IsHost, "the host is ready by definition and never swept");
    }

    /// <summary>
    /// The 30 Hz race broadcast at eight cars fits one 2 KB frame in the hub's JSON (camelCase,
    /// string enums). The static world goes once, on join, not per tick.
    /// </summary>
    private static void PerTickSnapshot_FitsTwoKilobytes_AtEightCars()
    {
        var snapshot = new PoCabinetRaceSnapshot
        {
            GameCode = "cabinet",
            ServerTimeMs = 1_700_000_000_000,
            ElapsedRaceTime = 95.42,
            Started = true,
            LocalCarId = 0,
            Cars = Enumerable.Range(0, PoCabinetCatalog.CarCount).Select(i => new PoCabinetCarState
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
        var options = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
        options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase));
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(snapshot, options);
        bytes.Length.Should().BeLessThanOrEqualTo(2048, $"the per-tick broadcast fits one frame; measured {bytes.Length} bytes");
    }
}
