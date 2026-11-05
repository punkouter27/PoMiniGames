using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.PoMarbleRace.Services;

/// <summary>
/// Client-side wrapper around <c>/pomarblerace/hub</c>. Owned by the page for the life
/// of the online session. Host pages push frames and events through it; guest pages
/// receive them and push steering. Frames are fire-and-forget with a one-deep send
/// queue: a slow link drops frames rather than queueing a backlog the guest would then
/// replay late.
/// </summary>
public sealed class PoMarbleRaceOnlineClient : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _hub;
    private Task _frameInFlight = Task.CompletedTask;

    public PoMarbleRaceOnlineClient(ApiEndpoints endpoints) => _endpoints = endpoints;

    public event Action<MarbleRaceStart>? RaceStarted;
    public event Action<MarbleRaceFrame>? FrameReceived;
    public event Action<MarbleRacePhase>? PhaseReceived;
    public event Action<MarbleRacePodium>? PodiumReceived;
    public event Action<MarbleRaceResult>? ResultReceived;
    public event Action<int>? GuestSteerReceived;
    public event Action<MarbleRaceRematch>? RematchChanged;
    public event Action? PeerLeft;
    public event Action<HubConnectionState>? ConnectionChanged;

    public HubConnectionState State => _hub?.State ?? HubConnectionState.Disconnected;

    public async Task ConnectAsync()
    {
        if (_hub is not null) return;
        _hub = HubConnectionFactory.Create(_endpoints.Hub("pomarblerace/hub"));
        _hub.On<MarbleRaceStart>("raceStarted", s => RaceStarted?.Invoke(s));
        _hub.On<MarbleRaceFrame>("frame", f => FrameReceived?.Invoke(f));
        _hub.On<MarbleRacePhase>("phase", p => PhaseReceived?.Invoke(p));
        _hub.On<MarbleRacePodium>("podium", p => PodiumReceived?.Invoke(p));
        _hub.On<MarbleRaceResult>("result", r => ResultReceived?.Invoke(r));
        _hub.On<int>("guestSteer", d => GuestSteerReceived?.Invoke(d));
        _hub.On<MarbleRaceRematch>("rematch", r => RematchChanged?.Invoke(r));
        _hub.On("peerLeft", () => PeerLeft?.Invoke());
        _hub.Reconnecting += _ => { ConnectionChanged?.Invoke(HubConnectionState.Reconnecting); return Task.CompletedTask; };
        // A reconnect gets a new connection id the server has already forgotten, and the
        // peer has already been told we left — the race cannot resume. Surface it as gone.
        _hub.Reconnected += _ => { PeerLeft?.Invoke(); return Task.CompletedTask; };
        _hub.Closed += _ => { ConnectionChanged?.Invoke(HubConnectionState.Disconnected); return Task.CompletedTask; };
        await _hub.StartAsync();
        ConnectionChanged?.Invoke(_hub.State);
    }

    public Task<MarbleRaceQueueStatus> FindRaceAsync(string displayName, bool isGuest, int mapId) =>
        Require().InvokeAsync<MarbleRaceQueueStatus>("FindRace", displayName, isGuest, mapId);

    public Task CancelSearchAsync() => Require().InvokeAsync("CancelSearch");

    /// <summary>Open a private race; returns its code, or null when already queued or seated.</summary>
    public Task<MarbleRaceRoom?> CreateRoomAsync(string displayName, bool isGuest, int mapId) =>
        Require().InvokeAsync<MarbleRaceRoom?>("CreateRoom", displayName, isGuest, mapId);

    /// <summary>Join a friend's private race by code.</summary>
    public Task<MarbleRaceJoin> JoinRoomAsync(string code, string displayName, bool isGuest) =>
        Require().InvokeAsync<MarbleRaceJoin>("JoinRoom", code, displayName, isGuest);

    /// <summary>Ask for another race against the same opponent (answered on <see cref="RematchChanged"/>).</summary>
    public async Task RequestRematchAsync()
    {
        var hub = _hub;
        if (hub is null || hub.State != HubConnectionState.Connected) return;
        try { await hub.SendAsync("RequestRematch"); } catch { /* the peer-left path reports a dead link */ }
    }

    /// <summary>Host: push a frame unless the previous one is still on the wire.</summary>
    public void SendFrame(MarbleRaceFrame frame)
    {
        if (_hub is null || _hub.State != HubConnectionState.Connected) return;
        if (!_frameInFlight.IsCompleted) return;
        _frameInFlight = SendQuietlyAsync("HostFrame", frame);
    }

    public Task SendPhaseAsync(MarbleRacePhase phase) => SendQuietlyAsync("HostPhase", phase);
    public Task SendPodiumAsync(MarbleRacePodium podium) => SendQuietlyAsync("HostPodium", podium);
    public Task SendResultAsync(MarbleRaceResult result) => SendQuietlyAsync("HostResult", result);

    /// <summary>Guest: steering direction, -1/0/+1.</summary>
    public Task SteerAsync(int dir) => SendQuietlyAsync("Steer", dir);

    public async Task LeaveAsync()
    {
        if (_hub is null || _hub.State != HubConnectionState.Connected) return;
        try { await _hub.InvokeAsync("Leave"); } catch { /* leaving anyway */ }
    }

    private async Task SendQuietlyAsync(string method, object arg)
    {
        var hub = _hub;
        if (hub is null || hub.State != HubConnectionState.Connected) return;
        try { await hub.SendAsync(method, arg); } catch { /* the peer-left path reports a dead link */ }
    }

    private HubConnection Require() =>
        _hub ?? throw new InvalidOperationException("ConnectAsync has not been called.");

    public async ValueTask DisposeAsync()
    {
        var hub = _hub;
        _hub = null;
        if (hub is null) return;
        try { await hub.DisposeAsync(); } catch { /* page is going away */ }
    }
}
