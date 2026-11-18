using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Identity;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Online Marble Race: a one-to-one relay between the two players the lobby seated. The host browser
/// streams <see cref="MarbleRaceFrame"/>s and phase/podium/result events; the guest
/// browser streams steering. Nothing here inspects a payload beyond the sender's role —
/// a guest cannot publish frames and a host cannot steer the guest's marble.
/// </summary>
/// <remarks>
/// Client events: <c>raceStarted</c> (<see cref="MarbleRaceStart"/>), <c>frame</c>,
/// <c>phase</c>, <c>podium</c>, <c>result</c> (guest only), <c>guestSteer</c> (host only,
/// an <c>int</c> -1/0/+1) and
/// <c>peerLeft</c> when the other seat is gone. A race seats two players at most: they meet in the
/// shared lobby and both call <see cref="JoinMatch"/> with the internal code its start carried.
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

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await NotifyPeerGoneAsync();
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Take your seat in the match the lobby started, by the internal <paramref name="matchCode"/>
    /// its <c>gameStarted</c> carried. The race starts when both seats are in (<c>raceStarted</c>
    /// to both). False when the code is unknown or this player holds no seat in it.
    /// </summary>
    public async Task<bool> JoinMatch(string matchCode)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var (seated, pairing) = _races.JoinMatch(Context.ConnectionId, identity.UserId, matchCode);
        if (pairing is null) return seated;

        _log.LogInformation("PoMarbleRace online: race {RaceId} paired host={Host} guest={Guest}",
            pairing.RaceId, pairing.HostStart.Host.DisplayName, pairing.HostStart.Guest.DisplayName);
        await Clients.Client(pairing.HostConnectionId).SendAsync("raceStarted", pairing.HostStart);
        await Clients.Client(pairing.GuestConnectionId).SendAsync("raceStarted", pairing.GuestStart);
        return true;
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
