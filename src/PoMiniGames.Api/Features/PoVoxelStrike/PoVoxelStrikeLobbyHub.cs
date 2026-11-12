using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// The PoVoxelStrike room over the shared lobby hub. On start the lockstep session is
/// allocated immediately with the captured roster — not at the clients' eventual
/// JoinLockstep, which a WebSocket reconnect could otherwise race — and a leaver's
/// in-flight session binding is dropped on disconnect.
/// </summary>
public sealed class PoVoxelStrikeLobbyHub : LobbyHub<PoVoxelStrikeLobbyPlayer, PoVoxelStrikeLobbyService>
{
    private readonly PoVoxelStrikeLockstepService _lockstep;

    public PoVoxelStrikeLobbyHub(
        PoVoxelStrikeLobbyService lobby,
        PoVoxelStrikeLockstepService lockstep,
        ILogger<PoVoxelStrikeLobbyHub> log)
        : base(lobby, "povoxelstrike-lobby", log)
    {
        _lockstep = lockstep;
    }

    protected override string StartingMessage => "Run starting…";

    protected override (LobbyState<PoVoxelStrikeLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest) =>
        Lobby.Open(Context.ConnectionId, displayName, isGuest);

    protected override Task OnStartingAsync(IReadOnlyList<PoVoxelStrikeLobbyPlayer> roster)
    {
        _lockstep.GetOrCreateSession(PoVoxelStrikeLobbyService.GlobalCode, roster);
        return Task.CompletedTask;
    }

    protected override Task OnDisconnectedCoreAsync()
    {
        _lockstep.RemoveConnection(Context.ConnectionId);
        return Task.CompletedTask;
    }
}
