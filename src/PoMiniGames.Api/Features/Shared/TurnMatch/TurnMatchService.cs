using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// Process-local pairing and authoritative match state for a two-seat, turn-based
/// grid game (ConnectFive, TicTacToe). One instance per hub type: the service owns
/// every board, a client sends a cell, the service validates the seat, the turn and
/// the placement through its <see cref="GridGameRules"/>, and hands back the snapshot
/// both seats render.
/// </summary>
/// <remarks>
/// <para>
/// The lobby (<see cref="TurnLobbyHub{TMatchHub}"/>) owns host, ready and start. When the host
/// starts, the lobby <see cref="Reserve"/>s an internal match code and tells only the two
/// seated clients; each then calls <see cref="Join"/> with that code on the match hub. The
/// host plays first. The code is plumbing and is never shown.
/// </para>
/// <para>
/// Seats are bound to a <b>seat token</b>, not a connection id. SignalR's automatic
/// reconnect hands the client a new connection id, so a 30 s WebSocket drop would
/// otherwise orphan the seat. A dropped seat is kept for <see cref="DisconnectGrace"/>
/// and the opponent is told it is waiting; if the token never comes back the match is
/// forfeited to whoever stayed. That timer is the one path where the service, not
/// the hub, broadcasts — hence the <see cref="IHubContext{THub}"/> dependency.
/// </para>
/// <para>
/// Process-local like every other live-play registry in the host: a restart drops
/// the matches, and a game that takes two minutes has no reason to outlive it.
/// </para>
/// </remarks>
public sealed class TurnMatchService<THub> where THub : Hub
{
    /// <summary>How long a dropped seat is held before the match is forfeited to the opponent.</summary>
    public static readonly TimeSpan DisconnectGrace = TimeSpan.FromSeconds(30);

    private readonly GridGameRules _rules;
    private readonly IHubContext<THub> _hub;
    private readonly ILogger _log;
    private readonly string _gameName;
    private readonly object _lock = new();
    private readonly TimeSpan? _turnClock;
    private readonly ITurnMatchResultSink? _results;
    private readonly Func<int, int> _pick;

    /// <summary>Codes the lobby has minted, each holding the first arrival until the second joins.</summary>
    private readonly Dictionary<string, Reservation> _reservations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Match> _byConnection = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Match> _byToken = new(StringComparer.Ordinal);

    /// <param name="rules">The game's placement and win rules.</param>
    /// <param name="hub">Used for the broadcasts the service makes itself (timeouts, scoring, disconnect forfeits).</param>
    /// <param name="log">Logger.</param>
    /// <param name="turnClock">Time a seat has per move; when it runs out the server plays a random legal move. Null: no clock.</param>
    /// <param name="results">Scores each finished match (online Elo). Null: matches are not rated.</param>
    /// <param name="pick">Chooses an index below the given count for the auto-move; defaults to <see cref="Random.Shared"/>.</param>
    public TurnMatchService(GridGameRules rules, IHubContext<THub> hub, ILogger<TurnMatchService<THub>> log,
        TimeSpan? turnClock = null, ITurnMatchResultSink? results = null, Func<int, int>? pick = null)
    {
        _rules = rules;
        _hub = hub;
        _log = log;
        _turnClock = turnClock;
        _results = results;
        _pick = pick ?? Random.Shared.Next;
        _gameName = typeof(THub).Name.Replace("Hub", "", StringComparison.Ordinal);
    }

    public GridGameRules Rules => _rules;

    public string GroupFor(string matchId) => $"{_gameName}-match-{matchId}";

    /// <summary>Reservations still waiting for a seat. Diagnostics only.</summary>
    public int PendingCount { get { lock (_lock) return _reservations.Count; } }

    // ── Pairing ─────────────────────────────────────────────────────────

    /// <summary>A reservation nobody claimed both seats of inside this long is dropped.</summary>
    public static readonly TimeSpan ReservationTtl = TimeSpan.FromMinutes(2);

    /// <summary>Mint the internal match code the lobby hands to its two seated players.</summary>
    public string Reserve()
    {
        lock (_lock)
        {
            var cutoff = DateTimeOffset.UtcNow - ReservationTtl;
            foreach (var stale in _reservations.Where(r => r.Value.CreatedUtc < cutoff).Select(r => r.Key).ToList())
            {
                _reservations.Remove(stale);
            }
            var code = "turn-" + Guid.NewGuid().ToString("N");
            _reservations[code] = new Reservation(DateTimeOffset.UtcNow);
            return code;
        }
    }

    /// <summary>
    /// Claim a seat under a reserved <paramref name="code"/>. The first claimant waits; the
    /// second completes the pairing and gets it back. The host (<paramref name="asHost"/>)
    /// moves first; if both claim the same role the earlier arrival keeps it. Throws
    /// <see cref="InvalidOperationException"/> for an unknown code; a connection that is
    /// already seated or waiting is left as it is (returns null).
    /// </summary>
    public Pairing? Join(string code, string connectionId, string principalId, string displayName, bool isGuest, bool asHost)
    {
        lock (_lock)
        {
            if (_byConnection.ContainsKey(connectionId)) return null;
            if (string.IsNullOrEmpty(code) || !_reservations.TryGetValue(code, out var reservation))
            {
                throw new InvalidOperationException("That game is no longer available.");
            }
            var arrival = new Waiting(connectionId, PrincipalIds.Sanitize(principalId), Features.Shared.PlayerNames.Sanitize(displayName), isGuest, asHost);
            if (reservation.Waiting is null)
            {
                reservation.Waiting = arrival;
                return null;
            }
            if (reservation.Waiting.ConnectionId == connectionId) return null;

            var partner = reservation.Waiting;
            _reservations.Remove(code);

            var arrivalFirst = arrival.AsHost && !partner.AsHost;
            var first = arrivalFirst ? arrival : partner;
            var second = arrivalFirst ? partner : arrival;

            var match = new Match(_rules, Guid.NewGuid().ToString("N"),
                new Seat(first, TurnMatchSide.First), new Seat(second, TurnMatchSide.Second));
            _byConnection[first.ConnectionId] = match;
            _byConnection[second.ConnectionId] = match;
            _byToken[match.First.Token] = match;
            _byToken[match.Second.Token] = match;

            _log.LogInformation("{Game}: paired {First} (first) vs {Second} (second) as match {MatchId}",
                _gameName, first.DisplayName, second.DisplayName, match.MatchId);
            StartClock(match, _turnClock);
            return match.Pairing();
        }
    }

    private void DropWaiting(string connectionId)
    {
        foreach (var r in _reservations.Values.Where(r => r.Waiting?.ConnectionId == connectionId))
        {
            r.Waiting = null;
        }
    }

    // ── Play ────────────────────────────────────────────────────────────

    /// <summary>
    /// Place a mark for the seat behind <paramref name="connectionId"/>. Gravity games
    /// resolve the row themselves. Throws <see cref="InvalidOperationException"/> with
    /// a player-readable message on any rejected move; the hub relays it as a
    /// <see cref="HubException"/>.
    /// </summary>
    public TurnMatchState Place(string connectionId, int row, int col)
    {
        lock (_lock)
        {
            var match = RequireMatch(connectionId);
            var seat = match.SeatFor(connectionId);
            if (match.Status != TurnMatchStatus.InProgress) throw new InvalidOperationException("The game is over.");
            if (seat.Side != match.Turn) throw new InvalidOperationException("It is not your turn.");

            var landing = _rules.ResolveRow(match.Cells, row, col);
            if (landing < 0) throw new InvalidOperationException("You can't play there.");

            ApplyMove(match, seat.Side, landing, col);
            return match.Snapshot();
        }
    }

    /// <summary>Put the mark down, then settle the game: a win, a full board, or the other seat's turn (and a fresh clock).</summary>
    private void ApplyMove(Match match, TurnMatchSide side, int landing, int col)
    {
        var mark = (byte)side;
        match.Cells[landing * _rules.Cols + col] = mark;
        match.MoveCount++;
        match.LastMove = new TurnMatchMove(landing, col, side);

        var line = _rules.FindWin(match.Cells, mark);
        if (line is not null)
        {
            match.Finish(side == TurnMatchSide.First ? TurnMatchStatus.FirstWon : TurnMatchStatus.SecondWon,
                TurnMatchEndReason.Line, line);
            OnFinished(match);
        }
        else if (PoMiniGames.Shared.Games.GridGameRules.IsFull(match.Cells))
        {
            match.Finish(TurnMatchStatus.Draw, TurnMatchEndReason.BoardFull, []);
            OnFinished(match);
        }
        else
        {
            match.Turn = Other(match.Turn);
            StartClock(match, _turnClock);
        }
    }

    // ── Turn clock ──────────────────────────────────────────────────────

    /// <summary>
    /// (Re)start the move clock for the seat to move. Bumping <see cref="Match.ClockEpoch"/> orphans any
    /// timer already running, so a move, a pause or the end of the game simply invalidates it.
    /// </summary>
    private void StartClock(Match match, TimeSpan? duration)
    {
        match.ClockEpoch++;
        match.DeadlineUtc = null;
        if (duration is not { } d || match.Status != TurnMatchStatus.InProgress) return;
        match.DeadlineUtc = DateTimeOffset.UtcNow + d;
        _ = TurnTimeoutAsync(match, match.ClockEpoch, d);
    }

    private async Task TurnTimeoutAsync(Match match, int epoch, TimeSpan duration)
    {
        try
        {
            await Task.Delay(duration);
            TurnMatchState state;
            lock (_lock)
            {
                if (match.ClockEpoch != epoch || match.Status != TurnMatchStatus.InProgress) return;
                if (RandomLegalMove(match) is not { } move) return;
                ApplyMove(match, match.Turn, move.Row, move.Col);
                state = match.Snapshot();
            }
            _log.LogInformation("{Game}: match {MatchId} turn clock ran out; played a random move", _gameName, match.MatchId);
            await _hub.Clients.Group(GroupFor(match.MatchId)).SendAsync("state", state);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "{Game}: turn-clock move failed for match {MatchId}", _gameName, match.MatchId);
        }
    }

    /// <summary>A uniformly random legal placement for the seat to move, by the game's own rules (gravity included).</summary>
    private (int Row, int Col)? RandomLegalMove(Match match)
    {
        var legal = new List<(int Row, int Col)>();
        for (var c = 0; c < _rules.Cols; c++)
        {
            for (var r = 0; r < _rules.Rows; r++)
            {
                if (_rules.ResolveRow(match.Cells, r, c) == r) legal.Add((r, c));
            }
        }
        return legal.Count == 0 ? null : legal[_pick(legal.Count)];
    }

    /// <summary>The game just ended: stop the clock and score the match once.</summary>
    private void OnFinished(Match match)
    {
        match.ClockEpoch++;
        match.DeadlineUtc = null;
        match.PausedRemaining = null;
        if (_results is null || match.ResultRecorded) return;
        match.ResultRecorded = true;
        _ = RecordResultAsync(match);
    }

    private async Task RecordResultAsync(Match match)
    {
        try
        {
            var result = new TurnMatchResult(match.MatchId, match.First.PrincipalId, match.First.DisplayName,
                match.Second.PrincipalId, match.Second.DisplayName, match.Status);
            var ratings = await _results!.RecordAsync(result);
            if (ratings is null) return;
            TurnMatchState state;
            lock (_lock)
            {
                match.Ratings = ratings;
                state = match.Snapshot();
            }
            await _hub.Clients.Group(GroupFor(match.MatchId)).SendAsync("state", state);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "{Game}: scoring match {MatchId} failed", _gameName, match.MatchId);
        }
    }

    /// <summary>
    /// Explicit leave. An in-progress game is forfeited to the opponent; a finished
    /// one just loses the seat. Returns the state to broadcast, or null when the
    /// connection was not seated (a waiting claim is simply dropped).
    /// </summary>
    public TurnMatchState? Leave(string connectionId)
    {
        lock (_lock)
        {
            DropWaiting(connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            if (match.Status == TurnMatchStatus.InProgress)
            {
                match.Finish(WinnerAgainst(seat.Side), TurnMatchEndReason.Forfeit, []);
                OnFinished(match);
            }
            Unseat(match, seat);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Transport disconnect. Unlike <see cref="Leave"/> the seat is kept: the token can
    /// <see cref="Rejoin"/> inside <see cref="DisconnectGrace"/>. Returns the state to
    /// broadcast so the opponent sees the seat go dark, or null when nothing changed.
    /// </summary>
    public TurnMatchState? Disconnected(string connectionId)
    {
        lock (_lock)
        {
            DropWaiting(connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            _byConnection.Remove(connectionId);
            seat.Connected = false;
            seat.ConnectionId = "";
            seat.DisconnectEpoch++;

            if (match.Status != TurnMatchStatus.InProgress)
            {
                // Nothing to forfeit; drop the match once nobody is left holding a seat.
                if (!match.First.Connected && !match.Second.Connected) Forget(match);
                return match.Snapshot();
            }

            // The move clock stands still while a seat is inside its reconnect grace window; it
            // resumes with what was left once every seat is back (see Rejoin).
            if (match.DeadlineUtc is { } deadline)
            {
                match.PausedRemaining = TimeSpan.FromTicks(Math.Max((deadline - DateTimeOffset.UtcNow).Ticks, TimeSpan.FromSeconds(1).Ticks));
                match.ClockEpoch++;
                match.DeadlineUtc = null;
            }
            _ = ForfeitAfterGraceAsync(match, seat, seat.DisconnectEpoch);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Re-bind a seat to a fresh connection after a reconnect. Null when the token is
    /// unknown (the match was forfeited or the host restarted), in which case the client
    /// should go back to the lobby.
    /// </summary>
    public TurnMatchRejoinResult? Rejoin(string connectionId, string seatToken)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(seatToken) || !_byToken.TryGetValue(seatToken, out var match)) return null;
            var seat = match.First.Token == seatToken ? match.First : match.Second;
            if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
            seat.ConnectionId = connectionId;
            seat.Connected = true;
            seat.DisconnectEpoch++; // invalidates any pending forfeit timer
            _byConnection[connectionId] = match;
            if (match.Status == TurnMatchStatus.InProgress && match.PausedRemaining is { } left
                && match.First.Connected && match.Second.Connected)
            {
                match.PausedRemaining = null;
                StartClock(match, left);
            }
            return new TurnMatchRejoinResult(match.StartFor(seat), match.Snapshot());
        }
    }

    // ── Internals ───────────────────────────────────────────────────────

    private async Task ForfeitAfterGraceAsync(Match match, Seat seat, int epoch)
    {
        try
        {
            await Task.Delay(DisconnectGrace);
            TurnMatchState? state = null;
            lock (_lock)
            {
                // The seat came back (epoch moved) or the game already ended some other way.
                if (seat.DisconnectEpoch != epoch || seat.Connected) return;
                if (match.Status == TurnMatchStatus.InProgress)
                {
                    match.Finish(WinnerAgainst(seat.Side), TurnMatchEndReason.Disconnect, []);
                    OnFinished(match);
                    state = match.Snapshot();
                }
                Unseat(match, seat);
            }
            if (state is not null)
            {
                _log.LogInformation("{Game}: match {MatchId} forfeited by disconnect ({Side})", _gameName, match.MatchId, seat.Side);
                await _hub.Clients.Group(GroupFor(match.MatchId)).SendAsync("state", state);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "{Game}: disconnect-forfeit broadcast failed for match {MatchId}", _gameName, match.MatchId);
        }
    }

    private void Unseat(Match match, Seat seat)
    {
        if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
        _byToken.Remove(seat.Token);
        seat.ConnectionId = "";
        seat.Connected = false;
        seat.DisconnectEpoch++;
        var other = seat == match.First ? match.Second : match.First;
        if (!other.Connected) Forget(match);
    }

    private void Forget(Match match)
    {
        _byToken.Remove(match.First.Token);
        _byToken.Remove(match.Second.Token);
        if (!string.IsNullOrEmpty(match.First.ConnectionId)) _byConnection.Remove(match.First.ConnectionId);
        if (!string.IsNullOrEmpty(match.Second.ConnectionId)) _byConnection.Remove(match.Second.ConnectionId);
    }

    private Match RequireMatch(string connectionId) =>
        _byConnection.TryGetValue(connectionId, out var match)
            ? match
            : throw new InvalidOperationException("You are not in a match.");

    private static TurnMatchSide Other(TurnMatchSide s) =>
        s == TurnMatchSide.First ? TurnMatchSide.Second : TurnMatchSide.First;

    private static TurnMatchStatus WinnerAgainst(TurnMatchSide loser) =>
        loser == TurnMatchSide.First ? TurnMatchStatus.SecondWon : TurnMatchStatus.FirstWon;

    /// <summary>
    /// What the hub needs to announce a game start: each seat's connection id with its
    /// private start record, plus the shared board. Connection ids are exposed here and
    /// nowhere else, because the hub has to address the private records individually.
    /// </summary>
    public sealed record Pairing(
        string MatchId,
        IReadOnlyList<(string ConnectionId, TurnMatchStart Start)> Connections,
        TurnMatchState State);

    private sealed record Waiting(string ConnectionId, string PrincipalId, string DisplayName, bool IsGuest, bool AsHost);

    private sealed class Reservation(DateTimeOffset createdUtc)
    {
        public DateTimeOffset CreatedUtc { get; } = createdUtc;
        public Waiting? Waiting { get; set; }
    }

    private sealed class Seat
    {
        public Seat(Waiting from, TurnMatchSide side)
        {
            ConnectionId = from.ConnectionId;
            PrincipalId = from.PrincipalId;
            DisplayName = from.DisplayName;
            IsGuest = from.IsGuest;
            Side = side;
            Token = Guid.NewGuid().ToString("N");
            Connected = true;
        }

        public string ConnectionId { get; set; }
        public string PrincipalId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public string Token { get; }
        public TurnMatchSide Side { get; set; }
        public bool Connected { get; set; }
        /// <summary>Bumped on every connect/disconnect so a stale grace timer can tell it lost the race.</summary>
        public int DisconnectEpoch { get; set; }

        public TurnMatchSeat Public() => new(DisplayName, IsGuest, Side, Connected);
    }

    private sealed class Match
    {
        public Match(GridGameRules rules, string matchId, Seat first, Seat second)
        {
            MatchId = matchId;
            First = first;
            Second = second;
            Cells = new byte[rules.CellCount];
        }

        public string MatchId { get; }
        public int GameNumber { get; } = 1;
        public Seat First { get; }
        public Seat Second { get; }
        public byte[] Cells { get; }
        public int MoveCount { get; set; }
        public TurnMatchSide Turn { get; set; } = TurnMatchSide.First;
        public TurnMatchStatus Status { get; private set; } = TurnMatchStatus.InProgress;
        public TurnMatchEndReason EndReason { get; private set; } = TurnMatchEndReason.None;
        public TurnMatchMove? LastMove { get; set; }
        public int[] WinCells { get; private set; } = [];
        /// <summary>When the seat to move runs out of time; null when there is no clock or it is paused.</summary>
        public DateTimeOffset? DeadlineUtc { get; set; }
        /// <summary>Time left on the clock when it was paused for a disconnected seat.</summary>
        public TimeSpan? PausedRemaining { get; set; }
        /// <summary>Bumped whenever the clock restarts or stops, so a stale timer can tell it lost.</summary>
        public int ClockEpoch { get; set; }
        public bool ResultRecorded { get; set; }
        public TurnMatchRatings? Ratings { get; set; }

        public Seat SeatFor(string connectionId) =>
            First.ConnectionId == connectionId ? First
            : Second.ConnectionId == connectionId ? Second
            : throw new InvalidOperationException("You are not seated in this match.");

        public void Finish(TurnMatchStatus status, TurnMatchEndReason reason, int[] winCells)
        {
            Status = status;
            EndReason = reason;
            WinCells = winCells;
        }

        public TurnMatchStart StartFor(Seat seat) =>
            new(MatchId, GameNumber, seat.Token, seat.Side, First.Public(), Second.Public());

        public Pairing Pairing() =>
            new(MatchId, [(First.ConnectionId, StartFor(First)), (Second.ConnectionId, StartFor(Second))], Snapshot());

        public TurnMatchState Snapshot()
        {
            var now = DateTimeOffset.UtcNow;
            int? msLeft = DeadlineUtc is { } deadline && Status == TurnMatchStatus.InProgress
                ? (int)Math.Max(0, (deadline - now).TotalMilliseconds)
                : null;
            return new(MatchId, GameNumber, (byte[])Cells.Clone(), MoveCount, Turn, Status, EndReason, LastMove,
                (int[])WinCells.Clone(), First.Public(), Second.Public(), now, msLeft, Ratings);
        }
    }
}
