using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Online Marble Race: quick-match pairing plus a one-to-one relay. The host browser
/// streams <see cref="MarbleRaceFrame"/>s and phase/podium/result events; the guest
/// browser streams steering. Nothing here inspects a payload beyond the sender's role —
/// a guest cannot publish frames and a host cannot steer the guest's marble.
/// </summary>
/// <remarks>
/// Client events: <c>raceStarted</c> (<see cref="MarbleRaceStart"/>), <c>frame</c>,
/// <c>phase</c>, <c>podium</c>, <c>result</c> (guest only), <c>guestSteer</c> (host only,
/// an <c>int</c> -1/0/+1), <c>rematch</c> (<see cref="MarbleRaceRematch"/>, both seats) and
/// <c>peerLeft</c> when the other seat is gone. A race seats two players at most: players meet
/// by quick-match or by a private code (<see cref="CreateRoom"/> / <see cref="JoinRoom"/>).
/// </remarks>
public sealed class PoMarbleRaceOnlineHub : Hub
{
    private readonly PoMarbleRaceOnlineService _races;
    private readonly ILogger<PoMarbleRaceOnlineHub> _log;

    public PoMarbleRaceOnlineHub(PoMarbleRaceOnlineService races, ILogger<PoMarbleRaceOnlineHub> log)
    {
        _races = races;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        await NotifyPeerGoneAsync();
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Queue for a race. <paramref name="mapId"/> only matters if the caller ends up host.</summary>
    public async Task<MarbleRaceQueueStatus> FindRace(string displayName, bool isGuest, int mapId)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var pairing = _races.Enqueue(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, mapId);
        if (pairing is null)
        {
            return new MarbleRaceQueueStatus(Matched: false, Waiting: _races.WaitingCount);
        }

        _log.LogInformation("PoMarbleRace online: race {RaceId} paired host={Host} guest={Guest}",
            pairing.RaceId, pairing.HostStart.Host.DisplayName, pairing.HostStart.Guest.DisplayName);
        await Clients.Client(pairing.HostConnectionId).SendAsync("raceStarted", pairing.HostStart);
        await Clients.Client(pairing.GuestConnectionId).SendAsync("raceStarted", pairing.GuestStart);
        return new MarbleRaceQueueStatus(Matched: true, Waiting: 0);
    }

    /// <summary>Open a private race and get the code a friend types in to join it. Null when already queued or seated.</summary>
    public MarbleRaceRoom? CreateRoom(string displayName, bool isGuest, int mapId)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var code = _races.CreateRoom(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, mapId);
        return code is null ? null : new MarbleRaceRoom(code);
    }

    /// <summary>Join a friend's private race by its code. The race starts at once (<c>raceStarted</c> to both).</summary>
    public async Task<MarbleRaceJoin> JoinRoom(string code, string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var (pairing, error) = _races.JoinRoom(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, code);
        if (pairing is null) return new MarbleRaceJoin(false, error);

        _log.LogInformation("PoMarbleRace online: private race {RaceId} joined host={Host} guest={Guest}",
            pairing.RaceId, pairing.HostStart.Host.DisplayName, pairing.HostStart.Guest.DisplayName);
        await Clients.Client(pairing.HostConnectionId).SendAsync("raceStarted", pairing.HostStart);
        await Clients.Client(pairing.GuestConnectionId).SendAsync("raceStarted", pairing.GuestStart);
        return new MarbleRaceJoin(true, null);
    }

    /// <summary>Ask for another race against the same opponent. Both seats hear every change.</summary>
    public async Task RequestRematch()
    {
        if (_races.RequestRematch(Context.ConnectionId) is not { } update) return;
        await Clients.Clients(update.HostConnectionId, update.GuestConnectionId).SendAsync("rematch", update.State);
    }

    public Task CancelSearch()
    {
        _races.Dequeue(Context.ConnectionId);
        return Task.CompletedTask;
    }

    public Task HostFrame(MarbleRaceFrame frame) => RelayFromHostAsync("frame", frame);

    public Task HostPhase(MarbleRacePhase phase) => RelayFromHostAsync("phase", phase);

    public Task HostPodium(MarbleRacePodium podium) => RelayFromHostAsync("podium", podium);

    public Task HostResult(MarbleRaceResult result) => RelayFromHostAsync("result", result);

    /// <summary>Guest steering: -1 left, 0 released, +1 right. Sent on change only.</summary>
    public async Task Steer(int dir)
    {
        if (_races.RoleOf(Context.ConnectionId) != MarbleRaceRole.Guest) return;
        var host = _races.PeerOf(Context.ConnectionId);
        if (host is null) return;
        await Clients.Client(host).SendAsync("guestSteer", Math.Clamp(dir, -1, 1));
    }

    public Task Leave() => NotifyPeerGoneAsync();

    private async Task RelayFromHostAsync<T>(string eventName, T payload)
    {
        if (_races.RoleOf(Context.ConnectionId) != MarbleRaceRole.Host) return;
        var guest = _races.PeerOf(Context.ConnectionId);
        if (guest is null) return;
        await Clients.Client(guest).SendAsync(eventName, payload);
    }

    private async Task NotifyPeerGoneAsync()
    {
        var peer = _races.Remove(Context.ConnectionId);
        if (peer is null) return;
        await Clients.Client(peer).SendAsync("peerLeft");
    }
}
