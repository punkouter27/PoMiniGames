using System.Diagnostics;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Plain-CLR PoRacer simulation engine — NO SignalR, NO Blazor, NO JS. The
/// <see cref="PoRacerRaceService"/> drives it on a timer and broadcasts the
/// snapshot. This is where every physics tick lives; the client renders the
/// same payload it receives, period.
/// </summary>
internal sealed class PoRacerSim
{
    private const int TotalLaps = PoRacerCatalog.TotalLaps;
    private const double CarRadius = 18;
    private const double StopAfterMs = 180_000; // Allows three real laps on the longer tracks; still bounds abandoned races.
    // Once the winner crosses the line (finishes lap 3), the pack gets this much
    // longer to finish; then the race ends and stragglers are DNF'd. Keeps the
    // race from idling to the safety cap after it's effectively decided. It was 5 s while
    // the bots lapped ten seconds slower than anyone who could steer; with the solo tiers a
    // driver who is a second or two a lap off the winner must still get to finish.
    private const double FinishGraceMs = 15_000;
    private double _leaderFinishMs = -1;
    /// <summary>
    /// The share of top speed a bot sheds for the sharpest bend. At 0.58 a bot laps the oval in
    /// about 27 s where a driver who keeps the throttle in manages 17: the cars can take every
    /// corner here far faster than the bots dare. That gap, more than top speed, is what the
    /// solo tiers move (PoRacerRaceRegistry.Join); demo and online bots keep this default.
    /// </summary>
    public const double DefaultBotCaution = 0.58;
    private readonly double _botCaution;
    // Solo races only: bots far from the leading human are nudged (UpdateRubberBand).
    private readonly bool _rubberBand;
    private readonly PoRacerRacingLine _line;
    // The fastest clean human lap so far on this track, as speed per node (PoRacerGhostLibrary
    // seeds it; SampleGhost and OfferGhostLap feed it). Bots blend their corner speed toward it.
    private readonly PoRacerGhostLibrary? _ghosts;
    private double[]? _ghost;
    private double _ghostSeconds = -1;
    private readonly Random _errRng;
    internal double GhostSeconds => _ghost is null ? -1 : _ghostSeconds;
    // Tyre grip from the weather: 1 dry, 0.90 rain, 0.80 snow. Every car carries it (SimCar.Wet).
    private readonly double _wet;

    // What moves a car's top speed: a boost pad or drift payout, a tow, and Damage. Each one
    // changes the ceiling itself, not just how hard the car pushes toward it.
    private const double BoostTopSpeed = 1.10;     // boost pad or drift payout
    private const double DraftTopSpeed = 1.04;     // sitting in another car's tow
    private const double DamageSpeedCost = 0.10;   // share of top speed lost at Damage = 1

    private static double TopSpeed(SimCar c) =>
        c.MaxSpeed * (1 - DamageSpeedCost * c.Damage) * (c.BoostTimer > 0 ? BoostTopSpeed : 1) * (c.Drafting ? DraftTopSpeed : 1)
        * (1 + c.RubberBand);

    /// <summary>The most a bot's pace is moved by the solo rubber band, either way.</summary>
    internal const double RubberBandCap = 0.04;
    /// <summary>How far (in laps) from the leading human a bot gets the whole of it.</summary>
    private const double RubberBandSpanLaps = 0.15;

    public PoRacerStaticWorld Static { get; }

    // Track
    private readonly PoRacerTrackData _track;
    private readonly List<Vec2> _centerline = new();
    private readonly List<(Vec2 a, Vec2 b)> _walls = new();
    private readonly double _trackWidth;

    // Cars + input map
    private readonly List<SimCar> _cars = new();
    private readonly Dictionary<string, SimCar> _byOwnerId = new(StringComparer.Ordinal);
    private readonly Dictionary<(int X, int Y), List<int>> _spatialGrid = new();
    private readonly List<List<int>> _spatialBuckets = new();
    private readonly List<(int A, int B)> _collisionCandidates = new();
    private int _usedSpatialBuckets;
    private double[] _segmentHeadings = [];
    private double[] _bendPrefix = [];
    private double[] _turnPrefix = [];
    internal int LastCollisionCandidateCount => _collisionCandidates.Count;

    private readonly Stopwatch _wallClock = Stopwatch.StartNew();
    private readonly Random _rng;
    private long _startElapsedMs;
    // Pause (solo only): the race clock is "now - start", so a pause freezes "now" and resuming
    // slides the start forward by the time spent paused. Every lap and finish time is measured
    // on that clock, so none of them can see the gap.
    private long _pausedAtMs = -1;

    private long NowMs => _pausedAtMs >= 0 ? _pausedAtMs : _wallClock.ElapsedMilliseconds;
    private double RaceSeconds => (NowMs - _startElapsedMs) / 1000.0;
    public bool Paused => _pausedAtMs >= 0;
    public string TrackId => _track.Id;

    /// <param name="bots">False for a time trial: only the human cars take the grid. Ignored with no humans.</param>
    /// <param name="botPace">Scales every bot's top speed and acceleration (the solo difficulty tier).</param>
    /// <param name="botCaution">How much speed a bot gives up for a bend, 0-1. See <see cref="DefaultBotCaution"/>.</param>
    /// <param name="weather">The day's weather on this track (<see cref="PoRacerWeather"/>). Rain and snow
    /// lower every car's grip; the default is a dry track, which is what the tests race on.</param>
    /// <param name="seed">Seeds the bots' steering wobble. Null (live races): Random.Shared, every
    /// race different. Tests pass one so a race is the same race every run (a lucky miss of
    /// every boost pad used to fail CI now and then).</param>
    public PoRacerSim(IReadOnlyList<PoRacerLobbyPlayer> players, string? trackId = null, int countdownSeconds = 0,
        bool bots = true, double botPace = 1.0, double botCaution = DefaultBotCaution,
        int carCount = PoRacerCatalog.CarCount, int? seed = null, string weather = PoRacerWeather.Clear,
        bool rubberBand = false, PoRacerGhostLibrary? ghosts = null)
    {
        _rubberBand = rubberBand && bots;
        _ghosts = ghosts;
        _wet = PoRacerWeather.Grip(weather);
        _rng = seed is { } fixedSeed ? new Random(fixedSeed) : Random.Shared;
        _errRng = seed is { } errSeed ? new Random(errSeed ^ 0x5EED) : Random.Shared;
        ArgumentOutOfRangeException.ThrowIfLessThan(carCount, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(carCount, PoRacerCatalog.SoloCarCount);
        _botCaution = botCaution;
        var track = PoRacerTrackRegistry.GetTrack(trackId);
        _track = track;
        _line = PoRacerRacingLine.For(track);
        if (ghosts?.Get(track.Id) is { } held) { _ghost = held.Speeds; _ghostSeconds = held.Seconds; }
        _trackWidth = track.TrackWidth;
        _centerline.Clear();
        _walls.Clear();
        _centerline.AddRange(track.Centerline);
        _walls.AddRange(track.Walls);
        BuildBendPrefix();

        // Build flat typed-array payloads for the wire format.
        var centerArr = new double[_centerline.Count * 2];
        for (int i = 0; i < _centerline.Count; i++)
        {
            centerArr[i * 2] = _centerline[i].X;
            centerArr[i * 2 + 1] = _centerline[i].Y;
        }
        var wallsArr = new double[_walls.Count * 4];
        for (int i = 0; i < _walls.Count; i++)
        {
            wallsArr[i * 4] = _walls[i].a.X;
            wallsArr[i * 4 + 1] = _walls[i].a.Y;
            wallsArr[i * 4 + 2] = _walls[i].b.X;
            wallsArr[i * 4 + 3] = _walls[i].b.Y;
        }
        Static = new PoRacerStaticWorld
        {
            TrackId = track.Id,
            Theme = track.EnvironmentTheme,
            Weather = weather,
            CenterXY = centerArr,
            WallsXY = wallsArr,
            TrackWidth = _trackWidth,
            TotalLaps = TotalLaps,
            BoostPads = track.BoostPads.Select(b => new PoRacerBoostPadWire
            {
                X = b.Position.X,
                Y = b.Position.Y,
                Radius = b.Radius,
                DirectionAngle = b.DirectionAngle
            }).ToList(),
            SurfaceZones = track.SurfaceZones.Select(s => new PoRacerSurfaceZoneWire
            {
                Name = s.Name,
                SurfaceType = s.SurfaceType.ToString().ToLowerInvariant(),
                X = s.Center.X,
                Y = s.Center.Y,
                Radius = s.Radius
            }).ToList()
        };

        // Start grid: two columns, staggered, laid along the road itself from just past the
        // line (GridSlot). It used to run in a straight line along the first segment's direction,
        // stepping 4 units further to one side every row: a long field left the road at the
        // first bend and walked off the edge of the track before it.
        // Players go first; AI fills the remaining seats for this mode.
        var palette = new[] { "#4ec3ff", "#ff5d6c", "#ffd24e", "#7eff8a", "#c47bff", "#ff944d", "#5ee7ff", "#ff77c8" };
        var playerProfile = (skill: 0.7, maxSpeed: 320.0, accel: 220.0, handling: 1.0);
        var slots = new List<(string connectionId, string name, bool isPlayer)>(carCount);
        foreach (var p in players)
        {
            slots.Add((string.IsNullOrEmpty(p.UserId) ? p.ConnectionId : p.UserId, p.DisplayName, true));
        }
        int humanCount = slots.Count;
        for (int i = humanCount; i < carCount && (bots || humanCount == 0); i++)
        {
            var p = PoRacerAiDriver.GetPersonality(i);
            var name = i < PoRacerCatalog.CarCount ? p.Name : $"{p.Name} {i + 1}";
            slots.Add(($"bot-{i}", name, false));
        }

        for (int i = 0; i < slots.Count && i < carCount; i++)
        {
            var s = slots[i];
            // Every human gets the same car. The profile used to be picked by grid slot, so the
            // second driver in an online race had 15 more top speed and acceleration than the
            // first, on a board that ranks best laps.
            var prof = playerProfile;
            var personality = s.isPlayer ? null : PoRacerAiDriver.GetPersonality(i);
            var (pos, gridHeading, gridNode) = GridSlot(i);
            string carColor = personality?.PrimaryColor ?? palette[i];
            var car = new SimCar
            {
                Id = i,
                OwnerId = s.connectionId,
                Name = s.name,
                IsPlayer = s.isPlayer,
                Personality = personality,
                Color = carColor,
                ColorDark = Darken(carColor),
                Livery = PoRacerCatalog.Liveries[i % PoRacerCatalog.Liveries.Count],
                Pos = pos,
                Heading = gridHeading,
                MaxSpeed = personality is null ? prof.maxSpeed : personality.MaxSpeed * botPace,
                Acceleration = personality is null ? prof.accel : personality.Acceleration * botPace,
                Handling = personality?.Handling ?? prof.handling,
                CorneringSkill = personality?.CorneringSkill ?? prof.skill,
                Lane = personality?.LateralOffsetRatio ?? 0,
                Wet = _wet,
                // A small fixed misjudgement of how hard each bend is, bigger for the less skilled.
                LineError = personality is null ? 0 : (_errRng.NextDouble() - 0.5) * 0.16 * (1.15 - personality.CorneringSkill),
                Lap = 1,
                // Where on the lap the slot is: the search for a car's place on the centerline
                // starts from here, and a slot far up the road is far from node 0.
                LastCheckpoint = gridNode,
                CheckpointT = 0,
                DistanceAlongTrack = 0,
            };
            _cars.Add(car);
            if (s.isPlayer) _byOwnerId[s.connectionId] = car;
        }

        _startElapsedMs = _wallClock.ElapsedMilliseconds + Math.Max(0, countdownSeconds) * 1000L;
        foreach (var car in _cars) { Project(car); UpdateRaceProgress(car); }
        Rank();
        Static.Roster = BuildRoster();
    }

    /// <summary>
    /// Grid slot <paramref name="index"/>: its position, the way it faces and the centerline
    /// node it sits on. Slots come in pairs, 44 units of road apart; the left car of a pair is
    /// 30 to the left of the centerline and the right one 30 to the right and half a pair
    /// further up the road, the stagger of a real grid. Each slot is measured along the centerline, so
    /// the field bends with the road and every car faces down it. The first pair is 60 past the
    /// line and later pairs are further up the road, so the humans (the lowest indices) start
    /// at the back, as they always have.
    /// </summary>
    private (Vec2 Pos, double Heading, int Node) GridSlot(int index)
    {
        const double firstRow = 60, rowGap = 44, column = 30;
        bool right = index % 2 == 1;
        double along = firstRow + (index / 2) * rowGap + (right ? rowGap * 0.5 : 0);
        int n = _centerline.Count, node = 0;
        // Walk the centerline to that distance (at most once round: no grid is a lap long).
        for (int walked = 0; walked < n; walked++)
        {
            var a = _centerline[node];
            var b = _centerline[(node + 1) % n];
            double length = Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y));
            if (along <= length || walked == n - 1)
            {
                double t = length > 1e-9 ? Math.Min(1, along / length) : 0;
                var normal = Normal(a, b);
                double side = right ? column : -column;
                return (new Vec2(a.X + (b.X - a.X) * t + normal.X * side, a.Y + (b.Y - a.Y) * t + normal.Y * side),
                    Math.Atan2(b.Y - a.Y, b.X - a.X), node);
            }
            along -= length;
            node = (node + 1) % n;
        }
        return (_centerline[0], 0, 0);
    }

    public int? CarIdForOwner(string ownerId) => _byOwnerId.TryGetValue(ownerId, out var car) ? car.Id : null;

    /// <summary>
    /// The human seats, as (owner id, car id): who a finished race's laps belong to. A seat the
    /// stand-in bot drove for even one tick is left out, so a lap a bot set can never be
    /// submitted to the board under the absent driver's name.
    /// </summary>
    public IEnumerable<(string OwnerId, int CarId)> Humans =>
        _byOwnerId.Where(p => !p.Value.BotDriven).Select(p => (p.Key, p.Value.Id));

    /// <summary>
    /// Hand a human's car to the bot driver, or back. A shared race does this for a seat nobody
    /// is connected to: otherwise a driver who closed the tab would leave a parked car on the
    /// racing line for everyone else, for the rest of the race.
    /// </summary>
    public void SetAutopilot(string ownerId, bool on)
    {
        if (_byOwnerId.TryGetValue(ownerId, out var car)) car.Autopilot = on;
    }

    private List<PoRacerCarInfo> BuildRoster() => _cars
        .Select(c => new PoRacerCarInfo(c.Id, c.Name, c.Color, c.ColorDark, c.Livery, c.IsPlayer, c.Personality?.Trait ?? ""))
        .ToList();

    /// <summary>
    /// Paint a human's car. The values come off the wire, so anything that is not a #rrggbb colour
    /// or a known livery is ignored. Returns true when the roster changed and must be re-sent.
    /// </summary>
    public bool SetPaint(string ownerId, string? colorHex, string? livery)
    {
        if (!_byOwnerId.TryGetValue(ownerId, out var car)) return false;
        var color = colorHex is { Length: 7 } hex && hex[0] == '#' && hex.Skip(1).All(Uri.IsHexDigit) ? hex.ToLowerInvariant() : car.Color;
        var style = livery is not null && PoRacerCatalog.Liveries.Contains(livery) ? livery : car.Livery;
        if (color == car.Color && style == car.Livery) return false;
        car.Color = color;
        car.ColorDark = Darken(color);
        car.Livery = style;
        Static.Roster = BuildRoster();
        return true;
    }

    public void SetPaused(bool paused)
    {
        if (paused == Paused) return;
        if (paused) _pausedAtMs = _wallClock.ElapsedMilliseconds;
        else
        {
            _startElapsedMs += _wallClock.ElapsedMilliseconds - _pausedAtMs;
            _pausedAtMs = -1;
        }
    }

    public void Tick(double dt, IReadOnlyDictionary<string, PoRacerInput> inputs)
    {
        // Inputs may be held through the countdown, but no car moves before GO.
        if (Paused || NowMs < _startElapsedMs) return;
        // These spatial buckets are also used to find the few nearby cars that can
        // contribute a tow; rebuilding after movement supplies collision candidates.
        BuildSpatialGrid(160);
        // Update surface friction and boost pads for every car
        foreach (var c in _cars)
        {
            UpdateSurfaceAndBoost(c, dt);
        }

        UpdateRubberBand(dt);

        // Apply player input.
        foreach (var (cid, car) in _byOwnerId)
        {
            if (car.Lap > TotalLaps) continue;
            if (car.Autopilot)
            {
                car.BotDriven = true;
                UpdateAi(car, dt);
                continue;
            }
            inputs.TryGetValue(cid, out var inp);
            // A non-zero analog axis (gamepad) wins over its key. Clamped here: this is the wire.
            double steer = Axis(inp?.Steer, -1) is var sx && sx != 0 ? sx : (inp?.Right == true ? 1 : 0) - (inp?.Left == true ? 1 : 0);
            double throttle = Axis(inp?.Throttle, 0) is var tv && tv > 0 ? tv : inp?.Up == true ? 1 : 0;
            double brake = Axis(inp?.Brake, 0) is var bv && bv > 0 ? bv : inp?.Down == true ? 1 : 0;
            ApplyControl(car, dt, throttle, brake, steer, inp?.Space ?? false);
        }
        // AI.
        foreach (var c in _cars)
        {
            if (c.IsPlayer) continue;
            if (c.Lap > TotalLaps) continue;
            UpdateAi(c, dt);
        }
        // Finished cars coast to a halt just past the line instead of being driven,
        // so they don't mill around the finish under collision impulses.
        foreach (var c in _cars)
        {
            if (c.Lap <= TotalLaps) continue;
            c.Speed *= Math.Max(0, 1 - 3.5 * dt);
            if (Math.Abs(c.Speed) < 2) c.Speed = 0;
            var coast = c.Heading - c.Slip;
            c.Pos = new Vec2(c.Pos.X + Math.Cos(coast) * c.Speed * dt,
                             c.Pos.Y + Math.Sin(coast) * c.Speed * dt);
        }
        // Car-car collisions.
        BuildCollisionCandidates();
        ResolveCarCollisions();
        // Yaw from an off-centre hit keeps turning the car for a moment after the contact,
        // then the tyres win and it grips up again.
        foreach (var c in _cars)
        {
            if (Math.Abs(c.Spin) < 1e-4) { c.Spin = 0; continue; }
            c.Heading += c.Spin * dt;
            c.Spin *= Math.Max(0, 1 - 5 * dt);
        }
        // Hard safety bound: collision impulses on a jam of stopped cars could
        // otherwise integrate into absurd runaway speeds (the finish-line pile-up).
        // (A boosted car in a tow legitimately runs about 15% over MaxSpeed, hence the headroom.)
        foreach (var c in _cars) c.Speed = Math.Clamp(c.Speed, -c.MaxSpeed, c.MaxSpeed * 1.2);
        // Project onto centerline.
        foreach (var c in _cars) Project(c);
        // Wall collisions.
        foreach (var c in _cars) ResolveWallCollision(c);
        // Lap detection + finish time.
        foreach (var c in _cars) UpdateRaceProgress(c);
        // Rank.
        Rank();

        // Race-end: the winner has crossed the line → start the finish grace.
        // When the grace expires (or the safety cap hits) declare any car
        // still running as DNF, so the race ends when the 3rd lap is won rather
        // than idling on until the cap.
        var elapsed = NowMs - _startElapsedMs;
        if (_leaderFinishMs < 0 && _cars.Any(c => c.Lap > TotalLaps))
        {
            _leaderFinishMs = elapsed;
        }
        var graceExpired = _leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs;
        if ((elapsed > StopAfterMs || graceExpired) && !_cars.All(c => c.Lap > TotalLaps))
        {
            foreach (var c in _cars)
            {
                if (c.Lap <= TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = double.PositiveInfinity;
                }
            }
        }
    }

    private void UpdateSurfaceAndBoost(SimCar c, double dt)
    {
        // 1. Boost pads check
        foreach (var pad in _track.BoostPads)
        {
            if (pad.Contains(c.Pos))
            {
                c.BoostTimer = pad.DurationSeconds;
                c.BoostGlow = 1.0;
                break;
            }
        }

        // Boost decay
        if (c.BoostTimer > 0)
        {
            c.BoostTimer -= dt;
            c.AccelerationModifier = 1.35;
            c.BoostGlow = Math.Max(c.BoostGlow, Math.Min(1.0, c.BoostTimer / 1.8));
        }
        else
        {
            c.BoostTimer = 0;
            c.AccelerationModifier = 1.0;
        }

        // 2. Surface zone check (sand vs tarmac)
        string detectedSurface = "asphalt";
        double grip = 1.0;
        foreach (var zone in _track.SurfaceZones)
        {
            if (zone.Contains(c.Pos))
            {
                detectedSurface = zone.SurfaceType.ToString().ToLowerInvariant();
                grip = zone.GripMultiplier;
                break;
            }
        }
        c.Surface = detectedSurface;
        c.EffectiveGrip = grip;

        // 3. Slipstream: tucked in behind another car. Every human gets it; among the bots only
        // the two drafting personalities do, as before, so the solo tiers keep their pace.
        c.Drafting = (c.IsPlayer || c.Personality?.PrefersDrafting == true) && HasDraftingTarget(c);
        if (c.Drafting) c.AccelerationModifier = Math.Max(c.AccelerationModifier, 1.15);
        // Eased, not snapped: the tow meter and the pressure-wave effect read this.
        c.DraftStrength = Math.Clamp(c.DraftStrength + ((c.Drafting ? 1 : 0) - c.DraftStrength) * Math.Min(1, 6 * dt), 0, 1);
    }

    private bool HasDraftingTarget(SimCar car)
    {
        var cell = SpatialCell(car.Pos, 160);
        for (int x = cell.X - 1; x <= cell.X + 1; x++)
        {
            for (int y = cell.Y - 1; y <= cell.Y + 1; y++)
            {
                if (!_spatialGrid.TryGetValue((x, y), out var bucket)) continue;
                foreach (var index in bucket)
                {
                    var other = _cars[index];
                    if (other.Id != car.Id && other.Lap <= TotalLaps
                        && PoRacerAiDriver.IsDrafting(car.Pos, car.Heading, other.Pos))
                    {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static double Axis(double? value, double min) =>
        value is { } v && double.IsFinite(v) ? Math.Clamp(v, min, 1) : 0;

    /// <param name="throttle">0…1.</param><param name="braking">0…1.</param><param name="steerInput">-1 (left) … 1 (right).</param>
    private static void ApplyControl(SimCar c, double dt, double throttle, double braking, double steerInput, bool handbrake)
    {
        bool accel = throttle > 0, brake = braking > 0;
        double steerRate = 3.0 * c.Handling * c.EffectiveGrip;
        double maxSteer = 0.55;
        c.Steer += (steerInput - c.Steer / maxSteer) * steerRate * dt;
        c.Steer = Math.Clamp(c.Steer, -maxSteer, maxSteer);
        if (steerInput == 0) c.Steer *= Math.Max(0, 1 - 2.0 * dt);

        double before = c.Speed;
        // A wet or snowy road (c.Wet under 1) spins some of the push away and lengthens every stop.
        double engine = c.Acceleration * c.AccelerationModifier * throttle * (0.6 + 0.4 * c.Wet) * (1 + c.RubberBand);
        engine -= c.Acceleration * (c.Speed > 1 ? 1.6 : 0.6) * braking * c.Wet;
        c.Speed += engine * dt;
        double drag = 0.6 + Math.Abs(c.Speed) * 0.004;
        c.Speed -= Math.Sign(c.Speed) * drag * dt;
        if (Math.Abs(c.Speed) < 0.5 && !accel && !brake) c.Speed = 0;

        // The handbrake with the wheel turned, at speed, on tarmac, is a drift: the car rotates
        // half again as fast and scrubs about a third of what a straight-line pull does. A drift
        // that was only that pull plus MORE understeer would make the one control named
        // after cornering make every corner worse. Holding a drift charges it; letting go pays
        // the charge out as a short boost, so it is a way round a tight bend, not a free one
        // down a straight (the scrub costs about what the payout returns).
        bool onSand = c.Surface == "sand";
        bool drift = handbrake && !onSand && Math.Abs(c.Steer) > 0.15 && c.Speed > c.MaxSpeed * 0.3;
        if (handbrake) c.Speed *= Math.Max(0, 1 - (drift ? 1.1 : 3.0) * dt);
        if (drift) c.DriftCharge = Math.Min(1, c.DriftCharge + dt);
        else if (c.DriftCharge > 0)
        {
            if (handbrake) c.DriftCharge = Math.Max(0, c.DriftCharge - dt);   // straightened up, still on the brake
            else
            {
                if (c.DriftCharge >= 0.3)
                {
                    c.BoostTimer = Math.Max(c.BoostTimer, 0.35 + 0.65 * c.DriftCharge);
                    c.BoostGlow = 1;
                }
                c.DriftCharge = 0;
            }
        }

        // Top speed moves with boost, tow and damage. Over it (the boost just ran out) the car
        // bleeds back down instead of snapping; under it this is the plain clamp it always was.
        double top = TopSpeed(c);
        if (c.Speed > top) c.Speed = Math.Max(top, Math.Min(c.Speed, before) - 150 * dt);
        c.Speed = Math.Max(c.Speed, -c.MaxSpeed * 0.4);

        double speedFactor = Math.Min(1, Math.Abs(c.Speed) / 80);
        double turnRate = (c.Speed / 60.0) * c.Steer * (1.0 - 0.3 * speedFactor) * (drift ? 1.5 : 1.0);
        // Less grip is understeer, and more of it the faster the car is going: at top speed in
        // the rain a car turns 10% less, in snow 20% less. Dry (Wet = 1) every one of these is
        // the number it always was.
        turnRate *= 1 - (1 - c.Wet) * Math.Min(1, Math.Abs(c.Speed) / c.MaxSpeed);

        // ── Slip ────────────────────────────────────────────────────────────────
        // The nose follows the steering wheel; the car's mass follows the nose only as fast as
        // the tyres can drag it round. The angle between the two is the slip angle, and it is
        // what a drift IS: past the tyres' limit the car keeps travelling along its old line
        // while the nose points into the corner, and the driver has to steer out of it.
        //
        // Grip is weather and tyre heat: heat is the scrub from the last few corners, and it
        // cools again once the car runs straight, so a long drift costs real grip.
        double grip = Math.Max(0.35, c.EffectiveGrip * c.Wet * (1 - 0.14 * c.TireHeat));
        double demand = Math.Abs(turnRate) * 18 / Math.Max(60, Math.Abs(c.Speed)) / grip;
        if (drift) demand = Math.Max(demand, 0.34 + 0.2 * c.DriftCharge);
        if (handbrake) demand = Math.Max(demand, 0.48);
        if (onSand) demand = Math.Max(demand, 0.3);
        // Below about 40 units/s there is not enough speed to break traction at all.
        if (Math.Abs(c.Speed) < 40) demand *= Math.Abs(c.Speed) / 40;
        demand = Math.Min(0.62, demand);
        double slipTarget = Math.Sign(turnRate) * demand;
        // Slip builds faster than it recovers: a car lets go quickly and grips up slowly.
        double slipRate = demand > Math.Abs(c.Slip) ? 6.0 : 3.0;
        c.Slip += (slipTarget - c.Slip) * Math.Min(1, slipRate * dt);

        c.Heading += turnRate * dt;

        // A sliding tyre turns forward motion into noise, heat and smoke. The scrub is what
        // keeps a drift a way round a corner rather than a free one.
        double slipAbs = Math.Abs(c.Slip);
        if (slipAbs > 0.1)
        {
            c.Speed *= Math.Max(0, 1 - slipAbs * 1.1 * dt);
            c.SkidIntensity = Math.Min(1, c.SkidIntensity + dt * (2 + slipAbs * 8));
        }
        else
        {
            c.SkidIntensity *= Math.Max(0, 1 - 3 * dt);
        }
        double scrubRate = slipAbs * Math.Abs(c.Speed) / 9000 + (handbrake ? 0.35 : 0);
        c.TireHeat = Math.Clamp(c.TireHeat + (scrubRate - 0.18) * dt, 0, 1);

        // Travel is along the direction the car is actually moving: the nose minus the slip.
        double travel = c.Heading - c.Slip;
        c.Pos = new Vec2(c.Pos.X + Math.Cos(travel) * c.Speed * dt, c.Pos.Y + Math.Sin(travel) * c.Speed * dt);

        c.BoostGlow *= Math.Max(0, 1 - 2 * dt);
        if (accel && Math.Abs(c.Speed) > c.MaxSpeed * 0.85) c.BoostGlow = Math.Min(1, c.BoostGlow + dt * 2);
    }

    private void UpdateAi(SimCar c, double dt)
    {
        int n = _centerline.Count;

        // Stuck accounting + marshal rescue, evaluated first so nothing can pin a
        // bot for the whole race. We track lack of TRACK PROGRESS (not just low
        // speed): a bot boxed at the grid or scraped onto a wall can thrash back and
        // forth with speed yet advance nowhere — the old AI's core failure mode.
        // If a bot fails to advance for a sustained spell despite the reverse
        // maneuver below, a marshal places it back on the racing line facing forward
        // — a hard completion guarantee.
        // Monotonic track progress in node units (n per lap) — unlike DistanceAlongTrack
        // this never dips at the start/finish line, so it won't false-flag a lapping car.
        double progress = c.Lap * n + c.ProjIdx + c.ProjT;
        if (progress > c.ProgressMark + 0.5)
        {
            c.ProgressMark = progress;
            c.StuckTimer = 0;
        }
        else
        {
            c.StuckTimer += dt;
        }
        if (c.StuckTimer > 2.0)
        {
            // Nudge a few nodes PAST the snag, not back onto it, so a bot that keeps
            // re-wedging at the same corner still nets forward progress each rescue.
            int pi = ((c.ProjIdx + 5) % n + n) % n;
            var cp = _centerline[pi];
            var nb = _centerline[(pi + 1) % n];
            c.Pos = cp;
            c.Heading = Math.Atan2(nb.Y - cp.Y, nb.X - cp.X);
            c.Speed = c.MaxSpeed * 0.32;
            c.Steer = 0;
            c.StuckTimer = 0;
            return;
        }

        double speedFrac = Math.Clamp(Math.Abs(c.Speed) / c.MaxSpeed, 0, 1);

        // How hard the track bends over a speed-scaled window ahead, and which way. The late
        // braker looks a little less far, so it finds out about a bend later than the others.
        var style = c.Personality?.Style ?? PoRacerAiStyle.Steady;
        int scan = (int)(9 + speedFrac * 15);
        if (style == PoRacerAiStyle.LateBraker) scan = (int)(scan * 0.85);
        double bend = UpcomingBend(c.LastCheckpoint, scan);
        double turn = UpcomingTurn(c.LastCheckpoint, scan);

        // Which lane to drive in: -1 is the left edge of the usable road, 1 the right. Every bot
        // starts from the racing line's apex lane (the inside of the bend ahead, more of it the
        // more skilled the driver); each style then picks its own, from the track and the cars around it.
        Nearby(c, out var ahead, out double aheadGap, out double aheadSide, out var beside, out double besideSide);
        Behind(c, out var behind, out double behindGap, out double behindSide);
        double laneWidth = _trackWidth * 0.35;
        double lane = c.Personality?.LateralOffsetRatio ?? 0;
        double LaneOf(double side) => (c.ProjSide + side) / laneWidth;
        int apexIdx = (c.LastCheckpoint + (int)(3 + speedFrac * 6)) % n;
        lane += _line.Apex[apexIdx] * (0.35 + 0.5 * c.CorneringSkill);
        switch (style)
        {
            case PoRacerAiStyle.ApexHugger:
                if (Math.Abs(turn) > 0.25) lane = 0.75 * Math.Sign(turn);        // the inside of the bend
                break;
            case PoRacerAiStyle.Bruiser:
                if (beside is not null) lane = LaneOf(besideSide);               // into the car alongside
                break;
            case PoRacerAiStyle.Cautious:
                if (beside is not null) lane = besideSide > 0 ? -0.7 : 0.7;      // away from it
                break;
            case PoRacerAiStyle.DraftHunter:
                if (ahead is not null) lane = LaneOf(aheadSide);                 // into its tow
                break;
            case PoRacerAiStyle.Slingshot:
                // In the tow until it is a car length off, then out of it and past.
                if (ahead is not null) lane = LaneOf(aheadSide) + (aheadGap > 60 ? 0 : LaneOf(aheadSide) > 0 ? -0.7 : 0.7);
                break;
            case PoRacerAiStyle.Wildcard:
                c.WhimTimer -= dt;
                if (c.WhimTimer <= 0)
                {
                    c.WhimTimer = 2 + _rng.NextDouble() * 3;
                    c.Whim = _rng.NextDouble() * 1.4 - 0.7;
                    if (_rng.NextDouble() < 0.25) c.HotTimer = 0.7;              // forgets the next bend
                }
                lane = c.Whim;
                break;
        }
        // A car close behind on a straight before a bend: take (and keep) the inside line.
        if (DefenceLane(c, style == PoRacerAiStyle.Bruiser, behind, behindGap, behindSide, laneWidth) is { } defend) lane = defend;
        // Caught a slower car: go round it, on the side with room. The bruiser drives into the
        // back of it instead, and the two drafters have their own plan for a car ahead.
        bool blocked = ahead is not null && aheadGap < 70 && Math.Abs(aheadSide) < 30 && c.Speed > ahead.Speed;
        c.PassHold = Math.Max(0, c.PassHold - dt);
        c.PassCooldown = Math.Max(0, c.PassCooldown - dt);
        if (style is not (PoRacerAiStyle.Bruiser or PoRacerAiStyle.DraftHunter or PoRacerAiStyle.Slingshot))
            lane = OvertakeLane(c, ahead, aheadGap, aheadSide, beside, besideSide, laneWidth, lane);
        // Eased, so a change of mind is a lane change and not a swerve.
        c.Lane += (Math.Clamp(lane, -0.9, 0.9) - c.Lane) * Math.Min(1, 2.5 * dt);

        // Aim a few nodes down the track, in that lane.
        double lookFactor = c.Personality?.LookaheadFactor ?? 1.0;
        int steerLook = (int)((3 + speedFrac * 6 + c.CorneringSkill * 3) * lookFactor);
        int aimIdx = (c.LastCheckpoint + steerLook) % n;
        var target = _centerline[aimIdx];
        if (c.Lane != 0)
        {
            var nrm = PoRacerTrackRegistry.ComputeNormal(target, _centerline[(aimIdx + 1) % n]);
            target = new Vec2(target.X + nrm.X * (c.Lane * laneWidth), target.Y + nrm.Y * (c.Lane * laneWidth));
        }

        // (The tow is worked out for every car in UpdateSurfaceAndBoost.)

        double desired = Math.Atan2(target.Y - c.Pos.Y, target.X - c.Pos.X);
        double diff = ShortAngleDiff(desired, c.Heading);

        // Predictive corner speed: slow to a speed the car can actually hold through the bend
        // ahead. Straights are near top speed; tight bends a small fraction. How much a bot
        // lifts is the race's caution (the solo tier) times its own.
        double caution = Math.Min(0.9, _botCaution * (c.Personality?.Caution ?? 1.0));
        if (c.HotTimer > 0) { c.HotTimer -= dt; caution *= 0.35; }
        double cornerSpeed = TargetSpeed(c, bend, caution);

        const double deadband = 0.05;
        bool accel, brake = false, handbrake = false;
        bool left = diff < -deadband, right = diff > deadband;

        // Once the crawl has lasted a moment, back STRAIGHT out to make room, then
        // resume. If reversing still can't free the car the marshal rescue above
        // eventually fires; here we give it every chance to recover on its own first.
        if (c.StuckTimer > 0.7)
        {
            accel = false; brake = true;             // low speed + brake ⇒ reverse
            left = false; right = false;             // straight back-out; steer relaxes to centre
        }
        else if (Math.Abs(c.Speed) < c.MaxSpeed * 0.18)
        {
            accel = true;                            // slow but not wedged → power out toward aim
        }
        else if (c.Speed > cornerSpeed * 1.05) { accel = false; brake = true; }   // shed speed
        else if (c.Speed > cornerSpeed) { accel = false; }                 // coast to target
        else { accel = true; }                 // power on

        // The cautious driver will not touch the car in front: it lifts, and brakes if that is not enough.
        if (style == PoRacerAiStyle.Cautious && blocked && c.StuckTimer <= 0.7 && Math.Abs(c.Speed) >= c.MaxSpeed * 0.18)
        {
            accel = false;
            if (aheadGap < 45) brake = true;
        }

        // Badly misaligned at speed (nose toward a wall) → brake to bleed it off.
        if (c.StuckTimer <= 0.7 && Math.Abs(c.Speed) >= c.MaxSpeed * 0.18 && Math.Abs(diff) > 1.25)
        {
            brake = true; accel = false;
        }

        ApplyControl(c, dt, accel ? 1 : 0, brake ? 1 : 0, (right ? 1 : 0) - (left ? 1 : 0), handbrake);

        // Small stochastic imperfection so the field isn't robotic; less for skilled bots.
        if (_rng.NextDouble() < 0.015 * (1.15 - c.CorneringSkill))
        {
            c.Steer += (_rng.NextDouble() - 0.5) * 0.06;
        }
    }

    /// <summary>
    /// The speed a bot aims for this tick. The racing line's profile (curvature limit with its
    /// braking and acceleration passes, so it knows where to start lifting) is blended with the
    /// local look-ahead bend, the more of it the more skilled the driver; a small fixed error
    /// per car keeps the field apart. Then the bot's own caution says how close to that it drives,
    /// and, when a human has set a clean lap, the bot learns toward the speeds that lap showed.
    /// </summary>
    private double TargetSpeed(SimCar c, double bend, double caution)
    {
        int n = _centerline.Count;
        var style = c.Personality?.Style ?? PoRacerAiStyle.Steady;
        int sample = (c.LastCheckpoint + (style == PoRacerAiStyle.LateBraker ? 0 : 2)) % n;
        double local = Math.Clamp(bend / 0.85, 0, 1);
        double profile = Math.Clamp((1 - _line.Speed[sample] / PoRacerRacingLine.TopSpeed) / 0.6, 0, 1);
        double curviness = Math.Clamp(local + (profile - local) * (0.35 + 0.5 * c.CorneringSkill) + c.LineError, 0, 1);
        double aggression = c.Personality?.Aggression ?? 0.5;
        // Scaled from the car's top speed of the moment, not its nominal one: on a boost pad a
        // bot is well over MaxSpeed, and measured against that it would brake for the boost.
        double top = TopSpeed(c);
        double cornerSpeed = top * (1.0 - caution * curviness) * (0.90 + 0.12 * c.CorneringSkill + 0.08 * aggression);
        // In the wet a bend is worth less speed still; a straight is worth what it always was.
        cornerSpeed *= 1 - (1 - c.Wet) * 0.5 * Math.Min(1, curviness * 2);
        if (_ghost is not null && c.Personality is not null)
        {
            double learn = Math.Clamp((c.CorneringSkill - 0.5) * 1.2, 0, 0.6);
            cornerSpeed += (_ghost[sample] * (c.MaxSpeed / 320.0) - cornerSpeed) * learn;
        }
        return Math.Clamp(cornerSpeed, c.MaxSpeed * 0.36 * c.Wet, top);
    }

    /// <summary>What a car would aim for right now (the scan a tick of UpdateAi makes), for the tests.</summary>
    internal double TargetSpeedOf(int carId)
    {
        var c = _cars[carId];
        double speedFrac = Math.Clamp(Math.Abs(c.Speed) / c.MaxSpeed, 0, 1);
        int scan = (int)(9 + speedFrac * 15);
        return TargetSpeed(c, UpcomingBend(c.LastCheckpoint, scan), Math.Min(0.9, _botCaution * (c.Personality?.Caution ?? 1.0)));
    }

    /// <summary>The nearest car behind (8 to 90 units back, within 60 to the side), same frame as <see cref="Nearby"/>.</summary>
    private void Behind(SimCar c, out SimCar? behind, out double gap, out double side)
    {
        behind = null; gap = double.MaxValue; side = 0;
        double cos = Math.Cos(c.Heading), sin = Math.Sin(c.Heading);
        var cell = SpatialCell(c.Pos, 160);
        for (int x = cell.X - 1; x <= cell.X + 1; x++)
        {
            for (int y = cell.Y - 1; y <= cell.Y + 1; y++)
            {
                if (!_spatialGrid.TryGetValue((x, y), out var bucket)) continue;
                foreach (var index in bucket)
                {
                    var other = _cars[index];
                    if (other.Id == c.Id || other.Lap > TotalLaps) continue;
                    double dx = other.Pos.X - c.Pos.X, dy = other.Pos.Y - c.Pos.Y;
                    double back = -(dx * cos + dy * sin), lateral = dy * cos - dx * sin;
                    if (back > 8 && back <= 90 && back < gap && Math.Abs(lateral) < 60) { behind = other; gap = back; side = lateral; }
                }
            }
        }
    }

    /// <summary>
    /// Defence: with a car close behind on a straight that ends in a bend, cover the inside line.
    /// One move per straight, keyed by the bend it ends in: the lane is chosen once and held until
    /// the bend, so a defender never weaves. A car already alongside is not defended against. The
    /// bruiser leans toward the car behind instead of taking the inside; nobody else touches it.
    /// Returns null when there is nothing to defend.
    /// </summary>
    private double? DefenceLane(SimCar c, bool bruiser, SimCar? behind, double gap, double side, double laneWidth)
    {
        int n = _centerline.Count;
        int node = ((c.LastCheckpoint % n) + n) % n;
        int dist = _line.NextBendDistance[node];
        if (dist <= 3 || dist > 40) return null;
        long key = (long)c.Lap * n + node + dist;
        if (c.DefendKey == key) return c.DefendLane;
        if (behind is null || gap < 15 || gap > 70 || Math.Abs(side) > 40) return null;
        c.DefendKey = key;
        c.DefendMoves++;
        c.DefendLane = bruiser ? Math.Clamp((c.ProjSide + side) / laneWidth, -0.9, 0.9) : 0.65 * _line.NextBendSign[node];
        return c.DefendLane;
    }

    /// <summary>
    /// Overtaking: a bot closing on a car ahead picks the side to pass once (the inside of the next
    /// bend when there is room, else the side with more room), holds it while the pass lasts, and
    /// gives the move up if another car takes that side or there is no room: it drops back into line
    /// behind and tries again after a short wait. Returns the lane to drive, <paramref name="lane"/> when not passing.
    /// </summary>
    private double OvertakeLane(SimCar c, SimCar? ahead, double gap, double aheadSide, SimCar? beside, double besideSide,
        double laneWidth, double lane)
    {
        if (c.PassHold > 0)
        {
            // Blocked: something is already alongside on the side being taken.
            if (beside is not null && Math.Sign(besideSide) == c.PassSide && Math.Abs(besideSide) < 60)
            {
                c.PassHold = 0; c.PassCooldown = 2; c.PassSide = 0;
                return lane;
            }
            return c.PassLane;
        }
        if (ahead is null || c.PassCooldown > 0 || gap >= 90 || Math.Abs(aheadSide) >= 40 || c.Speed <= ahead.Speed + 3) return lane;

        double limit = _trackWidth * 0.5 - CarRadius;
        double roomRight = limit - ahead.ProjSide, roomLeft = limit + ahead.ProjSide;
        const double needed = CarRadius * 2 + 8;
        bool takenRight = beside is not null && besideSide > 0 && Math.Abs(besideSide) < 60;
        bool takenLeft = beside is not null && besideSide < 0 && Math.Abs(besideSide) < 60;
        bool rightOk = roomRight >= needed && !takenRight, leftOk = roomLeft >= needed && !takenLeft;
        int side;
        int node = ((c.LastCheckpoint % _centerline.Count) + _centerline.Count) % _centerline.Count;
        int inside = _line.NextBendDistance[node] <= 40 ? _line.NextBendSign[node] : 0;
        if (rightOk && leftOk) side = inside != 0 ? inside : roomRight >= roomLeft ? 1 : -1;
        else if (rightOk) side = 1;
        else if (leftOk) side = -1;
        else { c.PassCooldown = 1; return lane; }                      // no room: stay behind it
        c.PassSide = side;
        c.PassHold = 2.5;
        c.PassLane = Math.Clamp((c.ProjSide + aheadSide) / laneWidth + side * 0.75, -0.9, 0.9);
        return c.PassLane;
    }

    /// <summary>
    /// Solo rubber band: bots far behind the leading human get up to 4% more pace, bots far ahead
    /// up to 4% less, eased in over a second or two. Off on the final lap (the finish is honest)
    /// and for humans, who never carry it. It only scales a bot's own top speed and push; scores
    /// and lap times are still the sim's clock.
    /// </summary>
    private void UpdateRubberBand(double dt)
    {
        if (!_rubberBand) return;
        SimCar? lead = null;
        foreach (var c in _cars)
        {
            if (!c.IsPlayer || c.Autopilot || c.BotDriven || c.Lap > TotalLaps) continue;
            if (lead is null || c.DistanceAlongTrack > lead.DistanceAlongTrack) lead = c;
        }
        bool finalLap = lead is null || lead.Lap >= TotalLaps;
        double n = _centerline.Count;
        foreach (var c in _cars)
        {
            if (c.IsPlayer || finalLap || c.Lap >= TotalLaps) { c.RubberBand = 0; continue; }
            double gapLaps = (c.DistanceAlongTrack - lead!.DistanceAlongTrack) / n;
            double target = -Math.Clamp(gapLaps / RubberBandSpanLaps, -1, 1) * RubberBandCap;
            c.RubberBand += (target - c.RubberBand) * Math.Min(1, 0.8 * dt);
        }
    }

    internal double RubberBandOf(int carId) => _cars[carId].RubberBand;

    /// <summary>Note the speed a human is carrying through the node it is on, for the ghost lap.</summary>
    private void SampleGhost(SimCar c)
    {
        c.LapSpeeds ??= Enumerable.Repeat(double.NaN, _centerline.Count).ToArray();
        // A seat the stand-in bot has touched, or a car reversing, makes this lap no one's to learn from.
        if (c.Autopilot || c.BotDriven || c.Speed < 0) c.LapTainted = true;
        c.LapSpeeds[c.ProjIdx] = c.Speed;
    }

    /// <summary>
    /// A lap just closed. If a human drove all of it and it is the fastest this race has seen and
    /// it covers the lap, keep its speed per node as the ghost the bots learn from. Bot cars never get here.
    /// </summary>
    private bool OfferGhostLap(SimCar c, double lapTime)
    {
        var samples = c.LapSpeeds;
        bool clean = c.IsPlayer && !c.BotDriven && !c.Autopilot && !c.LapTainted && samples is not null && lapTime > 0;
        c.LapSpeeds = null; c.LapTainted = false;
        if (!clean || samples is null) return false;
        int n = samples.Length, first = Array.FindIndex(samples, v => !double.IsNaN(v));
        if (first < 0 || samples.Count(v => !double.IsNaN(v)) < n * 0.6) return false;
        if (_ghost is not null && lapTime >= _ghostSeconds) return false;
        // A car at speed skips nodes: carry the last speed seen forward over the gaps.
        var filled = new double[n];
        double last = samples[first];
        for (int k = 0; k < n; k++)
        {
            int i = (first + k) % n;
            if (!double.IsNaN(samples[i])) last = samples[i];
            filled[i] = last;
        }
        _ghost = filled;
        _ghostSeconds = lapTime;
        _ghosts?.Offer(TrackId, lapTime, filled);
        return true;
    }

    /// <summary>Cumulative absolute heading change (radians) over the next <paramref name="span"/>
    /// centerline segments — a cheap proxy for how sharp the upcoming track is.</summary>
    private double UpcomingBend(int startIdx, int span)
    {
        int n = _segmentHeadings.Length;
        if (n == 0 || span <= 0) return 0;
        int start = (startIdx % n + n) % n;
        return _bendPrefix[start + span] - _bendPrefix[start];
    }

    /// <summary>The same window as <see cref="UpcomingBend"/>, signed: positive is a bend to the
    /// car's right (the side the track normal points to), negative to its left. A left-right
    /// chicane sums to about nothing, which is right: it has no inside to hug.</summary>
    private double UpcomingTurn(int startIdx, int span)
    {
        int n = _segmentHeadings.Length;
        if (n == 0 || span <= 0) return 0;
        int start = (startIdx % n + n) % n;
        return _turnPrefix[start + span] - _turnPrefix[start];
    }

    /// <summary>
    /// The nearest car ahead of this one (8 to 150 units up the road, within 60 to either side)
    /// and the nearest alongside (within 44 fore and aft, 80 to the side), measured in this car's
    /// own frame: <paramref name="aheadSide"/> and <paramref name="besideSide"/> are positive to
    /// its right. Reads the 160-unit grid Tick builds before anything moves.
    /// </summary>
    private void Nearby(SimCar c, out SimCar? ahead, out double aheadGap, out double aheadSide, out SimCar? beside, out double besideSide)
    {
        ahead = null; beside = null; aheadGap = double.MaxValue; aheadSide = 0; besideSide = 0;
        double cos = Math.Cos(c.Heading), sin = Math.Sin(c.Heading), nearest = double.MaxValue;
        var cell = SpatialCell(c.Pos, 160);
        for (int x = cell.X - 1; x <= cell.X + 1; x++)
        {
            for (int y = cell.Y - 1; y <= cell.Y + 1; y++)
            {
                if (!_spatialGrid.TryGetValue((x, y), out var bucket)) continue;
                foreach (var index in bucket)
                {
                    var other = _cars[index];
                    if (other.Id == c.Id) continue;
                    double dx = other.Pos.X - c.Pos.X, dy = other.Pos.Y - c.Pos.Y;
                    double fwd = dx * cos + dy * sin, side = dy * cos - dx * sin;
                    if (fwd > 8 && fwd <= 150 && fwd < aheadGap && Math.Abs(side) < 60)
                    {
                        ahead = other; aheadGap = fwd; aheadSide = side;
                    }
                    if (Math.Abs(fwd) <= 44 && Math.Abs(side) is > 1 and < 80 && Math.Abs(side) < nearest)
                    {
                        beside = other; besideSide = side; nearest = Math.Abs(side);
                    }
                }
            }
        }
    }

    private void BuildBendPrefix()
    {
        int n = _centerline.Count;
        _segmentHeadings = new double[n];
        for (int i = 0; i < n; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % n];
            _segmentHeadings[i] = Math.Atan2(b.Y - a.Y, b.X - a.X);
        }

        _bendPrefix = new double[n * 2 + 1];
        _turnPrefix = new double[n * 2 + 1];
        for (int i = 0; i < n * 2; i++)
        {
            double turn = ShortAngleDiff(_segmentHeadings[(i + 1) % n], _segmentHeadings[i % n]);
            _bendPrefix[i + 1] = _bendPrefix[i] + Math.Abs(turn);
            _turnPrefix[i + 1] = _turnPrefix[i] + turn;
        }
    }

    private static (int X, int Y) SpatialCell(Vec2 position, double size) =>
        ((int)Math.Floor(position.X / size), (int)Math.Floor(position.Y / size));

    private void BuildSpatialGrid(double cellSize)
    {
        foreach (var bucket in _spatialGrid.Values) bucket.Clear();
        _spatialGrid.Clear();
        _usedSpatialBuckets = 0;

        for (int i = 0; i < _cars.Count; i++)
        {
            var key = SpatialCell(_cars[i].Pos, cellSize);
            if (!_spatialGrid.TryGetValue(key, out var bucket))
            {
                if (_usedSpatialBuckets == _spatialBuckets.Count) _spatialBuckets.Add([]);
                bucket = _spatialBuckets[_usedSpatialBuckets++];
                _spatialGrid.Add(key, bucket);
            }
            bucket.Add(i);
        }
    }

    private void BuildCollisionCandidates()
    {
        BuildSpatialGrid(CarRadius * 2);
        _collisionCandidates.Clear();
        for (int i = 0; i < _cars.Count; i++)
        {
            var cell = SpatialCell(_cars[i].Pos, CarRadius * 2);
            for (int x = cell.X - 1; x <= cell.X + 1; x++)
            {
                for (int y = cell.Y - 1; y <= cell.Y + 1; y++)
                {
                    if (!_spatialGrid.TryGetValue((x, y), out var bucket)) continue;
                    foreach (int j in bucket)
                    {
                        if (j > i) _collisionCandidates.Add((i, j));
                    }
                }
            }
        }
    }

    private void ResolveCarCollisions()
    {
        foreach (var (i, j) in _collisionCandidates)
        {
            var a = _cars[i]; var b = _cars[j];
            var dx = b.Pos.X - a.Pos.X; var dy = b.Pos.Y - a.Pos.Y;
            var d = Math.Sqrt(dx * dx + dy * dy);
            var minD = CarRadius * 2;
            if (d < minD && d > 1e-3)
            {
                var overlap = (minD - d) * 0.5;
                var nx = dx / d; var ny = dy / d;
                a.Pos = new Vec2(a.Pos.X - nx * overlap, a.Pos.Y - ny * overlap);
                b.Pos = new Vec2(b.Pos.X + nx * overlap, b.Pos.Y + ny * overlap);
                var aVel = ProjectVelocity(a, nx, ny);
                var bVel = ProjectVelocity(b, nx, ny);
                var rel = aVel - bVel;
                var impulse = -rel * 0.6;
                a.Speed += impulse * 0.4;
                b.Speed -= impulse * 0.4;
                // Damage is by how hard, not by how long. It was +0.03 for every tick two
                // cars overlapped, so a grid that bumped off the line was fully dented by
                // the first corner; now that it costs speed, only a real closing speed counts.
                var closing = Math.Abs(rel);
                if (closing > 30)
                {
                    var dent = Math.Min(0.06, closing / 2500);
                    a.Damage = Math.Min(1, a.Damage + dent);
                    b.Damage = Math.Min(1, b.Damage + dent);
                    // A hit that lands off the line through both centres spins the car; a square
                    // rear-ender does not. The lever is the sine of the angle between the
                    // contact normal and the car's heading, and the spin decays in Tick.
                    var lever = Math.Sin(Math.Atan2(dy, dx) - a.Heading);
                    var spin = Math.Min(1.8, closing / 320);
                    a.Spin = Math.Clamp(a.Spin - lever * spin, -3, 3);
                    b.Spin = Math.Clamp(b.Spin + lever * spin, -3, 3);
                }
            }
        }
    }

    private static double ProjectVelocity(SimCar c, double nx, double ny)
    {
        var dir = c.Heading - c.Slip;
        var vx = Math.Cos(dir) * c.Speed;
        var vy = Math.Sin(dir) * c.Speed;
        return vx * nx + vy * ny;
    }

    private void Project(SimCar c)
    {
        var (idx, t, point, dist) = ClosestOnCenterline(c.Pos, c.LastCheckpoint);
        var a = _centerline[idx];
        var b = _centerline[(idx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var dx = c.Pos.X - a.X; var dy = c.Pos.Y - a.Y;
        var side = dx * n.X + dy * n.Y;
        c.ProjIdx = idx; c.ProjT = t; c.ProjSide = side;
    }

    private void ResolveWallCollision(SimCar c)
    {
        double limit = _trackWidth * 0.5 - CarRadius;
        if (Math.Abs(c.ProjSide) <= limit) return;
        var sign = Math.Sign(c.ProjSide);
        var a = _centerline[c.ProjIdx];
        var b = _centerline[(c.ProjIdx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var closest = new Vec2(a.X + (b.X - a.X) * c.ProjT, a.Y + (b.Y - a.Y) * c.ProjT);
        c.Pos = new Vec2(closest.X + n.X * sign * limit, closest.Y + n.Y * sign * limit);
        var tdx = b.X - a.X; var tdy = b.Y - a.Y;
        var tlen = Math.Sqrt(tdx * tdx + tdy * tdy);
        var tx = tdx / tlen; var ty = tdy / tlen;
        var nx = n.X * sign; var ny = n.Y * sign;
        var travel = c.Heading - c.Slip;
        var vx = Math.Cos(travel) * c.Speed;
        var vy = Math.Sin(travel) * c.Speed;
        var vInto = vx * nx + vy * ny;
        var vTangent = vx * tx + vy * ty;
        var vNormalNew = -Math.Abs(vInto) * 0.15;
        var vTangentNew = vTangent * 0.7;
        var vxNew = vTangentNew * tx + vNormalNew * nx;
        var vyNew = vTangentNew * ty + vNormalNew * ny;
        c.Speed = Math.Sqrt(vxNew * vxNew + vyNew * vyNew);
        c.Heading = Math.Atan2(vyNew, vxNew);
        // Glance off: turn the nose 0.2 rad toward the track, whichever way the car is travelling
        // (the sign of heading x inward-normal says which way that is). A fixed `+= sign * 0.2`
        // is right for a car driving the wrong way round and turns one driving the right way
        // INTO the barrier: a single brush becomes a hit on every tick, the speed collapses, the
        // car grinds along the wall and Damage runs to 1 in a quarter second.
        c.Heading += 0.2 * Math.Sign(Math.Sin(c.Heading) * nx - Math.Cos(c.Heading) * ny);
        c.SkidIntensity = 1.0;
        // The barrier took the slide out of it: no residual slip or spin after a hit.
        c.Slip = 0; c.Spin = 0;
        // By the speed into the barrier: a 5 degree brush at full speed is about 0.02, head-on is 0.12.
        if (Math.Abs(vInto) > 20) c.Damage = Math.Min(1, c.Damage + Math.Min(0.12, Math.Abs(vInto) / 1500));
    }

    private void UpdateRaceProgress(SimCar c)
    {
        if (c.Lap > TotalLaps) return;
        if (c.IsPlayer) SampleGhost(c);
        if (c.LastCheckpoint >= 0)
        {
            int prev = c.LastCheckpoint;
            double prevT = c.CheckpointT;
            int n = _centerline.Count;
            var advance = c.ProjIdx + c.ProjT - prev - prevT;
            if (advance < -n / 2.0) advance += n;
            if (advance > n / 2.0) advance -= n;
            c.LapTravel += advance;
            // Crossing the line counts only after traversing the circuit. Reversing
            // over the line or sliding backwards within a segment cannot award a lap.
            if (prev > n / 2 && c.ProjIdx < n / 2 && advance > 0 && c.LapTravel >= n * 0.75)
            {
                c.Lap++;
                c.LapTravel = 0;
                // Fastest-lap timing: a lap just closed — measure it against the
                // race clock and keep the best. LapStartElapsed rebases to now so
                // the next lap times independently. This is the metric 1P scores on.
                var nowSec = RaceSeconds;
                var lapTime = nowSec - c.LapStartElapsed;
                c.LastLapTime = lapTime;
                OfferGhostLap(c, lapTime);
                if (lapTime > 0 && (c.BestLapTime < 0 || lapTime < c.BestLapTime))
                {
                    c.BestLapTime = lapTime;
                }
                c.LapStartElapsed = nowSec;
                if (c.Lap > TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = nowSec;
                }
            }
        }
        c.LastCheckpoint = c.ProjIdx;
        c.CheckpointT = c.ProjT;
        c.DistanceAlongTrack = (c.Lap - 1) * _centerline.Count + c.ProjIdx + c.ProjT;
    }

    private IOrderedEnumerable<SimCar> OrderedCars() => _cars
        .OrderBy(c => c.Lap > TotalLaps ? 0 : 1)
        .ThenBy(c => c.Lap > TotalLaps ? c.FinishTime : 0)
        .ThenByDescending(c => c.DistanceAlongTrack)
        .ThenBy(c => c.Id);

    private void Rank()
    {
        var sorted = OrderedCars().ToList();
        for (int i = 0; i < sorted.Count; i++) sorted[i].Position = i + 1;
    }

    public bool AllFinishedOrStopped()
    {
        // Race is over when:
        //   * the safety cap has elapsed, OR
        //   * every car (player + AI) has crossed the line.
        // We deliberately check ALL cars (not just players) so a bot-only race
        // doesn't immediately finish via the vacuous-All-of-empty-set trap.
        var elapsed = NowMs - _startElapsedMs;
        if (elapsed > StopAfterMs) return true;
        // Winner crossed + grace elapsed → the race is decided.
        if (_leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs) return true;
        return _cars.All(c => c.Lap > TotalLaps);
    }

    public PoRacerFinalResult BuildFinalResult(string code)
    {
        var standings = OrderedCars()
            .Select((c, idx) => new PoRacerFinalEntry(
                idx + 1,
                c.Name,
                c.Id,
                !c.IsPlayer, // ai or guest by sign-up
                double.IsFinite(c.FinishTime) ? c.FinishTime : -1,
                c.Lap > TotalLaps && c.FinishTime >= 0 && !double.IsInfinity(c.FinishTime),
                c.BestLapTime))
            .ToList();
        return new PoRacerFinalResult(code, standings, DateTimeOffset.UtcNow);
    }

    public PoRacerRaceSnapshot Snapshot(string code)
    {
        var elapsed = RaceSeconds;
        // Positions are rounded for the wire: twenty frames a second of seventeen-digit doubles is
        // most of the payload, and a tenth of a unit is a twentieth of a pixel at the usual zoom.
        // Lap times and the track fraction keep more, because they are compared and steered by.
        var cars = _cars.Select(c => new PoRacerCarState
        {
            Id = c.Id,
            X = Math.Round(c.Pos.X, 1),
            Y = Math.Round(c.Pos.Y, 1),
            Heading = Math.Round(c.Heading, 3),
            Speed = Math.Round(c.Speed, 1),
            Lap = c.Lap,
            // DNF uses infinity internally; JSON/SignalR requires a finite wire value.
            FinishTime = double.IsFinite(c.FinishTime) ? c.FinishTime : -1,
            BestLapSeconds = c.BestLapTime,
            CurrentLapSeconds = c.Lap > TotalLaps ? c.LastLapTime : Math.Round(Math.Max(0, elapsed - c.LapStartElapsed), 3),
            LastLapSeconds = c.LastLapTime,
            LapProgress = Math.Round((c.ProjIdx + c.ProjT) / _centerline.Count, 5),
            Finished = c.Lap > TotalLaps,
            Position = c.Position,
            SkidIntensity = Math.Round(c.SkidIntensity, 2),
            BoostGlow = Math.Round(c.BoostGlow, 2),
            BoostTimer = Math.Round(c.BoostTimer, 2),
            Surface = c.Surface,
            Damage = Math.Round(c.Damage, 2),
            Drafting = c.Drafting,
            Drift = Math.Round(c.DriftCharge, 2),
            Slip = Math.Round(c.Slip, 3),
            TireHeat = Math.Round(c.TireHeat, 2),
            Draft = Math.Round(c.DraftStrength, 2),
        }).ToList();
        return new PoRacerRaceSnapshot
        {
            GameCode = code,
            ServerTimeMs = _wallClock.ElapsedMilliseconds,
            Cars = cars,
            ElapsedRaceTime = Math.Round(Math.Max(0, elapsed), 3),
            Started = elapsed >= 0,
            CountdownSeconds = (int)Math.Max(0, Math.Ceiling(-elapsed)),
            CountdownMs = (int)Math.Max(0, -elapsed * 1000),
            Paused = Paused,
            Finished = AllFinishedOrStopped(),
        };
    }

    // ── Math helpers (mirror the client's Catmull-Rom track) ─────────────

    private static Vec2 Normal(Vec2 a, Vec2 b)
    {
        var dx = b.X - a.X; var dy = b.Y - a.Y;
        var len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return new Vec2(0, 0);
        return new Vec2(-dy / len, dx / len);
    }

    private (int idx, double t, Vec2 point, double dist) ClosestOnCenterline(Vec2 p, int hint = -1)
    {
        int n = _centerline.Count;
        double bestSq = double.MaxValue;
        int bestIdx = 0; double bestT = 0; Vec2 bestPt = default;
        if (hint >= 0 && n > 0)
        {
            const int window = 6;
            for (int k = -window; k <= window; k++)
            {
                int i = ((hint + k) % n + n) % n;
                var a = _centerline[i];
                var b = _centerline[(i + 1) % n];
                var (pt, t) = ClosestPointOnSegment(p, a, b);
                double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
                double sq = ddx * ddx + ddy * ddy;
                if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
            }
            return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
        }
        for (int i = 0; i < n; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % n];
            var (pt, t) = ClosestPointOnSegment(p, a, b);
            double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
            double sq = ddx * ddx + ddy * ddy;
            if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
        }
        return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
    }

    private static (Vec2 pt, double t) ClosestPointOnSegment(Vec2 p, Vec2 a, Vec2 b)
    {
        var abx = b.X - a.X; var aby = b.Y - a.Y;
        var len2 = abx * abx + aby * aby;
        if (len2 < 1e-9) return (a, 0);
        var t = ((p.X - a.X) * abx + (p.Y - a.Y) * aby) / len2;
        t = Math.Clamp(t, 0, 1);
        return (new Vec2(a.X + abx * t, a.Y + aby * t), t);
    }

    private static double ShortAngleDiff(double a, double b)
    {
        var diff = (a - b) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        return diff;
    }

    private static string Darken(string hex)
    {
        if (hex.StartsWith('#') && hex.Length == 7)
        {
            int r = Convert.ToInt32(hex.Substring(1, 2), 16);
            int g = Convert.ToInt32(hex.Substring(3, 2), 16);
            int b = Convert.ToInt32(hex.Substring(5, 2), 16);
            r = (int)(r * 0.35); g = (int)(g * 0.35); b = (int)(b * 0.35);
            return $"#{r:X2}{g:X2}{b:X2}";
        }
        return "#222";
    }

    private sealed class SimCar
    {
        public int Id;
        public string OwnerId = "";
        public string Name = "";
        public string Color = "#ffffff";
        public string ColorDark = "#222";
        public string Livery = "stripe";
        public Vec2 Pos;
        public double Heading;
        public double Speed;
        public double Steer;
        public bool IsPlayer;
        public double CorneringSkill;
        public double MaxSpeed;
        public double Acceleration;
        public double Handling;
        public int Lap = 1;
        public int LastCheckpoint = -1;
        public double CheckpointT;
        public double DistanceAlongTrack;
        public double FinishTime = -1;
        public double BestLapTime = -1;   // fastest single lap (s); -1 until first lap done
        public double LapStartElapsed; // race-clock seconds when the current lap began
        public double LastLapTime = -1;
        public double LapTravel;
        public int Position;
        public int ProjIdx;
        public double ProjT;
        public double ProjSide;
        public double SkidIntensity;
        public double BoostGlow;
        public double BoostTimer;
        public string Surface = "asphalt";
        public double EffectiveGrip = 1.0;
        public double AccelerationModifier = 1.0;
        public PoRacerAiPersonality? Personality;
        public double Damage;
        public bool Drafting;       // in another car's tow this tick
        public double DriftCharge;  // 0..1, seconds of drift held; paid out as a boost on release
        public bool Autopilot;      // a human seat the stand-in bot is driving right now
        public bool BotDriven;      // ...or ever did: this car's laps do not go on the board
        public double StuckTimer;   // seconds without track progress — drives the AI unstick maneuver
        public double ProgressMark; // last DistanceAlongTrack the car meaningfully advanced past
        public double Wet = 1.0;    // grip from the weather: 1 dry, less in rain and snow
        public double Lane;         // bots: the lane being driven, -1 (left) to 1 (right), eased toward the style's pick
        public double Whim;         // the wildcard's lane of the moment
        public double WhimTimer;    // ...and the seconds until it picks another
        public double HotTimer;     // seconds left of a bot ignoring most of its caution (the wildcard's mistake)
        public double Slip;         // radians between the nose and the direction of travel
        public double Spin;         // rad/s of yaw left over from an off-centre hit
        public double TireHeat;     // 0..1; scrubs grip and feeds the smoke
        public double DraftStrength; // 0..1, eased from Drafting for the tow meter and effects
        public double RubberBand;    // bots in a solo race: -0.04..0.04 of pace, eased; always 0 for humans
        public double LineError;     // bots: a fixed misjudgement of bend severity (seeded)
        public long DefendKey = -1;  // the bend a defence was last made for: one move per straight
        public double DefendLane;
        public int DefendMoves;
        public double PassHold;      // seconds left of the pass in progress
        public double PassCooldown;  // seconds before a bot that gave a pass up tries another
        public int PassSide;         // -1 or +1: the side being taken; 0 when not passing
        public double PassLane;
        public double[]? LapSpeeds;  // humans: speed per node over the lap in progress (NaN where not seen)
        public bool LapTainted;      // ...and whether anything but the human drove any of it
    }
}
