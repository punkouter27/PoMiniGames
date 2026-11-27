namespace PoMiniGames.Shared.Games;

/// <summary>
/// Display metadata for a PoCabinet track: the card's name, blurb, accent colour, length and
/// difficulty. Geometry (knots, width, atmosphere) lives next door in
/// <see cref="PoCabinetTrackGeometry"/> under the same id, a lower-case string safe for URL paths.
/// </summary>
public sealed record PoCabinetTrackInfo(string Id, string Name, string Description, string Accent, int LengthKm, string Difficulty);

public static class PoCabinetCatalog
{
    /// <summary>Race laps where a definition does not say otherwise
    /// (<see cref="PoCabinetTrackDefinition.Laps"/>, which is what a race reads).</summary>
    public const int TotalLaps = 3;

    /// <summary>Driver seats in a multiplayer lobby: the most humans in one race.</summary>
    public const int CarCount = 8;

    /// <summary>Cars on every grid, solo, demo or online: always 64. The AI fills whatever the
    /// humans leave (64 minus the humans), so there is no AI-count setting anywhere. Online the
    /// server simulates every car; the humans ride every 30 Hz snapshot and the AI a third of
    /// them (see PoCabinetRaceRegistry.BotEveryTicks).</summary>
    public const int OnlineGridSize = SoloCarCount;

    /// <summary>Cars in a solo or demo race: 63 rivals and the player. The whole
    /// race runs in the browser, so only the lap verifier pays for it server-side.</summary>
    public const int SoloCarCount = 64;

    /// <summary>The player's grid slot in a solo race: mid-pack, quicker cars ahead and slower
    /// behind. Rival i takes slot i, or i + 1 from here back. Mirrors physics.js PLAYER_SLOT.</summary>
    public const int SoloPlayerSlot = 32;

    /// <summary>Solo places that mean something, now that "the podium" is 3 of 64 and the
    /// player starts 33rd: the top six earn the fanfare and count as a win.</summary>
    public const int SoloFrontRunners = 6;

    /// <summary>The Grand Prix's id: the track online races run on, and the one a race, a stored
    /// lap or a board gets when it names no other.</summary>
    public const string DefaultTrackId = PoCabinetTrackGeometry.TrackId;

    /// <summary>The scanned house's id: a second track, solo only, with a board of its own.</summary>
    public const string HouseTrackId = PoCabinetTrackGeometry.HouseTrackId;

    /// <summary>A multiplayer seat's paint when the player sent none.</summary>
    public const string DefaultSeatColor = "#3a7d44";

    /// <summary>The four AI officials, id and display name, in seat order. Their driving is
    /// PoCabinetPersonality.Roster on the server and physics.js OFFICIALS in the browser.</summary>
    public static IReadOnlyList<(string Id, string Name)> Officials { get; } =
    [
        ("sean-s", "Sean S."),
        ("steve-b", "Steve B."),
        ("bill-b", "Bill B."),
        ("mike-p", "Mike P."),
    ];

    /// <summary>An official's display name (the dialogue bubble, the grid); the id when unknown.</summary>
    public static string OfficialName(string? id)
    {
        foreach (var (officialId, name) in Officials)
        {
            if (officialId == id) return name;
        }
        return id ?? "";
    }

    private static readonly string[] FieldFirst = ["Dana", "Kyle", "Priya", "Omar", "Lena", "Marcus", "Ines", "Tobias", "Yuki", "Carla",
        "Dmitri", "Aisha", "Hank", "Noor", "Felix", "Greta", "Ravi", "Sofia", "Walt"];
    private static readonly string[] FieldLast = ["K.", "R.", "D.", "W.", "M."];

    /// <summary>A field racer's name by its index in the field (0 = the quickest). Mirrors
    /// physics.js <c>soloField</c>, so the same car has the same name solo and online.</summary>
    public static string FieldRacerName(int index) =>
        $"{FieldFirst[index % FieldFirst.Length]} {FieldLast[(index % FieldFirst.Length + index / FieldFirst.Length) % FieldLast.Length]}";

    /// <summary>The name of a multiplayer grid's AI driver number <paramref name="index"/>
    /// (0-based): the officials in seat order, then the field racers from the quickest.</summary>
    public static string BotName(int index) =>
        index < Officials.Count ? Officials[index].Name : FieldRacerName(index - Officials.Count);

    /// <summary>The <c>OfficialId</c> a field racer carries on the wire (physics.js <c>soloField</c>'s id).</summary>
    public const string FieldRacerId = "field";

    /// <summary>The Grand Prix: one lap takes in every kind of outdoor road the game has.</summary>
    public static PoCabinetTrackInfo Track { get; } = new(
        DefaultTrackId,
        "Cabinet Grand Prix",
        "One lap of everything: the stadium straight and its banked first turn, the climb over Senate Hill to the hairpin and the chicane, a blast across a giant scanned basketball court, the joker-lane sweeper and the beach road past the sand traps.",
        "#d4af37", 12, "Medium");

    /// <summary>The house: a toy road through a scan of a real one, floor to six feet and back.</summary>
    public static PoCabinetTrackInfo House { get; } = new(
        HouseTrackId,
        "House Party",
        "Two laps of a scanned house on a toy road: off the kitchen floor, round the living room, down the middle of the dining table, up the hall and round the bedroom to six feet in the air, then all the way back down.",
        "#e07a3f", 33, "Medium");

    /// <summary>Every track a solo race can be run on, the Grand Prix first (the start card's list).</summary>
    public static IReadOnlyList<PoCabinetTrackInfo> Tracks { get; } = [Track, House];

    /// <summary>A track's card: the house for its id (any casing), the Grand Prix for anything
    /// else, a retired track's id included.</summary>
    public static PoCabinetTrackInfo GetTrack(string? id = null) =>
        string.Equals(id?.Trim(), HouseTrackId, StringComparison.OrdinalIgnoreCase) ? House : Track;

    /// <summary>True for an id a race may be run and a lap posted on (any casing).</summary>
    public static bool IsKnownTrack(string? id) => KnownTrackId(id) is not null;

    /// <summary>The track's own id for <paramref name="id"/> in any casing, or null when no
    /// track has it: what a stored lap and a board are keyed by.</summary>
    public static string? KnownTrackId(string? id)
    {
        foreach (var track in Tracks)
        {
            if (string.Equals(id?.Trim(), track.Id, StringComparison.OrdinalIgnoreCase)) return track.Id;
        }
        return null;
    }

    /// <summary>A lap or race time as the HUD, the cards and the results show it: m:ss.s.</summary>
    public static string FormatLap(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) return "0:00.0";
        var minutes = (int)(seconds / 60);
        return $"{minutes}:{seconds - minutes * 60:00.0}";
    }
}
