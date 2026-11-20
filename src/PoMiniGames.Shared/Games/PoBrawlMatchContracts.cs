using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Shared.Games;

// ─────────────────────────────  Match runtime  ──────────────────────────────
//
// What the server broadcasts and what the client sends during a live 1v1.
//
// The fight is GGPO-style rollback with the server as input relay and referee. Both browsers
// and the server step the same integer, 60 Hz simulation (PoBrawlRollbackSim here, and its
// bit-identical twin wwwroot/js/pobrawl/rollbackSim.js). A client never reports a hit: it
// reports frame-stamped inputs, the server decides on which frame each one happened and echoes
// it to everyone, and the server alone declares the result.

/// <summary>
/// One input event a client sends on every input change: the corner's HELD state (Idle,
/// MoveForward, MoveBack or Block — it persists until the next event, so the client sends one on
/// key-up too) and, optionally, a PRESS (Punch, Kick, Special, Grab or Taunt, buffered one deep
/// behind the cooldown).
/// </summary>
/// <remarks>
/// <para>
/// <see cref="Frame"/> is the client's request: its own frame plus the input delay. The server
/// applies the input at max(<see cref="Frame"/>, its frame + 1) — it never rewrites its own past —
/// and echoes the frame it used in a <see cref="PoBrawlMatchInputEvent"/>.
/// </para>
/// <para>
/// The server validates <see cref="ActorSide"/> against the connection's known side at JoinMatch;
/// an honest client never needs it — it is here so a malicious client cannot claim to be the other side.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchInput
{
    /// <summary>Which side this input is from. Server-overridden with the connection's pinned side.</summary>
    public PoBrawlSide ActorSide { get; set; }
    /// <summary>The sim frame the client applied this input at (its frame + the input delay).</summary>
    public long Frame { get; set; }
    /// <summary>The held state from this frame on: Idle, MoveForward, MoveBack or Block.</summary>
    public PoBrawlMatchAction Held { get; set; }
    /// <summary>What was pressed on this frame (Punch, Kick, Special, Grab, Taunt), or Idle for none.</summary>
    public PoBrawlMatchAction Press { get; set; }
    /// <summary>Per-connection sequence number. The server drops one that is not newer, and echoes it back.</summary>
    public long Sequence { get; set; }
}

/// <summary>
/// An input the server accepted, broadcast at once to the whole match group — the sender
/// included, so a client whose input arrived late learns the frame the server moved it to.
/// </summary>
public sealed class PoBrawlMatchInputEvent
{
    public string MatchId { get; set; } = "";
    public PoBrawlSide Side { get; set; }
    /// <summary>The frame the server applied it at (never earlier than the client asked).</summary>
    public long Frame { get; set; }
    public PoBrawlMatchAction Held { get; set; }
    public PoBrawlMatchAction Press { get; set; }
    /// <summary>The sender's sequence number; 0 for an input the server made (a dropped corner lets go of its keys).</summary>
    public long Sequence { get; set; }
}

/// <summary>A clock-sync answer: where the server's fight clock is, so a client can run just ahead of it.</summary>
public sealed class PoBrawlMatchClock
{
    public string MatchId { get; set; } = "";
    /// <summary>The last frame the server has simulated.</summary>
    public long Frame { get; set; }
    /// <summary>The server's real-time frame clock when it answered (fractional; the sim catches up to it).</summary>
    public double ClockFrame { get; set; }
}

public enum PoBrawlSide
{
    Player1 = 0,
    Player2 = 1,
}

public enum PoBrawlMatchAction
{
    Idle = 0,
    MoveForward = 1,
    MoveBack = 2,
    Block = 3,
    /// <summary>Punch (a press). Lands only if the gap is inside punch reach when it fires.</summary>
    Punch = 4,
    /// <summary>Kick. Higher damage, slower cadence.</summary>
    Kick = 5,
    /// <summary>Special. Needs and spends a full energy bar; unblockable.</summary>
    Special = 6,
    /// <summary>Grab (a press). Goes through a guard and throws; any strike beats it; never the knockout.</summary>
    Grab = 7,
    /// <summary>Taunt (a press). Only taken out of strike range: about a second wide open, then energy.</summary>
    Taunt = 8,
}

/// <summary>
/// Server snapshot of the match, broadcast ~10 Hz on the match group: the full sim state at
/// <see cref="Frame"/> (so a client can check its own history against it and a spectator or late
/// joiner can start from it), plus the presence and forfeit facts only the server knows.
/// </summary>
public sealed class PoBrawlMatchState
{
    /// <summary>Stable match id (lobby-stamped GUID), echoed back so retries dedupe.</summary>
    public string MatchId { get; set; } = "";
    /// <summary>The sim frame this snapshot is of.</summary>
    public long Frame { get; set; }
    /// <summary>The packed <see cref="PoBrawlSimState"/> at <see cref="Frame"/> (<see cref="PoBrawlRollbackSim.Pack"/>).</summary>
    public int[] Sim { get; set; } = [];
    /// <summary><see cref="PoBrawlRollbackSim.Checksum"/> of <see cref="Sim"/>, for desync detection.</summary>
    public uint Checksum { get; set; }
    /// <summary>Seconds since the bell; negative through the pre-roll.</summary>
    public double ElapsedSeconds { get; set; }
    /// <summary>P1's current HP, 0..100.</summary>
    public int Player1Hp { get; set; } = 100;
    /// <summary>P2's current HP, 0..100.</summary>
    public int Player2Hp { get; set; } = 100;
    /// <summary>P1's energy meter in displayed points, 0..100.</summary>
    public int Player1Energy { get; set; }
    /// <summary>P2's energy meter in displayed points, 0..100.</summary>
    public int Player2Energy { get; set; }
    /// <summary>P1's position on the one-dimensional ring, metres from centre (negative = left).</summary>
    public double Player1X { get; set; } = -1.6;
    /// <summary>P2's position; always at least the minimum gap to the right of P1.</summary>
    public double Player2X { get; set; } = 1.6;
    /// <summary>What each corner is holding: Idle, MoveForward, MoveBack or Block.</summary>
    public PoBrawlMatchAction Player1Held { get; set; }
    public PoBrawlMatchAction Player2Held { get; set; }
    /// <summary>
    /// How the fight ended, once <see cref="Finished"/>: <c>ko</c>, <c>time-up</c>, <c>time-up-draw</c>,
    /// <c>forfeit</c> or <c>abandoned</c>. Empty while it runs.
    /// </summary>
    public string LastEvent { get; set; } = "";
    /// <summary>True when the match is over (a side at 0 HP, the timer ran out, or a forfeit).</summary>
    public bool Finished { get; set; }
    /// <summary>Winner side when <see cref="Finished"/> is true; null on a draw or while it runs.</summary>
    public PoBrawlSide? Winner { get; set; }
    /// <summary>Whether each corner has a live connection. A dropped corner has a grace window to come back.</summary>
    public bool Player1Connected { get; set; } = true;
    public bool Player2Connected { get; set; } = true;
    /// <summary>
    /// Seconds until a dropped corner forfeits — or, while <see cref="WaitingForOpponent"/>, until a
    /// corner that has not arrived abandons the fight. Null when both are here.
    /// </summary>
    public double? ForfeitInSeconds { get; set; }
    /// <summary>
    /// True until both corners have joined the match hub. The clock is held at frame 0 meanwhile
    /// (Ping answers ClockFrame 0), and the pre-roll countdown starts the moment the second arrives.
    /// </summary>
    public bool WaitingForOpponent { get; set; }
}


/// <summary>
/// Static per-match information returned once at JoinMatch. Carries the lobby-derived
/// player identities and the local side the connection was pinned to.
/// </summary>
public sealed class PoBrawlMatchSnapshot
{
    public string MatchId { get; set; } = "";
    /// <summary>The match code — a reconnect finds the fight by it.</summary>
    public string GameCode { get; set; } = "";
    public PoBrawlMatchPlayerInfo Player1 { get; set; } = new("", "");
    public PoBrawlMatchPlayerInfo Player2 { get; set; } = new("", "");
    public PoBrawlSide LocalSide { get; set; }
    /// <summary>True for a caller with no seat on this fight: they watch, and their inputs are ignored.</summary>
    public bool IsSpectator { get; set; }
}

public sealed record PoBrawlMatchPlayerInfo(string DisplayName, string FighterId);

/// <summary>
/// Final result the server returns when the match ends. Clients POST this back
/// to /api/pobrawl/matches so the result lands in MatchHistory and the Elo table.
/// </summary>
public sealed class PoBrawlMatchResult
{
    public string MatchId { get; set; } = "";
    /// <summary>Side the local player was on. Used by the client to map outcome to Owner/Opponent.</summary>
    public PoBrawlSide LocalSide { get; set; }
    /// <summary>Outcome from the local player's perspective.</summary>
    public PoBrawlOutcome Outcome { get; set; }
    /// <summary>Wall-clock duration, server-stamped so a client cannot pad its own result.</summary>
    public double DurationSeconds { get; set; }
    /// <summary>Final HP totals so the result modal can show the fight score.</summary>
    public int Player1Hp { get; set; }
    public int Player2Hp { get; set; }
    /// <summary>The opponent's principal id (server-stamped from the lobby roster).
    /// Included so the client can POST a complete match-result payload without a
    /// second round-trip to /api/auth/handshake.</summary>
    public string OpponentId { get; set; } = "";
    public string OpponentDisplayName { get; set; } = "";
    /// <summary>True when the fight ended because one corner never came back from a disconnect.</summary>
    public bool Forfeit { get; set; }
    /// <summary>
    /// True when the fight never really happened: a corner never arrived, or both walked out.
    /// <see cref="Outcome"/> is then Draw, and the result ingest records nothing and moves no rating.
    /// </summary>
    public bool Abandoned { get; set; }
}
