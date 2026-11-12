using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// Owns the two PoCabinet hub connections for the app's lifetime (scoped = one per tab in
/// WASM), so the lobby survives the hop into a race and back for a rematch.
/// <list type="number">
///   <item><b>Lobby hub</b> (<c>/pocabinet/lobby-hub</c>): join the one lobby (first in
///         hosts), receive <c>LobbyState</c> after every change, host controls (track, AI
///         officials, kick), and <c>RaceStarting(raceCode, trackId)</c>. A reconnect rejoins —
///         seats are keyed by claim identity server-side, so it is the same seat.
///         <c>Kicked(reason)</c> means the seat is gone; <c>LobbyNotice(text)</c> is a line
///         for everyone.</item>
///   <item><b>Race hub</b> (<c>/pocabinet/race-hub</c>): <see cref="JoinRaceAsync"/> returns
///         the static world and this client's car id (null = spectating); then one numbered
///         input per 30 Hz tick goes up and a <c>RaceSnapshot</c> per tick comes down, ending
///         with a typed <c>RaceFinished</c> result (or <c>RaceAborted</c>).
///         <see cref="LeaveRaceAsync"/> tells the server this player is out.</item>
/// </list>
/// <para>
/// Every race has its own code, and snapshots, results and aborts for any other code are
/// dropped here, so a results screen left open is not fed the next race.
/// </para>
/// <para>
/// When a connection is lost for good (automatic reconnect gave up), or a reconnect finds the
/// race already over, <see cref="RaceLost"/> / <see cref="LobbyLost"/> say so — the page must
/// never sit on "Reconnecting…" forever.
/// </para>
/// <para>
/// Inputs use <c>SendAsync</c> (fire-and-forget): at 30 per second, awaiting a round trip
/// for each one — as <c>InvokeAsync</c> does — queued them behind the network latency.
/// </para>
/// </summary>
public sealed class PoCabinetSession : IAsyncDisposable
{
    private readonly HubConnection _lobby;
    private readonly HubConnection _race;
    private readonly CancellationTokenSource _lifetime = new();
    private bool _inLobby;
    private string _displayName = "Player";
    private string? _trackId;
    private string? _color;
    private string? _gameCode;
    private bool _raceJoined;
    private int _lastSeq;
    private Task _pingLoop = Task.CompletedTask;

    public PoCabinetSession(ApiEndpoints endpoints)
    {
        _lobby = HubConnectionFactory.Create(endpoints.Hub("pocabinet/lobby-hub"));
        _race = HubConnectionFactory.Create(endpoints.Hub("pocabinet/race-hub"));

        _lobby.On<PoCabinetLobbyView>("LobbyState", async view =>
        {
            if (!_inLobby) return;
            Lobby = view;
            if (LobbyChanged is { } handler) await handler(view);
        });
        _lobby.On<string, string>("RaceStarting", async (code, trackId) =>
        {
            if (RaceStarting is { } handler) await handler(code, trackId);
        });
        _lobby.On<string>("Kicked", async reason =>
        {
            if (!_inLobby) return;
            _inLobby = false;
            Lobby = null;
            MySeatId = null;
            if (Kicked is { } handler) await handler(reason);
        });
        _lobby.On<string>("LobbyNotice", async text =>
        {
            if (_inLobby && LobbyNotice is { } handler) await handler(text);
        });
        _lobby.Reconnected += async _ =>
        {
            if (!_inLobby) return;
            try { await JoinLobbyAsync(_displayName, _trackId, _color); } catch { /* the view shows the stale state */ }
        };
        _lobby.Closed += async _ =>
        {
            if (_inLobby && LobbyLost is { } handler) await handler("Lost the connection to the lobby.");
        };

        _race.On<PoCabinetRaceSnapshot>("RaceSnapshot", async snapshot =>
        {
            if (!IsCurrent(snapshot.GameCode)) return;
            if (SnapshotReceived is { } handler) await handler(snapshot);
        });
        _race.On<PoCabinetFinalResult>("RaceFinished", async result =>
        {
            if (!IsCurrent(result.GameCode)) return;
            if (RaceFinished is { } handler) await handler(result);
        });
        _race.On<string>("RaceAborted", async code =>
        {
            if (!IsCurrent(code)) return;
            _raceJoined = false;
            await RaiseRaceLostAsync(new PoCabinetRaceLoss(
                "The race server hit a problem and called the race off. The lobby is open for a rematch.", RaceOver: true, MaySubmit: false));
        });
        _race.Reconnecting += async _ =>
        {
            if (_raceJoined && StatusChanged is { } handler) await handler("Reconnecting…");
        };
        _race.Reconnected += async _ =>
        {
            if (_gameCode is not { } code) return;
            PoCabinetRaceSnapshot? rejoined;
            try
            {
                rejoined = await _race.InvokeAsync<PoCabinetRaceSnapshot?>("JoinRace", code);
            }
            catch
            {
                _raceJoined = false;
                await RaiseRaceLostAsync(new PoCabinetRaceLoss("Could not rejoin the race.", RaceOver: false, MaySubmit: false));
                return;
            }
            if (rejoined is null)
            {
                // The race ended while we were away and its one RaceFinished went unheard.
                _raceJoined = false;
                await RaiseRaceLostAsync(new PoCabinetRaceLoss(
                    "The race finished while you were reconnecting.", RaceOver: true, MaySubmit: true));
                return;
            }
            if (StatusChanged is { } handler) await handler(null);
        };
        _race.Closed += async _ =>
        {
            if (!_raceJoined) return;
            _raceJoined = false;
            await RaiseRaceLostAsync(new PoCabinetRaceLoss("Lost the connection to the race server.", RaceOver: false, MaySubmit: false));
        };
    }

    /// <summary>The lobby this client sits in (latest broadcast), or null.</summary>
    public PoCabinetLobbyView? Lobby { get; private set; }

    /// <summary>This client's seat in <see cref="Lobby"/>.</summary>
    public string? MySeatId { get; private set; }

    public event Func<PoCabinetLobbyView, Task>? LobbyChanged;
    public event Func<string, string, Task>? RaceStarting;
    /// <summary>This player's seat was freed (the host kicked it, or the ready timeout); the text says why.</summary>
    public event Func<string, Task>? Kicked;
    /// <summary>A line for everyone in the lobby (e.g. who lost a seat to the ready timeout).</summary>
    public event Func<string, Task>? LobbyNotice;
    /// <summary>The lobby connection is gone for good; joining again restarts it.</summary>
    public event Func<string, Task>? LobbyLost;
    public event Func<PoCabinetRaceSnapshot, Task>? SnapshotReceived;
    public event Func<PoCabinetFinalResult, Task>? RaceFinished;
    /// <summary>Non-null message while the race connection is unhealthy, null when restored.</summary>
    public event Func<string?, Task>? StatusChanged;
    /// <summary>This client is out of the current race for good: the connection closed, or the race is over or called off.</summary>
    public event Func<PoCabinetRaceLoss, Task>? RaceLost;
    public event Func<double, Task>? PingMeasured;

    /// <summary>
    /// Join (or rejoin) the lobby; the first arrival hosts on <paramref name="trackId"/>. When
    /// no seat is free (race running, or eight seated) the view comes back with a null
    /// <see cref="MySeatId"/> and broadcasts keep arriving, so the caller can retry.
    /// </summary>
    public async Task<PoCabinetLobbyView?> JoinLobbyAsync(string displayName, string? trackId, string? color, CancellationToken ct = default)
    {
        await EnsureAsync(_lobby, ct);
        var view = await _lobby.InvokeAsync<PoCabinetLobbyView?>("Join", displayName, trackId, color, ct);
        _inLobby = true;
        _displayName = displayName;
        _trackId = trackId;
        _color = color;
        Lobby = view;
        MySeatId = view?.YourSeatId;
        return view;
    }

    public Task<bool> ToggleReadyAsync() => LobbyCallAsync("ToggleReady");

    public Task<bool> SetTrackAsync(string trackId) => LobbyCallAsync("SetTrack", trackId);

    public Task<bool> SetBotsAsync(int count) => LobbyCallAsync("SetBots", count);

    public Task<bool> TryStartAsync() => LobbyCallAsync("TryStart");

    /// <summary>Host-only, between races: free another player's seat.</summary>
    public Task<bool> KickAsync(string seatId) => LobbyCallAsync("Kick", seatId);

    public async Task LeaveLobbyAsync()
    {
        var wasIn = _inLobby;
        _inLobby = false;
        Lobby = null;
        MySeatId = null;
        if (!wasIn || _lobby.State != HubConnectionState.Connected) return;
        try { await _lobby.InvokeAsync("Leave"); } catch { /* best effort */ }
    }

    /// <summary>
    /// Join a running race. The reply carries the static world and, for a seated player,
    /// <c>LocalCarId</c> — null means this client spectates. Throws when the race is already over.
    /// </summary>
    public async Task<PoCabinetRaceSnapshot> JoinRaceAsync(string gameCode, CancellationToken ct = default)
    {
        _gameCode = gameCode;
        _lastSeq = 0;
        await EnsureAsync(_race, ct);
        var snapshot = await _race.InvokeAsync<PoCabinetRaceSnapshot?>("JoinRace", gameCode, ct)
            ?? throw new InvalidOperationException("That race is over. Head back to the lobby for a rematch.");
        _raceJoined = true;
        return snapshot;
    }

    /// <summary>
    /// Out of the current race: stop sending, ignore its traffic, and tell the server (best
    /// effort) so a seated car is forfeited and this connection leaves the race group. The
    /// connection itself stays up for the next race.
    /// </summary>
    public async Task LeaveRaceAsync()
    {
        var wasJoined = _gameCode is not null;
        _raceJoined = false;
        _gameCode = null;
        if (!wasJoined || _race.State != HubConnectionState.Connected) return;
        try { await _race.SendAsync("LeaveRace"); } catch { /* the server unbinds on disconnect anyway */ }
    }

    /// <summary>One tick of input, fire-and-forget. Dropped while not joined or reconnecting.</summary>
    public Task SendInputAsync(PoCabinetInput input)
    {
        if (!_raceJoined || _gameCode is null || _race.State != HubConnectionState.Connected) return Task.CompletedTask;
        _lastSeq = Math.Max(_lastSeq, input.Seq);
        return _race.SendAsync("SubmitInput", input);
    }

    /// <summary>
    /// The tab went hidden: one hands-off input, so the car coasts at once instead of holding
    /// the last input until the server's half-second stale cut-off. Reuses the last sequence
    /// number so the client's prediction history is not acknowledged past what it sent.
    /// </summary>
    public Task SendNeutralInputAsync() =>
        SendInputAsync(new PoCabinetInput { Seq = _lastSeq, Throttle = 0, Brake = 0, Steer = 0 });

    /// <summary>Begin the 3-second latency probe (idempotent) feeding the HUD ping badge.</summary>
    public void StartPingLoop()
    {
        if (_pingLoop.IsCompleted) _pingLoop = PingLoopAsync(_lifetime.Token);
    }

    private bool IsCurrent(string? code) =>
        _gameCode is not null && string.Equals(code, _gameCode, StringComparison.OrdinalIgnoreCase);

    private async Task RaiseRaceLostAsync(PoCabinetRaceLoss loss)
    {
        if (RaceLost is { } handler) await handler(loss);
    }

    private async Task PingLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(3000, ct);
                if (_raceJoined && _race.State == HubConnectionState.Connected)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await _race.InvokeAsync<long>("Ping", ct);
                    sw.Stop();
                    if (PingMeasured is { } handler) await handler(sw.Elapsed.TotalMilliseconds);
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // A failed probe is what a bad connection looks like; StatusChanged covers it.
            }
        }
    }

    private async Task<bool> LobbyCallAsync(string method, params object?[] args)
    {
        if (!_inLobby) return false;
        await EnsureAsync(_lobby, default);
        return await _lobby.InvokeCoreAsync<bool>(method, args);
    }

    private static async Task EnsureAsync(HubConnection hub, CancellationToken ct)
    {
        if (hub.State == HubConnectionState.Disconnected) await hub.StartAsync(ct);
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        try { await _lobby.DisposeAsync(); } catch { /* ignore */ }
        try { await _race.DisposeAsync(); } catch { /* ignore */ }
        _lifetime.Dispose();
    }
}

/// <summary>
/// Why this client is out of its race. <paramref name="RaceOver"/>: the race itself ended (or
/// was called off), so the race view should close; otherwise only this connection is gone and
/// the player chooses where to go. <paramref name="MaySubmit"/>: the server may hold a verified
/// lap for this player (the race finished), so the score is still worth submitting.
/// </summary>
public sealed record PoCabinetRaceLoss(string Message, bool RaceOver, bool MaySubmit);
