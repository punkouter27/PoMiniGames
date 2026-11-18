using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// Owns the PoCabinet race hub connection for the app's lifetime (scoped = one per tab in
/// WASM). The lobby is not here: <c>PoCabinetLobby</c> runs on the shared <c>OnlineLobby</c>, and
/// its <c>gameStarted(code)</c> is what leads to <see cref="JoinRaceAsync"/>.
/// <b>Race hub</b> (<c>/pocabinet/race-hub</c>): <see cref="JoinRaceAsync"/> returns the static
/// world and this client's car id (null = spectating); then one numbered input per 30 Hz tick
/// goes up and a <c>RaceSnapshot</c> per tick comes down, ending with a typed
/// <c>RaceFinished</c> result (or <c>RaceAborted</c>). <see cref="LeaveRaceAsync"/> tells the
/// server this player is out.
/// <para>
/// Every race has its own code, and snapshots, results and aborts for any other code are
/// dropped here, so a results screen left open is not fed the next race.
/// </para>
/// <para>
/// When the connection is lost for good (automatic reconnect gave up), or a reconnect finds the
/// race already over, <see cref="RaceLost"/> says so — the page must never sit on
/// "Reconnecting…" forever.
/// </para>
/// <para>
/// Inputs use <c>SendAsync</c> (fire-and-forget): at 30 per second, awaiting a round trip
/// for each one — as <c>InvokeAsync</c> does — queued them behind the network latency.
/// </para>
/// </summary>
public sealed class PoCabinetSession : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private readonly PlayerNameService _playerNameService;
    private HubConnection? _race;
    private readonly CancellationTokenSource _lifetime = new();
    private string? _gameCode;
    private bool _raceJoined;
    private int _lastSeq;
    private Task _pingLoop = Task.CompletedTask;

    public PoCabinetSession(ApiEndpoints endpoints, PlayerNameService playerNameService)
    {
        _endpoints = endpoints;
        _playerNameService = playerNameService;
    }

    private HubConnection GetOrCreateRace()
    {
        if (_race is not null) return _race;
        var race = HubConnectionFactory.Create(_endpoints.Hub("pocabinet/race-hub"));
        race.On<PoCabinetRaceSnapshot>("RaceSnapshot", async snapshot =>
        {
            if (!IsCurrent(snapshot.GameCode)) return;
            if (SnapshotReceived is { } handler) await handler(snapshot);
        });
        race.On<PoCabinetFinalResult>("RaceFinished", async result =>
        {
            if (!IsCurrent(result.GameCode)) return;
            if (RaceFinished is { } handler) await handler(result);
        });
        race.On<string>("RaceAborted", async code =>
        {
            if (!IsCurrent(code)) return;
            _raceJoined = false;
            await RaiseRaceLostAsync(new PoCabinetRaceLoss(
                "The race server hit a problem and called the race off. The lobby is open for a rematch.", RaceOver: true, MaySubmit: false));
        });
        race.Reconnecting += async _ =>
        {
            if (_raceJoined && StatusChanged is { } handler) await handler("Reconnecting…");
        };
        race.Reconnected += async _ =>
        {
            if (_gameCode is not { } code) return;
            PoCabinetRaceSnapshot? rejoined;
            try
            {
                rejoined = await race.InvokeAsync<PoCabinetRaceSnapshot?>("JoinRace", code);
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
        race.Closed += async _ =>
        {
            if (!_raceJoined) return;
            _raceJoined = false;
            await RaiseRaceLostAsync(new PoCabinetRaceLoss("Lost the connection to the race server.", RaceOver: false, MaySubmit: false));
        };
        _race = race;
        return race;
    }

    public event Func<PoCabinetRaceSnapshot, Task>? SnapshotReceived;
    public event Func<PoCabinetFinalResult, Task>? RaceFinished;
    /// <summary>Non-null message while the race connection is unhealthy, null when restored.</summary>
    public event Func<string?, Task>? StatusChanged;
    /// <summary>This client is out of the current race for good: the connection closed, or the race is over or called off.</summary>
    public event Func<PoCabinetRaceLoss, Task>? RaceLost;
    public event Func<double, Task>? PingMeasured;
    /// <summary>
    /// Join a running race. The reply carries the static world and, for a seated player,
    /// <c>LocalCarId</c> — null means this client spectates. Throws when the race is already over.
    /// </summary>
    public async Task<PoCabinetRaceSnapshot> JoinRaceAsync(string gameCode, CancellationToken ct = default)
    {
        _gameCode = gameCode;
        _lastSeq = 0;
        await _playerNameService.InitializeAsync();
        var race = GetOrCreateRace();
        await EnsureAsync(race, ct);
        var snapshot = await race.InvokeAsync<PoCabinetRaceSnapshot?>("JoinRace", gameCode, ct)
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
        if (!wasJoined || _race is null || _race.State != HubConnectionState.Connected) return;
        try { await _race.SendAsync("LeaveRace"); } catch { /* the server unbinds on disconnect anyway */ }
    }

    /// <summary>One tick of input, fire-and-forget. Dropped while not joined or reconnecting.</summary>
    public Task SendInputAsync(PoCabinetInput input)
    {
        if (!_raceJoined || _gameCode is null || _race is null || _race.State != HubConnectionState.Connected) return Task.CompletedTask;
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
                if (_raceJoined && _race is { State: HubConnectionState.Connected } race)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await race.InvokeAsync<long>("Ping", ct);
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

    private static async Task EnsureAsync(HubConnection hub, CancellationToken ct)
    {
        if (hub.State == HubConnectionState.Disconnected) await hub.StartAsync(ct);
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        if (_race is not null) { try { await _race.DisposeAsync(); } catch { /* ignore */ } }
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
