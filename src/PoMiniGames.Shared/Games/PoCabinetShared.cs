using System.Text.Json.Serialization;

namespace PoMiniGames.Shared.Games;

// ──────────────────────────────  Career state  ──────────────────────────────

/// <summary>
/// Player's campaign progress, kept in this browser's localStorage (PoCabinetCareerState).
/// Winning the trophy also wins the gold livery badge: they are one unlock.
/// </summary>
public sealed class PoCabinetCareerDto
{
    /// <summary>Index into the campaign stages (<see cref="PoCabinetCatalog.StageIndexOf"/>).</summary>
    public int CurrentStageIndex { get; set; }
    public bool TrophyUnlocked { get; set; }
    public IReadOnlyList<int> CompletedStages { get; set; } = new List<int>();

    public static PoCabinetCareerDto New() => new();
}

// ──────────────────────────────  Atmosphere wire  ──────────────────────────────

public sealed class PoCabinetAtmosphereWire
{
    public string SkyHex { get; set; } = "#0f1a3a";
    public double FogStart { get; set; }
    public double FogEnd { get; set; }
    public string FogHex { get; set; } = "#0f1a3a";
    public double AmbientIntensity { get; set; } = 0.5;
    public string GroundHex { get; set; } = "#888";
    /// <summary>Asphalt tint for the road ribbon (the ground is grass/sand/marble around it).</summary>
    public string RoadHex { get; set; } = "#3a3a40";
    public string AccentHex { get; set; } = "#888";
}

// ──────────────────────────────  Per-car state  ──────────────────────────────

/// <summary>
/// Wire shape for a single car in a snapshot. Trim-safe: every property is a
/// value type or a string — no reflection-heavy serialization shapes.
/// There is deliberately no dark/trim colour: the client derives it from
/// <see cref="Color"/>, and the per-car copy cost ~170 bytes of the 2 KB frame at 8 cars.
/// </summary>
public sealed class PoCabinetCarState
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string OfficialId { get; set; } = "";
    public string Color { get; set; } = "#ffffff";
    public double X { get; set; }
    public double Y { get; set; }
    public double Heading { get; set; }
    public double SpeedKmh { get; set; }
    public int Lap { get; set; }
    public double LapProgress { get; set; }
    public int Position { get; set; }
    public bool IsPlayer { get; set; }
    public bool Finished { get; set; }
    /// <summary>What the hits have cost the car (PoCabinetPhysics.Hurt): structure and engine
    /// 0..1, alignment -1..1 (+ pulls right). The owning client predicts with them, and every
    /// client smokes and dents the car by them. Left off the wire while 0 (most cars, most of
    /// the time): the 30 Hz snapshot is budgeted at 2 KB for 8 cars.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public double Damage { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public double Engine { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public double Pull { get; set; }
    /// <summary>Structure or engine gone: out of the race, limping off the racing line.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Wrecked { get; set; }
    /// <summary>This lap broke track limits (all four wheels past the edge): it will not count
    /// as a best lap.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool LapInvalid { get; set; }
    /// <summary>An AI driver's personality in a word ("Bruiser", "Late braker"; physics.js
    /// <c>archetype</c>), for the standings. Solo snapshots only; empty online.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Style { get; set; }
    /// <summary>
    /// Highest <see cref="PoCabinetInput.Seq"/> the server has applied to this car (0 for AI
    /// officials and in solo races). The owning client drops acknowledged inputs from its
    /// prediction history and replays the rest on top of this server state.
    /// </summary>
    public int AckSeq { get; set; }
}

// ──────────────────────────────  Dialogue event  ──────────────────────────────

public sealed class PoCabinetDialogueEvent
{
    public string OfficialId { get; set; } = "";
    public string Text { get; set; } = "";
    public long RaceTick { get; set; }
}

// ──────────────────────────────  Race snapshot  ──────────────────────────────

/// <summary>
/// Hub → client broadcast at 30 Hz. Sized for ≤ 2 KB at 8 cars: the eight
/// <see cref="PoCabinetCarState"/> rows are 11 doubles + 4 strings + 5 int/bool,
/// which System.Text.Json serializes at roughly 200 bytes each — well under the
/// budget. The contract test in <c>PoCabinetSharedContractTests</c> measures
/// the actual byte count and fails the build if it slips.
/// </summary>
public sealed class PoCabinetRaceSnapshot
{
    public string GameCode { get; set; } = "";
    public long ServerTimeMs { get; set; }
    public double ElapsedRaceTime { get; set; }
    public bool Started { get; set; }
    public int CountdownSeconds { get; set; }
    public bool Finished { get; set; }
    public int? LocalCarId { get; set; }
    public IReadOnlyList<PoCabinetCarState> Cars { get; set; } = new List<PoCabinetCarState>();
    public PoCabinetDialogueEvent? LatestDialogue { get; set; }
    public PoCabinetStaticWorld? Static { get; set; }
    /// <summary>Solo races only (race.js): the player's best lap, which the page submits at the
    /// finish. Online the best lap comes in the <c>RaceFinished</c> result instead.</summary>
    public double? BestLapSeconds { get; set; }
}

/// <summary>
/// Static world payload — sent once on join, and built locally for solo races, both via
/// <see cref="PoCabinetTrackGeometry.BuildStaticWorld"/>. CenterXY is a flat double array
/// (PoRacer pattern). There are no wall points: walls are the centerline offset by the half
/// width plus the run-off, which both physics implementations derive themselves.
/// </summary>
public sealed class PoCabinetStaticWorld
{
    public string TrackId { get; set; } = "capitol";
    public string TrackName { get; set; } = "";
    public PoCabinetAtmosphereWire Atmosphere { get; set; } = new();
    public IReadOnlyList<double> CenterXY { get; set; } = new List<double>();
    public double TrackWidth { get; set; }
    public double MinX { get; set; }
    public double MinY { get; set; }
    public double MaxX { get; set; }
    public double MaxY { get; set; }
    public int TotalLaps { get; set; } = PoCabinetCatalog.TotalLaps;
    /// <summary>Road height per centerline sample (sim units); empty on a flat track. Drawn only.</summary>
    public IReadOnlyList<double> CenterZ { get; set; } = new List<double>();
    /// <summary>Point-to-point tracks: the centerline sample the finish line is on (0 = a circuit).
    /// Both physics copies turn it into the lap length.</summary>
    public int FinishIndex { get; set; }
    /// <summary>Centerline samples <c>[HiddenFrom, HiddenTo)</c> are the return link of a
    /// point-to-point track and are not drawn.</summary>
    public int HiddenFrom { get; set; }
    public int HiddenTo { get; set; }
    /// <summary>Cross slope per centerline sample (tan of the bank, + = right side higher); empty
    /// on an unbanked track. Drawn only.</summary>
    public IReadOnlyList<double> CenterBank { get; set; } = new List<double>();
    /// <summary>The centerline sample the scene starts laying tarmac at (0 = the whole track);
    /// before it the track is an open chute in place of a model's gutter. Drawn only.</summary>
    public int RoadFrom { get; set; }

    // Track features (PoCabinetTrackFeatures): computed once here, read by both physics copies
    // and the scene, so the road everyone drives on is the same to the last value.

    /// <summary>Road half width per centerline sample (sim units).</summary>
    public IReadOnlyList<double> HalfWidths { get; set; } = new List<double>();
    /// <summary>Run-off per sample on the left and right (<see cref="PoCabinetRunoff"/> as an int).</summary>
    public IReadOnlyList<int> RunoffLeft { get; set; } = new List<int>();
    public IReadOnlyList<int> RunoffRight { get; set; } = new List<int>();
    /// <summary>Apex kerb per sample: 0 none, ±1 a flat kerb on that side (+ = right), ±2 a raised one.</summary>
    public IReadOnlyList<int> Kerbs { get; set; } = new List<int>();
    /// <summary>The racing line per sample (lateral offset, sim units): where the rubber goes down.</summary>
    public IReadOnlyList<double> RacingLine { get; set; } = new List<double>();
    public IReadOnlyList<PoCabinetPatchWire> Patches { get; set; } = new List<PoCabinetPatchWire>();
    public IReadOnlyList<PoCabinetIslandWire> Islands { get; set; } = new List<PoCabinetIslandWire>();
    /// <summary>Which scenery, sky and props dress the track (the id, or a borrowed theme for the daily track).</summary>
    public string Theme { get; set; } = "capitol";
}

/// <summary>A grip patch on samples [From, To) between two lateral offsets (sim units).</summary>
public sealed class PoCabinetPatchWire
{
    public int From { get; set; }
    public int To { get; set; }
    public double LatFrom { get; set; }
    public double LatTo { get; set; }
    public double DryGrip { get; set; } = 1;
    public double WetGrip { get; set; } = 1;
    public string Kind { get; set; } = "";
}

/// <summary>A road divider on samples [From, To) between two lateral offsets (sim units);
/// ShortSide (-1 left, +1 right) is the joker lane.</summary>
public sealed class PoCabinetIslandWire
{
    public int From { get; set; }
    public int To { get; set; }
    public double LatFrom { get; set; }
    public double LatTo { get; set; }
    public int ShortSide { get; set; }
}

// ──────────────────────────────  Player input  ──────────────────────────────

/// <summary>
/// One tick of player intent, analog whatever the device (input.js ramps the keyboard). Steer is
/// +1 = right, i.e. the heading-increasing direction in the sim's frame. Seq increases by one per
/// client tick and is echoed back as <see cref="PoCabinetCarState.AckSeq"/>.
/// </summary>
public sealed class PoCabinetInput
{
    public double Throttle { get; set; }
    public double Brake { get; set; }
    public double Steer { get; set; }
    public int Seq { get; set; }
}

// ──────────────────────────────  Multiplayer lobby  ──────────────────────────────

/// <summary>
/// One lobby seat as other players see it. <see cref="SeatId"/> is a hash of the
/// player's claim id — never the claim itself, which is an Entra object id.
/// </summary>
public sealed class PoCabinetLobbySeat
{
    public string SeatId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public bool IsReady { get; set; }
    public bool IsHost { get; set; }
    public string Color { get; set; } = "";
}

/// <summary>Full lobby state, broadcast as <c>LobbyState</c> after every change.</summary>
public sealed class PoCabinetLobbyView
{
    /// <summary>Internal id of the lobby's race (what <c>JoinRace</c> takes). Never shown — there are no join codes.</summary>
    public string Code { get; set; } = "";
    public string TrackId { get; set; } = PoCabinetCatalog.DefaultTrackId;
    /// <summary>AI drivers the host asked for; the race seats <see cref="BotSeats"/> of them.</summary>
    public int BotCount { get; set; }
    /// <summary>The AI drivers that fit: min(BotCount, grid slots the drivers leave free).</summary>
    public int BotSeats { get; set; }
    /// <summary>The host may start: everyone is ready and there are two cars, counting the AI.</summary>
    public bool Startable { get; set; }
    /// <summary>True while a race for this lobby is running; the lobby reopens when it ends.</summary>
    public bool InRace { get; set; }
    public IReadOnlyList<PoCabinetLobbySeat> Players { get; set; } = new List<PoCabinetLobbySeat>();
    /// <summary>The caller's own seat — set only on the Join reply (null there when no seat was free), null in broadcasts.</summary>
    public string? YourSeatId { get; set; }
}

// ──────────────────────────────  Final result  ──────────────────────────────

public sealed record PoCabinetFinalResult(
    string GameCode,
    IReadOnlyList<PoCabinetFinalEntry> Standings);

/// <summary>
/// One finisher. <see cref="TotalTimeSeconds"/> is race time from GO to the line (-1 when the
/// car was still running at the cut-off); <see cref="CarId"/> lets a client find its own row
/// by the <c>LocalCarId</c> it was given on join.
/// </summary>
public sealed record PoCabinetFinalEntry(
    int Position,
    string Name,
    bool IsPlayer,
    bool Finished,
    double TotalTimeSeconds,
    double BestLapSeconds = -1,
    int CarId = -1,
    bool Wrecked = false);
