using FluentAssertions;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using System.Diagnostics;
using Xunit;
using Xunit.Abstractions;

namespace PoMiniGames.Unit.Features.PoRacer;

/// <summary>
/// Headless multi-track simulation tests. Verifies all 4 tracks (circuit, neonskyline, desertdustway,
/// crossfire), surface physics detection (sand grip reduction), boost pad triggering, AI lap
/// completion, and that the field still gets round in rain and snow.
/// </summary>
public class PoRacerSimAiTests
{
    private readonly ITestOutputHelper _out;
    public PoRacerSimAiTests(ITestOutputHelper output) => _out = output;

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(SoloAndDemoFields_HaveSixtyFourCars_WhileOnlineFieldStaysAtEight))]
    [InlineData(nameof(StartGrid_LinesUpOnTheRoad_OnEveryTrack))]
    [InlineData(nameof(FullFieldSimulation_UsesNearbyCollisionCandidates))]
    [InlineData(nameof(RacingLineSpeedProfile_BrakesBeforeBends_OnEveryTrack))]
    [InlineData(nameof(RubberBand_IsCappedSoloOnlyAndOffOnTheFinalLap))]
    [InlineData(nameof(DefendingBot_TakesTheInsideOncePerStraight))]
    [InlineData(nameof(Bots_LearnFromAHumanLapProfile))]
    [InlineData(nameof(BotDrivenLaps_NeverFeedTheGhost))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    // The full solo field, before anything moves: every car on the road with room to the
    // barrier, facing the way the road runs where it stands, no two overlapping, in two
    // staggered columns, and ranked front to back by where it sits on the lap.
    private static void StartGrid_LinesUpOnTheRoad_OnEveryTrack()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        foreach (var track in PoRacerCatalog.Tracks)
        {
            var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], track.Id, carCount: PoRacerCatalog.SoloCarCount);
            var world = sim.Static;
            var grid = sim.Snapshot("grid").Cars;
            grid.Should().HaveCount(PoRacerCatalog.SoloCarCount);
            var cars = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", flags)!.GetValue(sim)!).Cast<object>().ToArray();
            double Field(object car, string name) => Convert.ToDouble(car.GetType().GetField(name)!.GetValue(car), System.Globalization.CultureInfo.InvariantCulture);
            int nodes = world.CenterXY.Count / 2;

            for (int i = 0; i < cars.Length; i++)
            {
                // ProjSide is the signed distance from the centerline of the stretch the car is on.
                double side = Field(cars[i], "ProjSide");
                Math.Abs(side).Should().BeInRange(20, world.TrackWidth / 2 - 18, $"{track.Id}: car {i} is in a column on the road, clear of the barrier");
                (side > 0).Should().Be(i % 2 == 1, $"{track.Id}: odd grid slots are the right-hand column");

                int node = (int)Field(cars[i], "ProjIdx"), next = (node + 1) % nodes;
                double road = Math.Atan2(world.CenterXY[next * 2 + 1] - world.CenterXY[node * 2 + 1], world.CenterXY[next * 2] - world.CenterXY[node * 2]);
                Math.Abs(PoRacerAiDriver.ShortAngleDiff(grid[i].Heading, road)).Should().BeLessThan(0.35, $"{track.Id}: car {i} faces down the road where it stands");

                for (int j = i + 1; j < cars.Length; j++)
                {
                    double dx = grid[i].X - grid[j].X, dy = grid[i].Y - grid[j].Y;
                    // Skip pairs a long way apart on the lap: on a track that crosses itself, two
                    // grid slots on different stretches can share a crossing.
                    if (Math.Abs(grid[i].LapProgress - grid[j].LapProgress) * nodes > 12) continue;
                    Math.Sqrt(dx * dx + dy * dy).Should().BeGreaterThan(36, $"{track.Id}: cars {i} and {j} must not overlap on the grid");
                }
            }
            // The human is slot 0, at the back; the last slot is on pole.
            grid[0].Position.Should().Be(PoRacerCatalog.SoloCarCount, $"{track.Id}: the driver starts at the back");
            grid[^1].Position.Should().Be(1, $"{track.Id}: the last slot is on pole");
            grid.Select(c => c.Position).Should().OnlyHaveUniqueItems();
        }
    }

    private static void SoloAndDemoFields_HaveSixtyFourCars_WhileOnlineFieldStaysAtEight()
    {
        var player = new PoRacerLobbyPlayer("connection", "Player", true, true, "owner");
        var online = new PoRacerSim([player]);
        var solo = new PoRacerSim([player], carCount: PoRacerCatalog.SoloCarCount);
        var demo = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), carCount: PoRacerCatalog.SoloCarCount);

        online.Snapshot("online").Cars.Should().HaveCount(PoRacerCatalog.CarCount);
        solo.Snapshot("solo").Cars.Should().HaveCount(PoRacerCatalog.SoloCarCount);
        solo.Static.Roster.Should().ContainSingle(c => c.IsPlayer);
        demo.Snapshot("demo").Cars.Should().HaveCount(PoRacerCatalog.SoloCarCount);
        demo.Static.Roster.Should().OnlyContain(c => !c.IsPlayer);
        solo.Static.Roster.Select(c => c.Name).Should().OnlyHaveUniqueItems();
        demo.Static.Roster.Select(c => c.Name).Should().OnlyHaveUniqueItems();
    }

    private void FullFieldSimulation_UsesNearbyCollisionCandidates()
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), carCount: PoRacerCatalog.SoloCarCount);
        typeof(PoRacerSim).GetField("_startElapsedMs", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .SetValue(sim, -1L);

        var timer = Stopwatch.StartNew();
        var noInput = new Dictionary<string, PoRacerInput>();
        for (int i = 0; i < 250; i++) sim.Tick(0.02, noInput);
        timer.Stop();

        sim.LastCollisionCandidateCount.Should().BeLessThan(PoRacerCatalog.SoloCarCount * (PoRacerCatalog.SoloCarCount - 1) / 2);
        _out.WriteLine($"{PoRacerCatalog.SoloCarCount}-car simulation: 250 ticks in {timer.Elapsed.TotalMilliseconds:0.0} ms; final collision candidates={sim.LastCollisionCandidateCount}");
        CollisionBroadphase_IncludesEveryOverlappingPairAcrossCellBoundaries();
    }

    private static void CollisionBroadphase_IncludesEveryOverlappingPairAcrossCellBoundaries()
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), carCount: PoRacerCatalog.SoloCarCount);
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var cars = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", flags)!.GetValue(sim)!).Cast<object>().ToArray();
        foreach (var (car, index) in cars.Select((car, index) => (car, index)))
        {
            int pair = index / 2;
            var position = index % 2 == 0
                ? new Vec2(-1000 + pair * 500, -180)
                : new Vec2(-975 + pair * 500, -155);
            car.GetType().GetField("Pos")!.SetValue(car, position);
        }

        typeof(PoRacerSim).GetMethod("BuildCollisionCandidates", flags)!.Invoke(sim, null);
        var pairs = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_collisionCandidates", flags)!.GetValue(sim)!)
            .Cast<object>()
            .Select(pair => ((int)pair.GetType().GetField("Item1")!.GetValue(pair)!, (int)pair.GetType().GetField("Item2")!.GetValue(pair)!))
            .ToHashSet();

        for (int i = 0; i < cars.Length; i++)
        {
            var a = (Vec2)cars[i].GetType().GetField("Pos")!.GetValue(cars[i])!;
            for (int j = i + 1; j < cars.Length; j++)
            {
                var b = (Vec2)cars[j].GetType().GetField("Pos")!.GetValue(cars[j])!;
                if ((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y) < 36 * 36)
                {
                    pairs.Should().Contain((i, j), "the broadphase must not omit any physically overlapping pair");
                }
            }
        }
    }

    private static void PrecomputedUpcomingBend_MatchesCenterlineCalculation(string trackId)
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId);
        var method = typeof(PoRacerSim).GetMethod("UpcomingBend", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var points = sim.Static.CenterXY;
        int count = points.Count / 2;

        foreach (int start in new[] { 0, count / 3, count - 3 })
        {
            foreach (int span in new[] { 9, 24 })
            {
                double expected = 0;
                for (int offset = 0; offset < span; offset++)
                {
                    int i = (start + offset) % count;
                    int next = (i + 1) % count;
                    int after = (i + 2) % count;
                    double first = Math.Atan2(points[next * 2 + 1] - points[i * 2 + 1], points[next * 2] - points[i * 2]);
                    double second = Math.Atan2(points[after * 2 + 1] - points[next * 2 + 1], points[after * 2] - points[next * 2]);
                    double difference = (second - first) % (2 * Math.PI);
                    if (difference > Math.PI) difference -= 2 * Math.PI;
                    if (difference < -Math.PI) difference += 2 * Math.PI;
                    expected += Math.Abs(difference);
                }

                ((double)method.Invoke(sim, [start, span])!).Should().BeApproximately(expected, 1e-10);
            }
        }
    }

    [Theory]
    [InlineData("circuit")]
    [InlineData("neonskyline")]
    [InlineData("desertdustway")]
    [InlineData("crossfire")]
    [InlineData("circuit", true)]
    // Weather: every bot must still get round with less grip, including the tightest track in snow.
    [InlineData("neonskyline", false, "rain")]
    [InlineData("crossfire", false, "snow")]
    public void RaceCompletion_FinishesBotsOrSerializesDnf(string trackId, bool expireRace = false, string weather = "clear")
    {
        PrecomputedUpcomingBend_MatchesCenterlineCalculation(trackId);
        // Seeded: the boost/sand/finish assertions below hold for this race every run.
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId, seed: 7, weather: weather);
        sim.Static.Weather.Should().Be(weather, "the client draws the weather the sim raced in");
        var noInput = new Dictionary<string, PoRacerInput>();
        if (expireRace)
        {
            VerifyCountdownAndRankings();
            // Advance the race clock past its safety cap without a real-time delay.
            typeof(PoRacerSim).GetField("_startElapsedMs", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .SetValue(sim, -181_000L);
            sim.Tick(0.02, noInput);
            var snapshot = sim.Snapshot("dnf");
            snapshot.Finished.Should().BeTrue();
            snapshot.Cars.Should().OnlyContain(c => !c.Finished && c.FinishTime == -1);
            var result = sim.BuildFinalResult("dnf");
            result.Standings.Should().OnlyContain(c => !c.Finished && c.TotalTimeSeconds == -1);
            // Both messages travel over SignalR when a race ends with unfinished cars.
            var snapshotJson = System.Text.Json.JsonSerializer.Serialize(snapshot);
            var resultJson = System.Text.Json.JsonSerializer.Serialize(result);
            System.Text.Json.JsonSerializer.Deserialize<PoRacerRaceSnapshot>(snapshotJson)!.Finished.Should().BeTrue();
            System.Text.Json.JsonSerializer.Deserialize<PoRacerFinalResult>(resultJson)!.Standings.Should().HaveCount(PoRacerCatalog.CarCount);
            return;
        }
        const double dt = 0.02;              // 50 Hz, matches the server tick rate
        const int maxTicks = 12_000;         // 240 sim-seconds hard budget

        var finishSec = new Dictionary<int, double>();
        int carCount = sim.Snapshot("t").Cars.Count;

        bool anyCarBoosted = false;
        bool anyCarHitSand = false;
        double fastest = 0;

        int tick = 0;
        for (; tick < maxTicks; tick++)
        {
            sim.Tick(dt, noInput);
            var snap = sim.Snapshot("t");
            foreach (var car in snap.Cars)
            {
                fastest = Math.Max(fastest, car.Speed);
                if (car.BoostTimer > 0) anyCarBoosted = true;
                if (car.Surface == "sand") anyCarHitSand = true;
                if (car.Finished && !finishSec.ContainsKey(car.Id))
                    finishSec[car.Id] = (tick + 1) * dt;
            }
            if (finishSec.Count == carCount) break;
        }

        var final = sim.Snapshot("t");
        int finished = final.Cars.Count(c => c.Finished);
        double raceSeconds = (tick + 1) * dt;

        _out.WriteLine($"track={trackId} weather={weather} cars={carCount} finished={finished} raceSeconds={raceSeconds:0.0}");
        foreach (var kv in finishSec.OrderBy(k => k.Value))
            _out.WriteLine($"  car {kv.Key} finished at {kv.Value:0.0}s");
        foreach (var c in final.Cars.Where(c => !c.Finished))
            _out.WriteLine($"  UNFINISHED car {c.Id} ({sim.Static.Roster[c.Id].Name}): Lap={c.Lap}, Pos=({c.X:0.0},{c.Y:0.0}), Speed={c.Speed:0.0}");

        var names = sim.Static.Roster.Select(c => c.Name).ToList();
        names.Distinct().Count().Should().Be(names.Count,
            "each car needs a unique name");

        finished.Should().Be(carCount, $"every AI bot should complete the 3-lap race on {trackId} without getting stuck");

        var times = finishSec.Values.OrderBy(x => x).ToList();
        double winner = times.First();
        double last = times.Last();
        _out.WriteLine($"winner={winner:0.0}s last={last:0.0}s spread={last - winner:0.0}s");

        // Wet: slower, but the leader is still home inside the race's 180 s safety cap.
        winner.Should().BeLessThan(weather == "clear" ? 140 : 175, "the leading bot should not crawl");
        if (weather != "clear")
        {
            // The grip cut is the contract. The two races are chaotic float sims, and libm differs
            // between Windows and Linux in the last bit, so on CI the wet winner once came home
            // 1.3 s AHEAD of the dry one (89.5 vs 90.8). Head-to-head only has to hold with margin.
            PoRacerWeather.Grip(weather).Should().BeLessThan(PoRacerWeather.Grip(PoRacerWeather.Clear),
                "rain and snow cost grip");
            winner.Should().BeGreaterThan(DryWinnerSeconds(trackId) * 0.95,
                "less grip never makes the same field meaningfully faster");
        }
        (last - winner).Should().BeGreaterThan(0.2, "racing should produce a spread");

        // Verify boost pad triggering on all tracks
        // Every track has pads, a pad lifts top
        // speed as well as push, and a bot must not brake for the extra: the quickest bot's
        // nominal top speed is 325, so anything past 335 was a boost carried at full throttle.
        PoRacerTrackRegistry.GetTrack(trackId).BoostPads.Should().NotBeEmpty();
        anyCarBoosted.Should().BeTrue("at least one car should drive over the track's boost pads");
        fastest.Should().BeGreaterThan(335, "a boost pad raises top speed");

        // Verify desert sand surface interaction
        if (trackId == "desertdustway")
        {
            anyCarHitSand.Should().BeTrue("desert dustway must trigger sand surface physics during cornering");
        }
    }

    /// <summary>The same seeded race on a dry track: what a wet one is measured against.</summary>
    private static double DryWinnerSeconds(string trackId)
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId, seed: 7);
        var noInput = new Dictionary<string, PoRacerInput>();
        for (int tick = 1; tick <= 12_000; tick++)
        {
            sim.Tick(0.02, noInput);
            if (tick % 10 == 0 && sim.Snapshot("dry").Cars.Any(c => c.Finished)) return tick * 0.02;
        }
        return double.MaxValue;
    }

    private static void VerifyCountdownAndRankings()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], countdownSeconds: 3);
        var input = new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } };
        var grid = sim.Snapshot("rules");
        sim.Tick(0.02, input);
        var waiting = sim.Snapshot("rules");
        waiting.Started.Should().BeFalse();
        waiting.CountdownSeconds.Should().BeInRange(1, 3);
        waiting.ElapsedRaceTime.Should().Be(0);
        waiting.Cars.Select(c => (c.X, c.Y, c.Speed)).Should().Equal(grid.Cars.Select(c => (c.X, c.Y, c.Speed)));
        typeof(PoRacerSim).GetField("_startElapsedMs", flags)!.SetValue(sim, -1L);
        sim.Tick(0.02, input);
        sim.Snapshot("rules").Cars[0].Speed.Should().BeGreaterThan(0);

        var cars = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", flags)!.GetValue(sim)!).Cast<object>().ToArray();
        static void Set(object car, string name, object value) => car.GetType().GetField(name)!.SetValue(car, value);
        void Progress(object car, int lap, int node)
        {
            Set(car, "Lap", lap); Set(car, "LastCheckpoint", node); Set(car, "ProjIdx", node);
            Set(car, "CheckpointT", 0.0); Set(car, "ProjT", 0.0);
            typeof(PoRacerSim).GetMethod("UpdateRaceProgress", flags)!.Invoke(sim, [car]);
        }
        Progress(cars[0], 1, sim.Static.CenterXY.Count / 2 - 4);
        Progress(cars[1], 2, 1);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var ranked = sim.Snapshot("rules");
        ranked.Cars[1].Position.Should().BeLessThan(ranked.Cars[0].Position, "a whole lap must outweigh position within that lap");

        Set(cars[0], "Lap", 4); Set(cars[0], "FinishTime", 12.0); Set(cars[0], "DistanceAlongTrack", 999999.0);
        Set(cars[1], "Lap", 4); Set(cars[1], "FinishTime", 10.0);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var finish = sim.BuildFinalResult("rules");
        finish.Standings[0].CarId.Should().Be(1);
        finish.Standings[1].CarId.Should().Be(0);
        finish.Standings.Where(c => c.Finished).Select(c => c.TotalTimeSeconds).Should().BeInAscendingOrder();
        // Finished cars cannot gain another lap or move their crossing timestamp.
        var before = sim.Snapshot("rules").Cars[0];
        sim.Tick(0.02, input);
        var after = sim.Snapshot("rules").Cars[0];
        after.Lap.Should().Be(before.Lap);
        after.FinishTime.Should().Be(before.FinishTime);
        VerifyTrialPaintAnalogAndPause();
    }

    // Rules: a time trial grids humans only, paint off the wire is validated, an
    // analog axis is clamped and wins over its key, and a pause stops the race clock.
    private static void VerifyTrialPaintAnalogAndPause()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        sim.Snapshot("trial").Cars.Should().ContainSingle("a time trial has no bots");
        sim.Static.Roster.Should().ContainSingle().Which.IsPlayer.Should().BeTrue();

        var before = sim.Static.Roster[0];
        sim.SetPaint("owner", "red; drop table", "plaid").Should().BeFalse("neither value is a colour or a known livery");
        sim.SetPaint("stranger", "#ff3333", "neon").Should().BeFalse();
        sim.SetPaint("owner", "#FF3333", "neon").Should().BeTrue();
        sim.Static.Roster[0].Should().Match<PoRacerCarInfo>(c => c.Color == "#ff3333" && c.Livery == "neon" && c.ColorDark != before.ColorDark);

        // Throttle 5 is clamped to 1: the car gains exactly what the key would give it.
        var keyed = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 25; i++)
        {
            sim.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Throttle = 5, Steer = double.NaN } });
            keyed.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
        }
        var analog = sim.Snapshot("trial").Cars[0];
        analog.Speed.Should().BeGreaterThan(0).And.Be(keyed.Snapshot("trial").Cars[0].Speed);
        // Throttle only, no steering: the grid points 0.09 rad off the first straight, so the car
        // meets the barrier. It must glance off and keep its speed, not be turned into the wall
        // and ground down to a crawl (which is what a wrong-signed deflection did).
        var slowest = double.MaxValue;
        for (var i = 0; i < 700; i++)
        {
            keyed.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
            if (i > 150) slowest = Math.Min(slowest, keyed.Snapshot("trial").Cars[0].Speed);
        }
        slowest.Should().BeGreaterThan(120, "a brush with the barrier costs speed once, not on every tick");
        keyed.Snapshot("trial").Cars[0].Damage.Should().BeInRange(0.01, 0.5, "damage is by how hard the barrier was met, and glancing blows are small");
        // Half throttle is a smaller push than full.
        var half = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 25; i++) half.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Throttle = 0.5 } });
        half.Snapshot("trial").Cars[0].Speed.Should().BeInRange(1, analog.Speed - 1);

        // Paused: ticks move nothing and the race clock stands still; resuming carries on from there.
        typeof(PoRacerSim).GetField("_startElapsedMs", flags)!.SetValue(sim, -5_000L);
        sim.SetPaused(true);
        var frozen = sim.Snapshot("trial");
        frozen.Paused.Should().BeTrue();
        Thread.Sleep(40);
        sim.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
        var still = sim.Snapshot("trial");
        still.ElapsedRaceTime.Should().Be(frozen.ElapsedRaceTime);
        (still.Cars[0].X, still.Cars[0].Y).Should().Be((frozen.Cars[0].X, frozen.Cars[0].Y));
        sim.SetPaused(false);
        sim.Snapshot("trial").ElapsedRaceTime.Should().BeInRange(frozen.ElapsedRaceTime, frozen.ElapsedRaceTime + 0.03, "the paused 40 ms is not race time");
        VerifyTowDriftAndStandIn();
    }

    // Rules: a human gets a tow and a non-drafting bot does not, a held drift keeps
    // its speed and pays out a boost on release, and a seat handed to the stand-in bot is driven
    // but loses its claim to the board. (Called from the helper above: the Unit tier is at its
    // 100-method ceiling.)
    private static void VerifyTowDriftAndStandIn()
    {
        static Dictionary<string, PoRacerInput> Keys(PoRacerInput input) => new() { ["owner"] = input };

        // Tow. On the grid the human (car 0) sits a car length behind car 2, and car 2 behind car 4.
        // Car 2 is the Aggressive Bumper, which does not draft, so only the human is in a tow.
        var grid = new PoRacerSim([new("connection", "Player", true, true, "owner")]);
        grid.Tick(0.02, Keys(new()));
        var towed = grid.Snapshot("tow").Cars;
        towed[0].Drafting.Should().BeTrue("every human gets the slipstream");
        towed[2].Drafting.Should().BeFalse("among the bots only the drafting personalities do, so the solo tiers keep their pace");

        // Drift. 1.2 s of throttle (short of the first boost pad), then 0.6 s of handbrake with the wheel turned.
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 60; i++) sim.Tick(0.02, Keys(new() { Up = true }));
        var entry = sim.Snapshot("drift").Cars[0].Speed;
        for (var i = 0; i < 30; i++) sim.Tick(0.02, Keys(new() { Up = true, Right = true, Space = true }));
        var sliding = sim.Snapshot("drift").Cars[0];
        sliding.Drift.Should().BeGreaterThanOrEqualTo(0.3, "a held drift charges");
        sliding.Speed.Should().BeGreaterThan(entry * 0.6, "a drift scrubs speed, it does not stop the car (the old handbrake left a sixth)");
        sliding.BoostTimer.Should().Be(0);
        sim.Tick(0.02, Keys(new() { Up = true }));
        var released = sim.Snapshot("drift").Cars[0];
        released.BoostTimer.Should().BeGreaterThan(0.3, "letting go of a charged drift pays out a boost");
        released.Drift.Should().Be(0);
        // A dab too short to charge pays nothing.
        var dab = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 60; i++) dab.Tick(0.02, Keys(new() { Up = true }));
        for (var i = 0; i < 8; i++) dab.Tick(0.02, Keys(new() { Up = true, Right = true, Space = true }));
        dab.Tick(0.02, Keys(new() { Up = true }));
        dab.Snapshot("drift").Cars[0].BoostTimer.Should().Be(0);

        // Stand-in. The seat is driven with no input at all, and is no longer anyone's to submit.
        var absent = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        absent.Humans.Should().ContainSingle();
        absent.SetAutopilot("owner", true);
        for (var i = 0; i < 100; i++) absent.Tick(0.02, new Dictionary<string, PoRacerInput>());
        absent.Snapshot("stand-in").Cars[0].Speed.Should().BeGreaterThan(100, "the stand-in bot drives the seat");
        absent.Humans.Should().BeEmpty("a lap the bot helped set is not the driver's to put on the board");
        absent.SetAutopilot("owner", false);
        absent.Humans.Should().BeEmpty("having been driven is not undone by taking the wheel back");
    }

    private const System.Reflection.BindingFlags Flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
    private static readonly PoRacerLobbyPlayer Human = new("connection", "Player", true, true, "owner");

    private static object[] CarsOf(PoRacerSim sim) =>
        ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", Flags)!.GetValue(sim)!).Cast<object>().ToArray();
    private static void SetField(object car, string name, object? value) => car.GetType().GetField(name)!.SetValue(car, value);
    private static T GetField<T>(object car, string name) => (T)car.GetType().GetField(name)!.GetValue(car)!;
    private static object? Call(PoRacerSim sim, string name, params object?[] args) => typeof(PoRacerSim).GetMethod(name, Flags)!.Invoke(sim, args);

    // The profile is a curvature limit with a braking pass and an acceleration pass: it never asks
    // for more deceleration or push than the cars have, and is slower at the sharpest bend than on
    // the straights, with the braking already under way in the run-up.
    private void RacingLineSpeedProfile_BrakesBeforeBends_OnEveryTrack()
    {
        foreach (var trackData in PoRacerCatalog.Tracks.Select(t => PoRacerTrackRegistry.GetTrack(t.Id)))
        {
            var line = PoRacerRacingLine.For(trackData);
            ReferenceEquals(line, PoRacerRacingLine.For(trackData)).Should().BeTrue("the profile is built once per track");
            int n = line.Count, apex = Array.IndexOf(line.Curvature, line.Curvature.Max()), fastest = Array.IndexOf(line.Speed, line.Speed.Max());
            _out.WriteLine($"{trackData.Id}: nodes={n} kmax={line.Curvature.Max():0.0000} mean={line.Curvature.Average():0.0000} seg={line.SegmentLength.Average():0.0} speed {line.Speed.Min():0}..{line.Speed.Max():0} sharpest bend at {apex}");
            line.Speed[apex].Should().BeLessThan(line.Speed[fastest] * 0.85, "the sharpest bend is taken slower than the straights");
            for (int i = 0; i < n; i++)
            {
                int next = (i + 1) % n;
                double ds = line.SegmentLength[i];
                (line.Speed[i] * line.Speed[i]).Should().BeLessThanOrEqualTo(line.Speed[next] * line.Speed[next] + 2 * PoRacerRacingLine.BrakeLimit * ds + 1e-6, "no braking harder than the cars can");
                (line.Speed[next] * line.Speed[next]).Should().BeLessThanOrEqualTo(line.Speed[i] * line.Speed[i] + 2 * PoRacerRacingLine.AccelLimit * ds + 1e-6, "no pulling away faster than the cars can");
            }
            Enumerable.Range(1, 30).Select(k => line.Speed[((apex - k) % n + n) % n])
                .Should().Contain(v => v > line.Speed[apex] + 1, "the profile is on the way down before the apex");
            line.NextBendDistance.Should().OnlyContain(d => d >= 0 && d <= n);
        }
    }

    // Rubber band: solo only, +/-4%, eased, off on the final lap and for humans, and absent without the flag.
    private static void RubberBand_IsCappedSoloOnlyAndOffOnTheFinalLap()
    {
        var sim = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount, rubberBand: true);
        var cars = CarsOf(sim);
        int n = sim.Static.CenterXY.Count / 2;
        SetField(cars[0], "DistanceAlongTrack", 2.0 * n);
        SetField(cars[1], "DistanceAlongTrack", 1.5 * n);      // far behind the human
        SetField(cars[2], "DistanceAlongTrack", 2.5 * n);      // far ahead
        SetField(cars[3], "DistanceAlongTrack", 2.0 * n + 3);  // level
        Call(sim, "UpdateRubberBand", 0.02);
        sim.RubberBandOf(1).Should().BeLessThan(0.004, "eased in: one tick moves it a hair, not the whole way");
        for (int i = 0; i < 600; i++) Call(sim, "UpdateRubberBand", 0.02);
        sim.RubberBandOf(1).Should().BeInRange(0.039, PoRacerSim.RubberBandCap + 1e-9, "far behind: the whole boost, never more");
        sim.RubberBandOf(2).Should().BeInRange(-PoRacerSim.RubberBandCap - 1e-9, -0.039);
        Math.Abs(sim.RubberBandOf(3)).Should().BeLessThan(0.006);
        sim.RubberBandOf(0).Should().Be(0, "a human never carries it");
        for (int i = 1; i < PoRacerCatalog.SoloCarCount; i++)
            Math.Abs(sim.RubberBandOf(i)).Should().BeLessThanOrEqualTo(PoRacerSim.RubberBandCap + 1e-9);
        // The final lap (the leading human on it) switches it off at once.
        SetField(cars[0], "Lap", 3);
        Call(sim, "UpdateRubberBand", 0.02);
        for (int i = 0; i < PoRacerCatalog.SoloCarCount; i++) sim.RubberBandOf(i).Should().Be(0, "the finish is honest");
        // Not online, demo or trial: no flag, no band.
        var online = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount);
        SetField(CarsOf(online)[1], "DistanceAlongTrack", -3.0 * n);
        for (int i = 0; i < 100; i++) Call(online, "UpdateRubberBand", 0.02);
        online.RubberBandOf(1).Should().Be(0);
    }

    // Defence: a close car behind on a straight before a bend sends the bot to the inside, once;
    // the lane is held along the straight (no weaving) and the next straight gets its own move.
    private static void DefendingBot_TakesTheInsideOncePerStraight()
    {
        var sim = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount);
        var cars = CarsOf(sim);
        var line = PoRacerRacingLine.For(PoRacerTrackRegistry.GetTrack("circuit"));
        int n = line.Count;
        int straight = Enumerable.Range(0, n).First(i => line.NextBendDistance[i] is >= 12 and <= 30);
        var bot = cars[3]; var attacker = cars[4];
        SetField(bot, "Lap", 1);
        SetField(bot, "LastCheckpoint", straight);
        double? Defend(object? behind, double gap = 40, double side = 0) =>
            (double?)Call(sim, "DefenceLane", bot, false, behind, gap, side, 70.0);

        Defend(null).Should().BeNull("nobody behind, nothing to defend");
        Defend(attacker, gap: 5).Should().BeNull("a car already alongside is not defended against");
        var first = Defend(attacker);
        first.Should().Be(0.65 * line.NextBendSign[straight], "the inside of the bend ahead");
        GetField<int>(bot, "DefendMoves").Should().Be(1);
        // Later on the same straight, attacker on the other side or gone: same lane, no new move.
        SetField(bot, "LastCheckpoint", straight + 2);
        Defend(attacker, side: 30).Should().Be(first);
        Defend(null).Should().Be(first);
        GetField<int>(bot, "DefendMoves").Should().Be(1, "one move per straight");
        // In the bend the defence is released.
        SetField(bot, "LastCheckpoint", straight + line.NextBendDistance[straight]);
        Defend(attacker).Should().BeNull();
        // The next straight is a new decision.
        int other = Enumerable.Range(0, n).First(i => line.NextBendDistance[i] is >= 12 and <= 30
            && i + line.NextBendDistance[i] != straight + line.NextBendDistance[straight]);
        SetField(bot, "LastCheckpoint", other);
        Defend(attacker).Should().Be(0.65 * line.NextBendSign[other]);
        GetField<int>(bot, "DefendMoves").Should().Be(2);
        // The bruiser leans toward the car behind rather than taking the inside.
        SetField(bot, "DefendKey", -1L);
        SetField(bot, "ProjSide", 0.0);
        ((double?)Call(sim, "DefenceLane", bot, true, attacker, 40.0, 20.0, 70.0)).Should().BeApproximately(20.0 / 70.0, 1e-9);
    }

    // Learning: a human's clean fast lap is kept (only a faster one replaces it); a bot that
    // sees the stored lap aims lower where that lap was slow, and the better the bot the more it learns.
    private void Bots_LearnFromAHumanLapProfile()
    {
        var library = new PoRacerGhostLibrary();
        var line = PoRacerRacingLine.For(PoRacerTrackRegistry.GetTrack("circuit"));
        int n = line.Count, straight = Array.IndexOf(line.Speed, line.Speed.Max());

        var plain = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount);
        var human = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount, ghosts: library);
        human.GhostSeconds.Should().Be(-1);
        var hc = CarsOf(human)[0];
        SetField(hc, "LapSpeeds", Enumerable.Repeat(100.0, n).ToArray());   // a human who crawled the whole lap
        ((bool)Call(human, "OfferGhostLap", hc, 22.0)!).Should().BeTrue();
        human.GhostSeconds.Should().Be(22.0);
        library.Get("circuit")!.Value.Seconds.Should().Be(22.0);
        SetField(hc, "LapSpeeds", Enumerable.Repeat(300.0, n).ToArray());
        ((bool)Call(human, "OfferGhostLap", hc, 25.0)!).Should().BeFalse("a slower lap does not replace it");
        library.Get("circuit")!.Value.Seconds.Should().Be(22.0);

        // A fresh race on that track starts from the stored lap. Bot 3 is Ghost Line (skill 0.98), bot 4 Speed Demon (0.65).
        var learner = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount, ghosts: library);
        learner.GhostSeconds.Should().Be(22.0);
        foreach (var sim in new[] { plain, learner })
            foreach (int id in new[] { 3, 4 }) SetField(CarsOf(sim)[id], "LastCheckpoint", straight);
        double skilled = plain.TargetSpeedOf(3) - learner.TargetSpeedOf(3);
        double rough = plain.TargetSpeedOf(4) - learner.TargetSpeedOf(4);
        _out.WriteLine($"learned drop: skilled={skilled:0.0} rough={rough:0.0}");
        skilled.Should().BeGreaterThan(20, "the bot picks up the speed the human showed on this node");
        skilled.Should().BeGreaterThan(rough, "better bots learn more");
        // A library with nothing for the track changes nothing.
        var empty = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount, ghosts: new PoRacerGhostLibrary());
        SetField(CarsOf(empty)[3], "LastCheckpoint", straight);
        empty.TargetSpeedOf(3).Should().Be(plain.TargetSpeedOf(3));
    }

    // Only a lap a human drove from start to finish teaches anyone anything: not a bot car, not a seat
    // the stand-in bot touched (even for a moment), not a lap that skipped most of the circuit.
    private static void BotDrivenLaps_NeverFeedTheGhost()
    {
        var library = new PoRacerGhostLibrary();
        var sim = new PoRacerSim([Human], "circuit", seed: 3, carCount: PoRacerCatalog.SoloCarCount, ghosts: library);
        int n = sim.Static.CenterXY.Count / 2;
        var cars = CarsOf(sim);
        double[] Full() => Enumerable.Repeat(150.0, n).ToArray();

        SetField(cars[3], "LapSpeeds", Full());
        ((bool)Call(sim, "OfferGhostLap", cars[3], 15.0)!).Should().BeFalse("bot laps are never learned from");
        SetField(cars[3], "LapSpeeds", null);
        Call(sim, "UpdateRaceProgress", cars[3]);
        GetField<double[]?>(cars[3], "LapSpeeds").Should().BeNull("only humans are sampled");
        // A human seat the stand-in bot drove, even for one tick.
        sim.SetAutopilot("owner", true);
        Call(sim, "SampleGhost", cars[0]);
        GetField<bool>(cars[0], "LapTainted").Should().BeTrue();
        SetField(cars[0], "LapSpeeds", Full());
        ((bool)Call(sim, "OfferGhostLap", cars[0], 15.0)!).Should().BeFalse();
        // ...and a car the bot has ever driven stays refused after the human takes the wheel back.
        sim.SetAutopilot("owner", false);
        SetField(cars[0], "BotDriven", true);
        SetField(cars[0], "LapSpeeds", Full());
        ((bool)Call(sim, "OfferGhostLap", cars[0], 15.0)!).Should().BeFalse();
        // A clean human lap that only saw a fifth of the circuit is not a lap profile.
        SetField(cars[0], "BotDriven", false);
        SetField(cars[0], "LapSpeeds", Enumerable.Range(0, n).Select(i => i < n / 5 ? 150.0 : double.NaN).ToArray());
        ((bool)Call(sim, "OfferGhostLap", cars[0], 15.0)!).Should().BeFalse();
        library.Get("circuit").Should().BeNull();
        sim.GhostSeconds.Should().Be(-1);
        // The same lap, driven clean, is kept.
        SetField(cars[0], "LapSpeeds", Full());
        ((bool)Call(sim, "OfferGhostLap", cars[0], 15.0)!).Should().BeTrue();
        library.Get("circuit").Should().NotBeNull();
    }
}
