using System.Collections.Concurrent;
using System.Diagnostics;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;
using Sim = PoMiniGames.Shared.Games.PoBrawlRollbackSim;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// One in-process PoBrawl 1v1 match: the referee of a rollback fight. Owns the timeline (which
/// frame each input happened on), the authoritative copy of the shared simulation, presence,
/// forfeits and the result. Lifecycle: created by <see cref="PoBrawlMatchRegistry"/>
/// when the host starts a match, and swept by the pump once it has lingered past
/// <see cref="PoBrawlMatchRegistry.FinishedLinger"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>The fight is <see cref="PoBrawlRollbackSim"/></b> — integer, 60 Hz, and bit-identical to the
/// browsers' rollbackSim.js, which predict the same fight locally and roll back when this server's
/// timeline disagrees. Nothing here does fight maths of its own.
/// </para>
/// <para>
/// <b>The server is the timeline authority.</b> Its frame clock is held at 0 until BOTH corners have
/// joined, then runs in real time (<see cref="ClockFrame"/>; the pump catches the sim up to it), so
/// the pre-roll countdown starts when the second corner arrives, not when the lobby pressed start.
/// An input stamped with client frame f is applied at max(f, <see cref="Frame"/> + 1, that side's
/// previous input frame); one stamped more than <see cref="MaxInputLeadFrames"/> ahead is refused,
/// as is a corner past <see cref="MaxInputsPerFrame"/> on one frame or <see cref="MaxInputsPerSecond"/>
/// in a second of fight: the server never rewrites its own past, each side's inputs stay in order,
/// and a flooding client cannot make the referee do unbounded work. Every accepted input comes back from <see cref="SubmitInput"/> as a
/// <see cref="PoBrawlMatchInputEvent"/> carrying the frame actually used, which the hub broadcasts
/// to the match — sender included, so a late input re-stamped here is corrected client-side.
/// </para>
/// <para>
/// <b>Anti-cheat.</b> A connection is pinned to its corner at JoinMatch by claim identity and can
/// only move that corner; a spectator's input is refused. A client never reports a hit or HP: the
/// result is built from this server's sim alone, and only its two corners can claim it.
/// </para>
/// <para>
/// <b>Presence.</b> A corner is present while any match-hub connection is pinned to it. A corner that
/// never arrives within <see cref="ArrivalGraceSeconds"/> abandons the fight — no winner, no rating:
/// the corner that did turn up never fought anyone. One that drops mid-fight gets
/// <see cref="ReconnectGraceSeconds"/> and then forfeits; when its last connection goes, the server
/// lets go of its keys with an input of its own (Sequence 0) so it does not march into the ropes.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchService
{
    /// <summary>Sim frames per second (<see cref="PoBrawlRollbackSim.Hz"/>).</summary>
    public const int FrameHz = Sim.Hz;

    /// <summary>Snapshot cadence: every 6th frame, 10 Hz.</summary>
    public const int SnapshotEveryFrames = 6;

    /// <summary>Round length, seconds. Matches the 2P local round.</summary>
    public const double MatchDurationSeconds = Sim.RoundFrames / (double)Sim.Hz;

    /// <summary>
    /// Pre-roll before the bell, counted from the moment the second corner joins: long enough for
    /// both pages to play the engine's 3.7 s countdown in step with it. The lobby's matches use
    /// this; tests start at 0.
    /// </summary>
    public const double CountdownSeconds = 5.0;

    /// <summary>How long a corner that dropped mid-fight has to reconnect before it forfeits.</summary>
    public const double ReconnectGraceSeconds = 15.0;

    /// <summary>How long both corners have to arrive (page load included) before the fight is abandoned.</summary>
    public const double ArrivalGraceSeconds = 25.0;

    /// <summary>Furthest ahead of the server's frame an input may be stamped (2 s); a later stamp is refused.</summary>
    public const int MaxInputLeadFrames = 2 * Sim.Hz;

    /// <summary>
    /// Inputs one corner may land on a single frame. They merge into one (the later held wins, a
    /// press is kept), so a real client never needs more than a key change and a press.
    /// </summary>
    public const int MaxInputsPerFrame = 3;

    /// <summary>
    /// Inputs one corner may send per second of fight (60 frames). A client sends only on a change
    /// — key down, key up — so even frantic mashing stays well under this.
    /// </summary>
    public const int MaxInputsPerSecond = 40;

    public string MatchId { get; }
    public string GameCode { get; }
    public IReadOnlyList<PoBrawlLobbyPlayer> Roster { get; }

    private readonly PoBrawlLobbyPlayer _p1;
    private readonly PoBrawlLobbyPlayer _p2;
    private readonly object _stateLock = new();

    /// <summary>The server-only side of one corner. Guarded by <see cref="_stateLock"/>.</summary>
    private sealed class Corner
    {
        /// <summary>Accepted inputs not yet simulated: frame → encoded input (merged per frame).</summary>
        public readonly Dictionary<long, int> Future = [];
        /// <summary>The frame this corner's newest input was applied at — later inputs never go before it.</summary>
        public long LastInputFrame;
        public long LastSequence = long.MinValue;
        public bool EverConnected;
        /// <summary>Frames this corner has had no connection (reset on arrival).</summary>
        public long AbsentFrames;
        /// <summary>Inputs accepted per future frame, for <see cref="MaxInputsPerFrame"/>.</summary>
        public readonly Dictionary<long, int> PerFrame = [];
        /// <summary>The server frame the current one-second input window opened on, and its count.</summary>
        public long WindowStartFrame;
        public int WindowCount;
    }

    private readonly Corner _c1 = new();
    private readonly Corner _c2 = new();
    private PoBrawlSimState _sim;
    private readonly long _createdAt = Stopwatch.GetTimestamp();
    /// <summary>When the second corner arrived and the clock started, or null while one is still awaited.</summary>
    private long? _armedAt;
    private bool _finished;
    private bool _forfeit;
    private bool _abandoned;
    private string _endEvent = "";
    private PoBrawlSide? _winner;

    /// <summary>When the bell rang, or null while the fight is on. The registry drops a match a while after this.</summary>
    public DateTimeOffset? FinishedAtUtc { get; private set; }

    /// <summary>Connection-id keyed map. Set by the match hub at JoinMatch.</summary>
    private readonly ConcurrentDictionary<string, PoBrawlSide> _connections = new();

    /// <param name="countdownSeconds">Pre-roll before the bell (see <see cref="CountdownSeconds"/>); 0 starts the fight at once.</param>
    public PoBrawlMatchService(string matchId, string gameCode, IReadOnlyList<PoBrawlLobbyPlayer> roster, double countdownSeconds = 0)
    {
        MatchId = matchId;
        GameCode = gameCode;
        Roster = roster.ToList();
        // Roster is exactly two (lobby cap), but be defensive about ordering so the
        // host is always P1 regardless of who joined first at the SignalR level.
        _p1 = Roster[0];
        _p2 = Roster[1];
        // The damage roll is seeded from the match id, so a replay of the same inputs is the same fight
        // — on this host, any other host, and in both browsers.
        _sim = Sim.Create(Sim.SeedFromMatchId(matchId), (int)Math.Round(Math.Max(0, countdownSeconds) * Sim.Hz));
    }

    /// <summary>The last frame simulated.</summary>
    public long Frame
    {
        get { lock (_stateLock) return _sim.Frame; }
    }

    /// <summary>A copy of the authoritative sim state (tests, diagnostics).</summary>
    public PoBrawlSimState SimState
    {
        get { lock (_stateLock) return _sim; }
    }

    /// <summary>
    /// The real-time frame clock: frames since both corners arrived, fractional, and 0 until then.
    /// The sim catches up to it.
    /// </summary>
    public double ClockFrame(long nowTimestamp)
    {
        lock (_stateLock) return ClockFrameLocked(nowTimestamp);
    }

    private double ClockFrameLocked(long nowTimestamp) =>
        _armedAt is { } armed ? Math.Max(0, nowTimestamp - armed) * (double)Sim.Hz / Stopwatch.Frequency : 0;

    /// <summary>True until both corners have joined (and the clock has started).</summary>
    public bool IsWaiting
    {
        get { lock (_stateLock) return _armedAt is null && !_finished; }
    }

    /// <summary>The Stopwatch timestamp the match was created at; the arrival grace runs from it.</summary>
    public long CreatedAt => _createdAt;

    private long _waitingNotice = -1;

    /// <summary>
    /// The pump's once-a-second waiting snapshot: true the first time it asks for a given whole
    /// second waited, false after, so the held clock still sends one snapshot a second.
    /// </summary>
    public bool TryMarkWaitingNotice(long secondWaited)
    {
        lock (_stateLock)
        {
            if (secondWaited == _waitingNotice) return false;
            _waitingNotice = secondWaited;
            return true;
        }
    }

    /// <summary>True when the fight ended without being fought: a corner never arrived, or both left.</summary>
    public bool IsAbandoned
    {
        get { lock (_stateLock) return _abandoned; }
    }

    public PoBrawlMatchClock Clock() => new()
    {
        MatchId = MatchId,
        Frame = Frame,
        ClockFrame = Math.Round(ClockFrame(Stopwatch.GetTimestamp()), 3),
    };

    public PoBrawlSide SideFor(string connectionId) =>
        _connections.TryGetValue(connectionId, out var side) ? side : PoBrawlSide.Player1;

    public void RegisterConnection(string connectionId, PoBrawlSide side)
    {
        lock (_stateLock)
        {
            _connections[connectionId] = side;
            var corner = CornerOf(side);
            corner.EverConnected = true;
            corner.AbsentFrames = 0;
            // A fresh connection (a refresh, a reconnect) starts its own sequence numbers.
            corner.LastSequence = long.MinValue;
            // Both corners here: start the clock, and with it the pre-roll countdown.
            if (_armedAt is null && _c1.EverConnected && _c2.EverConnected && !_finished)
            {
                _armedAt = Stopwatch.GetTimestamp();
            }
        }
    }

    private Corner CornerOf(PoBrawlSide side) => side == PoBrawlSide.Player1 ? _c1 : _c2;

    private bool IsPresentLocked(PoBrawlSide side) => _connections.Values.Any(s => s == side);

    /// <summary>
    /// Every match-hub connection pinned to a side. The pump sends each its own result
    /// from this — NOT from <see cref="Roster"/>, whose connection ids belong to the lobby
    /// hub and do not exist on the match hub at all, so a result sent there reached nobody.
    /// </summary>
    public IReadOnlyCollection<string> ConnectionIds => _connections.Keys.ToArray();

    /// <summary>
    /// Pin a connection by the player's lobby-side principal id. The match hub
    /// and the lobby hub allocate separate connection ids, so we re-resolve the
    /// side by walking the roster instead of relying on the lobby connection id
    /// being passed through.
    /// </summary>
    public bool RegisterConnectionByPrincipal(string principalId, string connectionId)
    {
        if (SideForPrincipal(principalId) is not { } side) return false;
        RegisterConnection(connectionId, side);
        return true;
    }

    /// <summary>
    /// Forget a connection. When it was the corner's last one, the corner lets go of whatever it
    /// was holding — a player who dropped mid-walk must not march into the ropes for the whole
    /// grace window — and its absence clock starts. Returns that server-made input for the hub to
    /// broadcast, or null when nothing changed.
    /// </summary>
    public PoBrawlMatchInputEvent? UnregisterConnection(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_connections.TryRemove(connectionId, out var side) || IsPresentLocked(side) || _finished) return null;
            return AcceptLocked(side, CornerOf(side), _sim.Frame + 1, PoBrawlMatchAction.Idle, PoBrawlMatchAction.Idle, sequence: 0);
        }
    }

    /// <summary>The current snapshot (the pump's 10 Hz broadcast, a join).</summary>
    public PoBrawlMatchState Snapshot()
    {
        lock (_stateLock) return SnapshotLocked();
    }

    private static bool IsHeld(PoBrawlMatchAction a) => a is >= PoBrawlMatchAction.Idle and <= PoBrawlMatchAction.Block;

    private static bool IsPressOrNone(PoBrawlMatchAction a) =>
        a is PoBrawlMatchAction.Idle or PoBrawlMatchAction.Punch or PoBrawlMatchAction.Kick or PoBrawlMatchAction.Special;

    /// <summary>
    /// Accept the caller's input. The side is the connection's pinned one, whatever
    /// <see cref="PoBrawlMatchInput.ActorSide"/> claims. Returns the event to broadcast (with the
    /// frame the server applied it at), or null when refused: not seated, a finished fight, a
    /// sequence number that is not newer, an action outside the held / press sets, a stamp more
    /// than <see cref="MaxInputLeadFrames"/> ahead, or a corner over its input budget.
    /// </summary>
    public PoBrawlMatchInputEvent? SubmitInput(string connectionId, PoBrawlMatchInput input)
    {
        if (!_connections.TryGetValue(connectionId, out var pinned)) return null;
        input.ActorSide = pinned;
        if (!IsHeld(input.Held) || !IsPressOrNone(input.Press)) return null;
        lock (_stateLock)
        {
            if (_finished) return null;
            var corner = CornerOf(pinned);
            if (input.Sequence <= corner.LastSequence) return null; // stale or duplicated in flight
            if (input.Frame > _sim.Frame + MaxInputLeadFrames) return null; // no honest clock is that far ahead
            if (_sim.Frame - corner.WindowStartFrame >= Sim.Hz)
            {
                corner.WindowStartFrame = _sim.Frame;
                corner.WindowCount = 0;
            }
            if (corner.WindowCount >= MaxInputsPerSecond) return null;
            var frame = Math.Max(input.Frame, Math.Max(_sim.Frame + 1, corner.LastInputFrame));
            if (corner.PerFrame.GetValueOrDefault(frame) >= MaxInputsPerFrame) return null;
            corner.WindowCount++;
            corner.LastSequence = input.Sequence;
            return AcceptLocked(pinned, corner, input.Frame, input.Held, input.Press, input.Sequence);
        }
    }

    private PoBrawlMatchInputEvent AcceptLocked(PoBrawlSide side, Corner corner, long requested, PoBrawlMatchAction held,
        PoBrawlMatchAction press, long sequence)
    {
        // Never into the past (ours or this side's previous input), never absurdly far ahead.
        var earliest = Math.Max(_sim.Frame + 1, corner.LastInputFrame);
        var frame = Math.Clamp(requested, earliest, Math.Max(earliest, _sim.Frame + MaxInputLeadFrames));
        corner.LastInputFrame = frame;
        corner.PerFrame[frame] = corner.PerFrame.GetValueOrDefault(frame) + 1;
        var encoded = Sim.EncodeInput((int)held, press == PoBrawlMatchAction.Idle ? Sim.PressNone : (int)press);
        corner.Future[frame] = corner.Future.TryGetValue(frame, out var earlier) ? Sim.MergeInput(earlier, encoded) : encoded;
        return new PoBrawlMatchInputEvent
        {
            MatchId = MatchId,
            Side = side,
            Frame = frame,
            Held = held,
            Press = press,
            Sequence = sequence,
        };
    }

    /// <summary>
    /// Simulate one frame. Returns the snapshot after it, or null when the match had already ended.
    /// The pump calls <see cref="AdvanceTo"/>; tests step frame by frame with this.
    /// </summary>
    public PoBrawlMatchState? Step()
    {
        lock (_stateLock)
        {
            if (_finished) return null;
            StepLocked();
            return SnapshotLocked();
        }
    }

    /// <summary>
    /// The pump's tick: while a corner is still awaited, abandon the fight once
    /// <see cref="ArrivalGraceSeconds"/> have passed since it was created (returns 0 either way);
    /// after that, catch the sim up to the real-time clock. Returns how many frames ran.
    /// </summary>
    public int AdvanceToClock(long nowTimestamp)
    {
        lock (_stateLock)
        {
            if (_finished) return 0;
            if (_armedAt is null)
            {
                if ((nowTimestamp - _createdAt) / (double)Stopwatch.Frequency >= ArrivalGraceSeconds)
                {
                    AbandonLocked();
                }
                return 0;
            }
            return AdvanceToLocked((long)Math.Floor(ClockFrameLocked(nowTimestamp)));
        }
    }

    /// <summary>
    /// Catch the sim up to <paramref name="targetFrame"/>. Returns how many frames ran; stops early
    /// when the fight ends. Tests drive the sim with this (and <see cref="Step"/>) directly.
    /// </summary>
    public int AdvanceTo(long targetFrame)
    {
        lock (_stateLock) return AdvanceToLocked(targetFrame);
    }

    private int AdvanceToLocked(long targetFrame)
    {
        var ran = 0;
        while (!_finished && _sim.Frame < targetFrame)
        {
            StepLocked();
            ran++;
        }
        return ran;
    }

    private void AbandonLocked()
    {
        _finished = true;
        _abandoned = true;
        _winner = null;
        _endEvent = "abandoned";
        FinishedAtUtc ??= DateTimeOffset.UtcNow;
    }

    private void StepLocked()
    {
        var f = (long)_sim.Frame + 1;
        var in1 = TakeInput(_c1, f);
        var in2 = TakeInput(_c2, f);
        Sim.Step(ref _sim, in1, in2);
        TickPresenceLocked();
        if (!_finished && _sim.Over != 0)
        {
            _finished = true;
            _winner = _sim.Winner switch { 1 => PoBrawlSide.Player1, 2 => PoBrawlSide.Player2, _ => null };
            _endEvent = _sim.Reason == Sim.ReasonKo ? "ko" : _winner is null ? "time-up-draw" : "time-up";
        }
        if (_finished) FinishedAtUtc ??= DateTimeOffset.UtcNow;
    }

    private static int TakeInput(Corner c, long frame)
    {
        c.PerFrame.Remove(frame);
        return c.Future.Remove(frame, out var input) ? input : 0;
    }

    /// <summary>
    /// Advance each corner's absence clock and forfeit one that stayed away past its grace. Both gone
    /// is an abandoned fight with no winner, and so is one where either corner never arrived at all:
    /// a win needs an opponent who actually turned up.
    /// </summary>
    private void TickPresenceLocked()
    {
        foreach (var (corner, side) in new[] { (_c1, PoBrawlSide.Player1), (_c2, PoBrawlSide.Player2) })
        {
            corner.AbsentFrames = IsPresentLocked(side) ? 0 : corner.AbsentFrames + 1;
        }
        var gone1 = _c1.AbsentFrames >= GraceFrames(_c1);
        var gone2 = _c2.AbsentFrames >= GraceFrames(_c2);
        if (!gone1 && !gone2) return;
        if ((gone1 && gone2) || !_c1.EverConnected || !_c2.EverConnected)
        {
            AbandonLocked();
            return;
        }
        _finished = true;
        _forfeit = true;
        _winner = gone1 ? PoBrawlSide.Player2 : PoBrawlSide.Player1;
        _endEvent = "forfeit";
    }

    private static long GraceFrames(Corner c) => (long)((c.EverConnected ? ReconnectGraceSeconds : ArrivalGraceSeconds) * Sim.Hz);

    private double? ForfeitInLocked()
    {
        if (_finished) return null;
        var left = new[] { _c1, _c2 }
            .Where(c => c.AbsentFrames > 0)
            .Select(c => (GraceFrames(c) - c.AbsentFrames) / (double)Sim.Hz)
            .DefaultIfEmpty(double.NaN)
            .Min();
        return double.IsNaN(left) ? null : Math.Max(0, Math.Round(left, 1));
    }

    private PoBrawlMatchState SnapshotLocked() => new()
    {
        MatchId = MatchId,
        Frame = _sim.Frame,
        Sim = Sim.Pack(_sim),
        Checksum = Sim.Checksum(_sim),
        ElapsedSeconds = Math.Round(Sim.ElapsedSeconds(_sim), 3),
        Player1Hp = _sim.P1.Hp,
        Player2Hp = _sim.P2.Hp,
        Player1Energy = _sim.P1.Energy / Sim.EnergyScale,
        Player2Energy = _sim.P2.Energy / Sim.EnergyScale,
        Player1X = _sim.P1.X / 1000.0,
        Player2X = _sim.P2.X / 1000.0,
        Player1Held = (PoBrawlMatchAction)_sim.P1.Held,
        Player2Held = (PoBrawlMatchAction)_sim.P2.Held,
        LastEvent = _finished ? _endEvent : "",
        Finished = _finished,
        Winner = _winner,
        Player1Connected = IsPresentLocked(PoBrawlSide.Player1),
        Player2Connected = IsPresentLocked(PoBrawlSide.Player2),
        // Waiting: how long the missing corner has left to arrive. Otherwise only while a corner is
        // actually away (over a second).
        ForfeitInSeconds = _armedAt is null && !_finished
            ? Math.Max(0, Math.Round(ArrivalGraceSeconds - (Stopwatch.GetTimestamp() - _createdAt) / (double)Stopwatch.Frequency, 1))
            : ForfeitInLocked() is { } left && (_c1.AbsentFrames > Sim.Hz || _c2.AbsentFrames > Sim.Hz) ? left : null,
        WaitingForOpponent = _armedAt is null && !_finished,
    };

    /// <summary>
    /// Build the final <see cref="PoBrawlMatchResult"/> from a connection's perspective.
    /// Both clients receive their own copy with their own local side set, so the
    /// outcome maps to "did the local player win?".
    /// </summary>
    public PoBrawlMatchResult BuildResultFor(string connectionId) => BuildResultForSide(SideFor(connectionId));

    /// <summary>
    /// The roster side a principal id owns, or null when they are not one of the two fighters.
    /// Ignore-case: the lobby lower-cases the principal it seats (it doubles as a table row key),
    /// while the claim id arrives as issued.
    /// </summary>
    public PoBrawlSide? SideForPrincipal(string principalId)
    {
        if (string.IsNullOrWhiteSpace(principalId)) return null;
        // Roster[0] is Player1, Roster[1] is Player2 (host-first, matches the lobby).
        for (var i = 0; i < Roster.Count; i++)
        {
            if (string.Equals(Roster[i].PrincipalId, principalId, StringComparison.OrdinalIgnoreCase))
            {
                return i == 0 ? PoBrawlSide.Player1 : PoBrawlSide.Player2;
            }
        }
        return null;
    }

    /// <summary>
    /// Server-canonical result for one of the two fighters, by principal id — the ingest's
    /// source of truth for outcome, opponent and duration. Null for anyone else (spectators,
    /// a fabricated caller): a match may only be reported by its own corners.
    /// </summary>
    public PoBrawlMatchResult? BuildResultForPrincipal(string principalId) =>
        SideForPrincipal(principalId) is { } side ? BuildResultForSide(side) : null;

    private PoBrawlMatchResult BuildResultForSide(PoBrawlSide localSide)
    {
        PoBrawlMatchState snapshot;
        lock (_stateLock)
        {
            snapshot = SnapshotLocked();
        }
        var opponent = localSide == PoBrawlSide.Player1 ? _p2 : _p1;
        bool forfeit, abandoned;
        lock (_stateLock)
        {
            forfeit = _forfeit;
            abandoned = _abandoned;
        }
        var outcome = !snapshot.Finished ? PoBrawlOutcome.Draw
            : snapshot.Winner is null ? PoBrawlOutcome.Draw
            : snapshot.Winner == localSide ? PoBrawlOutcome.Win
            : PoBrawlOutcome.Loss;
        return new PoBrawlMatchResult
        {
            MatchId = MatchId,
            LocalSide = localSide,
            Outcome = outcome,
            DurationSeconds = snapshot.ElapsedSeconds,
            Player1Hp = snapshot.Player1Hp,
            Player2Hp = snapshot.Player2Hp,
            OpponentId = opponent.PrincipalId,
            OpponentDisplayName = opponent.DisplayName,
            Forfeit = forfeit,
            Abandoned = abandoned,
        };
    }

    public PoBrawlLobbyPlayer Player1 => _p1;
    public PoBrawlLobbyPlayer Player2 => _p2;
}
