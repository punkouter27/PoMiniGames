using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>Where an online session is, from the player's point of view. <c>QuickMatchPanel</c> draws the non-lobby states; the lobby is drawn by <c>TurnLobbyPanel</c> (the shared <c>OnlineLobby</c>).</summary>
public enum QuickMatchPhase
{
    Idle,
    Connecting,
    Searching,
    /// <summary>In the shared lobby: roster, Ready, Start.</summary>
    Lobby,
    Playing,
    Over,
    Error,
}

/// <summary>
/// The client-side state machine for an online turn game (Connect Five, Tic-Tac-Toe):
/// meet in the shared lobby (host, ready, start), join the reserved match by its internal code,
/// relay moves, read the server's snapshots, record the result. The page keeps only what is board-specific — how a move
/// is drawn and sounded — through the three events below.
/// </summary>
public sealed class OnlineTurnSession : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private readonly ToastService _toasts;
    private readonly MatchHistoryService _history;
    private readonly string _hubPath;
    private readonly string _gameKey;
    private readonly string _localName;
    private TurnMatchClient? _client;
    private CancellationTokenSource? _joinWatch;
    private bool _matchRecorded;

    /// <param name="hubPath">The match hub, e.g. <c>connectfive/hub</c>; the lobby hub is <c>connectfive/lobby-hub</c>.</param>
    /// <param name="gameKey">Match-history key, e.g. <c>connectfive</c>.</param>
    /// <param name="localName">Fallback display name sent with the lobby join.</param>
    public OnlineTurnSession(
        ApiEndpoints endpoints, ToastService toasts, MatchHistoryService history,
        string hubPath, string gameKey, string localName)
    {
        _endpoints = endpoints;
        _toasts = toasts;
        _history = history;
        _hubPath = hubPath;
        _gameKey = gameKey;
        _localName = localName;
    }

    /// <summary>Anything below changed; re-render.</summary>
    public event Action? Changed;
    /// <summary>A new game began (the pairing completed): clear the board.</summary>
    public event Action<TurnMatchStart>? GameStarted;
    /// <summary>The board is exactly one move behind the server: draw (and sound) this move.</summary>
    public event Action<TurnMatchMove>? MoveApplied;
    /// <summary>The board is further behind (rejoin, missed broadcast): rebuild silently from these cells.</summary>
    public event Action<byte[]>? BoardRebuilt;
    /// <summary>The game ended. Win cells are flat indices into the grid; empty for a draw or forfeit.</summary>
    public event Action<GameResult, int[]>? GameEnded;

    /// <summary>The game's lobby hub, relative to the API base (what <c>OnlineLobby</c> connects to).</summary>
    public string LobbyHubPath => _hubPath[.._hubPath.LastIndexOf('/')] + "/lobby-hub";
    public QuickMatchPhase Phase { get; private set; } = QuickMatchPhase.Idle;
    public TurnMatchStart? Seat { get; private set; }
    public TurnMatchSide MySide { get; private set; } = TurnMatchSide.First;
    public int GameNumber { get; private set; }
    public int MoveCount { get; private set; }
    public TurnMatchSide Turn { get; private set; } = TurnMatchSide.First;
    public TurnMatchEndReason EndReason { get; private set; }
    public GameResult Result { get; private set; } = GameResult.InProgress;
    public string OpponentName { get; private set; } = "Opponent";
    public bool OpponentConnected { get; private set; } = true;
    public bool OpponentGone { get; private set; }
    public bool AwaitingServer { get; private set; }
    public bool Reconnecting { get; private set; }

    public bool IsMyTurn =>
        Phase == QuickMatchPhase.Playing && Result == GameResult.InProgress
        && Turn == MySide && !AwaitingServer && !Reconnecting;

    /// <summary>Display name for a side, marked "(you)" for the local seat; the fallbacks show before pairing.</summary>
    public string SeatName(TurnMatchSide side, string firstFallback, string secondFallback)
    {
        if (Seat is null) return side == TurnMatchSide.First ? firstFallback : secondFallback;
        var seat = side == TurnMatchSide.First ? Seat.First : Seat.Second;
        return side == MySide ? $"{seat.DisplayName} (you)" : seat.DisplayName;
    }

    /// <summary>One status line for the visible turn bar and the screen-reader announcement.</summary>
    public string StatusText => Phase switch
    {
        QuickMatchPhase.Idle or QuickMatchPhase.Connecting => "Connecting…",
        QuickMatchPhase.Searching or QuickMatchPhase.Lobby => "Waiting in the lobby…",
        QuickMatchPhase.Error => "Connection lost",
        _ when Result == GameResult.Win => EndReason switch
        {
            TurnMatchEndReason.Forfeit => $"{OpponentName} left — you win",
            TurnMatchEndReason.Disconnect => $"{OpponentName} disconnected — you win",
            _ => "You win!",
        },
        _ when Result == GameResult.Loss => $"{OpponentName} wins",
        _ when Result == GameResult.Draw => "Draw",
        _ when Reconnecting => "Reconnecting…",
        _ when !OpponentConnected => $"{OpponentName} is reconnecting…",
        _ when AwaitingServer => "Sending…",
        _ when Turn == MySide => "Your turn",
        _ => $"{OpponentName}'s turn",
    };

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// <summary>Enter the lobby phase: the page renders the shared <c>OnlineLobby</c> and joins the match from its start callback.</summary>
    public Task StartAsync()
    {
        Reconnecting = false;
        Phase = QuickMatchPhase.Lobby;
        Changed?.Invoke();
        return Task.CompletedTask;
    }

    public async Task RetryAsync()
    {
        await TearDownAsync();
        await StartAsync();
    }

    /// <summary>The lobby's host started: claim a seat in the reserved match by its internal code. The host moves first.</summary>
    public async Task JoinMatchAsync(string code, bool asHost)
    {
        if (Phase != QuickMatchPhase.Lobby) return;
        Phase = QuickMatchPhase.Connecting;
        Changed?.Invoke();
        try
        {
            if (_client is null)
            {
                _client = new TurnMatchClient(_endpoints, _hubPath);
                _client.MatchStarted += OnMatchStarted;
                _client.StateChanged += OnState;
                _client.ConnectionChanged += OnConnection;
                _client.SeatLost += OnSeatLost;
            }
            await _client.ConnectAsync();
            // matchStarted may fire before this returns (the second claimant completes the
            // pairing inside the call), so the phase is only ever advanced by the event.
            await _client.JoinMatchAsync(code, _localName, isGuest: false, asHost);
            // The other player was seated by the lobby but never claimed their seat: say so and
            // go back to the lobby instead of waiting on a card that never changes.
            _joinWatch?.Cancel();
            _joinWatch = new CancellationTokenSource();
            _ = MatchJoinGuard.WatchAsync(() => Phase == QuickMatchPhase.Connecting && Seat is null, async () =>
            {
                _toasts.Show("The other player didn't join. Back to the lobby.", ToastType.Warning);
                await ReturnToLobbySafeAsync();
                Changed?.Invoke();
            }, _joinWatch.Token);
        }
        catch (Exception)
        {
            Phase = QuickMatchPhase.Error;
            _toasts.Show("Couldn't start the game.", ToastType.Error);
            Changed?.Invoke();
        }
    }

    /// <summary>Give up the finished seat and go back to the lobby for another opponent.</summary>
    public async Task ReturnToLobbyAsync()
    {
        await DropMatchAsync();
        Seat = null;
        OpponentGone = false;
        OpponentConnected = true;
        EndReason = TurnMatchEndReason.None;
        Result = GameResult.InProgress;
        _matchRecorded = false;
        await StartAsync();
    }

    public async Task ReturnToLobbySafeAsync()
    {
        try { await ReturnToLobbyAsync(); }
        catch (Exception)
        {
            Phase = QuickMatchPhase.Error;
            Changed?.Invoke();
        }
    }

    private async Task DropMatchAsync()
    {
        var client = _client;
        if (client is null) return;
        _client = null;
        client.MatchStarted -= OnMatchStarted;
        client.StateChanged -= OnState;
        client.ConnectionChanged -= OnConnection;
        client.SeatLost -= OnSeatLost;
        await client.LeaveAsync();
        await client.DisposeAsync();
    }

    /// <summary>Place a mark. Gravity games pass any row; the server resolves it.</summary>
    public async Task PlaceAsync(int row, int col)
    {
        if (_client is null || !IsMyTurn) return;
        AwaitingServer = true;
        Changed?.Invoke();
        try
        {
            await _client.PlaceAsync(row, col);
        }
        catch (HubException ex)
        {
            _toasts.Show(ex.Message, ToastType.Warning);
        }
        catch (Exception)
        {
            _toasts.Show("That move didn't reach the server — try again.", ToastType.Warning);
        }
        finally
        {
            AwaitingServer = false;
            Changed?.Invoke();
        }
    }

    public async Task TearDownAsync()
    {
        _joinWatch?.Cancel();
        await DropMatchAsync();
    }

    public ValueTask DisposeAsync() => new(TearDownAsync());

    // ── Server events ─────────────────────────────────────────────────────

    private void OnMatchStarted(TurnMatchStart start)
    {
        Seat = start;
        MySide = start.YourSide;
        GameNumber = start.GameNumber;
        OpponentName = (start.YourSide == TurnMatchSide.First ? start.Second : start.First).DisplayName;
        Phase = QuickMatchPhase.Playing;
        OpponentGone = false;
        OpponentConnected = true;
        EndReason = TurnMatchEndReason.None;
        Result = GameResult.InProgress;
        MoveCount = 0;
        Turn = TurnMatchSide.First;
        AwaitingServer = false;
        _matchRecorded = false;
        GameStarted?.Invoke(start);
        Changed?.Invoke();
    }

    private void OnState(TurnMatchState state)
    {
        if (Seat is null || state.MatchId != Seat.MatchId) return;
        var opponent = state.OpponentOf(MySide);
        OpponentName = opponent.DisplayName;
        OpponentConnected = opponent.Connected;

        var sameGame = state.GameNumber == GameNumber;
        if (sameGame && state.MoveCount == MoveCount + 1 && state.LastMove is { } move)
        {
            MoveApplied?.Invoke(move);
        }
        else if (!sameGame || state.MoveCount != MoveCount)
        {
            GameNumber = state.GameNumber;
            Result = GameResult.InProgress;
            BoardRebuilt?.Invoke(state.Cells);
        }
        MoveCount = state.MoveCount;
        Turn = state.Turn;
        EndReason = state.EndReason;

        if (state.Status != TurnMatchStatus.InProgress && Result == GameResult.InProgress)
        {
            Result = state.Status switch
            {
                TurnMatchStatus.Draw => GameResult.Draw,
                TurnMatchStatus.FirstWon => MySide == TurnMatchSide.First ? GameResult.Win : GameResult.Loss,
                _ => MySide == TurnMatchSide.Second ? GameResult.Win : GameResult.Loss,
            };
            Phase = QuickMatchPhase.Over;
            RecordResult();
            GameEnded?.Invoke(Result, state.WinCells);
        }
        if (Phase == QuickMatchPhase.Over && !opponent.Connected) OpponentGone = true;
        Changed?.Invoke();
    }

    private void OnConnection(HubConnectionState state)
    {
        Reconnecting = state == HubConnectionState.Reconnecting;
        if (state == HubConnectionState.Disconnected && Phase is not (QuickMatchPhase.Idle or QuickMatchPhase.Error or QuickMatchPhase.Lobby))
        {
            Phase = QuickMatchPhase.Error;
        }
        Changed?.Invoke();
    }

    private void OnSeatLost()
    {
        _toasts.Show("Your seat expired while you were away — back to the lobby.", ToastType.Warning);
        Seat = null;
        _ = ReturnToLobbySafeAsync();
    }

    // Online results go to the head-to-head history as Multiplayer; they never touch the
    // adaptive vs-CPU rating, which is a measure of play against the AI only.
    private void RecordResult()
    {
        if (_matchRecorded) return;
        _matchRecorded = true;
        var outcome = Result switch
        {
            GameResult.Win => MatchOutcome.Win,
            GameResult.Loss => MatchOutcome.Loss,
            _ => MatchOutcome.Draw,
        };
        _ = _history.RecordAsync(_gameKey, MatchMode.Multiplayer, OpponentName, outcome);
    }
}
