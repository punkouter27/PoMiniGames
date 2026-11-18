using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// The Marble Race room: the plain ready/start lobby with two seats and one pick, the track. The
/// first arrival hosts (and runs the physics), the guest readies, the host starts. Nobody ever
/// sees a code: <see cref="GlobalCode"/> names the one room, and each start swaps in an internal
/// match code (<see cref="CreateMatchCode"/>) that the two browsers join the race hub by.
/// </summary>
public sealed class PoMarbleRaceLobbyService : LobbyRoom<PoMarbleRaceLobbyPlayer>
{
    public const string GlobalCode = "LOBBY";

    /// <summary>The map slot a fresh room starts on (the engine menu's default course).</summary>
    public const int DefaultMapId = 2;

    public PoMarbleRaceLobbyService()
        : base(GlobalCode, PoMarbleRaceOnlineService.MaxPlayers, "Race already in progress")
    {
    }

    // The last course the host picked. A new seat starts on it, so players coming back from a race
    // (new connections, so new seats) find the room on the course they just ran.
    private int _mapId = DefaultMapId;

    public (LobbyState<PoMarbleRaceLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest, string userId) =>
        OpenCore(connectionId, displayName, isGuest,
            (name, previous, _) => new PoMarbleRaceLobbyPlayer(connectionId, name, isGuest, false, userId, previous?.MapId ?? _mapId));

    /// <summary>Record the caller's course pick on their seat. The Daily Canyon is a solo board, not a shared course.</summary>
    public bool PickMap(string connectionId, int mapId) => WithLock(seats =>
    {
        if (mapId < 0 || mapId == MarbleRaceDaily.MapId) return false;
        if (!seats.TryGetValue(connectionId, out var seat)) return false;
        seats[connectionId] = seat with { MapId = _mapId = mapId };
        return true;
    });

    /// <summary>A fresh internal code for the match this start creates; it is what <c>gameStarted</c> carries.</summary>
    public string CreateMatchCode() => WithLock(_ => GameCode = "match-" + Guid.NewGuid().ToString("N"));

    // A race needs both humans: the host starts only once the guest has joined and readied.
    protected override bool CanStart(IReadOnlyList<PoMarbleRaceLobbyPlayer> players, string hostConnectionId) =>
        players.Count == MaxPlayers && base.CanStart(players, hostConnectionId);

    protected override PoMarbleRaceLobbyPlayer WithReady(PoMarbleRaceLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };
}
