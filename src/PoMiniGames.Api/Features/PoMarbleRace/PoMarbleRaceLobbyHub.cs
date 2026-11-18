using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// The Marble Race room over the shared lobby hub (<c>/pomarblerace/lobby-hub</c>). The only
/// game-specific steps: the host's course pick, and registering the match with the race service
/// the instant the host starts, so both browsers can join the race hub by the internal code
/// <c>gameStarted</c> carries.
/// </summary>
public sealed class PoMarbleRaceLobbyHub : LobbyHub<PoMarbleRaceLobbyPlayer, PoMarbleRaceLobbyService>
{
    private readonly PoMarbleRaceOnlineService _races;

    public PoMarbleRaceLobbyHub(PoMarbleRaceLobbyService lobby, PoMarbleRaceOnlineService races, ILogger<PoMarbleRaceLobbyHub> log)
        : base(lobby, "pomarblerace-lobby", log)
    {
        _races = races;
    }

    protected override string StartingMessage => "Race starting…";

    protected override (LobbyState<PoMarbleRaceLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        return Lobby.Open(Context.ConnectionId, identity.DisplayName, identity.IsGuest, identity.UserId);
    }

    /// <summary>The host's course pick. Anyone else's is ignored: the race runs the host's seat.</summary>
    public async Task PickMap(int mapId)
    {
        if (Lobby.HostConnectionId == Context.ConnectionId && Lobby.PickMap(Context.ConnectionId, mapId))
            await BroadcastStateAsync();
    }

    protected override Task OnStartingAsync(IReadOnlyList<PoMarbleRaceLobbyPlayer> roster)
    {
        var host = roster.First(p => p.ConnectionId == Lobby.HostConnectionId);
        var guest = roster.First(p => p.ConnectionId != host.ConnectionId);
        _races.Expect(Lobby.CreateMatchCode(),
            new PoMarbleRaceOnlineService.MatchSeat(host.UserId, host.DisplayName, host.IsGuest),
            new PoMarbleRaceOnlineService.MatchSeat(guest.UserId, guest.DisplayName, guest.IsGuest),
            host.MapId);
        return Task.CompletedTask;
    }
}
