namespace PoMiniGames.Shared.Games;

// Contracts for the /pomarblerace/hub (race) and /pomarblerace/lobby-hub (shared lobby) SignalR
// surfaces: online Marble Race.
//
// The race is HOST-AUTHORITATIVE. cannon-es steps with a variable frame dt and its float
// math is not guaranteed identical across two browsers, so a lockstep of the 101-marble
// physics would drift within seconds. Instead the host browser runs the only simulation
// and streams marble positions at ~15 Hz; the guest browser builds the same track from
// the same seed, renders the streamed positions, and sends only its steering. The
// server relays and pairs — it never sees a marble.

public enum MarbleRaceRole
{
    Host,
    Guest,
}

public sealed record MarbleRaceSeat(string DisplayName, bool IsGuest, MarbleRaceRole Role, bool Connected);

/// <summary>
/// Sent to each seat when a pair forms. The seed and map are what make both browsers build
/// the same course; <see cref="GuestMarbleIndex"/> is the pack slot the guest steers (the host
/// always drives marble 0, the red one).
/// </summary>
public sealed record MarbleRaceStart(
    string RaceId,
    MarbleRaceRole YourRole,
    int Seed,
    int MapId,
    int GuestMarbleIndex,
    MarbleRaceSeat Host,
    MarbleRaceSeat Guest);

/// <summary>
/// One streamed snapshot from the host. <see cref="Positions"/> is 101 × (x, y, z) little-endian
/// float32; <see cref="Flags"/> is one byte per marble: 0 live, 1 finished, 2 eliminated. The
/// guest marble's place rides along so the guest page can show it without a second sim.
/// </summary>
public sealed class MarbleRaceFrame
{
    public int Tick { get; set; }
    public double Clock { get; set; }
    public string Phase { get; set; } = "racing";
    public byte[] Positions { get; set; } = [];
    public byte[] Flags { get; set; } = [];
    public int GuestPlace { get; set; }
    public int Field { get; set; }
}

/// <summary>Host → guest phase change. <see cref="Seed"/> is the seed of the NEXT track on <c>pick</c>.</summary>
public sealed record MarbleRacePhase(string Phase, int Seed);

public sealed record MarbleRacePodium(int[] Indices, double[] Times, double[] Gaps);

/// <summary>Host → guest final standings for the two humans. Place is -1 for a marble that fell off.</summary>
public sealed record MarbleRaceResult(bool HostWon, int HostPlace, bool GuestWon, int GuestPlace);

/// <summary>
/// One seat in the shared Marble Race lobby. <see cref="MapId"/> is this seat's track pick; only the
/// host's counts (the race runs the host's course), but riding on the seat lets the shared lobby
/// state carry it to the guest with no extra message. <see cref="UserId"/> never goes on the wire:
/// the race hub uses it to tell which seat a joining connection is.
/// </summary>
public sealed record PoMarbleRaceLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    [property: System.Text.Json.Serialization.JsonIgnore] string UserId = "",
    int MapId = 2) : ILobbyPlayer;

/// <summary>
/// One finish on one map, offered as a world record. The server keeps it only if it is the fastest.
/// On the Daily Canyon (<see cref="MarbleRaceDaily.MapId"/>) <see cref="Day"/> is the UTC day
/// (yyyy-MM-dd) whose course was raced, and the finish goes on that day's board instead.
/// </summary>
public sealed record MarbleRaceRecordRequest(int MapId, double FinishSeconds, string? Day = null);

/// <summary>The Daily Canyon: one seeded course per UTC day, the same for everyone (maps.js slot 6).</summary>
public static class MarbleRaceDaily
{
    /// <summary>The map slot (maps.js <c>id: 6</c>).</summary>
    public const int MapId = 6;

    public const string DayFormat = "yyyy-MM-dd";

    /// <summary>
    /// Re-formats a caller's day from the parsed date, so only a server-formatted key ever reaches
    /// storage, and accepts it only if it is today or the day either side (a race that ran over
    /// midnight UTC, or a skewed clock). Anything older is not a board anyone can still post to.
    /// </summary>
    public static bool TryDayKey(string? day, DateTime utcNow, out string key)
    {
        key = "";
        if (!DateOnly.TryParseExact(day, DayFormat, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None, out var date)) return false;
        if (Math.Abs(date.DayNumber - DateOnly.FromDateTime(utcNow).DayNumber) > 1) return false;
        key = date.ToString(DayFormat, System.Globalization.CultureInfo.InvariantCulture);
        return true;
    }

    public static string TodayKey(DateTime utcNow) =>
        DateOnly.FromDateTime(utcNow).ToString(DayFormat, System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>One top-10 finish inside a scoring run. <see cref="LeadSeconds"/> is the gap to 2nd (0 unless 1st).</summary>
public sealed record MarbleRaceRunRace(int Place, double FinishSeconds, double LeadSeconds);

/// <summary>
/// A PoMarbleRace high-score submission: the run's claimed total plus the races it was built
/// from. The server recomputes the total from <see cref="Races"/> and stores that, never
/// <see cref="BestScore"/> (which is only compared and logged). Identity and timestamp are
/// server-derived, so there is no field to forge them in.
/// </summary>
public sealed record MarbleRaceHighScoreRequest(int BestScore, int MapId = 0, MarbleRaceRunRace[]? Races = null);
