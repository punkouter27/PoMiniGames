namespace PoMiniGamesClient.Services.Play;

/// <summary>The kind of server board a queued score targets — drives which submit path the flusher uses.</summary>
public enum PendingScoreKind
{
    MarbleRace = 0,
    PoBrawl = 1,
    /// <summary>A PlayerStats PUT (adaptive-ELO games mirror their rating into it).</summary>
    PlayerStats = 2,
    // 3 was retired with the PoSports game; explicit values keep older parked queues valid.
    PoVoxelStrike = 4,
    PoRacer = 5,
    PoCabinet = 6,
    PoMule = 7,
    PoFunQuiz = 8,
    MarbleRaceMapRecord = 9,
}

/// <summary>
/// One score that could not reach the server and is parked in localStorage until connectivity returns.
/// The payload is stored as JSON so a single queue can hold every board's wire shape.
/// </summary>
public sealed class PendingScore
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public PendingScoreKind Kind { get; set; }
    public string PayloadJson { get; set; } = "";
    public string EnqueuedAt { get; set; } = "";
    public int Attempts { get; set; }
}

