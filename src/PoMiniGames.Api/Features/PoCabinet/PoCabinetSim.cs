using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Server-authoritative PoCabinet race. No SignalR, no Blazor, no JS: the
/// <see cref="PoCabinetRaceRegistry"/> ticks it at 30 Hz and broadcasts what it reports.
///
/// <para>
/// Movement, walls and grass are <see cref="PoCabinetPhysics.Step"/>, the same model the
/// browser runs for solo races and for predicting its own car online.
/// </para>
/// <para>
/// Time is the sum of the <c>dt</c> values passed to <see cref="Tick"/> — no wall clock — so a
/// race replays identically from the same inputs. Lap and finish times are interpolated to
/// the moment the car's race distance crossed the line inside the tick, not rounded to it.
/// </para>
/// </summary>
public sealed class PoCabinetSim
{
    /// <summary>After the first car finishes, the rest have this long to cross the line.</summary>
    private const double FinishGraceSeconds = 15;
    /// <summary>A race that is still running this long after GO is called off (stuck/abandoned).</summary>
    private const double SafetyCutoffSeconds = 300;
    /// <summary>How long a wrecked human sits in the race before it counts as out.</summary>
    private const double WreckHoldSeconds = 4;

    private readonly PoCabinetTrack _track;
    private readonly List<SimCar> _cars = new();
    /// <summary><see cref="_cars"/> as the array the physics and the AI scan every tick.</summary>
    private readonly PoCabinetCarBody[] _bodies;
    private readonly Dictionary<string, SimCar> _byOwnerId = new(StringComparer.Ordinal);
    private readonly Random _rng;
    private double _clock;
    private double _firstFinishAt = -1;
    private int _tickCount;
    private int _finishOrder;

    public PoCabinetSim(string? trackId, int seed, IReadOnlyList<PoCabinetDriver> drivers)
    {
        if (drivers is null || drivers.Count == 0)
            throw new ArgumentException("at least one driver is required", nameof(drivers));
        if (drivers.Count > PoCabinetCatalog.OnlineGridSize)
            throw new ArgumentException($"max {PoCabinetCatalog.OnlineGridSize} drivers", nameof(drivers));

        _track = PoCabinetTrack.Get(trackId);
        TotalLaps = _track.Laps;
        _rng = new Random(seed);

        for (int i = 0; i < drivers.Count; i++)
        {
            var d = drivers[i];
            var car = new SimCar
            {
                Id = i,
                OwnerId = d.OwnerId,
                Name = d.Name,
                IsPlayer = d.IsPlayer,
                Color = d.Color,
                OfficialId = d.OfficialId,
                Personality = d.Personality,
                MaxSpeed = d.MaxSpeed,
                CorneringSkill = d.CorneringSkill,
                Position = i + 1,
            };
            PoCabinetPhysics.SetStyle(car, i);
            PoCabinetPhysics.GridSlot(_track, car, i);
            _cars.Add(car);
            if (d.IsPlayer) _byOwnerId[d.OwnerId] = car;
        }
        _bodies = [.. _cars];
    }

    /// <summary>Track this sim is running on (id is the geometry key).</summary>
    public string TrackId => _track.Id;

    public PoCabinetTrack Track => _track;

    /// <summary>Laps in this race: the track's own count.</summary>
    public int TotalLaps { get; }

    /// <summary>Grid countdown before GO. 0 = cars move on the first tick (tests, demos).</summary>
    public double CountdownSeconds { get; init; }

    /// <summary>Weather grip factor. Multiplayer always races dry: the rain in the browser is
    /// cosmetic online, because prediction must run the server's numbers.</summary>
    private const double Grip = 1;

    public bool IsFinished { get; private set; }

    /// <summary>Seconds since GO; negative during the countdown.</summary>
    public double ElapsedRaceTime => _clock - CountdownSeconds;

    public bool Started => ElapsedRaceTime >= 0;

    /// <summary>Whole seconds left on the countdown, as the HUD shows them (3, 2, 1, then 0).</summary>
    public int CountdownRemaining => Started ? 0 : (int)Math.Ceiling(-ElapsedRaceTime);

    /// <summary>Dialogue raised since the registry last took it (null = nothing new).</summary>
    private PoCabinetDialogueEvent? _pendingDialogue;

    public int? CarIdForOwner(string ownerId) => _byOwnerId.TryGetValue(ownerId, out var car) ? car.Id : null;

    public PoCabinetDialogueEvent? TakeDialogue()
    {
        var d = _pendingDialogue;
        _pendingDialogue = null;
        return d;
    }

    /// <summary>
    /// Advance the race by <paramref name="dt"/>. <paramref name="inputs"/> is keyed by driver
    /// <c>OwnerId</c>; a human with no entry coasts. Each applied input's <c>Seq</c> is recorded
    /// as that car's <see cref="SimCar.AckSeq"/>, during the countdown too, so the client's
    /// prediction history drains even before GO.
    /// </summary>
    public void Tick(double dt, IReadOnlyDictionary<string, PoCabinetInput> inputs)
    {
        if (IsFinished) return;
        _tickCount++;
        double before = ElapsedRaceTime;
        _clock += dt;

        foreach (var (ownerId, car) in _byOwnerId)
        {
            if (inputs.TryGetValue(ownerId, out var inp) && inp is not null && inp.Seq > car.AckSeq)
                car.AckSeq = inp.Seq;
        }

        if (_tickCount == 1) Say(DialogueKind.PreRace, BotAt(_rng.Next(Math.Max(1, _cars.Count))));
        if (!Started) return;

        double tickStart = Math.Max(0, before);
        double stepDt = ElapsedRaceTime - tickStart;
        if (stepDt <= 0) return;

        foreach (var car in _cars)
        {
            car.PrevDistance = car.Distance;
            PoCabinetControls controls;
            if (car.Finished || car.Wrecked || !car.IsPlayer)
            {
                // Finished humans roll a cool-down lap on autopilot so they never park on the line
                // (on a point-to-point track everyone rolls into the run-out and parks there); a
                // wrecked one is driven off the racing line.
                var persona = car.Personality ?? PoCabinetPersonality.Officials.BillB;
                controls = PoCabinetAiDriver.Decide(_track, car, persona, car.Finished ? car.MaxSpeed * _track.CoolDownAt(car.Distance) : car.MaxSpeed,
                    car.CorneringSkill, _bodies, Grip);
            }
            else
            {
                inputs.TryGetValue(car.OwnerId, out var inp);
                controls = PoCabinetControls.From(inp);
            }
            PoCabinetPhysics.Step(_track, car, controls, stepDt, Grip);
        }
        PoCabinetPhysics.ResolveContacts(_track, _bodies);

        foreach (var car in _cars)
        {
            if (car.Wrecked && car.WreckedAt < 0) car.WreckedAt = ElapsedRaceTime;
            car.CountLaps(_track, tickStart, stepDt, TotalLaps, (crossedAt, finished) =>
            {
                if (!finished)
                {
                    if (!car.IsPlayer && Rank(car) == 1) Say(DialogueKind.LapFinish, car);
                    return;
                }
                car.FinishTime = crossedAt;
                car.FinishOrder = ++_finishOrder;
                if (_firstFinishAt < 0)
                {
                    _firstFinishAt = ElapsedRaceTime;
                    if (!car.IsPlayer) Say(DialogueKind.RaceFinish, car);
                }
            });
        }

        var order = Standings();
        for (int i = 0; i < order.Count; i++) order[i].Position = i + 1;

        // A wrecked human is out: the race waits a few seconds so they see it, not for a finish.
        bool humansDone = _byOwnerId.Count > 0 && _byOwnerId.Values.All(c => c.Finished || (c.Wrecked && ElapsedRaceTime - c.WreckedAt > WreckHoldSeconds));
        bool everyoneDone = _cars.All(c => c.Finished || c.Wrecked);
        bool graceOver = _firstFinishAt >= 0 && ElapsedRaceTime - _firstFinishAt > FinishGraceSeconds;
        if (humansDone || everyoneDone || graceOver || ElapsedRaceTime > SafetyCutoffSeconds)
        {
            IsFinished = true;
        }
    }

    /// <summary>Finishers by finish order, then the cars still running by race distance, then
    /// the wrecks (DNF) by how far they got.</summary>
    public List<SimCar> Standings() =>
        _cars.OrderBy(c => c.Finished ? 0 : 1)
             .ThenBy(c => c.Finished ? c.FinishOrder : 0)
             .ThenBy(c => !c.Finished && c.Wrecked ? 1 : 0)
             .ThenByDescending(c => c.Finished ? 0 : c.Distance)
             .ThenBy(c => c.Id)
             .ToList();

    /// <summary>Final result for the <c>RaceFinished</c> broadcast.</summary>
    public PoCabinetFinalResult BuildResult(string gameCode) => new(
        gameCode,
        Standings().Select((c, i) => new PoCabinetFinalEntry(
            Position: i + 1,
            Name: c.Name,
            IsPlayer: c.IsPlayer,
            Finished: c.Finished,
            TotalTimeSeconds: c.Finished ? Math.Round(c.FinishTime, 3) : -1,
            BestLapSeconds: c.BestLapSeconds > 0 ? Math.Round(c.BestLapSeconds, 3) : -1,
            CarId: c.Id,
            Wrecked: c.Wrecked && !c.Finished)).ToList());

    public IReadOnlyList<SimCar> SnapshotCars() => _cars;

    private int Rank(SimCar car) => Standings().IndexOf(car) + 1;

    /// <summary>An AI with something to say: the officials have radio lines, the field racers none.</summary>
    private SimCar? BotAt(int index)
    {
        var bots = _cars.Where(c => !c.IsPlayer && c.OfficialId != PoCabinetCatalog.FieldRacerId).ToList();
        return bots.Count == 0 ? null : bots[index % bots.Count];
    }

    private void Say(DialogueKind kind, SimCar? speaker)
    {
        if (speaker is null || speaker.IsPlayer) return;
        var text = PoCabinetDialogue.PickLine(speaker.OfficialId, kind, _tickCount);
        if (text.Length == 0) return; // a field racer leading the lap: no line, not an empty bubble
        _pendingDialogue = new PoCabinetDialogueEvent
        {
            OfficialId = speaker.OfficialId,
            Text = text,
            RaceTick = _tickCount,
        };
    }

    /// <summary>Per-car race state on top of the lap count. Public so the wire DTO can read it.</summary>
    public sealed class SimCar : PoCabinetRacer
    {
        public int Id { get; init; }
        public required string OwnerId { get; init; }
        public required string Name { get; init; }
        public required bool IsPlayer { get; init; }
        public required string Color { get; init; }
        public string OfficialId { get; init; } = "player";
        public PoCabinetPersonality? Personality { get; init; }
        public double MaxSpeed { get; init; }
        public double CorneringSkill { get; init; }
        /// <summary>Current lap (1-based). Reads TotalLaps + 1 once finished, as it always has.</summary>
        public int Lap => LapsDone + 1;
        public double FinishTime { get; set; }
        public int FinishOrder { get; set; }
        /// <summary>Race time the car was wrecked at (-1 = still running).</summary>
        public double WreckedAt { get; set; } = -1;
        public int AckSeq { get; set; }
        public int Position { get; set; }
    }
}

/// <summary>
/// A car's lap count on top of its physical body: the multiplayer sim and the solo lap verifier
/// both keep it, the same way race.js <c>lapBookkeeping</c> does.
/// </summary>
public abstract class PoCabinetRacer : PoCabinetCarBody
{
    public int LapsDone { get; set; }
    public double LapStartTime { get; set; }
    public double BestLapSeconds { get; set; }
    /// <summary>This lap has broken track limits (all four wheels past the edge): it will not count as a best.</summary>
    public bool LapInvalid { get; set; }
    public bool Finished { get; set; }
    internal double PrevDistance { get; set; }

    /// <summary>
    /// Count the lines this tick's movement crossed. Each crossing is timed to the moment the race
    /// distance passed it inside the tick, not rounded to the tick; <paramref name="onLine"/> hears
    /// each one (its race time, and whether it finished the race). A wrecked or finished car
    /// counts nothing.
    /// </summary>
    internal void CountLaps(PoCabinetTrack track, double tickStart, double stepDt, int totalLaps, Action<double, bool>? onLine = null)
    {
        if (Finished || Wrecked) return;
        while (Distance >= (LapsDone + 1) * track.LapLength)
        {
            double boundary = (LapsDone + 1) * track.LapLength;
            double span = Distance - PrevDistance;
            double frac = span > 1e-9 ? Math.Clamp((boundary - PrevDistance) / span, 0, 1) : 1;
            double crossedAt = tickStart + frac * stepDt;
            double lapTime = crossedAt - LapStartTime;
            LapStartTime = crossedAt;
            if (!LapInvalid && (BestLapSeconds <= 0 || lapTime < BestLapSeconds)) BestLapSeconds = lapTime;
            LapInvalid = false;
            LapsDone++;
            Finished = LapsDone >= totalLaps;
            onLine?.Invoke(crossedAt, Finished);
            if (Finished) break;
        }
        if (Wide) LapInvalid = true;
    }
}

/// <summary>Driver row passed into <see cref="PoCabinetSim"/> at construction time; list order is grid order.</summary>
public sealed record PoCabinetDriver(
    string OwnerId,
    string Name,
    bool IsPlayer,
    string Color,
    PoCabinetPersonality? Personality,
    double MaxSpeed = PoCabinetPhysics.MaxSpeed,
    double CorneringSkill = 0.7,
    string OfficialId = "player");

/// <summary>
/// Personality parameter bundle for an AI driver (see <see cref="PoCabinetAiDriver"/> for what
/// each knob does). Values default to neutral.
/// </summary>
public sealed record PoCabinetPersonality(
    double LookaheadDistance = 60,
    double LateralOffset = 0.0,
    double BrakingAggression = 0.5,
    double CollisionTolerance = 0.5,
    double DraftingAffinity = 0.0,
    double Wildness = 0.0,
    double Aggression = 0.0,
    double Twitch = 0.375,
    int Seed = 0)
{
    /// <summary>The four named officials. Mirrored in <c>js/pocabinet/physics.js</c> (<c>OFFICIALS</c>).</summary>
    public static class Officials
    {
        // Lateral offsets are spread across the road so their lines stay visibly apart
        // (PoCabinetAiPersonalityTests asserts it over a full lap).
        public static readonly PoCabinetPersonality SeanS = new(
            LookaheadDistance: 25, LateralOffset: -0.95, BrakingAggression: 0.95,
            CollisionTolerance: 0.2, DraftingAffinity: 0.1, Wildness: 0.14, Aggression: 0.55, Twitch: 0.85, Seed: 201);
        public static readonly PoCabinetPersonality SteveB = new(
            LookaheadDistance: 45, LateralOffset: 0.85, BrakingAggression: 0.20,
            CollisionTolerance: 0.6, DraftingAffinity: 0.2, Wildness: 0.05, Aggression: 0.1, Twitch: 0.3, Seed: 202);
        public static readonly PoCabinetPersonality BillB = new(
            LookaheadDistance: 100, LateralOffset: 0.0, BrakingAggression: 0.50,
            CollisionTolerance: 0.9, DraftingAffinity: 0.0, Wildness: 0.03, Aggression: 0.35, Twitch: 0.1, Seed: 203);
        public static readonly PoCabinetPersonality MikeP = new(
            LookaheadDistance: 130, LateralOffset: -0.50, BrakingAggression: 0.40,
            CollisionTolerance: 0.3, DraftingAffinity: 0.95, Wildness: 0.08, Aggression: 0.85, Twitch: 0.45, Seed: 204);
    }

    /// <summary>The AI roster in seat order (<see cref="PoCabinetCatalog.Officials"/>, which has
    /// their names): id, colour, line, pace and cornering. Top speeds sit a few percent under a
    /// player's, and the cornering margin keeps them off the grip limit, so a clean human lap wins.</summary>
    public static IReadOnlyList<(string Id, string Color, PoCabinetPersonality Personality, double MaxSpeed, double CorneringSkill)> Roster { get; } =
    [
        ("sean-s", "#3470d8", Officials.SeanS, PoCabinetPhysics.MaxSpeed * 0.93, 0.62),
        ("steve-b", "#5e4b8b", Officials.SteveB, PoCabinetPhysics.MaxSpeed * 0.95, 0.55),
        ("bill-b", "#a02c2c", Officials.BillB, PoCabinetPhysics.MaxSpeed * 0.91, 0.70),
        ("mike-p", "#1c8054", Officials.MikeP, PoCabinetPhysics.MaxSpeed * 0.96, 0.60),
    ];

    /// <summary>
    /// The AI a multiplayer host can add, in the order it is seated: the four officials, then
    /// the eight quickest field racers of <see cref="SoloField"/>, each with the name and the
    /// paint it has in a solo race (physics.js <c>soloField</c>).
    /// </summary>
    public static IReadOnlyList<(string Id, string Name, string Color, PoCabinetPersonality Personality, double MaxSpeed, double CorneringSkill)> OnlineBots => LazyOnlineBots.Value;

    // Lazy: SoloField is declared below, and static initializers run in textual order.
    private static readonly Lazy<(string, string, string, PoCabinetPersonality, double, double)[]> LazyOnlineBots = new(BuildOnlineBots);

    private static (string, string, string, PoCabinetPersonality, double, double)[] BuildOnlineBots()
    {
        var bots = new (string, string, string, PoCabinetPersonality, double, double)[PoCabinetCatalog.MaxBots];
        for (int i = 0; i < bots.Length; i++)
        {
            if (i < Roster.Count)
            {
                var o = Roster[i];
                bots[i] = (o.Id, PoCabinetCatalog.OfficialName(o.Id), o.Color, o.Personality, o.MaxSpeed, o.CorneringSkill);
                continue;
            }
            int n = i - Roster.Count;
            var f = SoloField[i];
            // The paint soloField() gives the same car: hue, saturation and lightness from three bytes of its hash.
            uint h = unchecked((uint)(n + 1) * 0x9E3779B1u);
            double a = (h & 0xff) / 255.0, b = ((h >> 8) & 0xff) / 255.0, d = (h >> 24) / 255.0;
            var color = string.Create(System.Globalization.CultureInfo.InvariantCulture,
                $"hsl({Math.Round(d * 360, MidpointRounding.AwayFromZero)}, {55 + Math.Round(a * 35, MidpointRounding.AwayFromZero)}%, {32 + Math.Round(b * 30, MidpointRounding.AwayFromZero)}%)");
            bots[i] = (PoCabinetCatalog.FieldRacerId, PoCabinetCatalog.FieldRacerName(n), color, f.Personality, f.MaxSpeed, f.CorneringSkill);
        }
        return bots;
    }

    /// <summary>
    /// The 63 rivals of a solo race in grid order: the four officials, then 59 field racers from
    /// the quickest to the slowest. Qualifying order on purpose: a grid sorted any other way has
    /// to overtake itself, and a hundred cars doing that on a 27-second lap is a traffic jam,
    /// not a race. A field racer's pace comes from its index; so does its personality, every
    /// trait from a byte of its own (three hashes of the index), so no two cars drive alike and
    /// no trait follows from another. The arithmetic is exact on both sides of the mirror
    /// (<c>physics.js</c> <c>soloField</c>). No names or colours here: the server only re-runs
    /// the physics (<see cref="PoCabinetLapVerifier"/>).
    /// </summary>
    public static IReadOnlyList<(PoCabinetPersonality Personality, double MaxSpeed, double CorneringSkill)> SoloField { get; } = BuildSoloField();

    private static (PoCabinetPersonality, double, double)[] BuildSoloField()
    {
        var field = new (PoCabinetPersonality, double, double)[PoCabinetCatalog.SoloCarCount - 1];
        for (int i = 0; i < Roster.Count; i++) field[i] = (Roster[i].Personality, Roster[i].MaxSpeed, Roster[i].CorneringSkill);
        int n = field.Length - Roster.Count;
        for (int i = 0; i < n; i++)
        {
            uint h = unchecked((uint)(i + 1) * 0x9E3779B1u);
            uint g = unchecked((uint)(i + 1) * 0x85EBCA6Bu);
            double a = (h & 0xff) / 255.0, b = ((h >> 8) & 0xff) / 255.0, c = ((h >> 16) & 0xff) / 255.0, d = (h >> 24) / 255.0;
            double e = (g & 0xff) / 255.0, f = ((g >> 8) & 0xff) / 255.0, k = ((g >> 16) & 0xff) / 255.0, m = (g >> 24) / 255.0;
            uint q = unchecked((uint)(i + 1) * 0xC2B2AE35u);
            double r = (q & 0xff) / 255.0, t = ((q >> 8) & 0xff) / 255.0;
            double pace = 1 - i / (double)(n - 1);
            field[Roster.Count + i] = (
                new PoCabinetPersonality(
                    LookaheadDistance: 30 + 90 * c,
                    LateralOffset: -0.9 + 1.8 * d,
                    BrakingAggression: 0.05 + 0.9 * e,
                    CollisionTolerance: 0.1 + 0.8 * k,
                    DraftingAffinity: 0.7 * m,
                    // Everyone runs wide now and then; a few are a liability.
                    Wildness: 0.05 + 0.2 * f * f,
                    Aggression: r,
                    Twitch: t,
                    Seed: i + 1),
                PoCabinetPhysics.MaxSpeed * (0.7 + 0.2 * pace + 0.03 * a),
                0.25 + 0.35 * pace + 0.08 * b);
        }
        return field;
    }
}
